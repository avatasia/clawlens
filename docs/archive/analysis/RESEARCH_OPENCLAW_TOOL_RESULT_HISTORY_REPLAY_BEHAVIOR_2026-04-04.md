# OpenClaw Tool Result History Replay Behavior

本文件记录以下问题的研究结论：

- `userPrompt` 与 `historyMessages` 的职责分工
- 当前轮 `toolResult` 如何进入后续 replay
- 为什么“当前轮工具结果正确”不代表“后续轮仍然不会被污染”
- 指定 `llm-api` 日志中 `openclaw-qqbot` 错误回答是如何形成的

## 结论摘要

1. `userPrompt` 承载当前这一轮的新用户输入。
2. `historyMessages` 承载当前 session 中已经累计的历史消息，不只包含当前 turns，也包含前几轮 run 的消息。
3. 当前轮工具调用得到的 `toolResult` 会先参与当前轮回答；当前轮结束后，它又会写入 session history，并在后续轮次里作为 `historyMessages` 被 replay。
4. 因此，当前轮 fresh `toolResult` 通常更可靠；真正容易出错的是后续轮次里，旧 `toolResult`、旧 assistant 结论与新结果一起进入 replay 时的上下文污染。
5. 在指定日志样本中，`@tencent-connect/openclaw-qqbot` 的错误回答并不是因为当前轮重新读取了正确配置，而是：
   - 早前对 `global:openclaw-qqbot/dist/index.js` 发生误解
   - 错误结论进入 session history
   - 后续轮次没有重新核验工具输出，直接复述了旧错误结论

## 1. `userPrompt` 与 `historyMessages`

一次 LLM 请求可以理解成两部分：

- `userPrompt`
  - 当前这一轮刚收到的用户输入
- `historyMessages`
  - 当前 session 里此前已经存在的历史消息

所以：

- 当前轮问题放在 `userPrompt`
- 过去轮次的 `user` / `assistant` / `toolResult` 会出现在 `historyMessages`

这意味着 `historyMessages` 不是“当前 run 的局部消息”，而是“当前 session 的历史上下文”。

## 2. 当前轮 `toolResult` 如何变成历史污染源

当前轮里，工具调用流程本身没有问题：

1. assistant 发出 `toolCall`
2. 工具执行
3. 产生新的 `toolResult`
4. 模型基于新的 `toolResult` 完成当前轮回答

但当前轮结束后，上述消息会写入 session history。

到了下一轮：

- 这些上一轮的 `toolResult`
- 会以 `historyMessages` 的一部分重新进入模型上下文

所以真正的污染点不是“当前轮工具执行”，而是：

- 旧 `toolResult`
- 在后续 replay 中继续作为历史消息进入模型

## 3. 为什么“当前轮答对”不代表问题已消失

如果当前轮刚执行了 fresh tool call，模型通常更容易答对。

但后续轮次可能出现这种情况：

- 旧成功 `toolResult`
- 新失败 `toolResult`
- 旧 assistant 错误结论

一起出现在 `historyMessages`

此时系统并不会自动替模型做“旧结果失效”判断。

因此：

- 当前轮答对，只能说明这次新结果被模型优先采用
- 不能说明 replay 污染已经被系统层消除

## 4. 指定 `openclaw-qqbot` 错误回答是如何发生的

在指定日志样本中，错误链路可以拆成两步。

### 4.1 第一层错误：对 `global:` 的语义误读

日志里早前出现了类似输出：

- `global:openclaw-qqbot/dist/index.js`

模型把它误解成：

- 真实安装路径就是 `~/.openclaw/extensions/openclaw-qqbot/...`

但这一步并不是当前工具输出明确给出的事实，而是模型对来源标识做了过度推断。

### 4.2 第二层错误：旧错误结论进入 session history

之后用户再追问：

- 你怎么知道装了 `@tencent-connect/openclaw-qqbot`

日志里这轮没有新的 fresh tool check 去重新读取配置，
而是直接输出了：

- “从 `openclaw.json` 看到 `installs.openclaw-qqbot` ...”

这说明：

- 当前轮并不是 fresh 核验后得出的结论
- 而是 session history 中已经存在的旧错误推断被继续复述

## 5. 对系统治理的含义

这次分析说明：

1. 仅仅过滤旧 `toolResult`，可以缓解一部分 replay 污染。
2. 但如果错误结论已经被写成 assistant 文本消息，仅处理 `toolResult` 还不够。
3. 因此后续治理需要区分两层问题：
   - 旧诊断型 `toolResult` 的 replay 污染
   - 基于旧诊断结果派生出来的 assistant 文本污染

## 当前判断

当前最稳的结论是：

- 原版 OpenClaw 当前仍会把旧 `toolResult` 保留在 `historyMessages`
- 某次没有复现错误，不代表系统已经修好
- 更可能只是模型在那一次上下文里碰巧优先采用了较新的结果

## 相关信息来源

- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md](RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md)
- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](../archive/analysis/ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
