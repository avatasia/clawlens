# OpenClaw Assistant Conclusion Pollution Prototype Validation Cases

> [!IMPORTANT]
> Current Status: Current-Scope Validated
> 本文定义 `Phase 2` 第一批原型的最小验证用例，并记录已执行结果。

## 目标

验证两件事：

1. `Freshness Gate` 只在高风险环境问题上触发
2. 触发后模型会先做 fresh check，再回答，而不是复用旧 assistant 结论

## 当前验证范围

第一批只覆盖：

1. `plugin_enabled_state`
2. `plugin_install_registry_state`
3. 当前配置项是否存在

当前不覆盖：

- 普通文件读取
- 一般路径存在性
- 通用 repo 搜索
- 广义运行状态 / 版本信息

## 统一观测点

每条用例都应同时检查以下三层：

1. 用户侧回答
   - 是否先查后答
   - 是否复用了旧 assistant 结论

2. `llm-api` 日志
   - 是否出现新的工具调用
   - 是否属于预期的环境状态查询

3. OpenClaw 运行日志
   - 是否出现 freshness gate 日志
   - 是否能区分：
     - `not_high_risk`
     - `fresh`
     - `stale`
     - `missing`

## 已执行结果

### Result A：`plugin_enabled_state`，缺少 fresh 证据

- 会话：`phase2-proto-plugin-missing-20260405`
- 结果：通过

确认点：

1. `llm-api` 日志中存在 freshness gate 注入文本。
2. 模型没有直接复述历史 assistant 结论，而是先发起新的工具调用。
3. 当前实现里模型选择的是 `gateway config.get plugins.entries`，而不是 `openclaw plugins list`。

结论：

- `plugin_enabled_state` 的 `missing -> 注入 gate -> fresh check -> 再回答` 这条链已成立。
- 当前仍有一个实现观察点：
  - 插件状态问题目前走的是配置查询路径，结果正确，但查询粒度偏重，后续可考虑收窄到更轻的状态查询。

### Result B：配置项存在性 / `plugin_install_registry_state`，缺少 fresh 证据

- 会话：`phase2-proto-config-missing-20260405`
- 结果：通过

确认点：

1. session transcript 中可见用户问题后，模型先发起 `gateway config.get plugins.installs`。
2. 后续回答基于 fresh 查询结果给出 `plugins.installs` 下的当前键集合。
3. 没有直接沿用旧 assistant 对 `openclaw-qqbot` 的说法。

结论：

- `config_key_presence` 这一类问题的 freshness gate 已生效。
- 当前实现观察点：
  - `gateway config.get plugins.installs` 返回的结果仍然较大，后续若要继续优化，可考虑更小粒度的配置读取路径。

### Result C：普通文件读取，不应触发 gate

- 会话：`phase2-proto-not-high-risk-20260405`
- 结果：通过

确认点：

1. `llm-api` 记录中可见该会话请求，但未出现 freshness gate 注入文本。
2. session transcript 中模型直接调用 `read /tmp/phase2-gate-check.txt`。
3. 最终回答直接返回文件内容。

结论：

- 普通文件读取未被误判为高风险问题。
- `not_high_risk` 这一反例已通过。

### Result D：`plugin_install_registry_state`，精准问法正例

- 会话：`phase2-proto-install-registry-conflict-20260406`
- 结果：通过

确认点：

1. 在新 session 里直接提问：
   - `plugins.installs.openclaw-qqbot 现在还在吗？`
2. 模型先发起 `gateway config.get plugins.installs`
3. 最终回答基于当前 `plugins.installs` 实际内容给出“不在了”的结论

结论：

- `plugin_install_registry_state` 的精确问法是稳定的。
- 第一批原型里，这类问题比“插件还装着吗”这类自然语言问法更容易形成可重复验证样本。

### Result E：历史 `fresh` 识别最初失败样本

- 会话：`phase2-proto-plugin-missing-20260405`
- 结果：已定位并修复

验证问句：

- `qqbot 现在在 plugins.entries 里还是 enabled 吗？`

观察到的事实：

1. 该问题发生在同一 session 中，前面已经存在一次 `gateway config.get plugins.entries` 查询结果。
2. 但 `llm-api` 日志里仍然再次出现了 freshness gate 注入文本。
3. 随后模型重新查询并回答，而不是把上一轮结果识别为 fresh 证据直接使用。

最初判断：

- 这次失败最初暴露的是 `gateway` 结果未进入结构化 fresh 识别链
- 当前源码侧已补齐：
  - `gateway config.get plugins.entries` -> `openclaw.plugins_list`
  - `gateway config.get plugins.installs` -> `openclaw.config_snapshot`
- 但远端继续验证后确认，真正更深的根因是：
  - `tool_result_persist` hook 可能会重写 `toolResult`
  - 如果 replay metadata 只在 hook 之前注入，最终 transcript 中仍然看不到这些字段
- 因此当前源码又进一步修正为：
  - 在 `tool_result_persist` 之后再次补一遍 replay metadata
- 之后继续排查和修正后，这个样本已不再是当前 blocker。

### Result F：`plugin_install_registry_state`，同 session 中性 `fresh` 复用

- 会话：`phase2-proto-config-family-fixed18-20260406`
- 结果：通过

验证顺序：

1. 第一问：
   - `当前配置里有没有 plugins.installs.openclaw-qqbot 这一项？`
2. 中性追问：
   - `所以 plugins.installs 里有 openclaw-qqbot 吗？`

确认点：

1. 第一问先做 fresh check。
2. 第二问没有新增 `gateway` 或 `exec` 工具调用。
3. 模型直接基于最近 fresh 证据回答。

结论：

- `plugin_install_registry_state` 的同 session 中性追问，已能稳定复用 recent fresh evidence。
- 当前范围内，“重复查询优化”在这条子类上已成立。

### Result G：`plugin_enabled_state`，同 session 中性 `fresh` 复用

- 会话：`phase2-proto-plugin-missing-20260405`
- 结果：通过

验证顺序：

1. 会话中前面已经存在 `gateway config.get plugins.entries` 的 fresh 结果。
2. 中性追问：
   - `所以 qqbot 在 plugins.entries 里是 enabled 吗？`

确认点：

1. 追问后没有新增 `gateway` 或 `exec` 工具调用。
2. 模型直接依据最近 fresh 证据回答：
   - `plugins.entries.qqbot.enabled: true`

结论：

- `plugin_enabled_state` 的同 session 中性追问，也已能稳定复用 recent fresh evidence。
- 这说明 fallback toolCall 推断链在当前范围内已经闭环。

## 当前小结

截至目前，第一批原型已经完成 3 条关键验证：

1. 高风险正例：`plugin_enabled_state` -> 通过
2. 高风险正例：配置项存在性 / `plugin_install_registry_state` -> 通过
3. 非高风险反例：普通文件读取 -> 通过

另外：

4. `plugin_install_registry_state` 精确问法 -> 通过
5. `plugin_enabled_state` 的 `fresh` 命中 -> 仍待远端复核

当前未完成的仍包括：

- `plugin_enabled_state` 的稳定 `fresh` 命中
- `stale` 命中场景
- 旧 assistant 结论冲突场景
- 多模型遵循度回归

## 补充观察

### Observation 1：`plugin_enabled_state` 的查询路径仍偏重

当前 `plugin_enabled_state` 在原型里已能触发 gate，模型实际执行的是：

- `gateway config.get plugins.entries`

而不是更轻量的插件状态查询。

这不影响第一批原型“先查后答”的目标，但说明后续若要继续优化：

- 应考虑把 `plugin_enabled_state` 引导到更轻的状态查询路径
- 避免每次都读取较大的配置快照

同时，从 `fresh` 命中失败到后续代码复查的结果看：

- 当前查询路径本身没有问题
- 问题在于结构化 replay metadata 在远端真实插件链中没有稳定落盘
- 当前源码已补齐两层修正：
  - `gateway config.get ...` 的 `diagnosticType` 映射
  - `tool_result_persist` 之后再次补 metadata

所以接下来的验证重点，不再是“要不要让 `gateway` 接线”，而是：

- 远端 transcript 是否已经真正保留了 `__openclaw.transient / diagnosticType`
- 在此基础上 `fresh` 命中是否恢复

同时需要明确一条扩展原则：

- 不只是 `gateway config.get ...`
- 凡是 `openclaw ...` 开头、且语义上属于当前环境状态查询的命令

都应统一接入结构化打标体系。

当前这条原则应视为后续实现的固定约束，而不是可选优化：

- 第一批原型虽然只验证少量问题类型，但打标覆盖单位应提升到 `openclaw` 环境状态命令族。
- `gateway config.get ...` 只是当前最先暴露缺口的一类入口。
- 如果后续仍按“发现一条、补一条”的方式推进，`fresh` 命中会在别的 `openclaw ...` 状态命令上继续重复失败。

否则后续仍会不断出现：

- 当前轮能答对
- 下一轮 `fresh` 命中失败

的同类问题。

### Observation 2：`fresh` 命中场景需要精确到插件状态子类

在同一 session 中追加追问：

- `qqbot 现在还在吗？`

模型更容易把它理解成“运行状态 / 在线状态”，而不是 `plugin_enabled_state`。  
该问句不适合作为稳定 `fresh` 命中验证用例。

后续应改用更明确的问题，例如：

- `qqbot 插件现在还装着吗？`
- `qqbot 这个插件现在还启用着吗？`

也就是说：

- 当前原型的 `fresh` 场景还没有形成稳定通过样本
- 但问题主要在验证问句语义，而不是 gate 基座本身

### Observation 3：`插件现在还装着吗` 会引出“内置 vs 外装”语义分叉

后续改用更明确的插件问句：

- `qqbot 插件现在还装着吗？`

这条问句不再被模型理解成“在线状态”，但仍然触发了另一个语义分叉：

- 模型把问题理解成“这个插件是不是单独安装在 extensions 目录里”
- 随后去检查了 `~/.openclaw/extensions/`
- 最终回答成“`qqbot` 是内置插件，没单独装”

这说明：

1. 当前原型已经能避免直接复用旧 assistant 结论；
2. 但“插件安装状态”这个问题类型本身仍然存在语义歧义：
   - “是否在 `plugins.entries` 中启用”
   - “是否在 `plugins.installs` 中登记”
   - “是否作为外部扩展安装在 `extensions/` 中”
   - “是否为内置插件”

因此，后续原型验证和后续实现都应把该问题类型进一步细分，而不是继续用单一的粗粒度插件状态问题覆盖。

### 当前对 `fresh` 命中结论的修正

早期验证阶段，`fresh` 命中一度未形成稳定通过样本。

原因不是 gate 完全失效，而是当前问句容易被模型分流到不同语义：

- 运行状态
- 启用状态
- 内置 vs 外装
- 安装登记状态

当时更准确的结论是：

- `missing` 场景：`plugin_enabled_state` 与配置存在性已验证通过
- `not_high_risk` 场景：已验证通过
- `plugin_install_registry_state` 的精确问法：已验证通过
- `fresh` 场景：尚未稳定收敛，且已观察到明确失败样本

### Observation 4：`openclaw config get ...` 家族的早期失败样本

验证会话：

- `phase2-proto-openclaw-config-family-20260406`

执行顺序：

1. 第一问：
   - `当前配置里有没有 plugins.installs.openclaw-qqbot 这一项？`
2. 同一 session 第二问：
   - `openclaw config get plugins.installs 这一项里现在还有 openclaw-qqbot 吗？`

观察结果：

1. 第一问正常触发 gate，并通过 `gateway config.get plugins.installs` 拿到 fresh 结果后回答。
2. 第二问在 `llm-api` 日志中仍然出现了：
   - `Freshness check required for this question.`
3. 但 session transcript 显示第二问没有再次发起工具调用，而是直接复用了上一轮结果作答。

早期判断：

- 这说明这条链已经不只是“结构化 fresh 证据识别缺口”。
- 在当前实现下，还出现了第二类问题：
  - gate 已注入
  - 但模型未严格遵循“先 fresh check 再回答”
- 继续追查后，第一层缺口已经进一步收敛为：
  1. `tool_result_persist` 后 metadata 未稳定落盘
  2. 只有在 metadata 真正落盘后，才能继续判断 gate 文案是否仍然不足

当时的小结是：

- `missing` 场景：`plugin_enabled_state` 与配置存在性已验证通过
- `not_high_risk` 场景：已验证通过
- `plugin_install_registry_state` 的精确问法：已验证通过
- `fresh` 复用：尚未稳定收敛
- 当前实现目标已收敛为：
  - correctness 优先
  - `fresh` 复用作为后续优化

### Observation 5：同 session 高风险配置追问，correctness 已通过

验证会话：

- `phase2-proto-config-family-fixed18-20260406`

执行顺序：

1. 第一问：
   - `当前配置里有没有 plugins.installs.openclaw-qqbot 这一项？`
2. 同 session 追问：
   - `再确认一次：plugins.installs 里现在还有 openclaw-qqbot 吗？`

观察结果：

1. 后续追问后，session transcript 中 `gateway` 查询次数继续增加。
2. 这说明当前实现没有直接复用上一轮 assistant 结论，而是再次发起了环境状态查询。
3. 第二次回答仍然基于 fresh check 给出“不在”的结论。

结论：

- 当前 Phase 2 最小原型已经能在高风险配置问题上切断 assistant 历史污染。
- 同 session 高风险追问的 correctness 已验证通过。
- 当前剩余问题已从“是否会继续说错”下降为“是否能避免重复检查”。

## 当前最终结论

截至目前，第一批原型应按“当前范围已验证通过”理解：

1. `correctness validated`
   - 高风险配置 / 插件状态问题不会再直接复用旧 assistant 结论
   - `missing` 场景下会先 fresh check 再回答
2. `current-scope optimization validated`
   - 同 session 中性追问已能稳定复用 recent fresh evidence
   - 当前范围内不再反复重复查询

因此当前 `Phase 2` 应视为：

- 最小原型在当前范围内已通过
- 剩余项属于下一轮扩展，而不是当前 blocker

### Observation 6：同 session 高风险配置追问，`fresh` 复用已通过

验证会话：

- `phase2-proto-config-family-fixed18-20260406`

执行顺序：

1. 第一问：
   - `当前配置里有没有 plugins.installs.openclaw-qqbot 这一项？`
2. 中性追问：
   - `所以 plugins.installs 里有 openclaw-qqbot 吗？`

观察结果：

1. 第一问先完成 fresh check。
2. 中性追问后，没有新增 `gateway` 或 `exec` 工具调用。
3. 模型直接基于最近 fresh 证据回答。

结论：

- `plugin_install_registry_state` 的同 session `fresh` 复用，已在当前范围内验证通过。

### Observation 7：同 session `plugins.entries` 追问，`fresh` 复用已通过

验证会话：

- `phase2-proto-plugin-missing-20260405`

执行顺序：

1. 会话前面已经存在 `gateway config.get plugins.entries` 的 fresh 结果。
2. 中性追问：
   - `所以 qqbot 在 plugins.entries 里是 enabled 吗？`

观察结果：

1. 追问后没有新增 `gateway` 或 `exec` 工具调用。
2. 模型直接根据最近 fresh 结果回答 `enabled: true`。

结论：

- `plugin_enabled_state` 的同 session `fresh` 复用，也已在当前范围内验证通过。

## Case 1：`plugin_enabled_state`，缺少 fresh 证据

### 步骤

1. 在一个新 session 中直接提问：
   - `当前启用了哪些插件？`
2. 不提前执行任何相关工具查询

### 期望

- gate 触发
- freshness 状态为 `missing`
- 模型先调用插件状态查询工具
- 回答不直接引用历史 assistant 文本

## Case 2：`plugin_enabled_state`，已有 fresh 证据

### 步骤

1. 先让模型执行一次 `plugins.entries` / 启用状态查询
2. 在 `1 hour` 内再次提问：
   - `qqbot 现在在 plugins.entries 里还是 enabled 吗？`

### 期望

- gate 不触发
- freshness 状态为 `fresh`
- 模型可直接基于刚才这轮 fresh 结果回答
- 不应再次强制查证

## Case 3：`plugin_enabled_state`，旧证据已过期

### 步骤

1. 准备一条超过 `1 hour` 的 `openclaw.plugins_list` 旧证据
2. 再提问：
   - `当前启用了哪些插件？`

### 期望

- gate 触发
- freshness 状态为 `stale`
- 模型重新查证
- 不直接复用旧结果

## Case 4：`plugin_install_registry_state`，旧 assistant 结论与当前状态冲突

### 步骤

1. 先制造旧 assistant 结论：
   - `openclaw-qqbot 已在 plugins.installs 中登记`
2. 当前真实状态中移除该登记项
3. 再提问：
   - `plugins.installs.openclaw-qqbot 现在还在吗？`

### 期望

- 不直接复用旧 assistant 结论
- gate 触发并进行 fresh check
- 回答以当前工具结果为准

## Case 5：配置项存在性，缺少 fresh 证据

### 步骤

1. 在新 session 中直接提问：
   - `当前配置里有没有 plugins.installs.openclaw-qqbot 这一项？`

### 期望

- gate 触发
- freshness 状态为 `missing`
- 模型先读取或解析当前配置
- 不直接复述旧 assistant 说法

## Case 6：`plugin_install_registry_state`，值刚被修改

### 步骤

1. 先查询一次 `plugins.installs` 或目标登记项
2. 修改当前配置中的目标登记状态
3. 再次提出同一问题：
   - `plugins.installs.openclaw-qqbot 现在还在吗？`

### 期望

- 若旧证据已不足够 fresh，则重新查证
- 回答反映修改后的当前状态

## Case 7：非高风险普通文件读取

### 步骤

1. 提问：
   - `帮我看下 /tmp/test.txt 的内容`

### 期望

- gate 不触发
- freshness 状态为 `not_high_risk`
- 不应因为普通 `cat/read` 就注入环境 gate

## Case 8：普通 repo 搜索

### 步骤

1. 提问：
   - `帮我在仓库里搜一下 TODO`

### 期望

- gate 不触发
- 不应扩大到一般 `rg/grep` 搜索

## Case 9：fresh 证据来自配置读取，而不是 `openclaw` CLI

### 步骤

1. 通过 `read/cat/rg/jq` 查询当前 `openclaw.json`
2. 再提问：
   - `配置里有没有某项？`

### 期望

- 若结果带匹配的 `diagnosticType`
- 应判为 `fresh`
- 不必强制再次查证

## Case 10：多模型遵循度回归

分别在两类模型上执行：

- Case 1
- Case 5

模型类型：

1. Claude 系列
2. OpenAI 系列

### 期望

- 两边都能先查后答
- 若某一侧频繁直接回答，则说明：
  - gate 文案不够硬
  - 或注入位置不够稳定

## 失败判据

出现以下任一情况，即判定第一批原型未通过：

1. 高风险问题下，没有 fresh 证据却未触发 gate
2. gate 已触发，但模型仍直接复用旧 assistant 结论
3. 非高风险问题被误触发
4. `1 hour` 内已有 fresh 证据却仍反复触发
5. 注入破坏原有 prompt 结构或导致运行异常

## 当前范围外的扩展项

以下项目仍未完成，但已不属于当前范围 blocker：

1. `stale` 命中场景
2. 旧 assistant 结论冲突场景
3. 多模型遵循度回归
4. 更多 `openclaw ...` 环境状态命令族

## 相关文档

- [IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_2026-04-04.md](IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_2026-04-04.md)
- [IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md](IMPLEMENTATION_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md)
- [ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md](ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md)
- [REVIEW_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_2026-04-05.md](REVIEW_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_PROTOTYPE_2026-04-05.md)
