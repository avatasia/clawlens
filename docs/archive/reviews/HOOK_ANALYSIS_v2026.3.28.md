# ClawLens Hook 机制复核

> 复核时间：2026-04-01
> 证据源：`projects-ref/openclaw/src/plugins/types.ts`、`projects-ref/openclaw/src/plugins/hooks.ts`、`projects-ref/openclaw/src/plugins/registry.ts`、`projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`

## 结论摘要

1. `api.on()` 仍是 ClawLens 应使用的 typed plugin hook 注册入口。
2. `llm_input`、`llm_output`、`agent_end`、`after_tool_call` 是 void hook，框架并行执行并等待其完成。
3. `before_agent_start` 是 legacy modifying hook，顺序执行且逐个 await。
4. `tool_result_persist`、`before_message_write` 是同步 hook，不会 await Promise。
5. `llm_output` 的语义是 per-run 结束时的累计输出，不是 per-call。

## 一、注册入口

证据：

- `projects-ref/openclaw/src/plugins/types.ts:2482-2544`

结论：

- ClawLens 使用 `api.on(hookName, handler)` 是正确路径。
- 现有文档里把 `api.on()` 说成“旧接口”不准确；过时的是把所有 handler 写成 `any`，不是 `on()` 这个 API 本身。

## 二、当前与 ClawLens 相关的 hook

### 1. `llm_input`

证据：

- `projects-ref/openclaw/src/plugins/types.ts:1975-1983`
- `projects-ref/openclaw/src/plugins/hooks.ts:527-533`

结论：

- 事件里有 `runId`、`sessionId`、`provider`、`model`、`systemPrompt`、`prompt`、`historyMessages`、`imagesCount`。
- 这是 void hook，走并行执行路径。

### 2. `llm_output`

证据：

- `projects-ref/openclaw/src/plugins/types.ts:1985-1999`
- `projects-ref/openclaw/src/plugins/hooks.ts:537-542`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts:1808-1833`

结论：

- 事件类型公开的 `usage` 字段只有 token 计数，不含 `cost`。
- OpenClaw 在 run 末尾调用一次 `runLlmOutput()`，并传 `getUsageTotals()`。
- 所以这是 per-run 累计 usage hook。

### 3. `after_tool_call`

证据：

- `projects-ref/openclaw/src/plugins/types.ts:2196-2205`
- `projects-ref/openclaw/src/plugins/hooks.ts:733-742`

结论：

- 实际字段名是 `params` / `result` / `error` / `durationMs`。
- ClawLens 文档和测试若继续使用 `input` / `content` / `isError`，都属于陈旧表述。

### 4. `before_agent_start`

证据：

- `projects-ref/openclaw/src/plugins/types.ts:1943-1949`
- `projects-ref/openclaw/src/plugins/hooks.ts:494-513`

结论：

- 这是 legacy compatibility hook。
- 执行方式是顺序 modifying hook，框架逐个 `await` handler。
- 它并没有被移除，也不是 fire-and-forget。

### 5. `tool_result_persist`

证据：

- `projects-ref/openclaw/src/plugins/types.ts:2207-2229`
- `projects-ref/openclaw/src/plugins/hooks.ts:745-800`

结论：

- 这是同步、顺序、可修改 `message` 的 hook。
- 返回 Promise 时，结果会被忽略并写 warning。

### 6. `before_message_write`

证据：

- `projects-ref/openclaw/src/plugins/types.ts:2231-2241`
- `projects-ref/openclaw/src/plugins/hooks.ts:808-878`

结论：

- 这是同步、顺序、可 `block` 或替换 `message` 的 hook。
- 它位于 transcript append 的热路径上，比 `onSessionTranscriptUpdate` 更接近真正的写盘边界。

## 三、错误处理模型

证据：

- `projects-ref/openclaw/src/plugins/hooks.ts:250-258`
- `projects-ref/openclaw/src/plugins/hooks.ts:282-287`
- `projects-ref/openclaw/src/plugins/hooks.ts:334-336`
- `projects-ref/openclaw/src/plugins/hooks.ts:790-796`
- `projects-ref/openclaw/src/plugins/hooks.ts:862-868`

结论：

- 默认模式下，hook 抛错会被框架记录日志并吞掉。
- 因此插件作者不能把 hook 当作“抛错即可阻断主流程”的稳定机制。
- 真正的阻断应使用 hook 协议本身支持的返回值，例如 `before_tool_call.block` 或 `before_message_write.block`。

## 四、`allowPromptInjection` 复核

证据：

- `projects-ref/openclaw/src/plugins/registry.ts:869-889`

结论：

- `before_prompt_build` 在策略关闭时会被直接拦截，根本不注册。
- `before_agent_start` 则只会被约束掉 prompt injection 相关字段，不会整体失效。
- 所以 ClawLens 文档若只写“严格策略会让 before_agent_start 失效”，是不准确的。

## 五、对 ClawLens 的直接影响

1. Module A 不能再宣称自己基于 hook 拿到了 per-call usage；当前拿到的是 per-run 累计值。
2. Module B 继续依赖 `before_agent_start` 在技术上仍可运行，但应明确其 legacy 身份。
3. 若未来要在写盘前采集 assistant message 或 usage，优先研究 `before_message_write`，不要把 `onSessionTranscriptUpdate` 描述成等价替代品。
4. 测试和文档都应统一采用 `after_tool_call` 的真实字段名：`params`、`result`、`error`。
