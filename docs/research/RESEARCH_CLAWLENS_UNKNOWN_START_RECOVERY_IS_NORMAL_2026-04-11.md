# ClawLens 分析记录：`unknown` 起步后回填是常态路径（非异常）

日期：2026-04-11

## 结论

对当前 OpenClaw + ClawLens 链路而言，`lifecycle:start` 阶段出现 `sessionKey="unknown"`，随后由 `transcript_update` 绑定到正确 session/run，属于**常态恢复路径**，不应默认判定为异常。

换言之：

- `unknown_start_recovered`：正常且可接受（常见于 channel 入站消息）
- `unknown_persisted`：才应视为异常（最终仍留在 `unknown` 会话桶，或 current-message-run 只能 fallback）

## 本次实证样本

### 样本 A（Discord）

- 用户消息：`睡了没?`
- runId：`27d4d94b-cac5-478a-b3e7-72e49eb89c1b`
- 事件序列：
  1. `lifecycle:start` -> `sessionKey="unknown"`
  2. `transcript_update` -> `sessionKey="agent:main:discord:direct:1113387681435623444"` 且 `resolvedRunId` 命中同一 run
  3. `current-message-run` 返回 `resolved/latest-user-turn/transcript_explicit`

结论：`unknown_start_recovered`

### 样本 B（Weixin）

- 用户消息：`今天星期几`
- runId：`a2b67192-7720-4a23-93b4-73c6268afce2`
- 事件序列：
  1. `lifecycle:start` -> `sessionKey="unknown"`
  2. `transcript_update` -> `sessionKey="agent:main:openclaw-weixin:direct:o9cq801nwgnbegka5xk4bzn7ifyq@im.wechat"` 且 `resolvedRunId` 命中同一 run
  3. `current-message-run` 返回 `resolved/latest-user-turn/transcript_explicit`

结论：`unknown_start_recovered`

## 对监控与 UI 的解释

如果当前 session 的 `current-message-run` 已是 `resolved`，前端不显示异常徽标是合理行为；即使该 run 起点曾经是 `unknown`。

因此，“是否异常”的判定应基于**最终状态**，而不是仅基于起点：

- 看 `current-message-run.status/lookupBasis/sourceKind`
- 看 run 是否最终进入目标 session，而非停留在 `unknown`

## 建议口径

后续分析和报表里，建议明确分开统计：

1. `unknown_start_recovered`（常态恢复）
2. `unknown_persisted`（需排查）

避免把所有 `unknown start` 误判为故障。

