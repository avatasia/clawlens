# ClawLens — 增量更新：审计视图

> **版本兼容性**：ClawLens 基于 OpenClaw v2026.3.22 源码分析设计。经 v2026.3.23 / 3.23-2 变更日志核查：
> Plugin SDK（`openclaw/plugin-sdk/*`）、`api.on()` typed hooks、`registerHttpRoute`、
> `registerService`、`runtime.events.onAgentEvent` 等我们使用的 API 均无 breaking change。
> 3.23 的 UI 按钮 class 整合（`btn--icon` 等）不影响我们的 `clawlens-*` 前缀样式。
> **结论：代码无需因版本升级做任何修改。**

你将在已完成的 ClawLens 插件基础上，增加审计视图（Audit View）功能。ClawLens 已经部署在远程 OpenClaw 3.23 实例上并正常运行。

**在修改任何代码之前，先完整读取以下文件，理解现有实现：**

```bash
cat extensions/clawlens/index.ts
cat extensions/clawlens/src/store.ts
cat extensions/clawlens/src/collector.ts
cat extensions/clawlens/src/api-routes.ts
cat extensions/clawlens/src/sse-manager.ts
cat extensions/clawlens/src/types.ts
cat extensions/clawlens/ui/inject.js
cat extensions/clawlens/ui/styles.css
```

读完后再开始改代码。不要问问题，不要分步确认。

---

## 需求概述

当前 ClawLens 只有 Overview 面板显示 4 个聚合数字，和具体对话没有关联。需要增加审计视图，把每次对话拆解为完整的执行链路：用户消息 → LLM 调用 → tool 执行 → LLM 回复，显示每一步的 token、cost、耗时。

---

## 需要改动的文件

### 1. `src/store.ts` — 新增表 + 修改现有表 + 新增方法

**修改 `llm_calls` 表**（用 ALTER TABLE 追加列，兼容已有数据）：

```sql
-- 将 cost_usd 拆分为双 cost 列
ALTER TABLE llm_calls ADD COLUMN official_cost REAL;    -- 层次 1: pi-ai 内置定价
ALTER TABLE llm_calls ADD COLUMN calculated_cost REAL;  -- 层次 2: resolveModelCostConfig 重算
ALTER TABLE llm_calls ADD COLUMN user_prompt_preview TEXT;
-- 注意：如果 cost_usd 列已有数据，将其值复制到 calculated_cost
-- UPDATE llm_calls SET calculated_cost = cost_usd WHERE cost_usd IS NOT NULL;
```

如果 store.ts 的建表 SQL 还没有这些列，在 CREATE TABLE 中直接加：
```sql
  official_cost REAL,
  calculated_cost REAL,
  user_prompt_preview TEXT,
```

**修改 `runs` 表**（同上方式追加）：
```sql
ALTER TABLE runs ADD COLUMN total_official_cost REAL DEFAULT 0;
ALTER TABLE runs ADD COLUMN total_calculated_cost REAL DEFAULT 0;
```

**新增 `conversation_turns` 表**（在现有建表 SQL 后面追加）：

```sql
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

**新增方法**（追加到现有 Store class 中）：

- `insertConversationTurn(runId, sessionKey, turnIndex, role, contentPreview, contentLength, timestamp, opts?)` — prepared statement

- `getAuditSession(sessionKey)` — 核心审计 API，返回：
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
            totalInputTokens: number;
            totalOutputTokens: number;
            officialCost: number | null;    // pi-ai 返回
            calculatedCost: number | null;  // ClawLens 重算
            costMatch: boolean;             // 差异 < 0.1%
            costDiffReason?: string;
          };
      timeline: Array<{
        type: "llm_call" | "tool_execution";
        name?: string;
        startedAt: number;   // 相对于 run start 的偏移(ms)
        duration: number;
        inputTokens?: number;
        outputTokens?: number;
        cost?: number;
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
  实现逻辑：
  1. 查 `runs` 表 WHERE session_key = ? ORDER BY started_at
  2. 对每个 run，查 `llm_calls` 和 `tool_executions`，按 started_at 交叉排序生成 timeline
  3. 对每个 run，查 `conversation_turns` ORDER BY turn_index
  4. timeline 中的 startedAt 转为相对于 run.started_at 的偏移量

- `getAuditRun(runId)` — 单个 run 的详情（和 getAuditSession 中单个 run 的结构相同）

### 2. `src/collector.ts` — 新增 transcript 监听 + agent_end + cost 修正

**新增状态**（追加到现有 Collector class 中）：
- `sessionIdToRunId: Map<string, string>` — sessionId → runId 映射
- `unsubTranscript: (() => void) | null` — transcript 事件取消订阅函数

**新增 `handleTranscriptUpdate` 方法**（瀑布图 per-call 数据的核心来源）：

> `llm_output` hook 在整个 run 结束后只触发一次，返回累计 usage，无法拆分到每次 LLM 调用。
> 必须用 `onSessionTranscriptUpdate` 监听每条 assistant message 写入，获取 per-call usage。
> 这和官方 Usage 视图从 .jsonl 解析的是同一个 message.usage 对象。

```typescript
import { resolveModelCostConfig, estimateUsageCost } from "../../utils/usage-format.js";

handleTranscriptUpdate(update: { sessionFile: string; sessionKey?: string; message?: unknown }, config: OpenClawConfig) {
  const msg = update.message as Record<string, unknown> | undefined;
  if (!msg || msg.role !== "assistant") return;
  const usageRaw = msg.usage as Record<string, unknown> | undefined;
  if (!usageRaw) return;

  const usage = normalizeUsage(usageRaw);  // 同官方 normalizeUsage
  if (!usage) return;

  const provider = String(msg.provider ?? "");
  const model = String(msg.model ?? "");
  const sessionKey = update.sessionKey;
  const run = sessionKey
    ? [...this.activeRuns.values()].find(r => r.sessionKey === sessionKey)
    : undefined;
  if (!run) return;

  // ★ 层次 1：官方口径 cost — 从 message.usage.cost.total 直接取
  const costObj = usageRaw.cost as Record<string, unknown> | undefined;
  const officialCost = (costObj && typeof costObj.total === 'number' && Number.isFinite(costObj.total))
    ? costObj.total as number : null;

  // ★ 层次 2：ClawLens 计算 cost — resolveModelCostConfig 三层 fallback
  const costConfig = resolveModelCostConfig({ provider, model, config });
  const calculatedCost = estimateUsageCost({ usage, cost: costConfig }) ?? null;

  this.queue.push(() => {
    this.store.insertLlmCall({
      runId: run.runId,
      callIndex: run.llmCallIndex++,
      startedAt: Date.now(),
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      officialCost,       // 层次 1
      calculatedCost,     // 层次 2
      provider, model,
      systemPromptHash: run.systemPromptHash,
      userPromptPreview: run.lastUserPrompt,
    });
  });
}
```

**在 `start()` 方法中注册 transcript 监听**（追加到现有 start 逻辑末尾）：
```typescript
this.unsubTranscript = runtime.events.onSessionTranscriptUpdate((update) => {
  this.handleTranscriptUpdate(update, config);
});
```

**在 `stop()` 方法中取消订阅**（追加）：
```typescript
this.unsubTranscript?.();
```

**修改 `recordLlmInput` 方法**（如果已存在则修改，不存在则新增）：
- 建立映射：`this.sessionIdToRunId.set(event.sessionId, event.runId)`
- 在 activeRun state 中保存：`run.lastUserPrompt = event.prompt?.slice(0, 200)`
- 计算 system prompt hash：`run.systemPromptHash = simpleHash(event.systemPrompt ?? "")`

简单 hash 函数：
```typescript
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}
```

**重命名 `recordLlmCall` → `recordLlmOutput`**（如果已存在）：
- 此方法对应 `llm_output` hook，用于 per-run 汇总更新 `runs` 表
- **不再用于 per-call 的 `llm_calls` 写入**（per-call 由 `handleTranscriptUpdate` 负责）

**新增 `recordAgentEnd` 方法**：
```typescript
recordAgentEnd(event: { messages: unknown[]; success: boolean; durationMs?: number }, ctx: { sessionKey?: string; sessionId?: string }) {
  this.queue.push(() => {
    const runId = ctx.sessionId ? this.sessionIdToRunId.get(ctx.sessionId) : undefined;
    if (!runId || !ctx.sessionKey) return;

    const messages = event.messages as Array<{ role?: string; content?: string | unknown[] }>;
    let turnIndex = 0;
    for (const msg of messages) {
      const role = msg.role ?? "unknown";
      const content = typeof msg.content === "string"
        ? msg.content : JSON.stringify(msg.content ?? "");
      this.store.insertConversationTurn(
        runId, ctx.sessionKey, turnIndex++, role,
        content.slice(0, 500), content.length, Date.now()
      );
    }
  });
}
```

### 3. `src/cost-calculator.ts` — 改为 re-export 官方函数

**替换整个文件内容**为：
```typescript
export { resolveModelCostConfig, estimateUsageCost } from "../../utils/usage-format.js";
export type { ModelCostConfig } from "../../utils/usage-format.js";
```

如果路径不对，用 `find . -name "usage-format.ts" -path "*/utils/*"` 查找正确路径。

### 4. `index.ts` — 更新 hook 注册

将 `collector.recordLlmCall` 改为 `collector.recordLlmOutput`：

```typescript
// 修改前：
api.on("llm_output", (event, ctx) => collector.recordLlmCall(event, ctx));
// 修改后：
api.on("llm_output", (event, ctx) => collector.recordLlmOutput(event, ctx));
```

在 `api.on("after_tool_call", ...)` 后面追加（如果还没有）：
```typescript
api.on("agent_end", (event, ctx) => collector.recordAgentEnd(event, ctx));
```

### 5. `src/api-routes.ts` — 新增审计路由

在现有路由分发逻辑中追加两个路由：

```
GET .../audit/session/xxx → store.getAuditSession(sessionKey)
GET .../audit/run/xxx     → store.getAuditRun(runId)
```

路径解析方式和现有的 `.../run/xxx` 相同——从 pathname 中提取最后一段作为参数。

### 6. `ui/inject.js` — 新增 Chat 审计侧栏

**在现有代码基础上追加**（不要删除或重写已有的 Overview 面板逻辑）。

新增功能：当检测到 Chat 视图时，在聊天区域右侧注入审计侧栏。

**检测 Chat 视图**：URL pathname 包含 `/chat` 或 DOM 中存在 `.chat-split-container` 元素。

**获取 sessionKey**：
```javascript
function getCurrentSessionKey() {
  // 从 URL 参数获取
  const url = new URL(location.href);
  const s = url.searchParams.get("session");
  if (s) return s;
  // 从 DOM 中的 select 元素获取
  const sel = document.querySelector(".chat-session select");
  return sel?.value ?? null;
}
```

**注入方式**：找到 `.chat-split-container`，在其内部追加审计侧栏 div（和 OpenClaw 原生的 `.chat-sidebar` 并列）。同时在 `.chat-header` 或 topbar 区域追加一个 "Audit" 切换按钮。

**审计面板的 HTML 渲染**（完整代码）：

```javascript
function renderAuditPanel(data) {
  if (!data || !data.runs?.length) {
    return '<div class="clawlens-audit-body"><div style="color:var(--muted);padding:20px;text-align:center">No audit data</div></div>';
  }
  return '<div class="clawlens-audit-body">' + data.runs.map((run, i) => `
    <div class="clawlens-audit-run${i === 0 ? ' expanded' : ''}">
      <div class="clawlens-audit-run-hdr" onclick="this.parentElement.classList.toggle('expanded')">
        <div class="clawlens-audit-run-top">
          <span class="clawlens-audit-run-num">#${i + 1} Run</span>
          <span class="clawlens-audit-run-time">${formatDuration(run.duration)}</span>
        </div>
        <div class="clawlens-audit-run-prompt">${escapeHtml(run.userPrompt || '(no prompt)')}</div>
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
  `).join('') + '</div>';
}

function renderTimeline(timeline, totalDuration) {
  if (!timeline?.length || !totalDuration) return '';
  return '<div class="clawlens-timeline-bar">' + timeline.map(entry => {
    const left = (entry.startedAt / totalDuration * 100).toFixed(1);
    const width = Math.max(entry.duration / totalDuration * 100, 2).toFixed(1);
    const cls = entry.type === 'llm_call' ? 'clawlens-tl-llm' : 'clawlens-tl-tool';
    const label = entry.type === 'llm_call'
      ? `LLM ${formatDuration(entry.duration)}`
      : `${entry.toolName || 'tool'} ${formatDuration(entry.duration)}`;
    return `<div class="${cls}" style="left:${left}%;width:${width}%" title="${label}">${formatDuration(entry.duration)}</div>`;
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

**路由切换处理**：用现有的 MutationObserver（如果已有）扩展检测逻辑。每次 DOM 变化时判断当前页面：
- 如果在 overview → 注入/维护 Overview 面板
- 如果在 chat → 注入/维护审计侧栏
- 切换离开时移除对应面板

**sessionKey 变化监听**：在 chat 视图中，用 `setInterval(1000)` 轮询 `getCurrentSessionKey()`，如果变化则重新 fetch 审计数据。

### 7. `ui/styles.css` — 追加审计样式

**在现有样式末尾追加**（不要删除或覆盖已有的 Overview 面板样式）：

```css
/* =============================================
   ClawLens — Audit sidebar
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
.clawlens-audit-run-detail {
  display: none;
  border-top: 1px solid var(--border, #1e2028);
  padding: 10px 12px;
}
.clawlens-audit-run.expanded .clawlens-audit-run-detail {
  display: block;
}
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
.clawlens-tl-llm { background: var(--info, #3b82f6); }
.clawlens-tl-tool { background: var(--ok, #22c55e); }
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

---

## 约束

- **只修改 `extensions/clawlens/` 目录下的文件**
- **追加代码，不要重写**：在现有函数/类中追加方法和属性，不要删除已有逻辑
- Hook 用 `api.on()` 不是 `api.registerHook()`
- 所有颜色用 CSS 变量 `var(--name, fallback)`
- `agent_end` hook 的 context **没有 runId**，通过 `sessionIdToRunId` Map 关联
- SQLite 用 `node:sqlite`（`DatabaseSync`）

---

## 验证

改完后运行以下验证：

### 本地验证

```bash
# 1. 所有模块仍能 import
npx tsx -e "
const files = [
  './extensions/clawlens/src/types.js',
  './extensions/clawlens/src/store.js',
  './extensions/clawlens/src/collector.js',
  './extensions/clawlens/src/sse-manager.js',
  './extensions/clawlens/src/api-routes.js',
  './extensions/clawlens/src/static-server.js',
];
for (const f of files) {
  try { await import(f); console.log('✅', f); }
  catch (e) { console.error('❌', f, e.message); process.exit(1); }
}
"

# 2. Store 新功能测试
npx tsx -e "
import { Store } from './extensions/clawlens/src/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
const store = new Store(tmp);
store.insertRun('r1', 's1', Date.now() - 5000, { channel: 'test' });
store.insertLlmCall('r1', 0, Date.now() - 4000, { inputTokens: 100, outputTokens: 50, provider: 'openai', model: 'gpt-4o' });
store.insertToolExecution('r1', 'tc1', 'web_search', Date.now() - 3000, { durationMs: 1500 });
store.insertLlmCall('r1', 1, Date.now() - 1500, { inputTokens: 200, outputTokens: 100, provider: 'openai', model: 'gpt-4o' });
store.completeRun('r1', Date.now(), 'completed');
store.insertConversationTurn('r1', 's1', 0, 'user', 'hello world', 11, Date.now());
store.insertConversationTurn('r1', 's1', 1, 'assistant', 'hi there', 8, Date.now());
const audit = store.getAuditSession('s1');
console.log('runs:', audit.runs.length);
console.log('timeline:', audit.runs[0].timeline.length);
console.log('turns:', audit.runs[0].turns.length);
if (audit.runs.length !== 1) throw new Error('expected 1 run');
if (audit.runs[0].timeline.length !== 3) throw new Error('expected 3 timeline entries');
if (audit.runs[0].turns.length !== 2) throw new Error('expected 2 turns');
console.log('✅ Audit Store OK');
store.close();
fs.rmSync(tmp, { recursive: true });
"

# 3. inject.js 语法
node --check extensions/clawlens/ui/inject.js && echo '✅ inject.js OK'
```

### 远程部署

```bash
# 连接信息（使用之前定义的 rssh/rscp alias）
rscp -r extensions/clawlens/ $REMOTE_HOST:~/.openclaw/extensions/clawlens/
rssh "openclaw gateway restart 2>&1"
sleep 10
rssh "openclaw gateway logs 2>&1 | grep -i clawlens | tail -5"
rssh "curl -s http://localhost:18789/plugins/clawlens/api/overview"
rssh "curl -s http://localhost:18789/plugins/clawlens/api/audit/session/test 2>/dev/null || echo 'audit endpoint exists (empty data expected)'"
```

### UI 验证（2K 分辨率截图）

```bash
# SSH 隧道（如果还没建立）
sshpass -e ssh -o StrictHostKeyChecking=no -p $REMOTE_PORT -L 18789:127.0.0.1:18789 -N -f $REMOTE_HOST

# 获取 dashboard URL
DASHBOARD_URL=$(rssh "openclaw dashboard --no-open 2>&1" | grep -oP 'http://[^\s]+')

# 截图 Overview
google-chrome --headless=new --no-sandbox --disable-gpu \
  --screenshot=/tmp/clawlens-overview.png \
  --window-size=2560,1440 --screen-info="{2560x1440}" \
  "${DASHBOARD_URL}"

# 截图 Chat（验证审计侧栏）
TOKEN=$(echo "$DASHBOARD_URL" | grep -oP 'token=\K[^&]+')
google-chrome --headless=new --no-sandbox --disable-gpu \
  --screenshot=/tmp/clawlens-chat.png \
  --window-size=2560,1440 --screen-info="{2560x1440}" \
  "http://localhost:18789/chat?token=${TOKEN}"

echo "检查截图: /tmp/clawlens-overview.png /tmp/clawlens-chat.png"
```

---

> **⚠️ 远程服务器安全规则**：
> - 只允许操作 `~/.openclaw/extensions/clawlens/` 目录
> - 不要修改 OpenClaw 的任何其他文件
> - 不要安装全局包
> - 不要修改 `dist/control-ui/index.html`

如果验证失败，读错误信息修复代码，重新部署验证，直到全部通过。不要问问题。
