# ClawLens Hook 机制复核

> 复核时间：2026-04-01
> 证据源：`projects-ref/openclaw/src/plugins/types.ts`、`projects-ref/openclaw/src/plugins/hooks.ts`、`projects-ref/openclaw/src/plugins/registry.ts`、`projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
> 输出策略：基于原文另存为新文件；原文件未修改。

## 本轮修改/删除说明

1. 保留原文主结论，原因是 `api.on()`、void/modifying/sync hook 的划分、`llm_output` 为 per-run 等判断仍与源码一致。
2. 强化了 “同步 hook 不 await Promise” 的表述，原因是 `hooks.ts` 中对 Promise 返回值的处理不是“稍后 await”，而是“直接 warning 并忽略结果”。
3. 删除了任何可能把 `onSessionTranscriptUpdate` 误写成 hook 等价替代物的含糊表达，原因是 transcript update 事件的 `message` 本身是 optional，且很多路径只发 `sessionFile`。

## 结论摘要

1. `api.on()` 仍是 ClawLens 应使用的 typed hook 注册入口，不是旧接口。
2. `llm_input`、`llm_output`、`agent_end`、`after_tool_call` 是 void hook，框架并行执行并等待所有 handler 完成。
3. `before_agent_start` 是 legacy modifying hook，顺序执行且逐个 await。
4. `tool_result_persist`、`before_message_write` 是同步 hook；返回 Promise 会被警告并忽略结果。
5. `llm_output` 的语义仍是 per-run 结束时的累计输出，不是 per-call。

## 一、注册入口

证据：

- `projects-ref/openclaw/src/plugins/types.ts:2470-2555`

结论：

- `api.on(hookName, handler)` 仍是标准 typed hook 注册方式。
- 真正过时的是把 handler 全部写成 `any`，不是 `on()` 这个 API。

## 二、与 ClawLens 直接相关的 hook

### 1. `llm_input`

证据：

- `projects-ref/openclaw/src/plugins/types.ts:1971-1983`
- `projects-ref/openclaw/src/plugins/hooks.ts:527-533`

结论：

- 事件字段包含 `runId`、`sessionId`、`provider`、`model`、`systemPrompt?`、`prompt`、`historyMessages`、`imagesCount`。
- 这是 void hook，走并行路径。

### 2. `llm_output`

证据：

- `projects-ref/openclaw/src/plugins/types.ts:1985-1999`
- `projects-ref/openclaw/src/plugins/hooks.ts:537-542`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts:1805-1828`

结论：

- 类型公开的 `usage` 只有 token 计数，没有 `cost` 字段。
- 运行时调用点位于 run 尾部，并传 `getUsageTotals()`。
- 因此它是 per-run、累计 usage hook。

### 3. `after_tool_call`

证据：

- `projects-ref/openclaw/src/plugins/types.ts:2194-2205`
- `projects-ref/openclaw/src/plugins/hooks.ts:733-742`

结论：

- 实际字段名是 `params` / `result` / `error` / `durationMs`。
- ClawLens 文档或测试若还使用 `input` / `content` / `isError`，均为陈旧表述。

### 4. `before_agent_start`

证据：

- `projects-ref/openclaw/src/plugins/types.ts:1943-1949`
- `projects-ref/openclaw/src/plugins/hooks.ts:494-513`
- `projects-ref/openclaw/src/plugins/status.ts:101-109`

结论：

- 这是 legacy compatibility hook。
- 它是 modifying hook，不是 fire-and-forget。

### 5. `tool_result_persist`

证据：

- `projects-ref/openclaw/src/plugins/types.ts:2207-2229`
- `projects-ref/openclaw/src/plugins/hooks.ts:745-800`

结论：

- 它是同步、顺序、可修改 `message` 的 hook。
- handler 返回 Promise 时，框架只写 warning 并忽略结果，不会 await。

### 6. `before_message_write`

证据：

- `projects-ref/openclaw/src/plugins/types.ts:2231-2241`
- `projects-ref/openclaw/src/plugins/hooks.ts:808-868`
- `projects-ref/openclaw/src/agents/session-tool-result-guard.ts:147-176`

结论：

- 它是同步、顺序、可 `block` 或替换 `message` 的 hook。
- 它位于 transcript append 热路径上，比 `onSessionTranscriptUpdate` 更接近真正写盘边界。

## 三、错误处理模型

证据：

- `projects-ref/openclaw/src/plugins/hooks.ts:250-258`
- `projects-ref/openclaw/src/plugins/hooks.ts:282-287`
- `projects-ref/openclaw/src/plugins/hooks.ts:330-334`
- `projects-ref/openclaw/src/plugins/hooks.ts:772-781`
- `projects-ref/openclaw/src/plugins/hooks.ts:837-846`

结论：

- 默认模式下，hook 异常会被记录并吞掉。
- 默认模式下，插件不能依赖“抛错即阻断主流程”。
- 真正可控的阻断，应使用 hook 协议支持的返回值，例如 `before_tool_call.block` 或 `before_message_write.block`。

## 四、`allowPromptInjection` 复核

证据：

- `projects-ref/openclaw/src/plugins/registry.ts:869-889`

结论：

- `before_prompt_build` 会被直接阻止注册。
- `before_agent_start` 只会失去 prompt mutation 能力，不会整体失效。

## 五、对 ClawLens 的直接影响

1. Module A 不能再宣称自己通过 `llm_output` 拿到了 per-call usage。
2. Module B 若继续依赖 `before_agent_start`，文档中必须明确其 legacy 身份。
3. 如果未来要围绕写盘边界采集 assistant message，应优先研究 `before_message_write`，不要把 `onSessionTranscriptUpdate` 写成等价替代品。
4. 测试和文档都应统一采用 `after_tool_call` 的真实字段名：`params`、`result`、`error`。
