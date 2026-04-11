# OpenClaw Assistant Conclusion Pollution Prototype Review

> [!IMPORTANT]
> Current Status: PASS
> 本文记录 `Phase 2` 第一批原型文档的准入复核结论。

## 结论

当前 `Phase 2` 原型文档体系可以定为：

- 问题定义：清楚
- 架构入口：与代码事实一致
- 原型边界：收得足够小
- 风险状态：可控

这意味着：

- 可以进入最小代码原型
- 但仍不应把 `Phase 2` 视为已定稿的完整实施方案

## 本轮通过点

### 1. 原型边界已收紧

第一批原型只覆盖：

- 插件安装/启用状态
- 配置项是否存在

没有扩大到：

- 普通文件读取
- 广义路径存在性
- 通用 repo 搜索

### 2. Fresh Evidence 定义已结构化

当前文档已明确：

- 只认结构化 `toolResult`
- 只认 `__openclaw.transient = true`
- 只认匹配的 `diagnosticType`
- 只认 `1 hour` 内、最近 `50` 条历史消息窗口内的证据

因此第一版原型不再依赖 assistant 文本关键词匹配。

### 3. Prompt 注入入口已与代码对齐

当前代码链已确认：

- `resolvePromptBuildHookResult(...)`
- `composeSystemPromptWithHookContext(...)`

能够承接：

- `prependSystemContext`
- `appendSystemContext`

并且 `prependSystemContext` 会位于最终 system prompt 前部。

## 当前保留的实现前确认项

当前仍需在编码前保持显式确认的点：

1. 注入优先级
   - 需在真实 prompt 快照里确认 `prependSystemContext` 确实位于最前部

2. 多模型遵循度
   - 至少人工验证 Claude 与 OpenAI 两类模型的 gate 服从度

3. 参数冻结
   - 第一批继续固定：
     - 最近 `50` 条历史消息
     - `1 hour` freshness 阈值

## 当前建议

当前最合理顺序是：

1. 以 `IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_2026-04-04.md` 为第一批原型执行边界
2. 保持 `ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md` 作为问题定义与算法来源
3. 保持 `IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md` 为完整实施方向，但不把它误当成当前 Sprint 的直接 coding spec

## 相关文档

- [ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md](ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md)
- [IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md](IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md)
- [IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_2026-04-04.md](IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_2026-04-04.md)
- [ANALYSIS_OPENCLAW_CONTEXT_POLLUTION_ROADMAP_2026-04-04.md](ANALYSIS_OPENCLAW_CONTEXT_POLLUTION_ROADMAP_2026-04-04.md)
