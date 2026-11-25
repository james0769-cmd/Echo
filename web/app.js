const state = {
  appView: "home", // "home" | "workspace"
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
  groupMode: "topic", // "topic" | "time"
  collapsedTopics: new Set(),
  transcriptFilter: "all", // "all" | "evidence" | "corrected"
  transcriptQuery: "",
  editingSentenceIdx: null,
  editingMinuteId: null, // null when creating, string id when editing
  playMode: "evidence", // "evidence" | "full"
  activeSpanIndex: 0,
  playingSentenceIdx: -1,
  autoFollow: true,
  pendingAudioSeek: null,
  selectedUploadFile: null,
  homeFilter: "all", // "all" | "dev" | "test" | "edited"
  homeQuery: "",
  homeUploadFile: null,
  taskSources: new Set(),
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]
  ));
}

function formatTime(seconds, roundUp = false) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "--:--";
  const val = Math.max(0, Number(seconds));
  const total = roundUp ? Math.ceil(val) : Math.floor(val);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function formatSentenceId(idx) {
  return `S${String(idx + 1).padStart(3, "0")}`;
}

function getMinuteSpans(item) {
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

function recomputeMappings() {
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

function getSelectedMinute() {
  return state.minutes.find((item) => item.id === state.selectedMinuteId) || null;
}

function isUnknownValue(value) {
  const v = String(value ?? "").trim();
  return !v || v === "未知" || v === "未定";
}

function renderTopbar() {
  const sessionInfo = state.sessions.find((s) => s.id === state.sessionId);
  $("#currentSessionBadge").textContent = sessionInfo?.kind === "live" ? "本地上传" : state.sessionId.toUpperCase();
  $("#currentSessionTitle").textContent = sessionInfo?.title || state.audioName;

  const duration = Number(state.asr.duration || 0);
  const totalMinutes = state.minutes.length;
  const verifiedCount = state.minutes.filter((item) => Boolean(item.verified)).length;
  const flaggedCount = state.minutes.filter((item) => Array.isArray(item.flags) && item.flags.length > 0).length;
  const evidenceBound = state.minutes.filter((item) => getMinuteSpans(item).length > 0).length;

  const pills = [
    `<span class="stat-pill">${formatTime(duration)}</span>`,
    `<span class="stat-pill">${state.transcript.length} 句转写</span>`,
    `<span class="stat-pill">${evidenceBound}/${totalMinutes} 有证据</span>`,
    `<span class="stat-pill ${verifiedCount === totalMinutes && totalMinutes > 0 ? "is-safe" : "is-accent"}">已核对 ${verifiedCount}/${totalMinutes}</span>`,
  ];
  if (flaggedCount > 0) {
    pills.push(`<span class="stat-pill">${flaggedCount} 条防幻觉拦截</span>`);
  }
  $("#sessionStatsPills").innerHTML = pills.join("");
  $("#resetEditsBtn").classList.toggle("hidden", state.appView !== "workspace" || !state.hasEdits);
}

function renderHome() {
  const totalSessions = state.sessions.length;
  const totalItems = state.sessions.reduce((sum, s) => sum + Number(s.itemCount || 0), 0);
  const totalVerified = state.sessions.reduce((sum, s) => sum + Number(s.verifiedCount || 0), 0);
  $("#heroLibraryStats").textContent = `${totalSessions} 段会议录音 · ${totalItems} 条可回溯纪要 · ${totalVerified} 条已核对`;

  const demoSession = state.sessions.find((s) => s.id === state.sessionId) || state.sessions[0];
  if (demoSession) {
    const label = demoSession.kind === "live" ? demoSession.audioName : demoSession.id.toUpperCase();
    $("#heroStartDemoBtn").textContent = `▶ 立即进入示例会议核对 (${label})`;
    $("#enterLastSessionBtn").textContent = `进入工作台 (${label})`;
  }

  const query = state.homeQuery.trim().toLowerCase();
  const filtered = state.sessions.filter((s) => {
    if (state.homeFilter === "pending" && !(s.itemCount > 0 && s.verifiedCount < s.itemCount)) return false;
    if (state.homeFilter === "reviewed" && !s.hasEdits && !s.verifiedCount) return false;
    if (query) {
      const hay = [
        s.id,
        s.audioName,
        s.title,
        (s.topics || []).join(" "),
        s.previewText || "",
      ].join(" ").toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  const grid = $("#homeSessionGrid");
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state">没有找到匹配的会议录音，请更换搜索词或筛选条件</div>`;
    return;
  }

  grid.innerHTML = filtered.map((s) => {
    const idLabel = s.kind === "live" ? "本地导入" : s.id.toUpperCase();
    const kindLabel = s.kind === "live" ? s.audioName : "示例会议";
    const kindClass = s.kind === "live" ? "is-live" : "";
    const topics = s.topics || [];
    const visibleTopics = topics.slice(0, 3).map((t) => `<span class="card-topic-chip">${escapeHtml(t)}</span>`).join("");
    const extraTopics = topics.length > 3 ? `<span class="card-topic-chip">+${topics.length - 3}</span>` : "";

    const tc = s.typeCounts || {};
    const typeChips = [
      tc["决定"] ? `<span class="card-type-chip is-decision">决定 ${tc["决定"]}</span>` : "",
      tc["待办"] ? `<span class="card-type-chip is-todo">待办 ${tc["待办"]}</span>` : "",
      tc["待确认"] ? `<span class="card-type-chip is-pending">待确认 ${tc["待确认"]}</span>` : "",
      `<span class="card-type-chip is-neutral">${s.sentenceCount} 句转写</span>`,
      s.flaggedCount ? `<span class="card-type-chip is-pending">🛡 ${s.flaggedCount} 条拦截</span>` : "",
    ].filter(Boolean).join("");

    const pct = s.itemCount ? Math.round((s.verifiedCount / s.itemCount) * 100) : 0;
    const verifyText = s.itemCount
      ? `已核对 ${s.verifiedCount}/${s.itemCount}${s.hasEdits ? " · 含校对" : ""}`
      : (s.hasEdits ? "含人工校对" : "0 条纪要");

    return `
      <article class="home-session-card" data-open-session="${escapeHtml(s.id)}" tabindex="0" role="button">
        <div class="card-top-row">
          <div class="card-badges">
            <span class="card-id-pill">${escapeHtml(idLabel)}</span>
            <span class="card-split-pill ${kindClass}">${escapeHtml(kindLabel)}</span>
          </div>
          <span class="card-duration">⏱ ${formatTime(s.duration)}${s.audioUrl ? "" : " · 无音频"}</span>
        </div>

        <h3 class="card-title">${escapeHtml(s.title)}</h3>
        ${(visibleTopics || extraTopics) ? `<div class="card-topics">${visibleTopics}${extraTopics}</div>` : ""}
        <p class="card-preview">${escapeHtml(s.previewText || "暂无内容预览")}</p>

        <div class="card-metrics-row">${typeChips}</div>

        <div class="card-footer-row">
          <div class="card-verify-wrap">
            <div class="card-verify-bar"><div class="card-verify-fill" style="width:${pct}%"></div></div>
            <span class="card-verify-text">${verifyText}</span>
          </div>
          <span class="card-enter-link">进入核对 →</span>
        </div>
      </article>
    `;
  }).join("");
}

async function setAppView(view, sessionId = null, { pushHash = true } = {}) {
  const isWorkspace = view === "workspace";
  if (isWorkspace && sessionId && sessionId !== state.sessionId) {
    await switchSession(sessionId);
  }

  state.appView = isWorkspace ? "workspace" : "home";
  if (!isWorkspace) {
    $("#audioPlayer")?.pause();
  }

  $("#homeView").classList.toggle("hidden", isWorkspace);
  $("#workspaceBody").classList.toggle("hidden", !isWorkspace);
  $("#playerDock").classList.toggle("hidden", !isWorkspace);

  $("#backToHomeBtn").classList.toggle("hidden", !isWorkspace);
  $("#toggleSidebarBtn").classList.toggle("hidden", !isWorkspace);
  $("#topbarWorkspaceCenter").classList.toggle("hidden", !isWorkspace);
  $("#enterLastSessionBtn").classList.toggle("hidden", isWorkspace);
  $("#addMinuteBtn").classList.toggle("hidden", !isWorkspace);
  $("#copyMarkdownBtn").classList.toggle("hidden", !isWorkspace);
  $("#downloadMarkdownBtn").classList.toggle("hidden", !isWorkspace);
  $("#downloadWordBtn").classList.toggle("hidden", !isWorkspace);

  renderTopbar();
  if (!isWorkspace) {
    renderHome();
    if (pushHash && window.location.hash !== "#home") {
      window.location.hash = "#home";
    }
  } else {
    const targetHash = `#session/${state.sessionId}`;
    if (pushHash && window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
  }
}

async function openSessionWorkspace(id) {
  await setAppView("workspace", id, { pushHash: true });
}

function renderSidebar() {
  const container = $("#sessionList");
  if (!state.sessions.length) {
    container.innerHTML = `<div class="empty-state">暂无可用录音</div>`;
    return;
  }

  const liveSessions = state.sessions.filter((s) => s.kind === "live");
  const sampleSessions = state.sessions.filter((s) => s.kind !== "live");

  const renderGroup = (label, items) => {
    if (!items.length) return "";
    return `
      <div class="session-group-label"><span>${label}</span><span>${items.length}</span></div>
      ${items.map((s) => {
        const active = s.id === state.sessionId ? "active" : "";
        const idLabel = s.kind === "live" ? s.audioName : s.id.toUpperCase();
        const verifiedText = s.itemCount ? `${s.verifiedCount}/${s.itemCount} 已核` : "0 条";
        return `
          <button class="session-item ${active}" data-session-id="${escapeHtml(s.id)}" type="button">
            <div class="session-item-top">
              <span class="session-item-id">${s.hasEdits ? '<span class="edited-dot" title="含人工校对"></span>' : ""}${escapeHtml(idLabel)}</span>
              <span class="session-item-meta">${formatTime(s.duration)}</span>
            </div>
            <div class="session-item-title">${escapeHtml(s.title)}</div>
            <div class="session-item-sub">
              <span>${s.itemCount} 条纪要</span>
              <span>${verifiedText}</span>
            </div>
          </button>
        `;
      }).join("")}
    `;
  };

  container.innerHTML = [
    renderGroup("最近导入录音", liveSessions),
    renderGroup("会议录音列表", sampleSessions),
  ].join("");
}

function highlightQueryText(text, query) {
  const safe = escapeHtml(text);
  const trimmed = query.trim();
  if (!trimmed) return safe;
  const escapedQuery = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safe.replace(new RegExp(`(${escapedQuery})`, "gi"), "<mark>$1</mark>");
}

function renderTranscript() {
  const selectedItem = getSelectedMinute();
  const evidenceSet = new Set(selectedItem?.matchedSentenceIndices || []);
  const query = state.transcriptQuery.trim().toLowerCase();

  const filtered = state.transcript.filter((sentence) => {
    if (state.transcriptFilter === "evidence" && !sentence.citedBy.length) return false;
    if (state.transcriptFilter === "corrected" && !sentence.corrected) return false;
    if (query) {
      const timeStr = `${formatTime(sentence.start)}-${formatTime(sentence.end)}`;
      const matchText = sentence.text.toLowerCase().includes(query);
      const matchTime = timeStr.includes(query);
      const matchId = sentence.rawId.toLowerCase().includes(query);
      if (!matchText && !matchTime && !matchId) return false;
    }
    return true;
  });

  $("#transcriptCountLabel").textContent = filtered.length === state.transcript.length
    ? `${state.transcript.length} 句`
    : `${filtered.length} / ${state.transcript.length} 句`;

  if (!filtered.length) {
    $("#transcriptList").innerHTML = `<div class="empty-state">没有符合条件的转写句子</div>`;
    return;
  }

  $("#transcriptList").innerHTML = filtered.map((sentence) => {
    const isEvidence = evidenceSet.has(sentence.index);
    const isPlaying = state.playingSentenceIdx === sentence.index;
    const isEditing = state.editingSentenceIdx === sentence.index;
    const rowClasses = [
      "transcript-row",
      isEvidence ? "is-evidence" : "",
      isPlaying ? "is-playing" : "",
      isEditing ? "is-editing" : "",
    ].filter(Boolean).join(" ");

    const citeBadges = sentence.citedBy.map((mid) => {
      const active = mid === state.selectedMinuteId ? "is-active" : "";
      return `<button class="cite-chip ${active}" data-cite-minute="${escapeHtml(mid)}" type="button">#${escapeHtml(mid)}</button>`;
    }).join("");

    const correctedBadge = sentence.corrected ? `<span class="corrected-tag">已人工校对</span>` : "";

    const bodyHtml = isEditing
      ? `
        <div class="inline-editor">
          <textarea rows="2" id="inlineSentenceTextarea">${escapeHtml(sentence.text)}</textarea>
          <div class="inline-editor-actions">
            <button class="btn btn-secondary" data-cancel-sentence type="button">取消</button>
            <button class="btn btn-primary" data-save-sentence="${sentence.index}" type="button">保存校对</button>
          </div>
        </div>
      `
      : `
        <div class="transcript-text" data-dblclick-edit="${sentence.index}" title="双击也可进入校对">${highlightQueryText(sentence.text, state.transcriptQuery)}</div>
        ${(citeBadges || correctedBadge) ? `<div class="transcript-badges">${correctedBadge}${citeBadges}</div>` : ""}
      `;

    return `
      <div class="${rowClasses}" data-sentence-index="${sentence.index}">
        <div class="transcript-row-time">
          <button class="time-jump-btn" data-jump-time="${sentence.start}" type="button" title="点击从此句播放">
            <span>▶</span>
            <span>${formatTime(sentence.start)}</span>
          </button>
          <span class="sent-id-label">${sentence.rawId}</span>
        </div>
        <div class="transcript-row-body">${bodyHtml}</div>
        <div class="transcript-row-actions">
          ${isEditing ? "" : `<button class="row-edit-btn" data-edit-sentence="${sentence.index}" type="button">校对</button>`}
        </div>
      </div>
    `;
  }).join("");
}

function renderFilterCounts() {
  const counts = {
    全部: state.minutes.length,
    决定: state.minutes.filter((m) => m.type === "决定").length,
    待办: state.minutes.filter((m) => m.type === "待办").length,
    待确认: state.minutes.filter((m) => m.type === "待确认").length,
    待核对: state.minutes.filter((m) => !m.verified).length,
  };
  $$("#filterRow .filter-tab").forEach((btn) => {
    const filter = btn.dataset.filter;
    btn.classList.toggle("active", filter === state.minuteFilter);
    btn.innerHTML = `${escapeHtml(filter)} <span class="tab-count">${counts[filter] ?? 0}</span>`;
  });
}

function renderMinuteCard(item, showInlineTopic) {
  const isSelected = item.id === state.selectedMinuteId;
  const isVerified = Boolean(item.verified);
  const spans = item._spans || getMinuteSpans(item);

  const respUnknown = isUnknownValue(item.responsible);
  const dlUnknown = isUnknownValue(item.deadline);

  const spanChipsHtml = spans.length
    ? spans.map((span, sIdx) => `
      <button
        class="span-play-chip"
        data-play-minute="${escapeHtml(item.id)}"
        data-span-index="${sIdx}"
        type="button"
        title="点击立即回听此段原话"
      >
        <span>▶</span>
        <span>${formatTime(span.start)}–${formatTime(span.end, true)}</span>
      </button>
    `).join("")
    : `<span class="field-pill is-unknown">无关联时间段</span>`;

  const flagsHtml = Array.isArray(item.flags) && item.flags.length
    ? `<div class="guard-banner">🛡 防幻觉拦截：${item.flags.map(escapeHtml).join("；")}</div>`
    : "";

  const evidenceBoxHtml = item.evidence_text
    ? `<div class="minute-evidence-box">${escapeHtml(item.evidence_text)}</div>`
    : "";

  return `
    <article class="minute-card ${isSelected ? "is-selected" : ""} ${isVerified ? "is-verified" : ""}" data-minute-id="${escapeHtml(item.id)}">
      <div class="minute-card-top">
        <div class="minute-card-tags">
          <span class="type-badge type-${escapeHtml(item.type)}">${escapeHtml(item.type)}</span>
          <span class="minute-id">#${escapeHtml(item.id)}</span>
          ${showInlineTopic ? `<span class="minute-topic-inline">${escapeHtml(item.topic || "未分类议题")}</span>` : ""}
        </div>
        <div class="minute-card-actions">
          ${item.type === "待办" ? (state.taskSources.has(taskSourceKey(state.sessionId, item.id))
            ? '<a class="card-action-btn task-card-action" href="/tasks.html">已加入看板</a>'
            : '<button class="card-action-btn task-card-action" data-add-task="' + escapeHtml(item.id) + '" type="button">加入看板</button>') : ""}
          <button class="card-action-btn" data-edit-minute="${escapeHtml(item.id)}" type="button">编辑</button>
          <button class="card-action-btn verify-btn ${isVerified ? "is-verified" : ""}" data-verify-minute="${escapeHtml(item.id)}" type="button">
            ${isVerified ? "✓ 已核对" : "标记核对"}
          </button>
        </div>
      </div>

      <div class="minute-content">${escapeHtml(item.content)}</div>

      <div class="minute-fields">
        <span class="field-pill ${respUnknown ? "is-unknown" : ""}">
          <strong>负责人</strong> ${respUnknown ? "未知（原话未指明）" : escapeHtml(item.responsible)}
        </span>
        <span class="field-pill ${dlUnknown ? "is-unknown" : ""}">
          <strong>截止</strong> ${dlUnknown ? "未知（原话未指明）" : escapeHtml(item.deadline)}
        </span>
      </div>

      <div class="evidence-chips">${spanChipsHtml}</div>
      ${evidenceBoxHtml}
      ${flagsHtml}
    </article>
  `;
}

function renderMinutes() {
  renderFilterCounts();

  const visible = state.minutes.filter((item) => {
    if (state.minuteFilter === "全部") return true;
    if (state.minuteFilter === "待核对") return !item.verified;
    return item.type === state.minuteFilter;
  });

  $("#minutesCountLabel").textContent = visible.length === state.minutes.length
    ? `${state.minutes.length} 条`
    : `${visible.length} / ${state.minutes.length} 条`;

  const container = $("#minutesList");
  if (!visible.length) {
    container.innerHTML = `<div class="empty-state">${state.minutes.length ? "当前筛选下没有纪要条目" : "本段录音未抽取到可记录的决定、待办或待确认事项"}</div>`;
    return;
  }

  if (state.groupMode === "time") {
    const sorted = [...visible].sort((a, b) => (a.evidence_start ?? Infinity) - (b.evidence_start ?? Infinity));
    container.innerHTML = `<div class="topic-cards">${sorted.map((item) => renderMinuteCard(item, true)).join("")}</div>`;
    return;
  }

  // Group by topic preserving first appearance order
  const groups = [];
  const topicMap = new Map();
  visible.forEach((item) => {
    const topic = String(item.topic || "未分类议题").trim();
    if (!topicMap.has(topic)) {
      const group = { topic, items: [] };
      topicMap.set(topic, group);
      groups.push(group);
    }
    topicMap.get(topic).items.push(item);
  });

  container.innerHTML = groups.map((group) => {
    const isCollapsed = state.collapsedTopics.has(group.topic);
    return `
      <section class="topic-group ${isCollapsed ? "collapsed" : ""}" data-topic="${escapeHtml(group.topic)}">
        <div class="topic-group-header" data-toggle-topic="${escapeHtml(group.topic)}">
          <div class="topic-group-title">
            <svg class="topic-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>${escapeHtml(group.topic)}</span>
            <span class="topic-count">${group.items.length}</span>
          </div>
        </div>
        <div class="topic-cards">
          ${group.items.map((item) => renderMinuteCard(item, false)).join("")}
        </div>
      </section>
    `;
  }).join("");
}

function getEffectiveDuration() {
  const player = $("#audioPlayer");
  if (Number.isFinite(player.duration) && player.duration > 0) return player.duration;
  return Number(state.asr.duration || 0);
}

function renderEvidenceMarkersOnTimeline() {
  const layer = $("#timelineEvidenceLayer");
  const total = getEffectiveDuration();
  const item = getSelectedMinute();
  if (!item || !total) {
    layer.innerHTML = "";
    return;
  }
  const spans = item._spans || getMinuteSpans(item);
  layer.innerHTML = spans.map((span) => {
    const leftPct = Math.max(0, Math.min(100, (span.start / total) * 100));
    const widthPct = Math.max(0.6, Math.min(100 - leftPct, ((span.end - span.start) / total) * 100));
    return `<div class="timeline-evidence-marker" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;"></div>`;
  }).join("");
}

function updatePlayerMeta() {
  const player = $("#audioPlayer");
  const hasAudio = Boolean(state.audioUrl);
  $("#playPauseBtn").disabled = !hasAudio;
  $("#stepBackBtn").disabled = !hasAudio;
  $("#stepForwardBtn").disabled = !hasAudio;
  $("#timelineSlider").disabled = !hasAudio;

  const isPlaying = hasAudio && !player.paused && !player.ended;
  $("#playIcon").classList.toggle("hidden", isPlaying);
  $("#pauseIcon").classList.toggle("hidden", !isPlaying);

  const modeBtn = $("#playModeBtn");
  if (state.playMode === "evidence") {
    modeBtn.textContent = "证据精听";
    modeBtn.classList.remove("is-full");
  } else {
    modeBtn.textContent = "全场连播";
    modeBtn.classList.add("is-full");
  }

  const item = getSelectedMinute();
  const badge = $("#activeEvidenceBadge");
  const subtitle = $("#activeSubtitle");

  if (!hasAudio) {
    badge.textContent = "无本地音频";
    subtitle.textContent = "未找到本地音频，仍可核对转写与时间段。可通过右上角导入录音";
  } else if (item) {
    const spans = item._spans || [];
    const spanText = spans.length
      ? `${formatTime(spans[0].start)}–${formatTime(spans[spans.length - 1].end, true)}`
      : "无时间段";
    badge.textContent = `#${item.id} · ${spanText}`;
    if (state.playingSentenceIdx >= 0 && state.transcript[state.playingSentenceIdx]) {
      subtitle.textContent = state.transcript[state.playingSentenceIdx].text;
    } else {
      subtitle.textContent = item.evidence_text || item.content;
    }
  } else {
    badge.textContent = "未选择纪要";
    subtitle.textContent = "点击任意纪要卡片或时间芯片回听原话";
  }

  renderEvidenceMarkersOnTimeline();
}

function updateTimelineUI() {
  const player = $("#audioPlayer");
  const total = getEffectiveDuration();
  const current = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  const slider = $("#timelineSlider");
  slider.max = total > 0 ? total.toFixed(2) : "100";
  slider.value = Math.min(total || 0, current).toFixed(2);
  const pct = total > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : 0;
  $("#timelineProgressFill").style.width = `${pct.toFixed(2)}%`;
  $("#currentTimeLabel").textContent = formatTime(current);
  $("#totalTimeLabel").textContent = formatTime(total);
}

function setupAudioSource(audioUrl) {
  const player = $("#audioPlayer");
  player.pause();
  state.playingSentenceIdx = -1;
  state.pendingAudioSeek = null;

  if (audioUrl) {
    const currentSrc = player.getAttribute("src");
    if (currentSrc !== audioUrl) {
      player.setAttribute("src", audioUrl);
      player.load();
    } else {
      player.currentTime = 0;
    }
    player.playbackRate = Number($("#speedSelect").value || 1);
  } else {
    player.removeAttribute("src");
    player.load();
  }
  updateTimelineUI();
  updatePlayerMeta();
}

function seekAudioTo(seconds) {
  const player = $("#audioPlayer");
  if (!state.audioUrl) return;
  const target = Math.max(0, Math.min(getEffectiveDuration() || seconds, Number(seconds)));
  if (player.readyState >= 1) {
    player.currentTime = target;
    updateTimelineUI();
  } else {
    state.pendingAudioSeek = target;
  }
}

async function startPlaybackAt(seconds, mode = state.playMode) {
  const player = $("#audioPlayer");
  if (!state.audioUrl) {
    showToast("当前会话缺少本地音频文件");
    return;
  }
  state.playMode = mode;
  seekAudioTo(seconds);
  updatePlayerMeta();
  try {
    await player.play();
    updatePlayerMeta();
  } catch {
    showToast("浏览器阻止了音频播放，请手动点击播放按钮");
  }
}

function selectMinute(id, { autoPlay = false, scrollTranscript = true, spanIndex = 0 } = {}) {
  state.selectedMinuteId = id;
  state.activeSpanIndex = spanIndex;
  const item = getSelectedMinute();
  renderMinutes();
  renderTranscript();

  if (scrollTranscript && item && item.matchedSentenceIndices?.length) {
    const firstIdx = item.matchedSentenceIndices[0];
    const row = document.querySelector(`.transcript-row[data-sentence-index="${firstIdx}"]`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const spans = item?._spans || [];
  if (spans.length && state.audioUrl) {
    const targetSpan = spans[Math.min(spanIndex, spans.length - 1)];
    if (autoPlay) {
      startPlaybackAt(targetSpan.start, "evidence");
    } else {
      if ($("#audioPlayer").paused) {
        seekAudioTo(targetSpan.start);
      }
      updatePlayerMeta();
    }
  } else {
    updatePlayerMeta();
  }
}

function applySessionPayload(payload) {
  state.sessionId = payload.id || "clip01";
  state.audioName = payload.audioName || `${state.sessionId}.wav`;
  state.audioUrl = payload.audioUrl || null;
  state.hasEdits = Boolean(payload.hasEdits);
  state.asr = payload.asr || { duration: 0, rtf: 0, sentences: [] };
  state.minutesMeta = payload.minutes || {};
  state.transcript = (state.asr.sentences || []).map((s) => ({ ...s }));
  state.minutes = (state.minutesMeta.items || []).map((m) => ({ ...m }));
  state.editingSentenceIdx = null;
  state.collapsedTopics.clear();

  recomputeMappings();
  state.selectedMinuteId = state.minutes[0]?.id || null;
  state.activeSpanIndex = 0;

  renderSidebar();
  renderTopbar();
  renderMinutes();
  renderTranscript();
  setupAudioSource(state.audioUrl);

  const firstSpans = state.minutes[0]?._spans || [];
  if (firstSpans.length && state.audioUrl) {
    seekAudioTo(firstSpans[0].start);
  }
}

async function refreshSessionList() {
  const res = await fetch("/api/sessions");
  if (!res.ok) return;
  const data = await res.json();
  state.sessions = data.sessions || [];
  renderSidebar();
  renderTopbar();
  if (state.appView === "home") renderHome();
}

async function switchSession(id) {
  const res = await fetch(`/api/session?id=${encodeURIComponent(id)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "加载会话失败");
  await refreshSessionList();
  applySessionPayload(data);
}

async function persistEdits() {
  const cleanMinutes = state.minutes.map(({ _spans, matchedSentenceIndices, ...rest }) => rest);
  const cleanTranscript = state.transcript.map(({ index, rawId, citedBy, ...rest }) => rest);

  const res = await fetch("/api/session/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: state.sessionId,
      minutes: cleanMinutes,
      transcript: cleanTranscript,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "保存失败");
  state.hasEdits = true;
  await refreshSessionList();
  renderTopbar();
}

function buildMarkdownReport() {
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
      lines.push(`  - 负责人：${item.responsible || "未知"}｜截止：${item.deadline || "未知"}｜时间：\`${timeStr}\``);
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

function parseEvidenceIdsInput(text) {
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

function buildEvidenceFromIndices(indices) {
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

function updateEditEvidencePreview() {
  const raw = $("#editEvidenceIdsInput").value;
  const indices = parseEvidenceIdsInput(raw);
  const previewEl = $("#editEvidencePreview");
  if (!raw.trim()) {
    previewEl.textContent = "未填写句子编号时，将保留原有时间段（新增条目则无时间段）。";
    return;
  }
  if (!indices.length) {
    previewEl.textContent = "未匹配到有效的句子编号（请使用 S001, S002 格式）。";
    return;
  }
  const built = buildEvidenceFromIndices(indices);
  previewEl.textContent = `已匹配 ${indices.length} 句（${formatTime(built.evidence_start)}–${formatTime(built.evidence_end, true)}）：${built.evidence_text.slice(0, 90)}${built.evidence_text.length > 90 ? "…" : ""}`;
}

function openEditMinuteModal(minuteId = null) {
  state.editingMinuteId = minuteId;
  const item = minuteId ? state.minutes.find((m) => m.id === minuteId) : null;
  $("#editMinuteModalTitle").textContent = item ? `编辑纪要 · #${item.id}` : "新增纪要条目";
  $("#deleteMinuteBtn").classList.toggle("hidden", !item);

  $("#editTopicInput").value = item?.topic || "";
  $("#editTypeSelect").value = item?.type || "待办";
  $("#editContentInput").value = item?.content || "";
  $("#editResponsibleInput").value = item?.responsible || "未知";
  $("#editDeadlineInput").value = item?.deadline || "未知";

  const matchedIds = item?.matchedSentenceIndices?.length
    ? item.matchedSentenceIndices.map((idx) => formatSentenceId(idx)).join(", ")
    : (item?.evidence_ids || []).join(", ");
  $("#editEvidenceIdsInput").value = matchedIds;
  updateEditEvidencePreview();

  $("#editMinuteModal").classList.remove("hidden");
  $("#editTopicInput").focus();
}

function openModal(id) {
  $(`#${id}`).classList.remove("hidden");
}

function closeModal(id) {
  $(`#${id}`).classList.add("hidden");
}

function parseHashRoute() {
  const match = /^#session\/(live|clip0[1-5]|record-[a-f0-9-]{36})(?:\/minute\/(m(?:\d+|-[a-f0-9-]{36})))?$/.exec(window.location.hash);
  return match ? { sessionId: match[1], minuteId: match[2] } : {};
}

async function followHashRoute() {
  const { sessionId, minuteId } = parseHashRoute();
  await setAppView(sessionId ? "workspace" : "home", sessionId, { pushHash: false });
  if (!minuteId) return;
  if (!state.minutes.some((item) => item.id === minuteId)) {
    showToast("来源纪要已删除，可在这次会议中查看其余内容");
    return;
  }
  state.minuteFilter = "全部";
  state.collapsedTopics.clear();
  selectMinute(minuteId);
  const card = document.querySelector('.minute-card[data-minute-id="' + minuteId + '"]');
  card?.scrollIntoView({ block: "nearest" });
}

function taskSourceKey(sessionId, minuteId) {
  return sessionId + "/" + minuteId;
}

async function refreshTaskSources() {
  const res = await fetch("/api/tasks");
  if (!res.ok) return;
  const { tasks } = await res.json();
  state.taskSources = new Set(tasks.map((task) => taskSourceKey(task.sessionId, task.minuteId)));
  if (state.appView === "workspace") renderMinutes();
}

async function boot() {
  if (window.innerWidth <= 960) {
    $("#sessionSidebar").classList.add("collapsed");
  }
  const res = await fetch("/api/demo");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "初始化加载失败");
  state.sessions = data.sessions || [];
  applySessionPayload(data);
  await followHashRoute();
  refreshTaskSources().catch(() => {});
}

/* ==================== Event Listeners ==================== */

window.addEventListener("hashchange", () => {
  followHashRoute().catch((err) => showToast(err.message));
});

// Topbar & Home navigation
$("#backToHomeBtn").addEventListener("click", () => {
  setAppView("home");
});

$("#brandHomeLink").addEventListener("click", () => {
  setAppView("home");
});

$("#brandHomeLink").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setAppView("home");
  }
});

$("#enterLastSessionBtn").addEventListener("click", () => {
  openSessionWorkspace(state.sessionId).catch((err) => showToast(err.message));
});

$("#heroStartDemoBtn").addEventListener("click", () => {
  const targetId = state.sessions.find((s) => s.id === state.sessionId)?.id || state.sessions[0]?.id || "clip01";
  openSessionWorkspace(targetId).catch((err) => showToast(err.message));
});

$("#homeSearchInput").addEventListener("input", (event) => {
  state.homeQuery = event.target.value;
  renderHome();
});

$("#homeFilterTabs").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-home-filter]");
  if (!btn) return;
  state.homeFilter = btn.dataset.homeFilter;
  $$("#homeFilterTabs .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  renderHome();
});

$("#homeSessionGrid").addEventListener("click", (event) => {
  const card = event.target.closest("[data-open-session]");
  if (!card) return;
  openSessionWorkspace(card.dataset.openSession).catch((err) => showToast(err.message));
});

$("#homeSessionGrid").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest("[data-open-session]");
  if (!card) return;
  event.preventDefault();
  openSessionWorkspace(card.dataset.openSession).catch((err) => showToast(err.message));
});

// Sidebar toggle & session switching
$("#toggleSidebarBtn").addEventListener("click", () => {
  $("#sessionSidebar").classList.toggle("collapsed");
});

$("#sessionList").addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-session-id]");
  if (!btn) return;
  const id = btn.dataset.sessionId;
  if (window.innerWidth <= 960) {
    $("#sessionSidebar").classList.add("collapsed");
  }
  if (id === state.sessionId) return;
  try {
    await openSessionWorkspace(id);
  } catch (err) {
    showToast(err.message);
  }
});

// Transcript search & filters
$("#transcriptSearch").addEventListener("input", (event) => {
  state.transcriptQuery = event.target.value;
  renderTranscript();
});

$("#transcriptFilterGroup").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-tfilter]");
  if (!btn) return;
  state.transcriptFilter = btn.dataset.tfilter;
  $$("#transcriptFilterGroup .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  renderTranscript();
});

$("#autoFollowToggle").addEventListener("change", (event) => {
  state.autoFollow = event.target.checked;
});

// Transcript row interactions (jump time, click citation, inline edit)
$("#transcriptList").addEventListener("click", async (event) => {
  const jumpBtn = event.target.closest("[data-jump-time]");
  if (jumpBtn) {
    const t = Number(jumpBtn.dataset.jumpTime);
    startPlaybackAt(t, "full");
    return;
  }

  const citeBtn = event.target.closest("[data-cite-minute]");
  if (citeBtn) {
    const mid = citeBtn.dataset.citeMinute;
    selectMinute(mid, { autoPlay: false, scrollTranscript: false });
    const card = document.querySelector(`.minute-card[data-minute-id="${mid}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const editBtn = event.target.closest("[data-edit-sentence]");
  if (editBtn) {
    state.editingSentenceIdx = Number(editBtn.dataset.editSentence);
    renderTranscript();
    $("#inlineSentenceTextarea")?.focus();
    return;
  }

  if (event.target.closest("[data-cancel-sentence]")) {
    state.editingSentenceIdx = null;
    renderTranscript();
    return;
  }

  const saveBtn = event.target.closest("[data-save-sentence]");
  if (saveBtn) {
    const idx = Number(saveBtn.dataset.saveSentence);
    const newText = ($("#inlineSentenceTextarea")?.value || "").trim();
    if (!newText) {
      showToast("句子内容不能为空");
      return;
    }
    const targetSentence = state.transcript[idx];
    if (!targetSentence) return;
    if (!targetSentence.original_text) {
      targetSentence.original_text = targetSentence.text;
    }
    targetSentence.text = newText;
    targetSentence.corrected = true;
    state.editingSentenceIdx = null;

    // Refresh evidence_text on minutes referencing this sentence
    state.minutes.forEach((item) => {
      if (item.matchedSentenceIndices?.includes(idx)) {
        item.evidence_text = item.matchedSentenceIndices.map((i) => state.transcript[i].text).join("；");
      }
    });

    try {
      await persistEdits();
      renderTranscript();
      renderMinutes();
      updatePlayerMeta();
      showToast("转写校对已保存");
    } catch (err) {
      showToast(err.message);
    }
  }
});

$("#transcriptList").addEventListener("dblclick", (event) => {
  const textEl = event.target.closest("[data-dblclick-edit]");
  if (!textEl) return;
  state.editingSentenceIdx = Number(textEl.dataset.dblclickEdit);
  renderTranscript();
  $("#inlineSentenceTextarea")?.focus();
});

// Minutes filters & group mode
$("#filterRow").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-filter]");
  if (!tab) return;
  state.minuteFilter = tab.dataset.filter;
  renderMinutes();
});

$("#groupModeToggle").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-group]");
  if (!btn) return;
  state.groupMode = btn.dataset.group;
  $$("#groupModeToggle .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  renderMinutes();
});

// Minute card actions
$("#minutesList").addEventListener("click", async (event) => {
  const addTask = event.target.closest("[data-add-task]");
  if (addTask) {
    const sessionId = state.sessionId;
    const minuteId = addTask.dataset.addTask;
    addTask.disabled = true;
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, minuteId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "加入待办看板失败");
      state.taskSources.add(taskSourceKey(sessionId, minuteId));
      renderMinutes();
      showToast("已加入会后待办");
    } catch (error) {
      addTask.disabled = false;
      showToast(error.message);
    }
    return;
  }
  if (event.target.closest(".task-card-action")) return;

  const topicToggle = event.target.closest("[data-toggle-topic]");
  if (topicToggle) {
    const topic = topicToggle.dataset.toggleTopic;
    if (state.collapsedTopics.has(topic)) state.collapsedTopics.delete(topic);
    else state.collapsedTopics.add(topic);
    renderMinutes();
    return;
  }

  const verifyBtn = event.target.closest("[data-verify-minute]");
  if (verifyBtn) {
    event.stopPropagation();
    const id = verifyBtn.dataset.verifyMinute;
    const item = state.minutes.find((m) => m.id === id);
    if (!item) return;
    item.verified = !item.verified;
    try {
      await persistEdits();
      renderMinutes();
      showToast(item.verified ? "已标记为核对完成" : "已取消核对标记");
    } catch (err) {
      showToast(err.message);
    }
    return;
  }

  const editBtn = event.target.closest("[data-edit-minute]");
  if (editBtn) {
    event.stopPropagation();
    openEditMinuteModal(editBtn.dataset.editMinute);
    return;
  }

  const spanChip = event.target.closest("[data-play-minute]");
  if (spanChip) {
    event.stopPropagation();
    const id = spanChip.dataset.playMinute;
    const sIdx = Number(spanChip.dataset.spanIndex || 0);
    selectMinute(id, { autoPlay: true, scrollTranscript: true, spanIndex: sIdx });
    return;
  }

  const card = event.target.closest("[data-minute-id]");
  if (card) {
    selectMinute(card.dataset.minuteId, { autoPlay: false, scrollTranscript: true });
  }
});

// Edit / Add / Delete Minute Modal
$("#addMinuteBtn").addEventListener("click", () => openEditMinuteModal(null));
$("#editEvidenceIdsInput").addEventListener("input", updateEditEvidencePreview);

$("#editMinuteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const topic = $("#editTopicInput").value.trim();
  const type = $("#editTypeSelect").value;
  const content = $("#editContentInput").value.trim();
  const responsible = $("#editResponsibleInput").value.trim() || "未知";
  const deadline = $("#editDeadlineInput").value.trim() || "未知";
  const rawIdsText = $("#editEvidenceIdsInput").value.trim();
  const indices = parseEvidenceIdsInput(rawIdsText);

  let targetId = state.editingMinuteId;
  if (targetId) {
    const item = state.minutes.find((m) => m.id === targetId);
    if (!item) return;
    item.topic = topic;
    item.type = type;
    item.content = content;
    item.responsible = responsible;
    item.deadline = deadline;
    if (rawIdsText) {
      Object.assign(item, buildEvidenceFromIndices(indices));
    }
  } else {
    targetId = "m-" + crypto.randomUUID();
    const newItem = {
      id: targetId,
      topic,
      type,
      content,
      responsible,
      deadline,
      raw_responsible: responsible,
      raw_deadline: deadline,
      flags: [],
      verified: true,
      ...buildEvidenceFromIndices(indices),
    };
    state.minutes.push(newItem);
  }

  recomputeMappings();
  try {
    await persistEdits();
    closeModal("editMinuteModal");
    selectMinute(targetId, { autoPlay: false, scrollTranscript: true });
    showToast("纪要已保存");
  } catch (err) {
    showToast(err.message);
  }
});

$("#deleteMinuteBtn").addEventListener("click", async () => {
  if (!state.editingMinuteId) return;
  const deletedId = state.editingMinuteId;
  state.minutes = state.minutes.filter((m) => m.id !== deletedId);
  recomputeMappings();
  if (state.selectedMinuteId === deletedId) {
    state.selectedMinuteId = state.minutes[0]?.id || null;
  }
  try {
    await persistEdits();
    closeModal("editMinuteModal");
    renderMinutes();
    renderTranscript();
    updatePlayerMeta();
    showToast("已删除该纪要条目");
  } catch (err) {
    showToast(err.message);
  }
});

// Reset edits
$("#resetEditsBtn").addEventListener("click", async () => {
  try {
    const res = await fetch(`/api/session/reset?id=${encodeURIComponent(state.sessionId)}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "还原失败");
    await refreshSessionList();
    applySessionPayload(data);
    showToast("已还原为初始自动生成结果");
  } catch (err) {
    showToast(err.message);
  }
});

// Export & Copy Markdown
$("#copyMarkdownBtn").addEventListener("click", async () => {
  const md = buildMarkdownReport();
  try {
    await navigator.clipboard.writeText(md);
    showToast("Markdown 纪要已复制到剪贴板");
  } catch {
    showToast("剪贴板写入受限，请尝试点击「导出 .md」");
  }
});

$("#downloadMarkdownBtn").addEventListener("click", () => {
  const md = buildMarkdownReport();
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.sessionId}_minutes.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`已导出 ${state.sessionId}_minutes.md`);
});

// Audio Player Events
const audioPlayer = $("#audioPlayer");

audioPlayer.addEventListener("loadedmetadata", () => {
  if (state.pendingAudioSeek !== null) {
    audioPlayer.currentTime = state.pendingAudioSeek;
    state.pendingAudioSeek = null;
  }
  updateTimelineUI();
  renderEvidenceMarkersOnTimeline();
});

audioPlayer.addEventListener("timeupdate", () => {
  updateTimelineUI();
  const t = audioPlayer.currentTime;

  // Highlight currently playing transcript sentence
  const curIdx = state.transcript.findIndex((s) => t >= Number(s.start) - 0.05 && t <= Number(s.end) + 0.05);
  if (curIdx !== state.playingSentenceIdx) {
    const prevRow = document.querySelector(`.transcript-row.is-playing`);
    prevRow?.classList.remove("is-playing");
    state.playingSentenceIdx = curIdx;
    if (curIdx >= 0) {
      const curRow = document.querySelector(`.transcript-row[data-sentence-index="${curIdx}"]`);
      curRow?.classList.add("is-playing");
      if (state.autoFollow && state.editingSentenceIdx === null) {
        curRow?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      $("#activeSubtitle").textContent = state.transcript[curIdx].text;
    }
  }

  // Handle evidence-segment boundary playback
  if (state.playMode === "evidence" && !audioPlayer.paused) {
    const item = getSelectedMinute();
    const spans = item?._spans || [];
    const curSpan = spans[state.activeSpanIndex];
    if (curSpan && t >= curSpan.end - 0.04) {
      if (state.activeSpanIndex < spans.length - 1) {
        state.activeSpanIndex += 1;
        audioPlayer.currentTime = spans[state.activeSpanIndex].start;
      } else {
        audioPlayer.pause();
        state.activeSpanIndex = 0;
        updatePlayerMeta();
      }
    }
  }
});

audioPlayer.addEventListener("play", updatePlayerMeta);
audioPlayer.addEventListener("pause", updatePlayerMeta);
audioPlayer.addEventListener("ended", updatePlayerMeta);

$("#playPauseBtn").addEventListener("click", async () => {
  if (!state.audioUrl) return;
  if (!audioPlayer.paused) {
    audioPlayer.pause();
    return;
  }
  const item = getSelectedMinute();
  const spans = item?._spans || [];
  if (state.playMode === "evidence" && spans.length) {
    const t = audioPlayer.currentTime;
    const insideIdx = spans.findIndex((sp) => t >= sp.start - 0.2 && t < sp.end - 0.1);
    if (insideIdx >= 0) {
      state.activeSpanIndex = insideIdx;
      await audioPlayer.play();
    } else {
      state.activeSpanIndex = 0;
      await startPlaybackAt(spans[0].start, "evidence");
    }
  } else {
    try {
      await audioPlayer.play();
    } catch {
      showToast("无法播放当前音频");
    }
  }
});

$("#stepBackBtn").addEventListener("click", () => {
  if (!state.audioUrl) return;
  state.playMode = "full";
  seekAudioTo((audioPlayer.currentTime || 0) - 3);
  updatePlayerMeta();
});

$("#stepForwardBtn").addEventListener("click", () => {
  if (!state.audioUrl) return;
  state.playMode = "full";
  seekAudioTo((audioPlayer.currentTime || 0) + 3);
  updatePlayerMeta();
});

$("#playModeBtn").addEventListener("click", () => {
  state.playMode = state.playMode === "evidence" ? "full" : "evidence";
  updatePlayerMeta();
  showToast(state.playMode === "evidence" ? "已切换为：仅播证据片段" : "已切换为：全场连续播放");
});

$("#timelineSlider").addEventListener("input", (event) => {
  if (!state.audioUrl) return;
  const target = Number(event.target.value);
  const item = getSelectedMinute();
  const spans = item?._spans || [];
  if (state.playMode === "evidence") {
    const hitIdx = spans.findIndex((sp) => target >= sp.start && target <= sp.end);
    if (hitIdx >= 0) {
      state.activeSpanIndex = hitIdx;
    } else {
      state.playMode = "full";
      updatePlayerMeta();
    }
  }
  seekAudioTo(target);
});

$("#speedSelect").addEventListener("change", (event) => {
  audioPlayer.playbackRate = Number(event.target.value || 1);
});

$("#downloadWordBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const sessionId = state.sessionId;
  const filename = state.audioName.replace(/\.[^.]+$/, "");
  button.disabled = true;
  try {
    const response = await fetch("/api/session/word?id=" + encodeURIComponent(sessionId));
    if (!response.ok) throw new Error((await response.json()).error || "Word 导出失败");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = filename + "-会议纪要.docx";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

// Upload Modal
function acceptedAudio(file) {
  if (!file) return null;
  if (!/\.(wav|m4a|mp3)$/i.test(file.name)) {
    showToast("请选择 WAV、M4A 或 MP3 录音");
    return null;
  }
  if (file.size === 0 || file.size > 80 * 1024 * 1024) {
    showToast("请选择不超过 80 MB 的有效录音");
    return null;
  }
  return file;
}

function setUploadFile(file) {
  file = acceptedAudio(file);
  state.selectedUploadFile = file;
  if (file) {
    $("#dropzoneFileName").textContent = file.name;
    $("#dropzoneFileMeta").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · 准备就绪`;
    $("#startAnalyzeBtn").disabled = false;
  } else {
    $("#dropzoneFileName").textContent = "点击选择或拖拽录音至此";
    $("#dropzoneFileMeta").textContent = "支持 WAV、M4A、MP3，最大 80 MB";
    $("#startAnalyzeBtn").disabled = true;
  }
}

$("#uploadModalBtn").addEventListener("click", () => openModal("uploadModal"));
$("#sidebarUploadBtn").addEventListener("click", () => openModal("uploadModal"));

$$("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
});

$$(".modal-backdrop").forEach((backdrop) => {
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) backdrop.classList.add("hidden");
  });
});

$("#audioFileInput").addEventListener("change", (event) => {
  setUploadFile(event.target.files?.[0]);
});

const dropzone = $("#dropzone");
dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("is-dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragover"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("is-dragover");
  const file = event.dataTransfer?.files?.[0];
  if (file) setUploadFile(file);
});

async function analyzeAudioFile(file, method) {
  const res = await fetch(`/api/analyze?name=${encodeURIComponent(file.name)}&method=${encodeURIComponent(method)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "分析失败");
  await refreshSessionList();
  applySessionPayload(data);
  await setAppView("workspace", data.id, { pushHash: true });
}

function setHomeUploadFile(file) {
  file = acceptedAudio(file);
  state.homeUploadFile = file;
  if (file) {
    $("#homeDropzoneTitle").textContent = file.name;
    $("#homeDropzoneMeta").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · 准备就绪`;
    $("#homeAnalyzeBtn").disabled = false;
  } else {
    $("#homeDropzoneTitle").textContent = "点击选择或拖拽录音至此";
    $("#homeDropzoneMeta").textContent = "支持 WAV、M4A、MP3，最大 80 MB";
    $("#homeAnalyzeBtn").disabled = true;
  }
}

$("#homeAudioInput").addEventListener("change", (event) => {
  setHomeUploadFile(event.target.files?.[0]);
});

const homeDropzone = $("#homeDropzone");
homeDropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  homeDropzone.classList.add("is-dragover");
});
homeDropzone.addEventListener("dragleave", () => homeDropzone.classList.remove("is-dragover"));
homeDropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  homeDropzone.classList.remove("is-dragover");
  const file = event.dataTransfer?.files?.[0];
  if (file) setHomeUploadFile(file);
});

$("#homeAnalyzeBtn").addEventListener("click", async () => {
  const file = state.homeUploadFile;
  if (!file) return;
  const method = $("#homeMethodSelect").value;
  $("#homeAnalyzeBtn").disabled = true;
  $("#homeUploadProgress").classList.remove("hidden");
  try {
    await analyzeAudioFile(file, method);
    setHomeUploadFile(null);
    $("#homeAudioInput").value = "";
    showToast("本地录音转写与纪要生成完成");
  } catch (err) {
    showToast(err.message);
  } finally {
    $("#homeUploadProgress").classList.add("hidden");
    $("#homeAnalyzeBtn").disabled = !state.homeUploadFile;
  }
});

$("#startAnalyzeBtn").addEventListener("click", async () => {
  const file = state.selectedUploadFile;
  if (!file) return;
  const method = $("#analyzeMethodSelect").value;
  $("#startAnalyzeBtn").disabled = true;
  $("#uploadProgressBox").classList.remove("hidden");

  try {
    await analyzeAudioFile(file, method);
    closeModal("uploadModal");
    setUploadFile(null);
    $("#audioFileInput").value = "";
    showToast("本地录音转写与纪要生成完成");
  } catch (err) {
    showToast(err.message);
  } finally {
    $("#uploadProgressBox").classList.add("hidden");
    $("#startAnalyzeBtn").disabled = !state.selectedUploadFile;
  }
});

// Keyboard shortcuts (Space for play/pause when not typing)
document.addEventListener("keydown", (event) => {
  if (event.code === "Escape") {
    $$(".modal-backdrop").forEach((m) => m.classList.add("hidden"));
    if (state.editingSentenceIdx !== null) {
      state.editingSentenceIdx = null;
      renderTranscript();
    }
    return;
  }
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (event.code === "Space" && state.appView === "workspace" && state.audioUrl) {
    event.preventDefault();
    $("#playPauseBtn").click();
  }
});

boot().catch((err) => showToast(err.message));
