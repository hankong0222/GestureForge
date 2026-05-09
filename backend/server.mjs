import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sessionsDir = resolve(rootDir, "tmp", "sessions");
const defaultPort = Number(process.env.PORT ?? 8787);
const pythonExecutable = process.env.PYTHON ?? "python";
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
  const filePath = sessionPath(sessionId, "original", safeRelative);

  try {
    const info = await stat(filePath);

    if (info.isDirectory()) {
      return serveSessionFile(response, sessionId, `${urlPath.replace(/\/$/, "")}/index.html`);
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    textResponse(response, 404, "Not found");
  }
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
