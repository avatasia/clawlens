# OpenClaw Assistant Conclusion Pollution

本文件记录当前剩余问题：

- `toolResult replay` 污染已得到独立缓解方案
- 但模型上下文中的 **assistant 文本结论污染** 仍然存在

这里讨论的不是旧 `toolResult` 如何 replay，
而是：

- 模型已经说错的话
- 作为普通 assistant 消息进入 session history
- 后续轮次继续被模型当作“已有事实”引用

## 问题定义

当前已确认的现象是：

1. 某些错误最初可能来自：
   - 对工具输出的过度推断
   - 对环境状态的误读
2. 即使后续 replay 不再原样注入旧 `toolResult`
3. 早先那条错误 assistant 文本仍然可能留在 history 中
4. 模型后续轮次继续沿用这条错误结论

所以当前剩余问题已经从：

- stale diagnostic `toolResult` replay pollution

转移为：

- stale assistant conclusion pollution

## 与已解决问题的边界

已解决的问题：

- 旧的诊断型 `toolResult` 在后续 replay 中继续作为原文进入模型上下文

当前未解决的问题：

- 模型已经把错误结论写成 assistant 文本消息
- 这类消息不是 `toolResult`
- 之前的 replay 过滤不会处理它们

因此：

- `toolResult` 过滤方案仍然必要
- 但它不能单独解决 assistant 层污染

## 当前根因判断

当前更准确的根因是：

1. 某次环境诊断得到工具输出
2. 模型对该输出做了错误推断
3. 错误推断以 assistant 文本形式写入 history
4. 后续轮次没有强制 fresh check
5. 模型继续复用旧 assistant 结论

所以这不是单纯：

- replay 输入污染

而是：

- 诊断类 assistant 结论缺乏 freshness 约束

## 解决方向

### 方向 1：高风险问题强制 fresh check

对某些问题类型，不允许模型只根据历史 assistant 文本直接回答。

候选范围：

- 当前安装了什么插件
- 当前配置里是否存在某项
- 某文件现在是否存在
- 某路径当前指向什么
- 当前版本号 / 当前启用状态

这类问题的原则应是：

- 如果当前轮没有 fresh tool result
- 则先重新核验
- 再回答

### 方向 2：给诊断结论增加临时性标记

不是只给 `toolResult` 打标，
而是要考虑给“由环境诊断得出的 assistant 结论”也打上轻量标记，例如：

- 这是一次环境快照结论
- 不能默认长期沿用

后续 replay 时，可对这类结论：

- 降权
- 摘要化
- 或要求结合更新结果再使用

### 方向 3：在回答前做 freshness gate

对于高风险问题，增加一层判定：

- 当前上下文里是否只有旧 assistant 结论
- 是否缺少当前轮的 fresh 证据

如果缺少 fresh 证据，则：

- 先执行工具检查
- 不允许直接基于旧结论答复

这里需要明确一个当前架构约束：

- OpenClaw 现有单次流式 agent 循环中，并不存在独立的 planning / dispatch 控制层
- 因此“freshness gate”不能被理解为系统在模型外部静默执行工具
- 更现实的第一版方向只能是：
  - 通过现有 hook / system prompt override 注入约束
  - 显式要求模型本轮先做 fresh check
  - 而不是在执行流外部替模型完成工具调用

### 方向 4：区分“稳定事实”和“环境诊断结论”

当前污染问题的根源之一是：

- 模型把一次环境诊断的临时结论，当成长期知识保存

所以后续系统设计需要把两类信息区分：

- 稳定事实
- 临时诊断结论

否则所有 assistant 消息都会被同等 replay，污染风险会一直存在。

## 当前不建议直接做的事

1. 不建议直接删除历史 assistant 消息
2. 不建议靠“在 system prompt 里提醒模型小心旧信息”来解决
3. 不建议在没有分类边界的情况下，泛化处理所有 assistant 文本

## 建议实施顺序

1. 先定义“高风险问题类型”
2. 再定义这些问题的 fresh-check 触发条件与判定算法
3. 明确 Phase 2 可以挂载的现有代码入口
4. 然后评估 assistant 结论是否需要结构化标记
5. 最后再决定是否需要 replay 层的 assistant 降权策略

## 当前定位

本文件是：

- 下一阶段问题定义与方案收敛入口

不是：

- 已定稿实施方案

## 相关信息来源

- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](../research/RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md](../research/RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_HISTORY_REPLAY_BEHAVIOR_2026-04-04.md](../research/RESEARCH_OPENCLAW_TOOL_RESULT_HISTORY_REPLAY_BEHAVIOR_2026-04-04.md)
- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](../archive/analysis/ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
