# OpenClaw Stale Tool Result Replay Mitigation

本文件是当前关于 `stale toolResult replay pollution` 的主方案稿。

用途：

- 收拢当前已确认的根因结论
- 收拢当前建议实施方向
- 作为后续继续实现前的单一入口

本文件不是定稿规则，也不代表方案已经实施。

## 问题定义

当前问题不是：

- Discord 直接跨渠道读取 `qqbot/data`
- 模型单独凭空幻觉

当前更符合证据链的解释是：

- 同一个 agent/session 的旧 `toolResult`、旧 assistant/user 消息已经写入 session transcript
- 后续 run 在 replay 历史消息时，把这些旧内容重新送进模型
- 其中一部分内容属于强时效性的诊断/环境输出
- 模型在缺少显式新旧时间信号的前提下，继续沿用这些旧结论回答

一句话总结：

- 这是 `stale session history + replay pollution`

## 已确认事实

### 1. 旧 `toolResult` 会进入后续 replay

当前 OpenClaw 会在新的 run 前读取 session history，并对历史消息执行 replay 前清洗。

这意味着：

- 旧 `toolResult`
- 旧 assistant 结论
- 旧 user/tool 对话链

都可能再次进入后续模型上下文。

### 2. 当前清洗逻辑主要是结构清洗

现有 `sanitizeSessionHistory(...)` 主要处理：

- 图片与 thinking 清洗
- tool use / tool result 配对修复
- orphaned `toolResult` 清理
- `details` 剥离
- provider 兼容性处理

它不会自动识别：

- 某条历史 `toolResult` 在语义上已经过期

### 3. `toolResult.timestamp` 不会显式传给模型

系统内部消息对象有 `timestamp`，但当前 provider 输入转换不会把该字段带给模型。

因此不能把正确性寄托在：

- “模型自己根据时间戳判断旧结果和新结果”

### 4. 当前轮结果不能动

当前轮新产生的 `toolResult` 不论是：

- 成功文本
- `(no output)`
- 失败原因

都代表这次真实执行结果，必须保留。

所以本问题的处理对象只能是：

- 后续 replay 阶段里的旧 `toolResult`

## 当前主方案

### 核心原则

1. 只处理历史 replay，不处理当前轮工具结果
2. 只处理诊断型 / 环境型旧结果
3. 先摘要化，不直接删除
4. 不改 transcript 原始落盘
5. 尽量保持 tool use / tool result 结构安全

### 首选插入点

优先在 replay 前统一清洗入口做处理：

- `projects-ref/openclaw/src/agents/pi-embedded-runner/google.ts`
- `sanitizeSessionHistory(...)`

这样可以：

- 不改历史文件
- 不破坏当前 transcript 审计能力
- 先做最小侵入实验

### 首批目标对象

优先考虑强时效性、强环境依赖的诊断型输出，例如：

- `openclaw plugins list`
- 读取 `openclaw.json` 或其他配置快照
- 插件目录存在性探测
- 安装 / 升级 / 卸载诊断结果

### 推荐处理方式

对命中的旧 `toolResult`：

- 不直接删除
- 先将原始长文本替换成轻量摘要占位

例如：

- `Previous environment diagnostic output omitted from replay.`

这样做的目的：

- 保留“这里曾执行过诊断”的上下文事实
- 不再把旧环境细节继续注入模型
- 降低 replay 污染

## 当前不建议做的事

以下方向当前不建议作为第一版：

- 直接清空或重写历史 transcript
- 过滤所有 `toolResult`
- 完全依赖模型自己判断新旧
- 只加一句提示词提醒模型不要信旧信息
- 一上来同时修改 replay 和 compaction 两条链

## 实施顺序建议

### Step 1

先缩小命中集合，只保留少量真实污染案例的命令模式。

### Step 2

仅在 replay 路径试点：

- 识别命中的旧诊断型 `toolResult`
- 做摘要化替换

### Step 3

用真实案例验证：

- 旧插件状态是否不再持续污染后续回答
- 当前轮失败结果是否不再被旧成功结果语义复活
- 正常多轮任务是否仍能依赖最近工具结果

### Step 4

如果 replay 路径验证有效，再决定是否把类似策略扩展到 compaction。

## 关键风险

### 风险 1

误伤仍被当前任务依赖的近期工具结果。

### 风险 2

规则过粗，导致把普通任务型 `toolResult` 也当成诊断型输出处理。

### 风险 3

replay 与 compaction 口径不一致，造成不同路径下模型行为差异。

## 相关信息来源

- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](../research/RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md](../research/RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md)
- [ANALYSIS_OPENCLAW_SESSION_POLLUTION_FIX_PROPOSAL.md](../research/ANALYSIS_OPENCLAW_SESSION_POLLUTION_FIX_PROPOSAL.md)
- [ANALYSIS_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md](ANALYSIS_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md](IMPLEMENTATION_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_2026-04-03.md](IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_2026-04-03.md)
