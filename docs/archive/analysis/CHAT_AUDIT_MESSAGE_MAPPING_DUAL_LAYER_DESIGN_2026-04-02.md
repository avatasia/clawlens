# Chat Audit Message Mapping Dual-Layer Design 2026-04-02

## 目标

为 ClawLens 的“当前聊天消息 -> 对应 audit run”建立一套同时兼顾：

- 实时性
- 绑定精度
- 可审计性

的双层设计。

核心原则：

- 前端信源负责“快”
- 后端信源负责“准”

不再试图让单一链路同时承担 UI 即时反馈和审计真相源。

## 结论

推荐采用双层设计：

1. 前端层：直接利用当前 chat 会话的 websocket / history 消息流
2. 后端层：以 transcript update / transcript file / llm logger 为最终绑定真相源

前端层用于：

- 立即识别“当前页面这条消息是谁”
- 立即推动 UI 高亮、定位、预展开

后端层用于：

- 将消息稳定绑定到 `runId`
- 持久化、查询、审计、回放
- 在前端临时判断不准时做最终校正

## 当前实现状态

这份文档描述的是推荐目标态，不代表当前仓库已经完成前端实时层。

当前需要明确的现实约束是：

- 前端 `inject.js` 目前还没有接 control-ui 当前会话 websocket/history 消息流
- 前端还没有读取 `__openclaw.id` / `__openclaw.seq` 的现成逻辑
- 后端也还没有：
  - `GET /audit/session/:sessionKey/current-message-run`
  - `GET /audit/message/:messageId`

因此“双层设计”当前不能理解成“已经具备双层能力”，而应理解成：

- 后端审计层是当前主实现基础
- 前端实时层是待验证、待接入的增强层

## 为什么要分两层

### 只靠前端 websocket 的问题

优点：

- 时延最低
- 当前页面可立即拿到消息内容
- 已含 `__openclaw.id`、`__openclaw.seq`

缺点：

- 偏 UI 视角
- 不天然等于审计存档
- 当前页刷新、重连、分页都可能影响感知
- 不能作为唯一真相源

### 只靠后端 transcript / logger 的问题

优点：

- 持久化
- 可回放
- 可索引
- 审计可靠

缺点：

- 到达 UI 往往晚一拍
- 当前消息在页面上的“即时定位”不如前端直接拿流
- 若只靠后端回查，用户会看到明显延迟

所以最合适的拆分就是：

- 前端先做即时定位
- 后端再做最终绑定和修正

## 双层架构

## 第一层：前端实时消息层

### 信源

使用当前会话已有的 websocket / history 数据流。

前置条件：

- 必须先确认 control-ui 前端存在可稳定复用的消息流接入点
- 必须确认该消息流里能可靠拿到 `__openclaw.id/__openclaw.seq`

如果这两项无法满足，则第一版不实现这一层，直接降级为“后端单层 + 前端被动刷新”。

降级判据必须固定，不允许实现者主观判断。

判定方法：

1. 检查 control-ui 源码，确认是否存在可被插件稳定观察的当前会话消息流
2. 运行时在浏览器控制台验证，确认当前会话消息对象中是否稳定出现：
   - `__openclaw.id`
   - `__openclaw.seq`
3. 连续验证至少 `3` 条 user message 和 `3` 条 assistant message

若任一条件不满足，则判定为：

- 第一版前端实时层不可用
- 直接降级为“后端回查优先”

目标是拿到每条当前聊天消息的：

- `role`
- `content`
- `timestamp`
- `__openclaw.id`
- `__openclaw.seq`

这些字段已经足够做“当前页面消息定位”。

### 职责

第一层不直接承诺最终 `runId` 真相，只负责：

- 识别当前页面最新 user message
- 给消息建立前端临时 key
- 在 UI 中标记“这条消息正在等待绑定”
- 优先尝试命中后端已有绑定

### 前端临时标识建议

建议前端为当前会话消息维护：

- `sessionKey`
- `openclawMessageId`，优先取 `__openclaw.id`
- `openclawSeq`
- `timestamp`
- `textPreview`

这里的 `openclawMessageId` 是 UI 层消息 ID，不等于 transcript `messageId`，文档里必须明确区分。

### 第一层输出

第一层输出应是一个前端临时对象，例如：

```ts
{
  sessionKey,
  uiMessageId,
  uiSeq,
  timestamp,
  textPreview,
  bindingStatus: "pending" | "resolved" | "fallback",
  resolvedRunId?: string
}
```

它的作用是驱动 UI，而不是直接替代后端存储。

注意：

- 这里的 `bindingStatus` / `resolvedRunId` 目前只是目标态结构
- 当前前端代码里还没有对应状态机实现

## 第二层：后端审计绑定层

### 信源

后端绑定层使用三类信源，按强度排序：

1. transcript update / transcript file 的 `messageId`
2. llm logger request `prompt` 中的 `message_id`
3. sessionKey + active run + time window fallback

补充约束：

- 当前尚未证明 1 和 2 的 ID 一定同值
- 在完成实际对账前，不能把它们当作同一命名空间直接合并

### 职责

第二层负责：

- 建立真正的 `message -> run` 持久化绑定
- 将绑定结果落到现有存储
- 为前端提供查询和回查接口
- 在前端临时判断不准时，返回最终修正结果

### 持久化建议

优先复用当前已有的 `conversation_turns`：

- `message_id`
- `run_id`
- `session_key`

建议新增来源字段：

- `source_kind`
- `source_session_id`
- `source_logger_ts`

`source_kind` 建议枚举：

- `transcript_explicit`
- `llm_prompt_metadata`
- `session_fallback`

## 前后端协作方式

## 路径 A：后端已知 transcript `messageId`

这是最强路径。

流程：

1. OpenClaw 写 transcript
2. 触发 `onSessionTranscriptUpdate`
3. ClawLens 保存 `messageId`
4. 若 logger 解析也命中同一消息，再补强 `runId`
5. 前端查询时直接返回最终绑定

这条路径当前的限制是：

- transcript update 里的 `messageId` 在 OpenClaw 代码中是可选字段
- ClawLens 当前实现遇到缺失 `messageId` 会直接跳过

因此该路径不能假设“所有 transcript message 都有 `messageId`”。

## 路径 B：前端先看到消息，后端尚未完成绑定

这是最常见路径。

流程：

1. 前端 websocket 先拿到当前 user message
2. 前端用 `__openclaw.id/__openclaw.seq/textPreview` 标记“pending”
3. 前端调用后端接口按 `sessionKey` 回查当前消息
4. 后端若尚未完成强绑定，则先返回 fallback run 或 pending
5. 后续 transcript / logger 到达后，后端更新绑定
6. 前端收到更新后将 UI 从 pending 切成 resolved

## 路径 C：派生 run

例如：

- subagent task
- announce
- startup
- cron

这类 run 不强行走“当前用户消息 -> run”主路径。

它们继续走：

- runtime 派生关系
- explicit run metadata
- source-specific 规则

避免把主消息绑定规则错误外推到所有 run。

## 接口设计建议

建议增加两类接口。

说明：

- 这两个接口目前都还不存在
- 文档这里描述的是待实现接口，不是现有能力

### 1. 当前消息回查接口

第一版优先做这个：

`GET /audit/session/:sessionKey/current-message-run`

用途：

- 前端当前还不一定能直接拿 transcript `messageId`
- 先让后端按当前 session 返回“最可能对应当前消息的 run”

返回建议：

```json
{
  "sessionKey": "...",
  "status": "resolved" | "pending" | "fallback" | "none",
  "uiHint": {
    "messageId": "...",
    "seq": 37,
    "textPreview": "再看下当前版本号"
  },
  "runId": "...",
  "sourceKind": "llm_prompt_metadata"
}
```

返回字段必须固定，否则前后端会各自理解。

查找规则也必须固定：

1. 只在当前 `sessionKey` 范围内查
2. 只考虑 `role = user` 的 turn
3. 取最近一条 user turn 作为“当前消息”
4. 若该 turn 已有强绑定 run，返回 `resolved`
5. 若只有 fallback run，返回 `fallback`
6. 若找到了 user turn 但还没绑定 run，返回 `pending`
7. 若连 user turn 都没有，返回 `none`

### 2. 显式消息查询接口

第二版再做：

`GET /audit/message/:messageId`

前提是前端后续能稳定拿到后端可对齐的 `messageId`。

## 前端实现建议

### 第一步：接当前会话消息流

前端直接消费当前会话 websocket / history 数据流，拿到：

- `__openclaw.id`
- `__openclaw.seq`
- `textPreview`
- `timestamp`

前置条件：

- 当前 control-ui 代码必须能被 ClawLens 可靠观察或接入
- 如果当前架构下无法安全接入，这一步延后，不作为第一版实现前提

### 第二步：建立前端 pending 状态

当用户发出新消息时：

- 不要等后端完全绑定后再更新 UI
- 先标记这条消息为 `pending`
- Audit 侧栏可先高亮“当前消息正在匹配 run”

### 第三步：调用后端回查

第一版只传：

- `sessionKey`

后端返回：

- `resolved`
- `pending`
- `fallback`
- `none`

### 第四步：收到更强绑定后修正 UI

当 transcript / logger 侧绑定完成后：

- 前端刷新当前消息对应的 run
- 若之前只是 fallback，应替换成更强绑定结果

## 后端实现建议

### 第一步：稳住 transcript message 存储

继续以现有：

- `onSessionTranscriptUpdate`
- `conversation_turns.message_id`

为主线。

### 第二步：增加 logger 补强器

增加独立模块，例如：

- `src/logger-message-mapper.ts`

说明：

- 这是待新增模块，当前仓库并不存在
- 不能把它当成现有实现

职责：

- 解析 llm logger
- 识别 `user-entry` prompt
- 只在 `Conversation info (untrusted metadata)` 模板内提取 `message_id`
- 用 `message_id` 补强现有 message -> run 绑定

### 第三步：提供 session 级当前消息回查

后端需要支持：

- 按 `sessionKey` 找最近 user turn
- 找到它当前最可信的 `runId`
- 标出来源强度

### 第四步：对绑定做来源升级

同一条消息的绑定强度可能变化：

- 先 `session_fallback`
- 后升级为 `llm_prompt_metadata`
- 或 `transcript_explicit`

实现里应允许同一条消息被“升级”，而不是第一次命中后永不更新。

补充说明：

- 当前 `upsertConversationTurnByMessageId()` 还是“按 message_id 覆盖”
- 尚未实现“来源优先级升级”逻辑
- 因此这一步是明确待补能力，不是现状

来源升级算法建议直接写成规则，不要留给实现时自由发挥：

```ts
const SOURCE_PRIORITY = {
  transcript_explicit: 3,
  llm_prompt_metadata: 2,
  session_fallback: 1,
} as const;

function shouldReplaceBinding(existing: SourceKind, incoming: SourceKind): boolean {
  return SOURCE_PRIORITY[incoming] > SOURCE_PRIORITY[existing];
}
```

冲突处理规则：

1. 新来源优先级更高：允许覆盖
2. 新来源优先级相同：
   - 若 `runId` 相同，只更新补充字段
   - 若 `runId` 不同，记冲突日志，不直接覆盖
3. 新来源优先级更低：拒绝覆盖

防倒序要求：

- 所有异步补强都必须先读当前来源等级
- 不允许较晚到达的低优先来源回写覆盖高优先来源

## 绑定优先级

推荐最终优先级：

1. `transcript_explicit`
2. `llm_prompt_metadata`
3. `session_fallback`

原因：

- `transcript_explicit` 最接近持久化真相源
- `llm_prompt_metadata` 对主入口消息非常强，但依赖 logger
- `session_fallback` 只是兜底

## 实时性与准确性的职责划分

前端层负责：

- 200ms 级别内感知当前消息变化
- 立即高亮、预定位、预展开

后端层负责：

- 秒级内把绑定校正到最终结果
- 落库存档
- 提供后续查询、回放、审计

换句话说：

- 前端显示可以先“像是对的”
- 后端结果必须最终“确实是对的”

## 风险与边界

### 1. UI message id 与 transcript messageId 不一定同名

前端 websocket 里看到的 `__openclaw.id`，未必等于 transcript update 里的 `messageId`。

因此第一版不能假设两者天然一一对应。

### 2. logger 不是全场景都有

如果部署环境没有 llm logger：

- 第二层仍可运行
- 只是主入口消息绑定精度会下降到 transcript + fallback 组合

### 3. 派生 run 不应强行并入主入口消息逻辑

subagent / announce / startup / cron 必须继续保留独立规则。

## 推荐实施顺序

0. 先验证前端是否真有可靠的 websocket/history 接入点；若无，则第一版取消前端实时层
1. 先验证 logger `prompt.message_id` 与 transcript `messageId` 是否同值；若无，则增加对账层
2. 后端补 `current-message-run` 回查接口
3. 前后端先跑通“当前消息 -> fallback/resolved run”
4. 后端接入 logger 补强 `llm_prompt_metadata`
5. 在存储层补来源升级逻辑
6. 只有当前端能拿到稳定 transcript `messageId` 时，再加 `/audit/message/:messageId`

## 每步完成判据

### 第 0 步完成判据

- 已完成 control-ui 源码检查
- 已完成浏览器运行时验证
- 已明确记录“前端实时层可用 / 不可用”

### 第 1 步完成判据

- 已完成 logger/transcript ID 对账
- 已明确记录“同命名空间 / 不同命名空间”

### 第 2 步完成判据

- `current-message-run` 接口已返回完整契约
- `resolved/pending/fallback/none` 四类状态可复现

### 第 3 步完成判据

- 当前消息能稳定定位到一个 run 或明确返回 `none`
- 前端在无命中时不会卡在等待态

### 第 4 步完成判据

- logger 补强命中普通用户入口 run
- 不误命中 subagent/startup/cron/slug

### 第 5 步完成判据

- 已实现来源升级规则
- 低优先来源无法覆盖高优先来源
- 同级不同 runId 会触发冲突日志

## 最终结论

双层设计是当前最合理的路线：

- 前端 websocket/history 负责“快”
- 后端 transcript/logger 负责“准”

这样既不会为了追求实时性牺牲审计准确性，也不会为了追求真相源把 UI 做成总是慢一拍。
