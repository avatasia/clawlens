# Chat Audit Detail Capture Fix

## 问题

在 `agent:main:main` 的 web chat 场景中，右侧 Audit 面板出现了这类异常：

- `current-message-run` 已能正确命中当前消息对应的 `runId`
- `conversation_turns` 也能正常写入
- 但同一条 run 的 `llm_calls`、`tool_executions`、`provider/model`、`timeline` 长期为空

表现为：

- run 卡片只显示 transcript turn
- `summary.llmCalls = 0`
- `summary.toolCalls = 0`
- `model/provider = null`

## 排查结论

本轮排查确认：

1. OpenClaw 上游 **确实发出了** `llm_output` 和 `after_tool_call`
2. ClawLens **确实收到了** 这些 hook 事件
3. 问题不在 run 绑定，也不在 API 查询
4. 问题出在 ClawLens 自己的后置写库路径

关键证据：

- `collector` 日志能看到：
  - `llm_output`
  - `after_tool_call`
  - 正确的 `runId`
- 旧实现里：
  - `llm_output:enqueue` 出现
  - `llm_output:flush` 不出现
- `completeRun:aggregate` 聚合结果持续为：
  - `llmCount = 0`
  - `toolCalls = 0`

因此可以确认：

- 不是 OpenClaw 没发 hook
- 而是 ClawLens 旧实现依赖 `enqueue -> flush` 的异步写队列时，后置闭包存在执行缺口

## 根因判断

旧实现中：

- `recordLlmOutput()` 通过 `enqueue(() => store.insertLlmCall(...))` 写库
- `recordToolCall()` 通过 `enqueue(() => store.insertToolExecution(...))` 写库

这两类事件都属于 run 后段或结束附近的事件。实测中它们会在：

- `lifecycle:end`
- `agent_end`

附近到达。此时异步写队列存在竞态，导致：

- hook 事件已收到
- 但闭包未实际执行
- 最终 `completeRun()` 聚合不到任何明细

## 修复

本轮将以下两条路径改为**同步写库**：

- `Collector.recordLlmOutput()`
- `Collector.recordToolCall()`

保留同步 SSE 广播，但不再依赖延迟 flush。

## 验证结果

修复后远端实际验证通过：

- `current-message-run` 仍能正确命中当前消息
- 最新 run 已正常写出：
  - `llmCalls`
  - `toolCalls`
  - `provider/model`
  - `timeline`

验证样例：

- run `dc90382f-d189-4c18-acf8-26b6b3be0249`
- `summary.llmCalls = 1`
- `summary.toolCalls = 1`
- `provider = minimax`
- `model = MiniMax-M2.7`

## 调试日志沉淀

本轮使用的临时日志已沉淀为开关式方案，默认关闭：

- 配置开关：`collector.debugLogs`
- 环境变量：`CLAWLENS_DEBUG=1`

说明文档：

- [CHAT_AUDIT_DEBUG_LOG_SWITCH_2026-04-02.md](../../CHAT_AUDIT_DEBUG_LOG_SWITCH_2026-04-02.md)

## 结论

这次问题的主因更偏向 ClawLens 自身实现，而不是 OpenClaw 上游缺 hook。

更准确地说：

- OpenClaw 的 hook 时序可能放大了问题
- 但直接根因是 ClawLens 对后置明细写库采用了不稳的异步队列路径
