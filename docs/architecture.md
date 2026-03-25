# ClawLens Plugin — 架构设计文档

> 基于 analysis-raw.md 源码分析结论
> OpenClaw v2026.3.22 / pi-agent-core 0.61.1

---

## 1. 系统定位

一个 OpenClaw Plugin，提供三个官方 Usage 视图没有的能力。

> **设计原则**：OpenClaw 3.23 的 Usage 视图已包含完善的 session 级别 token/cost 统计、
> 时间序列图表、对话记录查看、tool 使用统计、延迟分析。ClawLens 不重复这些功能，
> 只做官方没有的。

**功能 A — Per-run 审计瀑布图**：把每次用户消息拆解为 LLM 调用 → tool 执行 → LLM 回复的完整链路，在 Chat 视图中内嵌侧栏实时展示每一步的 token、cost、耗时。官方 Usage 只有 session 级别的聚合，没有 per-run 粒度的执行时间线。

**功能 B — 并发多模型对比**：在指定 channel 上拦截用户指令，并发发给 N 个模型各自执行完整 tool call 链，记录对比数据。

**功能 C — System Prompt 差异分析**：记录每次 LLM 调用的 system prompt hash，检测不同 channel/agent 注入的 system prompt 差异。

**UI 层**：Greasemonkey 模式注入 Chat 视图，添加审计侧栏。不注入 Overview 或 Sessions 页面（官方已有）。

---

## 1.1 审计数据模型

ClawLens 的数据分为三个层次，在 UI 中用不同标签区分。

### 层次 1：官方口径（Official）

从 `onSessionTranscriptUpdate` 监听到的 `message.usage` 中直接提取，**不做任何重算**。

| 字段 | 来源 | 说明 |
|------|------|------|
| input tokens | `message.usage.input` | 经 `normalizeUsage()` 标准化 |
| output tokens | `message.usage.output` | 同上 |
| cache read/write | `message.usage.cacheRead/cacheWrite` | 同上 |
| total tokens | `message.usage.total` 或 in+out+cache 求和 | 同上 |
| cost total | `message.usage.cost.total` | pi-ai 从内置定价表计算并写入 |
| cost breakdown | `message.usage.cost.{input,output,cacheRead,cacheWrite}` | 同上 |

**这和官方 Usage 视图读取的是同一个 message 对象、同一个 usage 字段。**

Token 数据保证一致（同一份数据）。Cost 数据在大多数情况下一致（pi-ai 内置定价计算），
但在以下场景可能和 Usage 视图显示的不同：
- pi-ai 返回的 `usage.cost` 为空 → 官方 fallback 到 `resolveModelCostConfig` 三层 fallback
- 用户在 `config.models.providers` 中配了自定义 cost → 官方用自定义 cost，pi-ai 用内置定价

### 层次 2：ClawLens 计算（Calculated）

用官方的 `resolveModelCostConfig` + `estimateUsageCost` 对同一份 token 数据**独立重算 cost**。

| 字段 | 来源 | 说明 |
|------|------|------|
| clawlens cost | `estimateUsageCost({usage, cost: resolveModelCostConfig(...)})` | 三层 fallback |

**和层次 1 的 cost 对比**：
- 一致 → UI 显示绿色勾 ✓
- 不一致 → UI 显示黄色差异提示，附带可能原因：
  - "pi-ai 内置定价 vs config 自定义定价不同"
  - "provider 未返回 cost，使用 fallback 计算"
  - "models.json 定价已更新，旧数据使用了旧定价"

### 层次 3：ClawLens 独有（Exclusive）

官方 Usage 视图**完全没有**的数据。

| 数据 | 来源 | 粒度 |
|------|------|------|
| Per-run 瀑布图 | llm_calls + tool_executions 交叉排序 | per-LLM-call / per-tool-call |
| System prompt hash | `llm_input` hook 的 `event.systemPrompt` | per-LLM-call |
| System prompt 差异检测 | 同一 session 不同 run 的 hash 对比 | per-session |
| Tool 执行详情 | `after_tool_call` hook 的 params/result/error | per-tool-call |
| 对话轮次链路 | `agent_end` hook 的 `event.messages` | per-run |
| 并发多模型对比 | Module B comparator | per-prompt |

### UI 标注规则

审计侧栏中，每个数据点用右上角小标签标注来源：

```
Token 使用                      Cost
┌──────────────────────┐  ┌──────────────────────────────┐
│ 4,800 tokens  OFFICIAL│  │ $0.0150  OFFICIAL             │
│                       │  │ $0.0148  CALCULATED  ≈ ✓     │
│ in: 4,000 / out: 750 │  │                               │
│ cache: 50r / 0w      │  │ 差异 $0.0002 — pi-ai 内置定价 │
│                       │  │ vs config 四舍五入差异         │
└──────────────────────┘  └──────────────────────────────┘

Timeline                        EXCLUSIVE
┌──────────────────────────────────────────┐
│ ■■■LLM 1.2s■■■  ■■tool 3.5s■■  ■■LLM■■ │
└──────────────────────────────────────────┘
```

- **OFFICIAL** — 灰色标签，表示数据来自官方口径（和 Usage 视图一致）
- **CALCULATED** — 蓝色标签，表示 ClawLens 独立计算的数据
- **EXCLUSIVE** — 青色（teal）标签，表示官方没有的独有数据
- **≈ ✓** — 绿色，两个 cost 值差异在 0.1% 以内
- **⚠ DIFF** — 黄色，两个 cost 值差异超过 0.1%，附带差异原因

---

## 2. 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway 进程                        │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              clawlens-plugin                       │  │
│  │                                                            │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │  │
│  │  │ Collector │  │Comparator│  │  Store   │  │   API    │  │  │
│  │  │ (模块 A)  │  │ (模块 B) │  │ (SQLite) │  │(HTTP+WS) │  │  │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │  │
│  │       │              │              │              │        │  │
│  └───────┼──────────────┼──────────────┼──────────────┼────────┘  │
│          │              │              │              │            │
│  ════════╪══════════════╪══════════════╪══════════════╪════════    │
│  OpenClaw│ 官方 API     │              │              │            │
│          │              │              │              │            │
│  ┌───────▼──────┐ ┌────▼─────┐        │    ┌────────▼────────┐   │
│  │onAgentEvent  │ │runEmbedde│        │    │registerHttpRoute│   │
│  │(全局事件总线) │ │dPiAgent  │        │    │registerGateway  │   │
│  │              │ │(发起运行) │        │    │Method           │   │
│  └──────────────┘ └──────────┘        │    └─────────────────┘   │
│                                       │                           │
│  ┌────────────────────────────────────▼───────────────────────┐  │
│  │                  Control UI (Lit, Light DOM)                │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  inject.js (注入脚本)                                 │  │  │
│  │  │  ├─ 监控面板 (Overview 页)                            │  │  │
│  │  │  ├─ Session 列表增强 (token badge, 效率指标)          │  │  │
│  │  │  ├─ 瀑布图 (Session 详情页)                           │  │  │
│  │  │  └─ 对比视图 (模块 B 结果展示)                        │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. 模块 A：全局 Session 监控

### 3.1 数据采集

使用 `runtime.events.onAgentEvent` 全局监听，这是 OpenClaw plugin runtime 的官方 API。

```
onAgentEvent(evt => {
  evt.runId      — 运行标识
  evt.sessionKey — session 标识
  evt.stream     — "lifecycle" | "tool" | "assistant" | "error"
  evt.data       — 事件详情
  evt.ts         — 时间戳
})
```

**采集的事件和数据映射**：

| 事件 | stream | data 关键字段 | 记录为 |
|------|--------|-------------|--------|
| 运行开始 | lifecycle | `phase: "start"` | run_start_at |
| 运行结束 | lifecycle | `phase: "end"`, durationMs | run_end_at, duration_ms |
| 运行错误 | lifecycle | `phase: "error"`, error | error_message |
| 助手文本 | assistant | text, delta | 累计文本长度 |
| 工具开始 | tool | toolName, toolCallId | tool_name, tool_start_at |
| 工具结束 | tool | result, durationMs | tool_duration_ms, is_error |

**补充数据源**：

- **Per-run 累计 usage**：通过 `api.on("llm_output", ...)` 获取整个 run 的累计 token usage
- **Per-call usage（瀑布图必需）**：通过 `runtime.events.onSessionTranscriptUpdate` 监听每条 assistant message 写入，提取 per-message usage
- **System prompt 差异**：通过 `api.on("llm_input", ...)` 捕获每次发送给模型的完整 system prompt
- **Tool 执行详情**：通过 `api.on("after_tool_call", ...)` 获取每次 tool 执行的结果和耗时

> **数据源一致性论证**
>
> ClawLens 的 token 数据和官方 Usage 视图来自**同一个源头**：pi-agent-core 的
> `message_end` 事件中的 `event.message.usage`。验证路径：
>
> 1. pi-agent-core agent-loop 每次 LLM 调用完成时 emit `message_end`
> 2. OpenClaw 的 `handleMessageEnd()`（pi-embedded-subscribe.handlers.messages.ts:325）从
>    `event.message.usage` 提取 usage，调用 `recordAssistantUsage()` 累加到 `usageTotals`
> 3. 同一个 `event.message` 对象通过 `appendMessage()` 写入 session state → persist 到 `.jsonl` transcript
> 4. 官方 Usage 视图从 `.jsonl` 逐行解析 `message.usage`（session-cost-usage.ts:130）
> 5. ClawLens 通过两个路径获取同一份数据：
>    - `llm_output` hook 的 `getUsageTotals()`：整个 run 结束后的累计值（per-run 粒度）
>    - `onSessionTranscriptUpdate` 的 `update.message.usage`：每条 message 写入时的独立值（per-call 粒度）
> 6. 两者都经过相同的 `normalizeUsage()` 标准化（处理各 provider 字段名差异）
>
> **结论**：token 数据**完全一致**，因为读的是同一个 message 对象的同一个 usage 字段。
>
> **⚠️ `llm_output` hook 是 per-run 触发，不是 per-LLM-call**
>
> `runLlmOutput` 在 attempt.ts 中只调用一次（run 结束后的 finally 块），`getUsageTotals()`
> 返回的是整个 run 的累计 usage。如果一个 run 中有 3 次 LLM 调用（tool call 循环），hook
> 只返回总和。瀑布图需要 per-call 数据，必须用 `onSessionTranscriptUpdate` 获取。
>
> **Cost 一致性**
>
> 官方用 `resolveModelCostConfig()` 有三层 fallback：
> 1. `models.json`（bundled model pricing）
> 2. `config.models.providers.*.cost`（用户配置）
> 3. gateway model pricing cache（运行时缓存）
>
> ClawLens 应直接 import 并调用官方的 `resolveModelCostConfig` + `estimateUsageCost`
> （从 `src/utils/usage-format.ts`），而不是自己重新实现。这样三层 fallback 完全一致，
> 不会出现官方显示 $0.015 而 ClawLens 显示 $0 的情况。
> Plugin 可以通过 `import { resolveModelCostConfig, estimateUsageCost } from "../../utils/usage-format.js"`
> 访问这些函数（extensions 在同一个 monorepo 中，共享 tsconfig）。
>
> - `onAgentEvent`（全局事件总线）适合追踪 **run 级别生命周期**（start/end/error）
> - `onAgentEvent` 的 `stream: "assistant"` 事件**不带 usage**，只有 text/delta
> - `onAgentEvent` 的 `stream: "tool"` 事件只有 `phase: "start"|"update"` 和 `name`，
>   **没有 `phase: "end"` 和 duration**
> - `after_tool_call` hook 提供完整的 tool 详情：toolName、params、result、error、durationMs

### 3.2 数据模型

```sql
-- 每次 agent 运行（一次用户指令触发一次运行）
CREATE TABLE runs (
  run_id          TEXT PRIMARY KEY,
  session_key     TEXT NOT NULL,
  channel         TEXT,
  agent_id        TEXT,
  provider        TEXT,
  model           TEXT,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_ms     INTEGER,
  status          TEXT DEFAULT 'running',  -- running | completed | error
  error_message   TEXT,
  -- 汇总字段（从 llm_calls 聚合）
  total_llm_calls INTEGER DEFAULT 0,
  total_input_tokens  INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cache_read    INTEGER DEFAULT 0,
  total_cache_write   INTEGER DEFAULT 0,
  total_official_cost  REAL DEFAULT 0,
  total_calculated_cost REAL DEFAULT 0,
  total_tool_calls    INTEGER DEFAULT 0,
  -- 对比相关
  compare_group_id TEXT,      -- 模块 B: 同一组对比的标识
  is_primary       INTEGER    -- 模块 B: 是否是返回给用户的主模型
);

-- 每次 LLM API 调用（一次运行中可能有多次调用，因为 tool call 循环）
CREATE TABLE llm_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES runs(run_id),
  call_index      INTEGER NOT NULL,  -- 第几次调用 (0, 1, 2...)
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_ms     INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cache_read      INTEGER,
  cache_write     INTEGER,
  official_cost   REAL,              -- 层次 1：pi-ai 内置定价计算的 cost (message.usage.cost.total)
  calculated_cost REAL,              -- 层次 2：ClawLens 用 resolveModelCostConfig 三层 fallback 重算的 cost
  provider        TEXT,
  model           TEXT,
  stop_reason     TEXT,
  message_count   INTEGER,
  system_prompt_hash TEXT,           -- system prompt 的 hash（用于检测 channel 差异）
  user_prompt_preview TEXT,          -- 用户 prompt 前 200 字符
  tool_calls_in_response INTEGER DEFAULT 0
);

-- 每次工具执行
CREATE TABLE tool_executions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES runs(run_id),
  llm_call_index  INTEGER NOT NULL,  -- 属于哪次 LLM 调用
  tool_call_id    TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_ms     INTEGER,
  is_error        INTEGER DEFAULT 0,
  args_summary    TEXT,     -- 参数摘要（truncated）
  result_summary  TEXT      -- 结果摘要（truncated）
);

-- 索引
CREATE INDEX idx_runs_session ON runs(session_key);
CREATE INDEX idx_runs_channel ON runs(channel);
CREATE INDEX idx_runs_compare ON runs(compare_group_id);
CREATE INDEX idx_runs_started ON runs(started_at);
CREATE INDEX idx_llm_calls_run ON llm_calls(run_id);
CREATE INDEX idx_tool_exec_run ON tool_executions(run_id);
```

### 3.3 Collector 实现

数据采集使用四个数据源，按职责分工：

| 数据源 | 粒度 | 采集内容 |
|--------|------|---------|
| `runtime.events.onAgentEvent` | per-run | run 生命周期（start/end/error） |
| `runtime.events.onSessionTranscriptUpdate` | per-LLM-call | 每次 LLM 调用的独立 usage + provider/model（瀑布图核心数据源） |
| `api.on("llm_input")` | per-LLM-call | system prompt hash + user prompt preview |
| `api.on("after_tool_call")` | per-tool-call | tool 名称、参数、结果、耗时 |

> **为什么不用 `api.on("llm_output")` 做瀑布图？**
>
> `llm_output` hook 在整个 run 结束后只触发一次（attempt.ts 的 finally 块），
> `getUsageTotals()` 返回的是所有 LLM 调用的累计值。如果一个 run 有 3 次 LLM 调用，
> hook 返回的是总和，无法拆分。瀑布图需要 per-call 粒度，必须用 `onSessionTranscriptUpdate`。
>
> `llm_output` hook 仍然保留注册，用于 Overview 面板的 per-run 汇总更新。

```typescript
// collector.ts 核心逻辑（伪代码）

// ★ 直接使用官方的 cost 函数，保证三层 fallback 一致
import { resolveModelCostConfig, estimateUsageCost } from "../../utils/usage-format.js";

class Collector {
  private store: Store;
  private sseManager: SSEManager;
  private activeRuns: Map<string, RunState>;
  private sessionIdToRunId: Map<string, string>;
  private eventQueue: Array<() => void> = [];
  private flushTimer: NodeJS.Timer | null = null;
  private unsubTranscript: (() => void) | null = null;

  start(runtime: PluginRuntime, config: OpenClawConfig) {
    this.flushTimer = setInterval(() => this.flushEventQueue(), 100);

    // ★ per-call usage 的数据源：每条 assistant message 写入 transcript 时触发
    this.unsubTranscript = runtime.events.onSessionTranscriptUpdate((update) => {
      this.handleTranscriptUpdate(update, config);
    });
  }

  // ── onAgentEvent：run 级别生命周期 ──
  handleAgentEvent(evt: AgentEventPayload) {
    this.eventQueue.push(() => {
      if (evt.stream !== 'lifecycle') return;
      if (evt.data.phase === 'start') {
        this.activeRuns.set(evt.runId, {
          runId: evt.runId,
          sessionKey: evt.sessionKey,
          startedAt: evt.ts,
          llmCallIndex: 0,
        });
        this.store.insertRun(evt);
        this.sseManager.broadcast({ type: 'run_started', runId: evt.runId });
      }
      if (evt.data.phase === 'end' || evt.data.phase === 'error') {
        this.store.completeRun(evt);
        this.activeRuns.delete(evt.runId);
        this.sseManager.broadcast({ type: 'run_ended', runId: evt.runId });
      }
    });
  }

  // ── onSessionTranscriptUpdate：per-call usage（瀑布图核心）──
  // 和官方 Usage 视图从 .jsonl 解析的是同一个 message.usage 对象
  handleTranscriptUpdate(update: SessionTranscriptUpdate, config: OpenClawConfig) {
    const msg = update.message as Record<string, unknown> | undefined;
    if (!msg || msg.role !== 'assistant') return;

    const usageRaw = msg.usage as Record<string, unknown> | undefined;
    if (!usageRaw) return;

    const usage = normalizeUsage(usageRaw);  // 同官方 normalizeUsage
    if (!usage) return;

    const provider = String(msg.provider ?? '');
    const model = String(msg.model ?? '');
    const sessionKey = update.sessionKey;
    const run = sessionKey
      ? [...this.activeRuns.values()].find(r => r.sessionKey === sessionKey)
      : undefined;
    if (!run) return;

    // ★ 层次 1：官方口径 cost — 从 message.usage.cost 直接提取（pi-ai 内置定价计算）
    const officialCost = extractCostFromUsage(usageRaw);  // usage.cost.total

    // ★ 层次 2：ClawLens 计算 cost — 用 resolveModelCostConfig 三层 fallback 独立重算
    const costConfig = resolveModelCostConfig({ provider, model, config });
    const calculatedCost = estimateUsageCost({ usage, cost: costConfig });

    this.eventQueue.push(() => {
      this.store.insertLlmCall({
        runId: run.runId,
        callIndex: run.llmCallIndex++,
        startedAt: Date.now(),
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        officialCost: officialCost ?? null,      // 层次 1
        calculatedCost: calculatedCost ?? null,  // 层次 2
        provider,
        model,
        systemPromptHash: run.systemPromptHash,
        userPromptPreview: run.lastUserPrompt,
      });
    });
  }

  // 从 usage.cost 中直接提取 pi-ai 返回的 cost
  private extractCostFromUsage(usageRaw: Record<string, unknown>): number | undefined {
    const cost = usageRaw.cost as Record<string, unknown> | undefined;
    if (!cost) return undefined;
    const total = cost.total;
    return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : undefined;
  }

  // ── llm_input hook：system prompt hash + user prompt ──
  recordLlmInput(event: LlmInputEvent, ctx: AgentContext) {
    this.eventQueue.push(() => {
      this.sessionIdToRunId.set(event.sessionId, event.runId);
      const run = this.activeRuns.get(event.runId);
      if (!run) return;
      run.lastUserPrompt = event.prompt?.slice(0, 200);
      run.systemPromptHash = simpleHash(event.systemPrompt ?? '');
    });
  }

  // ── after_tool_call hook：tool 执行详情 ──
  recordToolCall(event: AfterToolCallEvent, ctx: ToolContext) {
    this.eventQueue.push(() => {
      this.store.insertToolExecution({
        runId: ctx.runId ?? event.runId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        startedAt: Date.now() - (event.durationMs ?? 0),
        durationMs: event.durationMs,
        isError: !!event.error,
        argsSummary: truncate(JSON.stringify(event.params), 200),
        resultSummary: truncate(String(event.result ?? event.error ?? ''), 200),
      });
    });
  }

  // ── agent_end hook：对话轮次（conversation_turns）──
  recordAgentEnd(event: AgentEndEvent, ctx: AgentContext) {
    this.eventQueue.push(() => {
      const runId = ctx.sessionId
        ? this.sessionIdToRunId.get(ctx.sessionId)
        : undefined;
      if (!runId || !ctx.sessionKey) return;

      const messages = event.messages as Array<{ role?: string; content?: string | unknown[] }>;
      let turnIndex = 0;
      for (const msg of messages) {
        const role = msg.role ?? 'unknown';
        const content = typeof msg.content === 'string'
          ? msg.content : JSON.stringify(msg.content ?? '');
        this.store.insertConversationTurn(
          runId, ctx.sessionKey, turnIndex++, role,
          content.slice(0, 500), content.length, Date.now(),
        );
      }
    });
  }

  // ── llm_output hook：per-run 汇总（Overview 面板用）──
  recordLlmOutput(event: LlmOutputEvent, ctx: AgentContext) {
    // 用 per-run 累计 usage 更新 runs 表的汇总字段
    // 瀑布图的 per-call 数据来自 handleTranscriptUpdate
    this.eventQueue.push(() => {
      if (!event.usage) return;
      this.store.updateRunUsageTotals(event.runId, event.usage);
    });
  }

  private flushEventQueue() {
    const batch = this.eventQueue.splice(0);
    for (const fn of batch) fn();
  }

  stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushEventQueue();
    this.unsubTranscript?.();
  }
}
```

---

### 4.1 触发机制

通过 `api.on("before_agent_start", ...)` 拦截。当检测到配置中指定的 channel 和启用状态时，fork 出 N 个对比运行。

> **注意**：`before_agent_start` hook 的 `PluginHookAgentContext` 中没有 model/provider 信息
> （此时 model resolve 尚未完成）。主模型的识别通过 `runtime.agent.session.loadSessionStore()`
> 读取 `SessionEntry.model` + `SessionEntry.modelProvider` 获得。对比模型列表中排除主模型。

```
用户消息 (channel: telegram)
  │
  ▼
before_agent_start hook
  │
  ├─ 检查: compare.enabled && compare.channels.includes(ctx.channelId)
  │
  ├─ 如果不匹配 → return (正常流程)
  │
  └─ 如果匹配:
       ├─ 从 session store 读取当前 model/provider（主模型）
       ├─ 从 compare.models 中过滤掉主模型
       ├─ 生成 compare_group_id
       ├─ 异步启动 N 个对比运行（不阻塞原始流程）
       └─ return（原始模型正常返回给用户）
```

### 4.2 对比运行的执行

使用 `runtime.agent.runEmbeddedPiAgent` — OpenClaw 官方 API，不需要自己管理 Agent 实例。

该函数只负责执行并返回结果，不会自动投递到 channel（投递逻辑在上层 `agentCommandInternal` → `deliverAgentCommandResult` 中），所以对比运行的输出天然不会发给用户。

```typescript
// comparator.ts 核心逻辑（伪代码）

async function launchCompareRuns(params: {
  runtime: PluginRuntime;
  store: Store;
  prompt: string;
  sessionKey: string;
  compareModels: Array<{ provider: string; model: string }>;
  groupId: string;
  extraSystemPrompt?: string;
  config: OpenClawConfig;
  stateDir: string;
}) {
  for (const target of params.compareModels) {
    const compareSessionKey = `${params.sessionKey}:compare:${target.provider}:${target.model}`;
    const runId = `compare-${params.groupId}-${target.provider}-${target.model}`;

    // 异步启动，不等待完成
    params.runtime.agent.runEmbeddedPiAgent({
      sessionId: `compare-${params.groupId}-${target.model}`,
      sessionKey: compareSessionKey,
      prompt: params.prompt,
      provider: target.provider,
      model: target.model,
      extraSystemPrompt: params.extraSystemPrompt,
      config: params.config,
      runId,

      // 必填参数
      sessionFile: path.join(params.stateDir, 'compare', params.groupId,
        `${target.provider}_${target.model}.jsonl`),
      workspaceDir: path.join(params.stateDir, 'compare', params.groupId,
        `${target.provider}_${target.model}`),
      timeoutMs: 300_000,  // 5 分钟超时

      // 绕过 main lane — 使用独立 lane
      lane: "compare",

      // 每个对比运行自带事件回调，直接收集数据
      onAgentEvent: (evt) => {
        params.store.recordCompareEvent(params.groupId, target, runId, evt);
      },
    }).then((result) => {
      params.store.recordCompareResult(params.groupId, target, result);
      // 通知 SSE 客户端
      sseManager.broadcast({
        type: 'compare_completed',
        groupId: params.groupId,
        provider: target.provider,
        model: target.model,
      });
    }).catch((err) => {
      params.store.recordCompareError(params.groupId, target, err);
    });
  }
}
```

### 4.3 Lane 锁绕过

两层保障：

1. **Session lane**：每个对比模型用独立 `sessionKey`（`{originalKey}:compare:{provider}:{model}`），自然进入不同的 session lane
2. **Global lane**：传入 `lane: "compare""`，与默认的 `"main"` lane 隔离。`runEmbeddedPiAgent` 的 `lane` 参数已确认存在于 `RunEmbeddedPiAgentParams` 中

### 4.4 Workspace 隔离

每个对比运行使用独立的 workspace 目录：

```
~/.openclaw/clawlens/compare/
  └── {groupId}/
      ├── anthropic_claude-sonnet-4/     ← Model A 的 workspace
      │   └── (tool 执行的文件操作在这里)
      ├── openai_gpt-4o/                 ← Model B 的 workspace
      │   └── ...
      └── results.json                   ← 对比结果汇总
```

如果 OpenClaw 配置了 Docker sandbox，每个对比运行自动获得独立容器（因为 sessionKey 不同）。

### 4.5 配置

```yaml
# openclaw.yaml 中的 clawlens plugin 配置
plugins:
  installs:
    - source: path
      spec: ./plugins/clawlens

# 或者在 pluginConfig 中
clawlens:
  # 模块 A: 全局监控（默认开启）
  collector:
    enabled: true
    snapshotIntervalMs: 60000

  # 模块 B: 并发对比
  compare:
    enabled: false   # 手动开启
    models:
      - provider: anthropic
        model: claude-sonnet-4-20250514
      - provider: openai
        model: gpt-4o
      - provider: google
        model: gemini-2.5-flash
    channels: ["telegram"]   # 只在指定 channel 生效
    workspaceMode: "copy"    # copy | sandbox | shared
    maxConcurrent: 3         # 最多同时几个对比运行
```

---

## 5. 数据存储层

### 5.1 选型：SQLite

- Plugin service 提供 `stateDir` 持久化目录
- SQLite 文件存储在 `{stateDir}/clawlens/clawlens.db`
- 单文件，无需额外进程
- 支持并发读 + 串行写（WAL mode）
- 查询灵活，支持聚合分析

### 5.2 数据生命周期

```
实时采集 → SQLite 写入 → 查询/聚合 → API 返回 → UI 展示
                │
                └─ 定期清理：保留最近 N 天的数据（可配置）
```

---

## 6. API 层

### 6.1 HTTP API（通过 registerHttpRoute）

```
Plugin HTTP 路由（前缀: /plugins/clawlens）

GET  /plugins/clawlens/api/overview
  → 全局汇总：活跃 session 数、总 token、总 cost、平均效率

GET  /plugins/clawlens/api/sessions?channel=&model=&since=&limit=
  → session 列表 + 汇总指标

GET  /plugins/clawlens/api/session/:sessionKey
  → 单个 session 的所有 run 详情

GET  /plugins/clawlens/api/run/:runId
  → 单个 run 的 LLM 调用 + tool 执行时间线

GET  /plugins/clawlens/api/run/:runId/waterfall
  → 瀑布图数据（时间线格式）

GET  /plugins/clawlens/api/compare/:groupId
  → 对比组的全部模型结果

GET  /plugins/clawlens/api/compare/list?since=&limit=
  → 对比组列表

GET  /plugins/clawlens/api/stats/channels
  → 按 channel 分组的效率统计

GET  /plugins/clawlens/api/stats/models
  → 按 model 分组的效率统计

POST /plugins/clawlens/api/compare/trigger
  → 手动触发一次对比运行

POST /plugins/clawlens/api/config
  → 更新 clawlens 配置（开关对比、修改模型列表）

# 静态资源
GET  /plugins/clawlens/ui/*
  → 注入脚本、CSS、图标等
```

### 6.2 实时推送（SSE）

> **设计变更说明**：原方案使用 `registerGatewayMethod` + `context.broadcast()` 做 WebSocket 推送。
> 经验证，`broadcast` 只在 gateway method handler 的请求上下文中可用，Collector 的
> `onAgentEvent` 回调中无法主动调用。改为 SSE（Server-Sent Events），Plugin HTTP route
> handler 接收标准 `IncomingMessage` + `ServerResponse`，完全支持 SSE 长连接。
>
> **Auth 注意**：SSE 使用 `EventSource` API，不支持自定义 headers（无法传 `Authorization: Bearer`）。
> 解决方案：SSE endpoint 注册为 `auth: "plugin"`（跳过 gateway auth），handler 内部从 URL
> query 参数验证 token。inject.js 从 `sessionStorage` 读取 gateway token 拼接到 URL。

```typescript
// api.ts 中注册 SSE endpoint

api.registerHttpRoute({
  path: "/plugins/clawlens/api/events",
  match: "exact",
  auth: "plugin",   // 跳过 gateway auth，自行验证
  handler: async (req, res) => {
    if (req.method !== "GET") return false;

    // 从 URL query 参数验证 token
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    if (!verifyGatewayToken(token, api.config)) {
      res.writeHead(401);
      res.end("Unauthorized");
      return true;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const clientId = crypto.randomUUID();
    sseManager.addClient(clientId, res);

    req.on("close", () => {
      sseManager.removeClient(clientId);
    });

    return true;
  },
});
```

```typescript
// sse-manager.ts

class SSEManager {
  private clients = new Map<string, ServerResponse>();

  addClient(id: string, res: ServerResponse) {
    this.clients.set(id, res);
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  }

  removeClient(id: string) {
    this.clients.delete(id);
  }

  broadcast(payload: ClawLensEvent) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const [id, res] of this.clients) {
      try {
        res.write(data);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  closeAll() {
    for (const [id, res] of this.clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}
```

前端注入脚本：
```javascript
// sse-client.js
// 从 sessionStorage 读取 gateway token（Control UI 存储在 openclaw.control.token.v1:* 中）
function getGatewayToken() {
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith("openclaw.control.token.v1")) {
      return sessionStorage.getItem(key) ?? "";
    }
  }
  return "";
}

const token = getGatewayToken();
const events = new EventSource(`/plugins/clawlens/api/events?token=${encodeURIComponent(token)}`);
events.onmessage = (e) => {
  const payload = JSON.parse(e.data);
  dispatchToPanel(payload);
};
events.onerror = () => {
  // EventSource 自动重连
};
```

**SSE 方案的优势**：
- Plugin 完全自控，不依赖 gateway 内部 broadcast 机制
- 标准 HTTP，CSP `connect-src 'self'` 已允许
- 天然支持断线重连（EventSource 自动重试）
- 单向推送语义正好匹配监控场景
- `auth: "plugin"` + query token 解决了 EventSource 不支持自定义 headers 的问题

---

## 7. UI 注入层

### 7.1 注入方式

Plugin 安装时修改 `dist/control-ui/index.html`，在 `</body>` 前追加：

```html
<script type="module" src="/plugins/clawlens/ui/inject.js"></script>
<link rel="stylesheet" href="/plugins/clawlens/ui/styles.css">
```

由于 CSP `script-src 'self'`，同源的 plugin HTTP 路由 serve 的脚本完全合法。

### 7.2 注入脚本架构

```
inject.js (入口)
├── boot.js          — 等待 openclaw-app 加载完成，初始化数据连接
├── data-client.js   — HTTP API 客户端 + SSE 事件监听 (EventSource)
├── sse-client.js    — SSE 连接管理 + 断线重连
├── panels/
│   ├── overview-panel.js    — Overview 页的监控卡片
│   ├── session-badge.js     — Session 列表的 token/效率 badge
│   ├── waterfall.js         — Session 详情的瀑布图
│   ├── compare-panel.js     — 对比结果面板
│   └── nav-indicator.js     — 导航栏的监控状态灯
└── styles.css               — 所有注入样式
```

### 7.3 DOM 注入目标

所有组件在 Light DOM 中，注入脚本用 MutationObserver 监听路由变化，按需注入：

| 页面 | 触发条件 | 注入位置 | 注入内容 |
|------|---------|---------|---------|
| Overview | `tab === "overview"` | `.overview-cards` 之后 | 全局监控面板：活跃 run 数、token 速率、channel 效率对比 |
| Sessions | `tab === "sessions"` | 每个 session 行内 | Token badge、cost badge、效率评分 |
| Chat（session 详情） | URL 含 sessionKey | `.chat-view` 侧边 | 瀑布图：LLM 调用 + tool 执行时间线 |
| 新 Tab | 导航栏 | 导航列表末尾 | "ClawLens" tab 入口 |
| ClawLens Tab | 自定义 | 主内容区 | 完整监控 dashboard：channel 对比、model 对比、对比组历史 |

### 7.4 实时数据流

```
Collector (onAgentEvent 回调)
    │
    ▼
SSEManager.broadcast(payload)
    │
    ▼
GET /plugins/clawlens/api/events (SSE 长连接)
    │
    ▼
inject.js → EventSource.onmessage
    │
    ▼
data-client.js 分发给各 panel
    │
    ├─ overview-panel: 更新实时数量
    ├─ session-badge: 更新对应 session 的指标
    ├─ waterfall: 追加新的时间线条目
    └─ compare-panel: 更新对比进度
```

---

## 8. Plugin 入口文件

> **Import 路径说明**：OpenClaw 的 plugin-sdk 通过 package.json `exports` map 暴露子模块。
> 主入口 `openclaw/plugin-sdk` 主要导出类型。运行时帮助函数在具体子路径下，如
> `openclaw/plugin-sdk/plugin-entry`。
>
> **⚠️ 两套 Hook API**（最关键的发现）：
> - `api.registerHook(events, handler)` → **InternalHook 系统**，handler 签名 `(event) => void`，只有一个参数
> - `api.on(hookName, handler)` → **TypedHook 系统**，handler 签名 `(event, ctx) => void`，有完整的类型推导
>
> 我们需要的 `"llm_output"`, `"llm_input"`, `"after_tool_call"`, `"before_agent_start"` 等
> 都是 typed hooks，必须用 **`api.on()`** 注册。用 `api.registerHook()` 走的是老式 internal hook
> 系统，handler 参数结构完全不同。
>
> `api.on()` 的优势：TypeScript 会根据 hookName 自动推导 event 和 ctx 的类型，不需要手动定义接口。

```typescript
// src/index.ts — Plugin 注册入口
// 参考现有 extensions 的写法（如 memory-lancedb、diagnostics-otel）

import path from "node:path";
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { Collector } from "./src/collector.js";
import { Comparator } from "./src/comparator.js";
import { Store } from "./src/store.js";
import { SSEManager } from "./src/sse-manager.js";
import { registerApiRoutes } from "./src/api-routes.js";
import { serveStaticFiles } from "./src/static-server.js";
import type { ClawLensConfig } from "./src/types.js";

const defaultConfig: ClawLensConfig = {
  collector: { enabled: true, snapshotIntervalMs: 60_000 },
  compare: { enabled: false, models: [], channels: [] },
};

export default definePluginEntry({
  id: "clawlens",
  name: "ClawLens",
  description: "全局 session 监控 + 并发多模型对比",

  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig as ClawLensConfig) ?? defaultConfig;
    const stateDir = api.runtime.state.resolveStateDir();
    const store = new Store(stateDir);
    const sseManager = new SSEManager();
    const collector = new Collector(store, sseManager);
    const comparator = new Comparator(store, sseManager, api.runtime);

    // ── 模块 A: 全局监控 ──
    if (config.collector?.enabled !== false) {
      // run 级别生命周期
      api.runtime.events.onAgentEvent((evt) => {
        collector.handleAgentEvent(evt);
      });

      // ★ per-call usage 来自 onSessionTranscriptUpdate（在 collector.start() 中注册）
      // 不在这里注册，因为需要在 service start 后才能 subscribe

      // per-run 累计 usage（用于 Overview 面板汇总）
      api.on("llm_output", (event, ctx) => {
        collector.recordLlmOutput(event, ctx);
      });

      // system prompt hash + user prompt（用于差异分析）
      api.on("llm_input", (event, ctx) => {
        collector.recordLlmInput(event, ctx);
      });

      // tool 执行详情
      api.on("after_tool_call", (event, ctx) => {
        collector.recordToolCall(event, ctx);
      });

      // 对话轮次（agent 运行结束时采集完整消息链）
      api.on("agent_end", (event, ctx) => {
        collector.recordAgentEnd(event, ctx);
      });
    }

    // ── 模块 B: 并发对比 ──
    if (config.compare?.enabled) {
      api.on("before_agent_start", (event, ctx) => {
        // ctx.channelId 包含 channel 信息
        return comparator.maybeForCompare(event, ctx, config.compare!);
      });
    }

    // ── HTTP API + SSE + 静态资源 ──
    registerApiRoutes(api, store, sseManager);

    api.registerHttpRoute({
      path: "/plugins/clawlens/ui",
      match: "prefix",
      auth: "gateway",
      handler: serveStaticFiles(path.join(api.rootDir!, "ui/dist")),
    });

    // ── 后台服务 ──
    api.registerService({
      id: "clawlens-service",
      start: async () => {
        collector.start(api.runtime);
        api.logger.info("ClawLens plugin started");
      },
      stop: async () => {
        collector.stop();
        sseManager.closeAll();
        store.close();
      },
    });
  },
});
```

---

## 9. 文件结构

```
extensions/clawlens/
├── package.json                # type: module, openclaw.extensions: ["./index.ts"]
├── openclaw.plugin.json        # { "id": "clawlens" }
├── index.ts                    # Plugin 入口（definePluginEntry）
├── api.ts                      # re-export: openclaw/plugin-sdk 类型
├── src/
│   ├── collector.ts            # 模块 A: 全局事件采集
│   ├── comparator.ts           # 模块 B: 并发对比引擎
│   ├── store.ts                # SQLite 存储层（node:sqlite）
│   ├── sse-manager.ts          # SSE 连接管理 + 事件推送
│   ├── api-routes.ts           # HTTP API 路由注册
│   ├── static-server.ts        # 静态文件服务
│   ├── cost-calculator.ts      # 按 config cost 配置计算费用
│   └── types.ts                # 共享类型定义
└── ui/
    ├── inject.js               # 注入到 Control UI 的脚本（纯 JS）
    └── styles.css              # 注入样式
```

> **注意**：不需要 `tsconfig.json`（共享根目录的）。入口文件 `index.ts` 在根目录
> （和现有 extensions 如 memory-lancedb、diagnostics-otel 一致）。
> UI 文件为纯 JS/CSS，不需要构建步骤。Extensions 以 `.ts` 源文件直接加载。

---

## 10. 安装与部署

```bash
# 1. 安装 plugin
cd /path/to/openclaw
openclaw plugin install ./clawlens

# 2. 构建 UI 注入文件
cd clawlens && pnpm build

# 3. 修改 Control UI index.html（install.sh 自动完成）
# 在 dist/control-ui/index.html 的 </body> 前追加:
#   <script type="module" src="/plugins/clawlens/ui/inject.js"></script>
#   <link rel="stylesheet" href="/plugins/clawlens/ui/styles.css">

# 4. 配置（可选）
# 在 openclaw.yaml 中添加 clawlens 配置

# 5. 重启 gateway
openclaw gateway restart
```

---

## 11. 风险和约束

| 风险 | 影响 | 缓解方案 |
|------|------|---------|
| Control UI 版本更新后 DOM 结构变化 | 注入脚本可能找不到目标元素 | 使用 MutationObserver + 防御性选择器，失败时 graceful degrade |
| `runEmbeddedPiAgent` 的对比运行消耗额外 token | 成本翻 N 倍 | 模块 B 默认关闭，需手动启用，可设置预算上限 |
| SQLite 写入在高并发下可能瓶颈 | 数据延迟 | WAL mode + 批量写入（每 100ms flush 一次） |
| Lane 锁的 main lane 限制并发 | 对比运行排队 | 使用 `lane: "compare"` 参数进入独立 lane |
| index.html 修改在 OpenClaw 升级时被覆盖 | UI 注入失效 | install.sh 中检测并重新注入；或做成 post-install hook |
| onAgentEvent 是同步回调 | collector 处理慢会影响主流程 | collector 内部异步处理：事件入队列，后台消费写入 |
| SSE 连接数过多 | 内存占用 | 限制最大 SSE 客户端数（如 10），超出拒绝新连接 |
| SSE 在某些反向代理后断连 | 实时推送中断 | EventSource 自动重连 + 前端 fallback 到定期轮询 |
| 对比运行的 workspace 磁盘占用 | 空间膨胀 | 完成后定期清理，保留最近 N 组对比数据 |

---

## 12. 实施路径

### Phase 1：最小可行版本（模块 A 基础功能）
1. Plugin 骨架：register + api.on() hooks + registerService
2. Collector：onAgentEvent 监听 + SQLite 写入
3. HTTP API：/api/overview + /api/sessions + /api/run/:id
4. UI 注入：Overview 页面的监控面板（只读数据）

### Phase 2：审计视图（Audit View）
5. 扩展 Store schema：conversation_turns 表 + messages 表
6. 扩展 Collector：agent_end hook 采集完整对话消息链
7. 审计 API：按 session → run → turn 三层结构返回数据
8. inject.js 注入审计面板到 Chat 视图和 Sessions 列表
9. 瀑布图组件：时间线渲染

### Phase 3：模块 B（并发对比）
10. Comparator：before_agent_start hook + runEmbeddedPiAgent
11. 对比结果存储 + API
12. Compare panel UI

### Phase 4：完善
13. ClawLens 独立 Tab（完整 dashboard）
14. 导出功能（JSON/CSV）
15. 数据清理策略
16. 配置热更新

---

## 13. 审计视图（Audit View）设计

### 13.1 需求

当前 Overview 面板只有 4 个聚合数字，和具体对话没有关联。需要一个审计视图，能把
每次对话（用户发一条消息 → agent 执行 → 返回结果）拆解为完整的执行链路：

```
用户消息 "帮我搜索今天的新闻并写个摘要"
  │
  ├─ LLM 调用 #1: Claude Sonnet → 决定调用 web_search
  │   ├─ tokens: 1,200 in / 150 out
  │   ├─ cost: $0.0042
  │   └─ 耗时: 1.2s
  │
  ├─ Tool: web_search("今天的新闻")
  │   ├─ 耗时: 3.5s
  │   └─ 结果: 5 个搜索结果
  │
  ├─ LLM 调用 #2: Claude Sonnet → 生成摘要
  │   ├─ tokens: 2,800 in / 600 out
  │   ├─ cost: $0.0108
  │   └─ 耗时: 2.1s
  │
  └─ 总计: 2 次 LLM / 1 次 Tool / 6.8s / $0.0150
```

### 13.2 数据源

所有数据已经由现有 hooks 采集，只需要增加两个维度：

**新增 hook：`agent_end`** — 提供每个 run 完成时的完整消息链：

```typescript
api.on("agent_end", (event, ctx) => {
  // event.messages: unknown[]  — 完整对话消息历史
  // event.success: boolean
  // event.error?: string
  // event.durationMs?: number
  // ctx.sessionKey, ctx.agentId, ctx.runId (来自 PluginHookAgentContext)
});
```

**已有 hook 数据的关联**：

| hook | 提供什么 | 关联键 |
|------|---------|--------|
| `onAgentEvent` lifecycle | run start/end 时间 | `runId` |
| `llm_input` | 发给模型的完整 prompt + system prompt + history | `runId` |
| `llm_output` | 模型回复 + token usage | `runId` |
| `after_tool_call` | tool 名称、参数、结果、耗时 | `runId` + `toolCallId` |
| `agent_end` | 完整消息链 + 成功/失败 | `runId`（通过 ctx） |

**关联链路**：`sessionKey` → 多个 `runId`（每条用户消息触发一个 run）→ 每个 run 内有多个 `llm_call` 和 `tool_execution`，按时间排序形成瀑布图。

### 13.3 扩展 Store Schema

在现有表基础上增加：

```sql
-- 每个 run 完成后保存的对话消息（从 agent_end hook 的 event.messages 提取）
CREATE TABLE IF NOT EXISTS conversation_turns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  session_key     TEXT NOT NULL,
  turn_index      INTEGER NOT NULL,   -- 在这个 run 中的顺序
  role            TEXT NOT NULL,       -- user | assistant | tool | tool_result | system
  content_preview TEXT,                -- 前 500 字符预览
  content_length  INTEGER,            -- 完整内容长度
  timestamp       INTEGER,
  -- assistant 消息的额外字段
  tool_calls_count INTEGER DEFAULT 0,  -- 这条 assistant 消息包含几个 tool call
  tokens_used     INTEGER              -- 这条消息消耗的 token（如果可追踪）
);

CREATE INDEX IF NOT EXISTS idx_conv_turns_run ON conversation_turns(run_id);
CREATE INDEX IF NOT EXISTS idx_conv_turns_session ON conversation_turns(session_key);
```

同时在 `llm_calls` 表增加一个字段用于关联用户消息：

```sql
ALTER TABLE llm_calls ADD COLUMN user_prompt_preview TEXT;  -- 这次 LLM 调用时的用户 prompt 前 200 字符
```

### 13.4 扩展 API

新增以下 HTTP 端点：

```
GET /plugins/clawlens/api/audit/session/:sessionKey
  → 返回该 session 的审计摘要：
    {
      sessionKey: "...",
      channel: "telegram",
      model: "claude-sonnet-4",
      runs: [
        {
          runId: "...",
          startedAt: 1711234567890,
          duration: 6800,
          status: "completed",
          userPrompt: "帮我搜索今天的新闻并写个摘要",  // 来自 llm_input.prompt
          summary: {
            llmCalls: 2,
            toolCalls: 1,
            totalInputTokens: 4000,
            totalOutputTokens: 750,
            totalCost: 0.015,
          },
          // 瀑布图数据：按时间排序的执行步骤
          timeline: [
            { type: "llm_call", index: 0, startedAt, duration, tokens: {in, out}, cost },
            { type: "tool", name: "web_search", startedAt, duration, isError: false },
            { type: "llm_call", index: 1, startedAt, duration, tokens: {in, out}, cost },
          ],
          // 对话轮次
          turns: [
            { role: "user", preview: "帮我搜索...", length: 28 },
            { role: "assistant", preview: "我来帮你搜索...", length: 450, toolCallsCount: 1 },
            { role: "tool_result", preview: "搜索结果: ...", length: 1200 },
            { role: "assistant", preview: "以下是今天的新闻摘要...", length: 800 },
          ]
        },
        // ... 更多 runs
      ]
    }

GET /plugins/clawlens/api/audit/run/:runId
  → 单个 run 的完整审计详情（含所有 llm_calls、tool_executions、conversation_turns）
```

### 13.5 UI 注入方案

三个注入点：

#### A. Chat 视图侧边栏（最核心）

在 Chat 页面的聊天消息旁边注入一个可折叠的审计面板。每条用户消息旁边显示一个小图标，
点击后展开该轮对话的完整执行链路。

```
┌─────────────────────────────────────────────────────────┐
│  Chat                                          [审计] ↔ │
├────────────────────────────────┬────────────────────────┤
│                                │ 审计面板               │
│  👤 帮我搜索今天的新闻         │ ┌────────────────────┐ │
│                                │ │ Run #abc123        │ │
│  🤖 我来帮你搜索...           │ │ Duration: 6.8s     │ │
│     ⚙️ web_search("新闻")     │ │ Cost: $0.015       │ │
│     📎 5 results               │ │                    │ │
│                                │ │ ▼ Timeline         │ │
│  🤖 以下是今天的新闻摘要：    │ │ ├ LLM #1  1.2s     │ │
│     1. ...                     │ │ ├ Tool    3.5s     │ │
│     2. ...                     │ │ └ LLM #2  2.1s     │ │
│                                │ │                    │ │
│  👤 能更详细一点吗？           │ │ Tokens: 4K/750     │ │
│                                │ └────────────────────┘ │
│  🤖 当然，让我展开...          │ ┌────────────────────┐ │
│                                │ │ Run #def456        │ │
│                                │ │ ...                │ │
│                                │ └────────────────────┘ │
└────────────────────────────────┴────────────────────────┘
```

实现方式：
- MutationObserver 监听 chat 视图的消息渲染
- 从 URL 或 DOM 中提取当前 `sessionKey`
- fetch `/plugins/clawlens/api/audit/session/{sessionKey}` 获取该 session 的全部 run 数据
- 在聊天区域右侧注入审计面板（可折叠）
- 每条用户消息通过时间戳或 runId 和 runs 列表对应

#### B. Sessions 列表增强

每个 session 行追加可展开的审计摘要：

```
┌────────────────────────────────────────────────────────────────┐
│ Sessions                                                       │
├────────────────────────────────────────────────────────────────┤
│ ▶ telegram:user123  │ claude-sonnet │ 12 runs │ 45K tokens │ $0.18 │
│ ▼ discord:channel1  │ gpt-4o        │ 8 runs  │ 32K tokens │ $0.24 │
│   ├─ Run #1: "天气查询"        2 LLM / 1 tool / 1.2s / $0.003  │
│   ├─ Run #2: "写一首诗"        1 LLM / 0 tool / 0.8s / $0.002  │
│   ├─ Run #3: "搜索新闻并摘要"  4 LLM / 2 tool / 8.5s / $0.032  │
│   └─ ... (展开更多)                                             │
│ ▶ whatsapp:group5   │ claude-sonnet │ 3 runs  │ 8K tokens  │ $0.03 │
└────────────────────────────────────────────────────────────────┘
```

#### C. 独立 Audit Tab（Phase 4）

在导航栏注入 "Audit" 入口，完整 dashboard 包含：
- 按时间范围筛选
- 按 channel / model / agent 分组
- 成本趋势图
- 效率异常检测（tool call 次数异常多、token 消耗异常高的 run 标红）
- 导出 CSV

### 13.6 Collector 扩展

在现有 Collector 基础上增加：

```typescript
// 新增 agent_end hook 注册（在 index.ts 的 register 中）
api.on("agent_end", (event, ctx) => {
  collector.recordAgentEnd(event, ctx);
});
```

```typescript
// collector.ts 新增方法
recordAgentEnd(event: { messages: unknown[]; success: boolean; durationMs?: number }, ctx: AgentContext) {
  this.queue.push(() => {
    const runId = ctx.runId;  // PluginHookAgentContext 中通过 sessionId 关联
    if (!runId) return;

    // 从 messages 中提取对话轮次
    const messages = event.messages as Array<{ role: string; content?: string | unknown[] }>;
    let turnIndex = 0;
    for (const msg of messages) {
      const role = msg.role ?? "unknown";
      const content = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content ?? "");
      this.store.insertConversationTurn({
        runId,
        sessionKey: ctx.sessionKey!,
        turnIndex: turnIndex++,
        role,
        contentPreview: content.slice(0, 500),
        contentLength: content.length,
        timestamp: Date.now(),
      });
    }
  });
}
```

同时在 `handleTranscriptUpdate` 中记录 user prompt preview（来自 `llm_input` hook 的 `event.prompt`）：

```typescript
recordLlmInput(event: LlmInputEvent, ctx: AgentContext) {
  this.queue.push(() => {
    const run = this.activeRuns.get(event.runId);
    if (!run) return;
    // 保存 prompt 到 activeRun state，后续 llm_output 时写入 llm_calls 表
    run.lastUserPrompt = event.prompt?.slice(0, 200);
    run.systemPromptHash = hashString(event.systemPrompt ?? "");
  });
}
```

### 13.7 PluginHookAgentContext 中 runId 的获取

`PluginHookAgentContext` 没有直接的 `runId` 字段，但有 `sessionId`。
`agent_end` 触发时，Collector 的 `activeRuns` Map 中应该还存在对应的 run（因为 lifecycle `end` 事件
尚未到达或刚刚到达）。关联方式：

1. `llm_input` / `llm_output` / `after_tool_call` 的 event 中有 `runId`
2. `agent_end` 的 context 中有 `sessionKey` + `sessionId`
3. 在 Collector 中维护 `sessionIdToRunId: Map<string, string>` 映射，在 lifecycle start 时建立

### 13.8 瀑布图数据格式

API 返回的 timeline 数组，前端用来渲染水平时间线：

```typescript
type TimelineEntry = {
  type: "llm_call" | "tool_execution";
  name?: string;           // tool name 或 "LLM #1"
  startedAt: number;       // 相对于 run start 的偏移(ms)
  duration: number;        // 耗时(ms)
  // LLM specific
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  provider?: string;
  model?: string;
  // Tool specific
  toolName?: string;
  isError?: boolean;
};
```

渲染为甘特图样式：

```
|--LLM #1--|     |--web_search--|     |--LLM #2--|
0s         1.2s  1.2s           4.7s  4.7s       6.8s
```

