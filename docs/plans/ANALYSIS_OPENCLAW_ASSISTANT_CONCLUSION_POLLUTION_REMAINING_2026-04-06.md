> [!IMPORTANT]
> Current Working Analysis: This is the active future-expansion analysis for the current Phase 2 prototype line.

# Phase 2 Future Expansion

本文用于收拢 OpenClaw `assistant conclusion pollution` 第二阶段原型在当前范围验证通过后，后续若继续扩展时仍需处理的问题。

它不是新的实施稿，也不是最终架构文档，而是当前 `Phase 2` 的后续扩展入口。

## 当前结论

`Phase 2` 当前范围原型已经证明以下能力成立：

- 高风险问题在 `missing` 场景下可以注入 freshness gate
- 普通文件读取这类 `not_high_risk` 场景不会被误触发
- `plugin_install_registry_state` 的精确问法可以先查后答
- 同 session 的高风险配置追问也能再次查证，不再直接复用旧 assistant 结论

因此当前第一阶段目标已经从“是否能止住错误结论复用”收敛为：

- correctness 已成立
- 当前范围内的 `fresh` 复用与重复查询优化也已成立
- 剩余项已从 blocker 下降为未来扩展

## 后续扩展项

### 1. 结构化打标在远端插件链里未稳定落盘

当前结构化 fresh 证据识别链依赖：

- `__openclaw.transient = true`
- `diagnosticType`

当前源码侧已经补齐：

- `gateway config.get plugins.entries`
- `gateway config.get plugins.installs`

对 `diagnosticType` 的接线。

但远端验证表明，真正还没稳定关闭的问题是：

- `tool_result_persist` hook 会参与重写最终落盘消息
- 如果 replay metadata 只在 hook 之前注入，远端 transcript 中仍然看不到
  - `__openclaw.transient`
  - `diagnosticType`

因此当前扩展点已从“命令族未接入”收敛为：

- 结构化打标在真实插件链下是否稳定落盘

同时，原则层仍保持不变：

- 所有 `openclaw ...` 开头、且语义上回答当前环境状态的命令
- 都应接入统一的结构化打标体系

### 2. 扩展范围外的 `fresh` / `stale` 语义仍未稳定覆盖

当前范围内的 `fresh` 复用已经成立，但更广范围内仍未覆盖：

- `stale` 命中场景
- 更复杂的跨类型冲突场景
- 更广义 `openclaw ...` 环境状态命令族

因此当前扩展项不再是：

- gate 是否完全失效

而是：

- 如何把当前能力推广到更多命令族和更多上下文冲突场景

### 3. 插件状态问题仍需保持子类拆分

当前验证已经证明，“插件状态”不能继续当成单一问题类型使用。

至少需要继续保持以下拆分：

- `plugin_enabled_state`
- `plugin_install_registry_state`
- `plugin_external_extension_state`
- `plugin_builtin_state`

否则验证问句和实现策略会继续在以下语义之间串线：

- 启用状态
- 安装登记状态
- 外部扩展存在性
- 内置插件身份
- 在线/运行状态

### 4. `stale` / 冲突 / 多模型场景仍未形成稳定通过样本

当前已确认：

- `missing`：通过
- `not_high_risk`：通过
- `plugin_install_registry_state` 精确问法：通过

但仍未稳定收敛的包括：

- `stale` 命中场景
- 旧 assistant 结论冲突场景
- 多模型遵循度回归

因此，当前原型已可视为“current-scope validated”，但仍不能视为“Phase 2 fully generalized”。

## 当前状态

当前 `Phase 2` 的后续项应明确写成扩展项，而不是 blocker：

1. 更多 `openclaw ...` 环境状态命令族的结构化打标与 `diagnosticType` 映射
2. `stale` / 冲突 / 多模型场景的继续验证

## 建议的下一步顺序

1. 先把当前范围验证结果沉淀为 Phase 2 最小原型的已验证基线
2. 再继续扩到：
   - 更多 `openclaw ...` 环境状态命令族
   - `stale`
   - 冲突场景
   - 多模型回归

## 相关信息来源

- [IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_2026-04-04.md](IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_2026-04-04.md)
- [REVIEW_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_VALIDATION_2026-04-05.md](REVIEW_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_VALIDATION_2026-04-05.md)
- [ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md](ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md)
- [ANALYSIS_OPENCLAW_CONTEXT_POLLUTION_ROADMAP_2026-04-04.md](ANALYSIS_OPENCLAW_CONTEXT_POLLUTION_ROADMAP_2026-04-04.md)
