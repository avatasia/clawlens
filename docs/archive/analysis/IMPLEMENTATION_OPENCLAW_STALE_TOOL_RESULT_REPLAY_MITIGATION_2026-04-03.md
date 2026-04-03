# OpenClaw Stale Tool Result Replay Mitigation Implementation Plan

本方案基于两条已确认事实：

1. 旧的 `toolResult` 会保留在 session history 中，并在后续 replay 中重新进入模型上下文
2. `toolResult.timestamp` 虽存在于系统内部，但当前不会显式传给模型

因此，解决方向不能依赖“模型自己凭时间戳判断新旧”，而应由系统在 replay 前主动做有限过滤。

## 目标

降低以下污染：

- 旧插件状态
- 旧配置快照
- 旧环境诊断输出
- 旧目录探测结果

这些内容在当前环境已变化后，仍被 replay 给模型，导致模型继续复述过期事实。

## 非目标

以下内容不在本轮方案内：

- 删除历史 transcript
- 重写历史 session 文件
- 让所有 `toolResult` 一律带时间戳进入模型
- 让模型自己解决所有历史冲突

## 方案核心

### 原则 1：只处理历史 replay，不处理当前轮工具结果

当前轮新产生的 `toolResult` 必须保留。

也就是说：

- 当前轮 `cat file` 成功，保留
- 当前轮 `cat file` 失败，也保留
- 只有当这些结果进入后续 replay 历史时，才进入过滤判断

### 原则 2：只处理诊断型 / 环境型旧结果

首批不处理一般任务结果，只处理高风险易过期的诊断型输出。

初始候选：

- `openclaw plugins list`
- 读取 `openclaw.json` / 相关配置快照
- 插件目录存在性探测
- 安装 / 升级 / 卸载结果摘要

### 原则 3：先摘要化，不直接删除

对命中的旧诊断型 `toolResult`，不直接删除，而是替换成轻量占位：

- `Previous environment diagnostic output omitted from replay.`

这样可以：

- 保留上下文里“曾执行过诊断”的事实
- 避免继续向模型注入过期细节
- 保持回退空间

## 推荐插入点

首选仍是：

- `projects-ref/openclaw/src/agents/pi-embedded-runner/google.ts`
  - `sanitizeSessionHistory(...)`

原因：

- 它是 replay 前的统一入口
- 当前已经负责结构清洗
- 最适合插入额外的“语义上有限过滤”

## 过滤判定标准

初版建议使用三元条件：

1. 是 replay 历史里的 `toolResult`
2. 属于诊断型 / 环境型命令模式
3. 与当前轮存在足够距离

其中第 3 条不直接依赖模型，而由系统内部元数据判断。

## 建议的最小实现

### Step 1：识别诊断型 `toolResult`

根据：

- tool name
- command pattern
- 文本输出特征

生成首批命中规则。

### Step 2：只在 replay 清洗阶段替换文本

把命中的旧结果从原始长文本替换成摘要文本。

### Step 3：保留当前轮最新结果

不管当前轮结果是：

- 成功文本
- `(no output)`
- 失败原因

都不能用旧历史结果覆盖它。

## 验证标准

### 成功标准

1. 旧插件状态不再持续污染新回答
2. 当前轮失败结果不会被旧成功结果“语义复活”
3. 正常多轮任务仍能使用最近工具结果

### 回归风险

1. 误伤合法多轮任务连续性
2. 规则过粗，误过滤非诊断型结果
3. replay 与 compaction 行为出现不一致

## 当前建议的实施顺序

1. 先在 replay 路径试点
2. 先只做 1 到 3 类高风险诊断型命令
3. 先摘要化，不删除
4. 先用真实污染案例回归验证
5. 再决定是否扩展到 compaction 路径

## 相关信息来源

- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](../research/RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md](../research/RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md)
- [ANALYSIS_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md](ANALYSIS_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md](IMPLEMENTATION_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md)
