const BAR_COUNT = 200;
const MIN_AMPLITUDE = 0.08;
const MAX_AMPLITUDE = 1.0;

const COLORS = {
  bandAll: "rgba(242, 169, 59, 0.14)",
  bandActive: "rgba(242, 169, 59, 0.28)",
  capActive: "#F5B74F",
  barActivePlayed: "#F5B74F",
  barActiveUnplayed: "#C9841F",
  barPlayed: "#E4EAF2",
  barUnplayed: "#3E4756",
  playhead: "#FFFFFF",
  hoverGuide: "rgba(255, 255, 255, 0.35)",
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatTimeMMSS(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "00:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function normalizeSpans(spans) {
  if (!Array.isArray(spans) || !spans.length) return [];
  const normalized = [];
  for (const span of spans) {
    if (!span) continue;
    const start = Number(span.start);
    const end = Number(span.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      normalized.push({ start, end });
    }
  }
  return normalized;
}

function spansEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end) return false;
  }
  return true;
}

function createBaselinePeaks(seedKey = "", durationHint = 0) {
  const seedStr = `${seedKey || "echotrace"}:${Math.round(Number(durationHint) || 0)}`;
  let hash = 2166136261;
  for (let i = 0; i < seedStr.length; i += 1) {
    hash ^= seedStr.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const phase = (hash >>> 0) % 360;
  const peaks = new Array(BAR_COUNT);
  for (let i = 0; i < BAR_COUNT; i += 1) {
    const waveA = Math.sin((i * 0.14) + phase);
    const waveB = Math.cos((i * 0.31) - phase * 0.5);
    const amp = 0.16 + 0.045 * waveA + 0.025 * waveB;
    peaks[i] = clamp(amp, MIN_AMPLITUDE, 0.28);
  }
  return peaks;
}

function extractPeaksFromBuffer(audioBuffer, count = BAR_COUNT) {
  const numChannels = Math.max(1, audioBuffer.numberOfChannels || 1);
  const totalSamples = audioBuffer.length || 0;
  if (totalSamples <= 0) {
    return createBaselinePeaks("empty", audioBuffer.duration);
  }

  const channels = [];
  for (let ch = 0; ch < numChannels; ch += 1) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  const raw = new Float32Array(count);
  let globalMax = 0;

  for (let i = 0; i < count; i += 1) {
    const start = Math.floor((i / count) * totalSamples);
    const end = Math.max(start + 1, Math.floor(((i + 1) / count) * totalSamples));
    const spanLen = end - start;
    const step = Math.max(1, Math.floor(spanLen / 256));

    let sumSq = 0;
    let peak = 0;
    let samples = 0;

    for (let s = start; s < end; s += step) {
      let val = 0;
      for (let ch = 0; ch < numChannels; ch += 1) {
        const abs = Math.abs(channels[ch][s]);
        if (abs > val) val = abs;
      }
      sumSq += val * val;
      if (val > peak) peak = val;
      samples += 1;
    }

    const rms = samples > 0 ? Math.sqrt(sumSq / samples) : 0;
    const score = 0.72 * rms + 0.28 * peak;
    raw[i] = score;
    if (score > globalMax) globalMax = score;
  }

  if (globalMax <= 1e-6) {
    return createBaselinePeaks("silent", audioBuffer.duration);
  }

  const peaks = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const norm = clamp(raw[i] / globalMax, 0, 1);
    const curved = Math.pow(norm, 0.85);
    peaks[i] = clamp(MIN_AMPLITUDE + (MAX_AMPLITUDE - MIN_AMPLITUDE) * curved, MIN_AMPLITUDE, MAX_AMPLITUDE);
  }
  return peaks;
}

function resamplePeaks(peaks, targetCount) {
  if (!peaks || !peaks.length) return new Array(targetCount).fill(0.16);
  if (peaks.length === targetCount) return peaks;
  const out = new Array(targetCount);
  const srcLen = peaks.length;
  for (let i = 0; i < targetCount; i += 1) {
    const start = (i / targetCount) * srcLen;
    const end = ((i + 1) / targetCount) * srcLen;
    const lo = Math.floor(start);
    const hi = Math.min(srcLen - 1, Math.floor(end));
    if (lo === hi) {
      out[i] = peaks[lo];
    } else {
      let sum = 0;
      let n = 0;
      for (let k = lo; k <= hi; k += 1) {
        sum += peaks[k];
        n += 1;
      }
      out[i] = n > 0 ? sum / n : peaks[lo];
    }
  }
  return out;
}

function drawRoundedBar(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  if (r <= 0.2) {
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

export class WaveformPlayer {
  /**
   * @param {{
   *   canvas: HTMLCanvasElement,
   *   container?: HTMLElement,
   *   tooltipEl?: HTMLElement,
   *   onSeek?: (seconds: number, opts: { commit?: boolean }) => void
   * }} options
   */
  constructor({ canvas, container, tooltipEl, onSeek } = {}) {
    this.canvas = canvas || null;
    this.container = container || canvas?.parentElement || null;
    this.tooltipEl = tooltipEl || null;
    this.onSeek = typeof onSeek === "function" ? onSeek : null;

    this.peaksCache = new Map();
    this.abortController = null;
    this._loadSeq = 0;
    this.audioContext = null;

    this.durationHint = 0;
    this.peaks = createBaselinePeaks("", 0);

    this.state = {
      currentTime: 0,
      duration: 0,
      allSpans: [],
      activeSpans: [],
      isPlaying: false,
    };

    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.rafId = null;
    this.destroyed = false;

    this.hoverX = null;
    this.isDragging = false;
    this.activePointerId = null;

    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    this._onPointerCancel = this._handlePointerCancel.bind(this);
    this._onPointerLeave = this._handlePointerLeave.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);

    if (this.canvas) {
      this.canvas.setAttribute("aria-valuemin", "0");
      this._syncAria();
      this.canvas.addEventListener("pointerdown", this._onPointerDown);
      this.canvas.addEventListener("pointermove", this._onPointerMove);
      this.canvas.addEventListener("pointerup", this._onPointerUp);
      this.canvas.addEventListener("pointercancel", this._onPointerCancel);
      this.canvas.addEventListener("pointerleave", this._onPointerLeave);
      this.canvas.addEventListener("keydown", this._onKeyDown);
    }

    this.resizeObserver = null;
    const observeTarget = this.container || this.canvas;
    if (typeof ResizeObserver !== "undefined" && observeTarget) {
      this.resizeObserver = new ResizeObserver(() => {
        if (this._measureSize()) {
          this._scheduleDraw();
        }
      });
      this.resizeObserver.observe(observeTarget);
    }

    this._measureSize();
    this._scheduleDraw();
  }

  async loadAudio(audioUrl, durationHint = 0) {
    if (this.destroyed) return this.peaks;

    const loadSeq = ++this._loadSeq;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    this.durationHint = Number.isFinite(Number(durationHint)) ? Math.max(0, Number(durationHint)) : 0;

    if (!audioUrl) {
      this.peaks = createBaselinePeaks("no-audio", this.durationHint);
      this._syncAria();
      this._scheduleDraw();
      return this.peaks;
    }

    if (this.peaksCache.has(audioUrl)) {
      this.peaks = this.peaksCache.get(audioUrl);
      this._syncAria();
      this._scheduleDraw();
      return this.peaks;
    }

    // Display calm baseline immediately while fetching/decoding
    this.peaks = createBaselinePeaks(audioUrl, this.durationHint);
    this._syncAria();
    this._scheduleDraw();

    const controller = new AbortController();
    this.abortController = controller;

    try {
      const response = await fetch(audioUrl, { signal: controller.signal });
      if (this.destroyed || loadSeq !== this._loadSeq || controller.signal.aborted) {
        return this.peaks;
      }
      if (!response.ok) {
        throw new Error(`Audio fetch failed (${response.status})`);
      }

      const arrayBuffer = await response.arrayBuffer();
      if (this.destroyed || loadSeq !== this._loadSeq || controller.signal.aborted) {
        return this.peaks;
      }

      const audioBuffer = await this._decodeAudio(arrayBuffer);
      if (this.destroyed || loadSeq !== this._loadSeq || controller.signal.aborted) {
        return this.peaks;
      }

      const peaks = extractPeaksFromBuffer(audioBuffer, BAR_COUNT);
      this.peaksCache.set(audioUrl, peaks);
      this.peaks = peaks;
      if (this.durationHint <= 0 && Number.isFinite(audioBuffer.duration)) {
        this.durationHint = audioBuffer.duration;
      }
      this._syncAria();
      this._scheduleDraw();
      return peaks;
    } catch (error) {
      if (
        this.destroyed ||
        loadSeq !== this._loadSeq ||
        controller.signal.aborted ||
        error?.name === "AbortError"
      ) {
        return this.peaks;
      }
      const fallback = createBaselinePeaks(audioUrl, this.durationHint);
      this.peaks = fallback;
      this._scheduleDraw();
      return fallback;
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  setState({ currentTime, duration, allSpans, activeSpans, isPlaying } = {}) {
    if (this.destroyed) return;

    const nextCurrentTime = currentTime !== undefined
      ? (Number.isFinite(Number(currentTime)) ? Math.max(0, Number(currentTime)) : 0)
      : this.state.currentTime;
    const nextDuration = duration !== undefined
      ? (Number.isFinite(Number(duration)) ? Math.max(0, Number(duration)) : 0)
      : this.state.duration;
    const nextAllSpans = allSpans !== undefined ? normalizeSpans(allSpans) : this.state.allSpans;
    const nextActiveSpans = activeSpans !== undefined ? normalizeSpans(activeSpans) : this.state.activeSpans;
    const nextIsPlaying = isPlaying !== undefined ? Boolean(isPlaying) : this.state.isPlaying;

    const changed =
      nextCurrentTime !== this.state.currentTime ||
      nextDuration !== this.state.duration ||
      nextIsPlaying !== this.state.isPlaying ||
      !spansEqual(nextAllSpans, this.state.allSpans) ||
      !spansEqual(nextActiveSpans, this.state.activeSpans);

    if (!changed) return;

    this.state = {
      currentTime: nextCurrentTime,
      duration: nextDuration,
      allSpans: nextAllSpans,
      activeSpans: nextActiveSpans,
      isPlaying: nextIsPlaying,
    };

    this._syncAria();
    this._scheduleDraw();
  }

  destroy() {
    this.destroyed = true;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (this.canvas) {
      this.canvas.removeEventListener("pointerdown", this._onPointerDown);
      this.canvas.removeEventListener("pointermove", this._onPointerMove);
      this.canvas.removeEventListener("pointerup", this._onPointerUp);
      this.canvas.removeEventListener("pointercancel", this._onPointerCancel);
      this.canvas.removeEventListener("pointerleave", this._onPointerLeave);
      this.canvas.removeEventListener("keydown", this._onKeyDown);
    }

    if (this.audioContext && typeof this.audioContext.close === "function") {
      try {
        const closing = this.audioContext.close();
        if (closing && typeof closing.catch === "function") closing.catch(() => {});
      } catch {
        // ignore close failure
      }
      this.audioContext = null;
    }

    this._hideTooltip();
    this.peaksCache.clear();
  }

  _getEffectiveDuration() {
    if (this.state.duration > 0) return this.state.duration;
    if (this.durationHint > 0) return this.durationHint;
    return 0;
  }

  _getAudioContext() {
    if (this.audioContext) return this.audioContext;
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtx) return null;
    try {
      this.audioContext = new AudioCtx();
      return this.audioContext;
    } catch {
      return null;
    }
  }

  async _decodeAudio(arrayBuffer) {
    const ctx = this._getAudioContext();
    if (!ctx || typeof ctx.decodeAudioData !== "function") {
      throw new Error("AudioContext unavailable");
    }
    return new Promise((resolve, reject) => {
      try {
        const maybePromise = ctx.decodeAudioData(arrayBuffer, resolve, reject);
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then(resolve, reject);
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  _resumeAudioContextIfNeeded() {
    if (this.audioContext && this.audioContext.state === "suspended" && typeof this.audioContext.resume === "function") {
      try {
        const res = this.audioContext.resume();
        if (res && typeof res.catch === "function") res.catch(() => {});
      } catch {
        // ignore autoplay resume failure
      }
    }
  }

  _measureSize() {
    if (!this.canvas) return false;
    const box = this.container || this.canvas;
    const rect = box.getBoundingClientRect ? box.getBoundingClientRect() : null;
    const cssWidth = Math.max(0, Math.round(rect?.width || box.clientWidth || this.canvas.clientWidth || 0));
    const cssHeight = Math.max(0, Math.round(rect?.height || box.clientHeight || this.canvas.clientHeight || 0));
    const dpr = clamp(globalThis.devicePixelRatio || 1, 1, 3);

    if (cssWidth === 0 || cssHeight === 0) return false;

    const targetW = Math.round(cssWidth * dpr);
    const targetH = Math.round(cssHeight * dpr);
    const changed =
      cssWidth !== this.width ||
      cssHeight !== this.height ||
      dpr !== this.dpr ||
      this.canvas.width !== targetW ||
      this.canvas.height !== targetH;

    if (!changed) return false;

    this.width = cssWidth;
    this.height = cssHeight;
    this.dpr = dpr;
    this.canvas.width = targetW;
    this.canvas.height = targetH;
    return true;
  }

  _scheduleDraw() {
    if (this.destroyed || !this.canvas) return;
    if (this.rafId !== null) return;
    const raf = globalThis.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
    this.rafId = raf(() => {
      this.rafId = null;
      if (!this.destroyed) {
        this._draw();
      }
    });
  }

  _draw() {
    if (!this.canvas || this.destroyed) return;
    this._measureSize();
    if (this.width <= 0 || this.height <= 0) return;

    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    const width = this.width;
    const height = this.height;
    const dpr = this.dpr;
    const duration = this._getEffectiveDuration();
    const currentTime = clamp(this.state.currentTime, 0, duration || this.state.currentTime);
    const { allSpans, activeSpans } = this.state;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const timeToX = (t) => (duration > 0 ? clamp((t / duration) * width, 0, width) : 0);

    // Layer 1: Background evidence bands (allSpans)
    if (duration > 0 && allSpans.length) {
      ctx.fillStyle = COLORS.bandAll;
      for (const span of allSpans) {
        const x1 = timeToX(span.start);
        const x2 = timeToX(span.end);
        const w = Math.max(2, x2 - x1);
        ctx.fillRect(x1, 0, w, height);
      }
    }

    // Layer 2: Active selected minute evidence bands (activeSpans) + 2px top/bottom caps
    if (duration > 0 && activeSpans.length) {
      for (const span of activeSpans) {
        const x1 = timeToX(span.start);
        const x2 = timeToX(span.end);
        const w = Math.max(3, x2 - x1);
        ctx.fillStyle = COLORS.bandActive;
        ctx.fillRect(x1, 0, w, height);

        ctx.fillStyle = COLORS.capActive;
        ctx.fillRect(x1, 0, w, 2);
        ctx.fillRect(x1, height - 2, w, 2);
      }
    }

    // Layer 3: Waveform bars (2px-3px wide with 1px-2px gap, centered vertically)
    const barWidth = width >= 720 ? 3 : (width >= 440 ? 2.5 : 2);
    const gap = width >= 720 ? 2 : (width >= 440 ? 1.5 : 1);
    const pitch = barWidth + gap;
    const barCount = Math.max(12, Math.floor((width + gap) / pitch));
    const bars = resamplePeaks(this.peaks, barCount);
    const totalBarsWidth = barCount * barWidth + (barCount - 1) * gap;
    const offsetX = Math.max(0, (width - totalBarsWidth) / 2);
    const maxBarHeight = Math.max(6, height - 10);
    const minBarHeight = 3;
    const playheadX = duration > 0 ? clamp((currentTime / duration) * width, 0, width) : 0;

    for (let i = 0; i < barCount; i += 1) {
      const x = offsetX + i * pitch;
      const barCenterX = x + barWidth / 2;
      const amp = clamp(bars[i], MIN_AMPLITUDE, MAX_AMPLITUDE);
      const barHeight = Math.max(minBarHeight, amp * maxBarHeight);
      const y = (height - barHeight) / 2;

      const tStart = duration > 0 ? (x / width) * duration : 0;
      const tEnd = duration > 0 ? ((x + barWidth) / width) * duration : 0;
      const isPlayed = duration > 0 && currentTime > 0 && barCenterX <= playheadX;
      const inActive =
        duration > 0 &&
        activeSpans.some((span) => tEnd >= span.start && tStart <= span.end);

      if (inActive) {
        ctx.fillStyle = isPlayed ? COLORS.barActivePlayed : COLORS.barActiveUnplayed;
      } else {
        ctx.fillStyle = isPlayed ? COLORS.barPlayed : COLORS.barUnplayed;
      }

      drawRoundedBar(ctx, x, y, barWidth, barHeight, Math.min(1.2, barWidth / 2));
    }

    // Layer 4: Playhead (crisp 1.5px vertical line + small top indicator dot)
    if (duration > 0 || currentTime === 0) {
      const px = clamp(playheadX, 1, Math.max(1, width - 1));
      ctx.fillStyle = COLORS.playhead;
      ctx.fillRect(px - 0.75, 2, 1.5, Math.max(0, height - 2));

      ctx.beginPath();
      ctx.arc(px, 3.2, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Layer 5: Hover guide hairline
    if (this.hoverX !== null) {
      const hx = clamp(Math.round(this.hoverX) + 0.5, 0.5, Math.max(0.5, width - 0.5));
      ctx.fillStyle = COLORS.hoverGuide;
      ctx.fillRect(hx - 0.5, 0, 1, height);
    }

    ctx.restore();
  }

  _pointerEventToX(event) {
    if (!this.canvas) return 0;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || this.width || 1;
    return clamp(event.clientX - rect.left, 0, w);
  }

  _xToTime(x) {
    const duration = this._getEffectiveDuration();
    if (duration <= 0 || this.width <= 0) return 0;
    return clamp((x / this.width) * duration, 0, duration);
  }

  _updateTooltip(x) {
    if (!this.tooltipEl) return;
    const hoverTime = this._xToTime(x);
    this.tooltipEl.textContent = formatTimeMMSS(hoverTime);
    const edgePad = this.width > 56 ? 24 : 0;
    const clampedX = clamp(x, edgePad, Math.max(edgePad, this.width - edgePad));
    let offsetLeft = 0;
    if (this.container && this.canvas?.getBoundingClientRect && this.container.getBoundingClientRect) {
      const cRect = this.canvas.getBoundingClientRect();
      const wrapRect = this.container.getBoundingClientRect();
      if (wrapRect.width > 0 && cRect.width > 0) {
        offsetLeft = cRect.left - wrapRect.left;
      }
    }
    this.tooltipEl.style.left = `${offsetLeft + clampedX}px`;
    this.tooltipEl.classList.remove("hidden");
  }

  _hideTooltip() {
    if (!this.tooltipEl) return;
    this.tooltipEl.classList.add("hidden");
  }

  _emitSeek(seconds, { commit = false } = {}) {
    if (!this.onSeek) return;
    const duration = this._getEffectiveDuration();
    const target = duration > 0 ? clamp(seconds, 0, duration) : Math.max(0, seconds);
    this.onSeek(target, { commit });
  }

  _syncAria() {
    if (!this.canvas) return;
    const duration = this._getEffectiveDuration();
    const current = clamp(this.state.currentTime, 0, duration || this.state.currentTime);
    this.canvas.setAttribute("aria-valuemax", String(Math.round(duration * 10) / 10));
    this.canvas.setAttribute("aria-valuenow", String(Math.round(current * 10) / 10));
    this.canvas.setAttribute(
      "aria-valuetext",
      `${formatTimeMMSS(current)} / ${formatTimeMMSS(duration)}`,
    );
  }

  _handlePointerDown(event) {
    if (this.destroyed) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    this._resumeAudioContextIfNeeded();
    if (this.width <= 0) this._measureSize();

    this.isDragging = true;
    this.activePointerId = event.pointerId;

    if (typeof this.canvas.setPointerCapture === "function") {
      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch {
        // ignore synthetic event capture failure
      }
    }

    const x = this._pointerEventToX(event);
    this.hoverX = x;
    this._updateTooltip(x);
    this._emitSeek(this._xToTime(x), { commit: false });
    this._scheduleDraw();
  }

  _handlePointerMove(event) {
    if (this.destroyed) return;
    if (this.width <= 0) this._measureSize();

    const x = this._pointerEventToX(event);
    this.hoverX = x;
    this._updateTooltip(x);

    if (this.isDragging && (this.activePointerId === null || event.pointerId === this.activePointerId)) {
      this._emitSeek(this._xToTime(x), { commit: false });
    }
    this._scheduleDraw();
  }

  _handlePointerUp(event) {
    if (this.destroyed || !this.isDragging) return;
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return;

    const x = this._pointerEventToX(event);
    this.isDragging = false;
    this.activePointerId = null;

    if (typeof this.canvas.releasePointerCapture === "function") {
      try {
        if (!this.canvas.hasPointerCapture || this.canvas.hasPointerCapture(event.pointerId)) {
          this.canvas.releasePointerCapture(event.pointerId);
        }
      } catch {
        // ignore
      }
    }

    this._updateTooltip(x);
    this._emitSeek(this._xToTime(x), { commit: true });
    this._scheduleDraw();
  }

  _handlePointerCancel(event) {
    if (this.destroyed) return;
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return;

    this.isDragging = false;
    this.activePointerId = null;
    this.hoverX = null;
    this._hideTooltip();

    if (typeof this.canvas.releasePointerCapture === "function") {
      try {
        if (!this.canvas.hasPointerCapture || this.canvas.hasPointerCapture(event.pointerId)) {
          this.canvas.releasePointerCapture(event.pointerId);
        }
      } catch {
        // ignore
      }
    }

    this._scheduleDraw();
  }

  _handlePointerLeave() {
    if (this.destroyed || this.isDragging) return;
    this.hoverX = null;
    this._hideTooltip();
    this._scheduleDraw();
  }

  _handleKeyDown(event) {
    if (this.destroyed) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

    event.preventDefault();
    this._resumeAudioContextIfNeeded();

    const delta = event.key === "ArrowLeft" ? -3 : 3;
    const duration = this._getEffectiveDuration();
    const base = this.state.currentTime;
    const target = duration > 0 ? clamp(base + delta, 0, duration) : Math.max(0, base + delta);
    this._emitSeek(target, { commit: true });
  }
}
