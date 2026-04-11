# OpenClaw Assistant Conclusion Pollution Implementation

本文件记录“assistant 结论污染”问题的第一版实施方向。

> [!IMPORTANT]
> Current Status: 本稿尚不能直接进入代码实现。
> 当前 OpenClaw 并不存在独立的 planning / dispatch 控制层来在单次流式响应前“静默插队”强制执行工具。
> 本稿当前定位是：在现有架构约束下重设计 Phase 2 的实施入口，而不是立即编码的定稿实施稿。

本方案处理的是：

- 错误 assistant 文本消息已经进入 session history
- 后续轮次继续沿用这些旧结论

本方案不处理的是：

- `toolResult replay` 本身
  - 该问题已由独立方案覆盖

## 目标

第一版目标不是“清理所有 assistant 污染”，而是：

- 对高风险问题引入 **freshness gate**
- 降低模型直接复用旧 assistant 诊断结论的概率

换句话说：

- 先控制“什么时候必须重新查”
- 不在第一版直接大规模改写 assistant history

## 第一版范围

### 保留

1. 高风险问题识别
2. 回答前 freshness gate
3. 缺少 fresh 证据时，显式引导当前轮先完成工具核验
4. 只使用当前 OpenClaw 已存在的接入点

### 暂缓

1. assistant 消息结构化打标
2. replay 阶段大规模 assistant 文本降权
3. compaction 路径同步治理
4. 面向所有问题类型的通用 freshness 系统

## 开关要求

`Phase 2` 的 freshness gate 属于行为改变型能力。

它会改变：

- 高风险问题上的工具调用频率
- 当前轮 system prompt 注入内容
- 模型在“已有历史结论”场景下的默认回答路径

因此第一版实现必须满足：

1. 支持显式开关
2. 默认关闭
3. 只在实验、验证或受控环境中开启

当前不应把它设计成默认对所有会话生效的行为。

## 第一版候选问题类型

仅处理少量明确高风险问题：

1. 当前插件安装状态
2. 当前配置是否存在某项
3. 某文件当前是否存在
4. 某路径当前是否存在 / 指向什么
5. 当前版本号 / 当前启用状态

这些类型共同特点：

- 强依赖“当前机器状态”
- 很容易被旧结论污染
- 可以通过 fresh 工具检查重新确认

第一版要明确：

- 高风险判断不是按“命令名是否为 `openclaw`”来做
- 而是按“这次查询是否在回答当前环境状态”来做

因此，以下来源都可能落入同一高风险集合：

1. `openclaw` CLI 查询
   - `openclaw plugins list`
   - `openclaw status`
   - `openclaw config get`
2. 环境快照读取/解析命令
   - `cat`
   - `read`
   - `grep`
   - `rg`
   - `jq`
   - `find`
   - `ls`

## 核心策略

### Step 1：识别高风险问题

在当前轮用户输入进入回答前，识别是否属于高风险问题。

第一版建议使用：

- 小范围显式模式识别
- 明确关键词和问题类型表

不建议第一版：

- 依赖宽泛语义分类
- 试图自动覆盖所有环境问题

### Step 2：检查当前上下文是否缺少 fresh 证据

对高风险问题，判断：

1. 当前轮是否已经有对应 fresh tool result
2. 最近历史里是否只有旧 assistant 结论，没有新的工具核验

若满足以下条件，则视为 freshness 不足：

- 当前轮没有 fresh tool check
- 当前上下文中与该问题相关的信息主要来自旧 assistant 结论

第一版必须把这一步写成显式算法，而不是概念判断。

当前建议的最小算法如下：

1. 将当前问题映射到有限的 `diagnosticType`
2. 遍历最近 `N = 50` 条历史消息
3. 只检查满足以下条件的消息：
   - `role = toolResult`
   - `__openclaw.transient = true`
   - `diagnosticType` 与当前问题匹配
4. 若存在一条同时满足以下条件的结果，则视为已有 fresh 证据：
   - `__openclaw.replayOmitted !== true`
   - `now - timestamp <= 1 hour`
5. 若不存在，则判定 freshness 不足

第一版明确不把以下内容当 fresh 证据：

- 普通 assistant 文本结论
- 无结构化 `diagnosticType` 的旧工具输出
- 已被 omitted 的历史诊断结果

当前仍待重设计的是：

- 这个判定挂在哪个具体函数
- 判定结果如何合法地影响本轮 agent 行为

### Step 3：触发 fresh check

若 freshness 不足，则不允许直接基于旧结论回答。

而应：

1. 通过当前 OpenClaw 已有入口，向本轮模型显式注入“必须先做 fresh check”的约束
2. 由模型在当前轮正常发起 tool call
3. 再基于 fresh 结果答复

这一步是第一版核心。

当前不应再写成：

- 系统在模型外部“静默强制跑一个工具，再把结果塞回 prompt”

因为现有 `run/attempt.ts` 的单次流式执行链并没有这个独立控制层。

第一版当前更具体的目标不是“强制执行工具”，而是：

- 在 system prompt 中加入一段非常短的约束
- 明确要求：
  - 对当前高风险问题
  - 如果没有 fresh 证据
  - 必须先调用对应工具核验
  - 不得仅依据历史 assistant 结论直接回答

也就是说，第一版的 gate 本质上是：

- `prompt-level hard guidance`

而不是：

- runtime-level hard interception

### Step 4：保持对正常对话的最小影响

该 gate 只应作用于高风险问题。

不应影响：

- 普通闲聊
- 一般事实性延续
- 当前轮已经拿到 fresh 结果的问题

## 当前可行入口

按当前代码事实，第一版只应考虑以下入口：

1. `before_prompt_build`
   - 可基于当前 prompt + 历史消息做问题识别
   - 可返回 `prependSystemContext` / `appendSystemContext`
2. `before_agent_start`
   - 作为兼容入口，可提供同类 prompt 级附加约束
3. `resolvePromptBuildHookResult(...)`
   - 当前会合并 `before_prompt_build` 与 `before_agent_start` 的结果
4. `composeSystemPromptWithHookContext(...)`
   - 当前会把 hook 注入内容并入最终 system prompt
5. `sanitizeSessionHistory(...)`
   - 适合继续治理 replay 输入
   - 不适合直接解决“当前轮必须先查再答”

当前不可假设存在：

- 独立 planning 层
- 独立 dispatch 层
- 一个能在模型外部拦截问题并无声执行工具的前置路由器

## 当前推荐重设计路线

第一版当前最可行的路线是：

### Route A：Hook 驱动的 prompt-level freshness gate

1. 在 `before_prompt_build` 或 `before_agent_start` 中识别高风险问题
2. 结合当前历史消息，判断是否缺少 fresh 证据
3. 若不足，则通过：
   - `prependSystemContext`
   - 或 `appendSystemContext`
   注入一段强约束，要求模型本轮必须先使用指定工具核验
4. 由模型正常发起 tool call
5. 用 fresh 结果完成回答

这条路线当前的优点是：

- 不需要增加新的运行控制层
- 不破坏单次流式 agent 循环
- 与现有 hook / system prompt 合并机制一致

这条路线当前的风险是：

- prompt 注入只是“强约束”，不是系统级硬阻断
- 仍要验证模型在该约束下是否足够稳定地先查后答

第一版建议的注入内容也应限制在最小模板，不要做大段提示词工程。目标只保留：

1. 当前问题属于高风险环境问题
2. 你当前没有 fresh 证据
3. 必须先调用指定类型工具核验
4. 不得仅依据历史 assistant 结论回答

在进入代码原型前，建议先固定：

1. 单一模板文本
2. 问题类型 -> `diagnosticType` 映射表
3. 最小观测日志字段

### Route B：暂不进入

以下路线当前不建议进入第一版：

- 系统外部静默执行工具
- 直接重写 assistant history
- 对 assistant 文本做大范围 replay 降权
## 推荐实现边界

第一版原则是：

- 不直接改写历史 transcript
- 不删除 assistant 消息
- 不大范围改写 replay 文本
- 不引入新的 agent 控制层

因此，本稿当前更准确的状态是：

- 已明确问题和最小目标
- 但仍需要把“freshness gate”重设计为适配现有架构的入口

## 误伤风险

### 风险 1：把普通连续对话误判成需要重查

缓解：

- 只覆盖少量高风险问题类型
- 默认保守，不做泛化

### 风险 2：引入过多额外工具调用

缓解：

- 只在 freshness 明显不足时触发
- 当前轮已有 fresh 结果则不再重复查
- 高风险问题类型必须保持小集合

### 风险 3：影响多轮连续任务流畅性

缓解：

- 当前轮已有 fresh 证据时，不打断流程
- 不把 gate 扩展到所有 assistant 消息

### 风险 4：Prompt 注入被原有 system prompt 稀释

缓解：

- 只使用短、强约束、任务相关的注入文本
- 优先使用 `prependSystemContext`
- 第一版必须验证注入后的最终 prompt 确实包含该约束

## 验证标准

第一版至少应验证：

1. 旧错误 assistant 结论存在时，
   对高风险问题会触发 fresh check
2. fresh check 完成后，
   模型不再直接复述旧错误结论
3. 普通非高风险问题不被额外打断
4. 当前轮已经有 fresh 结果时，不重复触发检查
5. `prependSystemContext` / `appendSystemContext` 注入后，不会破坏原有 system prompt 结构
6. 注入后的约束在当前 provider 下足以稳定引导工具调用

另外在进入代码实现前，还必须补充：

5. 具体接入函数与文件路径
6. 如何在不引入外部控制层的前提下，把约束传递给当前轮模型
7. 如何避免注入内容被已有 system prompt / skills / workspace notes 稀释

## 当前建议的具体接入点

如果继续推进到代码原型，第一批应只尝试以下文件：

1. `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.prompt-helpers.ts`
   - `resolvePromptBuildHookResult(...)`
2. `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
   - `composeSystemPromptWithHookContext(...)` 的应用链
3. `projects-ref/openclaw/src/plugins/hooks.ts`
   - `before_prompt_build` / `before_agent_start` 的结果拼装

当前不应在别处先开新控制层。

## 当前建议的第一批原型范围

如果继续进入最小代码原型，第一批只建议做：

1. 高风险问题 -> `diagnosticType` 映射表
2. 最近 `50` 条历史消息的 fresh 证据扫描
3. `prependSystemContext` 最小约束注入
4. 日志与观测点

第一批不建议做：

- assistant 结论结构化打标
- compaction 同步
- 泛化问题分类

## 回退策略

若第一版误伤过多，优先回退：

1. 缩小高风险问题类型集合
2. 缩小触发条件
3. 保留日志与研究结论，但关闭 freshness gate

## 当前定位

本文件是：

- 第一版最小实施方向
- 待重设计实施稿

不是：

- 最终完整治理设计
- 已可直接编码的定稿方案

## 相关信息来源

- [ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md](ANALYSIS_OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_2026-04-04.md)
- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_HISTORY_REPLAY_BEHAVIOR_2026-04-04.md](./RESEARCH_OPENCLAW_TOOL_RESULT_HISTORY_REPLAY_BEHAVIOR_2026-04-04.md)
