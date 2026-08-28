const elements = {
  overlayUrl: document.querySelector("#overlayUrl"),
  copyOverlay: document.querySelector("#copyOverlay"),
  audioFile: document.querySelector("#audioFile"),
  lyricsFile: document.querySelector("#lyricsFile"),
  lyricsText: document.querySelector("#lyricsText"),
  generateSync: document.querySelector("#generateSync"),
  modelStatus: document.querySelector("#modelStatus"),
  analysisStatus: document.querySelector("#analysisStatus"),
  analysisLoading: document.querySelector("#analysisLoading"),
  analysisLoadingMessage: document.querySelector("#analysisLoadingMessage"),
  analysisElapsed: document.querySelector("#analysisElapsed"),
  cancelAnalysis: document.querySelector("#cancelAnalysis"),
  analysisConflict: document.querySelector("#analysisConflict"),
  analysisConflictTitle: document.querySelector("#analysisConflictTitle"),
  analysisConflictMessage: document.querySelector("#analysisConflictMessage"),
  projectTitle: document.querySelector("#projectTitle"),
  audioPlayer: document.querySelector("#audioPlayer"),
  waveform: document.querySelector("#waveform"),
  currentTime: document.querySelector("#currentTime"),
  duration: document.querySelector("#duration"),
  previewCurrent: document.querySelector("#previewCurrent"),
  previewNext: document.querySelector("#previewNext"),
  restartPlayback: document.querySelector("#restartPlayback"),
  syncPlayback: document.querySelector("#syncPlayback"),
  exportProject: document.querySelector("#exportProject"),
  importProject: document.querySelector("#importProject"),
  timelineBody: document.querySelector("#timelineBody"),
  setSelectedToNow: document.querySelector("#setSelectedToNow"),
  shiftAfterButtons: document.querySelectorAll("[data-shift-after]"),
  shiftAllButtons: document.querySelectorAll("[data-shift-all]"),
  fontSize: document.querySelector("#fontSize"),
  fontSizeValue: document.querySelector("#fontSizeValue"),
  showNext: document.querySelector("#showNext"),
  shadow: document.querySelector("#shadow"),
  accent: document.querySelector("#accent"),
  textColor: document.querySelector("#textColor"),
  alignButtons: document.querySelectorAll("[data-align]"),
  developerPanel: document.querySelector("#developerPanel"),
  developerSessionStatus: document.querySelector("#developerSessionStatus"),
  developerSummary: document.querySelector("#developerSummary"),
  developerLog: document.querySelector("#developerLog"),
  exportDeveloperLog: document.querySelector("#exportDeveloperLog"),
  clearDeveloperLog: document.querySelector("#clearDeveloperLog"),
  closeDeveloperMode: document.querySelector("#closeDeveloperMode")
};

const app = {
  audioFile: null,
  audioBuffer: null,
  audioObjectUrl: null,
  waveform: null,
  lines: [],
  timeline: [],
  baseTimeline: [],
  state: null,
  projectDuration: 0,
  selectedIndex: 0,
  lastPlaybackPost: 0,
  playbackSequence: 0,
  lastKnownAudioTime: 0,
  recoveringEarlyEnd: false,
  activeAlign: "center",
  previewKey: "",
  previewSlots: [],
  developerMode: false,
  developerEvents: [],
  developerEventSequence: 0,
  developerSessionStartedAt: Date.now(),
  developerBaseline: [],
  developerAnalysis: null,
  developerResultSource: null
};

const APP_VERSION = "20260828-developer-logging-1";
const DEVELOPER_TOGGLE_PRESS_COUNT = 5;
const DEVELOPER_TOGGLE_WINDOW_MS = 2500;
const DEVELOPER_EVENT_LIMIT = 1000;
const CONTROL_SESSION_ID = typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

let analysisStartedAt = 0;
let analysisElapsedTimer = null;
let activeAnalysisJobId = null;
let activeAnalysisController = null;
let analysisCancelRequested = false;
let analysisCancelling = false;
let controlSessionStream = null;
let controlSessionClosing = false;
let developerF12Presses = [];

function openControlSession() {
  if (controlSessionStream && controlSessionStream.readyState !== EventSource.CLOSED) return;
  controlSessionClosing = false;
  controlSessionStream = new EventSource(
    `/api/control-session?sessionId=${encodeURIComponent(CONTROL_SESSION_ID)}`
  );
}

function closeControlSession() {
  if (controlSessionClosing) return;
  controlSessionClosing = true;
  const closeUrl = `/api/control-session/close?sessionId=${encodeURIComponent(CONTROL_SESSION_ID)}`;
  let queued = false;
  try {
    queued = navigator.sendBeacon(closeUrl);
  } catch {
    // Fall through to a keepalive request when sendBeacon is unavailable.
  }
  if (!queued) {
    fetch(closeUrl, { method: "POST", keepalive: true }).catch(() => {});
  }
  controlSessionStream?.close();
  controlSessionStream = null;
}

elements.overlayUrl.value = `${location.origin}/overlay?v=${APP_VERSION}`;

function setStatus(message, isError = false) {
  elements.analysisStatus.textContent = message;
  elements.analysisStatus.classList.toggle("error", isError);
  if (!isError && elements.analysisLoading && !elements.analysisLoading.hidden) {
    elements.analysisLoadingMessage.textContent = message;
  }
}

function diagnosticNumber(value, digits = 3) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
}

function normalizedDiagnosticLine(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function detectDiagnosticScript(text) {
  const value = String(text || "");
  const scripts = [];
  if (/[\uac00-\ud7af]/u.test(value)) scripts.push("ko");
  if (/[\u3040-\u30ff]/u.test(value)) scripts.push("ja");
  if (/[\u3400-\u9fff]/u.test(value) && !scripts.includes("ja")) scripts.push("cjk");
  if (/[A-Za-z]/u.test(value)) scripts.push("latin");
  return scripts.length === 0 ? "other" : scripts.join("+");
}

const DIAGNOSTIC_TIMELINE_SOURCES = new Set([
  "character",
  "estimated",
  "estimated-line",
  "exact",
  "forced-repeat",
  "forced-text",
  "fuzzy",
  "global-anchors",
  "measured",
  "repeated-duration",
  "repeated-pattern",
  "segment",
  "segment-sequence",
  "separator",
  "word",
  "word+character"
]);

function sanitizeDiagnosticTimelineSource(source) {
  const value = String(source || "unknown").trim().toLocaleLowerCase();
  if (DIAGNOSTIC_TIMELINE_SOURCES.has(value)) return value;
  for (const prefix of ["candidate-", "window-"]) {
    if (!value.startsWith(prefix)) continue;
    const nested = sanitizeDiagnosticTimelineSource(value.slice(prefix.length));
    return nested === "other" ? "other" : `${prefix}${nested}`;
  }
  return "other";
}

function buildDiagnosticRepeatMetadata(lines) {
  const groups = new Map();
  for (const [index, line] of lines.entries()) {
    const key = normalizedDiagnosticLine(line);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  }

  const result = Array.from({ length: lines.length }, () => ({
    repeatGroup: null,
    repeatOccurrence: null,
    repeatCount: 1
  }));
  let groupNumber = 0;
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    groupNumber += 1;
    indexes.forEach((lineIndex, occurrence) => {
      result[lineIndex] = {
        repeatGroup: groupNumber,
        repeatOccurrence: occurrence + 1,
        repeatCount: indexes.length
      };
    });
  }
  return result;
}

function buildDiagnosticLyricsSummary(lines = app.lines) {
  const repeatMetadata = buildDiagnosticRepeatMetadata(lines);
  const scripts = {};
  let characters = 0;
  let nonWhitespaceCharacters = 0;
  for (const line of lines) {
    const text = String(line || "");
    const script = detectDiagnosticScript(text);
    scripts[script] = (scripts[script] || 0) + 1;
    characters += Array.from(text).length;
    nonWhitespaceCharacters += Array.from(text.replace(/\s/gu, "")).length;
  }
  return {
    lineCount: lines.length,
    characterCount: characters,
    nonWhitespaceCharacterCount: nonWhitespaceCharacters,
    scriptLineCounts: scripts,
    repeatedLineCount: repeatMetadata.filter((row) => row.repeatGroup !== null).length,
    repeatedGroupCount: Math.max(0, ...repeatMetadata.map((row) => row.repeatGroup || 0))
  };
}

function sanitizeDiagnosticTimeline(timeline = app.timeline, lines = app.lines) {
  const repeatMetadata = buildDiagnosticRepeatMetadata(lines);
  return timeline.map((row, index) => {
    const lineIndex = Number.isInteger(Number(row.index)) ? Number(row.index) : index;
    const text = String(lines[lineIndex] ?? row.text ?? "");
    const repeat = repeatMetadata[lineIndex] || {
      repeatGroup: null,
      repeatOccurrence: null,
      repeatCount: 1
    };
    return {
      lineIndex,
      start: diagnosticNumber(row.start),
      end: diagnosticNumber(row.end),
      duration: diagnosticNumber(Number(row.end) - Number(row.start)),
      confidence: diagnosticNumber(row.confidence),
      tokenConfidence: diagnosticNumber(row.tokenConfidence),
      source: sanitizeDiagnosticTimelineSource(row.source),
      characterCount: Array.from(text).length,
      nonWhitespaceCharacterCount: Array.from(text.replace(/\s/gu, "")).length,
      wordCount: text.trim() ? text.trim().split(/\s+/u).length : 0,
      script: detectDiagnosticScript(text),
      repeatGroup: repeat.repeatGroup,
      repeatOccurrence: repeat.repeatOccurrence,
      repeatCount: repeat.repeatCount,
      anchor: Boolean(row.anchor)
    };
  });
}

function sanitizeDiagnosticAnalysis(result, source, elapsedMs) {
  const compatibility = result?.compatibility || {};
  const segmentation = result?.autoSegmentation || {};
  return {
    resultSource: source,
    elapsedMs: diagnosticNumber(elapsedMs, 0),
    engine: String(result?.engine || "unknown").slice(0, 80),
    model: String(result?.model || "unknown").slice(0, 80),
    device: String(result?.device || "unknown").slice(0, 24),
    language: String(result?.language || "auto").slice(0, 24),
    selectedVariant: String(result?.selectedVariant || "unknown").slice(0, 120),
    alignmentMethod: String(result?.alignmentMethod || source || "unknown").slice(0, 160),
    duration: diagnosticNumber(result?.duration ?? getProjectDuration()),
    confidence: diagnosticNumber(result?.confidence),
    quality: diagnosticNumber(result?.quality),
    transcriptSegments: diagnosticNumber(result?.transcriptSegments, 0),
    transcriptWords: diagnosticNumber(result?.transcriptWords, 0),
    matchedLines: diagnosticNumber(result?.matchedLines, 0),
    rescuedLines: diagnosticNumber(result?.rescuedLines, 0),
    forcedLines: diagnosticNumber(result?.forcedLines, 0),
    repeatedLines: diagnosticNumber(result?.repeatedLines, 0),
    autoSegmentation: {
      applied: Boolean(segmentation.applied),
      originalLines: diagnosticNumber(segmentation.originalLines, 0),
      resultLines: diagnosticNumber(segmentation.resultLines, 0)
    },
    compatibility: {
      status: String(compatibility.status || "unknown").slice(0, 40),
      score: diagnosticNumber(compatibility.score),
      matchedLines: diagnosticNumber(compatibility.matchedLines, 0),
      matchedRatio: diagnosticNumber(compatibility.matchedRatio),
      quality: diagnosticNumber(compatibility.quality)
    },
    candidates: Array.isArray(result?.candidates)
      ? result.candidates.slice(0, 24).map((candidate) => ({
        variant: String(candidate.variant || "unknown").slice(0, 120),
        alignmentMethod: String(candidate.alignmentMethod || "unknown").slice(0, 160),
        matchedLines: diagnosticNumber(candidate.matchedLines, 0),
        quality: diagnosticNumber(candidate.quality),
        transcriptHealth: diagnosticNumber(candidate.transcriptHealth),
        segments: diagnosticNumber(candidate.segments, 0)
      }))
      : []
  };
}

function appendDeveloperEvent(type, data = {}) {
  if (!app.developerMode) return;
  app.developerEventSequence += 1;
  app.developerEvents.push({
    sequence: app.developerEventSequence,
    elapsedMs: Math.max(0, Date.now() - app.developerSessionStartedAt),
    type,
    data
  });
  if (app.developerEvents.length > DEVELOPER_EVENT_LIMIT) {
    app.developerEvents.splice(0, app.developerEvents.length - DEVELOPER_EVENT_LIMIT);
  }
  renderDeveloperPanel();
}

function resetDeveloperDiagnostics() {
  app.developerEvents = [];
  app.developerEventSequence = 0;
  app.developerSessionStartedAt = Date.now();
  app.developerBaseline = [];
  app.developerAnalysis = null;
  app.developerResultSource = null;
  renderDeveloperPanel();
}

function beginDeveloperAnalysis(lines) {
  resetDeveloperDiagnostics();
  appendDeveloperEvent("analysis_started", {
    media: {
      sizeBytes: diagnosticNumber(app.audioFile?.size, 0),
      mimeType: String(app.audioFile?.type || "unknown").slice(0, 80)
    },
    lyrics: buildDiagnosticLyricsSummary(lines)
  });
}

function captureDeveloperBaseline(modelResult, source) {
  const elapsedMs = analysisStartedAt ? Date.now() - analysisStartedAt : null;
  app.developerResultSource = source;
  app.developerAnalysis = sanitizeDiagnosticAnalysis(modelResult, source, elapsedMs);
  app.developerBaseline = sanitizeDiagnosticTimeline();
  appendDeveloperEvent("analysis_completed", {
    resultSource: source,
    elapsedMs: app.developerAnalysis.elapsedMs,
    lineCount: app.developerBaseline.length,
    matchedLines: app.developerAnalysis.matchedLines,
    rescuedLines: app.developerAnalysis.rescuedLines,
    forcedLines: app.developerAnalysis.forcedLines,
    repeatedLines: app.developerAnalysis.repeatedLines,
    quality: app.developerAnalysis.quality,
    compatibilityScore: app.developerAnalysis.compatibility.score,
    candidateCount: app.developerAnalysis.candidates.length,
    autoSegmentation: app.developerAnalysis.autoSegmentation
  });
  for (const [candidateIndex, candidate] of app.developerAnalysis.candidates.entries()) {
    appendDeveloperEvent("alignment_candidate", {
      candidateIndex,
      ...candidate,
      selected: candidate.variant === app.developerAnalysis.selectedVariant
    });
  }
  renderDeveloperPanel();
}

function summarizeDeveloperCorrections() {
  const baselineByIndex = new Map(app.developerBaseline.map((row) => [row.lineIndex, row]));
  const finalTimeline = sanitizeDiagnosticTimeline();
  const deltas = finalTimeline
    .map((row) => {
      const baseline = baselineByIndex.get(row.lineIndex);
      return baseline ? Number(row.start) - Number(baseline.start) : 0;
    })
    .filter(Number.isFinite);
  const absoluteDeltas = deltas.map(Math.abs).sort((a, b) => a - b);
  const corrected = absoluteDeltas.filter((value) => value >= 0.005);
  const mean = corrected.length
    ? corrected.reduce((total, value) => total + value, 0) / corrected.length
    : 0;
  const p95Index = Math.max(0, Math.ceil(absoluteDeltas.length * 0.95) - 1);
  return {
    finalTimeline,
    correctedLines: corrected.length,
    meanAbsoluteCorrection: diagnosticNumber(mean),
    p95AbsoluteCorrection: diagnosticNumber(absoluteDeltas[p95Index] || 0),
    maxAbsoluteCorrection: diagnosticNumber(absoluteDeltas.at(-1) || 0),
    anchorCount: finalTimeline.filter((row) => row.anchor).length,
    correctionActions: app.developerEvents.filter((event) => [
      "line_start_adjusted",
      "anchor_applied",
      "timeline_shifted"
    ].includes(event.type)).length
  };
}

function summarizeTimelineMutation(beforeStarts) {
  const deltas = app.timeline
    .map((row, index) => Number(row.start) - Number(beforeStarts[index]))
    .filter((value) => Number.isFinite(value) && Math.abs(value) >= 0.0005);
  return {
    affectedLines: deltas.length,
    meanAbsoluteDelta: diagnosticNumber(
      deltas.length ? deltas.reduce((total, value) => total + Math.abs(value), 0) / deltas.length : 0
    ),
    maxAbsoluteDelta: diagnosticNumber(Math.max(0, ...deltas.map(Math.abs)))
  };
}

function renderDeveloperPanel() {
  if (!elements.developerPanel) return;
  elements.developerPanel.hidden = !app.developerMode;
  if (!app.developerMode) return;

  const corrections = summarizeDeveloperCorrections();
  const analysis = app.developerAnalysis || {};
  const compatibilityScore = analysis.compatibility?.score;
  const compatibilityPercent = compatibilityScore !== null
    && compatibilityScore !== undefined
    && Number.isFinite(Number(compatibilityScore))
    ? `${Math.round(Number(compatibilityScore) * 100)}%`
    : "-";
  const metrics = [
    ["정렬 품질", analysis.quality ?? "-"],
    ["AR/가사 일치", compatibilityPercent],
    ["매칭 줄", `${analysis.matchedLines ?? 0}/${app.developerBaseline.length || app.lines.length || 0}`],
    ["수정된 줄", corrections.correctedLines],
    ["평균 보정", `${corrections.meanAbsoluteCorrection ?? 0}s`],
    ["최대 보정", `${corrections.maxAbsoluteCorrection ?? 0}s`]
  ];
  const fragment = document.createDocumentFragment();
  for (const [label, value] of metrics) {
    const metric = document.createElement("div");
    metric.className = "developer-metric";
    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    const valueNode = document.createElement("strong");
    valueNode.textContent = String(value);
    metric.append(labelNode, valueNode);
    fragment.append(metric);
  }
  elements.developerSummary.replaceChildren(fragment);
  elements.developerSessionStatus.textContent = `진단 이벤트 ${app.developerEvents.length}건 · 원문 미포함`;
  elements.developerLog.textContent = app.developerEvents.length
    ? app.developerEvents.slice(-200).map((event) => {
      const seconds = (event.elapsedMs / 1000).toFixed(1).padStart(7, " ");
      return `#${String(event.sequence).padStart(3, "0")} ${seconds}s ${event.type} ${JSON.stringify(event.data)}`;
    }).join("\n")
    : "진단 이벤트가 아직 없습니다.";
}

function setDeveloperMode(active) {
  const next = Boolean(active);
  if (app.developerMode === next) return;
  if (next) {
    app.developerMode = true;
    if (!app.developerSessionStartedAt) app.developerSessionStartedAt = Date.now();
    if (!app.developerBaseline.length && app.timeline.length) {
      app.developerBaseline = sanitizeDiagnosticTimeline();
      app.developerResultSource = "existing-timeline";
    }
    appendDeveloperEvent("developer_mode_enabled", {
      hasTimeline: app.timeline.length > 0,
      lineCount: app.timeline.length
    });
    setStatus("개발자 모드가 활성화되었습니다.");
    elements.developerPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  appendDeveloperEvent("developer_mode_disabled");
  app.developerMode = false;
  renderDeveloperPanel();
  setStatus("개발자 모드가 비활성화되었습니다.");
}

function registerDeveloperF12Press() {
  const now = performance.now();
  developerF12Presses = developerF12Presses.filter((pressedAt) => now - pressedAt <= DEVELOPER_TOGGLE_WINDOW_MS);
  developerF12Presses.push(now);
  if (developerF12Presses.length < DEVELOPER_TOGGLE_PRESS_COUNT) return;
  developerF12Presses = [];
  setDeveloperMode(!app.developerMode);
}

function exportDeveloperDiagnostics() {
  const corrections = summarizeDeveloperCorrections();
  const baselineByIndex = new Map(app.developerBaseline.map((row) => [row.lineIndex, row]));
  const finalTimeline = corrections.finalTimeline.map((row) => {
    const baseline = baselineByIndex.get(row.lineIndex);
    return {
      ...row,
      automaticStart: baseline?.start ?? null,
      automaticEnd: baseline?.end ?? null,
      startCorrection: baseline ? diagnosticNumber(Number(row.start) - Number(baseline.start)) : null,
      endCorrection: baseline ? diagnosticNumber(Number(row.end) - Number(baseline.end)) : null
    };
  });
  const payload = {
    schemaVersion: 1,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    privacy: {
      includesAudio: false,
      includesLyricsText: false,
      includesFileNameOrPath: false,
      includesUserIdentity: false
    },
    media: {
      duration: diagnosticNumber(getProjectDuration()),
      sizeBytes: diagnosticNumber(app.audioFile?.size, 0),
      mimeType: String(app.audioFile?.type || "unknown").slice(0, 80)
    },
    lyrics: buildDiagnosticLyricsSummary(),
    analysis: app.developerAnalysis,
    automaticTimeline: app.developerBaseline,
    finalTimeline,
    summary: {
      correctedLines: corrections.correctedLines,
      correctionActions: corrections.correctionActions,
      anchorCount: corrections.anchorCount,
      meanAbsoluteCorrection: corrections.meanAbsoluteCorrection,
      p95AbsoluteCorrection: corrections.p95AbsoluteCorrection,
      maxAbsoluteCorrection: corrections.maxAbsoluteCorrection
    },
    events: app.developerEvents
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `obs-karaoke-diagnostic-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
  appendDeveloperEvent("diagnostic_exported", {
    eventCount: app.developerEvents.length,
    correctedLines: corrections.correctedLines
  });
}

function clearDeveloperEvents() {
  app.developerEvents = [];
  app.developerEventSequence = 0;
  app.developerSessionStartedAt = Date.now();
  appendDeveloperEvent("event_log_cleared", {
    baselinePreserved: app.developerBaseline.length > 0
  });
}

function clearAnalysisConflict() {
  elements.analysisConflict.hidden = true;
  elements.analysisConflict.classList.remove("warning");
  elements.analysisConflictMessage.textContent = "";
}

function showAnalysisConflict(title, message, warning = false) {
  elements.analysisConflictTitle.textContent = title;
  elements.analysisConflictMessage.textContent = message;
  elements.analysisConflict.classList.toggle("warning", warning);
  elements.analysisConflict.hidden = false;
}

function updateAnalysisElapsed() {
  if (!analysisStartedAt) return;
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - analysisStartedAt) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  elements.analysisElapsed.textContent = `경과 ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function setAnalysisLoading(active, message = "오디오를 준비하고 있습니다...") {
  if (!elements.analysisLoading) return;

  if (active) {
    analysisStartedAt = Date.now();
    elements.analysisLoadingMessage.textContent = message;
    elements.analysisLoading.hidden = false;
    document.body.setAttribute("aria-busy", "true");
    updateAnalysisElapsed();
    clearInterval(analysisElapsedTimer);
    analysisElapsedTimer = setInterval(updateAnalysisElapsed, 1000);
    elements.cancelAnalysis.disabled = false;
    elements.cancelAnalysis.textContent = "분석 종료";
    return;
  }

  clearInterval(analysisElapsedTimer);
  analysisElapsedTimer = null;
  analysisStartedAt = 0;
  elements.analysisLoading.hidden = true;
  document.body.removeAttribute("aria-busy");
  elements.cancelAnalysis.disabled = false;
  elements.cancelAnalysis.textContent = "분석 종료";
}

function formatTime(value) {
  const safe = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  const milliseconds = Math.floor((safe % 1) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function chooseDuration(...values) {
  return values.reduce((longest, value) => Math.max(longest, positiveFinite(value)), 0);
}

function playerDuration() {
  return positiveFinite(elements.audioPlayer.duration);
}

function waitForMediaDuration(timeoutMs = 2200) {
  const existing = playerDuration();
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      elements.audioPlayer.removeEventListener("loadedmetadata", finish);
      elements.audioPlayer.removeEventListener("durationchange", finish);
      elements.audioPlayer.removeEventListener("error", finish);
      clearTimeout(timer);
      resolve(playerDuration());
    };

    const timer = setTimeout(finish, timeoutMs);
    elements.audioPlayer.addEventListener("loadedmetadata", finish);
    elements.audioPlayer.addEventListener("durationchange", finish);
    elements.audioPlayer.addEventListener("error", finish);
  });
}

function absorbServerState(state) {
  app.state = state;
  app.projectDuration = chooseDuration(state?.duration, app.projectDuration);
  app.playbackSequence = Math.max(app.playbackSequence, Number(state?.playback?.sequence) || 0);
  return state;
}

function parseLyrics(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readLyricsFile(file) {
  const buffer = await file.arrayBuffer();
  const encodings = ["utf-8", "euc-kr"];

  for (const encoding of encodings) {
    try {
      const text = new TextDecoder(encoding, { fatal: false }).decode(buffer);
      if (!text.includes("\uFFFD")) {
        return text.replace(/^\uFEFF/, "");
      }
    } catch (error) {
      // Some browser builds may not expose every legacy decoder.
    }
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(buffer).replace(/^\uFEFF/, "");
}

function lyricWeight(line) {
  const hangul = (line.match(/[가-힣]/g) || []).length;
  const latinWords = (line.match(/[A-Za-z0-9]+/g) || []).reduce((sum, word) => sum + Math.max(1, word.length * 0.45), 0);
  const other = line.replace(/[가-힣A-Za-z0-9\s]/g, "").length * 0.2;
  return Math.max(1, hangul + latinWords + other);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function smooth(values, radius) {
  return values.map((_, index) => {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const value = values[index + offset];
      if (Number.isFinite(value)) {
        sum += value;
        count += 1;
      }
    }
    return count ? sum / count : 0;
  });
}

function average(values, start, end) {
  const from = Math.max(0, start);
  const to = Math.min(values.length, end);
  let sum = 0;
  let count = 0;

  for (let index = from; index < to; index += 1) {
    const value = values[index];
    if (Number.isFinite(value)) {
      sum += value;
      count += 1;
    }
  }

  return count ? sum / count : 0;
}

function cloneTimeline(timeline) {
  return timeline.map((row) => ({
    ...row,
    tokens: Array.isArray(row.tokens) ? row.tokens.map((token) => ({ ...token })) : []
  }));
}

function analyzeAudioBuffer(buffer) {
  const sampleRate = buffer.sampleRate;
  const frameSeconds = 0.08;
  const frameSize = Math.max(512, Math.floor(sampleRate * frameSeconds));
  const channelCount = Math.min(2, buffer.numberOfChannels);
  const channels = Array.from({ length: channelCount }, (_, index) => buffer.getChannelData(index));
  const frameCount = Math.ceil(buffer.length / frameSize);
  const rms = [];

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSize;
    const end = Math.min(buffer.length, start + frameSize);
    let sum = 0;
    let count = 0;

    for (let sample = start; sample < end; sample += 1) {
      let mixed = 0;
      for (const channel of channels) {
        mixed += channel[sample] || 0;
      }
      mixed /= channelCount || 1;
      sum += mixed * mixed;
      count += 1;
    }

    rms.push(Math.sqrt(sum / Math.max(1, count)));
  }

  const smoothed = smooth(rms, 3);
  const dbValues = smoothed.map((value) => 20 * Math.log10(value + 0.0000001));
  const dbSmoothed = smooth(dbValues, 2);
  const p05 = percentile(dbSmoothed, 0.05);
  const p20 = percentile(dbSmoothed, 0.2);
  const p50 = percentile(dbSmoothed, 0.5);
  const p88 = percentile(dbSmoothed, 0.88);
  const p96 = percentile(dbSmoothed, 0.96);
  const lowActivityThreshold = Math.max(p20 + (p88 - p20) * 0.12, p05 + 4);
  const strongActivityThreshold = p50 + (p96 - p50) * 0.18;
  const normalized = dbSmoothed.map((value) => {
    const range = Math.max(0.000001, p96 - p05);
    return Math.max(0, Math.min(1, (value - p05) / range));
  });

  const activityMask = dbSmoothed.map((value, index) => {
    const previous = dbSmoothed[Math.max(0, index - 2)] ?? value;
    const rise = Math.max(0, value - previous);
    return value >= lowActivityThreshold || (normalized[index] > 0.12 && rise >= 1.4);
  });
  const strongMask = dbSmoothed.map((value) => value >= strongActivityThreshold);
  const startIndex = findSustainedActivityStart(activityMask, frameSeconds);
  const endIndex = findSustainedActivityEnd(activityMask, frameSeconds);

  const strongStartIndex = findSustainedActivityStart(strongMask, frameSeconds);
  const phraseStarts = detectPhraseStarts(normalized, dbSmoothed, frameSeconds);

  return {
    duration: buffer.duration,
    frameSeconds,
    rms: dbSmoothed,
    normalized,
    threshold: lowActivityThreshold,
    activeStart: Math.max(0, startIndex * frameSeconds),
    activeEnd: Math.min(buffer.duration, (endIndex + 1) * frameSeconds),
    strongStart: Math.max(0, strongStartIndex * frameSeconds),
    phraseStarts
  };
}

function detectPhraseStarts(normalized, dbValues, frameSeconds) {
  const candidates = [];
  const preWindow = Math.max(3, Math.round(0.48 / frameSeconds));
  const postWindow = Math.max(4, Math.round(0.72 / frameSeconds));
  const nmsWindow = Math.max(4, Math.round(0.88 / frameSeconds));

  for (let index = preWindow + 1; index < normalized.length - postWindow - 1; index += 1) {
    const preEnergy = average(normalized, index - preWindow, index - 1);
    const postEnergy = average(normalized, index + 1, index + postWindow);
    const localEnergy = average(normalized, index, index + Math.max(2, Math.round(0.24 / frameSeconds)));
    const dbRise = average(dbValues, index, index + postWindow) - average(dbValues, index - preWindow, index - 1);
    const energyRise = postEnergy - preEnergy;
    const immediateRise = (normalized[index] || 0) - (normalized[index - 2] || 0);
    const valleyBefore = Math.max(0, 0.45 - preEnergy);
    const activeAfter = Math.max(postEnergy, localEnergy);

    if (activeAfter < 0.14) continue;
    if (energyRise < 0.025 && dbRise < 0.7 && immediateRise < 0.055) continue;

    const score =
      Math.max(0, energyRise) * 2.4 +
      Math.max(0, dbRise) * 0.08 +
      Math.max(0, immediateRise) * 1.3 +
      activeAfter * 0.8 +
      valleyBefore * 0.35;

    candidates.push({
      frame: refinePhraseStartFrame(normalized, index, frameSeconds),
      score
    });
  }

  const selected = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    const tooClose = selected.some((existing) => Math.abs(existing.frame - candidate.frame) <= nmsWindow);
    if (!tooClose) selected.push(candidate);
  }

  return selected
    .sort((a, b) => a.frame - b.frame)
    .map((candidate) => ({
      time: Number((candidate.frame * frameSeconds).toFixed(3)),
      score: Number(candidate.score.toFixed(3))
    }));
}

function refinePhraseStartFrame(normalized, frame, frameSeconds) {
  const lookback = Math.max(2, Math.round(0.32 / frameSeconds));
  const lookahead = Math.max(2, Math.round(0.2 / frameSeconds));
  let bestFrame = frame;
  let bestScore = -Infinity;

  for (let candidate = Math.max(1, frame - lookback); candidate <= Math.min(normalized.length - 2, frame + lookahead); candidate += 1) {
    const before = average(normalized, candidate - lookback, candidate);
    const after = average(normalized, candidate, candidate + lookahead + 1);
    const score = (after - before) * 2 + after - Math.abs(candidate - frame) * 0.01;
    if (score > bestScore) {
      bestScore = score;
      bestFrame = candidate;
    }
  }

  return bestFrame;
}

function findSustainedActivityStart(mask, frameSeconds) {
  const windowSize = Math.max(5, Math.round(0.72 / frameSeconds));
  const requiredHits = Math.max(3, Math.ceil(windowSize * 0.4));

  for (let index = 0; index <= mask.length - windowSize; index += 1) {
    let hits = 0;
    for (let offset = 0; offset < windowSize; offset += 1) {
      if (mask[index + offset]) hits += 1;
    }
    if (hits >= requiredHits) return index;
  }

  const firstActive = mask.findIndex(Boolean);
  return firstActive >= 0 ? firstActive : 0;
}

function findSustainedActivityEnd(mask, frameSeconds) {
  const windowSize = Math.max(5, Math.round(0.72 / frameSeconds));
  const requiredHits = Math.max(3, Math.ceil(windowSize * 0.4));

  for (let index = mask.length - windowSize; index >= 0; index -= 1) {
    let hits = 0;
    for (let offset = 0; offset < windowSize; offset += 1) {
      if (mask[index + offset]) hits += 1;
    }
    if (hits >= requiredHits) return Math.min(mask.length - 1, index + windowSize - 1);
  }

  for (let index = mask.length - 1; index >= 0; index -= 1) {
    if (mask[index]) return index;
  }

  return Math.max(0, mask.length - 1);
}

function getProjectDuration() {
  return chooseDuration(
    app.projectDuration,
    elements.audioPlayer.duration,
    app.waveform?.duration,
    app.state?.duration
  );
}

function findLowEnergyBoundary(analysis, target, minTime, maxTime) {
  const frameSeconds = analysis.frameSeconds;
  const startFrame = Math.max(0, Math.floor(minTime / frameSeconds));
  const endFrame = Math.min(analysis.normalized.length - 1, Math.ceil(maxTime / frameSeconds));
  const searchRadius = Math.max(1, Math.floor(3.5 / frameSeconds));
  const targetFrame = Math.floor(target / frameSeconds);
  const from = Math.max(startFrame, targetFrame - searchRadius);
  const to = Math.min(endFrame, targetFrame + searchRadius);
  let bestFrame = Math.max(startFrame, Math.min(endFrame, targetFrame));
  let bestScore = Infinity;

  for (let frame = from; frame <= to; frame += 1) {
    const distance = Math.abs(frame - targetFrame) / Math.max(1, searchRadius);
    const energy = analysis.normalized[frame] ?? 0;
    const before = analysis.normalized[Math.max(0, frame - 2)] ?? energy;
    const after = analysis.normalized[Math.min(analysis.normalized.length - 1, frame + 2)] ?? energy;
    const valleyBonus = Math.max(0, before - energy) + Math.max(0, after - energy);
    const score = energy * 1.6 + distance * 0.65 - valleyBonus * 0.4;

    if (score < bestScore) {
      bestScore = score;
      bestFrame = frame;
    }
  }

  return bestFrame * frameSeconds;
}

function findPhraseStartBoundary(analysis, target, minTime, maxTime, expectedDuration) {
  const phraseStarts = analysis.phraseStarts || [];
  const searchRadius = Math.max(2.4, Math.min(8, expectedDuration * 1.8));
  const inRange = phraseStarts.filter((candidate) => candidate.time >= minTime && candidate.time <= maxTime);
  const nearTarget = inRange.filter((candidate) => Math.abs(candidate.time - target) <= searchRadius);
  const pool = nearTarget.length ? nearTarget : inRange;

  if (!pool.length) {
    return findLowEnergyBoundary(analysis, target, minTime, maxTime);
  }

  let best = pool[0];
  let bestScore = Infinity;
  for (const candidate of pool) {
    const distance = Math.abs(candidate.time - target) / searchRadius;
    const confidence = candidate.score / (candidate.score + 1);
    const earlyPenalty = candidate.time < minTime + 0.12 ? 0.2 : 0;
    const score = distance * 1.05 - confidence * 0.72 + earlyPenalty;

    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return Math.max(minTime, Math.min(maxTime, best.time - 0.04));
}

function buildTimeline(lines, analysis) {
  const duration = Math.max(0, analysis.duration || 0);
  if (!lines.length || duration <= 0) return [];

  const rawStart = analysis.activeStart;
  const rawEnd = Math.max(rawStart + Math.min(duration, 1), analysis.activeEnd);
  const start = Math.min(rawStart, Math.max(0, duration - 0.5));
  const end = Math.max(start + 0.8, Math.min(duration, rawEnd));
  const span = Math.max(0.8, end - start);
  const weights = lines.map(lyricWeight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const baseMinimumDurations = weights.map((weight) => Math.max(0.75, Math.min(3.2, 0.5 + weight * 0.08)));
  const minimumTotal = baseMinimumDurations.reduce((sum, value) => sum + value, 0);
  const minimumScale = minimumTotal > span * 0.88 ? (span * 0.88) / minimumTotal : 1;
  const minimumDurations = baseMinimumDurations.map((value) => Math.max(0.45, value * minimumScale));
  const starts = [start];
  let cumulative = 0;

  for (let index = 1; index < lines.length; index += 1) {
    cumulative += weights[index - 1];
    const target = start + span * (cumulative / totalWeight);
    const minTime = starts[index - 1] + minimumDurations[index - 1];
    const remainingMinimum = minimumDurations.slice(index).reduce((sum, value) => sum + value, 0);
    const maxTime = end - remainingMinimum;
    const expectedDuration = Math.max(0.6, span * (weights[index - 1] / totalWeight));
    starts.push(findPhraseStartBoundary(analysis, target, minTime, Math.max(minTime, maxTime), expectedDuration));
  }

  const timeline = starts.map((lineStart, index) => {
    const nextStart = starts[index + 1];
    const lineEnd = nextStart ? Math.max(lineStart + 0.1, nextStart - 0.04) : duration;
    return {
      id: `line-${index + 1}`,
      index,
      text: lines[index],
      start: Number(lineStart.toFixed(3)),
      end: Number(Math.max(lineStart + 0.1, Math.min(duration, lineEnd)).toFixed(3)),
      confidence: Number(Math.max(0.35, Math.min(0.86, 0.72 - Math.abs((lineStart - start) / Math.max(1, span)) * 0.08)).toFixed(2))
    };
  });

  return normalizeTimeline(timeline, duration);
}

function normalizeTokenTimeline(tokens, rowStart, rowEnd) {
  if (!Array.isArray(tokens)) return [];
  return tokens.map((token, index) => {
    const start = Math.max(rowStart, Math.min(rowEnd, Number(token.start) || rowStart));
    const end = Math.max(start, Math.min(rowEnd, Number(token.end) || start));
    return {
      index,
      text: String(token.text || ""),
      start,
      end,
      confidence: Math.max(0, Math.min(1, Number(token.confidence) || 0)),
      source: String(token.source || "estimated"),
      timed: Boolean(token.timed)
    };
  });
}

function remapTokenTimeline(tokens, fromStart, fromEnd, toStart, toEnd) {
  const sourceSpan = Math.max(0.05, fromEnd - fromStart);
  const targetSpan = Math.max(0.05, toEnd - toStart);
  return normalizeTokenTimeline((tokens || []).map((token) => ({
    ...token,
    start: toStart + ((Number(token.start) - fromStart) / sourceSpan) * targetSpan,
    end: toStart + ((Number(token.end) - fromStart) / sourceSpan) * targetSpan
  })), toStart, toEnd);
}

function shiftTokenTimeline(tokens, delta) {
  return (tokens || []).map((token) => ({
    ...token,
    start: Number(token.start) + delta,
    end: Number(token.end) + delta
  }));
}

function normalizeTimeline(rows, duration) {
  const sorted = rows
    .map((row, index) => ({
      id: `line-${index + 1}`,
      index,
      text: row.text,
      start: Math.max(0, Number(row.start) || 0),
      end: Math.max(0, Number(row.end) || 0),
      confidence: Number(row.confidence) || 0,
      tokenConfidence: Number(row.tokenConfidence) || 0,
      source: String(row.source || "estimated"),
      tokens: Array.isArray(row.tokens) ? row.tokens.map((token) => ({ ...token })) : [],
      anchor: Boolean(row.anchor)
    }))
    .sort((a, b) => a.start - b.start);

  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = sorted[index - 1];
    if (previous && current.start <= previous.start + 0.15) {
      current.start = previous.start + 0.15;
    }

    const next = sorted[index + 1];
    current.index = index;
    current.id = `line-${index + 1}`;
    if (next && next.start <= current.start + 0.15) {
      next.start = current.start + 0.15;
    }
    const fallbackEnd = next ? next.start - 0.04 : duration;
    current.end = Math.max(current.start + 0.1, current.end || fallbackEnd);
    if (next) current.end = Math.min(current.end, Math.max(current.start + 0.1, next.start - 0.04));
    if (duration > 0) current.end = Math.min(current.end, duration);
    current.tokens = normalizeTokenTimeline(current.tokens, current.start, current.end);
  }

  return sorted;
}

function drawWaveform() {
  const canvas = elements.waveform;
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * scale);
  canvas.height = Math.floor(rect.height * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#101417";
  ctx.fillRect(0, 0, rect.width, rect.height);

  if (!app.waveform || !app.waveform.normalized?.length) {
    ctx.fillStyle = "#55606a";
    ctx.fillRect(0, rect.height / 2 - 1, rect.width, 2);
    if (!app.timeline.length) return;
  }

  const displayDuration = getProjectDuration();

  if (app.waveform?.normalized?.length) {
    const bars = Math.min(rect.width, app.waveform.normalized.length);
    const step = app.waveform.normalized.length / bars;
    const center = rect.height / 2;
    ctx.fillStyle = "#6bd8c6";

    for (let x = 0; x < bars; x += 1) {
      const index = Math.floor(x * step);
      const value = app.waveform.normalized[index] || 0;
      const height = Math.max(1, value * rect.height * 0.78);
      ctx.fillRect(x, center - height / 2, 1, height);
    }
  }

  if (app.timeline.length && displayDuration > 0) {
    ctx.fillStyle = "rgba(246, 211, 101, 0.85)";
    for (const row of app.timeline) {
      const x = (row.start / displayDuration) * rect.width;
      ctx.fillRect(x, 0, 2, rect.height);
    }
  }

  const currentTime = elements.audioPlayer.currentTime || 0;
  if (displayDuration > 0) {
    const playX = (currentTime / displayDuration) * rect.width;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(playX, 0, 2, rect.height);
  }
}

function findLineAt(time) {
  if (!app.timeline.length) return { current: null, next: null };
  let current = null;
  let next = null;

  for (const row of app.timeline) {
    if (time >= row.start && time <= row.end) {
      current = row;
      next = app.timeline[row.index + 1] || null;
      break;
    }

    if (row.start > time) {
      next = row;
      break;
    }
  }

  if (!current && !next) {
    current = app.timeline[app.timeline.length - 1];
  }

  return { current, next };
}

function splitPreviewText(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return Array.from(new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(String(text || "")), (part) => part.segment);
  }
  return Array.from(String(text || ""));
}

function fallbackTokens(row) {
  const units = splitPreviewText(row?.text || "");
  const timedUnits = units.filter((unit) => !/\s/.test(unit));
  let position = 0;
  return units.map((text, index) => {
    if (/\s/.test(text)) {
      const marker = row.start + (row.end - row.start) * position / Math.max(1, timedUnits.length);
      return { index, text, start: marker, end: marker, timed: false };
    }
    const start = row.start + (row.end - row.start) * position / Math.max(1, timedUnits.length);
    position += 1;
    const end = row.start + (row.end - row.start) * position / Math.max(1, timedUnits.length);
    return { index, text, start, end, timed: true };
  });
}

function renderPreviewLine(row, time, placeholder) {
  if (!row) {
    if (app.previewKey !== `empty:${placeholder}`) {
      app.previewKey = `empty:${placeholder}`;
      app.previewSlots = [];
      elements.previewCurrent.textContent = placeholder;
    }
    return;
  }

  const tokens = Array.isArray(row.tokens) && row.tokens.length ? row.tokens : fallbackTokens(row);
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const key = `${row.id}:${row.start}:${row.end}:${tokens.length}:${first?.start}:${last?.end}`;
  if (key !== app.previewKey) {
    app.previewKey = key;
    app.previewSlots = [];
    elements.previewCurrent.textContent = "";
    const fragment = document.createDocumentFragment();
    for (const token of tokens) {
      const span = document.createElement("span");
      span.className = /\s/.test(token.text) ? "timed-char space-char" : "timed-char";
      span.textContent = token.text;
      app.previewSlots.push({ span, token });
      fragment.append(span);
    }
    elements.previewCurrent.append(fragment);
  }

  for (const slot of app.previewSlots) {
    if (/\s/.test(slot.token.text)) continue;
    const start = Number(slot.token.start) || row.start;
    const end = Math.max(start + 0.015, Number(slot.token.end) || start + 0.015);
    const progress = slot.token.timed === false
      ? (time >= start ? 1 : 0)
      : Math.max(0, Math.min(1, (time - start) / (end - start)));
    const quantized = Math.round(progress * 200) / 2;
    if (slot.span.dataset.fill !== String(quantized)) {
      slot.span.dataset.fill = String(quantized);
      slot.span.style.setProperty("--char-fill", `${quantized}%`);
    }
  }
}

function renderPreview() {
  const time = elements.audioPlayer.currentTime || 0;
  const { current, next } = findLineAt(time);
  const firstUpcoming = !current && next ? next : null;
  const secondUpcoming = firstUpcoming ? app.timeline[firstUpcoming.index + 1] || null : next;

  renderPreviewLine(current || firstUpcoming, time, "가사가 여기에 표시됩니다.");
  elements.previewNext.textContent = secondUpcoming ? secondUpcoming.text : "";
  elements.currentTime.textContent = formatTime(time);
  elements.duration.textContent = formatTime(getProjectDuration());
}

function renderTimeline() {
  if (!app.timeline.length) {
    elements.timelineBody.innerHTML = '<tr><td colspan="6" class="empty-row">자동 싱크를 생성하면 편집표가 표시됩니다.</td></tr>';
    return;
  }

  elements.timelineBody.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const row of app.timeline) {
    const tr = document.createElement("tr");
    tr.className = [
      row.index === app.selectedIndex ? "selected-row" : "",
      row.anchor ? "anchor-row" : ""
    ].filter(Boolean).join(" ");
    tr.dataset.index = String(row.index);

    const indexTd = document.createElement("td");
    indexTd.textContent = String(row.index + 1);

    const startTd = document.createElement("td");
    const input = document.createElement("input");
    input.className = "start-input";
    input.type = "number";
    input.step = "0.01";
    input.min = "0";
    input.value = row.start.toFixed(2);
    input.addEventListener("change", () => {
      adjustLineStart(row.index, Number(input.value) - row.start, "manual-input");
    });
    startTd.append(input);

    const nudgeTd = document.createElement("td");
    const nudgeGroup = document.createElement("div");
    nudgeGroup.className = "nudge-group";
    for (const delta of [-0.5, -0.1, 0.1, 0.5]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = delta > 0 ? `+${delta}` : String(delta);
      button.addEventListener("click", () => adjustLineStart(row.index, delta, "step-button"));
      nudgeGroup.append(button);
    }
    nudgeTd.append(nudgeGroup);

    const lyricTd = document.createElement("td");
    lyricTd.className = "lyric-cell";
    lyricTd.textContent = row.text;

    const anchorTd = document.createElement("td");
    const anchorButton = document.createElement("button");
    anchorButton.className = row.anchor ? "anchor-button active" : "anchor-button";
    anchorButton.type = "button";
    anchorButton.textContent = row.anchor ? "고정됨" : "현재 고정";
    anchorButton.addEventListener("click", (event) => {
      event.stopPropagation();
      app.selectedIndex = row.index;
      applyAnchor(row.index, elements.audioPlayer.currentTime || row.start);
    });
    anchorTd.append(anchorButton);

    const jumpTd = document.createElement("td");
    const jumpButton = document.createElement("button");
    jumpButton.className = "jump-button";
    jumpButton.type = "button";
    jumpButton.textContent = "재생 위치";
    jumpButton.addEventListener("click", () => {
      elements.audioPlayer.currentTime = row.start;
      postPlayback("seek");
      renderPreview();
      drawWaveform();
    });
    jumpTd.append(jumpButton);

    tr.addEventListener("click", () => {
      app.selectedIndex = row.index;
      renderTimeline();
    });

    tr.append(indexTd, startTd, nudgeTd, lyricTd, anchorTd, jumpTd);
    fragment.append(tr);
  }

  elements.timelineBody.append(fragment);
}

function adjustLineStart(index, delta, method = "line-adjustment") {
  const row = app.timeline[index];
  if (!row) return;
  const beforeStarts = app.developerMode ? app.timeline.map((item) => item.start) : [];
  const beforeStart = row.start;
  const original = {
    start: row.start,
    end: row.end,
    tokens: (row.tokens || []).map((token) => ({ ...token }))
  };
  const previous = app.timeline[index - 1];
  const next = app.timeline[index + 1];
  const maxDuration = getProjectDuration();
  const min = previous ? previous.start + 0.12 : 0;
  const max = next ? next.start - 0.12 : Math.max(0, maxDuration - 0.1);
  row.start = Math.max(min, Math.min(max, row.start + delta));
  if (row.anchor) {
    rebuildTimelineFromAnchors();
  } else {
    app.timeline = normalizeTimeline(app.timeline, maxDuration);
    const adjusted = app.timeline[index];
    adjusted.tokens = remapTokenTimeline(
      original.tokens,
      original.start,
      original.end,
      adjusted.start,
      adjusted.end
    );
  }
  app.selectedIndex = index;
  renderTimeline();
  drawWaveform();
  sendTimeline();
  const adjusted = app.timeline[index];
  appendDeveloperEvent("line_start_adjusted", {
    lineIndex: index,
    method,
    requestedDelta: diagnosticNumber(delta),
    beforeStart: diagnosticNumber(beforeStart),
    afterStart: diagnosticNumber(adjusted?.start),
    appliedDelta: diagnosticNumber(Number(adjusted?.start) - Number(beforeStart)),
    ...summarizeTimelineMutation(beforeStarts)
  });
}

function ensureBaseTimeline() {
  if (app.baseTimeline.length !== app.timeline.length) {
    app.baseTimeline = cloneTimeline(app.timeline).map((row) => ({ ...row, anchor: false }));
  }
}

function rebuildTimelineFromAnchors() {
  ensureBaseTimeline();
  const duration = getProjectDuration();
  const anchorRows = app.timeline
    .filter((row) => row.anchor)
    .map((row) => ({ index: row.index, start: row.start }))
    .sort((a, b) => a.index - b.index);

  if (!anchorRows.length) {
    app.timeline = normalizeTimeline(app.timeline, duration);
    return;
  }

  const anchorMap = new Map(anchorRows.map((row) => [row.index, row.start]));
  const next = app.baseTimeline.map((baseRow) => ({
    ...baseRow,
    start: baseRow.start,
    end: 0,
    anchor: anchorMap.has(baseRow.index)
  }));

  if (anchorRows.length === 1) {
    const anchor = anchorRows[0];
    const delta = anchor.start - app.baseTimeline[anchor.index].start;
    for (const row of next) {
      row.start = app.baseTimeline[row.index].start + delta;
    }
  } else {
    const first = anchorRows[0];
    const last = anchorRows[anchorRows.length - 1];

    for (let index = 0; index <= first.index; index += 1) {
      next[index].start = app.baseTimeline[index].start + first.start - app.baseTimeline[first.index].start;
    }

    for (let anchorIndex = 0; anchorIndex < anchorRows.length - 1; anchorIndex += 1) {
      const left = anchorRows[anchorIndex];
      const right = anchorRows[anchorIndex + 1];
      const baseLeft = app.baseTimeline[left.index].start;
      const baseRight = app.baseTimeline[right.index].start;
      const baseSpan = Math.max(0.1, baseRight - baseLeft);
      const targetSpan = Math.max(0.1, right.start - left.start);

      for (let index = left.index; index <= right.index; index += 1) {
        const position = (app.baseTimeline[index].start - baseLeft) / baseSpan;
        next[index].start = left.start + position * targetSpan;
      }
    }

    for (let index = last.index; index < next.length; index += 1) {
      next[index].start = app.baseTimeline[index].start + last.start - app.baseTimeline[last.index].start;
    }
  }

  for (const anchor of anchorRows) {
    next[anchor.index].start = anchor.start;
    next[anchor.index].anchor = true;
  }

  app.timeline = normalizeTimeline(next, duration);
  for (const row of app.timeline) {
    const base = app.baseTimeline[row.index];
    row.tokens = remapTokenTimeline(
      base?.tokens || [],
      base?.start || row.start,
      base?.end || row.end,
      row.start,
      row.end
    );
  }
}

function applyAnchor(index, time) {
  if (!app.timeline[index]) return;
  const beforeStarts = app.developerMode ? app.timeline.map((row) => row.start) : [];
  const beforeStart = app.timeline[index].start;
  ensureBaseTimeline();
  const duration = getProjectDuration();
  app.timeline[index].anchor = true;
  app.timeline[index].start = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Number(time) || 0));
  rebuildTimelineFromAnchors();
  app.selectedIndex = index;
  renderTimeline();
  renderPreview();
  drawWaveform();
  sendTimeline();
  setStatus(`앵커 적용: ${index + 1}번 줄을 ${formatTime(app.timeline[index].start)}에 고정했습니다.`);
  appendDeveloperEvent("anchor_applied", {
    lineIndex: index,
    beforeStart: diagnosticNumber(beforeStart),
    requestedStart: diagnosticNumber(time),
    afterStart: diagnosticNumber(app.timeline[index].start),
    ...summarizeTimelineMutation(beforeStarts)
  });
}

function shiftRows(fromIndex, delta, method = "timeline-shift") {
  if (!app.timeline.length) return;
  const beforeStarts = app.developerMode ? app.timeline.map((row) => row.start) : [];
  ensureBaseTimeline();
  const duration = getProjectDuration();
  const shiftFrom = Math.max(0, Number(fromIndex) || 0);

  app.timeline = app.timeline.map((row) => ({
    ...row,
    start: row.index >= shiftFrom ? row.start + delta : row.start,
    end: row.index >= shiftFrom ? row.end + delta : row.end,
    tokens: row.index >= shiftFrom ? shiftTokenTimeline(row.tokens, delta) : row.tokens
  }));
  app.baseTimeline = app.baseTimeline.map((row) => ({
    ...row,
    start: row.index >= shiftFrom ? row.start + delta : row.start,
    end: row.index >= shiftFrom ? row.end + delta : row.end,
    tokens: row.index >= shiftFrom ? shiftTokenTimeline(row.tokens, delta) : row.tokens
  }));
  app.timeline = normalizeTimeline(app.timeline, duration);
  app.baseTimeline = normalizeTimeline(app.baseTimeline, duration).map((row) => ({ ...row, anchor: false }));
  renderTimeline();
  renderPreview();
  drawWaveform();
  sendTimeline();
  appendDeveloperEvent("timeline_shifted", {
    method,
    fromLineIndex: shiftFrom,
    requestedDelta: diagnosticNumber(delta),
    ...summarizeTimelineMutation(beforeStarts)
  });
}

async function decodeAudioFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextClass();
  const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  await audioContext.close();
  return decoded;
}

async function sendJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Server returned ${response.status}`);
  }

  return response.json();
}

async function sendTimeline() {
  await sendJson("/api/timeline", { timeline: app.timeline });
}

async function checkModelStatus() {
  try {
    const response = await fetch("/api/model-status", { cache: "no-store" });
    const status = await response.json();
    const ready = Boolean(status.ok);
    elements.modelStatus.classList.toggle("ready", ready);
    elements.modelStatus.classList.toggle("missing", !ready);
    elements.modelStatus.textContent = ready
      ? `Turbo 모델 준비됨 (${status.engine})`
      : "Turbo 모델 미설치: install-turbo-model.bat 실행 필요";
    return status;
  } catch (error) {
    elements.modelStatus.classList.add("missing");
    elements.modelStatus.textContent = "Turbo 모델 상태 확인 실패";
    return { ok: false, error: error.message };
  }
}

function createAnalysisJobId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cancelledAnalysisError() {
  const error = new Error("분석을 종료했습니다.");
  error.code = "ANALYSIS_CANCELLED";
  return error;
}

function ensureAnalysisContinues() {
  if (analysisCancelRequested) throw cancelledAnalysisError();
}

async function runTurboModelAlignment(lines, duration, jobId) {
  const form = new FormData();
  form.append("audio", app.audioFile, app.audioFile.name);
  form.append("lyrics", lines.join("\n"));
  form.append("title", app.audioFile.name);
  form.append("duration", String(duration || 0));
  form.append("model", "turbo");
  form.append("jobId", jobId);

  activeAnalysisController = new AbortController();

  const response = await fetch("/api/model-align", {
    method: "POST",
    body: form,
    signal: activeAnalysisController.signal
  });

  if (!response.ok) {
    throw new Error(`Turbo model server returned ${response.status}`);
  }

  return response.json();
}

async function cancelAnalysis() {
  if (elements.analysisLoading.hidden || analysisCancelling) return;

  analysisCancelRequested = true;
  analysisCancelling = true;
  elements.cancelAnalysis.disabled = true;
  elements.cancelAnalysis.textContent = "종료 중...";
  setStatus("실행 중인 분석을 종료하는 중입니다...");

  const jobId = activeAnalysisJobId;
  if (jobId) {
    await sendJson("/api/model-align/cancel", { jobId }).catch(() => {});
  }
  activeAnalysisController?.abort();
}

async function postPlayback(action) {
  const player = elements.audioPlayer;
  const now = performance.now();
  if (action === "tick" && now - app.lastPlaybackPost < 5000) return;
  app.lastPlaybackPost = now;

  await sendJson("/api/playback", {
    action,
    currentTime: player.currentTime || 0,
    duration: getProjectDuration(),
    playing: !player.paused && !player.ended,
    rate: player.playbackRate || 1,
    sequence: ++app.playbackSequence
  }).catch(() => {});
}

async function updateStyle() {
  elements.fontSizeValue.textContent = elements.fontSize.value;
  await sendJson("/api/style", {
    showNext: elements.showNext.checked,
    fontSize: Number(elements.fontSize.value),
    accent: elements.accent.value,
    textColor: elements.textColor.value,
    shadow: elements.shadow.checked,
    align: app.activeAlign
  }).catch(() => {});
}

async function generateSync() {
  let lines = [];
  try {
    if (!app.audioFile) {
      setStatus("오디오 파일을 선택하세요.", true);
      return;
    }

    lines = parseLyrics(elements.lyricsText.value);
    if (!lines.length) {
      setStatus("가사 TXT를 선택하거나 가사를 입력하세요.", true);
      return;
    }

    beginDeveloperAnalysis(lines);
    clearAnalysisConflict();
    analysisCancelRequested = false;
    analysisCancelling = false;
    activeAnalysisJobId = createAnalysisJobId();
    elements.generateSync.disabled = true;
    const preparingMessage = "오디오를 읽고 Turbo 모델 분석을 준비하는 중입니다...";
    setAnalysisLoading(true, preparingMessage);
    setStatus(preparingMessage);

    app.lines = lines;
    const mediaDuration = await waitForMediaDuration();
    ensureAnalysisContinues();
    app.audioBuffer = await decodeAudioFile(app.audioFile);
    ensureAnalysisContinues();
    app.projectDuration = chooseDuration(mediaDuration, app.audioBuffer.duration);
    app.waveform = analyzeAudioBuffer(app.audioBuffer);
    app.waveform.duration = app.projectDuration || app.waveform.duration;
    app.selectedIndex = 0;
    app.timeline = [];
    app.baseTimeline = [];
    app.previewKey = "";
    app.previewSlots = [];
    renderTimeline();
    renderPreview();
    drawWaveform();
    await sendJson("/api/project", {
      title: app.audioFile.name,
      duration: getProjectDuration(),
      lyrics: [],
      timeline: [],
      aligner: { mode: "analysis-pending", confidence: 0 }
    });
    ensureAnalysisContinues();

    setStatus("Turbo 모델로 음성을 인식하고 가사 줄·음절 타이밍을 맞추는 중입니다...");
    const modelResult = await runTurboModelAlignment(lines, getProjectDuration(), activeAnalysisJobId);
    ensureAnalysisContinues();

    if (modelResult.code === "ANALYSIS_CANCELLED" || modelResult.cancelled) {
      throw cancelledAnalysisError();
    }

    if (modelResult.code === "LYRICS_AUDIO_MISMATCH") {
      const compatibility = modelResult.compatibility || {};
      app.developerAnalysis = sanitizeDiagnosticAnalysis(
        modelResult,
        "lyrics-audio-mismatch",
        Date.now() - analysisStartedAt
      );
      appendDeveloperEvent("analysis_rejected", {
        code: "LYRICS_AUDIO_MISMATCH",
        compatibilityStatus: app.developerAnalysis.compatibility.status,
        compatibilityScore: app.developerAnalysis.compatibility.score,
        matchedLines: app.developerAnalysis.matchedLines,
        quality: app.developerAnalysis.quality
      });
      const percent = Math.round((Number(compatibility.score) || 0) * 100);
      const detail = `${modelResult.error || "오디오와 가사가 일치하지 않습니다."} 일치 점수 ${percent}%. 파일을 다시 확인하세요.`;
      showAnalysisConflict("AR/가사 불일치", detail);
      setStatus("분석 중단: AR 파일과 가사가 서로 다른 것으로 감지됐습니다.", true);
      return;
    }

    if (modelResult.code === "VOCAL_NOT_DETECTED") {
      app.developerAnalysis = sanitizeDiagnosticAnalysis(
        modelResult,
        "vocal-not-detected",
        Date.now() - analysisStartedAt
      );
      appendDeveloperEvent("analysis_rejected", {
        code: "VOCAL_NOT_DETECTED",
        compatibilityStatus: app.developerAnalysis.compatibility.status,
        compatibilityScore: app.developerAnalysis.compatibility.score
      });
      showAnalysisConflict(
        "보컬 인식 불가",
        modelResult.error || "보컬을 충분히 인식하지 못했습니다. AR/원곡 파일인지 확인하세요."
      );
      setStatus("분석 중단: 보컬 인식 결과가 부족합니다.", true);
      return;
    }

    if (modelResult.ok) {
      const resultLines = Array.isArray(modelResult.lyrics) && modelResult.lyrics.length
        ? modelResult.lyrics.map((line) => String(line))
        : lines;
      app.lines = resultLines;
      if (modelResult.autoSegmentation?.applied) {
        elements.lyricsText.value = resultLines.join("\n");
      }
      app.projectDuration = chooseDuration(getProjectDuration(), modelResult.duration);
      app.timeline = normalizeTimeline(modelResult.timeline || [], app.projectDuration);
      app.baseTimeline = cloneTimeline(app.timeline).map((row) => ({ ...row, anchor: false }));
      captureDeveloperBaseline(modelResult, "turbo-model");
      absorbServerState({ ...modelResult, duration: app.projectDuration });
      elements.projectTitle.textContent = app.audioFile.name;
      elements.audioPlayer.currentTime = 0;
      app.lastKnownAudioTime = 0;
      renderTimeline();
      renderPreview();
      drawWaveform();
      const deviceLabel = modelResult.device === "cuda" ? "GPU" : "CPU";
      if (modelResult.compatibility?.status === "low") {
        showAnalysisConflict(
          "일치 신뢰도 낮음",
          modelResult.compatibility.reason || "일부 줄은 수동 보정이 필요할 수 있습니다.",
          true
        );
      }
      const segmentation = modelResult.autoSegmentation;
      const segmentationLabel = segmentation?.applied
        ? ` · 자동 줄 나눔 ${segmentation.originalLines}→${segmentation.resultLines}줄`
        : "";
      setStatus(`Turbo ${deviceLabel} 싱크 완료: ${modelResult.matchedLines || 0}/${resultLines.length}줄 매칭${segmentationLabel}`);
      checkModelStatus();
      return;
    }

    app.timeline = buildTimeline(lines, app.waveform);
    app.baseTimeline = cloneTimeline(app.timeline).map((row) => ({ ...row, anchor: false }));
    captureDeveloperBaseline(modelResult, "local-phrase-fallback");
    const payload = {
      title: app.audioFile.name,
      duration: getProjectDuration(),
      lyrics: lines,
      timeline: app.timeline,
      aligner: {
        mode: "local-phrase-candidate-align-mvp",
        confidence: app.waveform.phraseStarts?.length ? 0.7 : 0.58
      }
    };

    absorbServerState(await sendJson("/api/project", payload));
    elements.projectTitle.textContent = app.audioFile.name;
    elements.audioPlayer.currentTime = 0;
    app.lastKnownAudioTime = 0;
    renderTimeline();
    renderPreview();
    drawWaveform();
    const installHint = modelResult.code === "MODEL_NOT_INSTALLED" ? " install-turbo-model.bat 실행 후 다시 시도하세요." : "";
    setStatus(`Turbo 모델 사용 실패, 임시 싱크 생성: ${lines.length}줄.${installHint}`, Boolean(modelResult.code === "MODEL_NOT_INSTALLED"));
  } catch (error) {
    if (
      analysisCancelRequested
      || error?.name === "AbortError"
      || error?.code === "ANALYSIS_CANCELLED"
    ) {
      appendDeveloperEvent("analysis_cancelled", {
        elapsedMs: diagnosticNumber(Date.now() - analysisStartedAt, 0)
      });
      setStatus("분석을 종료했습니다. 오디오와 가사는 그대로 유지됩니다.");
      return;
    }

    appendDeveloperEvent("analysis_failed", {
      code: String(error?.code || error?.name || "UNKNOWN").slice(0, 80),
      elapsedMs: diagnosticNumber(Date.now() - analysisStartedAt, 0)
    });
    try {
      if (!app.waveform && app.audioBuffer) {
        app.waveform = analyzeAudioBuffer(app.audioBuffer);
      }
      if (!lines.length) {
        lines = app.lines;
      }
      app.timeline = buildTimeline(lines, app.waveform);
      app.baseTimeline = cloneTimeline(app.timeline).map((row) => ({ ...row, anchor: false }));
      captureDeveloperBaseline(null, "local-fallback-after-error");
      absorbServerState(await sendJson("/api/project", {
        title: app.audioFile.name,
        duration: getProjectDuration(),
        lyrics: lines,
        timeline: app.timeline,
        aligner: {
          mode: "local-phrase-candidate-align-mvp",
          confidence: app.waveform?.phraseStarts?.length ? 0.7 : 0.58
        }
      }));
      elements.projectTitle.textContent = app.audioFile.name;
      elements.audioPlayer.currentTime = 0;
      app.lastKnownAudioTime = 0;
      renderTimeline();
      renderPreview();
      drawWaveform();
      setStatus(`Turbo 모델 오류, 임시 싱크로 생성했습니다: ${error.message}`, true);
    } catch (fallbackError) {
      appendDeveloperEvent("fallback_failed", {
        code: String(fallbackError?.code || fallbackError?.name || "UNKNOWN").slice(0, 80)
      });
      setStatus(`싱크 생성 실패: ${fallbackError.message}`, true);
    }
  } finally {
    setAnalysisLoading(false);
    elements.generateSync.disabled = false;
    activeAnalysisController = null;
    activeAnalysisJobId = null;
    analysisCancelRequested = false;
    analysisCancelling = false;
  }
}

function exportProject() {
  const project = {
    version: 1,
    title: app.audioFile?.name || app.state?.title || "OBS Karaoke MVP",
    duration: getProjectDuration(),
    lyrics: app.lines,
    timeline: app.timeline,
    baseTimeline: app.baseTimeline,
    exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "obs-karaoke-timeline.json";
  link.click();
  URL.revokeObjectURL(url);
}

async function importProject(file) {
  try {
    const project = JSON.parse(await file.text());
    resetDeveloperDiagnostics();
    app.lines = Array.isArray(project.lyrics) ? project.lyrics : [];
    app.projectDuration = chooseDuration(project.duration, elements.audioPlayer.duration);
    app.timeline = normalizeTimeline(project.timeline || [], app.projectDuration);
    app.baseTimeline = normalizeTimeline(project.baseTimeline || project.timeline || [], app.projectDuration)
      .map((row) => ({ ...row, anchor: false }));
    captureDeveloperBaseline(null, "imported-project");
    app.waveform = app.waveform || {
      duration: app.projectDuration,
      normalized: []
    };
    elements.lyricsText.value = app.lines.join("\n");
    absorbServerState(await sendJson("/api/project", {
      title: project.title || "Imported project",
      duration: getProjectDuration(),
      lyrics: app.lines,
      timeline: app.timeline,
      aligner: { mode: "imported-json", confidence: 1 }
    }));
    elements.projectTitle.textContent = project.title || "Imported project";
    renderTimeline();
    renderPreview();
    drawWaveform();
    setStatus("JSON 타임라인을 불러왔습니다.");
  } catch (error) {
    setStatus(`JSON 불러오기 실패: ${error.message}`, true);
  }
}

function animationLoop() {
  const currentTime = positiveFinite(elements.audioPlayer.currentTime);
  if (currentTime > 0 && !elements.audioPlayer.seeking) {
    app.lastKnownAudioTime = currentTime;
  }

  renderPreview();
  drawWaveform();
  if (!elements.audioPlayer.paused) {
    postPlayback("tick");
  }
  requestAnimationFrame(animationLoop);
}

elements.audioFile.addEventListener("change", () => {
  const [file] = elements.audioFile.files;
  if (!file) return;
  resetDeveloperDiagnostics();
  app.audioFile = file;
  app.projectDuration = 0;
  app.lastKnownAudioTime = 0;
  if (app.audioObjectUrl) URL.revokeObjectURL(app.audioObjectUrl);
  app.audioObjectUrl = URL.createObjectURL(file);
  elements.audioPlayer.src = app.audioObjectUrl;
  elements.projectTitle.textContent = file.name;
  clearAnalysisConflict();
  setStatus("가사를 선택한 뒤 자동 싱크를 생성하세요.");
});

elements.lyricsFile.addEventListener("change", async () => {
  const [file] = elements.lyricsFile.files;
  if (!file) return;
  elements.lyricsText.value = await readLyricsFile(file);
  app.lines = parseLyrics(elements.lyricsText.value);
  clearAnalysisConflict();
  setStatus(`${app.lines.length}줄의 가사를 읽었습니다.`);
});

elements.lyricsText.addEventListener("input", () => {
  app.lines = parseLyrics(elements.lyricsText.value);
  clearAnalysisConflict();
});

elements.generateSync.addEventListener("click", generateSync);
elements.cancelAnalysis.addEventListener("click", cancelAnalysis);

elements.copyOverlay.addEventListener("click", async () => {
  await navigator.clipboard.writeText(elements.overlayUrl.value);
  elements.copyOverlay.textContent = "복사됨";
  setTimeout(() => {
    elements.copyOverlay.textContent = "복사";
  }, 1200);
});

elements.audioPlayer.addEventListener("loadedmetadata", () => {
  app.projectDuration = chooseDuration(app.projectDuration, elements.audioPlayer.duration);
  elements.duration.textContent = formatTime(elements.audioPlayer.duration || 0);
});
elements.audioPlayer.addEventListener("play", () => postPlayback("play"));
elements.audioPlayer.addEventListener("pause", () => postPlayback("pause"));
elements.audioPlayer.addEventListener("seeked", () => postPlayback("seek"));
elements.audioPlayer.addEventListener("ratechange", () => postPlayback("seek"));
elements.audioPlayer.addEventListener("ended", async () => {
  const expectedDuration = getProjectDuration();
  const resumeFrom = Math.max(positiveFinite(elements.audioPlayer.currentTime), app.lastKnownAudioTime);

  if (app.recoveringEarlyEnd || expectedDuration <= 0 || resumeFrom <= 10 || resumeFrom >= expectedDuration - 5) {
    return;
  }

  app.recoveringEarlyEnd = true;
  try {
    elements.audioPlayer.currentTime = Math.min(expectedDuration - 0.5, resumeFrom + 0.08);
    await elements.audioPlayer.play();
    await postPlayback("play");
    setStatus(`재생이 ${formatTime(resumeFrom)}에서 조기 종료되어 이어서 재생했습니다.`);
  } catch {
    await postPlayback("pause");
  } finally {
    app.recoveringEarlyEnd = false;
  }
});

elements.restartPlayback.addEventListener("click", () => {
  elements.audioPlayer.currentTime = 0;
  app.lastKnownAudioTime = 0;
  postPlayback("restart");
  renderPreview();
  drawWaveform();
});

elements.syncPlayback.addEventListener("click", () => postPlayback("seek"));
elements.exportProject.addEventListener("click", exportProject);
elements.importProject.addEventListener("change", () => {
  const [file] = elements.importProject.files;
  if (file) importProject(file);
});

elements.setSelectedToNow.addEventListener("click", () => {
  const row = app.timeline[app.selectedIndex];
  if (!row) return;
  applyAnchor(app.selectedIndex, elements.audioPlayer.currentTime || row.start);
});

for (const button of elements.shiftAfterButtons) {
  button.addEventListener("click", () => {
    shiftRows(app.selectedIndex, Number(button.dataset.shiftAfter) || 0, "shift-after-selected");
  });
}

for (const button of elements.shiftAllButtons) {
  button.addEventListener("click", () => {
    shiftRows(0, Number(button.dataset.shiftAll) || 0, "shift-all");
  });
}

elements.exportDeveloperLog.addEventListener("click", exportDeveloperDiagnostics);
elements.clearDeveloperLog.addEventListener("click", clearDeveloperEvents);
elements.closeDeveloperMode.addEventListener("click", () => setDeveloperMode(false));

document.addEventListener("keydown", (event) => {
  if (event.key !== "F12" || event.repeat) return;
  event.preventDefault();
  event.stopPropagation();
  registerDeveloperF12Press();
}, true);

window.__obsKaraokeF12 = registerDeveloperF12Press;

for (const input of [elements.fontSize, elements.showNext, elements.shadow, elements.accent, elements.textColor]) {
  input.addEventListener("input", updateStyle);
  input.addEventListener("change", updateStyle);
}

for (const button of elements.alignButtons) {
  button.addEventListener("click", () => {
    app.activeAlign = button.dataset.align;
    for (const other of elements.alignButtons) {
      other.classList.toggle("selected", other === button);
    }
    updateStyle();
  });
}

window.addEventListener("resize", drawWaveform);
window.addEventListener("beforeunload", closeControlSession);
window.addEventListener("pagehide", closeControlSession);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) openControlSession();
});

openControlSession();
fetch("/api/state")
  .then((response) => response.json())
  .then((state) => {
    absorbServerState(state);
    app.timeline = state.timeline || [];
    app.baseTimeline = cloneTimeline(app.timeline).map((row) => ({ ...row, anchor: false }));
    app.lines = state.lyrics || [];
    elements.lyricsText.value = app.lines.join("\n");
    elements.projectTitle.textContent = state.title || "프로젝트 없음";
    elements.fontSize.value = state.style?.fontSize || 56;
    elements.fontSizeValue.textContent = elements.fontSize.value;
    elements.showNext.checked = Boolean(state.style?.showNext ?? true);
    elements.shadow.checked = Boolean(state.style?.shadow ?? true);
    elements.accent.value = state.style?.accent || "#f6d365";
    elements.textColor.value = state.style?.textColor || "#ffffff";
    app.activeAlign = state.style?.align || "center";
    for (const button of elements.alignButtons) {
      button.classList.toggle("selected", button.dataset.align === app.activeAlign);
    }
    renderTimeline();
    renderPreview();
    drawWaveform();
  })
  .catch(() => {});

checkModelStatus();
requestAnimationFrame(animationLoop);
