import {
  acceptedAudio,
  buildEvidenceFromIndices,
  buildMarkdownReport,
  escapeHtml,
  formatSentenceId,
  formatTime,
  getAllEvidenceSpans,
  getMinuteSpans,
  getSelectedMinute,
  isUnknownValue,
  normalizeUnknownField,
  parseEvidenceIdsInput,
  parseHashRoute,
  recomputeMappings,
  state,
  taskSourceKey,
} from "./state.js";
import {
  addTask,
  analyzeAudio,
  downloadSessionWord,
  fetchDemo,
  fetchSession,
  fetchSessions,
  fetchTasks,
  resetSessionEdits,
  saveSessionEdits,
} from "./api.js";
import { buildCharDiffHtml } from "./diff.js";
import { initPaneSplitter } from "./splitter.js";
import { WaveformPlayer } from "./waveform.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let waveformPlayer = null;
let paneSplitter = null;
let inlineFieldClosing = false;

function showToast(message) {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function getEffectiveDuration() {
  const player = $("#audioPlayer");
  if (player && Number.isFinite(player.duration) && player.duration > 0) {
    return player.duration;
  }
  return Number(state.asr.duration || 0);
}

function getVisibleMinutes() {
  const visible = state.minutes.filter((item) => {
    if (state.minuteFilter === "全部") return true;
    if (state.minuteFilter === "待核对") return !item.verified;
    return item.type === state.minuteFilter;
  });

  if (state.groupMode === "time") {
    return [...visible].sort((a, b) => (a.evidence_start ?? Infinity) - (b.evidence_start ?? Infinity));
  }

  const groups = new Map();
  visible.forEach((item) => {
    const topic = String(item.topic || "未分类议题").trim();
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(item);
  });
  const ordered = [];
  for (const [topic, items] of groups.entries()) {
    if (!state.collapsedTopics.has(topic)) {
      ordered.push(...items);
    }
  }
  return ordered;
}

function closeExportMenu() {
  const menu = $("#exportMenu");
  const btn = $("#exportMenuBtn");
  if (menu) menu.classList.add("hidden");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function toggleExportMenu(forceState = null) {
  const menu = $("#exportMenu");
  const btn = $("#exportMenuBtn");
  if (!menu || !btn) return;
  const willOpen = forceState !== null ? Boolean(forceState) : menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !willOpen);
  btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
}

function openModal(id) {
  closeExportMenu();
  const modal = $(`#${id}`);
  if (modal) modal.classList.remove("hidden");
}

function closeModal(id) {
  const modal = $(`#${id}`);
  if (modal) modal.classList.add("hidden");
}

function isAnyModalOpen() {
  return $$(".modal-backdrop").some((el) => !el.classList.contains("hidden"));
}

function applyMobilePane() {
  const split = $("#workspaceSplit");
  if (!split) return;
  const isMobile = window.innerWidth <= 960;
  split.dataset.mobilePane = state.mobilePane;
  $("#transcriptPane")?.classList.toggle("is-mobile-hidden", isMobile && state.mobilePane !== "transcript");
  $("#minutesPane")?.classList.toggle("is-mobile-hidden", isMobile && state.mobilePane !== "minutes");
  $$("#mobilePaneTabs .mobile-pane-btn").forEach((btn) => {
    const active = btn.dataset.mobilePane === state.mobilePane;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function renderTopbar() {
  const isWorkspace = state.appView === "workspace";
  $("#navArchive")?.classList.toggle("active", !isWorkspace);
  $("#navWorkspace")?.classList.toggle("active", isWorkspace);

  const navTaskCount = $("#navTaskCount");
  if (navTaskCount) {
    navTaskCount.textContent = String(state.taskCount || 0);
  }

  const sessionInfo = state.sessions.find((s) => s.id === state.sessionId);
  $("#currentSessionBadge").textContent = sessionInfo?.kind === "live" ? "本地上传" : state.sessionId.toUpperCase();
  $("#currentSessionTitle").textContent = sessionInfo?.title || state.audioName;

  const duration = Number(state.asr.duration || 0);
  const totalMinutes = state.minutes.length;
  const verifiedCount = state.minutes.filter((item) => Boolean(item.verified)).length;
  const flaggedCount = state.minutes.filter((item) => Array.isArray(item.flags) && item.flags.length > 0).length;
  const evidenceBound = state.minutes.filter((item) => getMinuteSpans(item).length > 0).length;

  const summaryParts = [
    formatTime(duration),
    `${state.transcript.length} 句转写`,
    `${evidenceBound}/${totalMinutes} 有证据`,
    `已核对 ${verifiedCount}/${totalMinutes}`,
  ];
  if (flaggedCount > 0) {
    summaryParts.push(`${flaggedCount} 条防幻觉拦截`);
  }
  const metaLine = $("#workspaceMetaLine");
  if (metaLine) {
    metaLine.textContent = summaryParts.join(" · ");
  }

  const resetBtn = $("#resetEditsBtn");
  if (resetBtn) {
    resetBtn.disabled = !state.hasEdits;
    resetBtn.style.opacity = state.hasEdits ? "" : "0.45";
    resetBtn.style.cursor = state.hasEdits ? "" : "not-allowed";
    resetBtn.title = state.hasEdits ? "清除人工校对与核对修改" : "当前未作人工修改";
  }
}

function renderHome() {
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
    const tc = s.typeCounts || {};
    const metaParts = [
      kindLabel,
      tc["决定"] ? `决定 ${tc["决定"]}` : "",
      tc["待办"] ? `待办 ${tc["待办"]}` : "",
      tc["待确认"] ? `待确认 ${tc["待确认"]}` : "",
      `${s.sentenceCount} 句`,
      s.flaggedCount ? `${s.flaggedCount} 条拦截` : "",
    ].filter(Boolean);

    const pct = s.itemCount ? Math.round((s.verifiedCount / s.itemCount) * 100) : 0;
    const verifyText = s.itemCount
      ? `已核对 ${s.verifiedCount}/${s.itemCount}${s.hasEdits ? " · 含校对" : ""}`
      : (s.hasEdits ? "含人工校对" : "0 条纪要");

    return `
      <article class="archive-card" data-open-session="${escapeHtml(s.id)}" tabindex="0" role="button">
        <div class="archive-card-head">
          <span class="archive-card-code">${escapeHtml(idLabel)}</span>
          <span class="archive-card-duration">${formatTime(s.duration)}${s.audioUrl ? "" : " · 无音频"}</span>
        </div>
        <h3 class="archive-card-title">${escapeHtml(s.title)}</h3>
        <p class="archive-card-preview">${escapeHtml(s.previewText || "暂无内容预览")}</p>
        <div class="archive-card-meta">${metaParts.map(escapeHtml).join(" · ")}</div>
        <div class="archive-card-footer">
          <div class="archive-card-progress">
            <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
            <span>${escapeHtml(verifyText)}</span>
          </div>
          <span class="archive-card-enter">进入核对 →</span>
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
    closeExportMenu();
  }

  $("#homeView").classList.toggle("hidden", isWorkspace);
  $("#workspaceBody").classList.toggle("hidden", !isWorkspace);
  $("#playerDock").classList.toggle("hidden", !isWorkspace);

  $("#topbarWorkspaceCenter").classList.toggle("hidden", !isWorkspace);
  $("#addMinuteBtn").classList.toggle("hidden", !isWorkspace);
  $("#exportDropdown").classList.toggle("hidden", !isWorkspace);
  $("#shortcutsBtn").classList.toggle("hidden", !isWorkspace);

  renderTopbar();
  if (!isWorkspace) {
    renderHome();
    if (pushHash && window.location.hash !== "#home") {
      window.location.hash = "#home";
    }
  } else {
    applyMobilePane();
    const targetHash = `#session/${state.sessionId}`;
    if (pushHash && window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
    updatePlayerMeta();
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
    const hasDiff = Boolean(sentence.corrected && sentence.original_text && sentence.original_text !== sentence.text);
    const isDiffExpanded = hasDiff && state.expandedDiffs.has(sentence.index);

    const rowClasses = [
      "transcript-row",
      isEvidence ? "is-evidence" : "",
      isPlaying ? "is-playing" : "",
      isEditing ? "is-editing" : "",
      sentence.corrected ? "is-corrected" : "",
    ].filter(Boolean).join(" ");

    const citeLinks = sentence.citedBy.map((mid) => {
      const active = mid === state.selectedMinuteId ? "is-active" : "";
      return `<button class="cite-link ${active}" data-cite-minute="${escapeHtml(mid)}" type="button">#${escapeHtml(mid)}</button>`;
    }).join("");

    const correctedLabel = sentence.corrected ? `<span class="corrected-label">已人工校对</span>` : "";

    let diffHtml = "";
    if (hasDiff && !isEditing) {
      const diffResult = isDiffExpanded ? buildCharDiffHtml(sentence.original_text, sentence.text) : null;
      diffHtml = `
        <div class="transcript-diff-box">
          <button class="diff-toggle-btn" data-toggle-diff="${sentence.index}" type="button" aria-expanded="${isDiffExpanded ? "true" : "false"}">
            ${isDiffExpanded ? "收起对比" : "查看校对对比"}
          </button>
          ${isDiffExpanded && diffResult ? `<div class="diff-panel">${diffResult.inlineHtml}</div>` : ""}
        </div>
      `;
    }

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
        ${diffHtml}
        ${(citeLinks || correctedLabel) ? `<div class="transcript-meta-row">${correctedLabel}${citeLinks}</div>` : ""}
      `;

    return `
      <div class="${rowClasses}" data-sentence-index="${sentence.index}">
        <div class="transcript-time-col">
          <button class="time-jump-btn" data-jump-time="${sentence.start}" type="button" title="点击从此句播放">
            <span>▶</span>
            <span>${formatTime(sentence.start)}</span>
          </button>
          <span class="sent-id">${sentence.rawId}</span>
        </div>
        <div class="transcript-body">${bodyHtml}</div>
        <div class="transcript-actions">
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

function renderInlineField(item, field, label) {
  const rawValue = item[field];
  const isUnknown = isUnknownValue(rawValue);
  const isEditing = Boolean(
    state.inlineEditField &&
      state.inlineEditField.minuteId === item.id &&
      state.inlineEditField.field === field,
  );

  if (isEditing) {
    const initialVal = isUnknown ? "" : String(rawValue ?? "").trim();
    return `
      <span style="display:inline-flex;align-items:center;gap:5px;font-size:var(--text-sm);color:var(--muted)">
        <strong>${label}</strong>
        <input
          class="inline-field-input"
          id="inlineFieldInput"
          type="text"
          value="${escapeHtml(initialVal)}"
          placeholder="留空则为未知"
          data-minute-id="${escapeHtml(item.id)}"
          data-field-name="${field}"
          aria-label="编辑${label}"
        />
      </span>
    `;
  }

  return `
    <button
      class="inline-field ${isUnknown ? "is-unknown" : ""}"
      data-inline-field="${field}"
      data-minute-id="${escapeHtml(item.id)}"
      type="button"
      title="点击行内编辑${label}"
    >
      <strong>${label}</strong>
      <span>${isUnknown ? "未知（原话未指明）" : escapeHtml(rawValue)}</span>
    </button>
  `;
}

function renderMinuteCard(item, showInlineTopic) {
  const isSelected = item.id === state.selectedMinuteId;
  const isVerified = Boolean(item.verified);
  const spans = item._spans || getMinuteSpans(item);

  const spanBtnsHtml = spans.length
    ? spans.map((span, sIdx) => `
      <button
        class="span-play-btn"
        data-play-minute="${escapeHtml(item.id)}"
        data-span-index="${sIdx}"
        type="button"
        title="点击立即回听此段原话"
      >
        <span>▶</span>
        <span>${formatTime(span.start)}-${formatTime(span.end, true)}</span>
      </button>
    `).join("")
    : `<span class="inline-field is-unknown">无关联时间段</span>`;

  const flagsHtml = Array.isArray(item.flags) && item.flags.length
    ? `<div class="guard-note">防幻觉拦截：${item.flags.map(escapeHtml).join("；")}</div>`
    : "";

  const quoteHtml = item.evidence_text
    ? `<div class="minute-quote">${escapeHtml(item.evidence_text)}</div>`
    : "";

  const taskActionHtml = item.type === "待办"
    ? (state.taskSources.has(taskSourceKey(state.sessionId, item.id))
      ? `<a class="card-action-btn task-linked" href="/tasks.html">已加入看板</a>`
      : `<button class="card-action-btn" data-add-task="${escapeHtml(item.id)}" type="button">加入待办</button>`)
    : "";

  return `
    <article class="minute-card type-${escapeHtml(item.type)} ${isSelected ? "is-selected" : ""} ${isVerified ? "is-verified" : ""}" data-minute-id="${escapeHtml(item.id)}">
      <div class="minute-head">
        <div class="minute-head-meta">
          <span class="minute-type-label">${escapeHtml(item.type)}</span>
          <span class="minute-id">#${escapeHtml(item.id)}</span>
          ${showInlineTopic ? `<span class="minute-topic-inline">${escapeHtml(item.topic || "未分类议题")}</span>` : ""}
        </div>
        <div class="minute-actions">
          ${taskActionHtml}
          <button class="card-action-btn" data-edit-minute="${escapeHtml(item.id)}" type="button">编辑</button>
          <button class="card-action-btn verify-btn ${isVerified ? "is-verified" : ""}" data-verify-minute="${escapeHtml(item.id)}" type="button">
            ${isVerified ? "✓ 已核对" : "标记核对"}
          </button>
        </div>
      </div>

      <div class="minute-content">${escapeHtml(item.content)}</div>

      <div class="minute-fields">
        ${renderInlineField(item, "responsible", "负责人")}
        ${renderInlineField(item, "deadline", "截止")}
      </div>

      <div class="minute-evidence-row">${spanBtnsHtml}</div>
      ${quoteHtml}
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

function updatePlayerMeta() {
  const player = $("#audioPlayer");
  const hasAudio = Boolean(state.audioUrl);
  $("#playPauseBtn").disabled = !hasAudio;
  $("#stepBackBtn").disabled = !hasAudio;
  $("#stepForwardBtn").disabled = !hasAudio;

  const isPlaying = hasAudio && !player.paused && !player.ended;
  $("#playIcon").classList.toggle("hidden", isPlaying);
  $("#pauseIcon").classList.toggle("hidden", !isPlaying);

  $$("#playModeToggle .mode-seg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.playMode === state.playMode);
  });

  const item = getSelectedMinute();
  const badge = $("#activeEvidenceBadge");
  const subtitle = $("#activeSubtitle");

  if (!hasAudio) {
    badge.textContent = "无本地音频";
    subtitle.textContent = "未找到本地音频，仍可核对转写与时间段。可通过右上角导入录音";
  } else if (item) {
    const spans = item._spans || [];
    const spanText = spans.length
      ? `${formatTime(spans[0].start)}-${formatTime(spans[spans.length - 1].end, true)}`
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

  waveformPlayer?.setState({
    currentTime: Number.isFinite(player.currentTime) ? player.currentTime : 0,
    duration: getEffectiveDuration(),
    allSpans: getAllEvidenceSpans(),
    activeSpans: item?._spans || [],
    isPlaying,
  });
}

function updateTimelineUI() {
  const player = $("#audioPlayer");
  const total = getEffectiveDuration();
  const current = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  const isPlaying = Boolean(state.audioUrl) && !player.paused && !player.ended;
  $("#currentTimeLabel").textContent = formatTime(current);
  $("#totalTimeLabel").textContent = formatTime(total);
  waveformPlayer?.setState({
    currentTime: current,
    duration: total,
    isPlaying,
  });
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

  waveformPlayer?.loadAudio(audioUrl, Number(state.asr.duration || 0));
  updateTimelineUI();
  updatePlayerMeta();
}

function seekAudioTo(seconds) {
  const player = $("#audioPlayer");
  if (!state.audioUrl) return;
  const duration = getEffectiveDuration();
  const target = Math.max(0, duration > 0 ? Math.min(duration, Number(seconds)) : Number(seconds));
  if (player.readyState >= 1) {
    player.currentTime = target;
    updateTimelineUI();
  } else {
    state.pendingAudioSeek = target;
    waveformPlayer?.setState({ currentTime: target, duration });
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

function handleWaveformSeek(seconds) {
  if (!state.audioUrl) return;
  const item = getSelectedMinute();
  const spans = item?._spans || [];
  if (state.playMode === "evidence") {
    const hitIdx = spans.findIndex((sp) => seconds >= sp.start && seconds <= sp.end);
    if (hitIdx >= 0) {
      state.activeSpanIndex = hitIdx;
    } else {
      state.playMode = "full";
      updatePlayerMeta();
    }
  }
  seekAudioTo(seconds);
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
  state.inlineEditField = null;
  state.expandedDiffs.clear();
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
  try {
    const data = await fetchSessions();
    state.sessions = data.sessions || [];
    renderSidebar();
    renderTopbar();
    if (state.appView === "home") renderHome();
  } catch {
    // Ignore transient list refresh failures
  }
}

async function switchSession(id) {
  const data = await fetchSession(id);
  await refreshSessionList();
  applySessionPayload(data);
}

async function persistEdits() {
  const cleanMinutes = state.minutes.map(({ _spans, matchedSentenceIndices, ...rest }) => rest);
  const cleanTranscript = state.transcript.map(({ index, rawId, citedBy, ...rest }) => rest);

  await saveSessionEdits({
    id: state.sessionId,
    minutes: cleanMinutes,
    transcript: cleanTranscript,
  });
  state.hasEdits = true;
  await refreshSessionList();
  renderTopbar();
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
  previewEl.textContent = `已匹配 ${indices.length} 句（${formatTime(built.evidence_start)}-${formatTime(built.evidence_end, true)}）：${built.evidence_text.slice(0, 90)}${built.evidence_text.length > 90 ? "…" : ""}`;
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

  openModal("editMinuteModal");
  $("#editTopicInput").focus();
}

async function commitInlineFieldEdit() {
  if (inlineFieldClosing || !state.inlineEditField) return;
  const input = $("#inlineFieldInput");
  if (!input) return;

  inlineFieldClosing = true;
  const { minuteId, field } = state.inlineEditField;
  const nextValue = normalizeUnknownField(input.value);
  const item = state.minutes.find((m) => m.id === minuteId);
  state.inlineEditField = null;

  if (!item) {
    inlineFieldClosing = false;
    renderMinutes();
    return;
  }

  const prevNormalized = normalizeUnknownField(item[field]);
  if (nextValue === prevNormalized) {
    inlineFieldClosing = false;
    renderMinutes();
    return;
  }

  item[field] = nextValue;
  renderMinutes();
  try {
    await persistEdits();
    showToast(field === "responsible" ? "负责人已更新" : "截止日期已更新");
  } catch (err) {
    showToast(err.message);
  } finally {
    inlineFieldClosing = false;
  }
}

function cancelInlineFieldEdit() {
  if (!state.inlineEditField) return;
  inlineFieldClosing = true;
  state.inlineEditField = null;
  renderMinutes();
  inlineFieldClosing = false;
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
  const card = document.querySelector(`.minute-card[data-minute-id="${minuteId}"]`);
  card?.scrollIntoView({ block: "nearest" });
}

async function refreshTaskSources() {
  const { tasks } = await fetchTasks();
  const list = Array.isArray(tasks) ? tasks : [];
  state.taskSources = new Set(list.map((task) => taskSourceKey(task.sessionId, task.minuteId)));
  state.taskCount = list.filter((task) => task.status !== "done").length;
  renderTopbar();
  if (state.appView === "workspace") renderMinutes();
}

async function toggleMinuteVerified(minuteId) {
  const item = state.minutes.find((m) => m.id === minuteId);
  if (!item) return;
  item.verified = !item.verified;
  renderMinutes();
  renderTopbar();
  try {
    await persistEdits();
    showToast(item.verified ? "已标记为核对完成" : "已取消核对标记");
  } catch (err) {
    showToast(err.message);
  }
}

function stepSelectedMinute(delta) {
  const visible = getVisibleMinutes();
  if (!visible.length) return;
  const curIdx = visible.findIndex((item) => item.id === state.selectedMinuteId);
  const nextIdx = curIdx < 0
    ? (delta > 0 ? 0 : visible.length - 1)
    : Math.max(0, Math.min(visible.length - 1, curIdx + delta));
  const target = visible[nextIdx];
  if (!target) return;
  selectMinute(target.id, { autoPlay: false, scrollTranscript: true });
  const card = document.querySelector(`.minute-card[data-minute-id="${target.id}"]`);
  card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setUploadFile(file) {
  const result = acceptedAudio(file);
  if (result.error) showToast(result.error);
  state.selectedUploadFile = result.file;
  if (result.file) {
    $("#dropzoneFileName").textContent = result.file.name;
    $("#dropzoneFileMeta").textContent = `${(result.file.size / 1024 / 1024).toFixed(2)} MB · 准备就绪`;
    $("#startAnalyzeBtn").disabled = false;
  } else {
    $("#dropzoneFileName").textContent = "点击选择或拖拽录音至此";
    $("#dropzoneFileMeta").textContent = "支持 WAV、M4A、MP3，最大支持 80 MB";
    $("#startAnalyzeBtn").disabled = true;
  }
}

function setHomeUploadFile(file) {
  const result = acceptedAudio(file);
  if (result.error) showToast(result.error);
  state.homeUploadFile = result.file;
  if (result.file) {
    $("#homeDropzoneTitle").textContent = result.file.name;
    $("#homeDropzoneMeta").textContent = `${(result.file.size / 1024 / 1024).toFixed(2)} MB · 准备就绪`;
    $("#homeAnalyzeBtn").disabled = false;
  } else {
    $("#homeDropzoneTitle").textContent = "选择或拖拽录音至此（WAV / M4A / MP3）";
    $("#homeDropzoneMeta").textContent = "最大支持 80 MB，音频仅在本机识别";
    $("#homeAnalyzeBtn").disabled = true;
  }
}

async function analyzeAndOpen(file, method) {
  const data = await analyzeAudio(file, method);
  await refreshSessionList();
  applySessionPayload(data);
  await setAppView("workspace", data.id, { pushHash: true });
}

function setSidebarCollapsed(collapsed) {
  const sidebar = $("#sessionSidebar");
  const expandBtn = $("#expandSidebarBtn");
  sidebar?.classList.toggle("collapsed", collapsed);
  expandBtn?.classList.toggle("hidden", !collapsed);
  expandBtn?.setAttribute("aria-expanded", String(!collapsed));
}

async function boot() {
  setSidebarCollapsed(window.innerWidth <= 960);

  waveformPlayer = new WaveformPlayer({
    canvas: $("#waveformCanvas"),
    container: $("#waveformWrap"),
    tooltipEl: $("#waveformTooltip"),
    onSeek: handleWaveformSeek,
  });

  paneSplitter = initPaneSplitter({
    container: $("#workspaceSplit"),
    handle: $("#paneResizer"),
  });

  const data = await fetchDemo();
  state.sessions = data.sessions || [];
  applySessionPayload(data);
  await followHashRoute();
  refreshTaskSources().catch(() => {});

  const params = new URLSearchParams(window.location.search);
  if (params.get("upload") === "1") {
    openModal("uploadModal");
    window.history.replaceState({}, "", window.location.pathname + window.location.hash);
  }
}

/* ==================== Event Listeners ==================== */

window.addEventListener("hashchange", () => {
  followHashRoute().catch((err) => showToast(err.message));
});

window.addEventListener("resize", () => {
  if (state.appView === "workspace") {
    applyMobilePane();
  }
});

// Topbar & Archive Navigation
$("#brandHomeLink").addEventListener("click", () => setAppView("home"));
$("#brandHomeLink").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setAppView("home");
  }
});

$("#navArchive").addEventListener("click", () => setAppView("home"));
$("#navWorkspace").addEventListener("click", () => {
  openSessionWorkspace(state.sessionId).catch((err) => showToast(err.message));
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

// Mobile pane tabs
$("#mobilePaneTabs").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-mobile-pane]");
  if (!btn) return;
  state.mobilePane = btn.dataset.mobilePane;
  applyMobilePane();
});

// Sidebar toggle & session switching
$("#collapseSidebarBtn").addEventListener("click", () => {
  setSidebarCollapsed(true);
});

$("#expandSidebarBtn").addEventListener("click", () => {
  setSidebarCollapsed(false);
});

$("#sessionList").addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-session-id]");
  if (!btn) return;
  const id = btn.dataset.sessionId;
  if (window.innerWidth <= 960) {
    setSidebarCollapsed(true);
  }
  if (id === state.sessionId) return;
  try {
    await openSessionWorkspace(id);
  } catch (err) {
    showToast(err.message);
  }
});

// Export dropdown
$("#exportMenuBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleExportMenu();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#exportDropdown")) {
    closeExportMenu();
  }
});

$("#shortcutsBtn").addEventListener("click", () => {
  const modal = $("#shortcutsModal");
  if (modal.classList.contains("hidden")) openModal("shortcutsModal");
  else closeModal("shortcutsModal");
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

// Transcript row interactions
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

  const diffBtn = event.target.closest("[data-toggle-diff]");
  if (diffBtn) {
    const idx = Number(diffBtn.dataset.toggleDiff);
    if (state.expandedDiffs.has(idx)) state.expandedDiffs.delete(idx);
    else state.expandedDiffs.add(idx);
    renderTranscript();
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
    if (targetSentence.original_text !== newText) {
      state.expandedDiffs.add(idx);
    }

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

// Minute card actions + inline quick edit
$("#minutesList").addEventListener("click", async (event) => {
  if (event.target.closest("#inlineFieldInput")) {
    event.stopPropagation();
    return;
  }

  const inlineBtn = event.target.closest("[data-inline-field]");
  if (inlineBtn) {
    event.stopPropagation();
    const minuteId = inlineBtn.dataset.minuteId;
    const field = inlineBtn.dataset.inlineField;
    state.inlineEditField = { minuteId, field };
    renderMinutes();
    const input = $("#inlineFieldInput");
    if (input) {
      input.focus();
      input.select();
    }
    return;
  }

  const addTaskBtn = event.target.closest("[data-add-task]");
  if (addTaskBtn) {
    event.stopPropagation();
    const sessionId = state.sessionId;
    const minuteId = addTaskBtn.dataset.addTask;
    addTaskBtn.disabled = true;
    try {
      await addTask({ sessionId, minuteId });
      state.taskSources.add(taskSourceKey(sessionId, minuteId));
      state.taskCount += 1;
      renderTopbar();
      renderMinutes();
      showToast("已加入会后待办");
    } catch (error) {
      addTaskBtn.disabled = false;
      showToast(error.message);
    }
    return;
  }
  if (event.target.closest(".task-linked")) return;

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
    await toggleMinuteVerified(verifyBtn.dataset.verifyMinute);
    return;
  }

  const editBtn = event.target.closest("[data-edit-minute]");
  if (editBtn) {
    event.stopPropagation();
    openEditMinuteModal(editBtn.dataset.editMinute);
    return;
  }

  const spanBtn = event.target.closest("[data-play-minute]");
  if (spanBtn) {
    event.stopPropagation();
    const id = spanBtn.dataset.playMinute;
    const sIdx = Number(spanBtn.dataset.spanIndex || 0);
    selectMinute(id, { autoPlay: true, scrollTranscript: true, spanIndex: sIdx });
    return;
  }

  const card = event.target.closest("[data-minute-id]");
  if (card) {
    selectMinute(card.dataset.minuteId, { autoPlay: false, scrollTranscript: true });
  }
});

$("#minutesList").addEventListener("keydown", (event) => {
  const input = event.target.closest("#inlineFieldInput");
  if (!input) return;
  if (event.key === "Enter") {
    event.preventDefault();
    commitInlineFieldEdit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelInlineFieldEdit();
  }
});

$("#minutesList").addEventListener("focusout", (event) => {
  if (event.target.id === "inlineFieldInput") {
    commitInlineFieldEdit();
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
  const responsible = normalizeUnknownField($("#editResponsibleInput").value);
  const deadline = normalizeUnknownField($("#editDeadlineInput").value);
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
    targetId = `m-${crypto.randomUUID()}`;
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

// Export & Reset actions
$("#resetEditsBtn").addEventListener("click", async () => {
  closeExportMenu();
  if (!state.hasEdits) return;
  try {
    const data = await resetSessionEdits(state.sessionId);
    await refreshSessionList();
    applySessionPayload(data);
    showToast("已还原为初始自动生成结果");
  } catch (err) {
    showToast(err.message);
  }
});

$("#copyMarkdownBtn").addEventListener("click", async () => {
  closeExportMenu();
  const md = buildMarkdownReport();
  try {
    await navigator.clipboard.writeText(md);
    showToast("Markdown 纪要已复制到剪贴板");
  } catch {
    showToast("剪贴板写入受限，请尝试点击「导出 .md 文件」");
  }
});

$("#downloadMarkdownBtn").addEventListener("click", () => {
  closeExportMenu();
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

$("#downloadWordBtn").addEventListener("click", async (event) => {
  closeExportMenu();
  const button = event.currentTarget;
  const sessionId = state.sessionId;
  const filename = state.audioName.replace(/\.[^.]+$/, "");
  button.disabled = true;
  try {
    const blob = await downloadSessionWord(sessionId);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename}-会议纪要.docx`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

// Audio Player Events
const audioPlayer = $("#audioPlayer");

audioPlayer.addEventListener("loadedmetadata", () => {
  if (state.pendingAudioSeek !== null) {
    audioPlayer.currentTime = state.pendingAudioSeek;
    state.pendingAudioSeek = null;
  }
  updateTimelineUI();
  updatePlayerMeta();
});

audioPlayer.addEventListener("timeupdate", () => {
  updateTimelineUI();
  const t = audioPlayer.currentTime;

  const curIdx = state.transcript.findIndex((s) => t >= Number(s.start) - 0.05 && t <= Number(s.end) + 0.05);
  if (curIdx !== state.playingSentenceIdx) {
    const prevRow = document.querySelector(".transcript-row.is-playing");
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
      try {
        await audioPlayer.play();
      } catch {
        showToast("无法播放当前音频");
      }
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

$("#playModeToggle").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-play-mode]");
  if (!btn) return;
  const nextMode = btn.dataset.playMode;
  if (nextMode === state.playMode) return;
  state.playMode = nextMode;
  updatePlayerMeta();
  showToast(state.playMode === "evidence" ? "已切换为：仅播证据片段" : "已切换为：全场连续播放");
});

$("#speedSelect").addEventListener("change", (event) => {
  audioPlayer.playbackRate = Number(event.target.value || 1);
});

// Upload Modal & Quick Import
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
    await analyzeAndOpen(file, method);
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
    await analyzeAndOpen(file, method);
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

// Keyboard shortcuts
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeExportMenu();
    $$(".modal-backdrop").forEach((m) => m.classList.add("hidden"));
    if (state.editingSentenceIdx !== null) {
      state.editingSentenceIdx = null;
      renderTranscript();
    }
    if (state.inlineEditField !== null) {
      cancelInlineFieldEdit();
    }
    return;
  }

  const active = document.activeElement;
  const tag = active?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active?.isContentEditable) {
    return;
  }

  if (event.key === "?") {
    event.preventDefault();
    const modal = $("#shortcutsModal");
    if (modal.classList.contains("hidden")) openModal("shortcutsModal");
    else closeModal("shortcutsModal");
    return;
  }

  if (state.appView !== "workspace" || isAnyModalOpen()) return;

  if (event.code === "Space") {
    if (active === $("#waveformCanvas")) return;
    if (state.audioUrl) {
      event.preventDefault();
      $("#playPauseBtn").click();
    }
    return;
  }

  if (event.key === "ArrowDown" || event.key === "j") {
    event.preventDefault();
    stepSelectedMinute(1);
    return;
  }

  if (event.key === "ArrowUp" || event.key === "k") {
    event.preventDefault();
    stepSelectedMinute(-1);
    return;
  }

  if (event.key === "v") {
    if (state.selectedMinuteId) {
      event.preventDefault();
      toggleMinuteVerified(state.selectedMinuteId);
    }
    return;
  }

  if (event.key === "r") {
    const item = getSelectedMinute();
    const spans = item?._spans || [];
    if (item && spans.length && state.audioUrl) {
      event.preventDefault();
      selectMinute(item.id, { autoPlay: true, scrollTranscript: true, spanIndex: 0 });
    }
    return;
  }

  if (event.key === "[") {
    if (state.audioUrl) {
      event.preventDefault();
      $("#stepBackBtn").click();
    }
    return;
  }

  if (event.key === "]") {
    if (state.audioUrl) {
      event.preventDefault();
      $("#stepForwardBtn").click();
    }
  }
});

boot().catch((err) => showToast(err.message));
