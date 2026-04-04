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

第一版必须把这一步写成显式算法，而不是概念判断。建议最低标准是：

1. 先把高风险问题映射到有限的 `diagnosticType`
2. 遍历最近 `N` 条历史消息
3. 查找是否存在：
   - 带对应 `diagnosticType` 的 fresh `toolResult`
   - 且时间距离未超过阈值
4. 若不存在，则判定 freshness 不足

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

### Step 4：保持对正常对话的最小影响

该 gate 只应作用于高风险问题。

不应影响：

- 普通闲聊
- 一般事实性延续
- 当前轮已经拿到 fresh 结果的问题

## 当前可行入口

按当前代码事实，第一版只应考虑以下入口：

1. `before_agent_start` / `before_model_resolve`
   - 只能做 prompt / model 级引导
   - 不能直接代替模型执行工具
2. system prompt override
   - 可用于附加“高风险问题必须先核验”的动态约束
3. `sanitizeSessionHistory(...)`
   - 适合继续治理 replay 输入
   - 不适合直接解决“当前轮必须先查再答”

当前不可假设存在：

- 独立 planning 层
- 独立 dispatch 层
- 一个能在模型外部拦截问题并无声执行工具的前置路由器
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

### 风险 3：影响多轮连续任务流畅性

缓解：

- 当前轮已有 fresh 证据时，不打断流程
- 不把 gate 扩展到所有 assistant 消息

## 验证标准

第一版至少应验证：

1. 旧错误 assistant 结论存在时，
   对高风险问题会触发 fresh check
2. fresh check 完成后，
   模型不再直接复述旧错误结论
3. 普通非高风险问题不被额外打断
4. 当前轮已经有 fresh 结果时，不重复触发检查

另外在进入代码实现前，还必须补充：

5. 具体接入函数与文件路径
6. 如何在不引入外部控制层的前提下，把约束传递给当前轮模型

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
- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](../archive/analysis/ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_HISTORY_REPLAY_BEHAVIOR_2026-04-04.md](../research/RESEARCH_OPENCLAW_TOOL_RESULT_HISTORY_REPLAY_BEHAVIOR_2026-04-04.md)
