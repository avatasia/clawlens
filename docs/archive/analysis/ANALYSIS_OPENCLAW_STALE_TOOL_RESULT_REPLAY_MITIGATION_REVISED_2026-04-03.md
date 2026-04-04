# OpenClaw Stale Tool Result Replay Mitigation Revised Analysis

本文件是对当前 replay pollution 方案的修正版分析稿。

修正目标：

- 吸收 `Tag & Expire` 机制
- 消除“仅靠文本特征猜测”带来的路线偏移
- 明确哪些边界属于当前主方案，哪些仍待验证

本文件不覆盖已有草稿。该方案已完成其“当前主分析入口”职责，现作为已归档的阶段性主方案保留。

## 审计后确认的修正点

当前需要修正的不是根因判断，而是方案路线。

根因判断仍成立：

- 问题主因是 `stale session history + replay pollution`
- 不是跨渠道直接读取 `qqbot/data`
- 也不能依赖模型自己根据时间先后稳定判断新旧

需要修正的是：

1. 主方案不应继续把“文本特征匹配”当成主路线
2. 必须吸收源头标记的 `Tag & Expire` 机制
3. 必须把“距离当前轮足够远”写成可执行规则
4. 必须显式约束摘要化替换时保持 `toolResult.content` 原结构

## 当前建议的主路线

### 核心方向

采用两段式处理：

1. **源头标记**
   在工具执行结果生成时，为高时效性诊断输出打标
2. **replay 失效**
   在 `sanitizeSessionHistory(...)` 中识别这些标记，并在满足失效条件时做摘要化替换

这条路线优于“只在 replay 时按文本猜测”的原因是：

- 来源明确
- 规则可维护
- 误伤面更小
- 更容易审计与回退

## 推荐的 Tag & Expire 机制

### Step 1：在源头打标

对首批高风险诊断型输出，在工具执行端注入最小元数据，例如：

```json
{
  "__openclaw": {
    "kind": "diagnostic",
    "transient": true,
    "diagnosticType": "plugins-list"
  }
}
```

首批候选类型：

- `plugins-list`
- `config-snapshot`
- `plugin-path-probe`
- `install-diagnostic`

这里的关键点是：

- 不靠后续 replay 层重新猜命令语义
- 由产生该结果的源头显式声明“这是高时效性输出”

### Step 2：在 replay 前做有限失效

仍然只改 replay 输入，不改原始 transcript 落盘。

首选插入点仍是：

- `projects-ref/openclaw/src/agents/pi-embedded-runner/google.ts`
- `sanitizeSessionHistory(...)`

当消息满足以下条件时，进入失效判定：

1. 是历史 replay 的 `toolResult`
2. 带有 `__openclaw.transient = true`
3. 属于已登记的诊断类型
4. 已满足“过期距离”阈值

## “距离当前轮足够远”的建议算法

当前方案不再保留模糊说法，建议明确成：

### 初版规则

对命中的历史 `toolResult`，满足以下任一条件即可视为“足够远”：

1. **时间阈值**
   - `now - toolResult.timestamp > 1 hour`
2. **存在更新同类结果**
   - 同一 `diagnosticType` 后续已出现更近的一条 `toolResult`
   - 这里的“更新”不要求新结果必须成功
   - 只要同类诊断命令重新执行并形成了新的结果事件，就视为旧结果已被更新
3. **跨 compaction 边界**
   - 该消息位于最近一次 compaction 之前

### 初版实施建议

为了降低复杂度，第一版优先采用：

1. 时间阈值
2. 同类结果被更新

先不把 compaction 边界作为硬依赖。

这样更容易实现和验证。

### 对“之前有效、现在无结果”的处理

这是当前方案必须覆盖的边界：

- 旧结果是成功的
- 新一次同类诊断执行后，结果变成失败、`(no output)` 或空内容

在这种情况下：

- 新结果依然代表当前环境的最新事实
- 旧成功结果不能因为“内容更丰富”而继续保留为高优先级事实

因此第一版必须遵守：

- **新失败结果也是更新**
- **新空结果也是更新**
- 不允许因为新结果为空或失败，就让旧成功结果继续原样 replay**

## 摘要化替换规则

### 原则

不删除消息，不破坏 tool use / tool result 配对，只替换内容。

### 占位内容

推荐占位文本：

- `Previous environment diagnostic output omitted from replay.`

### 结构兼容要求

这是当前方案必须新增的硬约束：

- 如果原 `toolResult.content` 是字符串，替换后仍保持字符串
- 如果原 `toolResult.content` 是数组，替换后仍保持数组结构
- 不允许把一种结构强行改成另一种结构

否则会有 provider 转换层兼容风险。

## 当前不建议作为主路线的方案

以下只可作为辅助补充，不应作为主方案核心：

- 仅按工具名匹配
- 仅按命令文本模式匹配
- 仅按输出文本特征匹配

这些规则可以作为：

- 源头打标前的过渡验证手段
- 或对无标记历史数据的有限 fallback

但不应继续作为主路线。

## 最小实施顺序

### Phase A：定义诊断类型

先确定首批需要打标的命令类型与元数据字段。

### Phase B：源头打标

在工具执行输出生成路径，为诊断型结果附加 `transient` 与 `diagnosticType`。

### Phase C：replay 失效

在 `sanitizeSessionHistory(...)` 中：

- 识别带标记的旧结果
- 按时间阈值 / 同类结果更新规则判断是否失效
- 失效则摘要化替换

### Phase D：回归验证

验证：

- 旧插件状态不再持续污染
- 当前轮失败结果不会被旧成功结果语义复活
- 正常多轮工具链未受明显伤害

## 当前仍待确认的问题

1. `__openclaw` 元数据在哪条持久化链上最稳妥
2. `diagnosticType` 是枚举还是自由文本
3. 时间阈值应固定还是可配置
4. compaction 路径是否与 replay 同时收口，还是第二阶段再做

## 相关信息来源

- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](../../research/RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md](../../research/RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md)
- [ANALYSIS_OPENCLAW_SESSION_POLLUTION_FIX_PROPOSAL.md](../../research/ANALYSIS_OPENCLAW_SESSION_POLLUTION_FIX_PROPOSAL.md)
- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_2026-04-03.md](ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_2026-04-03.md](IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_2026-04-03.md)
