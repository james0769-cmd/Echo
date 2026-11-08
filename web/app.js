const state = {
  transcript: [],
  minutes: [],
  selectedId: null,
  filter: "全部",
  currentView: "overview",
  audioUrl: "/media/demo.wav",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function formatTime(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "--:--";
  const totalSeconds = Math.max(0, Math.floor(Number(seconds)));
  const minutes = Math.floor(totalSeconds / 60);
  const rest = String(totalSeconds % 60).padStart(2, "0");
  return `${String(minutes).padStart(2, "0")}:${rest}`;
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function renderMetrics(asr, minutes) {
  const evidenceCount = minutes.filter((item) => item.evidence_text).length;
  const metrics = [
    ["音频时长", formatDuration(asr.duration), "本地 WAV 录音"],
    ["识别句数", asr.sentences.length, `RTF ${asr.rtf}`],
    ["纪要条目", minutes.length, "决定 / 待办 / 待确认"],
    ["证据绑定", `${evidenceCount}/${minutes.length}`, "条目可回溯原话"],
  ];
  $("#metricGrid").innerHTML = metrics.map(([label, value, note]) => `
    <div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>
  `).join("");
}

function renderTranscript(limit = 18) {
  const selectedIds = new Set((state.minutes.find((item) => item.id === state.selectedId)?.evidence_ids) || []);
  const list = state.transcript.slice(0, limit);
  $("#transcriptList").innerHTML = list.map((sentence) => `
    <div class="transcript-row ${selectedIds.has(sentence.id) ? "highlighted" : ""}" data-sentence-id="${sentence.id}">
      <div class="transcript-time">${formatTime(sentence.start)}</div>
      <div class="transcript-text">${escapeHtml(sentence.text)}</div>
    </div>
  `).join("");
}

function renderFullTranscript(query = "") {
  const normalized = query.trim().toLowerCase();
  const rows = state.transcript.filter((sentence) => !normalized || sentence.text.toLowerCase().includes(normalized));
  $("#fullTranscriptList").innerHTML = rows.map((sentence) => `
    <div class="transcript-row" data-sentence-id="${sentence.id}">
      <div class="transcript-time">${formatTime(sentence.start)}</div>
      <div class="transcript-text">${escapeHtml(sentence.text)}</div>
    </div>
  `).join("") || `<div class="empty-evidence">没有找到匹配的原话。</div>`;
}

function renderMinutes() {
  const visible = state.filter === "全部" ? state.minutes : state.minutes.filter((item) => item.type === state.filter);
  $("#minutesList").innerHTML = visible.map((item) => `
    <article class="minute-item ${item.id === state.selectedId ? "selected" : ""}" data-minute-id="${item.id}">
      <div class="minute-top"><div class="minute-topic">${escapeHtml(item.topic)}</div><span class="minute-type ${item.type === "决定" ? "decision" : ""}">${item.type}</span></div>
      <div class="minute-content">${escapeHtml(item.content)}</div>
      <div class="minute-meta"><span>${formatTime(item.evidence_start)}–${formatTime(item.evidence_end)}</span><span>负责人：${escapeHtml(item.responsible)}</span></div>
    </article>
  `).join("") || `<div class="empty-evidence">当前筛选没有条目。</div>`;
}

function renderReviewTable() {
  $("#reviewTable").innerHTML = `
    <div class="review-row review-head"><span>类型</span><span>议题</span><span>内容</span><span>证据</span></div>
    ${state.minutes.map((item) => `<div class="review-row"><span>${item.type}</span><span class="review-title">${escapeHtml(item.topic)}</span><span>${escapeHtml(item.content)}</span><span>${formatTime(item.evidence_start)}–${formatTime(item.evidence_end)}</span></div>`).join("")}
  `;
}

function renderEvidence(item) {
  if (!item) {
    $("#evidenceTitle").textContent = "选择一条纪要查看证据";
    $("#evidenceTime").textContent = "--:--";
    $("#evidenceBody").innerHTML = `<div class="empty-evidence">点击右侧纪要条目，查看对应原话、时间段和抽取提示。</div>`;
    return;
  }
  const spans = (item.evidence_spans?.length ? item.evidence_spans : [{ start: item.evidence_start, end: item.evidence_end }])
    .map((span) => ({ start: Number(span.start), end: Number(span.end) }))
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end))
    .sort((a, b) => a.start - b.start);
  $("#evidenceTitle").textContent = `${item.topic} · ${item.type}`;
  const firstSpan = spans[0] || { start: item.evidence_start, end: item.evidence_end };
  const lastSpan = spans[spans.length - 1] || firstSpan;
  $("#evidenceTime").textContent = `${spans.length > 1 ? `${spans.length}段 · ` : ""}${formatTime(firstSpan.start)}–${formatTime(lastSpan.end)}`;
  const flags = item.flags?.length ? `<div class="evidence-flag">${item.flags.map(escapeHtml).join("<br />")}</div>` : "";
  const audioBlock = state.audioUrl
    ? `<div class="evidence-player">
        <audio id="audioPlayer" preload="auto" src="${state.audioUrl}" aria-hidden="true"></audio>
        <button class="secondary-button compact-button" id="playEvidenceButton" type="button">播放证据片段</button>
        <div class="evidence-timeline">
          <span class="evidence-clock" id="evidenceCurrentTime">${formatTime(firstSpan.start)}</span>
          <input id="evidenceProgress" type="range" min="0" max="0" value="0" step="0.01" aria-label="证据播放进度" />
          <span class="evidence-clock" id="evidenceTotalTime">片段 00:00</span>
        </div>
      </div>`
    : `<div class="evidence-player"><span class="small-status">演示音频未随仓库提交，选择本地 WAV 后可播放证据。</span></div>`;
  $("#evidenceBody").innerHTML = `
    <div class="evidence-quote">${escapeHtml(item.evidence_text)}</div>
    <div class="evidence-details"><span>负责人：${escapeHtml(item.responsible)}</span><span>截止：${escapeHtml(item.deadline)}</span><span>证据句：${item.evidence_ids.join(", ")}</span></div>
    ${audioBlock}
    ${flags}
  `;
  if (state.audioUrl) {
    const player = $("#audioPlayer");
    const ranges = spans.length ? spans : [{ start: 0, end: null }];
    let rangeIndex = 0;
    let evidencePlayback = false;
    let stopHandler = null;
    const progress = $("#evidenceProgress");
    const currentLabel = $("#evidenceCurrentTime");
    const totalLabel = $("#evidenceTotalTime");
    const playButton = $("#playEvidenceButton");
    const rangeDurations = ranges.map((range) => Math.max(0, range.end - range.start));
    const totalEvidenceDuration = rangeDurations.reduce((sum, duration) => sum + duration, 0);

    progress.max = totalEvidenceDuration.toFixed(2);
    totalLabel.textContent = `片段 ${formatTime(totalEvidenceDuration)}`;

    const cumulativeBefore = (index) => rangeDurations.slice(0, index).reduce((sum, duration) => sum + duration, 0);
    const timelinePosition = () => {
      const range = ranges[rangeIndex];
      const offset = Math.max(0, Math.min(player.currentTime - range.start, rangeDurations[rangeIndex]));
      return cumulativeBefore(rangeIndex) + offset;
    };
    const updateTimeline = () => {
      const position = Math.min(totalEvidenceDuration, timelinePosition());
      progress.value = position.toFixed(2);
      currentLabel.textContent = formatTime(player.currentTime);
    };
    const seekTimeline = (position) => {
      let remaining = Math.max(0, Math.min(Number(position), totalEvidenceDuration));
      for (let index = 0; index < ranges.length; index += 1) {
        if (remaining <= rangeDurations[index] || index === ranges.length - 1) {
          rangeIndex = index;
          player.currentTime = ranges[index].start + Math.min(remaining, rangeDurations[index]);
          updateTimeline();
          return;
        }
        remaining -= rangeDurations[index];
      }
    };

    const stopEvidencePlayback = () => {
      if (stopHandler) player.removeEventListener("timeupdate", stopHandler);
      stopHandler = null;
      evidencePlayback = false;
      playButton.textContent = "播放证据片段";
    };

    const finishEvidencePlayback = () => {
      stopEvidencePlayback();
      player.pause();
      rangeIndex = ranges.length - 1;
      player.currentTime = ranges[rangeIndex].end;
      progress.value = totalEvidenceDuration.toFixed(2);
      currentLabel.textContent = formatTime(player.currentTime);
      playButton.textContent = "重新播放证据";
    };

    const beginEvidencePlayback = async () => {
      stopEvidencePlayback();
      if (progress.value >= totalEvidenceDuration) progress.value = "0";
      seekTimeline(progress.value);
      evidencePlayback = true;
      playButton.textContent = "暂停播放";
      stopHandler = () => {
        const currentRange = ranges[rangeIndex];
        if (currentRange.end !== null && player.currentTime >= currentRange.end) {
          if (rangeIndex < ranges.length - 1) {
            rangeIndex += 1;
            player.currentTime = ranges[rangeIndex].start;
            updateTimeline();
          } else {
            finishEvidencePlayback();
          }
        } else {
          updateTimeline();
        }
      };
      player.addEventListener("timeupdate", stopHandler);
      try {
        await player.play();
      } catch {
        stopEvidencePlayback();
        showToast("证据音频无法加载或浏览器阻止自动播放");
      }
    };

    player.addEventListener("pause", () => {
      if (evidencePlayback) stopEvidencePlayback();
    });
    const initializeEvidencePosition = () => {
      rangeIndex = 0;
      player.currentTime = ranges[0].start;
      updateTimeline();
    };
    player.addEventListener("loadedmetadata", initializeEvidencePosition, { once: true });
    player.addEventListener("timeupdate", updateTimeline);
    progress.addEventListener("input", (event) => seekTimeline(event.target.value));
    playButton.addEventListener("click", () => {
      if (evidencePlayback) {
        player.pause();
      } else {
        beginEvidencePlayback();
      }
    });
    if (player.readyState >= 1) initializeEvidencePosition();
  }
}

function selectMinute(id) {
  state.selectedId = id;
  const item = state.minutes.find((entry) => entry.id === id);
  renderMinutes();
  renderTranscript();
  renderEvidence(item);
  document.querySelector(".evidence-dock")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setView(view) {
  state.currentView = view;
  const workspaceView = view === "overview" || view === "transcript" || view === "minutes" ? "overview" : view;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === workspaceView));
  $$('[data-panel]').forEach((panel) => panel.classList.toggle("hidden-panel", panel.dataset.panel !== view));
  if (view === "transcript") renderFullTranscript();
}

function updateFileSummary(name, detail) {
  $("#fileName").textContent = name;
  $("#fileDetail").textContent = detail;
}

async function loadPayload(payload) {
  state.transcript = payload.asr.sentences || [];
  state.minutes = payload.minutes.items || [];
  state.audioUrl = payload.audioUrl || "";
  state.selectedId = state.minutes[0]?.id || null;
  state.filter = "全部";
  renderMetrics(payload.asr, state.minutes);
  renderTranscript();
  renderMinutes();
  renderReviewTable();
  renderEvidence(state.minutes[0]);
  updateFileSummary(payload.audioName || "clip01.wav", `${formatDuration(payload.asr.duration)} · ${state.transcript.length} 句 · ${state.minutes.length} 条纪要`);
}

async function loadDemo() {
  const response = await fetch("/api/demo");
  if (!response.ok) throw new Error("演示数据加载失败");
  return response.json();
}

async function analyzeSelectedFile(file) {
  const response = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: file });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "分析失败");
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

async function boot() {
  const payload = await loadDemo();
  await loadPayload(payload);
}

$("#filterRow").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  $$(".filter-button").forEach((item) => item.classList.toggle("active", item === button));
  renderMinutes();
});

$("#minutesList").addEventListener("click", (event) => {
  const item = event.target.closest("[data-minute-id]");
  if (item) selectMinute(item.dataset.minuteId);
});

$("#transcriptSearch").addEventListener("input", (event) => renderFullTranscript(event.target.value));

$("#showAllTranscript").addEventListener("click", () => setView("transcript"));
$("#exportButton").addEventListener("click", () => showToast("Markdown 结果已生成，可查看 results/demo/minutes.md"));
$$('[data-back-to-overview]').forEach((button) => button.addEventListener("click", () => setView("overview")));

$("#audioInput").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) updateFileSummary(file.name, `${(file.size / 1024 / 1024).toFixed(1)} MB · 等待分析`);
});

$("#analyzeButton").addEventListener("click", async () => {
  const file = $("#audioInput").files?.[0];
  const button = $("#analyzeButton");
  button.disabled = true;
  button.textContent = "分析中…";
  $("#transcriptStatus").textContent = "处理中";
  try {
    const payload = file ? await analyzeSelectedFile(file) : await loadDemo();
    await loadPayload(payload);
    showToast(file ? "本地录音分析完成" : "演示数据已刷新");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "开始分析";
    $("#transcriptStatus").textContent = "已加载";
  }
});

$("#resetButton").addEventListener("click", async () => {
  await boot();
  setView("overview");
  showToast("已恢复 clip01 演示数据");
});

$$('[data-view]').forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));

boot().catch((error) => showToast(error.message));
