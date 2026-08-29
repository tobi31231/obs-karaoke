const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { URL } = require("url");

const HOST = process.env.HOST || "127.0.0.1";
const BASE_PORT = Number(process.env.PORT || 5177);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 750 * 1024 * 1024;
const UPLOAD_DIR = path.join(__dirname, "work", "uploads");
const MODEL_SCRIPT = path.join(__dirname, "work", "model_align.py");

const clients = new Set();
const controlSessions = new Map();
const activeAlignmentJobs = new Map();
const cancelledAlignmentJobs = new Set();
let controlSessionSeen = false;
let controlShutdownTimer = null;
let shuttingDown = false;

function normalizeJobId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
}

function normalizeSessionId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
}

function cancelControlShutdown() {
  if (!controlShutdownTimer) return;
  clearTimeout(controlShutdownTimer);
  controlShutdownTimer = null;
}

function scheduleControlShutdown() {
  if (!controlSessionSeen || controlSessions.size > 0 || shuttingDown || controlShutdownTimer) return;
  controlShutdownTimer = setTimeout(() => {
    controlShutdownTimer = null;
    if (controlSessions.size === 0) shutdownSoon();
  }, 1800);
}

function markAlignmentCancelled(jobId) {
  if (!jobId) return;
  cancelledAlignmentJobs.add(jobId);
  const cleanup = setTimeout(() => cancelledAlignmentJobs.delete(jobId), 5 * 60 * 1000);
  cleanup.unref();
}

function cancelModelAlignment(jobId) {
  const normalized = normalizeJobId(jobId);
  if (!normalized) return false;
  markAlignmentCancelled(normalized);
  const job = activeAlignmentJobs.get(normalized);
  if (!job) return false;
  job.cancel();
  return true;
}

function initialPlayback() {
  const now = Date.now();
  return {
    currentTime: 0,
    playing: false,
    rate: 1,
    sequence: 0,
    startedAt: now,
    updatedAt: now
  };
}

function initialAligner() {
  return {
    mode: "none",
    model: null,
    device: null,
    confidence: 0,
    generatedAt: null
  };
}

function initialStyle() {
  return {
    showNext: true,
    fontSize: 56,
    accent: "#f6d365",
    textColor: "#ffffff",
    shadow: true,
    align: "center"
  };
}

const state = {
  revision: 0,
  title: "OBS Karaoke MVP",
  duration: 0,
  lyrics: [],
  timeline: [],
  aligner: initialAligner(),
  playback: initialPlayback(),
  style: initialStyle()
};

function clearUploads() {
  const uploadRoot = path.resolve(UPLOAD_DIR);
  const workRoot = path.resolve(__dirname, "work");
  if (!uploadRoot.startsWith(workRoot + path.sep)) return;

  try {
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  } catch {
    // Uploaded media may still be held by an active analysis process while shutting down.
  }

  try {
    fs.mkdirSync(uploadRoot, { recursive: true });
  } catch {
    // The next upload attempt will report any persistent filesystem problem.
  }
}

function resetState() {
  state.title = "OBS Karaoke MVP";
  state.duration = 0;
  state.lyrics = [];
  state.timeline = [];
  state.aligner = initialAligner();
  state.playback = initialPlayback();
  state.style = initialStyle();
  state.revision += 1;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function extendDurationIfNeeded(nextDuration) {
  const previousDuration = positiveFinite(state.duration);
  if (!nextDuration || nextDuration <= previousDuration + 0.25) return;

  state.duration = nextDuration;
  const lastRow = state.timeline[state.timeline.length - 1];
  if (lastRow && (!previousDuration || lastRow.end >= previousDuration - 0.75)) {
    lastRow.end = nextDuration;
  }
}

function currentPlaybackTime(now = Date.now()) {
  const duration = Number(state.duration) || 0;
  let currentTime = Number(state.playback.currentTime) || 0;

  if (state.playback.playing) {
    currentTime += ((now - state.playback.startedAt) / 1000) * state.playback.rate;
  }

  if (duration > 0) {
    return clamp(currentTime, 0, duration);
  }

  return Math.max(0, currentTime);
}

function snapshot() {
  const now = Date.now();
  return {
    revision: state.revision,
    serverNow: now,
    title: state.title,
    duration: state.duration,
    lyrics: state.lyrics,
    timeline: state.timeline,
    aligner: state.aligner,
    style: state.style,
    playback: {
      ...state.playback,
      currentTime: currentPlaybackTime(now)
    }
  };
}

function bumpRevision() {
  state.revision += 1;
  broadcast();
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function readBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function splitBuffer(buffer, delimiter) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);

  while (index !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }

  parts.push(buffer.subarray(start));
  return parts;
}

function parseMultipartBuffer(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(buffer, boundaryBuffer);
  const fields = {};
  const files = {};

  for (let part of parts) {
    if (!part.length) continue;
    if (part.subarray(0, 2).toString() === "--") continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;

    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const content = part.subarray(headerEnd + 4);
    const disposition = headerText.split(/\r?\n/).find((line) => line.toLowerCase().startsWith("content-disposition:")) || "";
    const nameMatch = disposition.match(/name="([^"]+)"/);
    const filenameMatch = disposition.match(/filename="([^"]*)"/);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    if (filenameMatch && filenameMatch[1]) {
      files[name] = {
        filename: path.basename(filenameMatch[1]).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_"),
        content
      };
    } else {
      fields[name] = content.toString("utf8");
    }
  }

  return { fields, files };
}

function findPythonExecutable() {
  const localPython = process.platform === "win32"
    ? path.join(__dirname, ".venv", "Scripts", "python.exe")
    : path.join(__dirname, ".venv", "bin", "python");
  const bundledPython = process.platform === "win32"
    ? path.join(__dirname, "python", "python.exe")
    : path.join(__dirname, "python", "bin", "python");

  if (fs.existsSync(bundledPython)) return bundledPython;
  if (fs.existsSync(localPython)) return localPython;
  return process.env.PYTHON || "python";
}

function runModelAligner(args, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 30 * 60 * 1000;
  const jobId = normalizeJobId(options.jobId);

  return new Promise((resolve) => {
    const child = spawn(findPythonExecutable(), [MODEL_SCRIPT, ...args], {
      cwd: __dirname,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        HF_HOME: path.join(__dirname, "models", ".cache"),
        HUGGINGFACE_HUB_CACHE: path.join(__dirname, "models", ".cache", "hub"),
        PATH: [
          path.join(__dirname, "python"),
          path.join(__dirname, "python", "Scripts"),
          process.env.PATH || ""
        ].join(path.delimiter)
      }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (jobId && activeAlignmentJobs.get(jobId)?.child === child) {
        activeAlignmentJobs.delete(jobId);
      }
      resolve(payload);
    };

    const cancel = () => {
      if (!child.killed) child.kill();
      finish({
        ok: false,
        code: "ANALYSIS_CANCELLED",
        cancelled: true,
        error: "Analysis was cancelled by the user."
      });
    };

    if (jobId) {
      activeAlignmentJobs.set(jobId, { child, cancel });
      if (cancelledAlignmentJobs.has(jobId)) cancel();
    }

    if (!settled) {
      timeout = setTimeout(() => {
        if (!child.killed) child.kill();
        finish({ ok: false, code: "ANALYSIS_TIMEOUT", error: "Local model analysis timed out.", stderr });
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({ ok: false, error: error.message, stderr });
    });
    child.on("close", (code) => {
      if (jobId && cancelledAlignmentJobs.has(jobId)) {
        finish({
          ok: false,
          code: "ANALYSIS_CANCELLED",
          cancelled: true,
          error: "Analysis was cancelled by the user.",
          exitCode: code
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "{}");
        finish({ ...parsed, exitCode: code, stderr });
      } catch (error) {
        finish({ ok: false, exitCode: code, error: error.message, stdout, stderr });
      }
    });
  });
}

function normalizeTokens(tokens, rowStart, rowEnd) {
  if (!Array.isArray(tokens)) return [];
  return tokens.map((token, index) => {
    const start = clamp(Number(token.start) || rowStart, rowStart, rowEnd);
    const end = clamp(Number(token.end) || start, start, rowEnd);
    return {
      index,
      text: String(token.text || ""),
      start,
      end,
      confidence: Number.isFinite(Number(token.confidence)) ? clamp(Number(token.confidence), 0, 1) : 0,
      source: String(token.source || "estimated"),
      timed: Boolean(token.timed)
    };
  });
}

function normalizeTimeline(timeline, duration) {
  const rows = Array.isArray(timeline) ? timeline : [];
  const normalized = rows
    .map((row, index) => ({
      id: String(row.id || `line-${index + 1}`),
      index: Number.isFinite(Number(row.index)) ? Number(row.index) : index,
      text: String(row.text || "").trim(),
      start: Math.max(0, Number(row.start) || 0),
      end: Math.max(0, Number(row.end) || 0),
      confidence: Number.isFinite(Number(row.confidence)) ? clamp(Number(row.confidence), 0, 1) : 0,
      tokenConfidence: Number.isFinite(Number(row.tokenConfidence)) ? clamp(Number(row.tokenConfidence), 0, 1) : 0,
      source: String(row.source || "estimated"),
      tokens: Array.isArray(row.tokens) ? row.tokens : [],
      anchor: Boolean(row.anchor)
    }))
    .filter((row) => row.text.length > 0)
    .sort((a, b) => a.start - b.start);

  for (let index = 0; index < normalized.length; index += 1) {
    normalized[index].index = index;
    normalized[index].id = `line-${index + 1}`;
    const previous = normalized[index - 1];
    if (previous && normalized[index].start <= previous.start + 0.15) {
      normalized[index].start = previous.start + 0.15;
    }

    const next = normalized[index + 1];
    const fallbackEnd = next ? Math.max(normalized[index].start + 0.1, next.start - 0.05) : duration;
    normalized[index].end = Math.max(normalized[index].start + 0.1, normalized[index].end || fallbackEnd);
    if (next) {
      normalized[index].end = Math.min(normalized[index].end, Math.max(normalized[index].start + 0.1, next.start - 0.05));
    }

    if (duration > 0) {
      normalized[index].start = clamp(normalized[index].start, 0, duration);
      normalized[index].end = clamp(normalized[index].end, normalized[index].start + 0.1, duration);
    }
    normalized[index].tokens = normalizeTokens(
      normalized[index].tokens,
      normalized[index].start,
      normalized[index].end
    );
  }

  return normalized;
}

function updatePlayback(payload) {
  const now = Date.now();
  const action = String(payload.action || "").toLowerCase();
  const previousSequence = Number(state.playback.sequence) || 0;
  const incomingSequence = Number(payload.sequence);
  if (Number.isFinite(incomingSequence) && incomingSequence < previousSequence) {
    return false;
  }

  const sequence = Number.isFinite(incomingSequence) ? incomingSequence : previousSequence + 1;
  extendDurationIfNeeded(positiveFinite(payload.duration));

  const requestedTime = Number.isFinite(Number(payload.currentTime))
    ? Number(payload.currentTime)
    : currentPlaybackTime(now);
  const duration = Number(state.duration) || 0;
  const currentTime = duration > 0 ? clamp(requestedTime, 0, duration) : Math.max(0, requestedTime);
  const rate = Number.isFinite(Number(payload.rate)) && Number(payload.rate) > 0 ? Number(payload.rate) : state.playback.rate;

  if (action === "play") {
    state.playback = {
      currentTime,
      playing: true,
      rate,
      sequence,
      startedAt: now,
      updatedAt: now
    };
    return true;
  }

  if (action === "pause" || action === "stop") {
    state.playback = {
      currentTime: action === "stop" ? 0 : currentTime,
      playing: false,
      rate,
      sequence,
      startedAt: now,
      updatedAt: now
    };
    return true;
  }

  if (action === "restart") {
    state.playback = {
      currentTime: 0,
      playing: Boolean(payload.playing),
      rate,
      sequence,
      startedAt: now,
      updatedAt: now
    };
    return true;
  }

  state.playback = {
    currentTime,
    playing: Boolean(payload.playing ?? state.playback.playing),
    rate,
    sequence,
    startedAt: now,
    updatedAt: now
  };
  return true;
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };
  return types[ext] || "application/octet-stream";
}

function sendStatic(req, res, pathname) {
  const route = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(route).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    res.writeHead(200, {
      "content-type": mimeType(filePath),
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "pragma": "no-cache",
      "expires": "0"
    });
    res.end(data);
  });
}

function shutdownSoon() {
  if (shuttingDown) return;
  shuttingDown = true;
  cancelControlShutdown();
  for (const [jobId] of activeAlignmentJobs) {
    cancelModelAlignment(jobId);
  }
  resetState();
  clearUploads();
  broadcast();
  setTimeout(() => {
    for (const res of clients) {
      try {
        res.end();
      } catch {
        // Ignore closed event streams during shutdown.
      }
    }
    for (const res of controlSessions.values()) {
      try {
        res.end();
      } catch {
        // Ignore control connections that already closed.
      }
    }
    controlSessions.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  }, 80).unref();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${BASE_PORT}`}`);
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/api/state") {
      sendJson(res, 200, snapshot());
      return;
    }

    if (req.method === "GET" && pathname === "/api/control-session") {
      const sessionId = normalizeSessionId(url.searchParams.get("sessionId"));
      if (!sessionId) {
        sendJson(res, 400, { error: "Control session ID is missing." });
        return;
      }

      const previous = controlSessions.get(sessionId);
      if (previous && previous !== res) {
        try {
          previous.end();
        } catch {
          // The previous page may already be gone during a reload.
        }
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      res.write("event: ready\ndata: {}\n\n");
      controlSessionSeen = true;
      controlSessions.set(sessionId, res);
      cancelControlShutdown();

      const closeControlSession = () => {
        if (controlSessions.get(sessionId) === res) {
          controlSessions.delete(sessionId);
          scheduleControlShutdown();
        }
      };
      res.on("close", closeControlSession);
      req.on("aborted", closeControlSession);
      return;
    }

    if (req.method === "POST" && pathname === "/api/control-session/close") {
      const sessionId = normalizeSessionId(url.searchParams.get("sessionId"));
      if (!sessionId) {
        sendJson(res, 400, { error: "Control session ID is missing." });
        return;
      }

      const controlResponse = controlSessions.get(sessionId);
      if (controlResponse) {
        controlSessions.delete(sessionId);
        try {
          controlResponse.end();
        } catch {
          // The browser may already have closed the event stream.
        }
      }
      sendJson(res, 200, { ok: true });
      scheduleControlShutdown();
      return;
    }

    if (req.method === "GET" && pathname === "/api/model-status") {
      const result = await runModelAligner(
        ["--check", "--model", "turbo"],
        { timeoutMs: 60 * 1000 }
      );
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/shutdown") {
      sendJson(res, 200, { ok: true });
      shutdownSoon();
      return;
    }

    if (req.method === "POST" && pathname === "/api/model-align/cancel") {
      const payload = await readJson(req);
      const jobId = normalizeJobId(payload.jobId);
      if (!jobId) {
        sendJson(res, 400, { ok: false, error: "Analysis job ID is missing." });
        return;
      }
      const active = cancelModelAlignment(jobId);
      sendJson(res, 200, { ok: true, cancelled: true, active, jobId });
      return;
    }

    if (req.method === "GET" && pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "POST" && pathname === "/api/project") {
      const payload = await readJson(req);
      const duration = Math.max(0, Number(payload.duration) || 0);
      state.title = String(payload.title || "OBS Karaoke MVP").slice(0, 160);
      state.duration = duration;
      state.lyrics = Array.isArray(payload.lyrics) ? payload.lyrics.map((line) => String(line)) : [];
      state.timeline = normalizeTimeline(payload.timeline, duration);
      state.aligner = {
        mode: String(payload.aligner?.mode || "local-browser-aligner"),
        confidence: Number.isFinite(Number(payload.aligner?.confidence)) ? clamp(Number(payload.aligner.confidence), 0, 1) : 0,
        generatedAt: new Date().toISOString()
      };
      updatePlayback({ action: "pause", currentTime: 0 });
      bumpRevision();
      sendJson(res, 200, snapshot());
      return;
    }

    if (req.method === "POST" && pathname === "/api/model-align") {
      const contentType = req.headers["content-type"] || "";
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
      if (!boundaryMatch) {
        sendJson(res, 400, { ok: false, error: "Multipart boundary is missing." });
        return;
      }

      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const body = await readBuffer(req, MAX_UPLOAD_BYTES);
      const { fields, files } = parseMultipartBuffer(body, boundaryMatch[1] || boundaryMatch[2]);
      const audio = files.audio;
      const lyrics = String(fields.lyrics || "");

      if (!audio) {
        sendJson(res, 400, { ok: false, error: "Audio file is missing." });
        return;
      }

      if (!lyrics.trim()) {
        sendJson(res, 400, { ok: false, error: "Lyrics text is missing." });
        return;
      }

      const requestedJobId = normalizeJobId(fields.jobId);
      const jobId = requestedJobId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      if (cancelledAlignmentJobs.has(jobId)) {
        cancelledAlignmentJobs.delete(jobId);
        sendJson(res, 200, {
          ok: false,
          code: "ANALYSIS_CANCELLED",
          cancelled: true,
          error: "Analysis was cancelled by the user."
        });
        return;
      }

      const audioPath = path.join(UPLOAD_DIR, `${jobId}-${audio.filename || "audio"}`);
      const lyricsPath = path.join(UPLOAD_DIR, `${jobId}-lyrics.txt`);
      fs.writeFileSync(audioPath, audio.content);
      fs.writeFileSync(lyricsPath, lyrics, "utf8");

      const cancelOnDisconnect = () => {
        if (!res.writableEnded) cancelModelAlignment(jobId);
      };
      res.once("close", cancelOnDisconnect);

      let result;
      try {
        result = await runModelAligner([
          "--audio", audioPath,
          "--lyrics", lyricsPath,
          "--model", String(fields.model || "turbo")
        ], { jobId });
      } finally {
        res.off("close", cancelOnDisconnect);
        try {
          fs.rmSync(audioPath, { force: true });
          fs.rmSync(lyricsPath, { force: true });
        } catch {
          // Cleanup is retried when the app exits if the process still held a file.
        }
      }

      cancelledAlignmentJobs.delete(jobId);

      if (!result.ok) {
        sendJson(res, 200, result);
        return;
      }

      const duration = Math.max(positiveFinite(fields.duration), positiveFinite(result.duration));
      state.title = String(fields.title || audio.filename || "OBS Karaoke MVP").slice(0, 160);
      state.duration = duration;
      state.lyrics = Array.isArray(result.lyrics) ? result.lyrics : [];
      state.timeline = normalizeTimeline(result.timeline, duration);
      state.aligner = {
        mode: `local-whisper-${String(fields.model || "turbo")}`,
        model: String(result.model || fields.model || "turbo"),
        device: String(result.device || "unknown"),
        confidence: Number.isFinite(Number(result.confidence)) ? clamp(Number(result.confidence), 0, 1) : 0.82,
        generatedAt: new Date().toISOString()
      };
      updatePlayback({ action: "pause", currentTime: 0 });
      bumpRevision();

      sendJson(res, 200, {
        ...snapshot(),
        ok: true,
        engine: result.engine || "unknown",
        model: result.model || String(fields.model || "turbo"),
        device: result.device || "unknown",
        language: result.language || "auto",
        selectedVariant: result.selectedVariant || "unknown",
        alignmentMethod: result.alignmentMethod || "unknown",
        quality: Number(result.quality) || 0,
        transcriptSegments: result.transcriptSegments || 0,
        transcriptWords: result.transcriptWords || 0,
        matchedLines: result.matchedLines || 0,
        rescuedLines: result.rescuedLines || 0,
        forcedLines: result.forcedLines || 0,
        repeatedLines: result.repeatedLines || 0,
        autoSegmentation: result.autoSegmentation || null,
        candidates: Array.isArray(result.candidates)
          ? result.candidates.slice(0, 24).map((candidate) => ({
            variant: String(candidate.variant || "unknown").slice(0, 120),
            alignmentMethod: String(candidate.alignmentMethod || "unknown").slice(0, 160),
            matchedLines: Number(candidate.matchedLines) || 0,
            quality: Number(candidate.quality) || 0,
            transcriptHealth: Number(candidate.transcriptHealth) || 0,
            segments: Number(candidate.segments) || 0
          }))
          : [],
        compatibility: result.compatibility || null
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/timeline") {
      const payload = await readJson(req);
      state.timeline = normalizeTimeline(payload.timeline, state.duration);
      bumpRevision();
      sendJson(res, 200, snapshot());
      return;
    }

    if (req.method === "POST" && pathname === "/api/playback") {
      const payload = await readJson(req);
      if (updatePlayback(payload)) {
        bumpRevision();
      }
      sendJson(res, 200, snapshot());
      return;
    }

    if (req.method === "POST" && pathname === "/api/style") {
      const payload = await readJson(req);
      state.style = {
        ...state.style,
        showNext: Boolean(payload.showNext ?? state.style.showNext),
        fontSize: clamp(Number(payload.fontSize) || state.style.fontSize, 28, 96),
        accent: String(payload.accent || state.style.accent).slice(0, 32),
        textColor: String(payload.textColor || state.style.textColor).slice(0, 32),
        shadow: Boolean(payload.shadow ?? state.style.shadow),
        align: ["left", "center", "right"].includes(payload.align) ? payload.align : state.style.align
      };
      bumpRevision();
      sendJson(res, 200, snapshot());
      return;
    }

    if (req.method === "GET" && pathname === "/overlay") {
      sendStatic(req, res, "/overlay.html");
      return;
    }

    if (req.method === "GET") {
      sendStatic(req, res, pathname);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Bad request" });
  }
});

function listen(port) {
  server.removeAllListeners("error");
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && port < BASE_PORT + 20) {
      listen(port + 1);
      return;
    }

    console.error(error);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    console.log(`OBS Karaoke MVP running at http://${HOST}:${port}`);
    console.log(`OBS overlay URL: http://${HOST}:${port}/overlay`);
  });
}

setInterval(() => {
  if (clients.size > 0) {
    broadcast();
  }
}, 1000);

const controlKeepAlive = setInterval(() => {
  for (const res of controlSessions.values()) {
    try {
      res.write(": keep-alive\n\n");
    } catch {
      // The close handler removes disconnected sessions.
    }
  }
}, 15000);
controlKeepAlive.unref();

clearUploads();
listen(BASE_PORT);
