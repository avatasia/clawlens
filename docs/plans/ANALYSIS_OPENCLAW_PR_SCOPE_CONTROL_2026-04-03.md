# OpenClaw PR Scope Control

本文件记录当前建议的 PR 范围控制原则。

目的不是讨论“问题是否存在”，而是回答：

- 为什么第一版 PR 应只做最小修复
- 为什么不建议一开始就扩到 compaction
- 为什么不建议一开始就支持过多类型

## 当前建议

第一版 PR 建议只做：

- replay 路径
- 少量明确的诊断型 / 环境型 `toolResult`
- `Tag & Expire`
- 摘要化替换

不建议第一版同时做：

- compaction 扩展
- 大量额外类型支持

## 为什么 replay-only 更稳

当前问题已经有较强证据表明，污染发生在：

- session history replay
- 旧 `toolResult` 再次进入模型上下文

因此第一版只改 replay 路径，就已经足够对当前问题形成直接修复。

这样做的优点是：

1. 改动面小
2. 影响边界清楚
3. 更容易验证
4. 更容易被上游接受

## 为什么不建议第一版扩到 compaction

compaction 不是简单的“另一条 replay”。

它涉及：

- 历史压缩
- compact 后上下文重建
- 与普通 replay 不完全相同的输入链路

如果第一版把 compaction 一起改掉，会出现这些问题：

1. 无法快速判断问题是 replay 修复还是 compaction 副作用
2. 验证面陡增
3. 维护者需要同时审两条复杂链路
4. PR 更像“历史上下文治理重构”，而不是针对性修 bug

所以当前建议是：

- 第一版先只改 replay
- compaction 扩展留到后续 PR

## 为什么不建议第一版支持过多类型

首批建议仅覆盖少量明确高风险类型，例如：

- `plugins-list`
- `config-snapshot`
- `plugin-path-probe`
- `install-diagnostic`

原因是这些类型共同具备：

- 强环境依赖
- 明显易过期
- 对当前问题有直接证据支持

如果第一版进一步泛化到更多类型，例如：

- 一般 `exec`
- 更宽泛的 `read`
- 普通任务结果

风险会迅速上升：

1. 误伤当前任务仍需依赖的结果
2. 规则边界更难解释
3. 回归验证更难收敛
4. 审查者更难判断该 PR 是否安全

## 当前推荐的第一版 PR 范围

### 保留

- 源头打标
- replay 侧失效
- 少量诊断型类型
- 摘要化替换
- 明确回退策略

### 暂缓

- compaction 路径同步处理
- 更多诊断类型
- 普遍化 toolResult 治理
- 更复杂的语义推断

## 一句话总结

第一版 PR 应该表现为：

- 一个针对 `stale diagnostic toolResult replay pollution` 的最小修复

而不是：

- 一次对 OpenClaw 历史上下文治理体系的大规模重构

## 相关信息来源

- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](../archive/analysis/ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](../archive/analysis/IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_PR_WORKFLOW_2026-04-03.md](IMPLEMENTATION_OPENCLAW_PR_WORKFLOW_2026-04-03.md)
