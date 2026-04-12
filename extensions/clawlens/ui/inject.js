/**
 * ClawLens UI inject — Overview panel + Audit drawer + Chat sidebar
 */

const API = "/plugins/clawlens/api";
const OVERVIEW_INTERVAL = 30_000;
const DEBUG_PREFIX = "[ClawLens Audit]";
const DEBUG_STORAGE_KEYS = ["clawlens.debug", "clawlens.audit.debug"];
const LIVE_LLM_STREAM_BY_RUN = new Map();
const TIMELINE_SCALE_BY_RUN = new Map();
const USER_MARKER_WIDTH_PCT = 3.2;
const LIVE_LLM_STALE_MS = 600_000;

// ── State ─────────────────────────────────────────────────────────────────

const S = {
  token: null,
  overview: null,
  drawerOpen: false,
  auditDays: 7,
  auditChannel: "",
  sessions: [],       // AuditSession summary[]
  selSession: null,   // string | null
  runs: [],           // RunAuditDetail[] — new format from getAuditSession
  loadingSessions: false,
  loadingRuns: false,
};

// ── Helpers ───────────────────────────────────────────────────────────────

function getToken() {
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i);
    if (k?.startsWith("openclaw.control.token.v1:"))
      return sessionStorage.getItem(k) ?? null;
  }
  return null;
}

function authHeaders() {
  return S.token ? { Authorization: `Bearer ${S.token}` } : {};
}

function isDebugEnabled() {
  try {
    if (window.__CLAWLENS_DEBUG__ === true) return true;
    for (const key of DEBUG_STORAGE_KEYS) {
      const raw = localStorage.getItem(key)?.trim().toLowerCase();
      if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
    }
  } catch {}
  return false;
}

function debugLog(...args) {
  if (!isDebugEnabled()) return;
  console.log(DEBUG_PREFIX, ...args);
}

async function apiFetch(path) {
  debugLog("apiFetch:start", path);
  try {
    const r = await fetch(API + path, { headers: authHeaders() });
    debugLog("apiFetch:response", path, r.status, r.ok);
    if (!r.ok) return null;
    const data = await r.json();
    debugLog("apiFetch:json", path, {
      hasRuns: Array.isArray(data?.runs),
      runCount: data?.runs?.length ?? null,
      latestStartedAt: data?.latestStartedAt ?? null,
      oldestStartedAt: data?.oldestStartedAt ?? null,
      hasMore: data?.hasMore ?? null,
    });
    if (path.startsWith("/audit/session/")) {
      const sampleRuns = Array.isArray(data?.runs)
        ? data.runs.slice(0, 3).map((run) => ({
            runId: run?.runId ?? null,
            hasDetail: run?.hasDetail ?? null,
            turnCount: Array.isArray(run?.turns) ? run.turns.length : null,
            timelineCount: Array.isArray(run?.timeline) ? run.timeline.length : null,
            status: run?.status ?? null,
          }))
        : [];
      debugLog("apiFetch:sessionSample", path, sampleRuns);
    }
    return data;
  } catch (err) {
    debugLog("apiFetch:error", path, err instanceof Error ? err.message : err);
    return null;
  }
}

function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}
function fmtCost(n) {
  if (!n) return "$0";
  if (n < 0.001) return "<$0.001";
  return "$" + n.toFixed(n < 0.01 ? 4 : 3);
}
function fmtDur(ms) {
  if (!ms) return "—";
  if (ms < 1000) return ms + "ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60_000) + "m " + Math.floor((ms % 60_000) / 1000) + "s";
}
function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
function fmtRelTime(ts) {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function shortKey(key) {
  if (!key || key === "unknown") return "—";
  if (key.length > 28) return key.slice(0, 12) + "…" + key.slice(-8);
  return key;
}
function formatDuration(ms) {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60000) + "m " + Math.floor((ms % 60000) / 1000) + "s";
}

function getNiceTickStepMs(spanMs, targetTicks = 6) {
  const safeSpan = Math.max(1, spanMs);
  const rawStep = safeSpan / Math.max(2, targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  let nice = 1;
  if (normalized <= 1) nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 5) nice = 5;
  else nice = 10;
  return nice * magnitude;
}

function formatTimelineTick(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function buildTimelineTicks(scaleDuration) {
  const stepMs = getNiceTickStepMs(scaleDuration, 6);
  const ticks = [];
  for (let t = 0; t <= scaleDuration + stepMs * 0.3; t += stepMs) {
    ticks.push(Math.min(t, scaleDuration));
  }
  if (!ticks.length || ticks[0] !== 0) ticks.unshift(0);
  if (ticks[ticks.length - 1] < scaleDuration) ticks.push(scaleDuration);

  const dedup = [];
  for (const t of ticks) {
    if (!dedup.length || Math.abs(dedup[dedup.length - 1] - t) > 1e-6) dedup.push(t);
  }
  return dedup.map((ms) => ({
    ms,
    leftPct: Math.max(0, Math.min((ms / scaleDuration) * 100, 100)),
    label: formatTimelineTick(ms),
  }));
}

function selectVisibleTickLabels(ticks, scaleDuration) {
  if (!ticks.length) return [];
  const minLabelGapPct = scaleDuration >= 60_000 ? 16 : 12;
  const selected = ticks.map((tick, idx) => ({ ...tick, showLabel: idx === 0 || idx === ticks.length - 1 }));

  let lastShownPct = selected[0].leftPct;
  for (let i = 1; i < selected.length - 1; i++) {
    const tick = selected[i];
    if (tick.leftPct - lastShownPct >= minLabelGapPct) {
      tick.showLabel = true;
      lastShownPct = tick.leftPct;
    }
  }

  const lastIdx = selected.length - 1;
  let prevShown = -1;
  for (let i = lastIdx - 1; i >= 0; i--) {
    if (selected[i].showLabel) {
      prevShown = i;
      break;
    }
  }
  if (prevShown >= 0 && selected[lastIdx].leftPct - selected[prevShown].leftPct < minLabelGapPct * 0.9) {
    selected[prevShown].showLabel = false;
  }
  return selected;
}

function getRunRenderDuration(run, now = Date.now()) {
  const base = typeof run?.duration === "number" ? run.duration : 0;
  if (run?.status !== "running") return Math.max(base, 0);
  const startedAt = typeof run?.startedAt === "number" ? run.startedAt : null;
  if (!startedAt) return Math.max(base, 0);
  const runId = run?.runId;
  if (runId) {
    const live = LIVE_LLM_STREAM_BY_RUN.get(runId);
    if (live?.finalized) {
      const lastAt = Number(live.lastAt ?? live.startedAt ?? startedAt);
      const frozen = Math.max(0, lastAt - startedAt);
      return Math.max(base, frozen);
    }
  }
  return Math.max(base, now - startedAt);
}

function getLiveLlmSegment(run, now = Date.now()) {
  const runId = run?.runId;
  const runStartedAt = typeof run?.startedAt === "number" ? run.startedAt : null;
  if (!runId || !runStartedAt) return null;
  const live = LIVE_LLM_STREAM_BY_RUN.get(runId);
  if (!live) return null;
  const lastAt = Number(live.lastAt ?? live.startedAt);
  if (now - lastAt > LIVE_LLM_STALE_MS) {
    LIVE_LLM_STREAM_BY_RUN.delete(runId);
    return null;
  }
  const startRel = Math.max(0, live.startedAt - runStartedAt);
  const endAbs = live.finalized ? lastAt : Math.max(now, lastAt);
  const duration = Math.max(0, endAbs - live.startedAt);
  return {
    type: "llm_call",
    startedAt: startRel,
    duration,
    live: true,
  };
}

function getPersistedLlmStreamSegment(run) {
  const runStartedAt = typeof run?.startedAt === "number" ? run.startedAt : null;
  const firstAt = Number(run?.llmStream?.firstAt ?? 0) || 0;
  const lastAt = Number(run?.llmStream?.lastAt ?? 0) || 0;
  if (!runStartedAt || !firstAt || !lastAt) return null;
  if (lastAt < firstAt) return null;
  const startRel = Math.max(0, firstAt - runStartedAt);
  const duration = Math.max(0, lastAt - firstAt);
  return {
    type: "llm_call",
    startedAt: startRel,
    duration,
    live: true,
    persisted: true,
  };
}

function getTimelineScaleDuration(elapsedMs) {
  const elapsed = Math.max(0, elapsedMs);
  // Intentional stepped scale (requested UX):
  // 0-30s fixed 30s window, then 50s/65s/80s...
  if (elapsed < 30_000) return 30_000;
  const steps = Math.floor((elapsed - 30_000) / 15_000);
  return 50_000 + steps * 15_000;
}

function getTimelineScaleDurationForRun(runId, elapsedMs, runStatus) {
  const computed = getTimelineScaleDuration(elapsedMs);
  if (!runId) return computed;
  if (runStatus === "running") {
    TIMELINE_SCALE_BY_RUN.set(runId, computed);
    return computed;
  }
  const locked = TIMELINE_SCALE_BY_RUN.get(runId);
  if (typeof locked === "number" && Number.isFinite(locked) && locked > 0) {
    return locked;
  }
  TIMELINE_SCALE_BY_RUN.set(runId, computed);
  return computed;
}

// ── Data fetch ────────────────────────────────────────────────────────────

async function fetchOverview() {
  const d = await apiFetch("/overview");
  if (d) { S.overview = d; renderOverview(); }
}

async function fetchAuditSessions() {
  S.loadingSessions = true;
  renderSessionList();
  const q = `?days=${S.auditDays}${S.auditChannel ? "&channel=" + encodeURIComponent(S.auditChannel) : ""}`;
  const d = await apiFetch("/audit" + q);
  S.sessions = d ?? [];
  S.loadingSessions = false;
  renderSessionList();
}

async function selectSession(key) {
  S.selSession = key;
  S.runs = [];
  S.loadingRuns = true;
  renderDetail();
  // API returns { sessionKey, runs: RunAuditDetail[] }
  const d = await apiFetch("/audit/session/" + encodeURIComponent(key));
  S.runs = d?.runs ?? [];
  S.loadingRuns = false;
  renderDetail();
}

// ── SSE ───────────────────────────────────────────────────────────────────

function connectSSE() {
  const url = S.token
    ? `${API}/events?token=${encodeURIComponent(S.token)}`
    : `${API}/events`;
  const es = new EventSource(url);
  es.onopen = () => setSSEDot(true);
  es.onerror = () => setSSEDot(false);
  es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === "llm_stream_progress" && ev.runId) {
        LIVE_LLM_STREAM_BY_RUN.set(ev.runId, {
          startedAt: Number(ev.startedAt ?? Date.now()),
          lastAt: Number(ev.lastAt ?? Date.now()),
          chunkCount: Number(ev.chunkCount ?? 0),
          finalized: false,
        });
        if (CHAT_STATE.visible) updateAuditSidebarContent(true);
        if (S.selSession && ev.sessionKey === S.selSession) renderDetail();
        return;
      }
      if (ev.type === "llm_stream_end" && ev.runId) {
        const current = LIVE_LLM_STREAM_BY_RUN.get(ev.runId);
        LIVE_LLM_STREAM_BY_RUN.set(ev.runId, {
          startedAt: Number(current?.startedAt ?? ev.startedAt ?? Date.now()),
          lastAt: Number(ev.lastAt ?? current?.lastAt ?? Date.now()),
          chunkCount: Number(ev.chunkCount ?? current?.chunkCount ?? 0),
          finalized: true,
        });
        if (CHAT_STATE.visible) updateAuditSidebarContent(true);
        if (S.drawerOpen) renderDetail();
        return;
      }
      if (["run_started", "run_ended", "llm_call", "tool_executed", "transcript_turn"].includes(ev.type)) {
        fetchOverview();
        if (S.drawerOpen) fetchAuditSessions();
        if (S.selSession && ev.sessionKey === S.selSession) selectSession(S.selSession);
        if (CHAT_STATE.visible) {
          requestChatAuditRefresh(`sse:${ev.type}`, { force: true, withDetails: true });
          if (ev.runId && CHAT_STATE.expandedRunIds.has(ev.runId)) {
            void refreshChatRunDetail(ev.runId, { force: true });
          }
        }
      }
    } catch {}
  };
}

function setSSEDot(ok) {
  const el = document.getElementById("cl-sse-dot");
  if (el) el.style.color = ok ? "#22c55e" : "#f59e0b";
}

// ── Overview panel ────────────────────────────────────────────────────────

function renderOverview() {
  const ov = S.overview ?? {};
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("cl-active", ov.activeRuns ?? "—");
  set("cl-runs24", ov.totalRuns24h ?? "—");
  set("cl-tok24", fmtTokens(ov.totalTokens24h));
  set("cl-cost24", fmtCost(ov.totalCost24h));
}

function _createPanelEl() {
  if (!document.getElementById("cl-styles")) {
    const link = document.createElement("link");
    link.id = "cl-styles";
    link.rel = "stylesheet"; link.href = "/plugins/clawlens/ui/styles.css";
    document.head.appendChild(link);
  }
  const panel = document.createElement("div");
  panel.id = "clawlens-panel";
  panel.innerHTML = `
    <div class="cl-panel-header">
      <span class="cl-panel-title">ClawLens</span>
      <span id="cl-sse-dot" class="cl-sse-dot" title="SSE">●</span>
      <button id="cl-audit-btn" class="cl-audit-btn" title="打开 Audit 面板">Audit →</button>
    </div>
    <div class="cl-metrics">
      <div class="cl-metric"><div class="cl-val" id="cl-active">—</div><div class="cl-lbl">Active Runs</div></div>
      <div class="cl-metric"><div class="cl-val" id="cl-runs24">—</div><div class="cl-lbl">Runs (24h)</div></div>
      <div class="cl-metric"><div class="cl-val" id="cl-tok24">—</div><div class="cl-lbl">Tokens (24h)</div></div>
      <div class="cl-metric"><div class="cl-val" id="cl-cost24">—</div><div class="cl-lbl">Cost (24h)</div></div>
    </div>
  `;
  panel.querySelector("#cl-audit-btn").addEventListener("click", openDrawer);
  return panel;
}

function mountOverviewPanel() {
  if (!location.pathname.includes("/overview") && location.pathname !== "/") return;
  const grid = document.querySelector("main section.grid, section.grid");
  if (!grid) return;
  const existing = document.getElementById("clawlens-panel");
  if (existing && existing.parentElement === grid) return;
  if (existing) existing.remove();
  grid.insertBefore(_createPanelEl(), grid.firstChild);
  renderOverview();
}

// ── Audit drawer ──────────────────────────────────────────────────────────

function mountDrawer() {
  if (document.getElementById("cl-drawer")) return;
  const drawer = document.createElement("div");
  drawer.id = "cl-drawer";
  drawer.innerHTML = `
    <div id="cl-overlay" class="cl-overlay"></div>
    <div class="cl-drawer-panel">
      <div class="cl-drawer-header">
        <span class="cl-drawer-title">🔍 ClawLens Audit</span>
        <div class="cl-drawer-filters">
          <select id="cl-days-sel" class="cl-sel">
            <option value="1">今天</option>
            <option value="7" selected>最近 7 天</option>
            <option value="30">最近 30 天</option>
            <option value="0">全部</option>
          </select>
          <input id="cl-ch-input" class="cl-input" placeholder="Channel 筛选" type="text" />
          <button id="cl-refresh-btn" class="cl-icon-btn" title="刷新">↻</button>
        </div>
        <button id="cl-close-btn" class="cl-close-btn" title="关闭">✕</button>
      </div>
      <div class="cl-drawer-body">
        <div id="cl-session-list" class="cl-session-list"></div>
        <div id="cl-detail-pane" class="cl-detail-pane"></div>
      </div>
    </div>
  `;
  document.body.appendChild(drawer);

  document.getElementById("cl-overlay").addEventListener("click", closeDrawer);
  document.getElementById("cl-close-btn").addEventListener("click", closeDrawer);
  document.getElementById("cl-refresh-btn").addEventListener("click", () => {
    fetchAuditSessions();
    if (S.selSession) selectSession(S.selSession);
  });
  document.getElementById("cl-days-sel").addEventListener("change", (e) => {
    S.auditDays = Number(e.target.value);
    fetchAuditSessions();
  });
  document.getElementById("cl-ch-input").addEventListener("change", (e) => {
    S.auditChannel = e.target.value.trim();
    fetchAuditSessions();
  });
}

function openDrawer() {
  S.drawerOpen = true;
  mountDrawer();
  const drawer = document.getElementById("cl-drawer");
  drawer.classList.add("cl-drawer-open");
  fetchAuditSessions();
  renderDetail();
}

function closeDrawer() {
  S.drawerOpen = false;
  document.getElementById("cl-drawer")?.classList.remove("cl-drawer-open");
}

// ── Session list render ───────────────────────────────────────────────────

function renderSessionList() {
  const el = document.getElementById("cl-session-list");
  if (!el) return;

  if (S.loadingSessions) {
    el.innerHTML = `<div class="cl-loading">加载中…</div>`;
    return;
  }
  if (!S.sessions.length) {
    el.innerHTML = `<div class="cl-empty">暂无数据<br><small>还没有记录的会话</small></div>`;
    return;
  }

  el.innerHTML = S.sessions.map(s => {
    const active = s.session_key === S.selSession ? "cl-sess-active" : "";
    const ch = s.channel ? `<span class="cl-ch-badge">${esc(s.channel)}</span>` : "";
    const model = s.model ? `<span class="cl-model-badge">${esc(s.model.split("/").pop())}</span>` : "";
    return `
      <div class="cl-sess-item ${active}" data-key="${esc(s.session_key)}">
        <div class="cl-sess-key" title="${esc(s.session_key)}">${shortKey(s.session_key)}</div>
        <div class="cl-sess-badges">${ch}${model}</div>
        <div class="cl-sess-stats">
          <span>${s.run_count} runs</span>
          <span>${fmtTokens(s.total_tokens)} tok</span>
          <span>${fmtCost(s.total_cost)}</span>
        </div>
        <div class="cl-sess-time">${fmtRelTime(s.last_run_at)}</div>
      </div>
    `;
  }).join("");

  el.querySelectorAll(".cl-sess-item").forEach(item => {
    item.addEventListener("click", () => selectSession(item.dataset.key));
  });
}

// ── Detail pane render ────────────────────────────────────────────────────

function renderDetail() {
  const el = document.getElementById("cl-detail-pane");
  if (!el) return;

  if (!S.selSession) {
    el.innerHTML = `<div class="cl-empty">← 选择一个 Session</div>`;
    return;
  }
  if (S.loadingRuns) {
    el.innerHTML = `<div class="cl-loading">加载 runs…</div>`;
    return;
  }
  if (!S.runs.length) {
    el.innerHTML = `<div class="cl-empty">该 Session 暂无 Run 数据</div>`;
    return;
  }

  const sessionInfo = S.sessions.find(s => s.session_key === S.selSession);
  const headerHtml = sessionInfo ? `
    <div class="cl-detail-header">
      <div class="cl-detail-key" title="${esc(S.selSession)}">${esc(S.selSession)}</div>
      <div class="cl-detail-summary">
        ${sessionInfo.run_count} runs ·
        ${fmtTokens(sessionInfo.total_tokens)} tokens ·
        ${fmtCost(sessionInfo.total_cost)} ·
        avg ${fmtDur(sessionInfo.avg_duration_ms)}
      </div>
    </div>
  ` : "";

  // Use the shared audit panel renderer — same as chat sidebar
  el.innerHTML = headerHtml + `<div class="clawlens-audit-body">${renderAuditPanel({ runs: S.runs })}</div>`;
  bindAuditPanelInteractions(el);
}

// ── Shared audit panel renderer ───────────────────────────────────────────
// Returns run card HTML without outer wrapper — caller provides the container.

function renderAuditPanel(data) {
  const expandedRunIds = arguments[1]?.expandedRunIds ?? null;
  const loadingRunIds = arguments[1]?.loadingRunIds ?? null;
  const defaultExpandFirst = arguments[1]?.defaultExpandFirst ?? true;
  if (!data || !data.runs?.length) {
    return '<div style="color:var(--muted,#838387);padding:20px;text-align:center">No audit data for this session</div>';
  }
  const now = Date.now();
  const visibleRunIds = new Set(data.runs.map((run) => run?.runId).filter(Boolean));
  for (const runId of TIMELINE_SCALE_BY_RUN.keys()) {
    if (!visibleRunIds.has(runId)) TIMELINE_SCALE_BY_RUN.delete(runId);
  }
  for (const runId of LIVE_LLM_STREAM_BY_RUN.keys()) {
    if (!visibleRunIds.has(runId)) LIVE_LLM_STREAM_BY_RUN.delete(runId);
  }
  return data.runs.map((run, i) => {
    const runDuration = getRunRenderDuration(run, now);
    const liveLlmSegment = getLiveLlmSegment(run, now)
      ?? (run?.status === "running" ? null : getPersistedLlmStreamSegment(run));
    const hasUserMarker = run?.runKind !== "heartbeat";
    return `
    <div class="clawlens-audit-run${isRunExpanded(run.runId, i, expandedRunIds, defaultExpandFirst) ? " expanded" : ""}" data-run-id="${esc(run.runId)}">
      <div class="clawlens-audit-run-hdr" data-run-id="${esc(run.runId)}">
        <div class="clawlens-audit-run-top">
          <span class="clawlens-audit-run-num">#${i + 1} Run</span>
          <span class="clawlens-audit-run-time">${formatDuration(runDuration)}</span>
        </div>
        <div class="clawlens-audit-run-prompt">${esc(run.userPrompt || "(no prompt)")}</div>
        <div class="clawlens-audit-run-stats">
          ${run.runKind === "heartbeat" ? '<span class="clawlens-tag exclusive">HEARTBEAT</span>' : ""}
          <span>${run.summary?.llmCalls ?? 0} LLM</span>
          <span>${run.summary?.toolCalls ?? 0} tool</span>
          <span>${fmtTokens((run.summary?.totalInputTokens ?? 0) + (run.summary?.totalOutputTokens ?? 0))} tok</span>
          <span class="cost">${fmtCost(run.summary?.officialCost ?? run.summary?.calculatedCost ?? run.summary?.totalCost)}</span>
        </div>
      </div>
      <div class="clawlens-audit-run-detail">
        ${renderRunDetailStatus(run, loadingRunIds)}
        <div class="clawlens-section-label">Timeline</div>
        <div class="clawlens-tl-legend">
          <span><span class="clawlens-tl-legend-dot" style="background:#f59e0b"></span>User</span>
          <span><span class="clawlens-tl-legend-dot" style="background:var(--info,#3b82f6)"></span>LLM</span>
          <span><span class="clawlens-tl-legend-dot" style="background:var(--ok,#22c55e)"></span>Tool</span>
        </div>
        ${needsRunDetailFetch(run) ? renderDeferredTimelineHint() : renderTimeline(run.timeline, runDuration, run.status, liveLlmSegment, run.runId, hasUserMarker)}
        <div class="clawlens-section-label" style="margin-top:8px">Turns</div>
        <div class="clawlens-turns">${needsRunDetailFetch(run) ? renderDeferredTurnsHint(loadingRunIds?.has(run.runId)) : renderTurns(run.turns)}</div>
      </div>
    </div>
  `;
  }).join("");
}

function isRunExpanded(runId, idx, expandedRunIds, defaultExpandFirst) {
  if (expandedRunIds?.size) return expandedRunIds.has(runId);
  return defaultExpandFirst && idx === 0;
}

function renderRunDetailStatus(run, loadingRunIds) {
  if (needsRunDetailFetch(run) && loadingRunIds?.has(run.runId)) {
    return '<div style="color:var(--muted,#838387);font-size:11px;padding:8px 0">Loading detail…</div>';
  }
  if (needsRunDetailFetch(run)) {
    return '<div style="color:var(--muted,#838387);font-size:11px;padding:8px 0">Click to load full timeline and turns.</div>';
  }
  return "";
}

function needsRunDetailFetch(run) {
  if (!run) return true;
  if (run.hasDetail === false) return true;
  const turns = Array.isArray(run.turns) ? run.turns : null;
  const timeline = Array.isArray(run.timeline) ? run.timeline : null;
  const hasTurns = !!turns?.length;
  const hasTimeline = !!timeline?.length;
  const llmCalls = run.summary?.llmCalls ?? 0;
  const toolCalls = run.summary?.toolCalls ?? 0;
  const hasRecordedActivity = llmCalls > 0 || toolCalls > 0;
  if (hasTurns || hasTimeline) return false;
  if (run.hasDetail === true && !hasRecordedActivity) return false;
  return true;
}

function renderDeferredTimelineHint() {
  return '<div style="color:var(--muted,#838387);font-size:11px;padding:4px 0 8px">Expand this run to load full timeline.</div>';
}

function renderDeferredTurnsHint(isLoading) {
  if (isLoading) {
    return '<div style="color:var(--muted,#838387);font-size:11px;padding:4px 0">Loading turns…</div>';
  }
  return '<div style="color:var(--muted,#838387);font-size:11px;padding:4px 0">Expand this run to load turns.</div>';
}

function renderTimeline(timeline, totalDuration, runStatus, liveLlmSegment, runId, hasUserMarker) {
  const minWidthPct = 1.8;
  const minGapPct = 1.0;
  const sourceTimeline = Array.isArray(timeline) ? [...timeline] : [];
  const nonLiveLlmCalls = sourceTimeline.filter((entry) => entry?.type === "llm_call" && entry?.live !== true);
  const hasDetailedLlmCalls = nonLiveLlmCalls.length > 1;
  const shouldOverlayLlmSegment = !!liveLlmSegment && (!liveLlmSegment.persisted || !hasDetailedLlmCalls);
  if (shouldOverlayLlmSegment && runStatus === "running") {
    sourceTimeline.push(liveLlmSegment);
  }
  if (shouldOverlayLlmSegment && runStatus !== "running") {
    sourceTimeline.push({ ...liveLlmSegment, live: true });
  }
  const hasAnyEvent = sourceTimeline.length > 0;
  const parsed = sourceTimeline.map((entry, idx) => {
    const startMs = Math.max(0, Number(entry.startedAt ?? 0) || 0);
    const durationMs = Math.max(0, Number(entry.duration ?? 0) || 0);
    const endMs = Math.max(startMs + durationMs, startMs);
    return { entry, idx, startMs, durationMs, endMs, isTool: entry.type === "tool_execution" };
  });
  const toolEntries = parsed.filter((item) => item.isTool);
  const hasToolEvent = toolEntries.length > 0;
  const firstToolStart = hasToolEvent ? Math.min(...toolEntries.map((item) => item.startMs)) : 0;
  const lastToolEnd = hasToolEvent ? Math.max(...toolEntries.map((item) => item.endMs)) : 0;

  // Detect "envelope" LLM calls that only represent whole-turn aggregation.
  // These should be rendered as endpoint markers instead of full-width bars.
  const preferLiveEnvelope = shouldOverlayLlmSegment;
  const summaryLlmIds = new Set(
    parsed
      .filter((item) => item.entry.type === "llm_call")
      .filter((item) => {
        if (preferLiveEnvelope && item.entry?.live !== true) return true;
        if (!hasToolEvent) return false;
        if (item.entry?.live === true) return false;
        const nearRunStart = item.startMs <= Math.max(1000, totalDuration * 0.06);
        const longEnough = item.durationMs >= totalDuration * 0.45;
        const coversTools = item.startMs <= firstToolStart && item.endMs >= lastToolEnd;
        return nearRunStart && longEnough && coversTools;
      })
      .map((item) => item.idx),
  );

  const effectiveEntries = parsed.filter((item) => !summaryLlmIds.has(item.idx));
  const maxEndMs = parsed.reduce((max, item) => Math.max(max, item.endMs), 0);
  const activeSpanMs = runStatus === "running"
    ? Math.max(totalDuration ?? 0, maxEndMs, 1)
    : Math.max(maxEndMs, totalDuration ?? 0, 1);
  const scaleDuration = getTimelineScaleDurationForRun(runId, activeSpanMs, runStatus);

  const rawSegments = effectiveEntries
    .map((item) => {
      const left = Math.max(0, Math.min((item.startMs / scaleDuration) * 100, 100));
      const fixedWidthPct = Number(item.entry.fixedWidthPct ?? 0) || 0;
      const width = Math.max((item.durationMs / scaleDuration) * 100, minWidthPct, fixedWidthPct);
      return {
        entry: item.entry,
        startMs: item.startMs,
        endMs: item.endMs,
        rawLeft: left,
        left,
        width: Math.min(width, 100),
      };
    })
    .sort((a, b) => a.left - b.left);

  const markerSegments = [];

  const ticks = selectVisibleTickLabels(buildTimelineTicks(scaleDuration), scaleDuration);
  const rulerHtml =
    '<div class="clawlens-timeline-ruler">' +
    ticks.map(({ leftPct, label, showLabel }) => {
      const edgeClass = leftPct >= 96 ? " end" : "";
      const labelHtml = showLabel ? `<span>${esc(label)}</span>` : "";
      return `<div class="clawlens-tl-tick${edgeClass}${showLabel ? "" : " no-label"}" style="left:${leftPct.toFixed(2)}%">${labelHtml}</div>`;
    }).join("") +
    "</div>";
  const gridHtml = ticks
    .map(({ leftPct }) => `<div class="clawlens-tl-gridline" style="left:${leftPct.toFixed(2)}%"></div>`)
    .join("");

  const segments = [...rawSegments, ...markerSegments].sort((a, b) => a.left - b.left);
  const maxShiftPct = runStatus === "running" ? 6 : 3.2;
  const minSegWidth = 1.1;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.left + segment.width > 100) {
      segment.left = Math.max(0, 100 - segment.width);
    }
    if (i === 0) continue;
    const prev = segments[i - 1];
    let overlap = prev.left + prev.width + minGapPct - segment.left;
    if (overlap <= 0) continue;

    // First try right-shift current segment with a bounded drift from raw position.
    const maxRight = Math.min(100 - segment.width, segment.rawLeft + maxShiftPct);
    if (segment.left < maxRight) {
      const shift = Math.min(overlap, maxRight - segment.left);
      segment.left += shift;
      overlap -= shift;
    }

    if (overlap > 0) {
      // Fallback: shrink neighboring widths to preserve a visible gap.
      const prevMin = prev.marker ? 2.8 : minSegWidth;
      const curMin = segment.marker ? 2.8 : minSegWidth;
      const prevReducible = Math.max(0, prev.width - prevMin);
      const prevTake = Math.min(prevReducible, overlap);
      prev.width -= prevTake;
      overlap -= prevTake;
    }
    if (overlap > 0) {
      const curMin = segment.marker ? 2.8 : minSegWidth;
      const curReducible = Math.max(0, segment.width - curMin);
      const curTake = Math.min(curReducible, overlap);
      segment.width -= curTake;
      overlap -= curTake;
      if (segment.left + segment.width > 100) {
        segment.left = Math.max(0, 100 - segment.width);
      }
    }
  }

  const emptyHint = !hasAnyEvent ? '<div class="clawlens-tl-empty-hint">waiting for first event…</div>' : "";
  const userMarkerHtml = hasUserMarker
    ? `<div class="clawlens-tl-user" style="left:0%;width:${USER_MARKER_WIDTH_PCT.toFixed(2)}%" title="User message"></div>`
    : "";
  return '<div class="clawlens-timeline-wrap">' + rulerHtml + '<div class="clawlens-timeline-bar">' +
    gridHtml + userMarkerHtml + segments.map(({ entry, left, width, marker }) => {
      const rawDuration = Math.max(0, Number(entry.duration ?? 0) || 0);
      const durationText = formatDuration(rawDuration);
      const cls = entry.type === "llm_call"
        ? `clawlens-tl-llm${marker ? " clawlens-tl-llm-marker" : ""}`
        : "clawlens-tl-tool";
      const label = entry.type === "llm_call"
        ? `LLM ${durationText}`
        : `${entry.toolName || "tool"} ${durationText}`;
      const text = marker ? "" : (width >= 12 ? durationText : "");
      return `<div class="${cls}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%" title="${esc(label)}">${text}</div>`;
    }).join("") + emptyHint + "</div></div>";
}

function renderTurns(turns) {
  debugLog("renderTurns", {
    hasTurns: Array.isArray(turns),
    turnCount: turns?.length ?? null,
    sample: Array.isArray(turns) ? turns.slice(0, 2).map((t) => ({ role: t?.role ?? null, previewLen: t?.preview?.length ?? 0 })) : null,
  });
  if (!turns?.length) {
    return '<div style="color:var(--muted,#838387);font-size:11px;padding:4px 0">No turns captured for this run.</div>';
  }
  return turns.map(t => {
    const preview = t.preview ?? "";
    return `
    <div class="clawlens-turn" title="${esc(preview)}">
      <span class="clawlens-turn-role ${esc(t.role)}">${esc(t.role)}</span>
      <span class="clawlens-turn-preview">${esc(preview)}</span>
    </div>
  `}).join("");
}

function bindAuditPanelInteractions(root) {
  if (!root || root.dataset.clawlensAuditBound === "1") return;
  root.dataset.clawlensAuditBound = "1";
  root.addEventListener("click", async (e) => {
    const turn = e.target.closest(".clawlens-turn");
    if (turn && root.contains(turn)) {
      turn.classList.toggle("expanded");
      return;
    }

    const hdr = e.target.closest(".clawlens-audit-run-hdr");
    if (hdr && root.contains(hdr)) {
      if (root.id === "clawlens-audit-sidebar-body") {
        await toggleChatRunExpanded(hdr.dataset.runId);
        return;
      }
      const runEl = hdr.parentElement;
      runEl?.classList.toggle("expanded");
    }
  });
}

function renderAuditEmptyState(sessionKey, resolvedFrom) {
  const keyLabel = esc(sessionKey || "unknown");
  const resolved = resolvedFrom && resolvedFrom !== sessionKey
    ? `<div style="margin-top:6px;font-size:11px;color:var(--muted,#838387)">using fallback: ${esc(resolvedFrom)}</div>`
    : "";
  return `
    <div style="color:var(--muted,#838387);padding:20px;text-align:center;line-height:1.6">
      <div>No audit data for this session</div>
      <div style="margin-top:6px;font-size:11px">session: ${keyLabel}</div>
      ${resolved}
    </div>
  `;
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function main() {
  await new Promise(resolve => {
    const check = () => document.querySelector("openclaw-app, main, body") && resolve();
    const obs = new MutationObserver(check);
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(check, 0);
    setTimeout(resolve, 10_000);
  });

  S.token = getToken();
  mountOverviewPanel();

  await fetchOverview();
  setInterval(fetchOverview, OVERVIEW_INTERVAL);

  connectSSE();
}

main().catch(console.error);

// ── Chat Audit Sidebar ────────────────────────────────────────────────────

const CHAT_STATE = {
  visible: false,
  sessionKey: null,
  sourceSessionKey: null,
  data: null,
  pollTimer: null,
  liveRenderTimer: null,
  loading: false,
  loadingMore: false,
  refreshing: false,
  loadError: null,
  latestStartedAt: null,
  oldestStartedAt: null,
  hasMore: false,
  expandedRunIds: new Set(),
  loadingRunIds: new Set(),
  currentMessageRunId: null,
  currentMessageStatus: null,
  currentMessageLookupBasis: null,
  currentMessageSourceKind: null,
  lastDomMessageFingerprint: null,
  domRefreshTimer: null,
  autoExpandDone: false,
  pointerInsideSidebar: false,
  suppressRenderUntil: 0,
  pendingSidebarRender: false,
  deferredRenderTimer: null,
  refreshTimer: null,
  pendingRefreshReason: null,
  pendingRefreshWithDetails: false,
  lastRefreshAt: 0,
  lastRouteSignature: null,
  lastDetailRefreshAt: new Map(),
  lastDataSignature: null,
};

const SIDEBAR_RENDER_SUPPRESS_MS = 800;
const CHAT_AUDIT_REFRESH_MIN_GAP_MS = 1200;
const CHAT_AUDIT_DETAIL_REFRESH_MIN_GAP_MS = 2500;
const CHAT_AUDIT_LIVE_RENDER_INTERVAL_MS = 1000;

function getCurrentSessionSelection() {
  const url = new URL(location.href);
  const raw = url.searchParams.get("session")
    ?? document.querySelector(".chat-session select")?.value
    ?? null;
  if (!raw) return null;
  return {
    raw,
    resolved: raw.includes(":") ? raw : "agent:main:main",
  };
}

function isInChatView() {
  return location.pathname.includes("/chat") || !!document.querySelector(".chat-split-container");
}

function getLatestChatDomMessageCandidate() {
  const groups = Array.from(document.querySelectorAll(".chat-group"));
  if (!groups.length) return null;
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    const role = group.classList.contains("user")
      ? "user"
      : group.classList.contains("assistant")
        ? "assistant"
        : group.classList.contains("tool")
          ? "tool"
          : null;
    if (!role) continue;
    const textNodes = Array.from(group.querySelectorAll(".chat-text, .chat-sender-name"))
      .map((node) => node.textContent?.trim() ?? "")
      .filter(Boolean);
    const text = textNodes.join(" | ").trim();
    if (!text) continue;
    return {
      role,
      text,
      fingerprint: `${role}:${text.slice(0, 240)}`,
    };
  }
  return null;
}

function scheduleDomDrivenAuditRefresh(reason) {
  if (!isInChatView()) return;
  if (!CHAT_STATE.visible) return;
  if (document.hidden) return;
  if (CHAT_STATE.domRefreshTimer) clearTimeout(CHAT_STATE.domRefreshTimer);
  CHAT_STATE.domRefreshTimer = setTimeout(async () => {
    CHAT_STATE.domRefreshTimer = null;
    const candidate = getLatestChatDomMessageCandidate();
    if (!candidate) return;
    if (candidate.fingerprint === CHAT_STATE.lastDomMessageFingerprint) return;
    CHAT_STATE.lastDomMessageFingerprint = candidate.fingerprint;
    if (candidate.role !== "user" && candidate.role !== "assistant") return;
    debugLog("domRefresh", { reason, role: candidate.role, textPreview: candidate.text.slice(0, 120) });
    requestChatAuditRefresh(`dom:${reason}`, { withDetails: true });
  }, 250);
}

function clearScheduledChatAuditRefresh() {
  if (CHAT_STATE.refreshTimer) {
    clearTimeout(CHAT_STATE.refreshTimer);
    CHAT_STATE.refreshTimer = null;
  }
}

function requestChatAuditRefresh(reason, opts = {}) {
  const withDetails = opts.withDetails === true;
  const force = opts.force === true;
  if (!CHAT_STATE.visible && !force) return;
  if (document.hidden && !force) return;

  CHAT_STATE.pendingRefreshReason = reason;
  CHAT_STATE.pendingRefreshWithDetails = CHAT_STATE.pendingRefreshWithDetails || withDetails;

  if (CHAT_STATE.loading || CHAT_STATE.refreshing) {
    return;
  }

  const now = Date.now();
  const waitMs = force ? 0 : Math.max(0, CHAT_AUDIT_REFRESH_MIN_GAP_MS - (now - CHAT_STATE.lastRefreshAt));
  if (CHAT_STATE.refreshTimer && !force) return;

  clearScheduledChatAuditRefresh();
  CHAT_STATE.refreshTimer = setTimeout(async () => {
    CHAT_STATE.refreshTimer = null;
    const queuedReason = CHAT_STATE.pendingRefreshReason ?? reason;
    const queuedWithDetails = CHAT_STATE.pendingRefreshWithDetails;
    CHAT_STATE.pendingRefreshReason = null;
    CHAT_STATE.pendingRefreshWithDetails = false;
    CHAT_STATE.lastRefreshAt = Date.now();
    debugLog("requestChatAuditRefresh:run", {
      reason: queuedReason,
      withDetails: queuedWithDetails,
      force,
    });
    await refreshChatAudit();
    if (queuedWithDetails) {
      await refreshExpandedChatRunDetails();
    }
    if (CHAT_STATE.pendingRefreshReason) {
      requestChatAuditRefresh(CHAT_STATE.pendingRefreshReason, {
        withDetails: CHAT_STATE.pendingRefreshWithDetails,
      });
    }
  }, waitMs);
}

function updateAuditSidebarContent(forceImmediate = false) {
  updateAuditHeaderBindHealth();
  const body = document.getElementById("clawlens-audit-sidebar-body");
  if (!body) return;
  const now = Date.now();
  const hasRenderedStableContent = body.dataset.clawlensRenderedStable === "1";
  if (!forceImmediate && hasRenderedStableContent && (CHAT_STATE.pointerInsideSidebar || CHAT_STATE.suppressRenderUntil > now)) {
    CHAT_STATE.pendingSidebarRender = true;
    scheduleDeferredSidebarRender();
    return;
  }
  CHAT_STATE.pendingSidebarRender = false;
  debugLog("updateSidebar", {
    visible: CHAT_STATE.visible,
    hasData: !!CHAT_STATE.data,
    runCount: CHAT_STATE.data?.runs?.length ?? 0,
    loadError: CHAT_STATE.loadError,
    loading: CHAT_STATE.loading,
    refreshing: CHAT_STATE.refreshing,
    latestStartedAt: CHAT_STATE.latestStartedAt,
  });
  if (CHAT_STATE.loadError) {
    body.dataset.clawlensRenderedStable = "1";
    body.innerHTML = `<div style="color:var(--destructive,#ef4444);padding:20px;text-align:center;line-height:1.6">${esc(CHAT_STATE.loadError)}</div>`;
    return;
  }
  if (!CHAT_STATE.data) {
    body.dataset.clawlensRenderedStable = "0";
    body.innerHTML = '<div style="color:var(--muted,#838387);padding:20px;text-align:center">Loading…</div>';
    return;
  }
  CHAT_STATE.lastDataSignature = buildChatAuditDataSignature(CHAT_STATE.data);
  if (!CHAT_STATE.data.runs?.length) {
    body.dataset.clawlensRenderedStable = "1";
    body.innerHTML = renderAuditEmptyState(
      CHAT_STATE.sourceSessionKey ?? CHAT_STATE.sessionKey,
      CHAT_STATE.data._resolvedFrom ?? CHAT_STATE.sessionKey,
    );
    return;
  }
  // body already has clawlens-audit-body class; renderAuditPanel returns inner content only
  const footer = CHAT_STATE.hasMore
    ? `<button id="clawlens-audit-load-more" class="clawlens-audit-load-more">${CHAT_STATE.loadingMore ? "Loading…" : "Load older runs"}</button>`
    : "";
  const hasExpanded = CHAT_STATE.expandedRunIds.size > 0;
  body.innerHTML = renderAuditPanel(CHAT_STATE.data, {
    expandedRunIds: CHAT_STATE.expandedRunIds,
    loadingRunIds: CHAT_STATE.loadingRunIds,
    defaultExpandFirst: !hasExpanded && !CHAT_STATE.autoExpandDone,
  }) + footer;
  body.dataset.clawlensRenderedStable = "1";
  bindAuditPanelInteractions(body);
  body.onscroll = () => {
    if (!CHAT_STATE.hasMore || CHAT_STATE.loadingMore) return;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 120) {
      loadOlderChatAudit();
    }
  };
  document.getElementById("clawlens-audit-load-more")?.addEventListener("click", loadOlderChatAudit);
}

function resolveAuditBindHealth() {
  const rawKey = CHAT_STATE.sourceSessionKey ?? CHAT_STATE.sessionKey ?? "";
  const resolvedKey = CHAT_STATE.sessionKey ?? "";
  const status = CHAT_STATE.currentMessageStatus ?? "";
  const lookupBasis = CHAT_STATE.currentMessageLookupBasis ?? "";
  const sourceKind = CHAT_STATE.currentMessageSourceKind ?? "";

  if (rawKey === "unknown" || resolvedKey === "unknown") {
    return {
      level: "error",
      label: "UNKNOWN SESSION",
      title: "Session key is unknown. Binding may rely on fallback mapping.",
    };
  }
  if (status === "fallback" || lookupBasis === "latest-run" || sourceKind === "session_fallback") {
    return {
      level: "warn",
      label: "FALLBACK BIND",
      title: `Current-message binding uses fallback (${lookupBasis || "unknown basis"}).`,
    };
  }
  if (status === "pending" || status === "none") {
    return {
      level: "warn",
      label: "UNRESOLVED",
      title: "Current message run is not resolved yet.",
    };
  }
  return null;
}

function updateAuditHeaderBindHealth() {
  const badge = document.getElementById("clawlens-audit-bind-health");
  if (!badge) return;
  const health = resolveAuditBindHealth();
  if (!health) {
    badge.className = "clawlens-audit-bind-health hidden";
    badge.textContent = "";
    badge.removeAttribute("title");
    return;
  }
  badge.className = `clawlens-audit-bind-health ${health.level}`;
  badge.textContent = health.label;
  badge.title = health.title;
}

function scheduleDeferredSidebarRender() {
  if (CHAT_STATE.deferredRenderTimer) return;
  const delay = Math.max(100, CHAT_STATE.suppressRenderUntil - Date.now());
  CHAT_STATE.deferredRenderTimer = setTimeout(() => {
    CHAT_STATE.deferredRenderTimer = null;
    if (!CHAT_STATE.visible) return;
    if (CHAT_STATE.pointerInsideSidebar || CHAT_STATE.suppressRenderUntil > Date.now()) {
      scheduleDeferredSidebarRender();
      return;
    }
    if (CHAT_STATE.pendingSidebarRender) {
      updateAuditSidebarContent();
    }
  }, delay);
}

function bumpSidebarInteractionWindow(ms = SIDEBAR_RENDER_SUPPRESS_MS) {
  CHAT_STATE.suppressRenderUntil = Math.max(CHAT_STATE.suppressRenderUntil, Date.now() + ms);
}


function setupResizeHandle(sidebar) {
  const handle = sidebar.querySelector(".clawlens-resize-handle");
  if (!handle) return;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    handle.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener("pointermove", (e) => {
    if (!handle.classList.contains("dragging")) return;
    const delta = startX - e.clientX;
    const minW = 240;
    const maxW = Math.min(760, Math.floor(window.innerWidth * 0.85));
    const newWidth = Math.max(minW, Math.min(maxW, startWidth + delta));
    document.documentElement.style.setProperty("--clawlens-audit-width", newWidth + "px");
  });

  handle.addEventListener("pointerup", () => {
    handle.classList.remove("dragging");
  });
}

function mountChatAuditSidebar() {
  if (document.getElementById("clawlens-audit-sidebar")) return;

  const sidebar = document.createElement("div");
  sidebar.id = "clawlens-audit-sidebar";
  sidebar.className = "clawlens-audit-sidebar";
  sidebar.innerHTML = `
    <div class="clawlens-resize-handle" title="拖拽调整宽度"></div>
    <div class="clawlens-audit-header">
      <div class="clawlens-audit-header-left">
        <span class="clawlens-audit-title">ClawLens Audit</span>
        <span id="clawlens-audit-bind-health" class="clawlens-audit-bind-health hidden"></span>
      </div>
      <button class="clawlens-audit-close" id="clawlens-audit-close-btn" title="Close">✕</button>
    </div>
    <div id="clawlens-audit-sidebar-body" class="clawlens-audit-body">
      <div style="color:var(--muted,#838387);padding:20px;text-align:center">Loading…</div>
    </div>
  `;
  document.body.appendChild(sidebar);
  document.getElementById("clawlens-audit-close-btn")?.addEventListener("click", hideChatAuditSidebar);
  sidebar.addEventListener("pointerenter", () => {
    CHAT_STATE.pointerInsideSidebar = true;
    bumpSidebarInteractionWindow();
  });
  sidebar.addEventListener("pointerleave", () => {
    CHAT_STATE.pointerInsideSidebar = false;
    bumpSidebarInteractionWindow(150);
    scheduleDeferredSidebarRender();
  });
  sidebar.addEventListener("pointerdown", () => {
    bumpSidebarInteractionWindow();
  });
  setupResizeHandle(sidebar);
  document.body.classList.add("clawlens-audit-open");
  CHAT_STATE.visible = true;
  debugLog("mountSidebar", {
    sessionKey: CHAT_STATE.sessionKey,
    sourceSessionKey: CHAT_STATE.sourceSessionKey,
    hasData: !!CHAT_STATE.data,
    runCount: CHAT_STATE.data?.runs?.length ?? 0,
    loadError: CHAT_STATE.loadError,
  });
  if (CHAT_STATE.data?.runs?.length || CHAT_STATE.loadError) {
    updateAuditSidebarContent();
    void refreshCurrentMessageRunHint();
  }
  // Fetch immediately after mount. Hidden-state prefetch is intentionally avoided.
  requestChatAuditRefresh("sidebar-open", { force: true, withDetails: true });
}

function hideChatAuditSidebar() {
  debugLog("hideSidebar", {
    sessionKey: CHAT_STATE.sessionKey,
    hasData: !!CHAT_STATE.data,
    runCount: CHAT_STATE.data?.runs?.length ?? 0,
  });
  const sidebar = document.getElementById("clawlens-audit-sidebar");
  if (sidebar) sidebar.remove();
  document.body.classList.remove("clawlens-audit-open");
  CHAT_STATE.visible = false;
  CHAT_STATE.pointerInsideSidebar = false;
  CHAT_STATE.pendingSidebarRender = false;
  CHAT_STATE.suppressRenderUntil = 0;
  if (CHAT_STATE.deferredRenderTimer) {
    clearTimeout(CHAT_STATE.deferredRenderTimer);
    CHAT_STATE.deferredRenderTimer = null;
  }
  if (CHAT_STATE.pollTimer) {
    clearInterval(CHAT_STATE.pollTimer);
    CHAT_STATE.pollTimer = null;
  }
  if (CHAT_STATE.liveRenderTimer) {
    clearInterval(CHAT_STATE.liveRenderTimer);
    CHAT_STATE.liveRenderTimer = null;
  }
}

function toggleChatAuditSidebar() {
  if (CHAT_STATE.visible) { hideChatAuditSidebar(); } else { mountChatAuditSidebar(); }
}

function injectAuditToggleBtn() {
  if (document.getElementById("clawlens-audit-toggle-btn")) return;
  const header = document.querySelector(".chat-header, .chat-topbar, .topbar");
  if (!header) return;
  const btn = document.createElement("button");
  btn.id = "clawlens-audit-toggle-btn";
  btn.className = "clawlens-audit-toggle";
  btn.textContent = "Audit";
  btn.addEventListener("click", toggleChatAuditSidebar);
  header.appendChild(btn);
}

function mergeRuns(existing, incoming, mode) {
  const existingMap = new Map((existing ?? []).filter((run) => run?.runId).map((run) => [run.runId, run]));
  const incomingMap = new Map((incoming ?? []).filter((run) => run?.runId).map((run) => [run.runId, run]));
  const orderedIds = mode === "prepend"
    ? [...incomingMap.keys(), ...existingMap.keys()]
    : [...existingMap.keys(), ...incomingMap.keys()];
  const seen = new Set();
  const out = [];
  for (const runId of orderedIds) {
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    const prev = existingMap.get(runId);
    const next = incomingMap.get(runId);
    if (prev && next) {
      const preserveDetail = prev.hasDetail === true;
      out.push(preserveDetail ? { ...next, ...prev, hasDetail: true } : { ...prev, ...next });
      continue;
    }
    if (next) {
      out.push(next);
      continue;
    }
    if (prev) {
      out.push(prev);
    }
  }
  out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return out;
}

function buildChatAuditDataSignature(data) {
  const runs = Array.isArray(data?.runs) ? data.runs : [];
  return JSON.stringify({
    latestStartedAt: data?.latestStartedAt ?? null,
    oldestStartedAt: data?.oldestStartedAt ?? null,
    hasMore: !!data?.hasMore,
    runs: runs.map((run) => ({
      runId: run?.runId ?? null,
      status: run?.status ?? null,
      hasDetail: run?.hasDetail ?? null,
      duration: run?.duration ?? null,
      runKind: run?.runKind ?? null,
      llmCalls: run?.summary?.llmCalls ?? null,
      toolCalls: run?.summary?.toolCalls ?? null,
      totalInputTokens: run?.summary?.totalInputTokens ?? null,
      totalOutputTokens: run?.summary?.totalOutputTokens ?? null,
      totalCost: run?.summary?.totalCost ?? null,
      turnCount: Array.isArray(run?.turns) ? run.turns.length : null,
      timelineCount: Array.isArray(run?.timeline) ? run.timeline.length : null,
    })),
  });
}

function getNewestIncomingRunId(incomingRuns) {
  if (!Array.isArray(incomingRuns) || !incomingRuns.length) return null;
  const sorted = [...incomingRuns].sort((a, b) => (b?.startedAt ?? 0) - (a?.startedAt ?? 0));
  return sorted[0]?.runId ?? null;
}

async function fetchChatAuditChunk(params = {}) {
  if (!CHAT_STATE.sessionKey) return null;
  const usp = new URLSearchParams();
  const limit = params.limit ?? 10;
  usp.set("limit", String(limit));
  usp.set("compact", "1");
  usp.append("excludeKinds", "heartbeat");
  usp.set("requireConversation", "1");
  if (params.before) usp.set("before", String(params.before));
  if (params.since) usp.set("since", String(params.since));
  const path = "/audit/session/" + encodeURIComponent(CHAT_STATE.sessionKey) + "?" + usp.toString();
  debugLog("fetchChatAuditChunk", {
    sessionKey: CHAT_STATE.sessionKey,
    params,
    path,
  });
  return await apiFetch(path);
}

async function fetchCurrentMessageRun(sessionKey) {
  if (!sessionKey) return null;
  const path = "/audit/session/" + encodeURIComponent(sessionKey) + "/current-message-run";
  debugLog("fetchCurrentMessageRun", { sessionKey, path });
  return await apiFetch(path);
}

async function refreshCurrentMessageRunHint() {
  if (!CHAT_STATE.sessionKey || !CHAT_STATE.data?.runs?.length) return;
  const hint = await fetchCurrentMessageRun(CHAT_STATE.sessionKey);
  if (!hint) return;
  CHAT_STATE.currentMessageStatus = hint.status ?? null;
  CHAT_STATE.currentMessageRunId = hint.run?.runId ?? null;
  CHAT_STATE.currentMessageLookupBasis = hint.lookupBasis ?? null;
  CHAT_STATE.currentMessageSourceKind = hint.matchedTurn?.sourceKind ?? null;
  const runId = hint.run?.runId;
  debugLog("refreshCurrentMessageRunHint:loaded", {
    status: hint.status ?? null,
    lookupBasis: hint.lookupBasis ?? null,
    sourceKind: hint.matchedTurn?.sourceKind ?? null,
    runId: runId ?? null,
  });
  if (CHAT_STATE.visible) updateAuditHeaderBindHealth();
  if (!runId) return;
  const hasRun = CHAT_STATE.data.runs.some((run) => run.runId === runId);
  if (!hasRun) return;
  const shouldAutoExpand = !CHAT_STATE.autoExpandDone && CHAT_STATE.expandedRunIds.size === 0;
  if (shouldAutoExpand) {
    CHAT_STATE.expandedRunIds.add(runId);
    CHAT_STATE.autoExpandDone = true;
    if (CHAT_STATE.visible) updateAuditSidebarContent();
    startChatRunDetailFetch(runId);
  }
}

async function ensureChatRunDetail(runId) {
  return refreshChatRunDetail(runId, { force: false });
}

function startChatRunDetailFetch(runId, opts = {}) {
  if (!runId || CHAT_STATE.loadingRunIds.has(runId)) return;
  CHAT_STATE.loadingRunIds.add(runId);
  if (CHAT_STATE.visible) updateAuditSidebarContent(true);
  void refreshChatRunDetail(runId, opts);
}

async function refreshChatRunDetail(runId, opts = {}) {
  if (!runId || !CHAT_STATE.data?.runs?.length) return;
  const idx = CHAT_STATE.data.runs.findIndex((r) => r.runId === runId);
  if (idx < 0) return;
  const run = CHAT_STATE.data.runs[idx];
  const force = opts.force === true;
  const now = Date.now();
  const lastRefreshAt = CHAT_STATE.lastDetailRefreshAt.get(runId) ?? 0;
  if (force && !opts.immediate && now - lastRefreshAt < CHAT_AUDIT_DETAIL_REFRESH_MIN_GAP_MS) {
    CHAT_STATE.loadingRunIds.delete(runId);
    return;
  }
  if (!force && !needsRunDetailFetch(run)) return;
  debugLog("ensureRunDetail:start", {
    runId,
    visible: CHAT_STATE.visible,
    force,
  });
  const detail = await apiFetch("/audit/run/" + encodeURIComponent(runId));
  CHAT_STATE.loadingRunIds.delete(runId);
  if (!detail) {
    debugLog("ensureRunDetail:empty", runId);
    if (CHAT_STATE.visible) updateAuditSidebarContent(true);
    return;
  }
  CHAT_STATE.lastDetailRefreshAt.set(runId, Date.now());
  CHAT_STATE.data.runs[idx] = { ...run, ...detail, hasDetail: true };
  debugLog("ensureRunDetail:done", {
    runId,
    turnCount: detail?.turns?.length ?? 0,
    timelineCount: detail?.timeline?.length ?? 0,
  });
  if (CHAT_STATE.visible) updateAuditSidebarContent(true);
}

async function toggleChatRunExpanded(runId) {
  if (!runId) return;
  bumpSidebarInteractionWindow();
  const implicitFirstRunId = CHAT_STATE.expandedRunIds.size === 0 && !CHAT_STATE.autoExpandDone
    ? CHAT_STATE.data?.runs?.[0]?.runId ?? null
    : null;
  const isImplicitlyExpanded = implicitFirstRunId === runId;
  const run = CHAT_STATE.data?.runs?.find((item) => item.runId === runId) ?? null;
  CHAT_STATE.autoExpandDone = true;
  if (CHAT_STATE.expandedRunIds.has(runId) || isImplicitlyExpanded) {
    CHAT_STATE.expandedRunIds.delete(runId);
    if (CHAT_STATE.visible) updateAuditSidebarContent(true);
    return;
  }
  CHAT_STATE.expandedRunIds.add(runId);
  if (run && needsRunDetailFetch(run)) {
    startChatRunDetailFetch(runId, { immediate: true });
    return;
  }
  if (CHAT_STATE.visible) updateAuditSidebarContent(true);
}

async function primeInitialChatRunDetail() {
  const firstRunId = CHAT_STATE.data?.runs?.[0]?.runId;
  if (!firstRunId) return;
  if (!CHAT_STATE.expandedRunIds.size) {
    CHAT_STATE.expandedRunIds.add(firstRunId);
    CHAT_STATE.autoExpandDone = true;
  }
  startChatRunDetailFetch(firstRunId);
}

async function refreshChatAudit() {
  if (CHAT_STATE.refreshing) return;
  const selection = getCurrentSessionSelection();
  if (!selection) return;
  const key = selection.resolved;
  const needsInitialLoad = key !== CHAT_STATE.sessionKey || !CHAT_STATE.data;
  debugLog("refreshChatAudit", {
    raw: selection.raw,
    resolved: selection.resolved,
    currentSessionKey: CHAT_STATE.sessionKey,
    needsInitialLoad,
    hasData: !!CHAT_STATE.data,
    visible: CHAT_STATE.visible,
    latestStartedAt: CHAT_STATE.latestStartedAt,
  });
  if (needsInitialLoad) {
    CHAT_STATE.sessionKey = key;
    CHAT_STATE.sourceSessionKey = selection.raw;
    CHAT_STATE.data = null;
    CHAT_STATE.latestStartedAt = null;
    CHAT_STATE.oldestStartedAt = null;
    CHAT_STATE.hasMore = false;
    CHAT_STATE.expandedRunIds.clear();
    CHAT_STATE.loadingRunIds.clear();
    CHAT_STATE.currentMessageRunId = null;
    CHAT_STATE.currentMessageStatus = null;
    CHAT_STATE.currentMessageLookupBasis = null;
    CHAT_STATE.currentMessageSourceKind = null;
    CHAT_STATE.lastDetailRefreshAt.clear();
    CHAT_STATE.autoExpandDone = false;
    CHAT_STATE.loading = true;
    CHAT_STATE.loadError = null;
    if (CHAT_STATE.visible) updateAuditSidebarContent();
    CHAT_STATE.refreshing = true;
    try {
      const d = await fetchChatAuditChunk({ limit: 8 });
      if (d) {
        debugLog("refreshChatAudit:initialLoaded", {
          runCount: d.runs?.length ?? 0,
          latestStartedAt: d.latestStartedAt ?? null,
          oldestStartedAt: d.oldestStartedAt ?? null,
          hasMore: !!d.hasMore,
        });
        CHAT_STATE.data = d;
        CHAT_STATE.lastDataSignature = buildChatAuditDataSignature(d);
        CHAT_STATE.latestStartedAt = d.latestStartedAt ?? d.runs?.[0]?.startedAt ?? null;
        CHAT_STATE.oldestStartedAt = d.oldestStartedAt ?? d.runs?.[d.runs.length - 1]?.startedAt ?? null;
        CHAT_STATE.hasMore = !!d.hasMore;
        primeInitialChatRunDetail();
        await refreshCurrentMessageRunHint();
        startChatPolling();
      } else {
        CHAT_STATE.loadError = "Failed to load audit data";
        debugLog("refreshChatAudit:initialFailed");
      }
    } finally {
      CHAT_STATE.loading = false;
      CHAT_STATE.refreshing = false;
      if (CHAT_STATE.visible) updateAuditSidebarContent();
    }
    return;
  }

  CHAT_STATE.sourceSessionKey = selection.raw;

  if (!CHAT_STATE.latestStartedAt) return;
  CHAT_STATE.refreshing = true;
  try {
    const d = await fetchChatAuditChunk({ limit: 6, since: CHAT_STATE.latestStartedAt });
    if (!d?.runs?.length) {
      debugLog("refreshChatAudit:incrementalEmpty", {
        latestStartedAt: CHAT_STATE.latestStartedAt,
      });
      return;
    }
    debugLog("refreshChatAudit:incrementalLoaded", {
      runCount: d.runs?.length ?? 0,
      latestStartedAt: d.latestStartedAt ?? null,
      oldestStartedAt: d.oldestStartedAt ?? null,
      hasMore: !!d.hasMore,
    });
    const nextData = {
      ...CHAT_STATE.data,
      ...d,
      runs: mergeRuns(CHAT_STATE.data?.runs, d.runs, "prepend"),
    };
    const nextSignature = buildChatAuditDataSignature(nextData);
    if (nextSignature === CHAT_STATE.lastDataSignature) {
      debugLog("refreshChatAudit:incrementalNoop", {
        latestStartedAt: d.latestStartedAt ?? null,
      });
      CHAT_STATE.latestStartedAt = Math.max(CHAT_STATE.latestStartedAt ?? 0, d.latestStartedAt ?? 0);
      return;
    }
    CHAT_STATE.data = nextData;
    CHAT_STATE.lastDataSignature = nextSignature;
    const newestIncomingRunId = getNewestIncomingRunId(d.runs);
    if (newestIncomingRunId) {
      CHAT_STATE.expandedRunIds.add(newestIncomingRunId);
      CHAT_STATE.autoExpandDone = true;
      const newestRun = CHAT_STATE.data.runs.find((run) => run.runId === newestIncomingRunId);
      if (newestRun && needsRunDetailFetch(newestRun)) {
        startChatRunDetailFetch(newestIncomingRunId);
      }
    }
    CHAT_STATE.latestStartedAt = Math.max(CHAT_STATE.latestStartedAt ?? 0, d.latestStartedAt ?? 0);
    CHAT_STATE.oldestStartedAt = CHAT_STATE.data.runs[CHAT_STATE.data.runs.length - 1]?.startedAt ?? CHAT_STATE.oldestStartedAt;
    CHAT_STATE.hasMore = CHAT_STATE.hasMore || !!d.hasMore;
    CHAT_STATE.loadError = null;
    await refreshCurrentMessageRunHint();
    if (CHAT_STATE.visible) updateAuditSidebarContent();
  } finally {
    CHAT_STATE.refreshing = false;
  }
}

async function loadOlderChatAudit() {
  if (!CHAT_STATE.sessionKey || !CHAT_STATE.oldestStartedAt || CHAT_STATE.loadingMore || !CHAT_STATE.hasMore) return;
  CHAT_STATE.loadingMore = true;
  debugLog("loadOlder:start", {
    sessionKey: CHAT_STATE.sessionKey,
    oldestStartedAt: CHAT_STATE.oldestStartedAt,
  });
  if (CHAT_STATE.visible) updateAuditSidebarContent();
  const d = await fetchChatAuditChunk({ limit: 8, before: CHAT_STATE.oldestStartedAt });
  CHAT_STATE.loadingMore = false;
  if (!d) {
    debugLog("loadOlder:empty");
    if (CHAT_STATE.visible) updateAuditSidebarContent();
    return;
  }
  debugLog("loadOlder:loaded", {
    runCount: d.runs?.length ?? 0,
    oldestStartedAt: d.oldestStartedAt ?? null,
    hasMore: !!d.hasMore,
  });
  const nextData = {
    ...CHAT_STATE.data,
    ...d,
    runs: mergeRuns(CHAT_STATE.data?.runs, d.runs, "append"),
  };
  const nextSignature = buildChatAuditDataSignature(nextData);
  if (nextSignature === CHAT_STATE.lastDataSignature) {
    CHAT_STATE.oldestStartedAt = d.oldestStartedAt ?? CHAT_STATE.oldestStartedAt;
    CHAT_STATE.hasMore = !!d.hasMore;
    if (CHAT_STATE.visible) updateAuditSidebarContent();
    return;
  }
  CHAT_STATE.data = nextData;
  CHAT_STATE.lastDataSignature = nextSignature;
  CHAT_STATE.oldestStartedAt = d.oldestStartedAt ?? CHAT_STATE.oldestStartedAt;
  CHAT_STATE.hasMore = !!d.hasMore;
  if (CHAT_STATE.visible) updateAuditSidebarContent();
}

function startChatPolling() {
  if (CHAT_STATE.pollTimer) return;
  CHAT_STATE.pollTimer = setInterval(async () => {
    if (document.hidden) return;
    if (!isInChatView() || !CHAT_STATE.visible || CHAT_STATE.loading || CHAT_STATE.refreshing || !CHAT_STATE.latestStartedAt) return;
    requestChatAuditRefresh("poll", { withDetails: true });
  }, 10000);

  if (CHAT_STATE.liveRenderTimer) return;
  CHAT_STATE.liveRenderTimer = setInterval(() => {
    if (document.hidden) return;
    if (!isInChatView() || !CHAT_STATE.visible || !CHAT_STATE.data?.runs?.length) return;
    const hasRunningRun = CHAT_STATE.data.runs.some((run) => run?.status === "running");
    if (!hasRunningRun) return;
    updateAuditSidebarContent(true);
  }, CHAT_AUDIT_LIVE_RENDER_INTERVAL_MS);
}

async function refreshExpandedChatRunDetails() {
  if (!CHAT_STATE.visible || !CHAT_STATE.expandedRunIds.size) return;
  const expandedRuns = CHAT_STATE.data?.runs
    ?.filter((run) => CHAT_STATE.expandedRunIds.has(run.runId)) ?? [];
  for (const run of expandedRuns) {
    if (run.hasDetail === false) {
      await refreshChatRunDetail(run.runId, { force: false });
      continue;
    }
    if (run.status === "running") {
      await refreshChatRunDetail(run.runId, { force: true });
    }
  }
}

function handleRouteChange() {
  if (isInChatView()) {
    injectAuditToggleBtn();
    const selection = getCurrentSessionSelection();
    const routeSignature = `${location.pathname}|${selection?.resolved ?? ""}`;
    const routeChanged = CHAT_STATE.lastRouteSignature !== routeSignature;
    CHAT_STATE.lastRouteSignature = routeSignature;
    if (CHAT_STATE.visible) {
      if (routeChanged) {
        requestChatAuditRefresh("route-change", { force: true, withDetails: true });
      }
    }
  } else {
    hideChatAuditSidebar();
    const btn = document.getElementById("clawlens-audit-toggle-btn");
    if (btn) btn.remove();
    CHAT_STATE.lastDomMessageFingerprint = null;
    CHAT_STATE.lastRouteSignature = null;
  }
}

// Watch for SPA route/DOM changes — subtree:true catches inner elements
let _chatObsDebounce = null;
const _chatObs = new MutationObserver(() => {
  clearTimeout(_chatObsDebounce);
  _chatObsDebounce = setTimeout(() => {
    mountOverviewPanel();
    handleRouteChange();
  }, 200);
});
_chatObs.observe(document.body, { childList: true, subtree: true });

const _chatMessageObs = new MutationObserver((mutations) => {
  let relevant = false;
  const chatRoot = document.querySelector(".chat-split-container, main.chat, .shell.shell--chat");
  for (const mutation of mutations) {
    if (mutation.type !== "childList") continue;
    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (chatRoot) {
        const insideChatRoot =
          chatRoot.contains(node)
          || !!node.querySelector?.(".chat-split-container, main.chat, .shell.shell--chat");
        if (!insideChatRoot) continue;
      }
      if (
        node.matches?.(".chat-group") ||
        node.querySelector?.(".chat-group")
      ) {
        relevant = true;
        break;
      }
    }
    if (relevant) break;
  }
  if (relevant) scheduleDomDrivenAuditRefresh("chat-mutation");
});
_chatMessageObs.observe(document.body, { childList: true, subtree: true });

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && CHAT_STATE.visible) {
    requestChatAuditRefresh("visibility-resume", { force: true, withDetails: true });
  } else if (document.hidden && CHAT_STATE.domRefreshTimer) {
    clearTimeout(CHAT_STATE.domRefreshTimer);
    CHAT_STATE.domRefreshTimer = null;
  }
});

setTimeout(handleRouteChange, 1000);
setTimeout(handleRouteChange, 3000);
