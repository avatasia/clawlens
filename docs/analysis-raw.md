# OpenClaw Gateway 源码分析报告

> 版本: v2026.3.22
> 分析目标: 模型调用架构 + Tool Call 执行机制 + 可 Hook 位置

---

## 1. 模型调用架构：完整调用链

### 1.1 调用链路图

```
用户指令（HTTP/WS/CLI）
│
├─ HTTP: POST /v1/chat/completions
│  └─ handleOpenAiHttpRequest()                    [src/gateway/openai-http.ts:409]
│     └─ agentCommandFromIngress()                 [src/agents/agent-command.ts:1311]
│
├─ WebSocket (Gateway协议)
│  └─ server-chat.ts → agentCommand()              [src/agents/agent-command.ts:1291]
│
└─ CLI
   └─ agentCommand()                               [src/agents/agent-command.ts:1291]
        │
        ▼
   agentCommandInternal()                          [src/agents/agent-command.ts:710]
        │
        ├─ prepareAgentCommandExecution()           [src/agents/agent-command.ts:538]
        │  (解析 config, session, model selection)
        │
        ├─ [ACP 路径] acpManager.runTurn()          [src/agents/agent-command.ts:796]
        │  (Agent Communication Protocol, 独立路径)
        │
        └─ [标准路径] runWithModelFallback()         [src/agents/agent-command.ts:1180]
              │
              └─ runAgentAttempt()                  [src/agents/agent-command.ts:352]
                    │
                    ├─ [CLI Provider] runCliAgent()
                    │
                    └─ [标准] runEmbeddedPiAgent()  [src/agents/pi-embedded-runner/run.ts:268]
                          │
                          ├─ ★ before_model_resolve hook  [run.ts:~340]
                          ├─ ★ before_agent_start hook     [run.ts:~360]
                          ├─ resolveModelAsync()           [pi-embedded-runner/model.ts:418]
                          │
                          └─ [重试循环 while(true)]         [run.ts:886]
                                │
                                └─ runEmbeddedAttempt()    [run/attempt.ts:1662]
                                      │
                                      ├─ createOpenClawCodingTools()   [attempt.ts:~1790]
                                      ├─ createAgentSession()          [attempt.ts:2173]
                                      │  (来自 @mariozechner/pi-coding-agent)
                                      │
                                      ├─ ★ agent.streamFn 赋值         [attempt.ts:2239-2397]
                                      │  (streamSimple / ollama / vertex / openai-ws)
                                      │  多层 wrapper 装饰器链
                                      │
                                      ├─ subscribeEmbeddedPiSession()  [attempt.ts:2563]
                                      │  (订阅 agent 事件流)
                                      │
                                      ├─ ★ llm_input hook              [attempt.ts:~2856]
                                      │
                                      └─ activeSession.prompt()        [attempt.ts:2876]
                                         (触发 pi-agent-core 的 agent loop)
                                              │
                                              ▼
                                         ┌─────────────────────────────┐
                                         │  @mariozechner/pi-agent-core │
                                         │  内部 agent loop:            │
                                         │  1. 组装 messages[]          │
                                         │  2. 调用 streamFn()          │
                                         │     → POST /chat/completions │
                                         │     或 Anthropic Messages API│
                                         │  3. 解析响应                  │
                                         │  4. 若有 tool_calls → 执行   │
                                         │  5. 将结果追加到 messages[]   │
                                         │  6. 回到步骤 1               │
                                         └─────────────────────────────┘
```

### 1.2 请求体组装

请求体的组装发生在两层：

**外层（OpenClaw 控制）：**
- `messages[]` 由 `SessionManager` 管理历史消息 + 当前 prompt
- `tools[]` 由 `createOpenClawCodingTools()` + Bundle MCP tools + Bundle LSP tools 组合
- system prompt 由 `buildEmbeddedSystemPrompt()` 组装
- 经过 `sanitizeSessionHistory()` / `limitHistoryTurns()` 清洗

**内层（pi-agent-core 控制）：**
- `streamFn(model, context, options)` 是实际发送 HTTP 请求的函数
- `context` 包含 `messages`、system prompt 等
- `model` 对象包含 API endpoint, headers, provider 信息

### 1.3 streamFn 装饰器链

`agent.streamFn` 在 `attempt.ts` 中被多层 wrapper 包装（**关键拦截点**）：

```
streamSimple (基础 HTTP 调用, 来自 @mariozechner/pi-ai)
  └─ 可选: createConfiguredOllamaStreamFn (Ollama 原生 API)
  └─ 可选: createOpenAIWebSocketStreamFn (OpenAI Responses WS)
  └─ 可选: createAnthropicVertexStreamFnForModel (Vertex AI)
  └─ wrapOllamaCompatNumCtx (Ollama 兼容层 num_ctx 注入)
  └─ applyExtraParamsToAgent (额外参数注入)
  └─ cacheTrace.wrapStreamFn (缓存追踪)
  └─ dropThinkingBlocks wrapper (清理 thinking 块)
  └─ sanitizeToolCallIds wrapper (工具调用 ID 规范化)
  └─ yield abort wrapper (sessions_yield 中断)
  └─ wrapStreamFnSanitizeMalformedToolCalls (修复畸形工具调用)
  └─ wrapStreamFnTrimToolCallNames (修剪工具名空白)
  └─ wrapStreamFnRepairMalformedToolCallArguments (修复参数)
  └─ wrapStreamFnDecodeXaiToolCallArguments (XAI HTML 解码)
  └─ anthropicPayloadLogger.wrapStreamFn (Anthropic 载荷日志)
```

### 1.4 响应解析

响应解析由 `@mariozechner/pi-agent-core` 内部处理：
- 该库解析 SSE 流或 JSON 响应
- 提取 `tool_calls` / `tool_use` 块
- 通过 `subscribeEmbeddedPiSession()` 的事件系统暴露给 OpenClaw

事件流通过 `AgentEvent` 类型传递，关键事件：
- `tool_execution_start` → 工具开始执行
- `tool_execution_end` → 工具执行完毕
- `assistant` stream → 文本流
- `lifecycle` stream → 生命周期（start/end/error）

### 1.5 Provider 抽象层

**有明确的 Provider 抽象层：**

```
src/agents/pi-embedded-runner/model.ts
  ├─ resolveModelAsync()          → 解析 provider + model → Model 对象
  ├─ resolveModelWithRegistry()   → 从 ModelRegistry 查找
  └─ provider 动态模型 hooks:
       ├─ prepareProviderDynamicModel()
       ├─ runProviderDynamicModel()
       └─ normalizeProviderResolvedModelWithPlugin()

Model 对象包含:
  - api: "anthropic-messages" | "openai" | "ollama" | "openai-responses" | ...
  - provider: "anthropic" | "openai" | "ollama" | ...
  - baseUrl: API endpoint
  - contextWindow: token 窗口大小
  - input: ["text", "image"] 等
```

---

## 2. Tool Call 执行机制

### 2.1 Tool 注册

工具在 `runEmbeddedAttempt()` 中组装 [attempt.ts:~1790-1860]：

```
effectiveTools = [
  ...createOpenClawCodingTools()     // 内置工具 (bash, read, write, etc.)
  ...bundleMcpRuntime?.tools         // Bundle MCP 工具
  ...bundleLspRuntime?.tools         // Bundle LSP 工具
]

// 然后 splitSdkTools() 将工具分为：
builtInTools   → pi-coding-agent 内部处理
customTools    → OpenClaw 自定义 + client tools
```

### 2.2 Tool Call Dispatch

工具执行由 `@mariozechner/pi-agent-core` 的 `agent-loop.js` 驱动：

1. 模型返回 assistant message，agent-loop 提取其中 `type === "toolCall"` 的 content blocks
2. 根据 `config.toolExecution` 选择执行策略：
   - **`"parallel"`（默认）**：所有 tool calls 先**串行 prepare**（验证参数 + beforeToolCall hook），然后**并行 execute**（`Promise.all` 语义），最后串行 finalize（afterToolCall hook + emit）
   - **`"sequential"`**：严格串行，一个一个执行
3. 执行结果作为 `toolResult` role message 追加到 `messages[]`
4. 如果 assistant message 有 tool calls → 继续内循环（下一轮 LLM 调用）
5. 没有 tool calls → 检查 steering/follow-up messages → 没有则退出

**关键发现：默认是并行执行！** 这在 `types.d.ts` 中明确定义：
```typescript
toolExecution?: ToolExecutionMode; // Default: "parallel"
```

但 OpenClaw 在 `attempt.ts` 中可以覆盖此设置（通过 `applyExtraParamsToAgent`）。

### 2.3 Tool 执行事件流

通过 `subscribeEmbeddedPiSession()` [attempt.ts:2563] 监听：

```
pi-agent-core 内部工具执行
    │
    ▼ AgentEvent
subscribeEmbeddedPiSession()                    [pi-embedded-subscribe.ts]
    │
    ├─ handleToolExecutionStart()                [pi-embedded-subscribe.handlers.tools.ts:331]
    │  ├─ ★ before_tool_call hook                (可拦截/修改参数/阻止执行)
    │  ├─ 记录 toolStartData (startTime, args)
    │  └─ emitAgentEvent (tool stream)
    │
    └─ handleToolExecutionEnd()                  [pi-embedded-subscribe.handlers.tools.ts:245]
       ├─ 解析执行结果
       ├─ emitAgentEvent (tool output)
       ├─ ★ after_tool_call hook                 (可观察结果、耗时)
       └─ 更新 toolMetas
```

### 2.4 工具执行结果回传

```
工具执行 → 返回结果字符串
    │
    ▼
pi-agent-core 将结果包装为 tool_result message:
{
  role: "tool",
  tool_call_id: "xxx",
  content: "执行结果..."
}
    │
    ▼
追加到 session.messages[]
    │
    ▼
下一轮 streamFn() 调用（完整 messages[] 发送给模型）
```

### 2.5 Tool Result 缓存

**没有显式的 tool call 结果缓存机制。**

但有相关机制：
- `session-tool-result-guard.ts` — 防护工具结果上下文溢出
- `tool-result-truncation.ts` — 过长结果截断
- `tool-result-context-guard.ts` — 基于上下文窗口的结果大小限制
- `cacheTrace` — 可选的缓存追踪（用于 prompt caching 优化，非结果缓存）

---

## 3. 可 Hook 位置清单

### 3.1 Plugin Hook 系统（最推荐）

OpenClaw 有完善的插件 hook 系统，定义在 `src/plugins/types.ts:1403-1444`：

| Hook 名称 | 触发时机 | 能力 | 文件位置 |
|-----------|---------|------|---------|
| `before_model_resolve` | 模型解析前 | 覆盖 provider/model | run.ts:~340 |
| `before_prompt_build` | prompt 组装前 | 注入 system prompt | run/attempt.ts (via hookRunner) |
| `before_agent_start` | agent 启动前 | 覆盖模型 + 注入 prompt | run.ts:~360 |
| **`llm_input`** | **模型调用前** | **观察完整输入** | attempt.ts:~2856 |
| **`llm_output`** | **模型调用后** | **观察输出 + usage** | pi-embedded-subscribe (lifecycle) |
| **`before_tool_call`** | **工具执行前** | **拦截/修改参数/阻止** | handlers.tools.ts:331 |
| **`after_tool_call`** | **工具执行后** | **观察结果+耗时** | handlers.tools.ts:581 |
| `agent_end` | agent 运行结束 | 观察完整结果 | run.ts (lifecycle end) |
| `session_start` / `session_end` | 会话生命周期 | 会话级别追踪 | — |

### 3.2 streamFn Wrapper（高级拦截）

`agent.streamFn` 是一个可替换的函数引用 [attempt.ts:2239]：

```typescript
type StreamFn = (model: Model, context: Context, options?: Options) =>
  Promise<StreamResponse>;

// 现有 wrapper 模式：
const inner = activeSession.agent.streamFn;
activeSession.agent.streamFn = (model, context, options) => {
  // 拦截请求：context.messages, model.baseUrl, etc.
  const response = inner(model, context, options);
  // 拦截响应：usage, tool_calls, content
  return response;
};
```

**这是最底层的拦截点**，能拿到：
- 完整的 messages[] 请求体
- model 信息（provider, baseUrl, API key）
- 完整的响应流（包括 usage tokens）

### 3.3 Agent Event 系统

`emitAgentEvent()` / `onAgentEvent()` [src/infra/agent-events.ts]：
- 可全局订阅所有 agent 事件
- 按 `runId` 过滤
- 包含 lifecycle、assistant、tool stream

### 3.4 Usage 追踪系统

已有 usage 追踪：`src/agents/usage.ts`
- `normalizeUsage()` — 统一不同 provider 的 token 计数格式
- `createUsageAccumulator()` — 跨多轮调用累计 token
- `derivePromptTokens()` — 计算 prompt token 数
- Usage 通过 `llm_output` hook 暴露

---

## 4. 结论：最佳拦截点分析

### 判定：**情况 A — 有丰富的抽象层可 hook**

OpenClaw 的架构完全支持通过 Plugin Hook 系统注入，无需 monkey-patch HTTP。

### 推荐方案：三层拦截

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: before_model_resolve hook                             │
│  → 可在这里决定把请求路由到哪个模型                                │
│  → 实现"同一指令并发 N 个模型"的入口                               │
│  文件: run.ts:~340                                              │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2: streamFn wrapper                                      │
│  → 拦截每一次实际 LLM API 调用                                    │
│  → 记录 input/output tokens (从 response.usage)                  │
│  → 记录每次调用耗时                                               │
│  → 可将请求转发到不同 endpoint (代理模式)                           │
│  文件: attempt.ts:2239-2397                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3: before_tool_call + after_tool_call hooks              │
│  → 记录每个工具的名称、参数、结果、耗时                             │
│  → 可阻止特定工具执行                                             │
│  → 可修改工具参数                                                 │
│  文件: pi-embedded-subscribe.handlers.tools.ts:331/581           │
└─────────────────────────────────────────────────────────────────┘
```

### 关键文件索引

| 文件 | 关键函数 | 角色 |
|------|---------|------|
| `src/gateway/openai-http.ts:409` | `handleOpenAiHttpRequest` | HTTP 入口 |
| `src/agents/agent-command.ts:710` | `agentCommandInternal` | 核心调度 |
| `src/agents/agent-command.ts:352` | `runAgentAttempt` | 单次尝试 |
| `src/agents/pi-embedded-runner/run.ts:268` | `runEmbeddedPiAgent` | 嵌入式 agent 入口 |
| `src/agents/pi-embedded-runner/run/attempt.ts:1662` | `runEmbeddedAttempt` | **实际执行核心** |
| `src/agents/pi-embedded-runner/model.ts:418` | `resolveModelAsync` | 模型解析 |
| `src/agents/pi-embedded-subscribe.ts` | `subscribeEmbeddedPiSession` | 事件订阅 |
| `src/agents/pi-embedded-subscribe.handlers.tools.ts` | tool execution handlers | 工具执行事件 |
| `src/plugins/hooks.ts:159` | `createHookRunner` | Hook 系统核心 |
| `src/plugins/types.ts:1403` | Hook 类型定义 | 所有可用 hook |
| `src/agents/usage.ts` | `normalizeUsage` | Token 计数统一 |

### 实现"并发多模型对比"的建议路径

**推荐路径（不改 OpenClaw 核心代码）：**

1. **写一个 OpenClaw Plugin**，注册以下 hooks：
   - `before_model_resolve` → 克隆请求到 N 个 model 配置
   - `llm_input` → 记录每轮输入
   - `llm_output` → 记录每轮输出 + usage tokens
   - `before_tool_call` / `after_tool_call` → 记录工具链
   - `agent_end` → 汇总生成报告

2. **用 streamFn wrapper 模式** 在 attempt.ts 中注入自定义 stream 函数：
   - 可以拦截并转发到多个不同的 API endpoint
   - 每个 endpoint 的 response 都能拿到完整 usage

3. **或者用代理层（情况 C）**：
   - 配置 `models.providers.xxx.baseUrl` 指向本地代理
   - 代理层转发到多个模型并行执行
   - 这种方式最灵活，但需要改 OpenClaw 配置

**最终建议：Plugin + streamFn wrapper 混合方案，这是最干净的路径。**

---

## 5. 深挖 @mariozechner/pi-agent-core（v0.61.1）

### 5.1 核心架构概览

整个库只有 4 个文件，~1650 行代码：

| 文件 | 行数 | 角色 |
|------|------|------|
| `agent-loop.js` | 389 | **核心 agent 循环** — LLM 调用 + tool dispatch |
| `agent.js` | 417 | **Agent 类** — 状态管理 + 对外 API |
| `types.d.ts` | 285 | 类型定义 |
| `proxy.js` | 267 | 代理模式流函数 |

### 5.2 Agent Loop 完整流程

```
agent.prompt(text)
  │
  └─ Agent._runLoop(messages)
       │
       ├─ 创建 AbortController
       ├─ 构建 AgentLoopConfig:
       │    ├─ model, reasoning, toolExecution ("parallel")
       │    ├─ convertToLlm (AgentMessage[] → Message[])
       │    ├─ transformContext (可选的上下文变换)
       │    ├─ getApiKey (动态 API key 解析)
       │    ├─ getSteeringMessages (中途注入消息)
       │    ├─ getFollowUpMessages (后续消息)
       │    ├─ beforeToolCall / afterToolCall
       │    └─ streamFn (实际 HTTP 调用函数)
       │
       └─ runAgentLoop(prompts, context, config, emit, signal, streamFn)
            │
            └─ runLoop() — 双层循环
                 │
                 ├─ 外层: while(true) — follow-up messages 驱动
                 │    │
                 │    └─ 内层: while(hasToolCalls || pendingMessages)
                 │         │
                 │         ├─ 注入 pending steering messages
                 │         │
                 │         ├─ streamAssistantResponse()
                 │         │    ├─ transformContext()
                 │         │    ├─ convertToLlm()
                 │         │    ├─ ★ streamFn(model, llmContext, options) ← 实际 HTTP
                 │         │    ├─ 逐事件处理 SSE 流
                 │         │    └─ 返回 AssistantMessage (含 usage, stopReason)
                 │         │
                 │         ├─ stopReason = "error"/"aborted" → 退出
                 │         │
                 │         ├─ 提取 toolCalls = content.filter(type === "toolCall")
                 │         │
                 │         └─ executeToolCalls()
                 │              │
                 │              ├─ [parallel 模式，默认]
                 │              │    ├─ 串行 prepare: 验证 + beforeToolCall
                 │              │    ├─ 并行 execute: map → execute, 逐个 await
                 │              │    └─ 串行 finalize: afterToolCall + emit
                 │              │
                 │              └─ [sequential 模式]
                 │                   └─ 串行 prepare → execute → finalize
                 │
                 └─ 检查 followUpMessages → 有则继续外层循环
```

### 5.3 streamFn 的精确签名

```typescript
type StreamFn = (
  model: Model,
  context: { systemPrompt: string; messages: Message[]; tools?: AgentTool[] },
  options?: { apiKey?: string; signal?: AbortSignal; reasoning?: string; ... }
) => AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> };
```

`context.messages` 已经是 `convertToLlm()` 转换后的 LLM 格式。

### 5.4 Tool 执行的并行细节

```javascript
// executeToolCallsParallel() 实际逻辑：

// 阶段 1: 串行 prepare（beforeToolCall 可能有副作用）
for (const toolCall of toolCalls) {
  emit({ type: "tool_execution_start", ... });
  const preparation = await prepareToolCall(...);
  if (preparation.kind === "immediate") {        // 被 block 或参数错误
    results.push(await emitToolCallOutcome(...));
  } else {
    runnableCalls.push(preparation);             // 可执行的
  }
}

// 阶段 2: 并行 execute（所有可执行的工具同时启动）
const runningCalls = runnableCalls.map(prepared => ({
  prepared,
  execution: executePreparedToolCall(prepared, signal, emit),
}));

// 阶段 3: 串行 finalize（按原始顺序等待结果）
for (const running of runningCalls) {
  const executed = await running.execution;
  results.push(await finalizeExecutedToolCall(...));
}
```

### 5.5 pi-ai streamSimple 调用链

```
streamSimple(model, context, options)
  └─ resolveApiProvider(model.api)
       └─ provider.streamSimple(...)
            ├─ [openai-completions] → OpenAI SDK → POST /chat/completions
            ├─ [anthropic-messages] → Anthropic SDK → POST /messages
            ├─ [google] → Google Gemini SDK
            ├─ [ollama] → Ollama native API
            └─ [openai-responses] → OpenAI Responses API
```

### 5.6 修正后的结论

**修正前**（第一版分析报告）：Tool 执行是串行的
**修正后**：Tool 执行**默认是并行的**（parallel 模式），prepare 和 finalize 串行

**对并发多模型方案的决定性影响**：

`agent.prompt()` 调用后进入 `_runLoop`，整个循环是**不可分叉的** — 一个 Agent 实例同一时间只能跑一个 prompt。要实现并发多模型：

- **方案 A（推荐）**：在 `agent.prompt()` 之前 fork — 创建 N 个独立的 Agent 实例，每个配置不同的 model，共享相同的初始 messages，各自独立运行完整的 tool call 链路
- **方案 B**：在 `streamFn` 层拦截 — 单个 Agent，streamFn 内部转发到 N 个 endpoint，选一个作为主响应（不适合需要各自独立 tool call 链的场景）
- **方案 C**：外部代理层 — 不改 Agent，HTTP 层面做路由

**方案 A 的可行性已验证**：Agent 类是纯 JavaScript 对象，无全局单例约束，`new Agent({...})` 可以创建任意多个实例。`SessionManager.open()` 可以对同一个 session file 只读使用。唯一需要处理的是：
1. 每个 Agent 实例需要独立的 session file（避免写冲突）
2. Tool 执行需要 sandbox 隔离（不同模型可能对同一文件做不同修改）
3. Usage 数据通过 `AssistantMessage.usage` 字段获取（每次 LLM 调用后自动填充）

---

## 6. 回顾补漏

### 6.1 ⚠️ Lane 并发锁（方案 A 的关键障碍）

`runEmbeddedPiAgent()` 使用**双层 lane 排队**：

```typescript
// run.ts:271-288
const sessionLane = resolveSessionLane(sessionKey);  // "session:<key>"
const globalLane = resolveGlobalLane(lane);           // "main"

return enqueueSession(() =>
  enqueueGlobal(async () => {
    // ... 实际执行
  })
);
```

每个 lane 的 `maxConcurrent` 默认为 **1**（`command-queue.ts:79`）。这意味着：

- **同一 sessionKey**：session lane 锁保证串行，不可能并行
- **全局 "main" lane**：所有非特殊 lane 的任务都排队等这个锁

**对方案 A 的影响**：如果直接通过 `runEmbeddedPiAgent` 发起 N 个并发模型调用，它们会被 lane 锁**串行化**。解决办法：
- 给每个并发 Agent 分配不同的 sessionKey（绕过 session lane 锁）
- 使用不同的 lane 或提高 `maxConcurrent`（绕过 global lane 锁）
- 或者直接绕过 `runEmbeddedPiAgent`，自行创建 Agent 实例和 session，跳过 lane 排队

### 6.2 AssistantMessage.usage 精确字段结构

已从 `@mariozechner/pi-ai/dist/types.d.ts` 确认：

```typescript
interface Usage {
  input: number;        // input tokens
  output: number;       // output tokens
  cacheRead: number;    // prompt cache read tokens
  cacheWrite: number;   // prompt cache write tokens
  totalTokens: number;  // 总计
  cost: {
    input: number;      // 输入成本 ($)
    output: number;     // 输出成本 ($)
    cacheRead: number;  // 缓存读成本
    cacheWrite: number; // 缓存写成本
    total: number;      // 总成本
  };
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;          // "openai" | "anthropic-messages" | ...
  provider: string;     // "openai" | "anthropic" | ...
  model: string;        // "gpt-4o" | "claude-sonnet-4-20250514" | ...
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}
```

每次 LLM 调用结束后，`AssistantMessage` 自动包含完整的 usage 数据 — 不需要额外解析 HTTP 响应。

### 6.3 Sandbox workspace 隔离模式

已从 `src/agents/sandbox/types.ts` 确认三种模式：

```typescript
type SandboxWorkspaceAccess = "none" | "ro" | "rw";
```

- `"rw"`：直接在原始 workspace 目录工作（写入共享）
- `"ro"`：workspace 只读挂载，sandbox 有自己的写层
- `"none"`：不挂载 workspace

**对并发多模型的影响**：每个并发 Agent 需要各自独立的 workspace 副本（sandbox mode = `"ro"` 或 `"none"`），否则多个模型可能同时修改同一文件导致冲突。Sandbox 后端支持 Docker 隔离，每个 session 可以有独立容器。

### 6.4 最终遗漏检查清单

| # | 检查项 | 状态 | 备注 |
|---|--------|------|------|
| **源码分析** | | | |
| 1 | 调用链路：用户指令 → LLM HTTP | ✅ | 7 层调用栈，完整追踪到 streamFn |
| 2 | 请求体组装（messages, tools, system prompt） | ✅ | convertToLlm + buildEmbeddedSystemPrompt |
| 3 | 响应解析：tool_calls 提取 | ✅ | agent-loop.js 逐事件处理 |
| 4 | Provider 抽象层 | ✅ | pi-ai 的 API provider registry |
| 5 | Tool dispatch 机制 | ✅ **已修正** | 默认并行，不是串行 |
| 6 | Tool 结果回传 | ✅ | toolResult message → messages[] |
| 7 | pi-agent-core 内部 agent loop | ✅ | 双层 while 循环，完整逆向 |
| 8 | pi-ai streamSimple → HTTP 调用 | ✅ | provider registry → OpenAI SDK / Anthropic SDK |
| **可 Hook / 拦截点** | | | |
| 9 | streamFn wrapper | ✅ | 最底层拦截，完整 request/response |
| 10 | Agent.beforeToolCall / afterToolCall | ✅ | pi-agent-core 级别 |
| 11 | OpenClaw Plugin hooks (27种) | ✅ | llm_input/output, before/after_tool_call 等 |
| 12 | onAgentEvent 全局事件总线 | ✅ | **Plugin runtime 直接暴露 `runtime.events.onAgentEvent`** |
| 13 | onSessionTranscriptUpdate | ✅ | **Plugin runtime 直接暴露** |
| **并发 / 隔离** | | | |
| 14 | Lane 并发锁 | ✅ **关键发现** | maxConcurrent=1，需要绕过或用不同 sessionKey |
| 15 | Workspace sandbox 隔离 | ✅ | none/ro/rw 三种模式，Docker 后端 |
| 16 | Agent 实例是否可多实例 | ✅ | 纯 JS 对象，无全局单例 |
| **数据 / 存储** | | | |
| 17 | AssistantMessage.usage 精确结构 | ✅ | input/output/cacheRead/cacheWrite + cost (USD) |
| 18 | SessionEntry 元数据 | ✅ | channel, model, provider, tokens, cost, compactionCount |
| 19 | Session transcript (.jsonl) | ✅ | 磁盘上完整记录 |
| 20 | Plugin 持久化目录 | ✅ | `registerService` 提供 `stateDir` |
| **Plugin 系统** | | | |
| 21 | Plugin 注册 API（OpenClawPluginApi） | ✅ | api.on() (typed hooks) / registerTool / registerHttpRoute / registerService |
| 22 | Plugin 安装方式 | ✅ | config `plugins.installs` — npm/path/archive |
| 23 | Plugin runtime 能力 | ✅ **新确认** | 可调用 onAgentEvent, loadConfig, session store, runEmbeddedPiAgent |
| 24 | Plugin 后台服务 | ✅ **新确认** | `registerService` — start/stop 生命周期 |
| 25 | Plugin 实时推送到前端 | ✅ **已修正** | broadcast 无法从 hook 回调调用 → 改用 SSE（见 architecture.md 6.2） |
| **UI 注入** | | | |
| 26 | Control UI 技术栈 | ✅ | Lit 3.x, Light DOM (无 Shadow DOM) |
| 27 | CSP 策略是否阻止注入 | ✅ | `script-src 'self'` — 同源 plugin HTTP 路由兼容 |
| 28 | Plugin HTTP 路由 vs Control UI 优先级 | ✅ | **Plugin 优先**（源码注释明确） |
| 29 | index.html 注入可行性 | ✅ | 安装时改 dist/control-ui/index.html |
| 30 | 前端实时数据推送 | ✅ **已修正** | SSE (EventSource) + auth: "plugin" + query token |
| 31 | DOM 操作可行性 | ✅ | Light DOM，标准 querySelector 可用 |
| **需求覆盖** | | | |
| 32 | 模块 A：全局 session 监控 | ✅ | onAgentEvent + session store + transcript |
| 33 | 模块 B：并发多模型对比 | ✅ | fork Agent 实例，lane 锁绕过方案明确 |
| 34 | Greasemonkey 式 UI 注入 | ✅ | Light DOM + 同源 script + SSE |
| 35 | 不修改 OpenClaw 核心代码 | ✅ | 全部通过 Plugin API 实现 |

### 6.5 Plugin Runtime 关键能力确认（第三轮补充）

`PluginRuntimeCore`（`src/plugins/runtime/types-core.ts`）直接暴露：

```typescript
runtime.events.onAgentEvent       // 全局 agent 事件监听 — 模块 A 的核心数据源
runtime.events.onSessionTranscriptUpdate  // session transcript 变更通知
runtime.agent.runEmbeddedPiAgent  // 可以从 plugin 内部发起 agent 运行 — 模块 B 的执行入口
runtime.agent.session.loadSessionStore   // 读取 sessions.json
runtime.agent.session.resolveStorePath   // 解析 session 存储路径
runtime.config.loadConfig         // 读取完整配置
runtime.state.resolveStateDir     // plugin 持久化目录
```

这意味着 plugin 不需要任何 hack — 所有模块 A 和模块 B 需要的底层能力都有官方 API 支持。

**特别关键**：`runtime.agent.runEmbeddedPiAgent` 是从 plugin 内部发起一次完整 agent 运行的官方入口。模块 B 的并发对比可以直接调用这个 API，传入不同的 provider/model，而不需要自己创建 Agent 实例。这比之前分析的"方案 A: fork Agent 实例"更干净。

---

## 7. 需求再确认：两个功能模块

经过需求澄清，系统实际包含**两个独立的功能模块**，服务于不同的使用场景：

### 模块 A：全局 Session 监控（被动观察）

**目标**：跟踪所有 sessions 的任务执行情况，分析不同 channel 的 SDK 注入的提示词对任务拆分效率的影响。

**特征**：
- 被动观察，不干预正常执行流程
- 覆盖所有 channel（telegram, slack, discord, whatsapp, webchat, ...共 81 个 extensions）
- 需要跨 session 统计和对比
- 关注点：每个 session 的 tool call 序列、LLM 调用次数、token 用量、耗时、成功/失败率

**数据采集点**（全部已验证可用）：

| 数据 | 来源 | 机制 |
|------|------|------|
| session 元信息 | `SessionEntry` (sessions.json) | channel, model, provider, sessionKey, agentId |
| 每次 LLM 调用的 token | `AssistantMessage.usage` | input/output/cacheRead/cacheWrite/cost |
| tool call 列表 + 耗时 | `tool_execution_start/end` 事件 | 通过 `onAgentEvent()` 全局监听 |
| system prompt 差异 | `systemPromptReport` on SessionEntry | 记录了 bootstrap files, skills, tools |
| channel 特定提示词 | `extraSystemPrompt` / `prependContext` | 通过 `before_prompt_build` hook 或 `llm_input` hook 捕获 |
| session 生命周期 | `lifecycle` stream events | start/end/error + durationMs |
| 完整对话 transcript | `.jsonl` session files | 磁盘上已有完整记录 |

**最佳拦截方式**：

```
方式 1（推荐）：onAgentEvent() 全局监听
  └─ src/infra/agent-events.ts
  └─ 全局单例，所有 runId 的事件都经过这里
  └─ 含 sessionKey，可以按 session 分组
  └─ 不影响任何执行流程

方式 2：Plugin hooks（llm_input + llm_output + before/after_tool_call）
  └─ 更结构化，有完整的上下文 (agentId, sessionKey, provider, model)
  └─ 但 hook 是 async 的，理论上有微小性能影响

方式 3：直接读取 sessions.json + .jsonl transcript 文件
  └─ 纯离线分析，零运行时影响
  └─ 适合做事后分析报告
```

**推荐**：方式 1 + 方式 3 组合 — 实时用 `onAgentEvent()` 监听，离线用 transcript 文件做深度分析。

### 模块 B：并发多模型对比（主动干预）

**目标**：同一用户指令，同一 channel，并发发给 N 个模型，各自独立执行完整 tool call 链，记录对比数据。

**特征**：
- 主动干预，需要拦截并 fork 请求
- 限定在同一个 channel 内（同一条消息触发）
- 每个模型独立的 session + workspace
- 需要对齐对比维度：相同 prompt，不同 model 的表现差异

**拦截点选择**：

在同一 channel 内拦截，最干净的位置是 `agentCommandInternal()` 级别（`src/agents/agent-command.ts:710`）。此时：
- 用户 prompt 已解析完毕
- session 已确定
- model 还没开始 resolve（可以覆盖）
- channel 特定的 extraSystemPrompt 已经附加

```
用户发消息(channel: telegram)
  │
  └─ agentCommandInternal()         ← 在这里拦截
       │
       ├─ [原始流程] model A → runAgentAttempt → 完整 tool chain
       │
       └─ [fork 出的] model B → 独立 sessionKey/workspace → 完整 tool chain
                      model C → 独立 sessionKey/workspace → 完整 tool chain
```

**Lane 锁绕过策略**：
- 每个 fork 的模型使用不同的 sessionKey（如 `original-key:compare:modelB`）
- 或者直接使用 `setCommandLaneConcurrency()` 提高并发上限
- 或者给 fork 请求传入自定义 `enqueue` 函数绕过 lane 系统

### 两个模块的关系

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                         │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │ Telegram  │  │  Slack   │  │ Discord  │  ... (81个)      │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                 │
│       │              │              │                       │
│       └──────────────┼──────────────┘                       │
│                      │                                      │
│                      ▼                                      │
│            agentCommandInternal()                           │
│                      │                                      │
│         ┌────────────┼────────────┐                        │
│         │            │            │                        │
│         ▼            ▼            ▼                        │
│    ┌─────────┐  ┌─────────┐  ┌─────────┐                 │
│    │ Model A │  │ Model B │  │ Model C │  ← 模块B: 并发对比│
│    └────┬────┘  └────┬────┘  └────┬────┘                  │
│         │            │            │                        │
│         └────────────┼────────────┘                        │
│                      │                                      │
│                      ▼                                      │
│              onAgentEvent()  ←────────── 模块A: 全局监控    │
│              (所有 session)                                  │
│                      │                                      │
│                      ▼                                      │
│              ┌───────────────┐                              │
│              │  数据存储层    │                              │
│              │  (共享)       │                              │
│              └───────┬───────┘                              │
│                      │                                      │
│         ┌────────────┼────────────┐                        │
│         ▼            ▼            ▼                        │
│    ┌─────────┐  ┌─────────┐  ┌─────────┐                 │
│    │ Web UI  │  │JSON/CSV │  │对比报告  │                  │
│    │(实时)   │  │(离线)   │  │(汇总)   │                  │
│    └─────────┘  └─────────┘  └─────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

### 交互设计考虑

**模块 A（全局监控）的交互**：
- 默认始终开启，被动记录
- Web UI 提供 dashboard 视图：按 channel 分组的 session 列表
- 可按 channel / model / agent / 时间范围 过滤
- 核心指标：平均 tool call 次数、平均 token、平均耗时、成功率
- 点击单个 session → 展开瀑布图（每步 LLM 调用 + tool 执行的时间线）
- 跨 channel 对比视图：同一个 agent，不同 channel 的效率差异

**模块 B（并发对比）的交互**：
- 需要明确的开关 — 不能默认并发所有请求（成本翻 N 倍）
- 配置方式：在 OpenClaw config 中指定对比模型列表
  ```yaml
  compare:
    enabled: true
    models:
      - provider: anthropic
        model: claude-sonnet-4-20250514
      - provider: openai
        model: gpt-4o
    channels: ["telegram"]  # 只在特定 channel 启用
  ```
- 或通过 CLI 命令临时启用：`/compare on anthropic/claude-sonnet-4-20250514 openai/gpt-4o`
- 执行时：原始模型的结果正常返回给用户，对比模型在后台静默执行
- 对比报告在 Web UI 中查看，不干扰用户聊天体验

**两个模块共享的数据层**：
- 统一的事件存储（每次 LLM 调用、每个 tool 执行、每个 session 生命周期）
- 模块 A 的数据是模块 B 的超集 — 模块 B 只是在特定 session 上多了"哪些 model 在并行对比"的元信息
- JSON/CSV 导出共用同一份数据

### 7.1 Plugin 注册方式补充

OpenClaw 的 plugin 系统通过 `OpenClawPluginApi` 接口注册，位于 `src/plugins/registry.ts:884`。一个 plugin 可以同时注册：

- `api.on(hookName, handler)` — 注册 typed hook（27 种），`registerHook(events, handler)` — 注册 internal hook
- `registerTool(tool)` — 注册自定义工具
- `registerHttpRoute(params)` — 注册 HTTP 路由（用于 Web UI）
- `registerChannel(registration)` — 注册新 channel
- `registerProvider(provider)` — 注册模型 provider
- `registerGatewayMethod(method, handler)` — 注册 gateway 方法
- `registerService(service)` — 注册后台服务

**Plugin 通过 config 中的 `plugins.installs` 配置加载**，支持 npm 包、本地路径、archive 等来源。

这意味着我们的监控系统可以打包成一个 OpenClaw Plugin，通过标准的 plugin 安装机制部署，注册所需的 hooks + HTTP 路由（Web UI），不需要 fork 或修改 OpenClaw 核心代码。

---

## 8. Dashboard UI 注入可行性分析（Greasemonkey 模式）

### 8.1 Control UI 技术栈

| 项目 | 技术 |
|------|------|
| 框架 | **Lit 3.x**（Web Components） |
| Shadow DOM | **不使用** — `createRenderRoot() { return this; }` 返回 light DOM |
| 构建工具 | Vite |
| 产物位置 | `dist/control-ui/`（预编译的静态文件） |
| 服务方式 | `serveResolvedIndexHtml()` 读取 `index.html` 字符串 → `res.end(body)` |
| CSP 策略 | `script-src 'self'` — 只允许同源脚本 |
| SPA 路由 | 客户端路由，所有未匹配路径 fallback 到 `index.html` |

### 8.2 关键发现：注入完全可行

**发现 1：Light DOM — 没有 Shadow DOM 隔离**

`openclaw-app` 主组件和 `dashboard-header` 等子组件都使用 `createRenderRoot() { return this; }`，所有 DOM 节点直接在 document 中，标准 `document.querySelector()` 可以直接访问和修改。

**发现 2：Plugin HTTP 路由优先于 Control UI**

`server-http.ts:910` 的注释明确说明：
```
// Plugin routes run before the Control UI SPA catch-all so explicitly
// registered plugin endpoints stay reachable.
```

Plugin 通过 `registerHttpRoute({ path: "/plugins/clawlens/...", match: "prefix" })` 注册的路由会在 Control UI 之前处理。这意味着 plugin 可以 serve 自己的 JS/CSS 文件。

**发现 3：CSP `script-src 'self'` 兼容**

CSP 只允许同源脚本。Plugin HTTP 路由和 Control UI 在同一个 HTTP server 上（同源），所以注入的 `<script src="/plugins/clawlens/inject.js">` 完全合法。

**发现 4：`index.html` 是字符串处理**

`serveResolvedIndexHtml()` 接收 `body: string`，没有做任何转换直接输出。可以在这一步做字符串替换注入。

### 8.3 三种注入路径

#### 路径 A：index.html 字符串注入（最干净）

在 gateway 启动时，通过 `gateway_start` hook 对 `serveResolvedIndexHtml` 做 monkey-patch：

```typescript
// 概念代码
const originalServe = controlUiModule.serveResolvedIndexHtml;
controlUiModule.serveResolvedIndexHtml = (res, body) => {
  const injected = body.replace(
    '</head>',
    '<script src="/plugins/clawlens/inject.js"></script></head>'
  );
  originalServe(res, injected);
};
```

**问题**：`serveResolvedIndexHtml` 是模块内私有函数，不能直接从外部 patch。需要找到可以拦截的公开接口。

#### 路径 B：Plugin HTTP 路由拦截根路径（可行但有风险）

Plugin 注册 `path: "/"` + `match: "prefix"` 会拦截所有请求（因为 plugin 优先于 Control UI）。可以在 handler 中：
1. 对非 HTML 请求 return false（交给后续 handler）
2. 对 HTML 请求，读取原始 index.html，注入 script 标签后返回

**问题**：需要拿到 Control UI 的 root 路径来读取 index.html 文件，且 `match: "prefix"` 加 `path: "/"` 可能拦截过于宽泛。

#### 路径 C：自加载脚本 + MutationObserver（最稳健，推荐）

不修改 index.html 送达过程，而是：
1. Plugin 注册 `registerHttpRoute({ path: "/plugins/clawlens", match: "prefix" })` serve 静态资源
2. 利用已有的 `ControlUiBootstrapConfig`（`/__openclaw/control-ui-config.json`）机制 — 前端已有加载配置的逻辑
3. 在 Control UI 的现有 JS 加载完成后，通过 `registerGatewayMethod` 注册自定义 WS 方法，前端可以通过 gateway WebSocket 协议拉取监控数据
4. 注入脚本的方式：**直接替换构建产物的 index.html 文件**

**最终推荐方案**：路径 C 的变体 — 在 plugin install/build 阶段修改 `dist/control-ui/index.html`，添加一行 `<script>` 标签。这是一次性操作，不需要运行时 patch：

```html
<!-- dist/control-ui/index.html 末尾 -->
<script type="module" src="/plugins/clawlens/inject.js"></script>
</body>
```

### 8.4 注入脚本能做什么

因为没有 Shadow DOM，注入脚本可以：

```javascript
// inject.js — 在 Control UI 加载完成后执行

// 1. 在 sessions 列表的每一行追加 token 用量指示器
document.querySelectorAll('.session-row').forEach(row => {
  const sessionKey = row.dataset.sessionKey;
  const badge = document.createElement('span');
  badge.className = 'clawlens-token-badge';
  badge.textContent = '1.2k tokens';
  row.querySelector('.session-info').appendChild(badge);
});

// 2. 在 overview 页面追加全局监控面板
const overview = document.querySelector('.overview-cards');
const monitorPanel = document.createElement('div');
monitorPanel.className = 'card clawlens-panel';
monitorPanel.innerHTML = `<div class="card-title">Task Efficiency Monitor</div>...`;
overview.parentNode.insertBefore(monitorPanel, overview.nextSibling);

// 3. 在 session 详情页追加瀑布图
const chatView = document.querySelector('.chat-view');
const waterfall = document.createElement('div');
waterfall.className = 'clawlens-waterfall';
// ... 渲染 LLM 调用 + tool 执行的时间线

// 4. 通过 WebSocket 实时接收监控数据
const ws = new WebSocket(`ws://${location.host}`);
ws.onmessage = (evt) => {
  const data = JSON.parse(evt.data);
  if (data.method === 'clawlens.update') {
    updateMonitorPanels(data.payload);
  }
};
```

### 8.5 DOM 注入目标清单

| 视图 | CSS 选择器 | 注入内容 |
|------|-----------|---------|
| Overview | `.overview-cards` 后面 | 全局监控 dashboard 面板 |
| Sessions 列表 | `.card` (sessions table) | 每行追加 token/cost badge |
| Session 详情 | `.chat-view` | 瀑布图 + 对比结果面板 |
| 导航栏 | `dashboard-header` | 监控状态指示灯 |
| 新增 Tab | 导航栏追加 | 独立的 Monitor 视图 |

### 8.6 数据通信方式

注入脚本需要从后端获取监控数据，有两种通路：

**通路 1：Plugin HTTP API（适合历史数据）**
```
GET /plugins/clawlens/api/sessions       → 所有 session 的汇总数据
GET /plugins/clawlens/api/session/:key   → 单个 session 的详细数据
GET /plugins/clawlens/api/compare/:id    → 对比结果
```

**通路 2：Gateway WebSocket（适合实时数据）**

Plugin 可以通过 `registerGatewayMethod("clawlens.subscribe", handler)` 注册自定义 WS 方法。前端注入脚本通过现有的 gateway WS 连接调用：
```javascript
// 利用 Control UI 已有的 WS 连接
gatewayClient.request("clawlens.subscribe", { sessionKey: "..." });
```

### 8.7 总结

| 方面 | 结论 |
|------|------|
| 能否注入 UI 元素 | ✅ 完全可行，Light DOM 无隔离 |
| 能否在不重新编译的情况下注入 | ✅ 修改 dist/control-ui/index.html 添加一行 script 标签 |
| CSP 是否阻止 | ✅ 不阻止，同源 script-src 'self' 兼容 |
| 能否访问现有 DOM | ✅ 所有组件都在 Light DOM |
| 能否接收实时数据 | ✅ Plugin 注册 WS 方法 + HTTP API |
| 能否作为 Plugin 安装 | ✅ registerHttpRoute + registerGatewayMethod |
| 需要修改 OpenClaw 核心代码吗 | ❌ 不需要 |

**整体方案：一个 OpenClaw Plugin 搞定所有**

```
clawlens/
├── src/
│   ├── index.ts            # Plugin 入口：注册 hooks + HTTP routes + gateway methods
│   ├── collector.ts        # 模块 A：全局事件收集器（onAgentEvent 监听）
│   ├── comparator.ts       # 模块 B：并发多模型对比引擎
│   ├── storage.ts          # 数据存储层（SQLite / JSON files）
│   └── api.ts              # HTTP API endpoints
├── ui/
│   ├── inject.js           # 注入到 Control UI 的主脚本
│   ├── clawlens-panel.js    # Overview 页面的监控面板组件
│   ├── waterfall.js        # Session 详情的瀑布图组件
│   ├── compare-view.js     # 对比结果视图
│   └── styles.css          # 注入的样式
└── install.sh              # 安装脚本：plugin install + 修改 index.html 添加 script 标签
```
