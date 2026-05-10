import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loginUser, signupUser } from "./auth.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

function loadDotenvFile(path) {
  try {
    const lines = readFileSync(path, "utf-8").replace(/^\uFEFF/, "").split(/\r?\n/);

    lines.forEach((rawLine) => {
      const line = rawLine.trim();

      if (!line || line.startsWith("#") || !line.includes("=")) {
        return;
      }

      const equalsIndex = line.indexOf("=");
      const key = line.slice(0, equalsIndex).trim();
      let value = line.slice(equalsIndex + 1).trim();

      if (!key || process.env[key] !== undefined) {
        return;
      }

      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    });
  } catch {
  }
}

loadDotenvFile(resolve(rootDir, ".env"));

const assetDir = resolve(rootDir, "asset");
const sessionsDir = resolve(rootDir, "tmp", "sessions");
const recordingsDir = resolve(rootDir, "tmp", "recordings");
const backboardStatePath = resolve(rootDir, "tmp", "backboard-state.json");
const defaultPort = Number(process.env.PORT ?? 8787);
const pythonExecutable = process.env.PYTHON ?? "python";
const cameraPort = Number(process.env.CAMERA_PORT ?? 8791);
const analyzerModel = process.env.ANALYZER_MODEL ?? "gpt-4o-mini";
const analyzerMaxFiles = process.env.ANALYZER_MAX_FILES ?? "50";
const analyzerMaxEvidence = process.env.ANALYZER_MAX_EVIDENCE ?? "25";
const analyzerMaxContextLines = process.env.ANALYZER_MAX_CONTEXT_LINES ?? "1";
const cloudinaryCloudName = (process.env.CLOUDINARY_CLOUD_NAME ?? process.env.VITE_CLOUDINARY_CLOUD_NAME ?? "").trim();
const cloudinaryApiKey = (process.env.CLOUDINARY_API_KEY ?? "").trim();
const cloudinaryApiSecret = (process.env.CLOUDINARY_API_SECRET ?? "").trim();
const cloudinaryRenderFolder = String(process.env.CLOUDINARY_RENDER_FOLDER ?? "gestureforge-renders")
  .replace(/^\/+|\/+$/g, "");
const cloudinaryAssetFolder = String(process.env.CLOUDINARY_ASSET_FOLDER ?? `${cloudinaryRenderFolder}/assets`)
  .replace(/^\/+|\/+$/g, "");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

let cameraProcess = null;
let cameraStartPromise = null;
let cameraError = "";
const recordingAnalysisJobs = new Map();

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

function recordingIdFromPathValue(recordingId) {
  const normalized = String(recordingId ?? "").trim();

  if (!/^[a-z0-9-]+$/i.test(normalized)) {
    throw new Error("Invalid recording id.");
  }

  return normalized;
}

function recordingMetaPath(recordingId) {
  return resolve(recordingsDir, `${recordingIdFromPathValue(recordingId)}.json`);
}

function recordingPath(recordingId, ...parts) {
  const normalized = recordingIdFromPathValue(recordingId);
  const recordingRoot = resolve(recordingsDir, normalized);
  const target = resolve(recordingRoot, ...parts);

  if (target !== recordingRoot && !target.startsWith(recordingRoot + sep)) {
    throw new Error("Path escaped recording directory.");
  }

  return target;
}

function normalizeCloudinaryRecording(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Cloudinary recording payload is required.");
  }

  const publicId = String(payload.public_id ?? "").trim();
  const videoUrl = String(payload.video_url ?? "").trim();

  if (!publicId) {
    throw new Error("Cloudinary public_id is required.");
  }

  if (!videoUrl) {
    throw new Error("Cloudinary video_url is required.");
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(videoUrl);
  } catch {
    throw new Error("Cloudinary video_url must be a valid URL.");
  }

  if (parsedUrl.protocol !== "https:") {
    throw new Error("Cloudinary video_url must use HTTPS.");
  }

  const sessionId = payload.session_id ? String(payload.session_id).trim() : "";

  if (sessionId && !/^[a-z0-9-]+$/i.test(sessionId)) {
    throw new Error("Invalid session id.");
  }

  return {
    public_id: publicId,
    video_url: videoUrl,
    session_id: sessionId || null,
    source: String(payload.source ?? "gestureforge_screen_recording"),
    resource_type: String(payload.resource_type ?? "video"),
    format: payload.format ? String(payload.format) : null,
    type: payload.type ? String(payload.type) : null,
    bytes: Number(payload.bytes || 0),
    duration: Number(payload.duration || 0),
    width: Number(payload.width || 0),
    height: Number(payload.height || 0),
    original_filename: payload.original_filename ? basename(String(payload.original_filename)) : null,
    analysis_status: "queued",
  };
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

function requestCameraShutdown() {
  return new Promise((resolvePromise) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: cameraPort,
        path: "/shutdown",
        method: "POST",
        timeout: 800,
      },
      (shutdownResponse) => {
        shutdownResponse.resume();
        resolvePromise(shutdownResponse.statusCode === 200);
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
      if (code !== 0 && code !== null && !cameraError) {
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

async function stopCameraStream() {
  if (cameraStartPromise) {
    cameraStartPromise = null;
  }

  const serviceStopped = await requestCameraShutdown();

  if (!cameraProcess) {
    cameraError = "";
    return serviceStopped;
  }

  if (serviceStopped) {
    await wait(700);

    if (!(await cameraHealth())) {
      cameraProcess = null;
      cameraError = "";
      return true;
    }
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

async function writeRecordingMeta(recording) {
  await mkdir(recordingsDir, { recursive: true });
  await writeFile(recordingMetaPath(recording.recording_id), JSON.stringify(recording, null, 2), "utf-8");

  if (recording.session_id) {
    try {
      await writeFile(sessionPath(recording.session_id, "cloudinary-recording.json"), JSON.stringify(recording, null, 2), "utf-8");
    } catch {
    }
  }
}

async function readRecordingMeta(recordingId) {
  return JSON.parse(await readFile(recordingMetaPath(recordingId), "utf-8"));
}

async function patchRecordingMeta(recordingId, patch) {
  const current = await readRecordingMeta(recordingId);
  const next = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  await writeRecordingMeta(next);
  return next;
}

async function saveCloudinaryRecording(payload) {
  const recording = {
    recording_id: randomUUID(),
    ...normalizeCloudinaryRecording(payload),
    received_at: new Date().toISOString(),
  };

  await mkdir(recordingPath(recording.recording_id), { recursive: true });
  await writeRecordingMeta(recording);
  processRecordingAnalysis(recording.recording_id);

  return recording;
}

async function runRecordingVideoAnalyzer(recording) {
  const analysisPath = recordingPath(recording.recording_id, "analysis.json");
  const feedbackPath = recordingPath(recording.recording_id, "feedback.json");
  const scriptPath = resolve(rootDir, "tools", "analyze_recording_video.py");
  const args = [
    scriptPath,
    "--video-url",
    recording.video_url,
    "--public-id",
    recording.public_id,
    "--work-dir",
    recordingPath(recording.recording_id),
    "--json-out",
    analysisPath,
    "--assistant-state",
    backboardStatePath,
  ];

  await mkdir(recordingPath(recording.recording_id), { recursive: true });

  try {
    await stat(feedbackPath);
    args.push("--feedback-json", feedbackPath);
  } catch {
  }

  await runCommand(pythonExecutable, args);

  return JSON.parse(await readFile(analysisPath, "utf-8"));
}

function processRecordingAnalysis(recordingId) {
  const normalizedId = recordingIdFromPathValue(recordingId);

  if (recordingAnalysisJobs.has(normalizedId)) {
    return recordingAnalysisJobs.get(normalizedId);
  }

  const job = (async () => {
    try {
      const recording = await patchRecordingMeta(normalizedId, {
        analysis_status: "analyzing",
        analysis_started_at: new Date().toISOString(),
        analysis_error: undefined,
      });
      const analysis = await runRecordingVideoAnalyzer(recording);
      const analysisStatus = analysis.status === "failed"
        ? "failed"
        : analysis.status === "partial" ? "partial" : "complete";
      const analysisErrors = Array.isArray(analysis.errors) ? analysis.errors.join(" / ") : "";
      await patchRecordingMeta(normalizedId, {
        analysis_status: analysisStatus,
        ...(analysisStatus === "failed" ? { analysis_error: analysisErrors || "Video analysis failed." } : {}),
        analysis_path: "analysis.json",
        analysis_finished_at: new Date().toISOString(),
      });
      if (analysisStatus !== "failed") {
        const latestRecording = await readRecordingMeta(normalizedId);
        await saveClipPlan(latestRecording, analysis);
      }
      return analysis;
    } catch (error) {
      await patchRecordingMeta(normalizedId, {
        analysis_status: "failed",
        analysis_error: error.message,
        analysis_finished_at: new Date().toISOString(),
      });
      throw error;
    } finally {
      recordingAnalysisJobs.delete(normalizedId);
    }
  })();

  recordingAnalysisJobs.set(normalizedId, job);
  job.catch(() => {});
  return job;
}

async function saveRecordingFeedback(recordingId, payload) {
  const normalizedId = recordingIdFromPathValue(recordingId);
  const recording = await readRecordingMeta(normalizedId);
  const feedback = {
    prompt: String(payload?.prompt ?? "").trim(),
    feedback: String(payload?.feedback ?? "").trim(),
    created_at: new Date().toISOString(),
  };

  await mkdir(recordingPath(normalizedId), { recursive: true });
  await writeFile(recordingPath(normalizedId, "feedback.json"), JSON.stringify(feedback, null, 2), "utf-8");
  await patchRecordingMeta(normalizedId, {
    analysis_status: "queued",
    analysis_error: undefined,
    clip_plan_status: "stale",
    user_prompt: feedback.prompt,
    user_feedback: feedback.feedback,
    feedback_at: feedback.created_at,
  });

  if (!recordingAnalysisJobs.has(normalizedId)) {
    processRecordingAnalysis(recording.recording_id);
  }

  return {
    recording_id: recording.recording_id,
    analysis_status: "queued",
    prompt: feedback.prompt,
    feedback: feedback.feedback,
  };
}

function numberOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function overlapDuration(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function cleanOverlayText(value, fallback) {
  return String(value || fallback || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

async function localClipAssetCatalog() {
  const entries = await readdir(assetDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const definitions = [
    {
      id: "meme_laugh",
      kind: "meme",
      label: "Laugh Meme",
      filename: "laughing.jpg",
      tags: ["laugh", "funny", "reaction"],
    },
    {
      id: "meme_embarrassed",
      kind: "meme",
      label: "Embarrassed Meme",
      filename: "embarrassed.gif",
      tags: ["embarrassed", "awkward", "fail", "reaction"],
    },
    {
      id: "sound_laugh",
      kind: "sound",
      label: "Laugh Sound",
      filename: "lagzjackson-funny-laughing-sound-effect-205565.mp3",
      tags: ["laugh", "funny", "reaction"],
    },
    {
      id: "sound_wtf",
      kind: "sound",
      label: "WTF Sound",
      filename: "universfield-what-a-fuck-120320.mp3",
      tags: ["wtf", "surprise", "fail", "reaction"],
    },
  ];

  return definitions
    .filter((asset) => files.includes(asset.filename))
    .map((asset) => ({
      ...asset,
      path: `asset/${asset.filename}`,
      url: `/api/assets/${encodeURIComponent(asset.filename)}`,
    }));
}

function assetById(catalog, assetId) {
  return catalog.find((asset) => asset.id === assetId) ?? null;
}

function hintedAsset(catalog, assetId, kind) {
  const asset = assetById(catalog, String(assetId || ""));
  return asset?.kind === kind ? asset : null;
}

function chooseClipAssets(candidate, audioSignals, catalog) {
  const hintedMeme = hintedAsset(catalog, candidate.asset_hints?.meme ?? candidate.selected_assets?.meme, "meme");
  const hintedSound = hintedAsset(catalog, candidate.asset_hints?.sound ?? candidate.selected_assets?.sound, "sound");
  const signalText = [
    candidate.title,
    candidate.reason,
    candidate.source,
    ...(candidate.signals ?? []),
    ...audioSignals.map((signal) => signal.label),
  ].join(" ").toLowerCase();
  const laughLike = signalText.includes("laugh");
  const awkwardLike = signalText.includes("embarrass") || signalText.includes("awkward") || signalText.includes("fail");
  const surpriseLike = signalText.includes("wtf") || signalText.includes("scream") || signalText.includes("shriek") || signalText.includes("surprise");

  return {
    meme: hintedMeme ?? assetById(catalog, awkwardLike ? "meme_embarrassed" : "meme_laugh"),
    sound: hintedSound ?? assetById(catalog, laughLike ? "sound_laugh" : surpriseLike ? "sound_wtf" : "sound_laugh"),
  };
}

function transcriptSegmentsForClip(analysis, clipStart, clipEnd) {
  const segments = Array.isArray(analysis?.transcription?.segments) ? analysis.transcription.segments : [];

  return segments
    .filter((segment) => overlapDuration(numberOr(segment.start), numberOr(segment.end), clipStart, clipEnd) > 0)
    .slice(0, 6)
    .map((segment) => ({
      start: Math.max(0, Number((numberOr(segment.start) - clipStart).toFixed(2))),
      end: Math.max(0.2, Number((numberOr(segment.end) - clipStart).toFixed(2))),
      text: cleanOverlayText(segment.text, ""),
    }))
    .filter((segment) => segment.text);
}

function audioSignalsForClip(analysis, clipStart, clipEnd) {
  const events = Array.isArray(analysis?.audio?.events) ? analysis.audio.events : [];

  return events
    .filter((event) => overlapDuration(numberOr(event.start), numberOr(event.end), clipStart, clipEnd) > 0)
    .map((event) => ({
      label: String(event.label || "audio"),
      start: Math.max(0, Number((numberOr(event.start) - clipStart).toFixed(2))),
      end: Math.max(0.2, Number((numberOr(event.end) - clipStart).toFixed(2))),
      score: numberOr(event.score),
    }));
}

function highlightCandidates(analysis) {
  const highlights = Array.isArray(analysis?.highlights) ? analysis.highlights : [];
  const funnyMoments = Array.isArray(analysis?.multimodal?.funny_moments) ? analysis.multimodal.funny_moments : [];
  const audioEvents = Array.isArray(analysis?.audio?.events) ? analysis.audio.events : [];
  const merged = [...highlights, ...funnyMoments]
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      start: numberOr(item.start),
      end: numberOr(item.end, numberOr(item.start) + 4),
      score: Math.min(1, Math.max(0, numberOr(item.score, 0.5))),
      title: cleanOverlayText(item.title, "Funny moment"),
      reason: cleanOverlayText(item.reason, "Backboard flagged this as a highlight."),
      source: String(item.source || "backboard"),
      signals: Array.isArray(item.signals) ? item.signals.map(String) : [],
      asset_hints: item.asset_hints && typeof item.asset_hints === "object"
        ? {
            meme: String(item.asset_hints.meme || ""),
            sound: String(item.asset_hints.sound || ""),
          }
        : {},
    }))
    .filter((item) => item.end > item.start);

  if (merged.length) {
    return merged;
  }

  return audioEvents
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      start: numberOr(item.start),
      end: numberOr(item.end, numberOr(item.start) + 3),
      score: Math.min(0.75, Math.max(0.35, numberOr(item.score, 0.45))),
      title: cleanOverlayText(String(item.label || "audio").replaceAll("_", " "), "Audio moment"),
      reason: cleanOverlayText(item.reason, "Audio event detected."),
      source: "audio",
      signals: [String(item.label || "audio")],
    }))
    .filter((item) => item.end > item.start);
}

function buildClipPlan(recording, analysis, assetCatalog) {
  const candidates = highlightCandidates(analysis)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .sort((a, b) => a.start - b.start);
  const sourceDuration = numberOr(analysis?.audio?.summary?.duration, numberOr(recording.duration, 0));
  const selected = candidates.length
    ? candidates
    : [{ start: 0, end: Math.min(sourceDuration || 8, 8), score: 0.35, title: "Opening moment", reason: "Fallback clip because no highlight was detected.", source: "fallback", signals: [] }];
  const clips = selected.map((candidate, index) => {
    const paddedStart = Math.max(0, candidate.start - 0.45);
    const rawEnd = Math.max(candidate.end + 0.65, paddedStart + 2.5);
    const paddedEnd = sourceDuration ? Math.min(sourceDuration, rawEnd) : rawEnd;
    const duration = Math.max(1.2, paddedEnd - paddedStart);
    const audioSignals = audioSignalsForClip(analysis, paddedStart, paddedEnd);
    const strongAudio = audioSignals.some((event) => ["scream_or_shriek", "laughter_like_bursts"].includes(event.label));
    const selectedAssets = chooseClipAssets(candidate, audioSignals, assetCatalog);

    return {
      id: `clip_${String(index + 1).padStart(2, "0")}`,
      order: index + 1,
      source_public_id: recording.public_id,
      trim: {
        start: Number(paddedStart.toFixed(2)),
        end: Number(paddedEnd.toFixed(2)),
        duration: Number(duration.toFixed(2)),
      },
      crop: {
        aspect_ratio: "9:16",
        width: 1080,
        height: 1920,
        mode: "fill",
        gravity: "auto",
      },
      captions: transcriptSegmentsForClip(analysis, paddedStart, paddedEnd),
      overlays: [
        selectedAssets.meme
          ? {
              type: "asset",
              role: "meme_reaction",
              asset_id: selectedAssets.meme.id,
              asset_path: selectedAssets.meme.path,
              label: selectedAssets.meme.label,
              position: "upper_right",
              start: Number(Math.min(0.2, duration / 5).toFixed(2)),
              duration: Number(Math.min(2.2, duration).toFixed(2)),
            }
          : null,
        {
          type: "text",
          role: "meme_title",
          text: cleanOverlayText(candidate.title, "Funny moment").toUpperCase(),
          position: "top",
          start: 0,
          duration: Math.min(2.8, duration),
        },
        {
          type: "text",
          role: "context",
          text: cleanOverlayText(candidate.reason, ""),
          position: "bottom",
          start: Math.max(0, duration - 2.8),
          duration: Math.min(2.8, duration),
        },
      ].filter((overlay) => overlay && (overlay.type === "asset" || overlay.text)),
      sound_effects: selectedAssets.sound
        ? [
            {
              asset_id: selectedAssets.sound.id,
              asset_path: selectedAssets.sound.path,
              label: selectedAssets.sound.label,
              start: Number(Math.min(Math.max(0.25, duration * 0.22), Math.max(0, duration - 0.7)).toFixed(2)),
              volume: strongAudio ? 0.55 : 0.42,
              mix: "duck_original_audio",
            },
          ]
        : [],
      selected_assets: {
        meme: selectedAssets.meme?.id ?? null,
        sound: selectedAssets.sound?.id ?? null,
      },
      effects: {
        zoom: {
          enabled: candidate.score >= 0.7,
          style: "subtle_punch_in",
          start: Number(Math.min(0.35, duration / 4).toFixed(2)),
          duration: Number(Math.min(1.4, duration / 2).toFixed(2)),
        },
        freeze_frame: {
          enabled: strongAudio,
          at: Number(Math.max(0.4, Math.min(duration - 0.4, duration * 0.58)).toFixed(2)),
          duration: strongAudio ? 0.45 : 0,
          reason: strongAudio ? "Emphasize scream/laughter reaction." : "",
        },
      },
      audio_signals: audioSignals,
      source_highlight: candidate,
    };
  });

  return {
    version: 1,
    status: "planned",
    generated_at: new Date().toISOString(),
    generator: "gestureforge-backboard-clip-plan-v1",
    recording_id: recording.recording_id,
    source: {
      public_id: recording.public_id,
      video_url: recording.video_url,
      duration: sourceDuration || null,
    },
    output: {
      format: "mp4",
      width: 1080,
      height: 1920,
      aspect_ratio: "9:16",
      video_codec: "h264",
      audio_codec: "aac",
      quality: "auto",
    },
    sequence: {
      mode: "splice",
      transition: "cut",
      clips,
    },
    asset_policy: {
      source: "local_asset_directory_only",
      asset_root: "asset",
      allowed_asset_ids: assetCatalog.map((asset) => asset.id),
      note: "Clip plan may only reference assets listed in asset_catalog.",
    },
    asset_catalog: assetCatalog,
    subtitle_style: {
      font_family: "Arial",
      font_size: 64,
      color: "white",
      background: "rgba(0,0,0,0.58)",
      gravity: "south",
    },
    meme_style: {
      font_family: "Impact",
      font_size: 78,
      color: "white",
      stroke: "black",
      gravity: "north",
    },
    manual_tuning: {
      editable_fields: [
        "sequence.clips[].trim.start",
        "sequence.clips[].trim.end",
        "sequence.clips[].overlays[].text",
        "sequence.clips[].selected_assets.meme",
        "sequence.clips[].selected_assets.sound",
        "sequence.clips[].effects.zoom.enabled",
        "sequence.clips[].effects.freeze_frame.enabled",
      ],
    },
  };
}

async function saveClipPlan(recording, analysis) {
  const assetCatalog = await localClipAssetCatalog();
  const plan = buildClipPlan(recording, analysis, assetCatalog);

  await mkdir(recordingPath(recording.recording_id), { recursive: true });
  await writeFile(recordingPath(recording.recording_id, "clip-plan.json"), JSON.stringify(plan, null, 2), "utf-8");
  await patchRecordingMeta(recording.recording_id, {
    clip_plan_status: "planned",
    clip_plan_path: "clip-plan.json",
    clip_plan_generated_at: plan.generated_at,
  });
  return plan;
}

async function getOrCreateClipPlan(recordingId) {
  const recording = await readRecordingMeta(recordingId);
  const existing = await readOptionalJson(recordingPath(recording.recording_id, "clip-plan.json"));

  if (existing) {
    return existing;
  }

  const analysis = await readOptionalJson(recordingPath(recording.recording_id, "analysis.json"));

  if (!analysis) {
    throw new Error("Video analysis must finish before generating a clip plan.");
  }

  return saveClipPlan(recording, analysis);
}

function requireCloudinaryCredentials() {
  const missing = [];

  if (!cloudinaryCloudName) {
    missing.push("CLOUDINARY_CLOUD_NAME");
  }

  if (!cloudinaryApiKey) {
    missing.push("CLOUDINARY_API_KEY");
  }

  if (!cloudinaryApiSecret) {
    missing.push("CLOUDINARY_API_SECRET");
  }

  if (missing.length) {
    throw new Error(`Set ${missing.join(", ")} in .env before rendering Cloudinary MP4 exports.`);
  }
}

function cloudinaryUploadAuthHeader() {
  return `Basic ${Buffer.from(`${cloudinaryApiKey}:${cloudinaryApiSecret}`).toString("base64")}`;
}

function encodeCloudinaryPathSegment(value) {
  return encodeURIComponent(String(value ?? ""))
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function cloudinaryDeliveryPublicId(publicId) {
  return String(publicId ?? "")
    .split("/")
    .filter(Boolean)
    .map(encodeCloudinaryPathSegment)
    .join("/");
}

function cloudinaryLayerPublicId(publicId) {
  return String(publicId ?? "")
    .split("/")
    .filter(Boolean)
    .map(encodeCloudinaryPathSegment)
    .join(":");
}

function cloudinaryText(value) {
  return encodeCloudinaryPathSegment(cleanOverlayText(value, ""))
    .replaceAll("%0A", "%20")
    .replaceAll("%0D", "%20");
}

function cloudinaryNumber(value, fallback = 0) {
  return Number(numberOr(value, fallback).toFixed(2)).toString();
}

function cloudinaryDeliveryUrl({ cloudName = cloudinaryCloudName, publicId, resourceType = "video", transformations = [], format = "mp4" }) {
  const transformationPath = transformations.filter(Boolean).join("/");
  const publicPath = cloudinaryDeliveryPublicId(publicId);
  const suffix = format ? `.${format}` : "";

  return `https://res.cloudinary.com/${encodeCloudinaryPathSegment(cloudName)}/${resourceType}/upload/${transformationPath ? `${transformationPath}/` : ""}${publicPath}${suffix}`;
}

function cloudinaryAssetResourceType(asset) {
  return asset.kind === "sound" ? "video" : "image";
}

function cloudinaryAssetPublicId(asset) {
  return `${cloudinaryAssetFolder}/${asset.id}`;
}

function cloudinaryRenderPublicId(recording, ...parts) {
  return [cloudinaryRenderFolder, recording.recording_id, ...parts]
    .map((part) => String(part ?? "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

async function cloudinaryUpload(resourceType, buildFormData, { attempts = 2 } = {}) {
  requireCloudinaryCredentials();

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const formData = new FormData();
    await buildFormData(formData);

    try {
      const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudinaryCloudName}/${resourceType}/upload`, {
        method: "POST",
        headers: {
          Authorization: cloudinaryUploadAuthHeader(),
        },
        body: formData,
      });
      const text = await response.text();
      let payload = {};

      try {
        payload = JSON.parse(text || "{}");
      } catch {
        payload = { raw: text };
      }

      if (response.ok) {
        return payload;
      }

      lastError = new Error(payload.error?.message || payload.message || `Cloudinary upload failed with ${response.status}.`);

      if (![420, 423, 429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;

      if (attempt === attempts) {
        throw error;
      }
    }

    await wait(2000 * attempt);
  }

  throw lastError || new Error("Cloudinary upload failed.");
}

async function uploadLocalAssetToCloudinary(asset) {
  const resourceType = cloudinaryAssetResourceType(asset);
  const publicId = cloudinaryAssetPublicId(asset);
  const filePath = resolve(assetDir, asset.filename);
  const info = await stat(filePath);

  if (!info.isFile()) {
    throw new Error(`Local asset is missing: ${asset.filename}`);
  }

  const bytes = await readFile(filePath);
  const mimeType = contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const result = await cloudinaryUpload(resourceType, (formData) => {
    formData.append("file", new Blob([bytes], { type: mimeType }), asset.filename);
    formData.append("public_id", publicId);
    formData.append("overwrite", "true");
    formData.append("invalidate", "true");
    formData.append("tags", "gestureforge,gestureforge-local-asset");
  });

  return {
    ...asset,
    cloudinary_public_id: result.public_id || publicId,
    cloudinary_resource_type: result.resource_type || resourceType,
    cloudinary_url: result.secure_url || result.url || cloudinaryDeliveryUrl({
      publicId,
      resourceType,
      format: resourceType === "image" ? extname(asset.filename).slice(1) : "mp3",
    }),
  };
}

async function syncLocalClipAssetsToCloudinary(assetCatalog) {
  const synced = {};

  for (const asset of assetCatalog) {
    synced[asset.id] = await uploadLocalAssetToCloudinary(asset);
  }

  return synced;
}

function validateRenderAssetSelection(assetCatalog, assetId, kind) {
  const normalizedId = String(assetId ?? "").trim();

  if (!normalizedId || normalizedId === "none") {
    return null;
  }

  const asset = hintedAsset(assetCatalog, normalizedId, kind);

  if (!asset) {
    throw new Error(`Asset ${normalizedId} is not allowed for ${kind}.`);
  }

  return asset;
}

function normalizeOverlayText(overlay, fallbackDuration) {
  const text = cleanOverlayText(overlay?.text, "");

  if (!text) {
    return null;
  }

  const start = Math.max(0, numberOr(overlay.start, 0));
  const duration = Math.max(0.4, Math.min(fallbackDuration, numberOr(overlay.duration, Math.min(2.8, fallbackDuration))));

  return {
    type: "text",
    role: String(overlay.role || "caption"),
    text,
    position: String(overlay.position || (overlay.role === "meme_title" ? "top" : "bottom")),
    start: Number(start.toFixed(2)),
    duration: Number(duration.toFixed(2)),
  };
}

function normalizeRenderableClip(recording, plan, clip, index, assetCatalog) {
  const sourceDuration = numberOr(plan?.source?.duration, numberOr(recording.duration, 0));
  const sourceLimit = sourceDuration || Infinity;
  const rawStart = Math.min(Math.max(0, numberOr(clip?.trim?.start, 0)), Math.max(0, sourceLimit - 0.8));
  const requestedEnd = numberOr(clip?.trim?.end, rawStart + 4);
  const rawEnd = sourceDuration
    ? Math.min(sourceDuration, Math.max(rawStart + 0.8, requestedEnd))
    : Math.max(rawStart + 0.8, requestedEnd);
  const duration = rawEnd - rawStart;
  const memeAsset = validateRenderAssetSelection(
    assetCatalog,
    clip?.selected_assets?.meme ?? clip?.overlays?.find((overlay) => overlay?.type === "asset")?.asset_id,
    "meme",
  );
  const soundAsset = validateRenderAssetSelection(
    assetCatalog,
    clip?.selected_assets?.sound ?? clip?.sound_effects?.[0]?.asset_id,
    "sound",
  );
  const textOverlays = (Array.isArray(clip?.overlays) ? clip.overlays : [])
    .filter((overlay) => overlay?.type === "text")
    .map((overlay) => normalizeOverlayText(overlay, duration))
    .filter(Boolean);
  const titleText = cleanOverlayText(clip?.source_highlight?.title, `Clip ${index + 1}`).toUpperCase();

  if (!textOverlays.some((overlay) => overlay.role === "meme_title")) {
    textOverlays.unshift({
      type: "text",
      role: "meme_title",
      text: titleText,
      position: "top",
      start: 0,
      duration: Number(Math.min(2.8, duration).toFixed(2)),
    });
  }

  const captions = (Array.isArray(clip?.captions) ? clip.captions : [])
    .map((caption) => ({
      start: Number(Math.max(0, numberOr(caption.start, 0)).toFixed(2)),
      end: Number(Math.min(duration, Math.max(0.2, numberOr(caption.end, 0.2))).toFixed(2)),
      text: cleanOverlayText(caption.text, ""),
    }))
    .filter((caption) => caption.text && caption.end > caption.start)
    .slice(0, 5);

  return {
    ...clip,
    id: clip?.id || `clip_${String(index + 1).padStart(2, "0")}`,
    order: index + 1,
    source_public_id: recording.public_id,
    trim: {
      start: Number(rawStart.toFixed(2)),
      end: Number(rawEnd.toFixed(2)),
      duration: Number(duration.toFixed(2)),
    },
    crop: {
      aspect_ratio: "9:16",
      width: 1080,
      height: 1920,
      mode: "fill",
      gravity: "auto",
    },
    captions,
    overlays: [
      memeAsset
        ? {
            type: "asset",
            role: "meme_reaction",
            asset_id: memeAsset.id,
            asset_path: memeAsset.path,
            label: memeAsset.label,
            position: "upper_right",
            start: Number(Math.min(0.2, duration / 5).toFixed(2)),
            duration: Number(Math.min(2.2, duration).toFixed(2)),
          }
        : null,
      ...textOverlays,
    ].filter(Boolean),
    sound_effects: soundAsset
      ? [
          {
            asset_id: soundAsset.id,
            asset_path: soundAsset.path,
            label: soundAsset.label,
            start: Number(Math.min(Math.max(0.2, duration * 0.2), Math.max(0, duration - 0.5)).toFixed(2)),
            volume: Math.max(0.15, Math.min(1, numberOr(clip?.sound_effects?.[0]?.volume, 0.45))),
            mix: "duck_original_audio",
          },
        ]
      : [],
    selected_assets: {
      meme: memeAsset?.id ?? null,
      sound: soundAsset?.id ?? null,
    },
  };
}

function normalizeRenderablePlan(recording, plan, assetCatalog) {
  const clips = Array.isArray(plan?.sequence?.clips) ? plan.sequence.clips : [];

  if (!clips.length) {
    throw new Error("Clip plan has no clips to render.");
  }

  return {
    ...plan,
    status: "rendering",
    source: {
      ...(plan.source ?? {}),
      public_id: recording.public_id,
      video_url: recording.video_url,
      duration: numberOr(plan?.source?.duration, numberOr(recording.duration, 0)) || null,
    },
    output: {
      format: "mp4",
      width: 1080,
      height: 1920,
      aspect_ratio: "9:16",
      video_codec: "h264",
      audio_codec: "aac",
      quality: "auto",
    },
    sequence: {
      mode: "splice",
      transition: "cut",
      clips: clips.slice(0, 6).map((clip, index) => normalizeRenderableClip(recording, plan, clip, index, assetCatalog)),
    },
    asset_policy: {
      source: "local_asset_directory_only",
      asset_root: "asset",
      allowed_asset_ids: assetCatalog.map((asset) => asset.id),
      note: "Cloudinary render may only sync and use assets listed in asset_catalog.",
    },
    asset_catalog: assetCatalog,
  };
}

function textLayerPlacement(position) {
  if (position === "top") {
    return "g_north,y_70";
  }

  if (position === "center") {
    return "g_center";
  }

  return "g_south,y_105";
}

function buildTextOverlayTransformation(overlay, fontFamily, fontSize) {
  const duration = Math.max(0.4, numberOr(overlay.duration, 2));
  const start = Math.max(0, numberOr(overlay.start, 0));
  const placement = textLayerPlacement(overlay.position);
  const text = cloudinaryText(overlay.text);

  if (!text) {
    return "";
  }

  return `l_text:${fontFamily}_${fontSize}_bold:${text},co_white,b_rgb:00000099/fl_layer_apply,${placement},so_${cloudinaryNumber(start)},du_${cloudinaryNumber(duration)}`;
}

function buildCaptionOverlayTransformation(caption) {
  const start = Math.max(0, numberOr(caption.start, 0));
  const duration = Math.max(0.25, numberOr(caption.end, start + 1) - start);
  const text = cloudinaryText(caption.text);

  if (!text) {
    return "";
  }

  return `l_text:Arial_58_bold:${text},co_white,b_rgb:00000099/fl_layer_apply,g_south,y_58,so_${cloudinaryNumber(start)},du_${cloudinaryNumber(duration)}`;
}

function buildMemeOverlayTransformation(overlay, syncedAsset) {
  if (!syncedAsset?.cloudinary_public_id) {
    return "";
  }

  const start = Math.max(0, numberOr(overlay.start, 0));
  const duration = Math.max(0.5, numberOr(overlay.duration, 1.8));
  const publicId = cloudinaryLayerPublicId(syncedAsset.cloudinary_public_id);

  return `l_${publicId}/c_fit,w_360,h_360/fl_layer_apply,g_north_east,x_52,y_118,so_${cloudinaryNumber(start)},du_${cloudinaryNumber(duration)}`;
}

function buildAudioOverlayTransformation(soundEffect, syncedAsset, clipDuration) {
  if (!syncedAsset?.cloudinary_public_id) {
    return "";
  }

  const start = Math.max(0, numberOr(soundEffect.start, 0));
  const duration = Math.max(0.4, Math.min(clipDuration - start, 2.2));
  const volume = Math.round(Math.max(0.1, Math.min(1, numberOr(soundEffect.volume, 0.45))) * 100);
  const publicId = cloudinaryLayerPublicId(syncedAsset.cloudinary_public_id);

  return `l_audio:${publicId},du_${cloudinaryNumber(duration)}/e_volume:${volume}/fl_layer_apply,so_${cloudinaryNumber(start)}`;
}

function buildEditedClipUrl(recording, clip, syncedAssets) {
  const width = numberOr(clip.crop?.width, 1080);
  const height = numberOr(clip.crop?.height, 1920);
  const gravity = clip.crop?.gravity === "auto" ? "auto" : "center";
  const transformations = [
    `so_${cloudinaryNumber(clip.trim?.start)},eo_${cloudinaryNumber(clip.trim?.end)}`,
    `c_fill,w_${width},h_${height},g_${gravity}`,
  ];

  if (clip.sound_effects?.length) {
    transformations.push("e_volume:82");
  }

  clip.overlays
    ?.filter((overlay) => overlay.type === "asset")
    .forEach((overlay) => {
      const component = buildMemeOverlayTransformation(overlay, syncedAssets[overlay.asset_id]);

      if (component) {
        transformations.push(component);
      }
    });

  clip.overlays
    ?.filter((overlay) => overlay.type === "text")
    .slice(0, 3)
    .forEach((overlay) => {
      const component = buildTextOverlayTransformation(
        overlay,
        "Arial",
        overlay.role === "meme_title" ? 78 : 48,
      );

      if (component) {
        transformations.push(component);
      }
    });

  clip.captions?.slice(0, 4).forEach((caption) => {
    const component = buildCaptionOverlayTransformation(caption);

    if (component) {
      transformations.push(component);
    }
  });

  clip.sound_effects?.slice(0, 1).forEach((soundEffect) => {
    const component = buildAudioOverlayTransformation(soundEffect, syncedAssets[soundEffect.asset_id], numberOr(clip.trim?.duration, 3));

    if (component) {
      transformations.push(component);
    }
  });

  if (clip.effects?.zoom?.enabled) {
    transformations.push("c_fill,w_1188,h_2112,g_auto/c_crop,w_1080,h_1920,g_auto");
  }

  transformations.push("q_auto,vc_h264,ac_aac");

  return cloudinaryDeliveryUrl({
    publicId: recording.public_id,
    resourceType: "video",
    transformations,
    format: "mp4",
  });
}

async function uploadCloudinaryRemoteVideo(sourceUrl, publicId, tags = "gestureforge,gestureforge-render") {
  return cloudinaryUpload("video", (formData) => {
    formData.append("file", sourceUrl);
    formData.append("public_id", publicId);
    formData.append("overwrite", "true");
    formData.append("invalidate", "true");
    formData.append("tags", tags);
  }, { attempts: 3 });
}

function buildFinalSpliceUrl(clipRenders) {
  const [firstClip, ...restClips] = clipRenders;

  if (!firstClip) {
    throw new Error("No rendered clips to splice.");
  }

  const transformations = [
    "c_fill,w_1080,h_1920,g_auto",
    ...restClips.flatMap((clip) => [
      `l_video:${cloudinaryLayerPublicId(clip.public_id)}`,
      "c_fill,w_1080,h_1920,g_auto",
      "fl_layer_apply,fl_splice",
    ]),
    "q_auto,vc_h264,ac_aac",
  ];

  return cloudinaryDeliveryUrl({
    publicId: firstClip.public_id,
    resourceType: "video",
    transformations,
    format: "mp4",
  });
}

async function renderRecordingClipPlan(recordingId, proposedPlan) {
  requireCloudinaryCredentials();

  const recording = await readRecordingMeta(recordingId);
  const savedPlan = await getOrCreateClipPlan(recording.recording_id);
  const assetCatalog = await localClipAssetCatalog();
  const renderPlan = normalizeRenderablePlan(recording, proposedPlan && typeof proposedPlan === "object" ? proposedPlan : savedPlan, assetCatalog);

  await patchRecordingMeta(recording.recording_id, {
    clip_render_status: "syncing_assets",
    clip_render_error: undefined,
  });

  const syncedAssets = await syncLocalClipAssetsToCloudinary(assetCatalog);
  const clipRenders = [];

  await patchRecordingMeta(recording.recording_id, {
    clip_render_status: "rendering_clips",
  });

  for (const clip of renderPlan.sequence.clips) {
    const sourceTransformUrl = buildEditedClipUrl(recording, clip, syncedAssets);
    const publicId = cloudinaryRenderPublicId(recording, "clips", clip.id);
    const upload = await uploadCloudinaryRemoteVideo(sourceTransformUrl, publicId);

    clipRenders.push({
      clip_id: clip.id,
      public_id: upload.public_id || publicId,
      source_transform_url: sourceTransformUrl,
      video_url: upload.secure_url || upload.url || cloudinaryDeliveryUrl({ publicId, resourceType: "video", format: "mp4" }),
      duration: clip.trim.duration,
    });
  }

  await patchRecordingMeta(recording.recording_id, {
    clip_render_status: "splicing",
  });

  const finalTransformUrl = buildFinalSpliceUrl(clipRenders);
  const finalPublicId = cloudinaryRenderPublicId(recording, "final");
  const finalUpload = await uploadCloudinaryRemoteVideo(finalTransformUrl, finalPublicId, "gestureforge,gestureforge-final-render");
  const resolvedFinalPublicId = finalUpload.public_id || finalPublicId;
  const resolvedFinalUrl = finalUpload.secure_url || finalUpload.url || cloudinaryDeliveryUrl({ publicId: resolvedFinalPublicId, resourceType: "video", format: "mp4" });
  const resolvedDownloadUrl = cloudinaryDeliveryUrl({
    publicId: resolvedFinalPublicId,
    resourceType: "video",
    transformations: ["fl_attachment"],
    format: "mp4",
  });
  const manifest = {
    version: 1,
    status: "rendered",
    generated_at: new Date().toISOString(),
    recording_id: recording.recording_id,
    cloudinary_cloud_name: cloudinaryCloudName,
    source_public_id: recording.public_id,
    final_public_id: resolvedFinalPublicId,
    final_url: resolvedFinalUrl,
    final_transform_url: finalTransformUrl,
    download_url: resolvedDownloadUrl,
    clip_renders: clipRenders,
    synced_assets: Object.fromEntries(
      Object.entries(syncedAssets).map(([id, asset]) => [
        id,
        {
          kind: asset.kind,
          label: asset.label,
          local_path: asset.path,
          public_id: asset.cloudinary_public_id,
          resource_type: asset.cloudinary_resource_type,
          url: asset.cloudinary_url,
        },
      ]),
    ),
    rendered_features: {
      trim: true,
      crop_9_16: true,
      splice: true,
      text_overlays: true,
      captions: true,
      meme_assets: true,
      sound_effects: true,
      zoom: renderPlan.sequence.clips.some((clip) => clip.effects?.zoom?.enabled),
      freeze_frame: false,
    },
    plan: renderPlan,
  };

  await writeFile(recordingPath(recording.recording_id, "clip-render.json"), JSON.stringify(manifest, null, 2), "utf-8");
  await patchRecordingMeta(recording.recording_id, {
    clip_render_status: "rendered",
    clip_render_path: "clip-render.json",
    clip_render_public_id: manifest.final_public_id,
    clip_render_url: manifest.final_url,
    clip_render_finished_at: manifest.generated_at,
  });

  return manifest;
}

async function runKeyboardAnalyzer(sessionId) {
  const sourceDir = sessionPath(sessionId, "original");
  const analysisPath = sessionPath(sessionId, "analysis.json");
  const stagePath = sessionPath(sessionId, "analysis-stage.json");
  const scriptPath = resolve(rootDir, "tools", "analyze_game_controls_with_composio.py");
  const commonArgs = [
    scriptPath,
    "--source",
    sourceDir,
    "--json-out",
    analysisPath,
    "--stage-out",
    stagePath,
    "--model",
    analyzerModel,
    "--max-files",
    analyzerMaxFiles,
    "--max-evidence",
    analyzerMaxEvidence,
    "--max-context-lines",
    analyzerMaxContextLines,
  ];

  await runCommand(pythonExecutable, commonArgs);

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
  const currentMeta = await readOptionalJson(sessionPath(sessionId, "session.json"));
  const existingAnalysis = await readOptionalJson(sessionPath(sessionId, "analysis.json"));

  if (currentMeta?.status === "ready" && existingAnalysis) {
    return;
  }

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
  const currentBeforeAnalyze = await readOptionalJson(sessionPath(sessionId, "session.json"));

  await writeSessionMeta(sessionId, {
    ...(currentBeforeAnalyze ?? meta),
    status: "analyzing",
    analyzing_started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  await runKeyboardAnalyzer(sessionId);

  const currentMeta = await readOptionalJson(sessionPath(sessionId, "session.json"));

  if (currentMeta?.status === "ready") {
    return;
  }

  await writeSessionMeta(sessionId, {
    ...(currentMeta ?? meta),
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
      clone_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await runCommand("git", ["clone", "--depth", "1", cloneUrl, originalDir], { cwd: rootDir });
    await writeSessionMeta(sessionId, {
      ...meta,
      status: "cloned",
      clone_started_at: (await readOptionalJson(sessionPath(sessionId, "session.json")))?.clone_started_at,
      cloned_at: new Date().toISOString(),
      source_path: "original",
      updated_at: new Date().toISOString(),
    });
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

async function serveAssetFile(response, filename) {
  const safeName = basename(decodeURIComponent(filename));
  const filePath = resolve(assetDir, safeName);

  if (filePath !== resolve(assetDir, safeName) || !filePath.startsWith(assetDir + sep)) {
    textResponse(response, 404, "Not found");
    return;
  }

  try {
    const info = await stat(filePath);

    if (!info.isFile()) {
      textResponse(response, 404, "Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    textResponse(response, 404, "Not found");
  }
}

async function readOptionalJson(path) {
  try {
    return JSON.parse((await readFile(path, "utf-8")).replace(/^\uFEFF/, ""));
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

    const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/i);
    if (request.method === "GET" && assetMatch) {
      await serveAssetFile(response, assetMatch[1]);
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
      const stopped = await stopCameraStream();
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

    if (request.method === "POST" && url.pathname === "/api/auth/signup") {
      const result = await signupUser(await readJsonBody(request));
      jsonResponse(response, result.status, result.payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const result = await loginUser(await readJsonBody(request));
      jsonResponse(response, result.status, result.payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/recordings/cloudinary") {
      const recording = await saveCloudinaryRecording(await readJsonBody(request));
      jsonResponse(response, 201, {
        status: "cloudinary_recording_saved",
        analysis_status: recording.analysis_status,
        recording_id: recording.recording_id,
        public_id: recording.public_id,
        video_url: recording.video_url,
      });
      return;
    }

    const recordingMatch = url.pathname.match(/^\/api\/recordings\/([a-z0-9-]+)$/i);
    if (request.method === "GET" && recordingMatch) {
      jsonResponse(response, 200, await readRecordingMeta(recordingMatch[1]));
      return;
    }

    const recordingAnalyzeMatch = url.pathname.match(/^\/api\/recordings\/([a-z0-9-]+)\/analyze$/i);
    if (request.method === "POST" && recordingAnalyzeMatch) {
      const recording = await readRecordingMeta(recordingAnalyzeMatch[1]);

      if (!["queued", "failed"].includes(recording.analysis_status)) {
        jsonResponse(response, 202, {
          recording_id: recording.recording_id,
          analysis_status: recording.analysis_status,
        });
        return;
      }

      processRecordingAnalysis(recording.recording_id);
      jsonResponse(response, 202, {
        recording_id: recording.recording_id,
        analysis_status: "queued",
      });
      return;
    }

    const recordingFeedbackMatch = url.pathname.match(/^\/api\/recordings\/([a-z0-9-]+)\/feedback$/i);
    if (request.method === "POST" && recordingFeedbackMatch) {
      jsonResponse(response, 202, await saveRecordingFeedback(recordingFeedbackMatch[1], await readJsonBody(request)));
      return;
    }

    const recordingAnalysisMatch = url.pathname.match(/^\/api\/recordings\/([a-z0-9-]+)\/analysis$/i);
    if (request.method === "GET" && recordingAnalysisMatch) {
      const recording = await readRecordingMeta(recordingAnalysisMatch[1]);
      const analysis = await readOptionalJson(recordingPath(recording.recording_id, "analysis.json"));

      if (!analysis || !["complete", "partial", "failed"].includes(recording.analysis_status)) {
        jsonResponse(response, recording.analysis_status === "failed" ? 500 : 202, {
          recording_id: recording.recording_id,
          analysis_status: recording.analysis_status,
          error: recording.analysis_error,
        });
        return;
      }

      jsonResponse(response, 200, {
        recording_id: recording.recording_id,
        analysis_status: recording.analysis_status,
        analysis,
      });
      return;
    }

    const clipPlanMatch = url.pathname.match(/^\/api\/recordings\/([a-z0-9-]+)\/clip-plan$/i);
    if (request.method === "GET" && clipPlanMatch) {
      const plan = await getOrCreateClipPlan(clipPlanMatch[1]);
      jsonResponse(response, 200, {
        recording_id: clipPlanMatch[1],
        clip_plan_status: plan.status,
        plan,
      });
      return;
    }

    const regenerateClipPlanMatch = url.pathname.match(/^\/api\/recordings\/([a-z0-9-]+)\/clip-plan\/regenerate$/i);
    if (request.method === "POST" && regenerateClipPlanMatch) {
      const recording = await readRecordingMeta(regenerateClipPlanMatch[1]);
      const analysis = await readOptionalJson(recordingPath(recording.recording_id, "analysis.json"));

      if (!analysis) {
        jsonResponse(response, 409, {
          recording_id: recording.recording_id,
          error: "Video analysis must finish before regenerating a clip plan.",
        });
        return;
      }

      const plan = await saveClipPlan(recording, analysis);
      jsonResponse(response, 200, {
        recording_id: recording.recording_id,
        clip_plan_status: plan.status,
        plan,
      });
      return;
    }

    const clipRenderMatch = url.pathname.match(/^\/api\/recordings\/([a-z0-9-]+)\/render$/i);
    if (request.method === "GET" && clipRenderMatch) {
      const recording = await readRecordingMeta(clipRenderMatch[1]);
      const render = await readOptionalJson(recordingPath(recording.recording_id, "clip-render.json"));

      if (!render) {
        jsonResponse(response, 404, {
          recording_id: recording.recording_id,
          clip_render_status: recording.clip_render_status || "idle",
          error: recording.clip_render_error || "No rendered MP4 yet.",
        });
        return;
      }

      jsonResponse(response, 200, {
        recording_id: recording.recording_id,
        clip_render_status: render.status,
        render,
      });
      return;
    }

    if (request.method === "POST" && clipRenderMatch) {
      const body = await readJsonBody(request);

      try {
        const render = await renderRecordingClipPlan(clipRenderMatch[1], body.plan);
        jsonResponse(response, 200, {
          recording_id: clipRenderMatch[1],
          clip_render_status: render.status,
          render,
        });
      } catch (error) {
        await patchRecordingMeta(clipRenderMatch[1], {
          clip_render_status: "failed",
          clip_render_error: error.message,
          clip_render_finished_at: new Date().toISOString(),
        });
        jsonResponse(response, 500, {
          recording_id: clipRenderMatch[1],
          clip_render_status: "failed",
          error: error.message,
        });
      }
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
      const sessionId = statusMatch[1];
      const meta = JSON.parse(await readFile(sessionPath(sessionId, "session.json"), "utf-8"));
      const analysisStage = await readOptionalJson(sessionPath(sessionId, "analysis-stage.json"));
      jsonResponse(response, 200, {
        ...meta,
        ...(analysisStage ? { analysis_stage: analysisStage } : {}),
      });
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
await mkdir(recordingsDir, { recursive: true });

createServer(handleRequest).listen(defaultPort, () => {
  console.log(`GestureForge backend listening on http://localhost:${defaultPort}`);
});
