# OpenClaw Assistant Conclusion Pollution Prototype Plan

> [!IMPORTANT]
> Current Status: Prototype Implemented and Current Scope Validated
> 本文不是 Phase 2 的正式实施稿，而是第一批最小代码原型的执行边界与当前范围的已验证基线。

## 目标

为 `assistant conclusion pollution` 的第二阶段准备一个最小可验证原型，目标只有一件事：

- 证明在现有 OpenClaw 架构中，能否通过 hook + system prompt 注入，
  让模型在高风险环境问题上优先做 fresh check，而不是直接复用旧 assistant 结论。

本原型不追求彻底解决 assistant 污染，只验证“最小 freshness gate”是否可行。

当前范围内，这个目标已经完成：

- `missing` 场景下会先 fresh check 再回答
- `not_high_risk` 场景不会误触发 gate
- 同 session 的中性追问，已经可以基于最近 fresh 证据跳过重复检查

## 开关要求

当前原型已证明机制可行，但后续若继续实现到 OpenClaw 上游，必须带显式开关且默认关闭。

原因：

1. 它会改变高风险问题上的默认工具调用行为
2. 它会改变当前轮的 prompt 注入
3. 当前仍处于原型验证与扩展阶段，不适合默认影响所有会话

因此后续代码实现必须满足：

- feature flag 存在
- 默认 `off`
- 仅在实验、验证或受控 rollout 中开启

## 第一批原型范围

### 只做

1. 单一机制：
   - `before_prompt_build` / `before_agent_start`
   - `prependSystemContext`
2. 单一算法：
   - 高风险问题识别
   - 最近 `50` 条历史消息扫描
   - `diagnosticType` 匹配
   - `1 hour` freshness 阈值
3. 单一行为目标：
   - 对高风险环境问题，要求模型本轮必须先核验

### 不做

1. assistant 结论结构化打标
2. compaction 路径支持
3. replay 层 assistant 文本降权
4. 泛化到所有环境问题
5. 模型外部静默执行工具

## 第一批高风险问题集合

原型只覆盖以下 2 类问题：

1. 当前插件状态问题
2. 当前配置项是否存在

对应原因：

- 与已验证的 `diagnosticType` 体系耦合最紧
- 最容易复现旧结论污染
- 最适合先验证 freshness gate 的有效性

当前暂不纳入：

- 普通文件读取问题
- 一般路径存在性问题
- 广义版本/状态问题

这里还需要额外说明：

- “当前插件状态问题” 不能继续作为单一粗粒度类别使用
- 它在真实对话里至少会分裂成以下 4 种语义：
  1. `plugin_enabled_state`
     - 是否在 `plugins.entries` 中启用
  2. `plugin_install_registry_state`
     - 是否在 `plugins.installs` 中登记
  3. `plugin_external_extension_state`
     - 是否作为外部扩展存在于 `extensions/` 目录
  4. `plugin_builtin_state`
     - 是否属于 OpenClaw 内置插件

第一批原型继续只验证 freshness gate 的可行性，但从现在开始：

- 验证与后续实现都必须按这些子类来设计问题
- 不再使用单一的 `plugin_install_state` 粗粒度覆盖所有插件问题

否则 gate 即使触发正确，模型仍可能沿着错误语义分支去查证。

这里必须明确：

- 原型按“问题语义”收边界
- 不按“工具名字”收边界

因此：

- `openclaw plugins list`
- `openclaw config get`
- `cat/read/grep/rg/jq` 针对 `openclaw.json` 的解析

如果都是在回答：

- 当前安装状态
- 当前配置项是否存在

它们都属于第一批原型候选来源。

相反：

- `cat /tmp/foo.txt`
- `rg hello README.md`

这类不在回答当前环境状态的问题，不属于第一批原型。

## Fresh Evidence 判定

### 输入

- 当前用户 prompt
- 最近 `50` 条历史消息

### 仅视为 fresh 证据的消息

必须同时满足：

1. `role = toolResult`
2. 带 `__openclaw.transient = true`
3. 带目标 `diagnosticType`
4. `__openclaw.replayOmitted !== true`
5. `now - timestamp <= 1 hour`

### 当前原型支持的映射

- `plugin_enabled_state`
  - `openclaw.plugins_list`
- `plugin_install_registry_state`
  - `openclaw.config_snapshot`
- 配置项是否存在
  - `openclaw.config_snapshot`

这些映射的来源可以是：

1. `openclaw` CLI 状态命令
2. `cat/read/grep/rg/jq/find/ls` 对环境文件或插件目录的读取结果
3. `gateway config.get ...` 这类网关配置读取结果

### `openclaw ...` 命令接入原则

当前补充一条明确约束：

- 凡是 `openclaw ...` 开头
- 且语义上属于“当前环境状态查询”

的命令，都应接入结构化打标体系，而不是只覆盖其中个别子命令。

这意味着后续不应只修：

- `openclaw plugins list`
- `openclaw config get`

而应把同类 `openclaw` 状态查询统一纳入：

- `__openclaw.transient`
- `diagnosticType`

的产生链。

这里的判断标准不是命令名本身，而是它是否在回答以下问题：

- 当前启用了什么
- 当前安装了什么
- 当前配置是什么
- 当前状态如何

如果属于这类环境状态查询，就应接入 Phase 1 的结构化证据体系。

### 当前范围内已关闭的关键缺口

本轮原型验证最终收敛出的关键问题是：

- `plugin_enabled_state` 在 `missing` 场景下可以正常触发 gate 并完成 fresh check
- 但同一 session 下再次追问 `plugins.entries` 启用状态时，最初仍然重新注入了 gate

当前代码事实已经进一步确认：

- `resolveAssistantConclusionFreshnessGate(...)` 只会把带有
  - `__openclaw.transient = true`
  - `diagnosticType`
  的 `toolResult` 视为可复用 fresh 证据
- 这些字段来自 `tool-result-replay-metadata.ts`
- 当前原型后来补齐了两层能力：
  1. `gateway config.get ...` 的 `diagnosticType` 接线：
  - `plugins.entries` -> `openclaw.plugins_list`
  - `plugins.installs / plugins.allow / 其他 config.get` -> `openclaw.config_snapshot`
  2. 对未显式打标的历史 `toolResult`，通过关联上一条 `toolCall` 参数做 fallback 推断

因此：

- `gateway config.get plugins.entries`
- `gateway config.get plugins.installs`

现在在源码层面已经可以被判定为结构化 fresh 证据候选，且最近同 session 的中性追问已能稳定命中 `fresh`。

这里需要明确两点：

1. 这条能力的当前范围已经成立：
   - `plugin_enabled_state`
   - `plugin_install_registry_state`
   - 配置项存在性
2. 当前 remaining 不再是 blocker，而是未来扩展项：
   - 更多 `openclaw ...` 环境状态命令族
   - `stale` / 冲突 / 多模型验证
   - 更广义的 assistant 结论治理

### 当前范围的最新实现结论

同 session 的 `fresh` 复用优化，现在通过以下链路闭环：

1. 当前轮环境状态查询先产生 fresh 证据
2. 下一轮 gate 扫描最近历史消息
3. 优先使用显式 `__openclaw` 结构化 metadata
4. 若历史 `toolResult` 未显式带 metadata，则通过关联上一条 `toolCall` 参数做 fallback 推断
5. 命中 `fresh` 时，不再注入 `prependSystemContext`
6. 模型直接基于最近 fresh 证据回答，不再重复查询

当前范围内，已验证通过的最小优化结果是：

- `plugin_install_registry_state` 的中性追问不再新增工具调用
- `plugin_enabled_state` 的中性追问不再新增工具调用

因此当前原型状态应更新为：

- correctness 已验证
- 当前范围的 fresh 复用优化已验证
- 剩余工作属于后续扩展，而不是当前 blocker

### 扩展原则

从当前原型继续往后做时，仍需保持这条原则：

不要再以“先碰到哪个命令就单独补哪个”这种方式零碎扩展。

因此后续原型收口必须明确：

1. `openclaw ...` 开头、且语义上回答当前环境状态的命令，应统一接入结构化打标体系
2. 第一版已经证明 `gateway config.get ...` 这条家族可行
3. 后续应继续扩到其他 `openclaw` 环境状态命令族，而不是保持零散例外

当前这条原则已经收敛为明确约束：

- 只要命令以 `openclaw` 开头，且结果语义属于“当前环境状态查询”，就应接入统一的结构化打标体系。
- 第一版不再接受“只补某个单独命令”的零散接线方式。
- `gateway config.get ...` 只是当前最先暴露缺口的一类入口，不是最终边界。
- 后续实现应按“`openclaw` 环境状态命令族”设计接入策略，而不是继续按单条命令打补丁。
- 在补齐打标之后，还必须再次验证：
  - gate 注入后模型是否真的会 fresh check
  - 不能把“已注入 gate”直接等同于“行为上已完成 fresh check”

### 第一批固定映射表

| 问题类型 | 典型问法 | 首选 `diagnosticType` | 典型来源 |
|---|---|---|---|
| `plugin_enabled_state` | “当前启用了哪些插件”“`qqbot` 在 `plugins.entries` 里启用了吗” | `openclaw.plugins_list` | `openclaw plugins list` / `gateway config.get plugins.entries` |
| `plugin_install_registry_state` | “`openclaw-qqbot` 在 `plugins.installs` 里登记了吗” | `openclaw.config_snapshot` | `openclaw config get` / `gateway config.get plugins.installs` |
| 配置项是否存在 | “配置里有没有某项”“当前配置值是什么” | `openclaw.config_snapshot` | `openclaw config get` / `cat|read|rg|jq openclaw.json` |

补充约束：

- 这里的“典型来源”只是第一批原型的主路径，不代表结构化打标只应覆盖这些单独命令。
- 凡是以 `openclaw` 开头、并且回答当前环境状态的命令，都应映射到对应 `diagnosticType` 体系。
- 若同一问题类型存在多个 `openclaw` 子命令入口，应优先统一到同一 `diagnosticType`，而不是为每条命令分裂出平行语义。

第一批明确不支持：

- 一条问题同时映射多个 `diagnosticType`
- 无结构化证据时对 assistant 文本做开放式正则推断

## 当前范围已验证通过

### 已通过

1. `plugin_enabled_state`
   - `missing`
   - 同 session 中性 `fresh` 复用
2. `plugin_install_registry_state`
   - `missing`
   - 精确问法
   - 同 session 中性 `fresh` 复用
3. 配置项存在性
   - `missing`
4. `not_high_risk`
   - 普通文件读取不误触发

### 当前不再视为 blocker

- `gateway config.get ...` 未接线
- 同 session `fresh` 命中失败
- “gate 已注入但模型仍直接复用上一轮结果” 作为当前范围通用问题

这些问题在当前范围内已经收敛并解决。

## 当前范围之外的后续扩展

后续若继续推进，应视为新一轮扩展，而不是当前原型未完成：

1. 扩展更多 `openclaw ...` 环境状态命令族
2. 增补 `stale` 场景验证
3. 增补旧 assistant 结论冲突场景
4. 多模型遵循度回归
5. 更广义的 assistant 结论治理
- 基于旧 assistant 结论反推问题类型

### 判定结果

- 若命中高风险问题：
  - 注入 freshness gate
- `freshnessState`
  - 当前继续保留用于日志与后续优化
  - 但第一版不再用它决定“是否跳过本轮核验”

## Prompt 注入策略

第一批只允许使用一段非常短的 `prependSystemContext`。

目标信息只保留：

1. 当前问题属于高风险环境问题
2. 本轮必须先调用相应工具核验
3. 不得仅依据历史 assistant 结论回答
4. 即使历史里已有类似结果，也不能直接复用

### 示例形态

```text
Freshness check required for this question. Before answering, use the appropriate tool to verify the current environment state. Do not answer from prior assistant conclusions alone.
```

### 候选模板

#### Template A

```text
Freshness check required for this question. Before answering, use the appropriate tool to verify the current environment state. Do not answer from prior assistant conclusions alone.
```

#### Template B

```text
This is a current-environment question. If you do not already have fresh evidence in this turn, you must check first and only then answer.
```

### 第一批选择原则

第一批原型只允许启用一个模板，避免把效果差异和算法问题混在一起。

当前推荐：

- Template A

原因：

- 约束更直接
- 更容易在日志和 prompt 快照中识别
- 更适合作为第一版的“硬提示”

这里的关键不是提示词工程，而是：

- 约束要短
- 约束要硬
- 不与普通任务说明混在一起

## 建议接入点

第一批原型只允许动以下位置：

1. `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.prompt-helpers.ts`
   - 扩展 `resolvePromptBuildHookResult(...)` 的上游输入约束
2. `projects-ref/openclaw/src/plugins/hooks.ts`
   - hook 结果拼装
3. `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
   - 最终 system prompt 合并链观察点

如果需要新增逻辑，优先新建一个小型辅助模块，不要把识别算法直接散写进 `attempt.ts`。

## 实现前确认清单

在进入第一批代码原型前，至少先确认以下事项：

1. `prependSystemContext` 的最终位置
   - 当前代码链显示：
     - `resolvePromptBuildHookResult(...)` 会收拢 hook 输出
     - `composeSystemPromptWithHookContext(...)` 会按
       `prependSystemContext + baseSystemPrompt + appendSystemContext`
       组合最终 system prompt
   - 因此第一批原型应先验证：
     - 注入内容确实位于最终 system prompt 最前部
     - 不会被后续 system prompt 合并逻辑吞掉

2. 模型遵循度
   - 第一批至少人工验证两类模型：
     - Claude 系列
     - OpenAI 系列
   - 目标不是比较模型优劣，而是确认：
     - gate 注入后，模型是否稳定先查后答

3. Freshness 参数是否维持最小固定值
   - 第一批继续固定：
     - 最近 `50` 条历史消息
     - `1 hour` freshness 阈值
   - 原型阶段不要同时调多个参数，否则很难判断失败原因

4. 问题边界不扩大
   - 第一批仍只允许：
     - `plugin_enabled_state`
     - `plugin_install_registry_state`
     - 配置项存在性
   - 不要在原型阶段扩到普通文件读取、广义路径状态或通用 repo 搜索

## 观测点与日志

第一批原型必须带最小观测点，否则无法证明 gate 是否真的生效。

### 观测点 1：问题识别

至少记录：

- 是否命中高风险问题
- 命中的问题类型
- 映射出的 `diagnosticType`

### 观测点 2：Fresh 证据扫描

至少记录：

- 扫描窗口大小
- 是否命中同类 `toolResult`
- freshness 判定结果：
  - `fresh`
  - `stale`
  - `missing`

### 观测点 3：Gate 注入

至少记录：

- 是否注入 `prependSystemContext`
- 使用的模板编号
- 当前 provider / model

### 观测点 4：行为结果

至少验证：

- 注入后模型是否先发起工具调用
- 若未发起，最终回答是否仍直接复述旧 assistant 结论

### 最小日志字段

建议统一保留以下字段：

- `phase=assistant-freshness-gate`
- `questionType`
- `diagnosticType`
- `freshnessState`
- `gateInjected=true|false`
- `templateId`

## 原型验证标准

第一批原型至少要通过以下验证：

1. 高风险问题时
   - 最终 prompt 中确实包含 freshness gate
2. 低风险问题
   - 不注入 gate
3. 注入 gate 后
   - 模型本轮会优先发起对应工具调用
4. 注入 gate 不会破坏原有 system prompt 结构
5. 日志中可以明确区分：
   - 未命中高风险问题
   - 命中高风险问题
   - 当前 `freshnessState`

## 失败判据

出现以下任一情况，就说明第一批原型未通过：

1. gate 注入后，模型仍频繁直接复述旧 assistant 结论
2. 高风险问题误伤明显，导致不可接受的大量额外工具调用
3. prompt 注入被现有 system prompt / skills 明显稀释
4. 实现必须引入新的控制层才能生效

## 通过后的下一步

如果原型通过，再继续考虑：

1. 扩展更多高风险问题类型
2. assistant 结论结构化标记
3. replay / compaction 侧的更完整治理

如果原型不通过，则应回退到：

- 保持 Phase 2 为研究阶段
- 重新评估是否需要 assistant-level 元数据模型，而不是继续增强 prompt 注入

## 相关文档

- [ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md](ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md)
- [IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md](IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md)
- [ANALYSIS_OPENCLAW_CONTEXT_POLLUTION_ROADMAP_2026-04-04.md](ANALYSIS_OPENCLAW_CONTEXT_POLLUTION_ROADMAP_2026-04-04.md)
