# LLM API Logger Message Mapping Research 2026-04-02

## 目的

研究 `projects-ref/openclaw-llm-api-logger/logs/2026-03-30.jsonl` 是否能为 ClawLens 提供比“sessionKey + 时序推断”更强的 message 级关联能力。

结论先行：

- 这份日志对“直接由用户消息触发的主 run”有很强的 message 关联价值。
- 关键不是 header，而是 request 里的 `prompt`。
- 在这份样本里，大部分普通用户入口 run 的 `prompt` 直接包含 `message_id` 和用户原始消息文本。
- 但 subagent、announce、startup、cron 这类派生 run 不遵守同一模式，不能用同一条规则强绑。

## 样本范围

- 文件：`projects-ref/openclaw-llm-api-logger/logs/2026-03-30.jsonl`
- 总行数：`166515`
- 可识别 header 条数：`47`
- 唯一 `runId`：`47`
- 唯一 `sessionId`：`8`
- provider：全部为 `minimax-cn`
- model：全部为 `MiniMax-M2.7-highspeed`

## 记录结构规律

每条记录由三段组成：

1. 单行 header JSON
2. `------`
3. 多行 request 文本
4. `------`
5. 多行 response 文本

其中：

- header 是合法 JSON，可稳定解析
- request/response 整体通常不是合法 JSON
- 失败原因不是字段缺失，而是正文里的原始换行破坏了 JSON 字符串转义
- 但顶层字段顺序相对稳定，仍可用正则或分段提取

## Header 层能提供什么

header 可稳定提取：

- `timestamp`
- `provider`
- `model`
- `runId`
- `sessionId`
- `durationMs`
- `status`

但 header 本身不包含：

- `message_id`
- 用户原始消息文本
- transcript message 的显式映射信息

所以如果只看 header，仍然只能做到 run/session 粒度，做不到 message 粒度。

## Request 层的关键规律

### 1. `prompt` 是最关键字段

在这份样本里，47/47 条 request 都能稳定提取出 `prompt` 段。

其中 40 条属于“直接用户入口”模式，开头形态基本一致：

```text
Conversation info (untrusted metadata):
```json
{
  \"message_id\": \"openclaw-weixin:...\",
  \"timestamp\": \"Mon 2026-03-30 ...\"
}
```

<用户原始消息文本>
```

这意味着对这 40 条 run，可以直接从 logger request 提取：

- `message_id`
- 用户原始消息文本
- 触发该 run 的入口时间

这比单靠 `sessionKey + started_at` 近似匹配强很多。

### 2. `message_id` 覆盖率很高，但不是全覆盖

在本样本中：

- 可提取 `prompt`：`47/47`
- `prompt` 中可提取 `message_id`：`40/47`

缺失 `message_id` 的 7 条并不是“异常损坏”，而是语义上不属于普通用户入口 run。

### 3. 缺失 `message_id` 的 run 有固定类型

这 7 条主要落在下面几类：

- subagent task
- subagent completion announce
- startup / reset 初始化 run
- cron / lobster 触发的自动任务
- slug 生成这类辅助 run

也就是说，`message_id` 缺失不是随机问题，而是 run 类型差异。

## Prompt 形态分类

对 47 条记录按 `prompt` 开头分类，可得到：

- `user-entry`: `40`
- `subagent-task`: `2`
- `subagent-announce`: `2`
- `other`: `3`

`other` 里包括：

- `/new` 或 `/reset` 触发的 startup run
- cron/lobster 自动任务
- slug generator 这类辅助场景

这说明 logger 的 request `prompt` 本身已经带有“run 来源类型”的强信号，不仅能做 message 映射，也能做 run 分类。

## 对 message 关联最重要的发现

### 1. 可直接提取 message_id

样本中可稳定提取出如下映射：

- `runId=6b8a4a58-...` -> `message_id=openclaw-weixin:1774876092473-7691e6e6`
- `runId=3ade628b-...` -> `message_id=openclaw-weixin:1774876204709-05d5d924`
- `runId=a8d59782-...` -> `message_id=openclaw-weixin:1774876278494-4df8d5fe`

这已经是“显式边”，不是时序猜测。

### 2. 可直接提取用户原始文本

同一段 `prompt` 里，metadata block 后面紧接着就是用户消息原文，例如：

- `用subagent方式 帮我查下当前装了哪些skill`
- `当前上下文多少`
- `是两个session id么 为啥cache hit提高了 不应该独立的么`

所以如果 transcript 侧拿到了 `message_id` 或消息文本，理论上可以和 logger 里的 run 做强匹配。

### 3. `historyMessages` 也有辅助价值

这份样本里约 `42/47` 条 request 还能提取出 `historyMessages` 段。

其中可观察到：

- 经常包含 `compactionSummary`
- 说明 logger request 记录的是“完整送给模型的上下文片段”
- 可用于理解为何某次 run 的 prompt 里出现某些上下文，但它不是 message-run 绑定的首选字段

原因是：

- `historyMessages` 更适合解释上下文来源
- `prompt.message_id` 更适合做入口消息绑定

## Response 层规律

response 一侧在样本中也较稳定：

- `assistantTexts`：`47/47`
- `lastAssistant`：`47/47`
- `thinking` block：`47/47`
- `text` block：`47/47`
- 可见 tool-use 痕迹：约 `13/47`

这说明 logger 不仅能辅助“用户消息 -> run”，也可能反向辅助“run -> 最终 assistant 输出摘要”。

但对当前 ClawLens 目标来说，response 的优先级低于 request `prompt`。

## 这对 ClawLens 的实际意义

### 可以解决的部分

如果 ClawLens 能访问同源 llm-api-logger 数据，或在运行时保存等价字段，那么对普通用户入口消息，可以不再只依赖：

- `sessionKey`
- `active run`
- `started_at` 时序近似

而是优先使用：

- `message_id`
- 用户原文
- runId

这已经足以把大量“主对话入口消息 -> 主 run”映射做成强绑定。

### 仍然不能自动解决的部分

下面这些 run 仍然不能只靠同一条规则绑定：

- subagent task run
- subagent announce run
- startup/reset run
- cron/lobster 自动触发 run
- 其他非用户直接输入触发的辅助 run

所以正确策略不是“所有 run 都改成靠 llm logger 绑定”，而是分层：

1. 普通用户入口 run：优先用 `prompt.message_id`
2. 派生 run：继续保留上层 runtime 规则或专门的派生关系规则

## 对之前研究结论的修正

之前的结论是：

- 单靠排序不能提供真正强绑定
- 普通用户消息缺少 `runId` 时，只能靠 session/timing 近似归属

这份 logger 研究说明应当修正为：

- 如果能读取 llm-api request `prompt`，普通用户消息未必缺少显式关联边
- 它可能没有 `runId`，但已经有 `message_id`
- 因此“用户消息 -> run”可以走 `message_id`，不必只靠时序

真正仍然缺显式边的是：

- 非用户直接入口的派生 run
- 或无法拿到这份 logger 的部署环境

## 实施建议

建议把后续实现拆成两层：

### 第一层：优先利用 logger 提升主消息绑定精度

对普通 chat 入口消息：

- 从 llm logger request `prompt` 提取 `message_id`
- 建立 `message_id -> runId` 索引
- ClawLens 前端或后端按 `message_id` 回查 run

这条路径优先级高，因为：

- 样本中覆盖率高
- 精度高
- 对主对话场景价值最大

### 第二层：继续保留派生 run 专项规则

对没有 `message_id` 的 run：

- subagent task / announce
- startup
- cron / lobster

继续使用：

- runtime 派生关系
- explicit run metadata
- session + time 窗口规则

而不是强行套用 message logger 规则。

## 当前边界

这份研究仍有两个边界：

1. 只验证了 `2026-03-30.jsonl` 这一天样本，尚未证明所有日期、所有 provider 都一致
2. 当前仓库里的参考 logger 是离线日志，不等于 ClawLens 生产环境已天然可访问同样数据

所以更准确的结论是：

- 这条路径技术上可行，且样本证据很强
- 但仍需决定 ClawLens 是直接接 logger、复刻同等字段、还是在 OpenClaw 上游补结构化事件

## 最终结论

`llm-api-logger` 的这份日志表明：

- 对普通用户入口消息，message 级强绑定并不一定要靠上游新增 `runId`
- 现有 request `prompt` 中已经稳定嵌入 `message_id + 用户原文`
- 因此主消息关联可以优先走“解析 llm api 日志/请求”的路线

但这条路线不能覆盖所有 run 类型。

最合理的整体方案不是单一路径，而是：

- 主入口消息：`message_id -> runId`
- 派生 run：runtime/source-specific 规则

这比单靠排序或单靠 session/timestamp 推断更强，也更符合当前样本数据的实际结构。
