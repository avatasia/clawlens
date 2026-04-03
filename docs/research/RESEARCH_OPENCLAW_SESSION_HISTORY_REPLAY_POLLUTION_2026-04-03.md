# OpenClaw Session History Replay Pollution Research

本研究记录一个具体问题的证据链：

- 用户在 Discord 中提问
- 回答却延续了已经过期的 `openclaw-qqbot` 信息
- 需要判断来源究竟是模型幻觉、跨渠道读取，还是 OpenClaw 本地历史 / tool result replay

## 结论

当前证据更支持：

- 不是 Discord 直接读取 `qqbot/data`
- 不是单纯模型幻觉
- 而是同一个 agent/session 的旧 `toolResult` 与旧 assistant/user 消息已经写入 session transcript
- 后续 run 在 prompt 构造前又把这些历史消息 replay 进模型
- 模型据此继续回答，于是延续了过期结论

一句话总结：

- 这是 **stale session history + replay pollution**
- 不是 **cross-channel data access**

## 关键证据

### 1. 当前运行配置里已不存在外部 `openclaw-qqbot`

远端当前生效配置与插件目录显示：

- `plugins.installs` 中已无 `openclaw-qqbot`
- `~/.openclaw/extensions/` 下也没有 `openclaw-qqbot`

这说明错误回答不是因为“旧外部插件仍被当前运行时加载”。

### 2. 当前 Discord 相关 session transcript 中已经固化了旧信息

远端 `~/.openclaw/agents/main/sessions/*.jsonl` 的当前非 reset 文件里，能够直接看到：

- 旧的用户/助手消息讨论 `openclaw-qqbot`
- 旧的 `toolResult`
- 旧的技能路径：
  - `~/.openclaw/extensions/openclaw-qqbot/...`
- 旧的插件列表输出：
  - `global:openclaw-qqbot/dist/index.js`

这说明过期信息已经进入当前 session 的 transcript/history。

### 3. `llm-api` 日志显示模型确实消费了本地工具输出

远端 `~/.openclaw/logs/llm-api/*.jsonl` 中可见，当时模型在该会话链路里执行过本地工具，例如：

- `openclaw plugins list`
- 读取 `openclaw.json`
- 读取本地插件相关文件

这些 `toolResult` 中确实出现过过期的 `openclaw-qqbot` 信息。  
这说明错误回答至少部分来源于：

- 旧 tool output
- 旧 session history

而不是模型“凭空捏造”。

### 4. OpenClaw 的 replay 路径会把 session history 重新送回模型

参考本地 OpenClaw 源码：

- `projects-ref/openclaw/src/gateway/session-utils.fs.ts`
  - `readSessionMessages()`
  - 会把 transcript 中的 `message` 行读出，并附加 `__openclaw.seq`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
  - run 前会对 `activeSession.messages` 调用 `sanitizeSessionHistory(...)`
  - 然后 `validateReplayTurns(...)`
  - 再把结果用于后续模型调用
- `projects-ref/openclaw/src/agents/pi-embedded-runner/google.ts`
  - `sanitizeSessionHistory(...)` 主要做结构性清洗，不会因为某条历史消息“语义过期”而删除它

也就是说：

- 只要旧消息 / 旧 `toolResult` 还在 session history 里
- 它们就可能继续被 replay

## 为什么不是 “Discord 读了 qqbot/data”

这条解释不够成立，原因是：

- 问题发生在 Discord 会话
- 直接证据已经足够说明该会话自己的 history 中就含有过期内容
- 不需要引入“跨渠道直接读取 `qqbot/data`”这个更强、更难成立的假设

`qqbot/data/ref-index.jsonl` 只能说明：

- QQ 侧也保留了旧知识

但这次 Discord 错答的更直接来源，是：

- 当前会话自己的历史 transcript
- 以及历史 tool output

## 当前清洗逻辑的边界

`sanitizeSessionHistory(...)` 当前能处理的是：

- 图片与 thinking 块清洗
- tool use / tool result 配对修复
- orphaned `toolResult` 清理
- `toolResult.details` 剥离
- provider 兼容性相关 replay 清洗

但它不会自动识别：

- 某条 `toolResult` 语义上已经过期
- 某条 assistant 结论依赖的本地状态已失效

所以这类“旧诊断输出污染后续回答”的问题，当前仍可能发生。

## 对 ClawLens / 当前项目的意义

这条研究对当前项目有两点现实价值：

1. 它解释了为什么“明明运行状态已变，模型仍会复述旧结论”
2. 它提示后续审计时不能只看当前配置，还要看：
   - 当前 session transcript
   - 历史 `toolResult`
   - replay / compaction 是否把旧内容继续送入模型

## 后续建议

### 1. 先做止血

对已受污染的 session：

- 重置或切换到新 session
- 避免继续沿用已包含旧 `openclaw-qqbot` 信息的历史链

### 2. 再研究长期方案

优先研究：

- 哪些类型的 `toolResult` 属于“高风险易过期”
- replay 前是否应对这类诊断型输出做额外过滤或降权

重点候选包括：

- `openclaw plugins list`
- 本地配置快照
- 一次性的安装 / 升级 / 迁移诊断输出

## 相关信息来源

- `projects-ref/openclaw/src/gateway/session-utils.fs.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/google.ts`
- `docs/research/RESEARCH_OPENCLAW_TOOL_CALL_FLOW.md`
- 远端：
  - `~/.openclaw/logs/llm-api/*.jsonl`
  - `~/.openclaw/agents/main/sessions/*.jsonl`
