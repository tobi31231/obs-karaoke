const root = document.querySelector("#overlayRoot");
const currentEl = document.querySelector("#overlayCurrent");
const nextEl = document.querySelector("#overlayNext");

const overlay = {
  state: null,
  receivedAt: performance.now(),
  currentText: "",
  currentKey: "",
  nextText: "",
  currentSlots: [],
  lastStateFetchAt: 0
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getTime() {
  if (!overlay.state) return 0;
  const playback = overlay.state.playback || {};
  let time = Number(playback.currentTime) || 0;
  if (playback.playing) {
    time += ((performance.now() - overlay.receivedAt) / 1000) * (Number(playback.rate) || 1);
  }
  return clamp(time, 0, Number(overlay.state.duration) || Number.MAX_SAFE_INTEGER);
}

function lineAt(time) {
  const timeline = overlay.state?.timeline || [];
  let current = null;
  let next = null;

  for (const row of timeline) {
    if (time >= row.start && time <= row.end) {
      current = row;
      next = timeline[row.index + 1] || null;
      break;
    }

    if (row.start > time) {
      next = row;
      break;
    }
  }

  return { current, next };
}

function applyStyle() {
  const style = overlay.state?.style || {};
  root.style.setProperty("--overlay-font-size", `${Number(style.fontSize) || 56}px`);
  root.style.setProperty("--overlay-accent", style.accent || "#f6d365");
  root.style.setProperty("--overlay-text", style.textColor || "#ffffff");
  root.classList.toggle("shadow", Boolean(style.shadow ?? true));
  root.classList.toggle("align-left", style.align === "left");
  root.classList.toggle("align-right", style.align === "right");
  nextEl.classList.toggle("hidden", !Boolean(style.showNext ?? true));
}

function fitOverlayLine(element, variableName, minScale) {
  if (!element.textContent.trim()) {
    root.style.setProperty(variableName, "1");
    return;
  }

  root.style.setProperty(variableName, "1");
  const availableWidth = Math.max(120, root.clientWidth * 0.92);
  const actualWidth = element.scrollWidth || element.getBoundingClientRect().width || 0;
  const scale = actualWidth > availableWidth ? clamp(availableWidth / actualWidth, minScale, 1) : 1;
  root.style.setProperty(variableName, scale.toFixed(3));
}

function fitOverlayText() {
  fitOverlayLine(currentEl, "--overlay-current-scale", 0.42);
  fitOverlayLine(nextEl, "--overlay-next-scale", 0.55);
}

function updateState(state) {
  overlay.state = state;
  overlay.receivedAt = performance.now();
  applyStyle();
  requestAnimationFrame(fitOverlayText);
}

function splitText(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return Array.from(new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(String(text || "")), (part) => part.segment);
  }

  return Array.from(String(text || ""));
}

function fallbackTokens(row) {
  const units = splitText(row?.text || "");
  const visibleCount = units.filter((unit) => !/\s/.test(unit)).length;
  let position = 0;
  return units.map((text, index) => {
    if (/\s/.test(text)) {
      const marker = row.start + (row.end - row.start) * position / Math.max(1, visibleCount);
      return { index, text, start: marker, end: marker, timed: false };
    }
    const start = row.start + (row.end - row.start) * position / Math.max(1, visibleCount);
    position += 1;
    const end = row.start + (row.end - row.start) * position / Math.max(1, visibleCount);
    return { index, text, start, end, timed: true };
  });
}

function renderCurrentLine(row) {
  if (!row) {
    if (!overlay.currentKey) return;
    overlay.currentKey = "";
    overlay.currentText = "";
    overlay.currentSlots = [];
    currentEl.textContent = "";
    return;
  }

  const tokens = Array.isArray(row.tokens) && row.tokens.length ? row.tokens : fallbackTokens(row);
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const key = `${row.id}:${row.start}:${row.end}:${tokens.length}:${first?.start}:${last?.end}`;
  if (key === overlay.currentKey) return;

  overlay.currentKey = key;
  overlay.currentText = row.text;
  overlay.currentSlots = [];
  currentEl.textContent = "";

  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    const span = document.createElement("span");
    span.className = "overlay-char";
    span.textContent = token.text;
    if (/\s/.test(token.text)) {
      span.classList.add("space-char");
    }
    overlay.currentSlots.push({ span, token });
    fragment.append(span);
  }

  currentEl.append(fragment);
  requestAnimationFrame(fitOverlayText);
}

function setTokenProgress(time, row) {
  for (const slot of overlay.currentSlots) {
    if (/\s/.test(slot.token.text)) continue;
    const start = Number(slot.token.start) || row.start;
    const end = Math.max(start + 0.015, Number(slot.token.end) || start + 0.015);
    const progress = overlay.state?.style?.karaokeFill === false ? 0 : slot.token.timed === false
      ? (time >= start ? 1 : 0)
      : clamp((time - start) / (end - start), 0, 1);
    const quantized = Math.round(progress * 200) / 2;
    if (slot.span.dataset.fill === String(quantized)) continue;
    slot.span.dataset.fill = String(quantized);
    slot.span.style.setProperty("--char-fill", `${quantized}%`);
  }
}

function render() {
  const time = getTime();
  const { current, next } = lineAt(time);
  const nextText = next ? next.text : "";

  renderCurrentLine(current);
  if (current) setTokenProgress(time, current);
  currentEl.classList.toggle("visible", Boolean(current));
  if (nextText !== overlay.nextText) {
    overlay.nextText = nextText;
    nextEl.textContent = nextText;
    requestAnimationFrame(fitOverlayText);
  }

  requestAnimationFrame(render);
}

function connectEvents() {
  const events = new EventSource("/events");
  events.onmessage = (event) => {
    updateState(JSON.parse(event.data));
  };
  events.onerror = () => {
    setTimeout(() => {
      if (events.readyState === EventSource.CLOSED) connectEvents();
    }, 1000);
  };
}

function refreshState() {
  overlay.lastStateFetchAt = performance.now();
  fetch(`/api/state?t=${Date.now()}`, { cache: "no-store" })
    .then((response) => response.json())
    .then(updateState)
    .catch(() => {});
}

fetch(`/api/state?t=${Date.now()}`, { cache: "no-store" })
  .then((response) => response.json())
  .then(updateState)
  .catch(() => {});

connectEvents();
setInterval(refreshState, 1000);
window.addEventListener("resize", fitOverlayText);
requestAnimationFrame(render);
