# Analysis: Session History Replay Pollution Fix Proposal

> [!IMPORTANT]
> Current Authority: This is the proposed architectural fix for the session history pollution problem identified in [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](../archive/analysis/RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md).

## 1. 问题根源再确认

通过对 `projects-ref/openclaw` 源码的深入审计，确认以下事实：

1.  **存储持久化**：所有的 `toolResult`（工具执行结果）都会通过 `src/gateway/session-lifecycle-events.ts` 及其关联的 transcript 写入机制，以原始 JSON 形式持久化到 `.jsonl` 文件中。
2.  **回放机制**：在每次新的 Agent Run 开始前，`src/agents/pi-embedded-runner/run/attempt.ts` 会调用 `readSessionMessages` 读取全量历史。
3.  **清洗盲区**：`src/agents/pi-embedded-runner/google.ts` 中的 `sanitizeSessionHistory` 仅执行结构化清洗（处理图片、思考块、剥离 `details` 元数据），**完全忽略了对内容有效性的校验**。
4.  **污染后果**：诊断类工具（如 `openclaw plugins list`）产生的具有强时效性的文本输出，会被模型视为“当前的真相”，导致即便插件已卸载，模型仍会基于历史上下文复述旧状态。

## 2. 核心挑战

- **不能简单删除**：历史消息对（toolUse + toolResult）的完整性对某些 Provider 的回放协议是必须的。
- **不能自动识别**：完全靠语义识别某个 `toolResult` 是否过期（如文件内容变化）在清洗层计算成本极高且不准确。

## 3. 建议解决方案：标记与失效 (Tag & Expire) 机制

### 3.1 定义诊断类输出
在 `src/agents/bash-tools.exec.ts` 或 `pi-tools.ts` 中，为已知具有强时效性的命令建立索引：
- `openclaw plugins list`
- `openclaw status`
- `ls -R` (部分场景)
- `cat openclaw.json`

### 3.2 注入时效标记
当这些命令执行成功并返回 `toolResult` 时，在 `__openclaw` 元数据中注入标记：
```json
{
  "role": "toolResult",
  "content": "...",
  "__openclaw": {
    "kind": "diagnostic",
    "transient": true
  }
}
```

### 3.3 实施清洗策略
修改 `src/agents/pi-embedded-runner/google.ts` 中的 `sanitizeSessionHistory`：

1.  **识别标记**：检查 `toolResult` 是否带有 `transient: true`。
2.  **按序失效**：
    - **保守策略**：如果历史记录中存在多个同名的诊断型 `toolResult`，只保留最后一个，其余的 `content` 置为空字符串或占位符。
    - **激进策略**：在 Replay 阶段，直接将所有 `transient` 消息对的 `content` 替换为：`[Previous diagnostic output omitted for accuracy]`。

## 4. 解决方案优势

- **协议安全**：保留了消息对的结构，不会触发 Provider 的“Tool Result Orphaned”错误。
- **强制刷新**：迫使模型在需要最新状态时，再次调用相关工具（如再次执行 `plugins list`），从而获取真实当前的磁盘状态。
- **工程可控**：标记在工具执行端（源头）生成，清洗逻辑在 Replay 前统一执行，符合分层治理原则。

## 5. 结论

解决 Session 污染的关键在于**打破模型对历史诊断输出的盲目信任**。通过“标记-清洗”链路，可以确保 OpenClaw 在长周期会话中保持对运行环境感知的准确性。
