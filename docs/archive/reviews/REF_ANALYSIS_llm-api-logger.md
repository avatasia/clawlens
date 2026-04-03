# `openclaw-llm-api-logger` 参考项目复核

> 复核时间：2026-04-01
> 证据源：`projects-ref/openclaw-llm-api-logger/` 与 `projects-ref/openclaw-llm-api-logger/logs/2026-03-30.jsonl`

## 结论摘要

1. 参考项目的核心模式是正确的：用 `runId` 关联 `llm_input` 与 `llm_output`，记录的是 per-run 请求/响应。
2. 它不能作为 ClawLens 瀑布图的 per-call 方案参考，因为它采集的本来就是 per-run 数据。
3. 该项目自身有三处明确缺陷：配置读取方式不规范、日志格式被 `replace(/\\n/g, '\n')` 破坏、`pendingWrites` 清理逻辑无效。
4. 2026-03-30 样本日志中共有 47 条 header 记录，header 可稳定解析，但正文经常不再是合法 JSON。

## 一、可借鉴部分

### 1. `runId` 关联模式是成立的

证据：

- `projects-ref/openclaw-llm-api-logger/index.ts:45-52`
- `projects-ref/openclaw-llm-api-logger/index.ts:74-131`

结论：

- `llm_input` 时把请求缓存到 `inFlightRequests`。
- `llm_output` 时按同一 `runId` 取回并写日志。
- 这个模式适合 per-run 请求/响应关联。

边界：

- 它只能证明 `llm_input`/`llm_output` 共享 runId。
- 它不能推出 `llm_output` 是 per-call；参考项目自己也没有这么实现。

### 2. 参考日志确实记录了 response.usage

证据：

- `projects-ref/openclaw-llm-api-logger/index.ts:121-125`

结论：

- logger 直接把 `event.usage` 放进 `response.usage`。
- 因此日志里出现的 `usage.cost`，来源是运行时 hook event，而不是 logger 额外计算。

## 二、已确认问题

### P1-1 配置读取没有使用 `api.pluginConfig`

证据：

- `projects-ref/openclaw-llm-api-logger/index.ts:24-33`
- `projects-ref/openclaw-llm-api-logger/index.ts:60-63`

结论：

- 参考项目手动从 `api.config?.plugins?.entries[...]` 取配置。
- 这绕过了 OpenClaw 已经提供好的 `api.pluginConfig`。
- ClawLens 当前用 `api.pluginConfig`，这点比参考项目规范。

### P1-2 日志格式被换行替换破坏

证据：

- `projects-ref/openclaw-llm-api-logger/logger.ts:113-145`

结论：

- `formatEntry()` 先做 `JSON.stringify(...)`，再对整个字符串执行 `.replace(/\\n/g, '\n')`。
- 一旦 request/response 中原本有字符串换行，输出就会出现未转义真实换行。
- header 仍是一行合法 JSON，但 request/response 段常常不再能 `JSON.parse`。

直接影响：

- 该文件不是标准 JSONL。
- 也不能继续被描述成“稳定的三段 JSON 记录”，更准确的说法是“三段文本记录，其中 header 通常仍可结构化解析”。

### P1-3 `pendingWrites` 清理代码无效

证据：

- `projects-ref/openclaw-llm-api-logger/logger.ts:246-258`

结论：

- Promise 实例没有可读的 `.status` 字段。
- 该过滤逻辑不会得到真实 pending 状态。
- 文档中若写“参考项目有成熟写入队列回收机制”，不成立。

### P2-1 没有 `definePluginEntry`

证据：

- `projects-ref/openclaw-llm-api-logger/index.ts:54-138`

结论：

- 它直接导出裸对象。
- 这不影响运行，但缺少官方 SDK 入口类型保护。

### P2-2 手写局部 `OpenClawPluginApi` 类型

证据：

- `projects-ref/openclaw-llm-api-logger/index.ts:10-33`

结论：

- 这让 hook 参数退化成 `unknown`/`any`。
- 与 OpenClaw SDK 真正暴露的类型可能逐步漂移。

### P2-3 manifest 自带未文档化字段 `hooks`

证据：

- `projects-ref/openclaw-llm-api-logger/openclaw.plugin.json:1-34`

结论：

- manifest 顶层有 `"hooks": ["llm_input", "llm_output"]`。
- 本轮复核没有在 OpenClaw 源码里找到“插件 manifest 需要或消费这个字段”的直接证据。
- 因此 ClawLens 不应把它当成必要写法复制过来。

## 三、日志样本复核

### 1. 样本规模

通过匹配 header 行，`projects-ref/openclaw-llm-api-logger/logs/2026-03-30.jsonl` 中共有 47 条记录。

### 2. header 层面可稳定获取的字段

已确认 header 中稳定出现：

- `timestamp`
- `provider`
- `model`
- `runId`
- `sessionId`
- `durationMs`
- `status`

这与 logger 代码里 header 的构造一致：

- `projects-ref/openclaw-llm-api-logger/logger.ts:127-140`

### 3. `usage.cost` 的证据边界

已确认：

- 原始日志文本中可直接检索到多处 `usage.cost.total`。
- 但由于正文被换行替换破坏，无法把整份样本可靠地结构化解析成“47 条完整 response JSON”。

因此本文只保留如下结论：

- 本批 minimax-cn 运行样本中，`response.usage.cost` 确实出现过。
- 不能再把“47 条 response 全部已成功 JSON 解析并完成严格统计”写成既成事实。

## 四、对 ClawLens 的启发

1. `runId` 关联模式可直接借鉴，但语义应明确为 per-run。
2. 不要照搬它的日志格式设计；如果 ClawLens 需要可分析日志，必须避免对完整 JSON 文本做全局换行替换。
3. 不要照搬它的配置读取方式和手写 API 类型。
4. 不要把这个参考项目误读成“per-call 采集实现样板”；它解决的是请求/响应归档，不是瀑布图精细度问题。
