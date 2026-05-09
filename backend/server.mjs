import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sessionsDir = resolve(rootDir, "tmp", "sessions");
const defaultPort = Number(process.env.PORT ?? 8787);
const pythonExecutable = process.env.PYTHON ?? "python";
const cameraPort = Number(process.env.CAMERA_PORT ?? 8791);
const analyzerModel = process.env.ANALYZER_MODEL ?? "gpt-4o-mini";
const analyzerMaxFiles = process.env.ANALYZER_MAX_FILES ?? "50";
const analyzerMaxEvidence = process.env.ANALYZER_MAX_EVIDENCE ?? "25";
const analyzerMaxContextLines = process.env.ANALYZER_MAX_CONTEXT_LINES ?? "1";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

let cameraProcess = null;
let cameraStartPromise = null;
let cameraError = "";

function jsonResponse(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Filename",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function textResponse(response, status, text) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(text);
}

function htmlResponse(response, status, html) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(html);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sessionPath(sessionId, ...parts) {
  if (!/^[a-z0-9-]+$/i.test(sessionId)) {
    throw new Error("Invalid session id.");
  }

  const target = resolve(sessionsDir, sessionId, ...parts);
  const sessionRoot = resolve(sessionsDir, sessionId);

  if (target !== sessionRoot && !target.startsWith(sessionRoot + sep)) {
    throw new Error("Path escaped session directory.");
  }

  return target;
}

function ensureSafeGitHubUrl(githubUrl) {
  let parsed;

  try {
    parsed = new URL(githubUrl);
  } catch {
    throw new Error("Invalid GitHub URL.");
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error("Only https://github.com/... repository URLs are supported.");
  }

  const parts = parsed.pathname.replace(/^\/|\/$/g, "").split("/");

  if (parts.length < 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error("GitHub URL must include owner and repository.");
  }

  return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/, "")}.git`;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? rootDir,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} exited with ${code}\n${stderr || stdout}`));
    });
  });
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function cameraHealth() {
  return new Promise((resolvePromise) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: cameraPort,
        path: "/health",
        method: "GET",
        timeout: 800,
      },
      (healthResponse) => {
        healthResponse.resume();
        resolvePromise(healthResponse.statusCode === 200);
      },
    );

    request.on("timeout", () => {
      request.destroy();
      resolvePromise(false);
    });
    request.on("error", () => resolvePromise(false));
    request.end();
  });
}

async function ensureCameraStream() {
  if (await cameraHealth()) {
    return;
  }

  if (cameraStartPromise) {
    return cameraStartPromise;
  }

  cameraStartPromise = (async () => {
    cameraError = "";
    const scriptPath = resolve(rootDir, "tools", "hand_camera_stream.py");
    const args = [scriptPath, "--port", String(cameraPort), "--mirror"];

    cameraProcess = spawn(pythonExecutable, args, {
      cwd: rootDir,
      env: { ...process.env },
      shell: false,
      windowsHide: true,
    });

    cameraProcess.stdout.on("data", (chunk) => {
      console.log(`[camera] ${chunk.toString().trim()}`);
    });
    cameraProcess.stderr.on("data", (chunk) => {
      cameraError += chunk.toString();
      console.error(`[camera] ${chunk.toString().trim()}`);
    });
    cameraProcess.on("error", (error) => {
      cameraError = error.message;
      cameraProcess = null;
    });
    cameraProcess.on("close", (code) => {
      if (code !== 0 && !cameraError) {
        cameraError = `camera process exited with ${code}`;
      }
      cameraProcess = null;
      cameraStartPromise = null;
    });

    for (let index = 0; index < 30; index += 1) {
      if (await cameraHealth()) {
        return;
      }
      await wait(200);
    }

    throw new Error(cameraError || "Camera stream did not become ready.");
  })();

  try {
    await cameraStartPromise;
  } finally {
    cameraStartPromise = null;
  }
}

function stopCameraStream() {
  if (cameraStartPromise) {
    cameraStartPromise = null;
  }

  if (!cameraProcess) {
    cameraError = "";
    return false;
  }

  try {
    cameraProcess.kill();
  } catch {
  }

  cameraProcess = null;
  cameraError = "";
  return true;
}

async function proxyCameraVideo(response) {
  await ensureCameraStream();

  const proxyRequest = httpRequest(
    {
      host: "127.0.0.1",
      port: cameraPort,
      path: "/video",
      method: "GET",
    },
    (proxyResponse) => {
      response.writeHead(proxyResponse.statusCode ?? 200, {
        "Content-Type": proxyResponse.headers["content-type"] ?? "multipart/x-mixed-replace; boundary=frame",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      proxyResponse.pipe(response);
    },
  );

  proxyRequest.on("error", (error) => {
    if (!response.headersSent) {
      jsonResponse(response, 503, { error: error.message });
    } else {
      response.destroy(error);
    }
  });
  response.on("close", () => proxyRequest.destroy());
  proxyRequest.end();
}

async function proxyCameraState(response) {
  await ensureCameraStream();

  const stateRequest = httpRequest(
    {
      host: "127.0.0.1",
      port: cameraPort,
      path: "/state",
      method: "GET",
      timeout: 1200,
    },
    (stateResponse) => {
      let body = "";
      stateResponse.on("data", (chunk) => {
        body += chunk.toString();
      });
      stateResponse.on("end", () => {
        try {
          jsonResponse(response, stateResponse.statusCode ?? 200, JSON.parse(body || "{}"));
        } catch {
          jsonResponse(response, 502, { error: "Invalid camera state response." });
        }
      });
    },
  );

  stateRequest.on("timeout", () => {
    stateRequest.destroy();
    jsonResponse(response, 504, { error: "Camera state timed out." });
  });
  stateRequest.on("error", (error) => {
    jsonResponse(response, 503, { error: error.message });
  });
  stateRequest.end();
}

async function readRequestBody(request, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > maxBytes) {
      throw new Error("Request body is too large.");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(request) {
  const body = await readRequestBody(request);
  return JSON.parse(body.toString("utf-8") || "{}");
}

async function writeSessionMeta(sessionId, meta) {
  await writeFile(sessionPath(sessionId, "session.json"), JSON.stringify(meta, null, 2), "utf-8");
}

async function runKeyboardAnalyzer(sessionId) {
  const sourceDir = sessionPath(sessionId, "original");
  const analysisPath = sessionPath(sessionId, "analysis.json");
  const scriptPath = resolve(rootDir, "tools", "analyze_game_controls_with_composio.py");

  await runCommand(pythonExecutable, [
    scriptPath,
    "--source",
    sourceDir,
    "--json-out",
    analysisPath,
    "--model",
    analyzerModel,
    "--max-files",
    analyzerMaxFiles,
    "--max-evidence",
    analyzerMaxEvidence,
    "--max-context-lines",
    analyzerMaxContextLines,
  ]);

  return JSON.parse(await readFile(analysisPath, "utf-8"));
}

async function runMappingPatcher(sessionId) {
  const sourceDir = sessionPath(sessionId, "original");
  const analysisPath = sessionPath(sessionId, "analysis.json");
  const mappingPath = sessionPath(sessionId, "mapping.json");
  const planPath = sessionPath(sessionId, "patch-plan.json");
  const patchedDir = sessionPath(sessionId, "patched");
  const reportPath = sessionPath(sessionId, "patch-report.json");
  const scriptPath = resolve(rootDir, "tools", "apply_gesture_mapping.py");
  const args = [
    scriptPath,
    "--source",
    sourceDir,
    "--analysis",
    analysisPath,
    "--mapping",
    mappingPath,
    "--out",
    patchedDir,
    "--report-out",
    reportPath,
  ];

  try {
    await stat(planPath);
    args.push("--plan", planPath);
  } catch {
  }

  await runCommand(pythonExecutable, args);

  return JSON.parse(await readFile(reportPath, "utf-8"));
}

async function runPatchPlanner(sessionId) {
  const sourceDir = sessionPath(sessionId, "original");
  const analysisPath = sessionPath(sessionId, "analysis.json");
  const mappingPath = sessionPath(sessionId, "mapping.json");
  const planPath = sessionPath(sessionId, "patch-plan.json");
  const scriptPath = resolve(rootDir, "tools", "plan_gesture_patch_lines.py");

  await runCommand(pythonExecutable, [
    scriptPath,
    "--source",
    sourceDir,
    "--analysis",
    analysisPath,
    "--mapping",
    mappingPath,
    "--json-out",
    planPath,
  ]);

  return JSON.parse(await readFile(planPath, "utf-8"));
}

async function markSessionFailed(sessionId, meta, error) {
  const hint = error.message.includes("rate_limit_exceeded") || error.message.includes("Request too large")
    ? "Analyzer request was too large. Restart backend with -Model gpt-4o-mini -MaxFiles 50 -MaxEvidence 25."
    : undefined;

  await writeSessionMeta(sessionId, {
    ...meta,
    status: "failed",
    error: error.message,
    ...(hint ? { hint } : {}),
    updated_at: new Date().toISOString(),
  });
}

async function analyzeSession(sessionId, meta) {
  await writeSessionMeta(sessionId, {
    ...meta,
    status: "analyzing",
    updated_at: new Date().toISOString(),
  });

  await runKeyboardAnalyzer(sessionId);

  await writeSessionMeta(sessionId, {
    ...meta,
    status: "ready",
    analysis_path: "analysis.json",
    game_url: `/api/sessions/${sessionId}/game/`,
    updated_at: new Date().toISOString(),
  });
}

async function processGithubSession(sessionId, meta, cloneUrl) {
  try {
    const originalDir = sessionPath(sessionId, "original");
    await writeSessionMeta(sessionId, {
      ...meta,
      status: "cloning",
      updated_at: new Date().toISOString(),
    });

    await runCommand("git", ["clone", "--depth", "1", cloneUrl, originalDir], { cwd: rootDir });
    await analyzeSession(sessionId, meta);
  } catch (error) {
    await markSessionFailed(sessionId, meta, error);
  }
}

async function createSessionFromGithub(githubUrl) {
  const sessionId = randomUUID();
  const cloneUrl = ensureSafeGitHubUrl(githubUrl);
  const meta = {
    session_id: sessionId,
    source_type: "github",
    github_url: cloneUrl,
    status: "queued",
    created_at: new Date().toISOString(),
  };

  await mkdir(sessionPath(sessionId), { recursive: true });
  await writeSessionMeta(sessionId, meta);
  processGithubSession(sessionId, meta, cloneUrl);

  return { session_id: sessionId, status: "queued" };
}

async function processZipSession(sessionId, meta, zipPath) {
  try {
    const originalDir = sessionPath(sessionId, "original");
    await mkdir(originalDir, { recursive: true });
    await writeSessionMeta(sessionId, {
      ...meta,
      status: "extracting",
      updated_at: new Date().toISOString(),
    });

    const archiveCommand = [
      "Expand-Archive",
      "-LiteralPath",
      `'${zipPath.replaceAll("'", "''")}'`,
      "-DestinationPath",
      `'${originalDir.replaceAll("'", "''")}'`,
      "-Force",
    ].join(" ");
    await runCommand("powershell.exe", ["-NoProfile", "-Command", archiveCommand]);
    await analyzeSession(sessionId, meta);
  } catch (error) {
    await markSessionFailed(sessionId, meta, error);
  }
}

async function createSessionFromZip(request) {
  const sessionId = randomUUID();
  const uploadDir = sessionPath(sessionId, "upload");
  const filename = basename(request.headers["x-filename"] || "game.zip");

  if (extname(filename).toLowerCase() !== ".zip") {
    throw new Error("Zip uploads must use a .zip filename.");
  }

  await mkdir(uploadDir, { recursive: true });

  const zipPath = join(uploadDir, filename);
  await writeFile(zipPath, await readRequestBody(request, 250 * 1024 * 1024));

  const meta = {
    session_id: sessionId,
    source_type: "zip",
    filename,
    status: "queued",
    created_at: new Date().toISOString(),
  };
  await writeSessionMeta(sessionId, meta);
  processZipSession(sessionId, meta, zipPath);

  return { session_id: sessionId, status: "queued" };
}

async function serveSessionFile(response, sessionId, urlPath) {
  const relativePath = decodeURIComponent(urlPath.replace(`/api/sessions/${sessionId}/game/`, "")) || "index.html";
  const safeRelative = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  let gameRoot = "original";
  const patchReport = await readOptionalJson(sessionPath(sessionId, "patch-report.json"));

  try {
    const patchedInfo = await stat(sessionPath(sessionId, "patched"));

    if (patchedInfo.isDirectory() && patchReport?.status === "patched") {
      gameRoot = "patched";
    }
  } catch {
  }

  const filePath = sessionPath(sessionId, gameRoot, safeRelative);

  try {
    const info = await stat(filePath);

    if (info.isDirectory()) {
      return serveSessionFile(response, sessionId, `${urlPath.replace(/\/$/, "")}/index.html`);
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-GestureForge-Game-Root": gameRoot,
    });
    createReadStream(filePath).pipe(response);
  } catch {
    textResponse(response, 404, "Not found");
  }
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function latestReadySession() {
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  const sessions = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9-]+$/i.test(entry.name)) {
      continue;
    }

    const metaPath = sessionPath(entry.name, "session.json");
    const meta = await readOptionalJson(metaPath);

    if (!meta || meta.status !== "ready") {
      continue;
    }

    const info = await stat(metaPath);
    sessions.push({
      id: entry.name,
      meta,
      time: Date.parse(meta.updated_at ?? meta.created_at ?? "") || info.mtimeMs,
    });
  }

  sessions.sort((a, b) => b.time - a.time);
  return sessions[0] ?? null;
}

function mappingRows(mapping, analysis) {
  const mappedControls = Array.isArray(mapping?.controls) ? mapping.controls : [];

  if (mappedControls.length) {
    return mappedControls;
  }

  return Array.isArray(analysis?.controls)
    ? analysis.controls.map((control) => ({
        control_id: control.id,
        action: control.action,
        key: control.key,
        code: control.code,
        gesture_label: "Unmapped",
      }))
    : [];
}

function gestureStateName(gesture) {
  const names = {
    index_extend: "indexExtended",
    index_fold: "indexFolded",
  };

  return names[gesture] ?? String(gesture ?? "").replace(/[^a-zA-Z0-9_$]+/g, "_");
}

function controlFunctionName(control) {
  const suggested = String(control?.suggested_function ?? "");
  const match = suggested.match(/gestureForge\.controls\.([A-Za-z_$][\w$]*)\s*\(/);

  if (match) {
    return match[1];
  }

  const action = String(control?.action ?? control?.control_id ?? "control").replace(/[^a-zA-Z0-9_$]+/g, "_");
  const cleaned = action || "control";
  return cleaned[0].match(/[0-9]/) ? `control_${cleaned}` : cleaned[0].toLowerCase() + cleaned.slice(1);
}

function displayControlMap(rows) {
  const controlMap = {};

  for (const row of rows) {
    const name = controlFunctionName(row);
    const stateName = gestureStateName(row.gesture);

    if (!controlMap[name]) {
      controlMap[name] = [];
    }

    if (stateName && !controlMap[name].includes(stateName)) {
      controlMap[name].push(stateName);
    }
  }

  return controlMap;
}

function keyEventFields(row) {
  const key = String(row?.key ?? "");
  const code = String(row?.code ?? key);
  const normalized = code || key;
  const keyCodeByName = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    ShiftLeft: 16,
    ShiftRight: 16,
    ControlLeft: 17,
    ControlRight: 17,
    AltLeft: 18,
    AltRight: 18,
    Escape: 27,
    Space: 32,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
  };

  if (normalized === "Space" || key === "Space") {
    return { key: " ", code: "Space", keyCode: 32 };
  }

  if (/^Key[A-Z]$/.test(normalized)) {
    const letter = normalized.at(-1);
    return { key: letter.toLowerCase(), code: normalized, keyCode: letter.charCodeAt(0) };
  }

  if (/^Digit[0-9]$/.test(normalized)) {
    const digit = normalized.at(-1);
    return { key: digit, code: normalized, keyCode: digit.charCodeAt(0) };
  }

  if (Object.prototype.hasOwnProperty.call(keyCodeByName, normalized)) {
    return { key: key && key !== "Space" ? key : normalized, code: normalized, keyCode: keyCodeByName[normalized] };
  }

  if (key.length === 1) {
    return { key, code: code || `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
  }

  return { key: key || normalized, code: code || normalized, keyCode: 0 };
}

function displayKeyMap(rows) {
  const keyMap = {};

  for (const row of rows) {
    keyMap[controlFunctionName(row)] = keyEventFields(row);
  }

  return keyMap;
}

async function displayPage(response, sessionId) {
  const meta = await readOptionalJson(sessionPath(sessionId, "session.json"));

  if (!meta) {
    htmlResponse(response, 404, "<!doctype html><title>Session not found</title><h1>Session not found</h1>");
    return;
  }

  const analysis = await readOptionalJson(sessionPath(sessionId, "analysis.json"));
  const mapping = await readOptionalJson(sessionPath(sessionId, "mapping.json"));
  const patchReport = await readOptionalJson(sessionPath(sessionId, "patch-report.json"));
  const rows = mappingRows(mapping, analysis);
  const controlMap = displayControlMap(rows);
  const keyMap = displayKeyMap(rows);
  const gameUrl = `/api/sessions/${sessionId}/game/`;
  const status = patchReport?.status === "patched" ? "PATCHED" : "DISPLAY";

  htmlResponse(response, 200, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GestureForge Display</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #05070d; color: #f6f1df; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    iframe { width: 100vw; height: 100vh; display: block; border: 0; background: #05070d; }
    .camera { width: min(24vw, 280px); aspect-ratio: 4 / 3; position: fixed; left: 18px; top: 18px; overflow: hidden; border: 4px solid #f6f1df; background: #05070d; box-shadow: 8px 8px 0 rgba(0,0,0,.72); z-index: 2; }
    .camera img { width: 100%; height: 100%; display: block; object-fit: cover; }
    .camera .hud { position: absolute; left: 0; right: 0; bottom: 0; padding: 7px 9px; background: rgba(5,7,13,.84); color: #92ff73; font-size: 12px; font-weight: 900; text-transform: uppercase; }
    .map { width: min(360px, calc(100vw - 36px)); position: fixed; right: 18px; bottom: 18px; z-index: 2; padding: 14px; border: 4px solid #f6f1df; background: rgba(8,17,29,.92); box-shadow: 8px 8px 0 rgba(0,0,0,.72); }
    .title { display: flex; justify-content: space-between; gap: 14px; margin-bottom: 8px; font-size: 13px; font-weight: 900; text-transform: uppercase; }
    .badge { color: #92ff73; }
    .row { min-height: 42px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 2px solid rgba(246,241,223,.2); }
    .row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 900; text-transform: uppercase; }
    kbd { min-width: 126px; border: 2px solid #f6f1df; padding: 6px 8px; color: #ffd65a; text-align: center; font-size: 11px; font-weight: 900; text-transform: uppercase; }
    .note { margin: 8px 0 10px; color: #ffd65a; font-size: 12px; font-weight: 900; text-transform: uppercase; }
    .session { position: fixed; left: 18px; bottom: 18px; z-index: 2; max-width: min(520px, calc(100vw - 36px)); padding: 8px 10px; background: rgba(5,7,13,.82); color: #9aa3b2; font-size: 11px; }
  </style>
</head>
<body>
  <iframe id="game" src="${escapeHtml(gameUrl)}" title="GestureForge session game"></iframe>
  <div class="camera">
    <img id="camera" alt="Live hand skeleton">
    <div class="hud" id="camera-status">Starting camera</div>
  </div>
  <section class="map" aria-label="Active gesture mappings">
    <div class="title"><span>Index Map</span><span class="badge">${escapeHtml(status)}</span></div>
    ${patchReport?.status === "patch_failed" ? `<p class="note">Patch failed, showing original game.</p>` : ""}
    ${rows.map((row) => `
      <div class="row">
        <span>${escapeHtml(row.action ?? row.control_id)}</span>
        <kbd>${escapeHtml(row.gesture_label ?? row.gesture ?? row.key ?? "Unmapped")}</kbd>
      </div>
    `).join("") || '<div class="row"><span>No mapping</span><kbd>--</kbd></div>'}
  </section>
  <div class="session">${escapeHtml(sessionId)} · ${escapeHtml(meta.github_url ?? meta.filename ?? meta.source_type ?? "")}</div>
  <script>
    const game = document.getElementById("game");
    const camera = document.getElementById("camera");
    const cameraStatus = document.getElementById("camera-status");
    const controlMap = ${JSON.stringify(controlMap)};
    const keyMap = ${JSON.stringify(keyMap)};
    function installGestureForgeRuntime() {
      try {
        const target = game.contentWindow;
        if (!target || !target.document) return false;
        if (target.gestureForge && target.gestureForge.__displayInjected) return true;

        const root = target.gestureForge = target.gestureForge || {};
        const state = root.state = root.state || { indexExtended: false, indexFolded: true };
        const extraPredicates = root.extraPredicates = root.extraPredicates || {};
        const activeKeyboardActions = root.activeKeyboardActions = root.activeKeyboardActions || {};

        root.__displayInjected = true;
        root.setState = function setState(nextState) {
          Object.assign(state, nextState || {});
          state.indexFolded = !state.indexExtended;
          syncKeyboardEvents();
        };
        root.gestures = root.gestures || {
          indexExtended: function indexExtended() { return !!state.indexExtended; },
          indexFolded: function indexFolded() { return !!state.indexFolded; }
        };
        root.controls = root.controls || {};
        root.input = root.input || {};
        root.bind = function bind(action, predicate) {
          if (!extraPredicates[action]) extraPredicates[action] = [];
          extraPredicates[action].push(predicate);
        };
        root.input.check = function check(action, predicates) {
          const originalPredicates = Array.isArray(predicates) ? predicates : predicates ? [predicates] : [];
          const gesturePredicates = (controlMap[action] || []).map(function toPredicate(name) {
            return root.gestures[name];
          });
          return originalPredicates.concat(gesturePredicates, extraPredicates[action] || []).some(function run(predicate) {
            try { return typeof predicate === "function" && !!predicate(); } catch { return false; }
          });
        };

        Object.keys(controlMap).forEach(function registerControl(name) {
          root.controls[name] = function mappedGestureControl() {
            return root.input.check(name);
          };
        });

        function keyEventFor(action, type) {
          const config = keyMap[action] || {};
          const keyCode = Number(config.keyCode || 0);
          const eventInit = {
            key: config.key || "",
            code: config.code || "",
            keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true,
          };

          try {
            return new target.KeyboardEvent(type, eventInit);
          } catch {
            const fallback = target.document.createEvent("KeyboardEvent");
            fallback.initKeyboardEvent(type, true, true, target, eventInit.key, 0, "", false, "");
            return fallback;
          }
        }

        function dispatchKeyboardEvent(action, type) {
          if (!keyMap[action]) return;
          const event = keyEventFor(action, type);
          const eventTarget = target.document.activeElement || target.document.body || target.document;

          try { eventTarget.dispatchEvent(event); } catch {}
          try { target.document.dispatchEvent(event); } catch {}
          try { target.dispatchEvent(event); } catch {}
        }

        function syncKeyboardEvents() {
          Object.keys(controlMap).forEach(function syncAction(action) {
            const active = (controlMap[action] || []).map(function toPredicate(name) {
              return root.gestures[name];
            }).some(function run(predicate) {
              try { return typeof predicate === "function" && !!predicate(); } catch { return false; }
            });

            if (active && !activeKeyboardActions[action]) {
              activeKeyboardActions[action] = true;
              dispatchKeyboardEvent(action, "keydown");
            } else if (!active && activeKeyboardActions[action]) {
              activeKeyboardActions[action] = false;
              dispatchKeyboardEvent(action, "keyup");
            }
          });
        }

        function installMelonInputPatch() {
          return true;
        }

        if (!installMelonInputPatch()) {
          let tries = 0;
          const timer = target.setInterval(function retryMelonInputPatch() {
            tries += 1;
            if (installMelonInputPatch() || tries > 120) {
              target.clearInterval(timer);
            }
          }, 100);
        }
        target.setInterval(syncKeyboardEvents, 80);
        return true;
      } catch (error) {
        return false;
      }
    }
    game.addEventListener("load", installGestureForgeRuntime);
    window.setInterval(installGestureForgeRuntime, 500);
    function pushGestureState(state) {
      try {
        installGestureForgeRuntime();
        const target = game.contentWindow;
        if (!target || !target.gestureForge || typeof target.gestureForge.setState !== "function") {
          return false;
        }
        target.gestureForge.setState({
          indexExtended: !!state.indexExtended,
          indexFolded: !!state.indexFolded
        });
        return true;
      } catch (error) {
        return false;
      }
    }
    async function pollGestureState() {
      try {
        const response = await fetch("/api/camera/state", { cache: "no-store" });
        const state = await response.json();
        const pushed = pushGestureState(state);
        const pose = state.hands ? (state.indexExtended ? "INDEX EXT" : "INDEX FOLD") : "NO HAND";
        cameraStatus.textContent = pushed ? "Camera on / " + pose : "Camera on / runtime pending / " + pose;
      } catch (error) {
        cameraStatus.textContent = error.message;
      } finally {
        window.setTimeout(pollGestureState, 80);
      }
    }
    async function startCamera() {
      try {
        cameraStatus.textContent = "Starting camera";
        const response = await fetch("/api/camera/start");
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Camera failed");
        camera.src = "/api/camera/video?t=" + Date.now();
        cameraStatus.textContent = "Camera on / index state";
        pollGestureState();
      } catch (error) {
        cameraStatus.textContent = error.message;
        setTimeout(startCamera, 2500);
      }
    }
    camera.onerror = () => {
      cameraStatus.textContent = "Camera retry";
      setTimeout(startCamera, 1200);
    };
    startCamera();
  </script>
</body>
</html>`);
}

async function handleRequest(request, response) {
  if (request.method === "OPTIONS") {
    jsonResponse(response, 204, {});
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      jsonResponse(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/display/latest") {
      const latest = await latestReadySession();

      if (!latest) {
        htmlResponse(response, 404, "<!doctype html><title>No ready session</title><h1>No ready session</h1>");
        return;
      }

      await displayPage(response, latest.id);
      return;
    }

    const displayMatch = url.pathname.match(/^\/display\/([a-z0-9-]+)$/i);
    if (request.method === "GET" && displayMatch) {
      await displayPage(response, displayMatch[1]);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/sessions/latest") {
      const latest = await latestReadySession();
      jsonResponse(response, latest ? 200 : 404, latest ? latest.meta : { error: "No ready session." });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/camera/health") {
      jsonResponse(response, 200, {
        status: (await cameraHealth()) ? "ready" : "stopped",
        port: cameraPort,
        error: cameraError || undefined,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/camera/start") {
      await ensureCameraStream();
      jsonResponse(response, 200, {
        status: "ready",
        port: cameraPort,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/camera/stop") {
      const stopped = stopCameraStream();
      jsonResponse(response, 200, {
        status: "stopped",
        stopped,
        port: cameraPort,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/camera/video") {
      await proxyCameraVideo(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/camera/state") {
      await proxyCameraState(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/sessions/github") {
      const body = await readJsonBody(request);
      jsonResponse(response, 201, await createSessionFromGithub(body.github_url));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/sessions/zip") {
      jsonResponse(response, 201, await createSessionFromZip(request));
      return;
    }

    const statusMatch = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)$/i);
    if (request.method === "GET" && statusMatch) {
      const meta = JSON.parse(await readFile(sessionPath(statusMatch[1], "session.json"), "utf-8"));
      jsonResponse(response, 200, meta);
      return;
    }

    const analysisMatch = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)\/analysis$/i);
    if (request.method === "GET" && analysisMatch) {
      const meta = JSON.parse(await readFile(sessionPath(analysisMatch[1], "session.json"), "utf-8"));

      if (meta.status !== "ready") {
        jsonResponse(response, 409, meta);
        return;
      }

      const analysis = JSON.parse(await readFile(sessionPath(analysisMatch[1], "analysis.json"), "utf-8"));
      jsonResponse(response, 200, analysis);
      return;
    }

    const mappingMatch = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)\/mapping$/i);
    if (request.method === "POST" && mappingMatch) {
      const mapping = await readJsonBody(request);
      await writeFile(sessionPath(mappingMatch[1], "mapping.json"), JSON.stringify(mapping, null, 2), "utf-8");
      jsonResponse(response, 200, { session_id: mappingMatch[1], status: "mapping_saved" });
      return;
    }

    const planMappingMatch = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)\/plan-mapping$/i);
    if (request.method === "POST" && planMappingMatch) {
      const sessionId = planMappingMatch[1];
      const meta = JSON.parse(await readFile(sessionPath(sessionId, "session.json"), "utf-8"));
      let plan;
      let status = "planned";

      try {
        plan = await runPatchPlanner(sessionId);
      } catch (error) {
        status = "plan_failed";
        plan = {
          status,
          error: error.message,
          patches: [],
          runtime_injections: [],
          manual_review: [],
          needs_ai: true,
        };
        await writeFile(sessionPath(sessionId, "patch-plan.json"), JSON.stringify(plan, null, 2), "utf-8");
      }

      await writeSessionMeta(sessionId, {
        ...meta,
        status: "ready",
        analysis_path: "analysis.json",
        mapping_path: "mapping.json",
        patch_plan_path: "patch-plan.json",
        game_url: `/api/sessions/${sessionId}/game/`,
        updated_at: new Date().toISOString(),
      });

      jsonResponse(response, 200, {
        session_id: sessionId,
        status,
        game_url: `/api/sessions/${sessionId}/game/`,
        plan,
      });
      return;
    }

    const patchPlanMatch = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)\/patch-plan$/i);
    if (request.method === "GET" && patchPlanMatch) {
      const plan = JSON.parse(await readFile(sessionPath(patchPlanMatch[1], "patch-plan.json"), "utf-8"));
      jsonResponse(response, 200, plan);
      return;
    }

    const applyMappingMatch = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)\/apply-mapping$/i);
    if (request.method === "POST" && applyMappingMatch) {
      const sessionId = applyMappingMatch[1];
      const meta = JSON.parse(await readFile(sessionPath(sessionId, "session.json"), "utf-8"));
      let report;
      let status = "patched";

      try {
        report = await runMappingPatcher(sessionId);
      } catch (error) {
        status = "patch_failed";
        report = {
          status,
          error: error.message,
          results: [],
        };
        await writeFile(sessionPath(sessionId, "patch-report.json"), JSON.stringify(report, null, 2), "utf-8");
      }

      await writeSessionMeta(sessionId, {
        ...meta,
        status: "ready",
        analysis_path: "analysis.json",
        mapping_path: "mapping.json",
        patch_report_path: "patch-report.json",
        game_url: `/api/sessions/${sessionId}/game/`,
        ...(status === "patched" ? { patched_at: new Date().toISOString() } : {}),
        updated_at: new Date().toISOString(),
      });

      jsonResponse(response, 200, {
        session_id: sessionId,
        status,
        game_url: `/api/sessions/${sessionId}/game/`,
        report,
      });
      return;
    }

    const patchReportMatch = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)\/patch-report$/i);
    if (request.method === "GET" && patchReportMatch) {
      const report = JSON.parse(await readFile(sessionPath(patchReportMatch[1], "patch-report.json"), "utf-8"));
      jsonResponse(response, 200, report);
      return;
    }

    const gameMatch = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)\/game(?:\/.*)?$/i);
    if (request.method === "GET" && gameMatch) {
      await serveSessionFile(response, gameMatch[1], url.pathname);
      return;
    }

    jsonResponse(response, 404, { error: "Not found" });
  } catch (error) {
    jsonResponse(response, 500, { error: error.message });
  }
}

await mkdir(sessionsDir, { recursive: true });

createServer(handleRequest).listen(defaultPort, () => {
  console.log(`GestureForge backend listening on http://localhost:${defaultPort}`);
});
