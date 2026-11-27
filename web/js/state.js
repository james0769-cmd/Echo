const UNKNOWN_VALUES = new Set(["", "未定", "未指明", "未指定", "未知", "—", "-"]);

export const state = {
  appView: "home",
  sessions: [],
  sessionId: "clip01",
  audioName: "clip01.wav",
  audioUrl: null,
  hasEdits: false,
  asr: { duration: 0, rtf: 0, sentences: [] },
  minutesMeta: {},
  transcript: [],
  minutes: [],
  selectedMinuteId: null,
  minuteFilter: "全部",
  groupMode: "topic",
  collapsedTopics: new Set(),
  transcriptFilter: "all",
  transcriptQuery: "",
  expandedDiffs: new Set(),
  editingSentenceIdx: null,
  editingMinuteId: null,
  inlineEditField: null,
  playMode: "evidence",
  activeSpanIndex: 0,
  playingSentenceIdx: -1,
  autoFollow: true,
  pendingAudioSeek: null,
  selectedUploadFile: null,
  homeFilter: "all",
  homeQuery: "",
  homeUploadFile: null,
  taskSources: new Set(),
  taskCount: 0,
  mobilePane: "minutes",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]
  ));
}

export function formatTime(seconds, roundUp = false) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "--:--";
  const val = Math.max(0, Number(seconds));
  const total = roundUp ? Math.ceil(val) : Math.floor(val);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function formatSentenceId(idx) {
  return `S${String(idx + 1).padStart(3, "0")}`;
}

export function normalizeUnknownField(value) {
  const trimmed = String(value ?? "").trim();
  return UNKNOWN_VALUES.has(trimmed) ? "未知" : trimmed;
}

export function isUnknownValue(value) {
  return normalizeUnknownField(value) === "未知";
}

export function getMinuteSpans(item) {
  if (!item) return [];
  const raw = Array.isArray(item.evidence_spans) && item.evidence_spans.length
    ? item.evidence_spans
    : (item.evidence_start != null && item.evidence_end != null
      ? [{ start: item.evidence_start, end: item.evidence_end }]
      : []);
  return raw
    .map((span) => ({
      id: span.id || null,
      start: Number(span.start),
      end: Number(span.end),
    }))
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end >= span.start)
    .sort((a, b) => a.start - b.start);
}

export function recomputeMappings() {
  state.transcript.forEach((sentence, idx) => {
    sentence.index = idx;
    sentence.rawId = formatSentenceId(idx);
    sentence.citedBy = [];
  });

  state.minutes.forEach((item, idx) => {
    if (!item.id) item.id = `m${String(idx + 1).padStart(2, "0")}`;
    const spans = getMinuteSpans(item);
    item._spans = spans;
    const matched = [];
    if (spans.length) {
      state.transcript.forEach((sentence) => {
        const overlaps = spans.some(
          (span) => Number(sentence.end) > span.start + 0.05 && Number(sentence.start) < span.end - 0.05,
        );
        if (overlaps) {
          matched.push(sentence.index);
          sentence.citedBy.push(item.id);
        }
      });
    }
    item.matchedSentenceIndices = matched;
  });
}

export function getSelectedMinute() {
  return state.minutes.find((item) => item.id === state.selectedMinuteId) || null;
}

export function getAllEvidenceSpans() {
  return state.minutes.flatMap((item) => item._spans || getMinuteSpans(item));
}

export function taskSourceKey(sessionId, minuteId) {
  return `${sessionId}/${minuteId}`;
}

export function acceptedAudio(file) {
  if (!file) return { file: null, error: null };
  if (!/\.(wav|m4a|mp3)$/i.test(file.name || "")) {
    return { file: null, error: "请选择 WAV、M4A 或 MP3 录音" };
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > 80 * 1024 * 1024) {
    return { file: null, error: "请选择不超过 80 MB 的有效录音" };
  }
  return { file, error: null };
}

export function parseHashRoute(hash = (typeof window !== "undefined" ? window.location.hash : "")) {
  const match = /^#session\/(live|clip0[1-5]|record-[a-f0-9-]{36})(?:\/minute\/(m(?:\d+|-[a-f0-9-]{36})))?$/.exec(
    String(hash || ""),
  );
  return match ? { sessionId: match[1], minuteId: match[2] } : {};
}

export function parseEvidenceIdsInput(text) {
  const tokens = String(text || "")
    .toUpperCase()
    .split(/[\s,，;；]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const indices = [];
  tokens.forEach((tok) => {
    const m = /^S?(\d+)$/.exec(tok);
    if (!m) return;
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < state.transcript.length && !indices.includes(idx)) {
      indices.push(idx);
    }
  });
  indices.sort((a, b) => a - b);
  return indices;
}

export function buildEvidenceFromIndices(indices) {
  if (!indices.length) {
    return {
      evidence_ids: [],
      evidence_spans: [],
      evidence_start: null,
      evidence_end: null,
      evidence_text: "",
    };
  }
  const sents = indices.map((i) => state.transcript[i]);
  const spans = sents.map((s) => ({
    id: s.rawId,
    start: Number(s.start),
    end: Number(s.end),
  }));
  return {
    evidence_ids: sents.map((s) => s.rawId),
    evidence_spans: spans,
    evidence_start: spans[0].start,
    evidence_end: spans[spans.length - 1].end,
    evidence_text: sents.map((s) => s.text).join("；"),
  };
}

export function buildMarkdownReport() {
  const lines = [`# 会议纪要 · ${state.sessionId} (${state.audioName})`, ""];
  if (!state.minutes.length) {
    lines.push("本段没有抽取到可记录的决定、待办或待确认事项。", "");
    return lines.join("\n");
  }
  const groups = new Map();
  state.minutes.forEach((item) => {
    const topic = String(item.topic || "未分类议题").trim();
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(item);
  });

  for (const [topic, items] of groups.entries()) {
    lines.push(`## ${topic}`, "");
    items.forEach((item) => {
      const status = item.verified ? "[已核对] " : "";
      const spans = item._spans || getMinuteSpans(item);
      const timeStr = spans.length
        ? `${formatTime(spans[0].start)}–${formatTime(spans[spans.length - 1].end, true)}`
        : "未知";
      lines.push(`- **${status}[${item.type}]** ${item.content}`);
      lines.push(
        `  - 负责人：${normalizeUnknownField(item.responsible)}｜截止：${normalizeUnknownField(item.deadline)}｜时间：\`${timeStr}\``,
      );
      if (item.evidence_text) {
        lines.push(`  - 原话证据：${item.evidence_text}`);
      }
      if (Array.isArray(item.flags) && item.flags.length) {
        lines.push(`  - 校对提示：${item.flags.join("；")}`);
      }
    });
    lines.push("");
  }
  return lines.join("\n");
}
