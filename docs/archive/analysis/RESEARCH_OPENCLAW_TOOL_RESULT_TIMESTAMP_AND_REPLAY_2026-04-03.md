# OpenClaw Tool Result Timestamp And Replay Research

本研究补充回答两个关键问题：

1. `toolResult` 是否带时间戳
2. 时间戳是否真的会传给模型，足以让模型稳定判断“旧结果”和“新结果”

## 结论

- `toolResult` 在 session / transcript 结构里有 `timestamp`
- 但当前 OpenClaw 在把历史消息转换成 provider 输入时，**没有把 `timestamp` 传给模型**
- 因此，不能把“旧成功结果 + 新失败结果”并存时的正确判断，寄托在模型自己依据时间戳完成

一句话总结：

- **系统内部有时间**
- **模型输入里没有显式时间**

## 关键结论

### 1. `toolResult` 本身带时间戳

在 transcript / session message 结构中，`toolResult` 与 `user`、`assistant` 一样，属于消息对象的一种。

当前消息结构可带：

- `timestamp`
- `toolCallId` / `toolUseId`
- `role = "toolResult"`

这意味着从系统内部角度看，OpenClaw 有足够信息区分：

- 哪条工具结果先产生
- 哪条工具结果后产生

### 2. `exec` 失败时不会回退到旧值

对 `cat deleted-file` 这类命令，当前实现不是“空值时沿用旧值”，而是：

- 成功但无输出：通常写成 `"(no output)"`
- 执行失败：写成失败原因文本，并标记失败状态

所以旧内容之所以还会继续影响回答，不是因为新结果被错误赋值，而是因为：

- 旧成功 `toolResult` 还留在 history
- 新失败 `toolResult` 也写进了 history
- 后续 replay 时两者都可能进入模型上下文

### 3. 当前 replay 转换层没有把 `timestamp` 带给模型

OpenAI Responses/WebSocket 路径中，核心转换在：

- `projects-ref/openclaw/src/agents/openai-ws-message-conversion.ts`

其中：

- `user` 转成 `message`
- `assistant` 转成 `message` / `function_call`
- `toolResult` 转成 `function_call_output`

但转换时只保留了：

- `role`
- `content`
- `toolCallId` / `toolUseId`

没有把 `timestamp` 一起传出去。

所以模型看到的是：

- 若干条历史消息
- 若干条工具输出

而不是：

- 带可直接比较时间顺序的显式消息元数据

### 4. `timestamp` 当前主要用于系统内部逻辑

例如：

- compaction 相关清洗
- usage snapshot 清理

这些逻辑会读取 message timestamp，但它们是系统内部的 replay / compaction 处理，不代表 provider payload 里会保留该字段。

## 对问题的意义

这说明当前错误回答不是：

- “模型明明拿到了时间信息却还判断错”

而更像是：

- “系统把旧成功结果和新失败结果一起 replay 给模型”
- “模型缺少显式时间信号，只能在冲突语义里自己猜”

所以该问题的主因仍偏系统，而不是单纯模型失误。

## 对解决方案的约束

基于这一点，后续解决方案应遵守：

1. 不能假设模型会自动按时间顺序采信历史 `toolResult`
2. 需要在 replay 前由系统先做降权或过滤
3. 不能因为当前轮是空结果或失败结果，就回退去信任历史旧成功结果

## 相关信息来源

- `projects-ref/openclaw/src/agents/bash-tools.exec.ts`
- `projects-ref/openclaw/src/agents/tools/common.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-subscribe.tools.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-subscribe.handlers.tools.ts`
- `projects-ref/openclaw/src/agents/openai-ws-message-conversion.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/google.ts`
- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
