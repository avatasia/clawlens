# ClawLens — OpenClaw 监控插件

> **版本兼容性**：本 prompt 基于 v2026.3.22 源码分析。经 v2026.3.23 / 3.23-2 变更日志核查，
> 我们使用的所有 Plugin API（`api.on()`、`registerHttpRoute`、`registerService`、
> `runtime.events.onAgentEvent`、`definePluginEntry`）均无 breaking change。
> **代码同时兼容 3.22 和 3.23。**

你将为 OpenClaw 编写一个完整的监控插件。不要中途停下来问问题，按照下面的规范一次性完成所有文件。

OpenClaw 仓库位于当前工作目录。先读 `extensions/diagnostics-otel/index.ts` 和 `extensions/memory-lancedb/index.ts` 了解现有 extension 的写法模式，然后在 `extensions/clawlens/` 下创建所有文件。

---

## 完整文件清单

创建以下所有文件，不多不少：

```
extensions/clawlens/
├── package.json
├── openclaw.plugin.json
├── index.ts
├── api.ts
├── src/
│   ├── types.ts
│   ├── store.ts
│   ├── cost-calculator.ts
│   ├── collector.ts
│   ├── comparator.ts
│   ├── sse-manager.ts
│   ├── api-routes.ts
│   └── static-server.ts
└── ui/
    ├── inject.js
    └── styles.css
```

---

## 文件规范

### `package.json`

```json
{
  "name": "clawlens",
  "version": "0.1.0",
  "description": "OpenClaw session monitor + multi-model comparator",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"]
  }
}
```

### `openclaw.plugin.json`

```json
{
  "id": "clawlens",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

### `api.ts`

```typescript
export { definePluginEntry, type OpenClawPluginApi, type OpenClawPluginService, type OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
```

### `src/types.ts`

定义以下类型：

```typescript
export type ClawLensConfig = {
  collector?: {
    enabled?: boolean;
    snapshotIntervalMs?: number;
    retentionDays?: number;
  };
  compare?: {
    enabled?: boolean;
    models?: Array<{ provider: string; model: string }>;
    channels?: string[];
    timeoutMs?: number;
    maxConcurrent?: number;
  };
};

export type ClawLensEvent = {
  type: "run_started" | "run_ended" | "llm_call" | "tool_executed" | "compare_completed" | "connected";
  [key: string]: unknown;
};
```

### `src/store.ts`

使用 Node.js 内置 `node:sqlite`（v22+），不需要外部依赖。

```typescript
import { DatabaseSync } from "node:sqlite";
```

关键点：
- 构造函数接收 `stateDir: string`，在 `{stateDir}/clawlens/` 下创建 `clawlens.db`
- 自动创建目录（`fs.mkdirSync` recursive）
- 启用 WAL mode：`db.exec("PRAGMA journal_mode=WAL")`
- 建表 SQL：

```sql
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  channel TEXT,
  agent_id TEXT,
  provider TEXT,
  model TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  status TEXT DEFAULT 'running',
  error_message TEXT,
  total_llm_calls INTEGER DEFAULT 0,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cache_read INTEGER DEFAULT 0,
  total_cache_write INTEGER DEFAULT 0,
  total_official_cost REAL DEFAULT 0,
  total_calculated_cost REAL DEFAULT 0,
  total_tool_calls INTEGER DEFAULT 0,
  compare_group_id TEXT,
  is_primary INTEGER
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  call_index INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  official_cost REAL,      -- 层次 1: pi-ai 返回的 message.usage.cost.total
  calculated_cost REAL,    -- 层次 2: resolveModelCostConfig 三层 fallback 重算
  stop_reason TEXT,
  provider TEXT,
  model TEXT,
  system_prompt_hash TEXT,
  user_prompt_preview TEXT,
  tool_calls_in_response INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tool_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  is_error INTEGER DEFAULT 0,
  args_summary TEXT,
  result_summary TEXT
);

CREATE TABLE IF NOT EXISTS session_snapshots (
  session_key TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  channel TEXT,
  model TEXT,
  provider TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  estimated_cost REAL,
  compaction_count INTEGER,
  PRIMARY KEY (session_key, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_key);
CREATE INDEX IF NOT EXISTS idx_runs_channel ON runs(channel);
CREATE INDEX IF NOT EXISTS idx_runs_compare ON runs(compare_group_id);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_run ON tool_executions(run_id);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  session_key     TEXT NOT NULL,
  turn_index      INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content_preview TEXT,
  content_length  INTEGER,
  timestamp       INTEGER,
  tool_calls_count INTEGER DEFAULT 0,
  tokens_used     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_conv_turns_run ON conversation_turns(run_id);
CREATE INDEX IF NOT EXISTS idx_conv_turns_session ON conversation_turns(session_key);
```

提供以下方法（全部用 prepared statement 缓存）：
- `insertRun(runId, sessionKey, startedAt, opts?: {channel, agentId})`
- `completeRun(runId, endedAt, status, errorMessage?)` — UPDATE runs + 从 llm_calls/tool_executions 聚合汇总字段
- `insertLlmCall(runId, callIndex, startedAt, opts)` — 插入一条 LLM 调用记录
- `insertToolExecution(runId, toolCallId, toolName, startedAt, opts)` — 插入一条 tool 执行记录
- `insertConversationTurn(runId, sessionKey, turnIndex, role, contentPreview, contentLength, timestamp, opts?)` — 插入对话轮次
- `getOverview()` — 返回 `{activeRuns, totalRuns24h, totalTokens24h, totalCost24h}`
- `getSessions(filters?)` — session 列表 + 汇总指标
- `getRunDetail(runId)` — run + llm_calls + tool_executions + conversation_turns
- `getAuditSession(sessionKey)` — 返回该 session 的所有 run，每个 run 带 timeline + turns（审计视图核心 API）
- `getAuditRun(runId)` — 单个 run 的完整审计详情
- `insertSessionSnapshot(sessionKey, snapshotAt, data)`
- `cleanup(retentionDays)` — DELETE WHERE started_at < cutoff
- `close()` — db.close()

`getAuditSession(sessionKey)` 返回格式：
```typescript
{
  sessionKey: string;
  runs: Array<{
    runId: string;
    startedAt: number;
    duration: number;
    status: string;
    userPrompt: string;
    summary: {
      llmCalls: number;
      toolCalls: number;
      totalInputTokens: number;      // OFFICIAL — 同官方 Usage 口径
      totalOutputTokens: number;     // OFFICIAL
      officialCost: number | null;   // OFFICIAL — pi-ai 返回的 cost
      calculatedCost: number | null; // CALCULATED — ClawLens 独立重算
      costMatch: boolean;            // officialCost 和 calculatedCost 差异 < 0.1%
      costDiffReason?: string;       // 差异原因（如果不一致）
    };
    timeline: Array<{         // EXCLUSIVE — 官方没有的 per-call 瀑布图数据
      type: "llm_call" | "tool_execution";
      name?: string;
      startedAt: number;      // 相对于 run start 的偏移(ms)
      duration: number;
      inputTokens?: number;
      outputTokens?: number;
      officialCost?: number;
      calculatedCost?: number;
      toolName?: string;
      isError?: boolean;
    }>;
    turns: Array<{
      role: string;
      preview: string;
      length: number;
      toolCallsCount?: number;
    }>;
  }>;
}
```

`costDiffReason` 的可能值：
- `"pi-ai builtin pricing differs from config"` — pi-ai 内置定价和用户 config 定价不同
- `"provider did not return cost, using fallback"` — provider 没返回 cost，只有 calculated
- `"models.json pricing updated"` — models.json 更新了定价，和旧计算的差异

### `src/cost-calculator.ts`

> **一致性保证**：直接 re-export 官方的 cost 函数，不自己重新实现。
> 官方 `resolveModelCostConfig` 有三层 fallback（models.json → config → gateway pricing cache），
> 确保 ClawLens 显示的 cost 和 Usage 视图完全一致。

```typescript
// Re-export 官方 cost 函数（extensions 在同一个 monorepo 中，可以直接 import）
export { resolveModelCostConfig, estimateUsageCost } from "../../utils/usage-format.js";
export type { ModelCostConfig } from "../../utils/usage-format.js";
```

如果 `../../utils/usage-format.js` 路径不对（取决于 extensions 目录深度），用以下方式查找：
```bash
find . -name "usage-format.ts" -path "*/utils/*" | head -1
```
然后调整 import 路径。

### `src/collector.ts`

核心类。构造函数接收 `Store` + `SSEManager`。

关键设计：
- `activeRuns: Map<string, { runId, sessionKey, startedAt, llmCallIndex, lastUserPrompt?, systemPromptHash? }>` 跟踪进行中的 run
- `sessionIdToRunId: Map<string, string>` — 在 `llm_input` hook 中建立 `sessionId → runId` 映射，供 `agent_end`（context 只有 sessionId 没有 runId）使用
- `queue: Array<() => void>` 事件队列，`setInterval(100ms)` 批量 flush

> **⚠️ per-call usage 的关键数据源**
>
> `llm_output` hook 在整个 run 结束后只触发一次，返回的是累计 usage（无法拆分到每次 LLM 调用）。
> 瀑布图需要 per-call 粒度，使用 `runtime.events.onSessionTranscriptUpdate` 监听每条
> assistant message 写入 transcript。这和官方 Usage 视图从 .jsonl 解析的是同一个 message.usage 对象。

**数据源职责分工**：

| 方法 | 数据源 | 粒度 | 写入表 |
|------|--------|------|--------|
| `handleAgentEvent` | `onAgentEvent` | per-run | runs |
| `handleTranscriptUpdate` | `onSessionTranscriptUpdate` | per-LLM-call | llm_calls |
| `recordLlmInput` | `api.on("llm_input")` | per-LLM-call | activeRun state（暂存） |
| `recordToolCall` | `api.on("after_tool_call")` | per-tool-call | tool_executions |
| `recordAgentEnd` | `api.on("agent_end")` | per-run | conversation_turns |
| `recordLlmOutput` | `api.on("llm_output")` | per-run | runs（汇总字段更新） |

**start(runtime, config)** 方法中注册 `onSessionTranscriptUpdate`：
```typescript
this.unsubTranscript = runtime.events.onSessionTranscriptUpdate((update) => {
  this.handleTranscriptUpdate(update, config);
});
```

**handleTranscriptUpdate(update, config)**：
- 从 `update.message` 提取 `role`, `usage`, `provider`, `model`
- 只处理 `role === "assistant"` 的 message
- 用 `normalizeUsage()` 标准化 token 数据（和官方相同函数）
- 提取两个 cost 值：
  - `officialCost`：从 `message.usage.cost.total` 直接取（pi-ai 内置定价，层次 1）
  - `calculatedCost`：用 `resolveModelCostConfig` + `estimateUsageCost` 独立重算（层次 2）
- 从 `activeRuns` 中找到对应的 run（通过 `update.sessionKey` 匹配）
- 写入 `llm_calls` 表（含 `official_cost` 和 `calculated_cost` 两个字段）

**recordLlmInput(event, ctx)**（`llm_input` hook）：
- 建立 `sessionIdToRunId` 映射
- 保存 `lastUserPrompt` 和 `systemPromptHash` 到 activeRun state
- 这些数据在 `handleTranscriptUpdate` 写入 llm_calls 时一并写入

**recordToolCall(event, ctx)**（`after_tool_call` hook）：
- event: `toolName, toolCallId, params, result, error, durationMs, runId`
- ctx: `sessionKey, agentId, runId, toolName, toolCallId`

**recordAgentEnd(event, ctx)**（`agent_end` hook）：
- event: `messages: unknown[], success: boolean, durationMs?: number`
- ctx: `sessionKey, sessionId, agentId`（**没有 runId**，通过 `sessionIdToRunId` 映射）
- 从 `event.messages` 提取对话轮次写入 `conversation_turns` 表

**recordLlmOutput(event, ctx)**（`llm_output` hook）：
- 用 per-run 累计 usage 更新 `runs` 表的汇总字段（totalInputTokens 等）
- **不用于瀑布图**（per-call 数据来自 `handleTranscriptUpdate`）

**stop()**：清理 timer，flush 剩余队列，`unsubTranscript()`

### `src/comparator.ts`

构造函数接收 `Store` + `SSEManager` + `PluginRuntime`。

`maybeForCompare(event, ctx, config)` 方法：
1. 检查 `config.channels?.includes(ctx.channelId)` — 不匹配则 return
2. 从 session store 读取主模型：
   ```typescript
   const storePath = this.runtime.agent.session.resolveStorePath(ctx.agentId);
   const sessionStore = this.runtime.agent.session.loadSessionStore(storePath);
   const entry = sessionStore[ctx.sessionKey!];
   const primaryModel = entry?.model;
   const primaryProvider = entry?.modelProvider;
   ```
3. 从 config.models 中过滤掉主模型
4. 为每个对比模型异步调用 `this.runtime.agent.runEmbeddedPiAgent({...})`：
   - `sessionKey`: `${ctx.sessionKey}:clawlens:${provider}:${model}`
   - `sessionFile`: `path.join(stateDir, "clawlens", "compare", groupId, "${provider}_${model}.jsonl")`
   - `workspaceDir`: `path.join(stateDir, "clawlens", "compare", groupId, "${provider}_${model}")`
   - `lane: "compare"`
   - `timeoutMs: config.timeoutMs ?? 300000`
   - `onAgentEvent`: 回调直接记录到 store
5. 返回 `undefined`（不修改主运行的 model）

### `src/sse-manager.ts`

```typescript
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export class SSEManager {
  private clients = new Map<string, ServerResponse>();
  private maxClients = 10;

  addClient(res: ServerResponse): string | null {
    if (this.clients.size >= this.maxClients) return null;
    const id = randomUUID();
    this.clients.set(id, res);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    this.sendTo(id, { type: "connected" });
    return id;
  }
  removeClient(id: string): void { this.clients.delete(id); }
  broadcast(payload: object): void {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const [id, res] of this.clients) {
      try { res.write(data); } catch { this.clients.delete(id); }
    }
  }
  private sendTo(id: string, payload: object): void {
    const res = this.clients.get(id);
    if (res) try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { this.clients.delete(id); }
  }
  closeAll(): void { for (const [, res] of this.clients) try { res.end(); } catch {} this.clients.clear(); }
  get clientCount(): number { return this.clients.size; }
}
```

### `src/api-routes.ts`

用单个 `registerHttpRoute` 注册 prefix match `/plugins/clawlens/api`，内部按 pathname 分发。

`auth: "plugin"` — 所有路由内部自行验证 token。SSE endpoint 从 query param 取 token，其他路由从 `Authorization: Bearer` 取。token 和 `(api.config as any)?.auth?.token` 比对。如果 gateway 没配 token（token 为空），跳过验证。

路由：
- `GET .../overview` → `sendJson(res, 200, store.getOverview())`
- `GET .../sessions` → 解析 query params → `sendJson(res, 200, store.getSessions(filters))`
- `GET .../run/xxx` → 从 pathname 提取 runId → `sendJson(res, 200, store.getRunDetail(runId))`
- `GET .../audit/session/xxx` → 从 pathname 提取 sessionKey → `sendJson(res, 200, store.getAuditSession(sessionKey))`（审计视图核心 API）
- `GET .../audit/run/xxx` → 从 pathname 提取 runId → `sendJson(res, 200, store.getAuditRun(runId))`
- `GET .../events` → SSE（token 从 query param 取）
- 其他 → `sendJson(res, 404, { error: "not found" })`

### `src/static-server.ts`

导出一个函数 `registerStaticRoutes(api, rootDir)`。注册 `/plugins/clawlens/ui` prefix route，从 `rootDir`（即 `path.join(api.rootDir!, "ui")`）读取文件并返回。

只允许 `.js`, `.css`, `.html`, `.svg`, `.png` 后缀。Content-Type 根据后缀设置。路径遍历防护：`path.resolve` 后检查 `startsWith(rootDir)`。

### `ui/inject.js`

纯 JavaScript ESM module。包含两个主要注入功能：Overview 面板 + Chat 审计面板。

**功能 1：Overview 面板**（已有）
1. `waitForElement("openclaw-app")` — polling/MutationObserver 等待 app 加载
2. 从 `sessionStorage` 读取 `openclaw.control.token.v1:*` 作为 gateway token
3. SSE 连接 `/plugins/clawlens/api/events?token=...`
4. 定期 fetch `/plugins/clawlens/api/overview`（带 `Authorization: Bearer` header）
5. MutationObserver 监听 DOM 变化，在 `.overview-cards` 或 `.card` 后面注入 `#clawlens-panel`
6. 面板显示 Active Runs / Runs (24h) / Tokens (24h) / Cost (24h)

**功能 2：Chat 审计面板**（新增，核心功能）

当用户在 Chat 视图时，在聊天区域右侧注入可折叠的审计侧栏。

检测 Chat 视图：MutationObserver 监听 DOM 变化，检测 URL hash/pathname 中是否包含 `/chat` 或 DOM 中是否存在 `.chat-view` 元素。

从 URL 或 DOM 中提取当前 sessionKey：
```javascript
// Control UI 的 chat 视图 URL 格式: /chat?session=<sessionKey> 或从 DOM 中查找
function getCurrentSessionKey() {
  const url = new URL(location.href);
  const session = url.searchParams.get("session");
  if (session) return session;
  // 尝试从 DOM 中的 session 选择器获取
  const sel = document.querySelector("[data-session-key]");
  return sel?.getAttribute("data-session-key") ?? null;
}
```

当检测到 chat 视图 + sessionKey 存在时：
1. fetch `/plugins/clawlens/api/audit/session/{sessionKey}` 获取审计数据
2. 在聊天区域旁边注入 `#clawlens-audit-panel`
3. 面板包含：
   - 每个 run 的摘要卡片（用户 prompt 预览、LLM/tool 调用次数、token、cost、耗时）
   - 可展开的瀑布图（timeline 渲染为水平条形图）
   - 对话轮次列表（role + content preview）

审计面板的 HTML 结构：
```javascript
function renderAuditPanel(data) {
  if (!data || !data.runs?.length) return '<div class="card-sub">No audit data for this session</div>';
  return data.runs.map((run, i) => `
    <div class="clawlens-audit-run${i === 0 ? ' expanded' : ''}">
      <div class="clawlens-audit-run-hdr" onclick="this.parentElement.classList.toggle('expanded')">
        <div class="clawlens-audit-run-top">
          <span class="clawlens-audit-run-num">#${i + 1} Run</span>
          <span class="clawlens-audit-run-time">${formatDuration(run.duration)}</span>
        </div>
        <div class="clawlens-audit-run-prompt">${escapeHtml(run.userPrompt || '(no prompt)')}</div>
        <div class="clawlens-audit-run-stats">
          <span>${run.summary.llmCalls} LLM</span>
          <span>${run.summary.toolCalls} tool</span>
          <span>${formatTokens(run.summary.totalInputTokens + run.summary.totalOutputTokens)} tok <span class="clawlens-tag official">OFFICIAL</span></span>
          <span class="cost">${formatCost(run.summary.officialCost)} <span class="clawlens-tag official">OFFICIAL</span></span>
          ${run.summary.costMatch === false ? `<span class="clawlens-cost-diff" title="${escapeHtml(run.summary.costDiffReason || '')}">⚠ ${formatCost(run.summary.calculatedCost)} <span class="clawlens-tag calculated">CALC</span></span>` : ''}
        </div>
      </div>
      <div class="clawlens-audit-run-detail">
        <div class="clawlens-section-label">Timeline <span class="clawlens-tag exclusive">EXCLUSIVE</span></div>
        <div class="clawlens-tl-legend">
          <span><span class="clawlens-tl-legend-dot" style="background:var(--info,#3b82f6)"></span>LLM</span>
          <span><span class="clawlens-tl-legend-dot" style="background:var(--ok,#22c55e)"></span>Tool</span>
        </div>
        ${renderTimeline(run.timeline, run.duration)}
        <div class="clawlens-section-label" style="margin-top:8px">Turns</div>
        <div class="clawlens-turns">${renderTurns(run.turns)}</div>
      </div>
    </div>
  `).join('');
}

function renderTimeline(timeline, totalDuration) {
  if (!timeline?.length) return '';
  return '<div class="clawlens-timeline-bar">' + timeline.map(entry => {
    const left = totalDuration > 0 ? (entry.startedAt / totalDuration * 100) : 0;
    const width = totalDuration > 0 ? Math.max(entry.duration / totalDuration * 100, 2) : 10;
    const cls = entry.type === 'llm_call' ? 'clawlens-tl-llm' : 'clawlens-tl-tool';
    const label = entry.type === 'llm_call' ? `LLM ${formatDuration(entry.duration)}` : `${entry.toolName} ${formatDuration(entry.duration)}`;
    return `<div class="${cls}" style="left:${left}%;width:${width}%" title="${label}"></div>`;
  }).join('') + '</div>';
}

function renderTurns(turns) {
  if (!turns?.length) return '';
  return turns.map(t => `
    <div class="clawlens-turn">
      <span class="clawlens-turn-role ${t.role}">${t.role}</span>
      <span class="clawlens-turn-preview">${escapeHtml(t.preview?.slice(0, 120) || '')}</span>
    </div>
  `).join('');
}
```

**功能 3：Sessions 列表增强**（新增）

在 Sessions 视图中，为每个 session 行追加可展开的审计摘要。检测 sessions 视图：DOM 中存在 `.card` 且 `.card-title` 文本为 "Sessions"。

点击 session 行时，fetch 审计数据并展开显示该 session 的 run 列表。

**路由切换处理**：

用一个统一的 MutationObserver 监听 `document.body` 的 childList/subtree 变化，每次变化时检测当前在哪个页面（overview / chat / sessions），按需注入或移除面板。同时维护一个 `currentView` 状态避免重复注入。

### `ui/styles.css`

**重要**：所有颜色使用 OpenClaw Control UI 的 CSS 变量。以下是完整的 CSS，直接复制到文件中：

```css
/* =============================================
   ClawLens — Overview panel
   ============================================= */
#clawlens-panel {
  margin-top: 12px;
}
.clawlens-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
  margin-top: 8px;
}
.clawlens-stat {
  background: var(--card, #161920);
  border: 1px solid var(--border, #1e2028);
  border-radius: var(--radius-md, 10px);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.clawlens-stat-value {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
  color: var(--text-strong, #f4f4f5);
}
.clawlens-stat-label {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted, #838387);
  margin-top: 6px;
}

/* =============================================
   ClawLens — Audit sidebar (injected into chat-split-container)
   ============================================= */
.clawlens-audit-sidebar {
  width: 320px;
  flex-shrink: 0;
  border-left: 1px solid var(--border, #1e2028);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--panel, #0e1015);
  animation: clawlens-slide-in 200ms ease-out;
}
@keyframes clawlens-slide-in {
  from { opacity: 0; transform: translateX(20px); }
  to { opacity: 1; transform: translateX(0); }
}
.clawlens-audit-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border, #1e2028);
  flex-shrink: 0;
  background: var(--panel, #0e1015);
}
.clawlens-audit-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--accent-2, #14b8a6);
}
.clawlens-audit-close {
  background: none;
  border: none;
  color: var(--muted, #838387);
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
  border-radius: 4px;
}
.clawlens-audit-close:hover {
  background: var(--bg-hover, #1f2330);
}
.clawlens-audit-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* =============================================
   Audit — Run cards
   ============================================= */
.clawlens-audit-run {
  background: var(--card, #161920);
  border: 1px solid var(--border, #1e2028);
  border-radius: var(--radius-lg, 14px);
  overflow: hidden;
}
.clawlens-audit-run-hdr {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  cursor: pointer;
}
.clawlens-audit-run-hdr:hover {
  background: var(--bg-hover, #1f2330);
}
.clawlens-audit-run-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.clawlens-audit-run-num {
  font-size: 11px;
  font-weight: 500;
  color: var(--accent-2, #14b8a6);
}
.clawlens-audit-run-time {
  font-size: 11px;
  color: var(--muted-strong, #62626a);
}
.clawlens-audit-run-prompt {
  font-size: 12px;
  color: var(--text, #d4d4d8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.clawlens-audit-run-stats {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--muted, #838387);
  flex-wrap: wrap;
}
.clawlens-audit-run-stats .cost {
  color: var(--warn, #f59e0b);
}

/* Detail — collapsed by default, shown when .expanded */
.clawlens-audit-run-detail {
  display: none;
  border-top: 1px solid var(--border, #1e2028);
  padding: 10px 12px;
}
.clawlens-audit-run.expanded .clawlens-audit-run-detail {
  display: block;
}

/* =============================================
   Audit — Timeline (waterfall chart)
   ============================================= */
.clawlens-section-label {
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted-strong, #62626a);
  margin-bottom: 4px;
}
.clawlens-tl-legend {
  display: flex;
  gap: 10px;
  font-size: 10px;
  color: var(--muted, #838387);
  margin-bottom: 6px;
}
.clawlens-tl-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  display: inline-block;
  vertical-align: middle;
  margin-right: 3px;
}
.clawlens-timeline-bar {
  position: relative;
  height: 28px;
  background: var(--bg, #0e1015);
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 8px;
}
.clawlens-tl-llm,
.clawlens-tl-tool {
  position: absolute;
  top: 4px;
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 500;
  color: #fff;
  min-width: 20px;
}
.clawlens-tl-llm {
  background: var(--info, #3b82f6);
}
.clawlens-tl-tool {
  background: var(--ok, #22c55e);
}

/* =============================================
   Audit — Conversation turns
   ============================================= */
.clawlens-turns {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.clawlens-turn {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 11px;
  line-height: 1.4;
}
.clawlens-turn-role {
  flex-shrink: 0;
  width: 54px;
  text-align: right;
  font-weight: 500;
  padding-top: 1px;
}
.clawlens-turn-role.user { color: var(--muted, #838387); }
.clawlens-turn-role.assistant { color: var(--accent, #ff5c5c); }
.clawlens-turn-role.tool { color: var(--ok, #22c55e); }
.clawlens-turn-preview {
  color: var(--muted-strong, #62626a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* =============================================
   Chat topbar — Audit toggle button
   ============================================= */
.clawlens-audit-toggle {
  background: rgba(20, 184, 166, 0.12);
  border: 1px solid rgba(20, 184, 166, 0.25);
  color: var(--accent-2, #14b8a6);
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 500;
}
.clawlens-audit-toggle:hover {
  background: rgba(20, 184, 166, 0.2);
}

/* =============================================
   Data source tags — OFFICIAL / CALCULATED / EXCLUSIVE
   ============================================= */
.clawlens-tag {
  display: inline-block;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.03em;
  padding: 1px 4px;
  border-radius: 3px;
  vertical-align: middle;
  margin-left: 3px;
}
.clawlens-tag.official {
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted, #838387);
}
.clawlens-tag.calculated {
  background: rgba(59, 130, 246, 0.15);
  color: var(--info, #3b82f6);
}
.clawlens-tag.exclusive {
  background: rgba(20, 184, 166, 0.15);
  color: var(--accent-2, #14b8a6);
}
.clawlens-cost-diff {
  color: var(--warn, #f59e0b);
}

/* =============================================
   Mobile — audit sidebar goes fullscreen
   ============================================= */
@media (max-width: 768px) {
  .clawlens-audit-sidebar {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    width: 100%;
    z-index: 1000;
    border-left: none;
  }
}
```

**注意**：CSS 变量使用 `var(--name, fallback)` 格式，fallback 值是 OpenClaw 暗色主题（claw theme）的实际值。这样即使 CSS 变量加载顺序有问题，也不会出现白色或透明的异常。

### `index.ts`

完整入口文件结构：

```typescript
import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Collector } from "./src/collector.js";
import { Comparator } from "./src/comparator.js";
import { Store } from "./src/store.js";
import { SSEManager } from "./src/sse-manager.js";
import { registerApiRoutes } from "./src/api-routes.js";
import { registerStaticRoutes } from "./src/static-server.js";
import type { ClawLensConfig } from "./src/types.js";

const defaultConfig: ClawLensConfig = {
  collector: { enabled: true, snapshotIntervalMs: 60_000, retentionDays: 30 },
  compare: { enabled: false, models: [], channels: [], timeoutMs: 300_000, maxConcurrent: 3 },
};

export default definePluginEntry({
  id: "clawlens",
  name: "ClawLens",
  description: "Session monitor + multi-model comparator",
  register(api: OpenClawPluginApi) {
    const config: ClawLensConfig = { ...defaultConfig, ...(api.pluginConfig as ClawLensConfig) };
    const stateDir = api.runtime.state.resolveStateDir();
    const store = new Store(stateDir);
    const sseManager = new SSEManager();
    const collector = new Collector(store, sseManager);
    const comparator = new Comparator(store, sseManager, api.runtime, stateDir);

    if (config.collector?.enabled !== false) {
      api.runtime.events.onAgentEvent((evt) => collector.handleAgentEvent(evt));
      // ★ per-call usage 来自 onSessionTranscriptUpdate（在 collector.start() 中注册）
      api.on("llm_output", (event, ctx) => collector.recordLlmOutput(event, ctx));  // per-run 汇总
      api.on("llm_input", (event, ctx) => collector.recordLlmInput(event, ctx));
      api.on("after_tool_call", (event, ctx) => collector.recordToolCall(event, ctx));
      api.on("agent_end", (event, ctx) => collector.recordAgentEnd(event, ctx));
    }

    if (config.compare?.enabled) {
      api.on("before_agent_start", (event, ctx) => comparator.maybeForCompare(event, ctx, config.compare!));
    }

    registerApiRoutes(api, store, sseManager);
    registerStaticRoutes(api, path.join(api.rootDir!, "ui"));

    api.registerService({
      id: "clawlens-service",
      start: async () => {
        collector.start(api.runtime, api.config, config);
        api.logger.info("ClawLens plugin started");
      },
      stop: async () => {
        collector.stop();
        sseManager.closeAll();
        store.cleanup(config.collector?.retentionDays ?? 30);
        store.close();
      },
    });
  },
});
```

---

## 约束摘要

- TypeScript `.ts`（除了 `ui/inject.js` 和 `ui/styles.css`）
- `type: "module"` — import 用 `.js` 后缀
- 不需要 `npm install`、`tsconfig.json`、构建步骤
- SQLite 用 `node:sqlite`（`DatabaseSync`）
- Hook 用 **`api.on()`** 不是 `api.registerHook()`
- SSE 用 `auth: "plugin"` + query token
- 不要用 `deliver: false`（不存在此参数）
- `before_agent_start` context 没有 model/provider，从 session store 读取

---

## 自动验证

完成所有文件后，执行以下验证脚本。**如果任何一步失败，读错误信息修复代码，然后重新跑验证，直到全部通过。**

### 验证 1：Plugin 入口能加载

```bash
cd /path/to/openclaw
npx tsx -e "
import path from 'node:path';
const mod = await import(path.join(process.cwd(), 'extensions/clawlens/index.ts'));
const plugin = mod.default;
if (!plugin) throw new Error('no default export');
if (plugin.id !== 'clawlens') throw new Error('id mismatch: ' + plugin.id);
if (typeof plugin.register !== 'function') throw new Error('register is not a function');
console.log('✅ Plugin entry OK:', plugin.id, plugin.name);
"
```

### 验证 2：Store 能创建数据库和读写

```bash
npx tsx -e "
import { Store } from './extensions/clawlens/src/store.js';
import fs from 'node:fs';
import os from 'node:os';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawlens-test-'));
import path from 'node:path';
const store = new Store(tmpDir);
store.insertRun('run-1', 'sess-1', Date.now(), { channel: 'test' });
store.insertLlmCall('run-1', 0, Date.now(), { inputTokens: 100, outputTokens: 50, provider: 'openai', model: 'gpt-4o' });
store.insertToolExecution('run-1', 'tc-1', 'bash', Date.now(), {});
store.completeRun('run-1', Date.now(), 'completed');
const overview = store.getOverview();
console.log('✅ Store OK:', JSON.stringify(overview));
const detail = store.getRunDetail('run-1');
console.log('✅ RunDetail OK: llm_calls=' + detail.llmCalls.length + ' tools=' + detail.toolExecutions.length);
store.close();
fs.rmSync(tmpDir, { recursive: true });
"
```

### 验证 3：SSEManager 能 broadcast

```bash
npx tsx -e "
import { SSEManager } from './extensions/clawlens/src/sse-manager.js';
const mgr = new SSEManager();
console.log('✅ SSEManager OK, clients:', mgr.clientCount);
mgr.closeAll();
"
```

### 验证 4：Collector 能实例化

```bash
npx tsx -e "
import { Store } from './extensions/clawlens/src/store.js';
import { SSEManager } from './extensions/clawlens/src/sse-manager.js';
import { Collector } from './extensions/clawlens/src/collector.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawlens-test-'));
const store = new Store(tmpDir);
const sse = new SSEManager();
const collector = new Collector(store, sse);
console.log('✅ Collector OK');
store.close();
fs.rmSync(tmpDir, { recursive: true });
"
```

### 验证 5：所有 TS 文件能被 import（无语法/类型错误）

```bash
npx tsx -e "
const files = [
  './extensions/clawlens/src/types.js',
  './extensions/clawlens/src/store.js',
  './extensions/clawlens/src/cost-calculator.js',
  './extensions/clawlens/src/collector.js',
  './extensions/clawlens/src/sse-manager.js',
  './extensions/clawlens/src/api-routes.js',
  './extensions/clawlens/src/static-server.js',
];
for (const f of files) {
  try {
    await import(f);
    console.log('✅', f);
  } catch (e) {
    console.error('❌', f, e.message);
    process.exit(1);
  }
}
console.log('✅ All modules importable');
"
```

### 验证 6：inject.js 语法正确

```bash
node --check extensions/clawlens/ui/inject.js && echo "✅ inject.js syntax OK"
```

---

现在创建所有文件，然后逐个运行上面 6 个验证。如果有失败，修复后重跑。不要问问题，不要分步确认。

---

## 远程部署与联调

本地验证全部通过后，将插件部署到已运行的 OpenClaw 3.23 实例上。

> **⚠️ 远程服务器安全规则（必须严格遵守）：**
> - **只允许操作 `~/.openclaw/extensions/clawlens/` 目录**下的文件（创建、修改、删除）
> - **不要修改** OpenClaw 的任何其他文件，包括但不限于：openclaw.yaml（仅允许追加 clawlens 插件配置）、其他 extension 目录、dist/ 目录、node_modules/、系统配置文件
> - **不要安装任何全局包**，不要运行 `npm install -g`、`apt install`（`sshpass` 仅在本地安装）
> - **不要修改 `dist/control-ui/index.html`**（UI 注入的 script 标签将在后续手动添加）
> - **只允许执行**：`scp`（上传 clawlens 文件）、`openclaw config set`（注册插件）、`openclaw gateway restart`（重启）、`curl`（验证）、`cat/grep`（读日志）
> - 如果调试需要查看远程文件，只能用 `cat` / `grep` / `ls` 读取，**不要写入或修改**

连接信息：
- Host: <IP>
- Port: <SSH端口，默认22>
- User: <用户名>
- Password: <密码>
- OpenClaw 安装方式：npm 全局安装（非源码）

先确认 `sshpass` 可用，不可用则安装：
```bash
which sshpass || (apt-get update && apt-get install -y sshpass)
```

定义连接变量（后续所有命令复用）：
```bash
export REMOTE_HOST="<user>@<IP>"
export REMOTE_PORT="<SSH端口>"
export SSHPASS="<密码>"
alias rssh='sshpass -e ssh -o StrictHostKeyChecking=no -p $REMOTE_PORT $REMOTE_HOST'
alias rscp='sshpass -e scp -o StrictHostKeyChecking=no -P $REMOTE_PORT'
```

### 确认远程环境

```bash
# 1. 确认 OpenClaw 运行目录和 extensions 路径
rssh "ls ~/.openclaw/ && ls ~/.openclaw/extensions/ 2>/dev/null || echo 'no extensions yet'"

# 2. 确认 gateway 在运行
rssh "openclaw health 2>/dev/null || curl -s http://localhost:18789/__openclaw/control-ui-config.json"

# 3. 确认 Node 版本
rssh "node --version"
```

根据实际输出调整下面的路径。

### 部署插件

```bash
# 将 clawlens 目录拷贝到远程的 extensions 目录
rssh "mkdir -p ~/.openclaw/extensions/"
rscp -r extensions/clawlens/ $REMOTE_HOST:~/.openclaw/extensions/clawlens/
```

注意：如果 OpenClaw 使用了自定义 `OPENCLAW_STATE_DIR` 环境变量，extensions 目录在 `$OPENCLAW_STATE_DIR/extensions/` 下而不是 `~/.openclaw/extensions/`。通过第 1 步确认。

### 注册插件到配置

```bash
# 查看当前配置中有没有 plugins 配置
rssh "openclaw config get plugins.installs 2>/dev/null || echo 'no plugins config'"

# 添加 clawlens 到插件列表（如果 openclaw config set 支持）
rssh "openclaw config set plugins.installs.clawlens.source path --strict-json"
rssh "openclaw config set plugins.installs.clawlens.spec ~/.openclaw/extensions/clawlens --strict-json"
```

如果 `openclaw config set` 不支持嵌套写入，直接编辑配置文件：
```bash
rssh "cat ~/.openclaw/openclaw.yaml"
# 在 plugins.installs 下添加:
#   clawlens:
#     source: path
#     spec: ~/.openclaw/extensions/clawlens
```

### 重启 gateway 并验证

```bash
# 重启
rssh "openclaw gateway restart 2>&1"

# 等待启动（10秒）
sleep 10

# 验证 plugin 加载 — 检查日志
rssh "openclaw gateway logs 2>&1 | grep -i clawlens | tail -5"

# 验证 API 可访问（gateway 绑定 127.0.0.1，通过 ssh 在远程执行 curl）
rssh "curl -s http://localhost:18789/plugins/clawlens/api/overview"
```

如果返回 JSON → 部署成功。
如果 404 → plugin 没加载，查日志找原因。
如果连接拒绝 → gateway 没启动成功。

### 验证数据采集

在另一个 channel（如 Telegram）发一条消息触发 agent 运行，然后：

```bash
# 等待 agent 运行完成（约 30 秒）
sleep 30

# 检查是否采集到数据
rssh "curl -s http://localhost:18789/plugins/clawlens/api/sessions"
rssh "curl -s http://localhost:18789/plugins/clawlens/api/overview"
```

如果 sessions 返回了数据 → 完整工作。如果为空 → 检查 `api.on()` hook 注册是否成功，查 gateway 日志中的 hook 相关错误。

### 验证 UI 效果

Gateway 绑定 `127.0.0.1`，无法从外部直接访问。需要通过 SSH 端口转发将远程的 dashboard 端口映射到本地。

**Step 1：建立 SSH 隧道**

```bash
# 在本地建立端口映射（后台运行）
sshpass -e ssh -o StrictHostKeyChecking=no -p $REMOTE_PORT -L 18789:127.0.0.1:18789 -N -f $REMOTE_HOST
```

这会把远程的 `127.0.0.1:18789` 映射到本地的 `localhost:18789`。

**Step 2：获取 Dashboard 访问地址**

```bash
# 远程执行获取 dashboard URL（含 auth token）
rssh "openclaw dashboard --no-open"
```

输出类似：`http://localhost:18789/?token=xxxx`。记录这个完整 URL。

**Step 3：用无头浏览器验证 UI（2K 分辨率）**

> **重要**：无头浏览器默认分辨率 800x600 会导致布局和真实效果不一致。必须同时设置
> `--window-size` 和 `--screen-info` 两个参数，否则 `screen.width/height` 仍是 800x600。

```bash
# 确认 chromium/google-chrome 可用
which google-chrome || which chromium-browser || which chromium || echo "需要安装 chromium"

# 用 2K 分辨率截图验证 Overview 页面
DASHBOARD_URL="<Step 2 获取的完整 URL>"

google-chrome \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --screenshot=/tmp/clawlens-overview.png \
  --window-size=2560,1440 \
  --screen-info="{2560x1440}" \
  "${DASHBOARD_URL}"

echo "✅ Overview 截图: /tmp/clawlens-overview.png"

# 截图 Chat 页面（验证审计侧栏）
# 需要先从 dashboard URL 中提取 token，然后拼接 chat 路径
TOKEN=$(echo "$DASHBOARD_URL" | grep -oP 'token=\K[^&]+')
CHAT_URL="http://localhost:18789/chat?token=${TOKEN}"

google-chrome \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --screenshot=/tmp/clawlens-chat-audit.png \
  --window-size=2560,1440 \
  --screen-info="{2560x1440}" \
  "${CHAT_URL}"

echo "✅ Chat+Audit 截图: /tmp/clawlens-chat-audit.png"
```

如果本地没有 Chrome/Chromium，用 Puppeteer 代替：

```bash
npx puppeteer browsers install chrome
node -e "
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--window-size=2560,1440',
      '--screen-info={2560x1440}',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 2560, height: 1440 });
  await page.goto('$DASHBOARD_URL', { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForTimeout(3000);  // 等待 ClawLens inject.js 加载
  await page.screenshot({ path: '/tmp/clawlens-overview.png', fullPage: false });
  console.log('✅ Overview screenshot saved');

  // 检查 ClawLens 面板是否注入成功
  const panel = await page.\$('#clawlens-panel');
  if (panel) {
    console.log('✅ ClawLens overview panel injected');
  } else {
    console.error('❌ ClawLens overview panel NOT found — inject.js 可能没加载');
  }

  await browser.close();
})();
"
```

**Step 4：检查截图**

打开截图文件检查：
1. Overview 页面是否有 ClawLens 面板（Active Runs / Runs / Tokens / Cost 四个卡片）
2. Chat 页面是否有审计侧栏（右侧 320px 面板，含 run 卡片和瀑布图）
3. 布局是否正常（没有溢出、错位、空白区域）

```bash
# 用 file 命令确认截图生成成功
file /tmp/clawlens-overview.png
file /tmp/clawlens-chat-audit.png
```

如果截图中看不到 ClawLens 面板，检查：
1. `dist/control-ui/index.html` 是否已添加 `<script>` 标签
2. `/plugins/clawlens/ui/inject.js` 是否可访问：`rssh "curl -s -o /dev/null -w '%{http_code}' http://localhost:18789/plugins/clawlens/ui/inject.js"`
3. 浏览器控制台错误：用 Puppeteer 的 `page.on('console', msg => console.log(msg.text()))` 捕获

---

部署验证如果有失败，读错误信息修复代码，重新 scp + restart，直到全部通过。
