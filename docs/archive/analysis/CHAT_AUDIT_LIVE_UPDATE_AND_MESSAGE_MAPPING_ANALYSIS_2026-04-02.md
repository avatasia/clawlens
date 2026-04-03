# Chat Audit 运行中不更新与消息关联机制分析

日期：2026-04-02

## 现象

在 Chat 页面右侧打开 `ClawLens Audit` 后，如果新的聊天请求已经发出、任务正在执行，右侧 Audit 面板通常不会立即出现变化。截图中的典型表现是：

- 聊天区已经有新的用户消息
- 任务仍在运行中
- 右侧 Audit 仍停留在一组旧的 run 卡片
- 第一条 run 里 `Timeline` / `Turns` 仍为空或保持旧状态

## 根因总结

这不是单一 bug，而是当前数据模型和前端增量协议共同导致的结果：

1. 当前增量刷新只会发现“新 run”，不会刷新“同一个 run 的新进展”
2. `Turns` 目前只在 `agent_end` 时一次性写入，不是逐条消息实时写入
3. `runs` 表中的摘要字段偏向“完结后聚合”，运行中列表统计本身就可能不变化
4. 当前 UI 没有建立“当前正在执行的 run 持续重拉 detail”的机制
5. OpenClaw 已经提供 message-level transcript update 信源，但 ClawLens 没有接入

因此，运行中任务不会在右侧持续变动，是当前实现边界，而不只是界面没刷出来。

## 代码层原因

### 1. 前端增量刷新基于 `startedAt`，不是基于 `runId` 的版本变化

Chat Audit 前端当前通过 `/audit/session/<sessionKey>?since=<latestStartedAt>` 拉增量。

这意味着它只会拿到：

- `started_at` 晚于当前列表最新一条 run 的记录

它拿不到：

- 已经在列表里的同一个 run 后续新增的 `llm_calls`
- 已经在列表里的同一个 run 后续新增的 `tool_executions`
- 已经在列表里的同一个 run 最终补上的 `conversation_turns`

所以，即使 SSE 因 `llm_call` / `tool_executed` 事件触发了前端 `refreshChatAudit()`，前端实际还是只会发：

- `?since=<latestStartedAt>`

如果当前只是“同一个 run 正在继续执行”，而不是“新 run 开始”，这次增量结果自然就是空。

### 2. `Turns` 不是实时采集的，而是 `agent_end` 才批量写入

当前 ClawLens 的 conversation turn 写入发生在：

- [collector.ts](../../../extensions/clawlens/src/collector.ts)

具体是在 `recordAgentEnd()` 中：

- 只有收到 `agent_end`
- 才把 `event.messages` 整体遍历
- 再调用 `store.insertConversationTurn(...)`

也就是说，当前 `Turns` 数据不是随着聊天过程一条条进入数据库，而是：

- run 结束后
- 一次性从 `agent_end.messages` 回填

这会带来直接后果：

- 运行中看不到当前对话对应的 `Turns`
- `Turns` 要等任务结束后才可能出现

### 3. 列表摘要字段本身就是“完结后聚合”的

当前 Audit 列表卡片上的摘要主要来自 `runs` 表中的聚合字段，例如：

- `total_llm_calls`
- `total_input_tokens`
- `total_output_tokens`
- `total_cost_usd`
- `total_tool_calls`

这些字段的核心聚合更新发生在：

- [store.ts](../../../extensions/clawlens/src/store.ts) 的 `completeRun()`

也就是说：

- 运行中的 run 即使已经产生了新的 `llm_calls`
- 或已经写入了 `tool_executions`
- `runs` 行上的摘要数字也未必同步更新

所以当前右侧列表即使被刷新，run 卡片上的统计数字仍可能看起来“没变”。

这意味着当前 UI 不只是“没拿到实时数据”，而是底层列表摘要模型本身就更偏向“事后结算”。

### 4. 当前并未使用 OpenClaw 的 transcript update 做逐条消息流式关联

OpenClaw 本身有：

- [transcript-events.ts](../../../projects-ref/openclaw/src/sessions/transcript-events.ts)

它提供：

- `onSessionTranscriptUpdate(listener)`
- update 中可带 `sessionKey`
- `message`
- `messageId`

但当前 ClawLens 并没有接这个事件。

从 [index.ts](../../../extensions/clawlens/index.ts) 看，当前只接了：

- `onAgentEvent`
- `llm_output`
- `llm_input`
- `after_tool_call`
- `agent_end`

没有：

- `onSessionTranscriptUpdate`

所以 ClawLens 目前并不知道“聊天界面上刚刚新增的是哪一条 messageId”，也没有实时订阅 transcript 的逐条变化。

更准确地说，不是系统没有 message-level 信源，而是：

- OpenClaw 已经提供了这条能力
- ClawLens 当前实现没有消费它

## 当前功能是如何关联到聊天消息的

结论先说：**当前只能做到 run 级别的弱关联，不能精确关联到聊天界面的每一条具体消息。**

### 已有的关联维度

当前 ClawLens 主要依赖这些字段做关联：

1. `sessionKey`
   - 例如 `agent:main:main`
   - 用来把某个 chat 会话和一批 run 归到同一侧栏中

2. `runId`
   - 每次 agent 执行生命周期的唯一标识
   - 所有 LLM/tool/turn 数据最终都挂在这个 run 上

3. `llm_input.prompt` 的截断预览
   - collector 在 `recordLlmInput()` 里把 prompt 前 200 字符存到 `active.lastUserPrompt`
   - 后续写进 `llm_calls.user_prompt_preview`
   - UI 顶部 run 卡片显示的其实主要是这个预览

4. `agent_end.messages`
   - 只在 run 结束时整体写入 `conversation_turns`

### 当前做不到的事

当前做不到这两件关键事：

1. 无法精确说“聊天窗口里的这条消息 = 数据库中的哪条 turn”
   - 因为数据库里没有持久化 `messageId`
   - 也没有 transcript file offset / message sequence 的直接引用

2. 无法在消息刚出现时立即把它挂到当前 run 上显示
   - 因为没有实时 transcript 监听
   - `Turns` 也是 `agent_end` 才回填

所以现在右侧 Audit 的“消息关联”本质是：

- 先按 `sessionKey` 找到这组 run
- 再按 run 的 prompt preview、执行顺序、最终 messages 回填结果来做近似展示

这不是精确的 message-level trace。

## 为什么从其他 session 切回 heartbeat 会正常一些

从其他 session 切到 `heartbeat` 时，前端会把它当成一次显式的 session 切换：

- 重新跑首屏请求
- 重新渲染列表

而“停留在 heartbeat 不变、任务继续执行”的场景里，前端更多是依赖增量刷新：

- 只查 `since=<latestStartedAt>`
- 不会把“当前同一 run 的新进展”重新拉回来

所以两种场景的观感不一样：

- 切 session：更像强制 reload
- 同 session 内运行中：更像只等新 run 出现

## 如果要实现真正的运行中动态更新，需要补哪些能力

建议分两层。

### A. 让同一个 run 在运行中可更新

至少需要补一种“按 run 刷新”的机制，而不是只靠 `since=startedAt`：

可选方案：

1. 前端在当前顶部展开 run 存在时，定时调用 `/audit/run/<runId>`
   - 优点：改动最小
   - 缺点：只能盯住一个或少数几个 run

2. 后端给 `/audit/session` 增加“包含当前活动 run 的增量模式”
   - 例如基于 `updatedAt` / `lastEventAt`
   - 而不是只基于 `startedAt`

3. SSE 直接推送某个 run 的“脏标记”
   - 前端收到后仅刷新对应 run 的 detail

### B. 实现真正的消息级关联

如果目标是“右侧每一条 turn 能对应聊天窗口里的具体消息”，那当前模型还不够，需要新增：

1. 接入 `onSessionTranscriptUpdate`
   - 监听每条 transcript 变更

2. 在存储层持久化这些字段
   - `messageId`
   - `sessionFile`
   - `timestamp`
   - 可能还需要 `messageIndex` / `source`

3. 建立 `runId <-> messageId` 关联规则
   - 最简单是按 run 生命周期窗口归属
   - 更稳的是在 agent 执行上下文里直接传 message identity

4. UI 上明确展示“该 turn 对应哪条消息”
   - 而不只是 `user/assistant/tool + preview`

## 当前最准确的结论

### 为什么任务运行中右侧 Audit 不变化

因为当前实现同时受这四件事限制：

- 前端只会增量发现“新 run”，不会刷新“同一个 run 的实时进展”
- `Turns` 只在 `agent_end` 后一次性写入
- `runs` 表摘要字段主要在 `completeRun()` 后才完整
- ClawLens 没接 OpenClaw 的 transcript update，所以没有 message-level 实时流

### 当前功能怎么关联每一条具体对话消息

目前并没有做到真正按每条具体消息精确关联。当前只能做到：

- `sessionKey` 级别归类
- `runId` 级别聚合
- 用 prompt preview 和最终 `agent_end.messages` 做弱关联展示

换句话说，现在的 Chat Audit 更准确地说是：

- **run audit**

而不是：

- **message-level audit**

## 更准确的改进优先级

如果要把当前能力从“事后 run 审计”往“运行中可观测”推进，建议优先顺序是：

1. 先补“同一 run 的实时刷新”
   - 当前展开 run 定时重拉 `/audit/run/<runId>`

2. 再补“运行中摘要”
   - 不再只依赖 `runs.total_*`
   - 运行中从 `llm_calls` / `tool_executions` 实时汇总

3. 最后接 `onSessionTranscriptUpdate`
   - 持久化 `messageId`
   - 建立 `runId <-> messageId` 映射
   - 再谈真正的逐条消息关联

## 2026-04-02 实施进展

本轮已完成前两步里的一个最小可用实现：

1. 已补“同一 run 的实时刷新”
   - 前端当前展开的 run 在 SSE 收到 `llm_call` / `tool_executed` / `transcript_turn` 后会主动重拉 detail
   - 轮询期间也会对展开中的 `running` run 继续刷新 `/audit/run/<runId>`

2. 已补“运行中摘要”
   - `RunAuditDetail.summary` 不再只依赖 `runs.total_*`
   - 运行中会实时参考 `llm_calls` / `tool_executions` 现有数据计算摘要

3. 已接 `onSessionTranscriptUpdate` 的最小实现
   - 当前会把 transcript update 中的 `messageId`、`sessionFile`、message preview 预写入 `conversation_turns`
   - 如果当前 session 存在活动 run，则按 `sessionKey -> 最新 active run` 规则挂接
   - 收到 transcript update 后会发出 `transcript_turn` SSE，促使右侧已展开 run 刷新
   - 对于“用户消息先写入 transcript、run 稍后才启动”的情况，当前增加了按 `sessionKey` 的 pending 队列
   - 这类 turn 会在下一个 `run_started` flush 时挂到新 run 上，不再直接丢失
   - 对于消息体内已自带 run 线索的 transcript message，当前会优先强绑定：
     - `openclawAbort.runId`
     - 明确可解析的 `idempotencyKey`
   - 只有缺少这些线索时，才退回 `sessionKey -> active run / pending queue` 规则

## 当前仍然保留的边界

即使接了 transcript update，当前仍然不是完整的 message-level trace，原因有两点：

1. 当前 `runId <-> messageId` 虽然比“最新 active run”更强了一步，但仍不是核心上下文直接给出的强绑定
   - 已支持“pending user turn -> 下一个 run_started”这类常见顺序
   - 已支持带 `openclawAbort.runId` / 可解析 `idempotencyKey` 的 transcript message 优先强绑定
   - 但跨 run 并发、普通用户消息缺少 run 元数据、异常重放等边界场景仍可能只能近似归属

2. `agent_end.messages` 现在只作为 fallback
   - 如果 transcript update 已经提前写入过 turn，结束时不再重复回填
   - 这避免了重复，但也意味着当前实现更依赖 transcript 流的完整性
