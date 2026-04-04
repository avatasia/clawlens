# OpenClaw Context Pollution Roadmap

本文件汇总当前 OpenClaw “上下文污染”问题的阶段性治理路线。

目标不是替代各专项分析/实施稿，
而是回答三个问题：

1. 当前到底已经解决了什么
2. 现在还剩什么问题
3. 后续应该按什么顺序继续推进

## 总体结论

当前问题已经可以拆成三层：

1. `toolResult replay` 污染
2. assistant 结论污染
3. 更完整的上下文治理体系

其中：

- 第一层已完成并转入长期资产
- 第二层已有分析稿和待重设计实施稿
- 第三层仍属于后续增强，不建议现在一次性展开

## Phase 1：Tool Result Replay Pollution

### 问题

- 旧的诊断型 `toolResult`
- 在后续 replay 中继续作为历史消息进入模型上下文
- 导致模型在后续轮次继续引用过期的环境快照

### 当前状态

- 已完成方案收敛
- 已完成本地原型实现
- 已完成核心测试
- 已完成远端完整包安装验证
- 已导出 patch
- 已从 `plans` 转正为架构与历史资产

### 当前产物

- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](../archive/analysis/ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](../archive/analysis/IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [REVIEW_OPENCLAW_STALE_TOOL_RESULT_REPLAY_VALIDATION_2026-04-04.md](REVIEW_OPENCLAW_STALE_TOOL_RESULT_REPLAY_VALIDATION_2026-04-04.md)

### 当前判断

这一层已经从“研究问题”进入：

- 可验证
- 可复用
- 可提交 patch
- 可从当前待决区移出

## Phase 2：Assistant Conclusion Pollution

### 问题

- 错误结论已经被模型写成普通 assistant 文本
- 这些 assistant 消息进入 session history
- 即使后续 replay 不再原样注入旧 `toolResult`
- 模型仍可能继续沿用旧 assistant 结论

### 当前状态

- 问题边界已明确
- 已有分析稿
- 已有第一版实施思路
- 当前实施思路仍需按现有架构重设计
- 尚未进入代码实现

### 当前产物

- [ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md](ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md)
- [IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md](IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md)

### 第一版策略

第一版不直接清理所有 assistant 历史，
而是先尝试：

- high-risk question freshness gate

也就是：

1. 识别少量高风险问题类型
2. 判断当前轮是否缺少 fresh 证据
3. 若缺少，则通过现有入口显式要求本轮先做 fresh tool check，再回答

当前限制也必须明确：

- 这一层还没有找到像 Phase 1 那样直接、稳定的代码插入点
- 因此 Phase 2 目前仍属于“重设计中的实施方向”，不是可直接编码的最小 patch

## Phase 3：Broader Context Governance

### 问题

如果要进一步降低污染风险，最终还需要处理：

- 临时环境结论与稳定事实的区分
- assistant / toolResult 的统一 freshness 模型
- replay 与 compaction 的一致性治理

### 当前状态

- 尚未进入实施
- 当前不建议展开

### 为什么暂缓

因为这一层会把问题从：

- 一个可控的 agent/history correctness 修复

扩大成：

- 更广义的上下文治理工程

这会显著扩大：

- 改动面
- 误伤面
- 验证面

## 推荐推进顺序

当前推荐顺序非常明确：

1. 先完成 Phase 1 收口与上游 PR 准备
2. 再重设计 Phase 2 的最小 freshness gate
3. 只有在 Phase 2 的边界和收益稳定后，才考虑 Phase 3

## 当前最关键的边界

### 已解决

- 旧诊断型 `toolResult` 的 replay 污染

### 正在规划

- assistant 结论污染

### 暂不展开

- 全量上下文治理
- 普适 assistant 文本降权
- compaction 扩展

## 一句话总结

当前路线不是“一步彻底修完所有上下文污染”，
而是：

1. 先切掉旧 `toolResult`
2. 再约束旧 assistant 结论
3. 最后才考虑更完整的上下文治理体系

## 相关文档

- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](../archive/analysis/ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](../archive/analysis/IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md](ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md)
- [IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md](IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md)
