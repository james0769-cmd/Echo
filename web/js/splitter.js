const MOBILE_BREAKPOINT = 960;
const KEYBOARD_STEP = 0.02;

export function initPaneSplitter({
  container,
  handle,
  storageKey = "echotrace.splitRatio",
  minPx = 320,
  defaultRatio = 0.48,
}) {
  if (!container || !handle) {
    return { reset() {}, destroy() {} };
  }

  let currentRatio = readSavedRatio();
  let isDragging = false;
  let activePointerId = null;
  let prevUserSelect = "";

  function isDisabled() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  function readSavedRatio() {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw !== null) {
        const parsed = Number.parseFloat(raw);
        if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) {
          return parsed;
        }
      }
    } catch {
      // Ignore storage access errors
    }
    return defaultRatio;
  }

  function saveRatio(ratio) {
    try {
      window.localStorage.setItem(storageKey, ratio.toFixed(4));
    } catch {
      // Ignore storage access errors
    }
  }

  function clampRatio(ratio) {
    const safe = Number.isFinite(ratio) ? ratio : defaultRatio;
    const width = container.getBoundingClientRect().width;
    if (width > minPx * 2) {
      const minRatio = minPx / width;
      const maxRatio = 1 - minRatio;
      return Math.min(maxRatio, Math.max(minRatio, safe));
    }
    return Math.min(0.8, Math.max(0.2, safe));
  }

  function applyRatio(ratio) {
    const clamped = clampRatio(ratio);
    currentRatio = clamped;
    const pct = Number((clamped * 100).toFixed(2));
    container.style.setProperty("--split-left", `${pct}%`);
    handle.setAttribute("aria-valuenow", String(Math.round(pct)));
    return clamped;
  }

  function updateFromClientX(clientX) {
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    const rawRatio = (clientX - rect.left) / rect.width;
    applyRatio(rawRatio);
  }

  function onPointerDown(event) {
    if (isDisabled() || event.button !== 0) return;
    event.preventDefault();
    isDragging = true;
    activePointerId = event.pointerId;
    prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    handle.classList.add("is-dragging");
    handle.setPointerCapture?.(event.pointerId);
    updateFromClientX(event.clientX);
  }

  function onPointerMove(event) {
    if (!isDragging || event.pointerId !== activePointerId) return;
    updateFromClientX(event.clientX);
  }

  function finishDrag(event) {
    if (!isDragging) return;
    if (event && event.pointerId !== undefined && event.pointerId !== activePointerId) return;
    isDragging = false;
    handle.classList.remove("is-dragging");
    document.body.style.userSelect = prevUserSelect;
    if (activePointerId !== null) {
      try {
        handle.releasePointerCapture?.(activePointerId);
      } catch {
        // Ignore if pointer capture already released
      }
      activePointerId = null;
    }
    saveRatio(currentRatio);
  }

  function onDoubleClick() {
    if (isDisabled()) return;
    reset();
  }

  function onKeyDown(event) {
    if (isDisabled()) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const applied = applyRatio(currentRatio - KEYBOARD_STEP);
      saveRatio(applied);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      const applied = applyRatio(currentRatio + KEYBOARD_STEP);
      saveRatio(applied);
    }
  }

  function onWindowResize() {
    if (!isDisabled()) {
      applyRatio(currentRatio);
    }
  }

  function reset() {
    const applied = applyRatio(defaultRatio);
    saveRatio(applied);
  }

  function destroy() {
    finishDrag();
    handle.removeEventListener("pointerdown", onPointerDown);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", finishDrag);
    handle.removeEventListener("pointercancel", finishDrag);
    handle.removeEventListener("dblclick", onDoubleClick);
    handle.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onWindowResize);
  }

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", finishDrag);
  handle.addEventListener("pointercancel", finishDrag);
  handle.addEventListener("dblclick", onDoubleClick);
  handle.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onWindowResize);

  applyRatio(currentRatio);

  return { reset, destroy };
}
