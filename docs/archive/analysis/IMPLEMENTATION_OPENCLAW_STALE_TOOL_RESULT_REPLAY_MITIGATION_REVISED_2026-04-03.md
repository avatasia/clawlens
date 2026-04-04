# OpenClaw Stale Tool Result Replay Mitigation Revised Implementation Plan

本文件是当前 replay pollution 修复路线的修正版实施计划。

本计划吸收以下审计意见：

- 主路线改为 `Tag & Expire`
- 不再把文本特征匹配当成核心方案
- 明确定义“过期距离”算法
- 明确 `toolResult.content` 替换时的结构兼容约束

本文件不覆盖旧稿。该方案已完成其“当前主实施入口”职责，现作为已归档的阶段性主实施方案保留。

## 实施边界

本方案的目标系统是：

- `OpenClaw` 主运行链

不是：

- `ClawLens` 插件侧绕行方案

原因是本问题发生在：

- session history replay
- `sanitizeSessionHistory(...)`
- run 前历史消息重放

这些都属于 OpenClaw 主链逻辑，而不是插件后处理链路。

因此：

- 本仓库中的文档用于收敛研究与方案
- 真正落地实现时，应修改 OpenClaw 侧源码或维护对应 patch
- 插件只能用于审计、观察与辅助验证，不能从根上替代 replay 污染治理

## 目标

在不改写历史 transcript 的前提下，降低以下 stale replay 污染：

- 旧插件状态
- 旧配置快照
- 旧目录探测结果
- 旧安装 / 升级 / 卸载诊断输出

同时保持：

- 当前轮工具结果完整保留
- tool use / tool result 结构完整
- transcript 可审计性

## 非目标

本轮不做：

- 删除历史 transcript
- 重写 session 文件
- 给模型显式增加完整时间元数据
- 靠提示词劝模型自己忽略旧结果
- 过滤所有 `toolResult`

## 实施主线

### Phase 0：定义标记模型

#### 目标

为高时效性诊断结果定义统一元数据。

#### 建议字段

```json
{
  "__openclaw": {
    "kind": "diagnostic",
    "transient": true,
    "diagnosticType": "plugins-list"
  }
}
```

#### 首批 `diagnosticType`

- `plugins-list`
- `config-snapshot`
- `plugin-path-probe`
- `install-diagnostic`

#### 完成判据

- 诊断类型枚举定稿
- 字段名与写入位置定稿

## Phase 1：源头打标

### 目标

在工具输出生成时标记诊断型结果。

### 动作

1. 在工具执行输出生成路径识别首批诊断类命令
2. 为命中的 `toolResult` 注入 `__openclaw.transient = true`
3. 同时写入 `diagnosticType`

### 约束

- 当前轮结果一律保留
- 不因为结果为空或失败而跳过标记
- 只对首批明确命中的诊断类型生效

### 完成判据

- 首批诊断类 `toolResult` 能稳定带上标记
- 非诊断类结果不被误标

## Phase 2：Replay 失效处理

### 目标

只在 replay 阶段对旧诊断结果做摘要化降权。

### 插入点

- `projects-ref/openclaw/src/agents/pi-embedded-runner/google.ts`
- `sanitizeSessionHistory(...)`

### 失效条件

必须同时满足：

1. 是 replay 历史里的 `toolResult`
2. 带有 `__openclaw.transient = true`
3. 命中已知 `diagnosticType`
4. 满足过期规则

### 过期规则

第一版明确使用以下任一条件：

1. `Date.now() - timestamp > 1 hour`
2. 同一 `diagnosticType` 已存在更近的一条结果

这里的“更近结果”明确包括：

- 成功结果
- 失败结果
- `(no output)`
- 空内容结果

也就是说：

- 只要同类诊断命令重新执行过，并产生了新的结果事件
- 旧结果就不能继续作为最新事实参与 replay

第一版暂不强依赖 compaction 边界。

### 处理方式

将内容替换为：

- `Previous environment diagnostic output omitted from replay.`

### 结构兼容要求

摘要化替换必须保持原 `toolResult.content` 的数据结构：

- 原来是字符串，仍写字符串
- 原来是数组，仍写数组

不允许破坏 provider 期望的数据形态。

### 完成判据

- 命中的旧诊断结果不再原样 replay
- 当前轮新结果不受影响

## Phase 3：回归验证

### 核心案例

1. 旧插件状态污染案例
2. 旧成功结果 + 新失败结果并存案例
3. 正常多步任务仍依赖近期工具结果的案例

### 验证标准

必须同时成立：

1. 旧插件状态不再持续污染新回答
2. 当前轮失败结果不会被旧成功结果语义复活
3. 合法多轮任务未出现明显上下文断裂
4. 未触发 tool use / tool result 配对协议错误
5. 当前轮空结果或失败结果不会被旧成功结果语义覆盖

## Phase 4：扩展与收口

### 只有在前述验证通过后才考虑

- 将同类规则扩展到 compaction 路径
- 扩展更多 `diagnosticType`
- 为时间阈值引入配置项

### 当前不建议

- 在 replay 层重新用文本正则推测所有诊断结果
- 在第一版就扩到所有工具

## 回退策略

如果出现以下问题，应立即回退到“仅打标、不失效”状态：

- 多轮任务连续性明显下降
- provider 转换层出现内容结构错误
- 命中规则误伤普通任务结果

## 相关信息来源

- [ANALYSIS_OPENCLAW_SESSION_POLLUTION_FIX_PROPOSAL.md](../../research/ANALYSIS_OPENCLAW_SESSION_POLLUTION_FIX_PROPOSAL.md)
- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](../../research/RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md](../../research/RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md)
- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
