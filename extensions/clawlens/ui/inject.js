/**
 * ClawLens UI inject — Overview panel + Audit drawer + Chat sidebar
 */

const API = "/plugins/clawlens/api";
const OVERVIEW_INTERVAL = 30_000;

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

async function apiFetch(path) {
  try {
    const r = await fetch(API + path, { headers: authHeaders() });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
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
      if (["run_started", "run_ended", "llm_call", "tool_executed"].includes(ev.type)) {
        fetchOverview();
        if (S.drawerOpen) fetchAuditSessions();
        if (S.selSession && (ev.sessionKey === S.selSession || ev.runId)) selectSession(S.selSession);
        if (CHAT_STATE.visible) refreshChatAudit();
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
}

// ── Shared audit panel renderer ───────────────────────────────────────────
// Returns run card HTML without outer wrapper — caller provides the container.

function renderAuditPanel(data) {
  if (!data || !data.runs?.length) {
    return '<div style="color:var(--muted,#838387);padding:20px;text-align:center">No audit data for this session</div>';
  }
  return data.runs.map((run, i) => `
    <div class="clawlens-audit-run${i === 0 ? " expanded" : ""}">
      <div class="clawlens-audit-run-hdr" onclick="this.parentElement.classList.toggle('expanded')">
        <div class="clawlens-audit-run-top">
          <span class="clawlens-audit-run-num">#${i + 1} Run</span>
          <span class="clawlens-audit-run-time">${formatDuration(run.duration)}</span>
        </div>
        <div class="clawlens-audit-run-prompt">${esc(run.userPrompt || "(no prompt)")}</div>
        <div class="clawlens-audit-run-stats">
          <span>${run.summary?.llmCalls ?? 0} LLM</span>
          <span>${run.summary?.toolCalls ?? 0} tool</span>
          <span>${fmtTokens((run.summary?.totalInputTokens ?? 0) + (run.summary?.totalOutputTokens ?? 0))} tok</span>
          <span class="cost">${fmtCost(run.summary?.officialCost ?? run.summary?.calculatedCost ?? run.summary?.totalCost)}</span>
        </div>
      </div>
      <div class="clawlens-audit-run-detail">
        <div class="clawlens-section-label">Timeline</div>
        <div class="clawlens-tl-legend">
          <span><span class="clawlens-tl-legend-dot" style="background:var(--info,#3b82f6)"></span>LLM</span>
          <span><span class="clawlens-tl-legend-dot" style="background:var(--ok,#22c55e)"></span>Tool</span>
        </div>
        ${renderTimeline(run.timeline, run.duration)}
        <div class="clawlens-section-label" style="margin-top:8px">Turns</div>
        <div class="clawlens-turns">${renderTurns(run.turns)}</div>
      </div>
    </div>
  `).join("");
}

function renderTimeline(timeline, totalDuration) {
  if (!timeline?.length || !totalDuration) return "";
  return '<div class="clawlens-timeline-bar">' + timeline.map(entry => {
    const left = Math.max(0, (entry.startedAt / totalDuration * 100)).toFixed(1);
    const width = Math.max(entry.duration / totalDuration * 100, 2).toFixed(1);
    const cls = entry.type === "llm_call" ? "clawlens-tl-llm" : "clawlens-tl-tool";
    const label = entry.type === "llm_call"
      ? `LLM ${formatDuration(entry.duration)}`
      : `${entry.toolName || "tool"} ${formatDuration(entry.duration)}`;
    return `<div class="${cls}" style="left:${left}%;width:${width}%" title="${esc(label)}">${formatDuration(entry.duration)}</div>`;
  }).join("") + "</div>";
}

function renderTurns(turns) {
  if (!turns?.length) return "";
  return turns.map(t => `
    <div class="clawlens-turn">
      <span class="clawlens-turn-role ${esc(t.role)}">${esc(t.role)}</span>
      <span class="clawlens-turn-preview">${esc((t.preview ?? "").slice(0, 120))}</span>
    </div>
  `).join("");
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
  data: null,
  pollTimer: null,
};

function getCurrentSessionKey() {
  const url = new URL(location.href);
  const s = url.searchParams.get("session");
  if (s) return s;
  const sel = document.querySelector(".chat-session select");
  return sel?.value ?? null;
}

function isInChatView() {
  return location.pathname.includes("/chat") || !!document.querySelector(".chat-split-container");
}

function updateAuditSidebarContent() {
  const body = document.getElementById("clawlens-audit-sidebar-body");
  if (!body) return;
  if (!CHAT_STATE.data) {
    body.innerHTML = '<div style="color:var(--muted,#838387);padding:20px;text-align:center">Loading…</div>';
    return;
  }
  // body already has clawlens-audit-body class; renderAuditPanel returns inner content only
  body.innerHTML = renderAuditPanel(CHAT_STATE.data);
}

function mountChatAuditSidebar() {
  if (document.getElementById("clawlens-audit-sidebar")) return;

  const sidebar = document.createElement("div");
  sidebar.id = "clawlens-audit-sidebar";
  sidebar.className = "clawlens-audit-sidebar";
  sidebar.innerHTML = `
    <div class="clawlens-audit-header">
      <span class="clawlens-audit-title">ClawLens Audit</span>
      <button class="clawlens-audit-close" id="clawlens-audit-close-btn" title="Close">✕</button>
    </div>
    <div id="clawlens-audit-sidebar-body" class="clawlens-audit-body">
      <div style="color:var(--muted,#838387);padding:20px;text-align:center">Loading…</div>
    </div>
  `;
  document.body.appendChild(sidebar);
  document.getElementById("clawlens-audit-close-btn")?.addEventListener("click", hideChatAuditSidebar);
  CHAT_STATE.visible = true;
  // Fetch immediately — don't wait for MutationObserver debounce
  refreshChatAudit();
}

function hideChatAuditSidebar() {
  const sidebar = document.getElementById("clawlens-audit-sidebar");
  if (sidebar) sidebar.remove();
  CHAT_STATE.visible = false;
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

async function refreshChatAudit() {
  const key = getCurrentSessionKey();
  if (!key) return;
  if (key !== CHAT_STATE.sessionKey) {
    CHAT_STATE.sessionKey = key;
    CHAT_STATE.data = null;
    if (CHAT_STATE.visible) updateAuditSidebarContent();
  }
  // API returns { sessionKey, runs: RunAuditDetail[] }
  let d = await apiFetch("/audit/session/" + encodeURIComponent(key));
  // If no runs found for the exact key, try progressively coarser fallbacks.
  // Lifecycle events may omit channelId so "agent:main:main" is stored as
  // "agent:main". Try each shorter prefix before giving up.
  if (d && d.runs?.length === 0) {
    const parts = key.split(":");
    for (let i = parts.length - 1; i >= 1 && d.runs?.length === 0; i--) {
      const shorter = parts.slice(0, i).join(":");
      const fb = await apiFetch("/audit/session/" + encodeURIComponent(shorter));
      if (fb?.runs?.length) { d = { ...fb, sessionKey: key, _fallback: true }; }
    }
  }
  // Last resort: try the "unknown" bucket.
  if (d && d.runs?.length === 0) {
    const fallback = await apiFetch("/audit/session/unknown");
    if (fallback?.runs?.length) {
      d = { ...fallback, sessionKey: key, _fallback: true };
    }
  }
  if (d) {
    CHAT_STATE.data = d;
    if (CHAT_STATE.visible) updateAuditSidebarContent();
  }
}

function startChatPolling() {
  if (CHAT_STATE.pollTimer) return;
  CHAT_STATE.pollTimer = setInterval(async () => {
    if (!isInChatView()) return;
    await refreshChatAudit();
  }, 10000);
}

function handleRouteChange() {
  if (isInChatView()) {
    injectAuditToggleBtn();
    startChatPolling();
    refreshChatAudit();
  } else {
    hideChatAuditSidebar();
    const btn = document.getElementById("clawlens-audit-toggle-btn");
    if (btn) btn.remove();
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

setTimeout(handleRouteChange, 1000);
setTimeout(handleRouteChange, 3000);
