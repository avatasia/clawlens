# Chat Audit 排序与精确关联研究

日期：2026-04-02

## 研究目标

回答两个问题：

1. ClawLens 当前监听到的 LLM / transcript 数据，是否仅靠入库时间就能精确关联到每条消息？
2. OpenClaw 是否存在可复用的线性排序规则，帮助建立更强的 `runId <-> messageId` 映射？

## 结论摘要

结论是：

- OpenClaw **存在线性排序规则**
- 但它不是“全局统一序”
- 而是至少分成两套不同语义的序：
  - **session 内 transcript message 顺序**
  - **run 内 chat 事件顺序**

因此，仅靠 ClawLens 当前记录的 `llm_calls.started_at` 或简单“按时间入库”排序，**还不能天然做到精确消息关联**。

更准确地说：

- `llm_output` / `tool_executed` 更接近 **run execution timeline**
- transcript update / session history 更接近 **session conversation timeline**

两者相关，但不是同一条序列。

## 研究结果

### 1. Session transcript/history 是 session 内线性有序

OpenClaw 在 session history 读取与 SSE 推送时，会给 transcript message 附加：

- `__openclaw.id`
- `__openclaw.seq`

关键代码：

- [sessions-history-http.ts](../../../projects-ref/openclaw/src/gateway/sessions-history-http.ts)
- [session-utils.fs.ts](../../../projects-ref/openclaw/src/gateway/session-utils.fs.ts)

从这些实现可以看出：

- `seq` 是基于 **当前 session transcript message 的顺序** 生成
- `cursor` 也是按 `seq` 做分页
- SSE history update 追加消息时，也会继续沿用同一个 session 的 `seq`

所以这套序是：

- **session 内单调递增**
- **只对该 session 有意义**
- **不是全局跨 session 的统一序**

这条规则对后续很重要，因为它说明：

- 同一 session 中，message 的前后关系是稳定可恢复的
- 但不能拿它跨 session 比较先后

### 2. Chat 流里的 `agentRunSeq` 是 run 内事件序，不是 transcript 序

OpenClaw chat websocket/gateway 路径里有另一套序：

- `agentRunSeq: Map<string, number>`

关键代码：

- [chat.ts](../../../projects-ref/openclaw/src/gateway/server-methods/chat.ts)
- `nextChatSeq(...)`

这套 `seq` 用于：

- 某个 run 在 chat 流里发出的 started / delta / final 等事件排序

它的语义是：

- **单个 run 内事件顺序**
- 不等同于 transcript message 的 `__openclaw.seq`

所以需要明确区分：

1. transcript message seq
   - session 维度
   - 面向会话历史

2. chat run seq
   - run 维度
   - 面向流式执行事件

这两套序不能直接混用。

### 3. transcript update 已经携带 message identity，但不天然携带 run identity

OpenClaw 的 transcript update 来源：

- [transcript-events.ts](../../../projects-ref/openclaw/src/sessions/transcript-events.ts)

它会发出：

- `sessionFile`
- `sessionKey`
- `message`
- `messageId`

这说明 OpenClaw 对“每条会话消息”的身份已经有：

- `messageId`

但普通 transcript update 并不会稳定直接给出：

- `runId`

也就是说：

- **message identity 已有**
- **run identity 不是天然齐备**

这正是 ClawLens 当前还做不到“绝对精确强绑定”的根本原因。

### 4. 某些 transcript message 的确带有 run 线索

虽然普通消息没有稳定 `runId`，但部分特殊消息体里已经有可用线索：

1. abort / injected assistant message
   - 带 `openclawAbort.runId`

2. 一些消息的 `idempotencyKey`
   - 本身就是 `runId`
   - 或者是 `${runId}:assistant`

这些线索来自：

- [chat-transcript-inject.ts](../../../projects-ref/openclaw/src/gateway/server-methods/chat-transcript-inject.ts)
- [chat.ts](../../../projects-ref/openclaw/src/gateway/server-methods/chat.ts)

所以这类消息可以做到：

- **message -> run 的强绑定**

但这只是局部，不覆盖所有普通用户消息。

### 5. 为什么单靠 LLM 入库时间仍然不够

表面上看，ClawLens 已经记录了：

- `llm_calls.started_at`
- `tool_executions.started_at`
- `conversation_turns.timestamp`

似乎可以按时间拼起来。

但这里至少有四个问题：

1. transcript message 可能先于 `run_started`
   - 尤其 webchat 用户输入路径
   - 用户消息先写 transcript，再启动 run

2. `Turns` 原本不是实时写入
   - 直到后续接入 transcript update 之后才开始提前预写

3. `llm_output` 是 run 级累计 usage
   - 不是逐 token、逐条 message 的细粒度因果链

4. 一旦未来一个 session 内允许并发 run
   - 单纯“最近时间靠近”会退化成近似归属

所以：

- **时间排序是必要条件**
- **不是充分条件**

## 对 ClawLens 现状的影响

结合本轮已实现的能力，ClawLens 当前已经做到：

1. transcript update 预写入 turn
2. pending queue 处理“消息先到、run 后到”
3. 特殊消息优先使用 `openclawAbort.runId` / `idempotencyKey` 强绑定
4. 运行中的展开 run 可持续刷新

但仍然存在一个核心空洞：

- 普通用户消息如果没有显式 run 线索
- 就只能依赖 `sessionKey + 时序` 做归属

因此当前系统更准确地说是：

- **半强绑定**

而不是：

- **全量强绑定**

## 更深层的结论

如果目标是“精确到每条消息的强关联”，最可行的路线不是继续在 ClawLens 侧无限增加推断规则，而是让 OpenClaw 上游显式暴露：

- transcript message 对应的 `runId`

或者至少暴露：

- message append 时的 run context

原因很简单：

- session 内线性序已存在
- message identity 已存在
- 现在缺的不是顺序，而是 **message 与 run 的显式边**

## 后续执行建议

建议分三步推进：

1. 保留当前 ClawLens 侧的增强规则
   - transcript pending queue
   - 特殊消息优先强绑定
   - 运行中展开项刷新

2. 在 OpenClaw 上游调研并设计 run-aware transcript metadata
   - 普通 user / assistant transcript append 时，是否能携带 `runId`
   - 或最小化增加 `originRunId`

3. 一旦上游可提供 run-aware message metadata
   - ClawLens 直接以 `messageId + runId` 持久化
   - 取消大部分近似归属逻辑

## 当前最准确的判断

回答原问题：

### “监听的 llm 日志按时间入库，这还不能精准吗？”

还不能保证精准。

原因不是“没有顺序”，而是：

- OpenClaw 的顺序是 **session 内线性序**
- ClawLens 的 llm/tool 数据是 **run 执行序**
- 现在缺的是 **message 与 run 的显式绑定**

所以仅靠时间和排序，只能显著提高准确率，不能从根上保证强一致关联。

### “OpenClaw 的排序是 session 内有序还是全局有序？”

当前能确认的是：

- **session transcript/history 是 session 内有序**
- **chat run 流事件是 run 内有序**
- **没有看到一个可直接拿来做 message-run 全局统一排序的单一全局序**
