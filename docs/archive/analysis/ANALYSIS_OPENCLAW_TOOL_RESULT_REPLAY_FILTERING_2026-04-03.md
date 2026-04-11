# OpenClaw Tool Result Replay Filtering Analysis

本文件记录一个待实施方向：

- 如何降低旧 `toolResult` 被 replay 进后续 prompt 后造成的语义污染
- 特别是“旧诊断输出 / 旧插件状态 / 旧配置快照”继续影响新回答的问题

当前状态：

- 尚未定稿
- 尚未实施
- 仅作为后续过滤策略的分析与实施前置文档

## 背景

已有研究表明，当前问题更像：

- 同一个 agent/session 的 transcript 中保存了旧消息与旧 `toolResult`
- OpenClaw 在后续 run 中会 replay 这些历史消息
- 现有 `sanitizeSessionHistory(...)` 主要做结构清洗
- 语义上已经过期、但结构合法的 `toolResult` 不会被自动过滤

相关研究见：

- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](./RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_CALL_FLOW.md](../../research/RESEARCH_OPENCLAW_TOOL_CALL_FLOW.md)

## 目标

定义一套**保守、可审计、尽量不伤主能力**的 replay 过滤策略，用于降低以下问题：

- 旧插件安装状态继续污染后续回答
- 一次性诊断输出被当成长期事实反复复述
- 旧本地工具输出在模型上下文中“冻结成事实”

同时避免破坏：

- 合法的任务连续性
- 合法的 tool use / tool result 推理链
- 当前依赖 recent tool output 的正常多轮工作流

## 需要解决的核心问题

### 1. 哪类 `toolResult` 属于“高风险易过期”

初步候选包括：

- `openclaw plugins list`
- 读取当前配置的完整快照输出
- 插件安装 / 升级 / 迁移诊断输出
- 列目录 / 查文件存在性这类一次性环境探测结果

这些结果通常：

- 强依赖当时本地状态
- 很快可能失效
- 一旦被长期 replay，容易变成错误事实来源

### 2. 哪类 `toolResult` 不应过滤

必须谨慎保留的包括：

- 当前仍与用户任务直接相关的最近工具输出
- 形成完整 tool call -> tool result -> assistant answer 链的近期结果
- 对当前多步任务有持续依赖的结构化结果

否则会损伤：

- 多轮延续推理
- 当前任务追踪
- 工具链可解释性

### 3. 过滤发生在什么阶段

优先考虑的插入点：

- replay 前的 `sanitizeSessionHistory(...)`

原因：

- 它已经是统一的历史清洗入口
- 可以在不改 transcript 持久化的情况下，先做运行时过滤实验

不优先考虑的方向：

- 改写历史 transcript 文件
- 直接删除历史 `toolResult`

原因：

- 破坏可审计性
- 风险过高

## 候选策略

### 策略 A：按工具名 + 输出模式过滤

例如仅针对：

- `exec`
- `read`

且输出内容匹配高风险模式时，降权或过滤 replay。

优点：

- 最容易开始

缺点：

- 误伤面大
- 规则容易粗糙

### 策略 B：按“诊断型命令”过滤

例如识别：

- `openclaw plugins list`
- 读取 `openclaw.json`
- 插件目录存在性探测

优点：

- 语义更接近真实问题

缺点：

- 需要更强的命令模式识别

### 策略 C：按时间窗 + 近期任务关联过滤

例如：

- 只保留最近 N 条高风险工具结果
- 超出时间窗或轮次后不再 replay

优点：

- 风险更可控

缺点：

- 需要定义“最近”的标准
- 不同任务密度下效果可能波动

### 策略 D：只对高风险工具结果做“摘要化”而非完全删除

例如把原始输出替换为更轻的占位说明：

- `Previous environment diagnostic output omitted from replay`

优点：

- 兼顾可解释性

缺点：

- 仍需定义哪些结果该摘要化

## 当前建议方向

当前更稳的顺序是：

1. 先做运行时过滤实验，不改历史落盘
2. 先从“诊断型 / 环境探测型 `toolResult`”入手
3. 优先尝试“摘要化或限时保留”，而不是一刀切删除
4. 用真实污染案例回归验证

## 实施前必须回答的问题

1. 过滤判定应基于：
   - tool name
   - command pattern
   - 输出内容
   - 还是上述组合
2. 过滤后是否会破坏当前 run 的多轮延续能力
3. 过滤应只作用于 replay，还是也影响 compaction 输入
4. 是否需要为被过滤的历史内容保留显式标记，避免“静默消失”

## 建议的实施顺序

### Step 1

先针对真实污染案例，收集一组最小命令模式：

- `openclaw plugins list`
- 配置读取
- 插件目录探测

### Step 2

在 OpenClaw replay 清洗入口做实验性策略：

- 仅作用于 replay
- 不改 transcript 原始落盘

### Step 3

验证以下结果：

- 错误旧结论是否减少
- 当前多轮任务是否被破坏
- tool use / tool result 正常链路是否仍可追

## 相关信息来源

- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](./RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/google.ts`
- `projects-ref/openclaw/src/gateway/session-utils.fs.ts`
