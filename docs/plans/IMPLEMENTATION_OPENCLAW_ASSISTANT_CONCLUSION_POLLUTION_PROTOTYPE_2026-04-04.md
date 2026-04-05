# OpenClaw Assistant Conclusion Pollution Prototype Plan

> [!IMPORTANT]
> Current Status: Prototype Planning
> 本文不是 Phase 2 的正式实施稿，而是第一批最小代码原型的执行边界。

## 目标

为 `assistant conclusion pollution` 的第二阶段准备一个最小可验证原型，目标只有一件事：

- 证明在现有 OpenClaw 架构中，能否通过 hook + system prompt 注入，
  让模型在高风险环境问题上优先做 fresh check，而不是直接复用旧 assistant 结论。

本原型不追求彻底解决 assistant 污染，只验证“最小 freshness gate”是否可行。

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
   - 当缺少 fresh 证据时，要求模型本轮必须先核验

### 不做

1. assistant 结论结构化打标
2. compaction 路径支持
3. replay 层 assistant 文本降权
4. 泛化到所有环境问题
5. 模型外部静默执行工具

## 第一批高风险问题集合

原型只覆盖以下 2 类问题：

1. 当前插件安装/启用状态
2. 当前配置项是否存在

对应原因：

- 与已验证的 `diagnosticType` 体系耦合最紧
- 最容易复现旧结论污染
- 最适合先验证 freshness gate 的有效性

当前暂不纳入：

- 普通文件读取问题
- 一般路径存在性问题
- 广义版本/状态问题

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

- 插件安装/启用状态
  - `openclaw.plugins_list`
- 配置项是否存在
  - `openclaw.config_snapshot`

这些映射的来源可以是：

1. `openclaw` CLI 状态命令
2. `cat/read/grep/rg/jq/find/ls` 对环境文件或插件目录的读取结果

### 第一批固定映射表

| 问题类型 | 典型问法 | 首选 `diagnosticType` | 典型来源 |
|---|---|---|---|
| 插件安装/启用状态 | “当前装了什么插件”“某插件还在吗” | `openclaw.plugins_list` | `openclaw plugins list` |
| 配置项是否存在 | “配置里有没有某项”“当前配置值是什么” | `openclaw.config_snapshot` | `openclaw config get` / `cat|read|rg|jq openclaw.json` |

第一批明确不支持：

- 一条问题同时映射多个 `diagnosticType`
- 无结构化证据时对 assistant 文本做开放式正则推断
- 基于旧 assistant 结论反推问题类型

### 判定结果

- 若命中同类 fresh 证据：
  - 不注入 freshness gate
- 若未命中：
  - 注入 freshness gate

## Prompt 注入策略

第一批只允许使用一段非常短的 `prependSystemContext`。

目标信息只保留：

1. 当前问题属于高风险环境问题
2. 当前没有 fresh 证据
3. 本轮必须先调用相应工具核验
4. 不得仅依据历史 assistant 结论回答

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
     - 插件安装/启用状态
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

1. 高风险问题 + 无 fresh 证据时
   - 最终 prompt 中确实包含 freshness gate
2. 高风险问题 + 有 fresh 证据时
   - 不注入 gate
3. 低风险问题
   - 不注入 gate
4. 注入 gate 后
   - 模型本轮会优先发起对应工具调用
5. 注入 gate 不会破坏原有 system prompt 结构
6. 日志中可以明确区分：
   - 未命中高风险问题
   - 命中但已有 fresh 证据
   - 命中且触发 gate

## 失败判据

出现以下任一情况，就说明第一批原型未通过：

1. gate 注入后，模型仍频繁直接复述旧 assistant 结论
2. 高风险问题误伤明显，导致大量不必要工具调用
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
