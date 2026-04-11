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

这里的高风险判断不应建立在“工具名是不是 `openclaw`”之上，
而应建立在：

- 这个问题是否在查询**当前环境状态**

因此，第一版高风险来源至少包括两类：

1. `openclaw ...` CLI 状态查询
   - 例如：
     - `openclaw plugins list`
     - `openclaw status`
     - `openclaw config get`
2. 环境快照读取/解析命令
   - 例如：
     - `cat`
     - `read`
     - `grep`
     - `rg`
     - `jq`
     - `find`
     - `ls`

只要这些命令的结果被用来回答：

- 现在装了什么
- 现在配置是什么
- 现在路径/文件是否存在
- 现在状态如何

它们都属于同一类高风险环境诊断源。

这类问题的原则应是：

- 如果当前轮没有 fresh tool result
- 则先重新核验
- 再回答

当前最可行的第一版，不是让系统在模型外部替它执行工具，
而是：

- 在当前轮开始前识别高风险问题
- 通过现有 hook / prompt override，把“本轮必须先核验”的约束注入系统提示
- 由模型在本轮正常发起 tool call
- 再基于 fresh 结果回答

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

按当前代码，最值得继续设计的真实入口是：

1. `before_prompt_build`
2. `before_agent_start`
3. `resolvePromptBuildHookResult(...)`
4. `composeSystemPromptWithHookContext(...)`

也就是：

- 先在 hook 侧识别高风险问题
- 再通过 `prependSystemContext` / `appendSystemContext` 注入 freshness 约束
- 让本轮模型自己走工具调用链

这条路线的意义是：

- 不引入新控制层
- 不需要系统外“静默执行工具”
- 与当前流式 agent 架构一致

### 方向 4：区分“稳定事实”和“环境诊断结论”

当前污染问题的根源之一是：

- 模型把一次环境诊断的临时结论，当成长期知识保存

所以后续系统设计需要把两类信息区分：

- 稳定事实
- 临时诊断结论

否则所有 assistant 消息都会被同等 replay，污染风险会一直存在。

## 第一版最小判定模型

当前建议把 `Phase 2` 的算法收敛成一个非常小的判定模型，只回答两个问题：

1. 当前用户问题是否属于高风险环境问题
2. 当前上下文里是否已经有足够新的结构化证据

### 1. 高风险问题类型最小集合

第一版只保留以下 4 类：

1. 插件安装/启用状态
2. 配置项当前是否存在
3. 文件/路径当前是否存在
4. 当前版本号 / 当前运行状态

这 4 类之外的问题，第一版默认不触发 freshness gate。

### 2. 问题类型到 `diagnosticType` 的映射

`Phase 1` 已经为部分高风险工具结果注入了结构化标记。

第一版 `Phase 2` 应优先复用这些标记，而不是退回 assistant 文本正则匹配。

建议的最小映射：

- “当前安装了什么插件 / 有没有装某插件”
  - `openclaw.plugins_list`
- “当前配置里有没有某项 / 当前配置值是什么”
  - `openclaw.config_snapshot`
- “当前插件路径是否存在 / 某 package.json 是否存在”
  - `openclaw.plugin_path_probe`
- “当前 OpenClaw 状态 / 当前版本 / 当前运行状态”
  - `openclaw.status`

这里的映射来源可以是：

- `openclaw` CLI 结果
- 也可以是 `cat/read/grep/rg/jq/find/ls` 对环境文件的读取和解析结果

关键不在命令名字，而在结果语义。

### 3. Fresh 证据的最小定义

第一版不把 assistant 文本视为 fresh 证据。

只有以下内容才算 fresh 证据：

1. 当前历史消息中存在带 `diagnosticType` 的 `toolResult`
2. 该结果：
   - 未被 replay omitted
   - 距当前时间未超过阈值
3. 且该结果与当前问题类型匹配

当前建议阈值与 `Phase 1` 保持一致：

- `1 hour`

### 4. 缺少 fresh 证据的判定顺序

第一版建议按以下顺序判断：

1. 当前问题是否命中高风险问题类型
   - 否：直接放行
2. 遍历最近 `N` 条历史消息
   - 只检查：
     - `role = toolResult`
     - 且带 `__openclaw.transient = true`
     - 且带目标 `diagnosticType`
3. 若找到未过期、未 omitted 的同类结果
   - 视为已有 fresh 证据
4. 若没有找到
   - 视为 freshness 不足

第一版建议的最小窗口：

- 最近 `50` 条历史消息

### 5. 当前不作为 fresh 证据的内容

第一版明确不把以下内容当 fresh 证据：

- 普通 assistant 文本结论
- 没有 `diagnosticType` 的工具输出
- 已被 replay omitted 的旧诊断结果
- 超过时间阈值的旧诊断结果

这样做的目的很明确：

- Phase 2 先建立在 Phase 1 的结构化元数据之上
- 不重新发明一套 assistant 文本理解器

## 当前不建议直接做的事

1. 不建议直接删除历史 assistant 消息
2. 不建议靠“在 system prompt 里提醒模型小心旧信息”来解决
3. 不建议在没有分类边界的情况下，泛化处理所有 assistant 文本

## 建议实施顺序

1. 先定义“高风险问题类型”
2. 再定义这些问题的 fresh-check 触发条件与判定算法
3. 明确 Phase 2 当前最小入口：
   - `before_prompt_build` / `before_agent_start`
   - `prependSystemContext` / `appendSystemContext`
4. 评估 system prompt 注入是否足以让模型稳定先查后答
5. 然后评估 assistant 结论是否需要结构化标记
6. 最后再决定是否需要 replay 层的 assistant 降权策略

## 当前定位

本文件是：

- 下一阶段问题定义与方案收敛入口

不是：

- 已定稿实施方案

## 相关信息来源

- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](./RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md](./RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_HISTORY_REPLAY_BEHAVIOR_2026-04-04.md](./RESEARCH_OPENCLAW_TOOL_RESULT_HISTORY_REPLAY_BEHAVIOR_2026-04-04.md)
- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
