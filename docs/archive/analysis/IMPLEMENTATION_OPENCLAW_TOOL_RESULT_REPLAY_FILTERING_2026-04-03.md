# OpenClaw Tool Result Replay Filtering Implementation Plan

本文件是：

- 针对旧 `toolResult` replay 污染问题的待实施计划
- 基于当前分析稿细化的工程动作清单
- 仍未定稿，不代表已决定执行

相关分析：

- [ANALYSIS_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md](ANALYSIS_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md)
- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](./RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)

## 目标

在不改写历史 transcript 文件的前提下，降低以下问题：

- 过期的本地诊断输出被长期 replay
- 模型把旧环境状态当成当前事实继续复述
- 旧插件状态、旧配置快照、旧目录探测结果污染新回答

同时维持：

- 当前正常多轮任务链
- 合法的 tool call / tool result 连续性
- transcript 与 session 的可审计性

## 非目标

以下内容不属于本轮目标：

- 清空或重写历史 transcript
- 删除 session 中已经存在的历史消息
- 解决所有历史污染问题
- 针对所有工具做全局语义理解

## 当前拟采用的路径

优先采用：

- **运行时 replay 过滤**
- **仅作用于 session history replay**
- **不改原始 transcript 落盘**

不优先采用：

- 离线清洗历史数据
- 直接删除历史 `toolResult`

## 候选插入点

首选插入点：

- `projects-ref/openclaw/src/agents/pi-embedded-runner/google.ts`
  - `sanitizeSessionHistory(...)`

调用位置：

- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/compact.ts`

理由：

- 这是 replay 前的统一清洗入口
- 可以先做最小侵入实验
- 不改写 transcript 文件

## Phase 0：证据归类

### 目标

先把“高风险 toolResult”缩成有限集合。

### 动作

1. 从真实污染案例中提取命令模式
2. 区分：
   - 诊断型 / 环境探测型
   - 任务执行型
3. 给出首批候选模式

### 当前首批候选

- `openclaw plugins list`
- 读取 `openclaw.json`
- 插件目录存在性探测
- 安装 / 升级 / 卸载结果摘要

### 完成判据

- 形成一组明确的命令模式清单
- 不再使用“高风险”这种空泛标签

## Phase 1：最小实验实现

### 目标

只对一小批高风险 replay 内容做实验性降权。

### 建议策略

首选不是删除，而是二选一：

1. 限时保留
2. 摘要化替换

建议优先顺序：

- 先摘要化
- 再视效果考虑限时保留

### 具体动作

1. 在 `sanitizeSessionHistory(...)` 内识别 replay 消息中的 `toolResult`
2. 对匹配高风险命令模式的结果进行分类
3. 把原始大段输出替换为轻量占位文本

例如：

- `Previous environment diagnostic output omitted from replay.`

### 约束

- 只影响 replay 输入
- 不改 transcript 文件
- 不影响实时新到达的 `toolResult`

### 完成判据

- 对选定的 1 到 3 类命令模式生效
- 当前污染案例中，旧插件状态不再原样进入 replay

## Phase 2：回归验证

### 目标

验证“减少污染”没有明显破坏正常多轮能力。

### 回归场景

1. 旧插件状态污染案例
2. 当前多步任务依赖 recent tool output 的正常案例
3. 含 tool use / tool result 配对的 replay 案例

### 重点观察

- 错误旧结论是否减少
- 当前任务是否仍能引用最近一步工具结果
- 是否出现回答上下文断裂

### 完成判据

- 污染案例改善
- 正常多轮能力未出现明显回退

## Phase 3：扩展策略

### 目标

在最小实验有效后，决定是否扩到更细规则。

### 可选扩展

- 时间窗保留策略
- 配置快照与安装诊断分开处理
- `toolResult` 摘要化时保留最小可解释标签
- 对 compaction 输入做同类降权

### 不建议直接做

- 一次性扩到所有工具
- 引入复杂的自然语言语义判断

## 风险

### 风险 1：误伤正常任务连续性

如果某条 `toolResult` 其实仍被当前任务依赖，过早过滤会让模型失去必要上下文。

### 风险 2：过滤规则过粗

若仅按 `exec` 或 `read` 工具名过滤，误伤面会过大。

### 风险 3：compaction 与 replay 规则不一致

如果 replay 被过滤而 compaction 仍保留全量旧输出，可能出现前后行为不一致。

## 建议的工程顺序

1. 先只做 replay 侧实验
2. 只针对首批诊断型命令模式
3. 先摘要化，不直接删除
4. 用真实案例验证
5. 再考虑是否扩展到 compaction

## 相关信息来源

- [ANALYSIS_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md](ANALYSIS_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md)
- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](./RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
- `projects-ref/openclaw/src/agents/pi-embedded-runner/google.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/compact.ts`
