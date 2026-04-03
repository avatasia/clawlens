# ClawLens Plugin — 架构设计文档 v2.0

> 基于 OpenClaw v2026.3.23 / pi-agent-core 0.61.1 源码分析
> 版本：v2.0 | 日期：2026-03-27
> 本文档整合了 v1.0 架构文档与代码评审意见，纠正了多处与实际实现的偏差

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

## 2. 审计数据模型（v2 修正版）

ClawLens 的数据分为三个层次，在 UI 中用不同标签区分。

### 层次 1：官方口径（Official）

> **注意**：`officialCost` 字段暂未实现，当前版本始终为 `undefined`。
> 这是已知的技术限制，后续版本将补充完整。

从 `api.on("llm_output")` hook 的 `event.usage` 字段中提取。

| 字段 | 来源 | 说明 |
|------|------|------|
| input tokens | `event.usage.input` | 经标准化处理 |
| output tokens | `event.usage.output` | 同上 |
| cache read/write | `event.usage.cacheRead/cacheWrite` | 同上 |
| total tokens | `event.usage.total` 或 in+out+cache 求和 | 同上 |
| cost total | **暂未实现** — pi-ai 内置定价计算的 cost | 待 hook 事件补充 |

### 层次 2：ClawLens 计算（Calculated）

用自定义 `cost-calculator.ts` 对 token 数据独立计算 cost。

| 字段 | 来源 | 说明 |
|------|------|------|
| calculated_cost | `calculateCost(usage, costConfig)` | 从 `config.models.providers` 读取配置 |

> **成本计算说明**：当前实现只有一层 fallback（从 `config.models.providers` 读取）。
> 文档 v1.0 描述的三层 fallback（models.json → config → gateway cache）暂未完整实现。
> 当用户未配置自定义定价时，`calculated_cost` 为 `null`。

**和层次 1 的 cost 对比**（待 `officialCost` 实现后）：
- 一致 → UI 显示绿色勾 ✓
- 不一致 → UI 显示黄色差异提示

### 层次 3：ClawLens 独有（Exclusive）

官方 Usage 视图**完全没有**的数据。

| 数据 | 来源 | 粒度 |
|------|------|------|
| Per-run 瀑布图 | `llm_output` + `after_tool_call` 事件交叉排序 | per-LLM-call / per-tool-call |
| System prompt hash | `llm_input` hook 的 `event.systemPrompt` | per-LLM-call |
| Tool 执行详情 | `after_tool_call` hook 的 params/result/error | per-tool-call |
| 对话轮次链路 | `agent_end` hook 的 `event.messages` | per-run |

### UI 标注规则

审计侧栏中，每个数据点用右上角小标签标注来源：

```
Token 使用                      Cost
┌──────────────────────┐  ┌──────────────────────────────┐
│ 4,800 tokens  OFFICIAL│  │ $0.0150  OFFICIAL (待实现)  │
│                       │  │ $0.0148  CALCULATED  ≈ ✓   │
│ in: 4,000 / out: 750 │  │                              │
│ cache: 50r / 0w       │  │ 差异 $0.0002 — 自定义定价   │
└──────────────────────┘  └──────────────────────────────┘

Timeline                        EXCLUSIVE
┌──────────────────────────────────────────┐
│ ■■■LLM 1.2s■■■  ■■tool 3.5s■■  ■■LLM■■ │
└──────────────────────────────────────────┘
```

- **OFFICIAL** — 灰色标签（待功能实现后显示）
- **CALCULATED** — 蓝色标签，ClawLens 独立计算的数据
- **EXCLUSIVE** — 青色（teal）标签，官方没有的独有数据
- **≈ ✓** — 绿色，两个 cost 值差异在 0.1% 以内
- **⚠ DIFF** — 黄色，成本差异超过 0.1%

---

## 3. 整体架构

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
│  │(全局事件总线) │ │dPiAgent  │        │    │registerService  │   │
│  │              │ │(发起运行) │        │    └─────────────────┘   │
│  └──────────────┘ └──────────┘        │                           │
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

## 4. 模块 A：全局 Session 监控

### 4.1 数据采集（v2 修正版）

使用两个系统采集数据：

#### 系统 1：`runtime.events.onAgentEvent` — 全局事件总线

```
onAgentEvent(evt => {
  evt.runId      — 运行标识
  evt.sessionKey — session 标识
  evt.stream     — "lifecycle" | "tool" | "assistant" | "error"
  evt.data       — 事件详情（phase, startedAt, endedAt, error 等）
  evt.ts         — 时间戳
})
```

**采集的事件**：

| 事件 | stream | data 关键字段 | 记录为 |
|------|--------|-------------|--------|
| 运行开始 | lifecycle | `phase: "start"` | runs 表插入 |
| 运行结束 | lifecycle | `phase: "end"`, endedAt | runs 表更新，延迟 800ms |
| 运行错误 | lifecycle | `phase: "error"`, error | runs 表更新，状态设为 error |

#### 系统 2：`api.on(...)` — Typed Hook 系统

> **重要**：`api.on()` 和 `api.registerHook()` 是两套完全不同的 Hook 系统。
> `api.on()` 是 Typed Hook 系统，提供完整的类型推导。
> `api.registerHook()` 是 Legacy Internal Hook 系统，参数结构完全不同。
> 必须使用 `api.on()` 注册 `llm_output`, `llm_input`, `after_tool_call`, `agent_end` 等。

**已注册的 Hooks**：

| Hook | 触发时机 | 关键数据 |
|------|---------|---------|
| `llm_output` | **每次 LLM 调用结束时** | `usage.input/output/cacheRead/cacheWrite`, `provider`, `model`, `stopReason` |
| `llm_input` | 每次 LLM 调用前 | `systemPrompt`, `prompt`（用于 hash 和 preview） |
| `after_tool_call` | 每次 tool 执行后 | `toolName`, `params`, `result`, `error`, `durationMs` |
| `agent_end` | agent 运行结束时 | `messages[]`, `success`, `durationMs` |

> **数据源说明**：`llm_output` hook 在**每次 LLM 调用结束**时触发，而非整个 run 结束时触发。
> 因此可以直接用于 per-call 粒度的瀑布图数据。
>
> `onSessionTranscriptUpdate` 当前**未使用**。文档 v1.0 中的相关描述已过时。

### 4.2 数据模型

```sql
-- 每次 agent 运行（一次用户指令触发一次运行）
CREATE TABLE runs (
  run_id              TEXT PRIMARY KEY,
  session_key         TEXT NOT NULL,
  channel             TEXT,
  agent_id            TEXT,
  provider            TEXT,
  model               TEXT,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  duration_ms         INTEGER,
  status              TEXT DEFAULT 'running',  -- running | completed | error
  error_message       TEXT,
  -- 汇总字段（从 llm_calls 聚合）
  total_llm_calls     INTEGER DEFAULT 0,
  total_input_tokens  INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cache_read    INTEGER DEFAULT 0,
  total_cache_write   INTEGER DEFAULT 0,
  total_cost_usd      REAL DEFAULT 0,           -- legacy，≈ calculated_cost
  total_official_cost REAL,                      -- 层次 1（暂未实现）
  total_calculated_cost REAL,                    -- 层次 2
  total_tool_calls    INTEGER DEFAULT 0,
  -- 对比相关
  compare_group_id    TEXT,      -- 模块 B: 同一组对比的标识
  is_primary          INTEGER    -- 模块 B: 是否是返回给用户的主模型
);

-- 每次 LLM API 调用（一次运行中可能有多次调用，因为 tool call 循环）
CREATE TABLE llm_calls (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT NOT NULL REFERENCES runs(run_id),
  call_index          INTEGER NOT NULL,  -- 第几次调用 (0, 1, 2...)
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  duration_ms         INTEGER,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read          INTEGER,
  cache_write         INTEGER,
  cost_usd            REAL,              -- legacy，≈ calculated_cost
  official_cost       REAL,              -- 层次 1：pi-ai 内置定价（暂未实现）
  calculated_cost     REAL,              -- 层次 2：自定义配置计算
  stop_reason         TEXT,
  provider            TEXT,
  model               TEXT,
  system_prompt_hash  TEXT,               -- system prompt 的 hash（用于检测 channel 差异）
  tool_calls_in_response INTEGER DEFAULT 0,
  user_prompt_preview TEXT                -- 用户 prompt 前 200 字符
);

-- 每次工具执行
CREATE TABLE tool_executions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES runs(run_id),
  tool_call_id    TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_ms     INTEGER,
  is_error        INTEGER DEFAULT 0,
  args_summary    TEXT,     -- 参数摘要（truncated to 200）
  result_summary  TEXT      -- 结果摘要（truncated to 200）
);

-- 每个 run 完成后保存的对话消息（从 agent_end hook 的 event.messages 提取）
CREATE TABLE conversation_turns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  session_key     TEXT NOT NULL,
  turn_index      INTEGER NOT NULL,
  role            TEXT NOT NULL,       -- user | assistant | tool | tool_result | system
  content_preview TEXT,                -- 前 500 字符预览
  content_length  INTEGER,
  timestamp       INTEGER,
  tool_calls_count INTEGER DEFAULT 0,
  tokens_used     INTEGER
);

-- 索引
CREATE INDEX idx_runs_session ON runs(session_key);
CREATE INDEX idx_runs_channel ON runs(channel);
CREATE INDEX idx_runs_compare ON runs(compare_group_id);
CREATE INDEX idx_runs_started ON runs(started_at);
CREATE INDEX idx_llm_calls_run ON llm_calls(run_id);
CREATE INDEX idx_tool_exec_run ON tool_executions(run_id);
CREATE INDEX idx_conv_turns_run ON conversation_turns(run_id);
CREATE INDEX idx_conv_turns_session ON conversation_turns(session_key);
```

### 4.3 Collector 实现要点

```typescript
class Collector {
  // run 结束延迟 800ms 后才 completeRun
  // 原因：让 trailing 的 llm_output / after_tool_call 事件先flush
  private scheduleComplete(runId: string, endedAt: number, status: string) {
    const timer = setTimeout(() => {
      this.store.completeRun(runId, endedAt, status);
    }, 800);
  }

  // llm_output hook — per-call usage（瀑布图核心数据源）
  recordLlmCall(event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) {
    // event.usage 包含 input/output/cacheRead/cacheWrite
    // officialCost 当前为 undefined（待实现）
    // calculatedCost 从 config.models.providers 计算
  }

  // llm_input hook — system prompt hash
  recordLlmInput(event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) {
    // 用 simpleHash(event.systemPrompt) 计算 hash
    // 保存到 activeRun 供后续 llm_call 使用
  }

  // after_tool_call hook — tool 执行详情
  recordToolCall(event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) {
    // event.durationMs, event.params, event.result, event.error
  }

  // agent_end hook — 对话轮次
  recordAgentEnd(event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) {
    // event.messages[] 包含完整对话历史
    // 通过 sessionIdToRunId Map 关联到 runId
  }
}
```

### 4.4 成本计算（v2 修正版）

```typescript
// cost-calculator.ts — 当前实现

export function calculateCost(
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  costConfig: ModelCostConfig | undefined,
): number | null {
  // 无任何 fallback，costConfig 为 undefined 则返回 null
  if (!costConfig) return null;
  return (
    (usage.input ?? 0) * costConfig.input +
    (usage.output ?? 0) * costConfig.output +
    (usage.cacheRead ?? 0) * costConfig.cacheRead +
    (usage.cacheWrite ?? 0) * costConfig.cacheWrite
  );
}
```

> **与 v1 文档的差异**：v1 文档描述使用 `resolveModelCostConfig` + `estimateUsageCost` 三层 fallback，
> 当前实现未使用这些函数，仅从 `config.models.providers` 读取单层配置。

---

## 5. 模块 B：并发多模型对比

### 5.1 触发机制

通过 `api.on("before_agent_start", ...)` 拦截。

```
用户消息 (channel: telegram)
  │
  ▼
before_agent_start hook
  │
  ├─ 检查: compare.enabled && compare.channels.includes(ctx.channelId)
  │
  ├─ 如果不匹配 → return undefined（正常流程）
  │
  └─ 如果匹配:
       ├─ 从 session store 读取当前 model/provider（主模型）
       ├─ 从 compare.models 中过滤掉主模型
       ├─ 生成 compare_group_id
       ├─ 异步启动 N 个对比运行（不阻塞原始流程）
       └─ return undefined（原始模型正常返回给用户）
```

> **注意**：`before_agent_start` 是 Modifying hook，但其返回值用于合并结果，
> 不用于控制是否继续主流程。ClawLens 利用这一点——返回 `undefined`，
> 主模型运行正常继续，同时异步启动对比运行。

### 5.2 对比运行的执行

使用 `runtime.agent.runEmbeddedPiAgent` — OpenClaw 官方 API。

```typescript
await runtime.agent.runEmbeddedPiAgent({
  sessionKey: compareSessionKey,
  sessionFile: "...",
  workspaceDir: "...",
  lane: "compare",        // 独立 lane，与 main lane 隔离
  timeoutMs: 300_000,
  provider,
  model,
  onAgentEvent: (evt) => {
    // 对比运行的事件写入 runs 表
    // 通过 compare_group_id 关联
  },
});
```

### 5.3 Lane 隔离

两层隔离：
1. **Session lane**：每个对比模型用独立 `sessionKey`
2. **Global lane**：传入 `lane: "compare"`，与默认的 `"main"` lane 隔离

### 5.4 Workspace 隔离

每个对比运行使用独立的 workspace 目录：
```
~/.openclaw/clawlens/compare/{groupId}/
├── anthropic_claude-sonnet-4/
├── openai_gpt-4o/
└── results.json
```

### 5.5 配置（v2 修正版）

```yaml
clawlens:
  collector:
    enabled: true
    snapshotIntervalMs: 60000
    retentionDays: 30

  compare:
    enabled: false
    models:
      - provider: anthropic
        model: claude-sonnet-4-20250514
      - provider: openai
        model: gpt-4o
    channels: ["telegram"]
    timeoutMs: 300000
    maxConcurrent: 3
```

> **注意**：`workspaceMode` 字段当前未实现，已从配置中移除。

---

## 6. 数据存储层

### 6.1 SQLite

- Plugin service 提供 `stateDir` 持久化目录
- SQLite 文件：`{stateDir}/clawlens/clawlens.db`
- 使用 WAL mode，支持并发读 + 串行写
- 批量写入：collector 每 100ms flush 一次队列

### 6.2 数据生命周期

```
实时采集 → 内存队列(100ms batch) → SQLite 写入 → API 查询 → UI 展示
                                                    │
                                                    └─ 定期清理：保留最近 N 天数据
```

---

## 7. API 层

### 7.1 HTTP API

```
Plugin HTTP 路由（前缀: /plugins/clawlens）

GET  /plugins/clawlens/api/overview
  → 全局汇总：活跃 run 数、总 token、总 cost

GET  /plugins/clawlens/api/sessions?channel=&model=&provider=&limit=&offset=
  → session 列表 + 汇总指标

GET  /plugins/clawlens/api/run/:runId
  → 单个 run 的 LLM 调用 + tool 执行详情

GET  /plugins/clawlens/api/audit
  → 审计视图汇总（按 session 分组，含 cost 对比）

GET  /plugins/clawlens/api/audit/session/:sessionKey
  → 单个 session 的完整审计数据（含 timeline 和对话轮次）

GET  /plugins/clawlens/api/audit/run/:runId
  → 单个 run 的完整审计详情

GET  /plugins/clawlens/api/events
  → SSE 实时事件推送
```

> **注意**：以下 API 端点**暂未实现**：
> - `/compare/:groupId`
> - `/compare/list`
> - `/compare/trigger`
> - `/config`（配置热更新）
> - `/stats/channels`
> - `/stats/models`

### 7.2 SSE 实时推送

```typescript
// 注册方式
api.registerHttpRoute({
  path: "/plugins/clawlens/api/events",
  match: "exact",
  auth: "plugin",   // 跳过 gateway auth
  handler: async (req, res) => {
    // auth: "plugin" 跳过 gateway auth
    // SSE token 验证通过 URL query 参数
    const token = url.searchParams.get("token");
    // ...
  }
});
```

**SSE 推送的事件类型**：
- `run_started` — 新 run 开始
- `run_ended` — run 结束
- `llm_call` — LLM 调用记录
- `tool_executed` — tool 执行记录
- `compare_completed` — 对比运行完成

### 7.3 Auth 机制

API 使用 Bearer token 认证：
- Header: `Authorization: Bearer <token>`
- SSE: token 通过 URL query 参数传递（因为 EventSource 不支持自定义 headers）

---

## 8. UI 注入层

### 8.1 注入方式

Plugin 启动时自动检测并修改 Control UI 的 `index.html`：
```typescript
// 在 </body> 前追加
<script src="/plugins/clawlens/ui/inject.js"></script>
<link rel="stylesheet" href="/plugins/clawlens/ui/styles.css">
```

### 8.2 注入脚本架构

```
inject.js (入口)
├── boot.js          — 等待 openclaw-app 加载完成，初始化数据连接
├── data-client.js   — HTTP API 客户端 + SSE 事件监听
├── sse-client.js    — SSE 连接管理 + 断线重连
├── panels/
│   ├── overview-panel.js    — Overview 页的监控卡片
│   ├── session-badge.js     — Session 列表的 token/效率 badge
│   ├── waterfall.js         — Session 详情的瀑布图
│   ├── compare-panel.js     — 对比结果面板
│   └── nav-indicator.js     — 导航栏的监控状态灯
└── styles.css               — 所有注入样式
```

### 8.3 DOM 注入目标

| 页面 | 触发条件 | 注入位置 | 注入内容 |
|------|---------|---------|---------|
| Overview | `tab === "overview"` | `.overview-cards` 之后 | 全局监控面板 |
| Sessions | `tab === "sessions"` | 每个 session 行内 | Token badge、cost badge |
| Chat | URL 含 sessionKey | `.chat-view` 侧边 | 瀑布图 |
| 导航栏 | — | 导航列表末尾 | "ClawLens" tab 入口 |

---

## 9. Plugin 入口文件

```typescript
// extensions/clawlens/index.ts

export default definePluginEntry({
  id: "clawlens",
  name: "ClawLens",

  register(api: OpenClawPluginApi) {
    const config = { ...defaultConfig, ...api.pluginConfig };
    const store = new Store(stateDir);
    const sseManager = new SSEManager();
    const collector = new Collector(store, sseManager);
    const comparator = new Comparator(store, sseManager, runtime, stateDir);

    // 模块 A: 全局监控
    api.runtime.events.onAgentEvent((evt) => collector.handleAgentEvent(evt));
    api.on("llm_output", (event, ctx) => collector.recordLlmCall(event, ctx));
    api.on("llm_input", (event, ctx) => collector.recordLlmInput(event, ctx));
    api.on("after_tool_call", (event, ctx) => collector.recordToolCall(event, ctx));
    api.on("agent_end", (event, ctx) => collector.recordAgentEnd(event, ctx));

    // 模块 B: 并发对比
    if (config.compare?.enabled) {
      api.on("before_agent_start", (event, ctx) =>
        comparator.maybeForCompare(event, ctx, config.compare!),
      );
    }

    // HTTP API
    registerApiRoutes(api, store, sseManager);
    registerStaticRoutes(api, uiPath);

    // 后台服务
    api.registerService({
      id: "clawlens-service",
      start: async () => {
        collector.start(runtime, api.config, config);
        patchControlUiIndexHtml(api);
      },
      stop: async () => {
        collector.stop();
        sseManager.closeAll();
        store.cleanup(retentionDays);
        store.close();
      },
    });
  },
});
```

---

## 10. 文件结构

```
extensions/clawlens/
├── index.ts                    # Plugin 入口（definePluginEntry）
├── api.ts                      # re-export: openclaw/plugin-sdk 类型
├── package.json                # type: module
├── openclaw.plugin.json        # { "id": "clawlens" }
├── src/
│   ├── collector.ts            # 模块 A: 全局事件采集
│   ├── comparator.ts           # 模块 B: 并发对比引擎
│   ├── store.ts                # SQLite 存储层
│   ├── sse-manager.ts          # SSE 连接管理 + 事件推送
│   ├── api-routes.ts           # HTTP API 路由 + 静态文件服务
│   ├── cost-calculator.ts      # 成本计算（单层 fallback）
│   └── types.ts                # 共享类型定义
└── ui/
    ├── inject.js               # 注入到 Control UI 的脚本（纯 JS）
    └── styles.css              # 注入样式
```

---

## 11. 实施路径

### Phase 1：基础监控（MVP）
- [x] Plugin 骨架
- [x] Collector：onAgentEvent + llm_output + llm_input + after_tool_call + agent_end
- [x] SQLite 存储
- [x] HTTP API：overview + sessions + run/:id
- [x] SSE 推送
- [x] UI 注入基础

### Phase 2：审计视图
- [x] Audit API：/audit + /audit/session + /audit/run
- [x] 瀑布图 timeline 构建
- [x] Cost 对比展示（待 officialCost 实现）
- [ ] 完整 Audit Tab

### Phase 3：并发对比
- [x] Comparator 基础
- [ ] 对比结果 API（/compare/:groupId 等）
- [ ] Compare panel UI

### Phase 4：完善
- [ ] officialCost 实现（从 message.usage.cost 提取）
- [ ] resolveModelCostConfig 三层 fallback
- [ ] 配置热更新 API
- [ ] 数据导出（JSON/CSV）
- [ ] 数据清理策略

---

## 12. 风险和约束

| 风险 | 影响 | 缓解方案 |
|------|------|---------|
| Control UI 版本更新后 DOM 结构变化 | 注入脚本失效 | MutationObserver + 防御性选择器 |
| `runEmbeddedPiAgent` 消耗额外 token | 成本翻 N 倍 | 模块 B 默认关闭，设置预算上限 |
| SQLite 写入在高并发下可能瓶颈 | 数据延迟 | WAL mode + 批量写入（100ms flush） |
| Lane 锁限制并发 | 对比运行排队 | 使用 `lane: "compare"` 独立 lane |
| onAgentEvent 是同步回调 | collector 处理慢影响主流程 | collector 内部异步：事件入队列，后台消费 |
| SSE 连接数过多 | 内存占用 | 限制最大 SSE 客户端数（当前 10） |
| index.html 修改在升级时被覆盖 | UI 注入失效 | 启动时检测并重新注入 |
