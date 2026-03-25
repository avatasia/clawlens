/**
 * ClawLens UI inject — Overview panel + Audit drawer
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
  sessions: [],       // AuditSession[]
  selSession: null,   // string | null
  runs: [],           // RunWithDetail[]
  loadingSessions: false,
  loadingRuns: false,
  expandedRuns: new Set(),
  expandedLlm: new Set(),
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
function statusBadge(status) {
  const map = { completed: ["✓", "cl-badge-ok"], error: ["✕", "cl-badge-err"], running: ["⟳", "cl-badge-run"] };
  const [icon, cls] = map[status] ?? ["?", ""];
  return `<span class="cl-badge ${cls}">${icon} ${esc(status)}</span>`;
}
function shortKey(key) {
  if (!key || key === "unknown") return "—";
  if (key.length > 28) return key.slice(0, 12) + "…" + key.slice(-8);
  return key;
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
  S.expandedRuns.clear();
  S.expandedLlm.clear();
  S.loadingRuns = true;
  renderDetail();
  const d = await apiFetch("/audit/session/" + encodeURIComponent(key));
  S.runs = d ?? [];
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
  // Only inject on overview page
  if (!location.pathname.includes("/overview") && location.pathname !== "/") return;

  // Best target: section.grid inside main content (overview page native layout)
  const grid = document.querySelector("main section.grid, section.grid");
  if (!grid) return; // Overview page not rendered yet — observer will retry

  const existing = document.getElementById("clawlens-panel");

  // Already mounted in the right place → nothing to do
  if (existing && existing.parentElement === grid) return;

  // Remove from wrong location if needed
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

  const runsHtml = S.runs.map((item, idx) => renderRunCard(item, idx)).join("");
  el.innerHTML = headerHtml + `<div class="cl-run-list">${runsHtml}</div>`;

  // bind expand toggles
  el.querySelectorAll("[data-toggle-run]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.toggleRun;
      S.expandedRuns.has(id) ? S.expandedRuns.delete(id) : S.expandedRuns.add(id);
      renderDetail();
    });
  });
  el.querySelectorAll("[data-toggle-llm]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.toggleLlm;
      S.expandedLlm.has(id) ? S.expandedLlm.delete(id) : S.expandedLlm.add(id);
      renderDetail();
    });
  });
}

function renderRunCard({ run, llmCalls, toolSummary }, idx) {
  const expanded = S.expandedRuns.has(run.run_id);
  const llmExpanded = S.expandedLlm.has(run.run_id);

  // header row
  const status = statusBadge(run.status);
  const toks = run.total_input_tokens + run.total_output_tokens;
  const cacheInfo = (run.total_cache_read > 0 || run.total_cache_write > 0)
    ? ` <span class="cl-cache-info">cache ↓${fmtTokens(run.total_cache_read)} ↑${fmtTokens(run.total_cache_write)}</span>` : "";
  const model = run.model ? `<span class="cl-run-model">${esc(run.model.split("/").pop())}</span>` : "";

  const chevron = expanded ? "▾" : "▸";

  let bodyHtml = "";
  if (expanded) {
    // Token breakdown row
    const tokenRow = `
      <div class="cl-run-tokens">
        <span class="cl-tok-in">↑ ${fmtTokens(run.total_input_tokens)} in</span>
        <span class="cl-tok-out">↓ ${fmtTokens(run.total_output_tokens)} out</span>
        ${run.total_cache_read > 0 ? `<span class="cl-tok-cache">⚡ ${fmtTokens(run.total_cache_read)} cached</span>` : ""}
        <span class="cl-run-cost">${fmtCost(run.total_cost_usd)}</span>
      </div>
    `;

    // Tool summary
    const toolsHtml = toolSummary.length ? `
      <div class="cl-section-label">🔧 Tool Calls (${run.total_tool_calls})</div>
      <div class="cl-tool-grid">
        ${toolSummary.map(t => `
          <div class="cl-tool-row ${t.error_count > 0 ? "cl-tool-err" : ""}">
            <span class="cl-tool-name">${esc(t.tool_name)}</span>
            <span class="cl-tool-count">×${t.count}</span>
            <span class="cl-tool-dur">${fmtDur(t.avg_duration_ms)}/call</span>
            ${t.error_count > 0 ? `<span class="cl-tool-errcnt">${t.error_count} err</span>` : ""}
          </div>
        `).join("")}
      </div>
    ` : "";

    // LLM calls expandable
    const llmChevron = llmExpanded ? "▾" : "▸";
    const llmHeader = llmCalls.length ? `
      <div class="cl-section-label">
        <button class="cl-expand-btn" data-toggle-llm="${esc(run.run_id)}">
          ${llmChevron} 💬 LLM Calls (${llmCalls.length})
        </button>
      </div>
    ` : "";
    const llmBody = llmExpanded && llmCalls.length ? `
      <div class="cl-llm-list">
        ${llmCalls.map((c, i) => `
          <div class="cl-llm-row">
            <span class="cl-llm-idx">#${c.call_index ?? i}</span>
            <span class="cl-llm-model">${esc((c.model ?? "").split("/").pop())}</span>
            <span class="cl-llm-dur">${fmtDur(c.duration_ms)}</span>
            <span class="cl-llm-toks">↑${fmtTokens(c.input_tokens)} ↓${fmtTokens(c.output_tokens)}</span>
            ${c.cache_read > 0 ? `<span class="cl-llm-cache">⚡${fmtTokens(c.cache_read)}</span>` : ""}
            <span class="cl-llm-cost">${fmtCost(c.cost_usd)}</span>
            ${c.tool_calls_in_response > 0 ? `<span class="cl-llm-tc">🔧${c.tool_calls_in_response}</span>` : ""}
          </div>
        `).join("")}
      </div>
    ` : "";

    bodyHtml = `
      <div class="cl-run-body">
        ${tokenRow}
        ${llmHeader}${llmBody}
        ${toolsHtml}
        ${run.error_message ? `<div class="cl-run-error">⚠ ${esc(run.error_message)}</div>` : ""}
      </div>
    `;
  }

  return `
    <div class="cl-run-card ${run.status === 'error' ? 'cl-run-card-err' : ''}">
      <div class="cl-run-head" data-toggle-run="${esc(run.run_id)}">
        <span class="cl-run-chevron">${chevron}</span>
        <span class="cl-run-time">${fmtTime(run.started_at)}</span>
        ${status}
        ${model}
        <span class="cl-run-dur">${fmtDur(run.duration_ms)}</span>
        <span class="cl-run-toks-sm">${fmtTokens(toks)} tok${cacheInfo}</span>
        <span class="cl-run-cost-sm">${fmtCost(run.total_cost_usd)}</span>
        <span class="cl-run-pills">
          ${run.total_llm_calls > 0 ? `<span class="cl-pill-llm">💬${run.total_llm_calls}</span>` : ""}
          ${run.total_tool_calls > 0 ? `<span class="cl-pill-tool">🔧${run.total_tool_calls}</span>` : ""}
        </span>
      </div>
      ${bodyHtml}
    </div>
  `;
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function main() {
  // Wait for app shell
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

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function formatDuration(ms) {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60000) + "m " + Math.floor((ms % 60000) / 1000) + "s";
}
function formatTokens(n) { return fmtTokens(n); }
function formatCost(n) { return fmtCost(n); }

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

function renderTimeline(timeline, totalDuration) {
  if (!timeline?.length || !totalDuration) return "";
  return '<div class="clawlens-timeline-bar">' + timeline.map(entry => {
    const left = Math.max(0, (entry.startedAt / totalDuration * 100)).toFixed(1);
    const width = Math.max(entry.duration / totalDuration * 100, 2).toFixed(1);
    const cls = entry.type === "llm_call" ? "clawlens-tl-llm" : "clawlens-tl-tool";
    const label = entry.type === "llm_call"
      ? `LLM ${formatDuration(entry.duration)}`
      : `${entry.toolName || "tool"} ${formatDuration(entry.duration)}`;
    return `<div class="${cls}" style="left:${left}%;width:${width}%" title="${escapeHtml(label)}">${formatDuration(entry.duration)}</div>`;
  }).join("") + "</div>";
}

function renderTurns(turns) {
  if (!turns?.length) return "";
  return turns.map(t => `
    <div class="clawlens-turn">
      <span class="clawlens-turn-role ${escapeHtml(t.role)}">${escapeHtml(t.role)}</span>
      <span class="clawlens-turn-preview">${escapeHtml((t.preview ?? "").slice(0, 120))}</span>
    </div>
  `).join("");
}

function renderAuditPanel(data) {
  if (!data || !data.runs?.length) {
    return '<div class="clawlens-audit-body"><div style="color:var(--muted,#838387);padding:20px;text-align:center">No audit data for this session</div></div>';
  }
  return '<div class="clawlens-audit-body">' + data.runs.map((run, i) => `
    <div class="clawlens-audit-run${i === 0 ? " expanded" : ""}">
      <div class="clawlens-audit-run-hdr" onclick="this.parentElement.classList.toggle('expanded')">
        <div class="clawlens-audit-run-top">
          <span class="clawlens-audit-run-num">#${i + 1} Run</span>
          <span class="clawlens-audit-run-time">${formatDuration(run.duration)}</span>
        </div>
        <div class="clawlens-audit-run-prompt">${escapeHtml(run.userPrompt || "(no prompt)")}</div>
        <div class="clawlens-audit-run-stats">
          <span>${run.summary?.llmCalls ?? 0} LLM</span>
          <span>${run.summary?.toolCalls ?? 0} tool</span>
          <span>${formatTokens((run.summary?.totalInputTokens ?? 0) + (run.summary?.totalOutputTokens ?? 0))} tok</span>
          <span class="cost">${formatCost(run.summary?.totalCost)}</span>
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
  `).join("") + "</div>";
}

async function fetchChatAudit(sessionKey) {
  const data = await apiFetch("/audit/session/" + encodeURIComponent(sessionKey));
  return data;
}

function updateAuditSidebarContent() {
  const body = document.getElementById("clawlens-audit-sidebar-body");
  if (!body) return;
  if (!CHAT_STATE.data) {
    body.innerHTML = '<div style="color:var(--muted,#838387);padding:20px;text-align:center">Loading…</div>';
    return;
  }
  body.innerHTML = renderAuditPanel(CHAT_STATE.data);
}

function mountChatAuditSidebar() {
  if (document.getElementById("clawlens-audit-sidebar")) return;

  const container = document.querySelector(".chat-split-container");
  if (!container) return;

  const sidebar = document.createElement("div");
  sidebar.id = "clawlens-audit-sidebar";
  sidebar.className = "clawlens-audit-sidebar";
  sidebar.innerHTML = `
    <div class="clawlens-audit-header">
      <span class="clawlens-audit-title">ClawLens Audit</span>
      <button class="clawlens-audit-close" id="clawlens-audit-close-btn" title="Close">✕</button>
    </div>
    <div id="clawlens-audit-sidebar-body" class="clawlens-audit-body">
      <div style="color:var(--muted,#838387);padding:20px;text-align:center">Select a session to view audit data</div>
    </div>
  `;
  container.appendChild(sidebar);
  document.getElementById("clawlens-audit-close-btn")?.addEventListener("click", hideChatAuditSidebar);
  CHAT_STATE.visible = true;
  updateAuditSidebarContent();
}

function hideChatAuditSidebar() {
  const sidebar = document.getElementById("clawlens-audit-sidebar");
  if (sidebar) sidebar.remove();
  CHAT_STATE.visible = false;
}

function toggleChatAuditSidebar() {
  if (CHAT_STATE.visible) {
    hideChatAuditSidebar();
  } else {
    mountChatAuditSidebar();
  }
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
    updateAuditSidebarContent();
  }
  const data = await fetchChatAudit(key);
  if (data) {
    CHAT_STATE.data = data;
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

// Initial check — deferred so SPA can finish rendering
setTimeout(handleRouteChange, 1000);
setTimeout(handleRouteChange, 3000);
