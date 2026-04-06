> [!IMPORTANT]
> Current Working Plan: This is the active follow-up implementation plan for future Phase 2 expansion work.

# Phase 2 Expansion Next Steps

本文用于把 `assistant conclusion pollution` 第二阶段原型在当前范围验证通过后，后续若继续扩展时的下一步顺序收清。

它不替代当前的原型实施稿，而是只负责回答：

- 现在还差什么
- 应该先做哪一步
- 哪些事现在不要做

## 当前状态

当前已解决的能力：

1. `missing` 场景下，gate 可以被注入并先查后答
2. `not_high_risk` 场景不会误触发
3. `plugin_install_registry_state` 与 `plugin_enabled_state` 的同 session 中性追问，已能复用 recent fresh evidence

当前若继续推进，剩下的是扩展项：

1. `openclaw` 环境状态命令族未完整接入结构化打标
2. `stale` / 冲突 / 多模型验证仍未稳定收口

## 实施顺序

### Step 1. 扩展更多 `openclaw` 环境状态命令族的结构化打标

目标：

- 将当前已在 `gateway config.get ...` 上验证通过的结构化打标能力，扩到更多 `openclaw ...` 环境状态查询命令

完成判据：

- 新命令族能稳定产生：
  - `__openclaw.transient`
  - `diagnosticType`
- 同类问题在当前范围内可被 gate 识别为 `fresh`

### Step 2. 单独扩展 `stale` 命中验证

目标：

- 证明当前 gate 不只会处理 `missing`
- 还能在证据过期时重新要求 fresh check

完成判据：

- 超过阈值的旧证据会触发重新查证
- 不会错误复用过期结果

### Step 3. 单独扩展旧 assistant 结论冲突场景

目标：

- 证明当旧 assistant 文本与当前真实状态冲突时，模型仍会优先 fresh check

完成判据：

- 不直接复用旧 assistant 结论
- 回答以当前 fresh 工具结果为准

### Step 4. 最后做多模型回归

只有在 Step 1 - Step 3 收敛后，再继续：

- 多模型遵循度回归

## 当前不要做的事

现阶段不建议做：

- 扩到 compaction
- 扩到 assistant history 全量降权
- 扩到普通 `cat/read/rg/jq` 场景
- 重新发明 system 外控制层
- 把“当前范围已通过”误写成“Phase 2 已全部完成”

## 当前最小扩展前提

在进入下一轮扩展代码原型前，当前前提应固定为：

1. 当前范围正确性与 fresh 复用已通过，不再回退
2. 新一轮扩展只围绕更广命令族与更复杂场景，不重开当前已关闭问题

## 相关信息来源

- [ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_REMAINING_2026-04-06.md](ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_REMAINING_2026-04-06.md)
- [IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_2026-04-04.md](IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_2026-04-04.md)
- [REVIEW_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_VALIDATION_2026-04-05.md](REVIEW_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_VALIDATION_2026-04-05.md)
