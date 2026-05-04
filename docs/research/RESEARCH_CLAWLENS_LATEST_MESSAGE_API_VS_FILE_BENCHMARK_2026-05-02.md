# ClawLens Latest Message API vs File Benchmark

本文记录 2026-05-02 对“获取当前 session 最新消息”两种路径的远端实测对比：

1. 通过 OpenClaw gateway API / RPC 获取
2. 直接读取 transcript JSONL 文件尾部获取

目的不是替代功能设计文档，而是给后续“默认主路径”和“fallback 开关”选择提供实证依据。

## 测试问题

对于“读取当前 session 的最新消息”这类能力，哪条路径更快、更适合作为默认主路径：

- API 路径：`chat.history(sessionKey, limit=1)`
- file 路径：直接读取 `sessionFile` 尾部最后一条 JSONL message

## 测试环境

- 日期：2026-05-02
- 目标：远端 OpenClaw gateway
- 连接方式：loopback backend gateway client
- 会话类型：独立临时 dashboard session
- transcript 位置：
  - `~/.openclaw/agents/main/sessions/<sessionId>.jsonl`

## 测试方法

1. 创建临时 dashboard session
2. 发送一条短消息，并等待 assistant 返回固定 ack
3. 对同一条 session 重复 30 次：
   - 调用 `chat.history(sessionKey, limit=1)`
   - 直接 tail `sessionFile` 最后一条 JSONL message
4. 分别记录：
   - median
   - avg
   - min
   - max
   - 返回的最新消息文本是否一致

file 路径使用的是“读取尾部 64 KiB 并解析最后一条非空 JSONL line”的实现，而不是全文件扫描。
这是一条独立 benchmark 探针，用来比较“理想的 file-first latest-message 路径”和 gateway API 的性能差异；它不等同于当前 `extensions/clawlens/src/source-resolver.ts` 的生产实现。

## 实测结果

- API:
  - method: `chat.history(sessionKey, limit=1)`
  - median: `22.79ms`
  - avg: `25.57ms`
  - min: `13.44ms`
  - max: `52.29ms`

- file:
  - method: `direct tail sessionFile last jsonl line`
  - median: `0.27ms`
  - avg: `0.28ms`
  - min: `0.17ms`
  - max: `0.92ms`

- 差值：
  - file 比 API 的 median 快约 `22.51ms`

- 语义一致性：
  - 两条路径都返回同一条最新 assistant 文本
  - 本轮样本中未出现“file 更快但语义不一致”的情况

## 解释

在当前远端环境中：

1. file 路径明显更快
   它绕过了 gateway 层 RPC、history projection、鉴权/序列化开销，只做本地文件尾部读取与一条 JSONL 解析。

2. API 路径更重
   `chat.history` 不只是“读最后一行”，而是经过 host 侧历史读取与 projection 逻辑再返回。

3. 对“当前 session 最新消息”这个具体问题，file 路径已经足够
   只要已有可信 `sessionFile`，直接读取文件尾部是更好的默认主路径。

4. 与当前生产实现的关系
   当前 ClawLens 的 `source-resolver.ts` 主要服务 message/tool source lookup，仍采用有界顺序扫描与 typed miss 语义；它还没有单独实现“tail 最后一条消息”的专用 fast path。

## 推荐结论

### 结论 A

默认主路径应优先使用 file。

更具体地说：

- 当系统已经持有可信 `sessionFile`
- 且目标只是获取“当前 session 最新消息”

优先直接读取 transcript 文件尾部。

### 结论 B

API 路径应保留为 fallback，而不是默认主路径。

### 结论 C

如果后续实现中要启用 API fallback，必须把启用原因写清楚，避免几年后回看时误以为“API 和 file 只是两种等价实现”。

建议文档里明确把 API fallback 的启用原因限定为以下几类：

1. 当前记录没有可用 `sessionFile`
2. 运行环境不允许直接读取 transcript 文件
3. 需要 host 侧 projection / sanitization 语义，而不是原始 JSONL 最新 entry
4. 文件路径在 reset / delete / compaction 生命周期后已失效，需要先借助 host 侧能力辅助定位

## 与 reset / archive 结论的关系

这个 benchmark 只回答“当前 session 最新消息谁更快”，不回答“reset 后旧消息去哪里找”。

对于 reset / deleted / checkpoint 相关历史 source：

- file 仍然是更稳的证据源
- API 侧在 reset 后会只暴露当前会话的最新可见状态

因此：

- “当前最新消息”优先 file
- “旧 transcript source replay”也优先 file
- API 更适合作为能力缺失时的 fallback，不适合作为默认主路径

## files

- `docs/plans/IMPLEMENTATION_CLAWLENS_REMOTE_VALIDATION_PREP_2026-05-01.md`
- `docs/research/RESEARCH_CLAWLENS_SOURCE_LOOKUP_ROOTS_AND_RESET_BEHAVIOR_2026-05-01.md`
- `extensions/clawlens/src/source-resolver.ts`
