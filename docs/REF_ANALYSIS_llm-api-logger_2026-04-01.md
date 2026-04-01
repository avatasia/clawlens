# `openclaw-llm-api-logger` 参考项目复核

> 复核时间：2026-04-01
> 证据源：`projects-ref/openclaw-llm-api-logger/` 与 `projects-ref/openclaw-llm-api-logger/logs/2026-03-30.jsonl`
> 输出策略：基于原文另存为新文件；原文件未修改。

## 本轮修改/删除说明

1. 保留原文“这是 per-run 请求/响应归档，不是 per-call 采集样板”的结论，原因是 `index.ts` 仍以 `runId` 配对 `llm_input`/`llm_output`。
2. 将“47 条 header 可稳定解析”进一步量化为字段完整性检查，并补明 header 实际不包含 `usage`，原因是本轮已对全部 header 行做结构化提取。
3. 将“正文常常不再是合法 JSON”从定性表述补成可复验统计，原因是本轮对 47 个 chunk 做解析后，request 成功数为 0，response 成功数仅为 4。

## 结论摘要

1. 参考项目的核心模式是正确的：用 `runId` 关联 `llm_input` 与 `llm_output`，记录的是 per-run 请求/响应。
2. 它不能作为 ClawLens 瀑布图的 per-call 方案参考，因为它采集的本来就是 per-run 数据。
3. 该项目自身仍有三处明确缺陷：配置读取方式不规范、日志格式被 `.replace(/\\n/g, '\n')` 破坏、`pendingWrites` 清理逻辑无效。
4. 2026-03-30 样本日志中共有 47 条 header 记录；header 层可稳定解析，但 header 本身不含 `usage`，request/response 正文又绝大多数已不是合法 JSON。

## 一、可借鉴部分

### 1. `runId` 关联模式成立

证据：

- `projects-ref/openclaw-llm-api-logger/index.ts:41-50`
- `projects-ref/openclaw-llm-api-logger/index.ts:88-121`

结论：

- `llm_input` 时缓存 request。
- `llm_output` 时按同一 `runId` 取回并写日志。
- 这个模式适合 per-run 请求/响应归档。

### 2. 参考日志确实记录了 response.usage

证据：

- `projects-ref/openclaw-llm-api-logger/index.ts:110-117`

结论：

- logger 直接把 `event.usage` 写入 `response.usage`。
- 因此日志里的 `usage.cost` 若出现，来源是运行时 hook event，而不是 logger 自己计算。

## 二、已确认问题

### P1-1 配置读取没有使用 `api.pluginConfig`

证据：

- `projects-ref/openclaw-llm-api-logger/index.ts:21-28`
- `projects-ref/openclaw-llm-api-logger/index.ts:56-57`

结论：

- 参考项目手动从 `api.config?.plugins?.entries[...]` 读配置。
- 这绕过了 OpenClaw 已提供的 `api.pluginConfig`。

### P1-2 日志格式被换行替换破坏

证据：

- `projects-ref/openclaw-llm-api-logger/logger.ts:106-131`

结论：

- `formatEntry()` 先 `JSON.stringify()`，再对完整字符串执行 `.replace(/\\n/g, '\n')`。
- 这会把 JSON 字符串里的转义换行改成真实换行，直接破坏 JSON 合法性。

### P1-3 `pendingWrites` 清理代码无效

证据：

- `projects-ref/openclaw-llm-api-logger/logger.ts:225-239`

结论：

- Promise 没有可读的 `.status` 字段。
- 这里的过滤逻辑不能正确识别 pending 状态。

### P2-1 没有 `definePluginEntry`

证据：

- `projects-ref/openclaw-llm-api-logger/index.ts:52-125`

结论：

- 它直接导出裸对象。
- 这不一定导致运行时错误，但缺少官方 SDK 的入口类型保护。

### P2-2 手写局部 `OpenClawPluginApi` 类型

证据：

- `projects-ref/openclaw-llm-api-logger/index.ts:10-28`

结论：

- hook 参数被退化为 `unknown` / `any`。
- 与 OpenClaw SDK 正式类型存在漂移风险。

### P2-3 manifest 中的 `hooks` 字段无直接消费证据

证据：

- `projects-ref/openclaw-llm-api-logger/openclaw.plugin.json:1-34`

结论：

- manifest 顶层有 `"hooks": ["llm_input", "llm_output"]`。
- 本轮未在 OpenClaw 源码中找到 manifest 消费该字段的直接证据。
- ClawLens 不应把它当成必要写法照搬。

## 三、日志样本复核

### 1. 样本规模

本轮按 header 行模式 `^{\"timestamp\"` 计数，`projects-ref/openclaw-llm-api-logger/logs/2026-03-30.jsonl` 中共有 47 条记录。

### 2. header 层可稳定获取的字段

本轮对 47 条 header 逐行 `JSON.parse` 后得到：

- `provider` 统一为 `minimax-cn`
- `model` 统一为 `MiniMax-M2.7-highspeed`
- `status` 均为 `success`
- `runId` 缺失数为 0
- `sessionId` 缺失数为 0
- `durationMs` 非数字数为 0

同时已确认：

- header 结构只包含 `timestamp`、`provider`、`model`、`runId`、`sessionId`、`durationMs`、`status`、`error`
- `usage` 不在 header 中；若要取 usage，只能从 response 正文尝试解析或做文本检索

这与 logger 构造 header 的逻辑一致：

- `projects-ref/openclaw-llm-api-logger/logger.ts:117-126`

### 3. 正文 JSON 合法性

本轮按每个 header chunk 拆分 `header / ------ / request / ------ / response` 后，对 47 组正文做解析，结果为：

- 可成功 `JSON.parse` 的 request: 0
- 可成功 `JSON.parse` 的 response: 4

结论：

- 该文件不是标准 JSONL。
- 更准确的说法应是“三段文本记录，其中 header 通常可结构化解析，正文经常被换行替换破坏”。

### 4. `usage.cost` 的证据边界

已确认：

- 原始日志文本中存在大量 `cost` 片段。
- 样本中可直接检索到 `usage.cost.total` 样式字段。

但仍需保留边界：

- 由于正文绝大多数已不是合法 JSON，不能把它写成“47 条完整 response 全部已结构化统计”。

## 四、对 ClawLens 的启发

1. `runId` 关联模式可借鉴，但语义必须写清楚是 per-run。
2. 不要照搬它的日志格式；若需要可分析日志，不能在完整 JSON 字符串上做全局换行替换。
3. 如果后续分析依赖 `usage`，不要假设能从 header 单独提取；当前格式下必须额外处理 response 正文。
4. 不要照搬它的配置读取方式或手写 API 类型。
5. 不要把这个参考项目误读成 “per-call 采集实现样板”；它解决的是请求/响应归档，不是瀑布图粒度问题。
