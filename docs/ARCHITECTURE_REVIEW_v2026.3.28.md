# ClawLens 架构审查复核

> 复核时间：2026-04-01
> 复核范围：`extensions/clawlens/`、`projects-ref/openclaw/src/`、`projects-ref/openclaw-llm-api-logger/logs/2026-03-30.jsonl`
> 本文只保留已被代码或日志直接证实的结论；旧文档中无法证实或已互相矛盾的表述已移除。

## 结论摘要

1. `llm_output` 在 OpenClaw v2026.3.28 中仍然是 per-run、累计 usage，不是 per-call。
2. ClawLens 当前把 `llm_output` 当作单次 LLM 调用写入 `llm_calls`，所以瀑布图 token/cost 数据在多次 LLM 循环下失真。
3. Comparator 代码仍存在高风险缺陷，但由于 `openclaw.plugin.json` 的空 schema 会拒绝所有用户配置，`compare.enabled` 在正式配置路径下无法打开，相关路径当前事实上不可达。
4. 测试文件存在两类问题：一类是根本无法直接运行，另一类是断言字段名已经落后于实现。
5. Store 层存在三处已确认的数据完整性缺陷：`cleanup()` 无事务保护、`computeCostMatch(null, null)` 返回假阳性、`conversation_turns` 不受保留策略覆盖。
6. Collector 的 `sessionIdToRunId` Map 在长时间运行的实例中无限增长（内存泄漏）；`recordAgentEnd` 当 `ctx.sessionKey` 缺失时无回退，静默丢弃全部对话轮次。
7. API 路由层：SSE token 暴露于 URL 查询参数；handler 无顶层 try/catch；`Number()` 转换用户输入未防 NaN，可注入 `LIMIT NaN`。

## 一、OpenClaw 侧已核实事实

### 1. `llm_output` 是 per-run

证据：

- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts:1808-1833`
- `projects-ref/openclaw/src/plugins/types.ts:1985-1999`

`runLlmOutput()` 在 `attempt.ts` 的主流程末尾调用一次，传入 `usage: getUsageTotals()`。这说明：

- 触发频率是每个 run 一次。
- `usage` 是整个 run 的累计值。
- 文档中任何“每次 LLM call 都会触发一次 llm_output”的说法都与现行代码不符。

### 2. Hook 执行模型

证据：

- `projects-ref/openclaw/src/plugins/hooks.ts:270-340`
- `projects-ref/openclaw/src/plugins/hooks.ts:754-878`

已确认：

- `llm_input`、`llm_output`、`agent_end`、`after_tool_call` 等 void hook 走 `runVoidHook()`，并行执行，框架 `await Promise.all(...)`。
- `before_agent_start`、`before_model_resolve`、`before_prompt_build`、`before_tool_call` 等 modifying hook 走 `runModifyingHook()`，顺序执行，框架逐个 `await`。
- `tool_result_persist`、`before_message_write` 是同步 hook，不接受异步返回；handler 若返回 Promise，会被记录 warning 并忽略结果，不会被 await。
- 所有 hook handler 异常默认被捕获并写日志，不会向上重新抛出。

### 3. `before_agent_start` 仍是 legacy 兼容层

证据：

- `projects-ref/openclaw/src/plugins/types.ts:1943-1949`
- `projects-ref/openclaw/src/plugins/hooks.ts:494-513`
- `projects-ref/openclaw/src/plugins/status.ts:94-102`

已确认：

- `before_agent_start` 仍可用，但 OpenClaw 自己把它标为 legacy compatibility。
- 新工作应优先拆到 `before_model_resolve` 与 `before_prompt_build`。

### 4. `allowPromptInjection=false` 的实际影响

证据：

- `projects-ref/openclaw/src/plugins/registry.ts:869-889`

已确认：

- `before_prompt_build` 在该策略下直接被拒绝注册。
- `before_agent_start` 不会被整体拒绝，但其 prompt mutation 字段会被约束掉，只保留非 prompt 覆写部分。
- 因此“严格策略下 before_agent_start 完全不可用”的说法不成立。

### 5. `onSessionTranscriptUpdate` 不能被当作稳定的 per-call usage 总线

证据：

- `projects-ref/openclaw/src/sessions/transcript-events.ts:1-49`
- `projects-ref/openclaw/src/agents/session-tool-result-guard.ts:147-176,252-270`
- `projects-ref/openclaw/src/agents/command/attempt-execution.ts:278-300`

已确认：

- `SessionTranscriptUpdate.message` 在类型上就是 optional。
- 有些路径会带 `message` 发事件，例如 session append 的主写入路径。
- 也有很多路径只发 `sessionFile` 字符串，例如 `attempt-execution.ts`。
- 所以它适合做“文件已变化”的通知，不适合被文档描述成“稳定提供每次调用 usage 的 API”。

## 二、ClawLens 已核实问题

### P0-1 `recordLlmCall()` 把 per-run usage 当 per-call 写入

证据：

- `extensions/clawlens/src/collector.ts:152-216`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts:1805-1827`

现状：

- ClawLens 在 `api.on("llm_output", ...)` 中调用 `collector.recordLlmCall(...)`。
- `recordLlmCall()` 直接把 `event.usage.input/output/cacheRead/cacheWrite` 写入 `llm_calls`。
- 由于 OpenClaw 的 `llm_output` 是 per-run，`llm_calls` 表里的每条记录并不代表一次真实 LLM 调用。

影响：

- 单 run 内若发生多轮 tool-use 循环，ClawLens 仍会只拿到一次累计 usage。
- `call_index` 在本地递增，但数值语义是伪造的“调用序号”，不是 OpenClaw 发出的真实 per-call 事件序号。

修复方向：

- 文档层先停止把这条数据描述为 per-call。
- 若要拿接近 per-call 的写盘边界，应转向 assistant message 落盘路径，例如 `before_message_write`；但这是一套新采集设计，不是现有实现已经具备的能力。

### P0-2 `officialCost` 被代码硬编码丢弃

证据：

- `extensions/clawlens/src/collector.ts:198-199`
- `projects-ref/openclaw-llm-api-logger/index.ts:121-125`
- `projects-ref/openclaw-llm-api-logger/logs/2026-03-30.jsonl` 中大量 `"cost": {...}`

现状：

- `collector.ts` 明确把 `officialCost` 写成 `undefined`。
- 参考 logger 会把 `event.usage` 原样写入 response。
- 2026-03-30 的日志文件中可以直接搜索到大量 `usage.cost.total`。

边界：

- OpenClaw 的 `PluginHookLlmOutputEvent.usage` 类型没有 `cost` 字段。
- 运行时日志证明该字段至少在本次 minimax-cn 样本中存在，但文档不应再把它写成 TypeScript 明面契约。

### P1-1 `snapshotIntervalMs` 配置项当前无效

证据：

- `extensions/clawlens/src/collector.ts:44-51`

现状：

- `intervalMs` 被读取但没有被用到。
- 实际 flush 定时器始终固定为 100ms。

### P1-2 Comparator 缺少 `sessionId`

证据：

- `extensions/clawlens/src/comparator.ts:72-96`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/params.ts:27-28`

现状：

- `runEmbeddedPiAgent()` 的 `sessionId` 是必填。
- Comparator 调用时未传该字段。
- `runtime: any` 抹掉了本应在编译期暴露出来的错误。

### P1-3 Comparator 异常被完全吞掉

证据：

- `extensions/clawlens/src/comparator.ts:71-99`

现状：

- compare run 启动失败、参数错误、文件系统错误都会进入空 `catch`。
- 调用方、日志和 UI 都拿不到失败信息。

### P1-4 `configSchema` 使 Comparator 在正式配置路径下不可启用

证据：

- `extensions/clawlens/openclaw.plugin.json:1-8`
- `extensions/clawlens/index.ts:89`

现状：

- manifest 只有空对象 schema，且 `additionalProperties: false`。
- 这意味着用户通过正常插件配置写入的任何字段都会被 schema 拒绝。
- `index.ts:89` 只有在 `config.compare?.enabled` 为真时才注册 compare hook。

结论：

- “Comparator 存在多处逻辑 bug”这个判断成立。
- 但“这些 bug 当前会在正式用户环境中直接触发”的说法不严谨；因为 compare 功能先被空 schema 卡死了。

### P1-5 `cleanup()` 无事务保护

证据：

- `extensions/clawlens/src/store.ts:611-619`

现状：

- `cleanup()` 先对每个过期 `run_id` 执行 `DELETE FROM llm_calls` 和 `DELETE FROM tool_executions`，再执行 `DELETE FROM runs`，最后删 `session_snapshots`。
- 整个过程没有 `BEGIN`/`COMMIT` 事务包裹。
- 若中途进程崩溃，`llm_calls` 已删但 `runs` 未删，或 `runs` 已删但 `session_snapshots` 未删，DB 将处于部分清理状态。

### P1-6 `computeCostMatch(null, null)` 返回假阳性

证据：

- `extensions/clawlens/src/store.ts:87`

现状：

- 当 `official` 和 `calculated` 均为 `null` 时，函数直接返回 `{ costMatch: true }`。
- 实际语义是"双方均无数据"，但被记录为"成本匹配"。
- `getAuditSessions()` 基于该结果展示 cost 对比状态，会误导用户。

### P1-7 `sessionIdToRunId` Map 从不清理

证据：

- `extensions/clawlens/src/collector.ts:34`
- `extensions/clawlens/src/collector.ts:233`
- `extensions/clawlens/src/collector.ts:308`

现状：

- `recordLlmInput()` 在 line 233 写入 `sessionIdToRunId`。
- `recordAgentEnd()` 在 line 308 只读取，不删除。
- 整个 `Collector` 生命周期内没有对该 Map 做任何清理。
- 长时间运行的实例中，每个新 session 都会增加一条永久条目。

### P1-8 `conversation_turns` 不受 `cleanup()` 保护

证据：

- `extensions/clawlens/src/store.ts:181-192`
- `extensions/clawlens/src/store.ts:611-619`

现状：

- `conversation_turns` 表没有声明外键约束，无级联删除。
- `cleanup()` 删除了 `runs`、`llm_calls`、`tool_executions`、`session_snapshots`。
- `conversation_turns` 未被删除；其对应的 `run_id` 在 `runs` 表中已经不存在。
- 随保留策略运行，`conversation_turns` 中的孤立记录会持续积累。

### P2-1 `patchControlUiIndexHtml()` 直接修改 OpenClaw 产物

证据：

- `extensions/clawlens/index.ts:13-62`

风险：

- 修改的是 OpenClaw 自身 `dist/control-ui/index.html`。
- 升级、重装、路径变化都会覆盖或失效。
- 这属于脆弱集成，不应在文档里表述为稳定扩展点。

### P1-9 `recordAgentEnd` 无 sessionKey 回退

证据：

- `extensions/clawlens/src/collector.ts:109`
- `extensions/clawlens/src/collector.ts:304-309`

现状：

- `handleAgentEvent` 在 lifecycle start 阶段把 `sessionKey` 写入 `activeRuns`（line 109）。
- `recordAgentEnd` 在 line 309 的守卫为 `if (!runId || !ctx.sessionKey) return;`。
- 若 `agent_end` hook context 中 `ctx.sessionKey` 缺失，函数提前返回，所有 `conversation_turns` 写入都被静默丢弃。
- 代码没有尝试从 `activeRuns.get(runId)?.sessionKey` 回退取值。

### P2-3 SSE 鉴权 token 暴露于 URL 查询参数

证据：

- `extensions/clawlens/src/api-routes.ts:33-36`
- `extensions/clawlens/src/api-routes.ts:53-54`

现状：

- SSE `/events` 端点使用 `authOkQuery`，从 `url.searchParams.get("token")` 读取 token。
- 客户端必须以 `?token=<secret>` 形式访问 SSE 端点。
- query 参数中的 token 会出现在服务端访问日志、浏览器历史、代理日志中。

### P2-4 API 路由处理器无 try/catch，Number() 参数不防 NaN

证据：

- `extensions/clawlens/src/api-routes.ts:47-131`
- `extensions/clawlens/src/api-routes.ts:83-84`
- `extensions/clawlens/src/api-routes.ts:122-124`
- `extensions/clawlens/src/store.ts:401-403`
- `extensions/clawlens/src/store.ts:451-453`

现状（两个独立问题）：

1. **无 try/catch**：整个 `handler` 函数体（line 47-131）没有顶层 try/catch。`store.getOverview()` 等方法抛出的任何异常都会直接向上传播，无法以 500 响应结束请求。

2. **NaN 注入**：`?limit=foo` 经 `Number("foo") = NaN` 后作为 SQL `LIMIT NaN` 传入 SQLite（store.ts:403, 453）；`?days=foo` 同样产生 `NaN * 86_400_000 = NaN`，使 `started_at >= NaN` 条件失效（store.ts:451）。两处均无输入校验。

### P2-5 `getSessionRuns()` 从未被调用（死代码）

证据：

- `extensions/clawlens/src/store.ts:476-502`

现状：

- 整个 `extensions/clawlens/` 中只有 `store.ts:476` 定义了 `getSessionRuns`，无任何调用方。
- 该方法也只读取了 `cost_usd`，未读取后续增加的 `official_cost` / `calculated_cost` 列。

### P2-6 `conversation_turns` 同批写入时间戳全部相同

证据：

- `extensions/clawlens/src/collector.ts:314-325`

现状：

- `recordAgentEnd()` 在调用前取一次 `const now = Date.now()`，然后用同一个 `now` 写入本次 run 的所有对话轮次。
- `conversation_turns` 表中，同一 run 的所有行 `timestamp` 字段完全相同。
- 无法通过时间戳排序区分轮次顺序，只能依赖 `turn_index`。

### P2-2 测试文件与实现脱节

证据：

- `extensions/clawlens/tests/collector.test.ts:127,256,369-370`
- `extensions/clawlens/src/collector.ts:257-287`
- `extensions/clawlens/tests/store.test.ts:178-188`
- `extensions/clawlens/src/store.ts:112-155,229-250`
- `extensions/clawlens/package.json:1-8`

已确认的脱节：

- `collector.test.ts` 仍向 `recordToolCall()` 传 `input`、`content`、`isError`，而实现读取的是 `params`、`result`、`error`。
- `store.test.ts` 断言 `duration_ms`、`ended_at` 这类 snake_case 字段，但 `getRunDetail()` 实际返回的是运行时查询结果，文档不应再假设这些字段一定按测试中的形状暴露。
- `package.json` 没有测试构建步骤；测试源码直接 import `../src/*.js`，在当前工作树下用 `node --test` 会因 `.js` 不存在而失败。

## 三、日志层复核

### 1. 2026-03-30 样本量

通过匹配 header 行格式，`projects-ref/openclaw-llm-api-logger/logs/2026-03-30.jsonl` 中共有 47 条记录。

### 2. 日志格式不是标准 JSONL

证据：

- `projects-ref/openclaw-llm-api-logger/logger.ts:113-145`

已确认：

- 每条记录由 `header / ------ / request / ------ / response` 组成。
- `formatEntry()` 在拼接完成后执行 `.replace(/\\n/g, '\n')`。
- 这会把 JSON 字符串里的转义换行变成真实换行，导致 request/response 段常常不再是合法 JSON。

因此：

- 只能稳定解析 header 行。
- request/response 适合做文本检索，不适合继续被文档描述成“可直接 JSON.parse 的三段结构”。

### 3. 运行时 `usage.cost` 的证据形态

已确认：

- 日志文件正文可直接检索到大量 `usage.cost.total`。
- 但由于正文被换行替换破坏，无法把全部 47 条 response 严格 JSON 解析后做结构化统计。

因此本文采用的更稳健结论是：

- 本批 minimax-cn 样本明确出现了运行时 `usage.cost`。
- 不能据此把 `cost` 上升为 OpenClaw 插件类型契约。

## 四、文档修正原则

本轮修订后，四份文档统一采用以下口径：

1. `llm_output` 统一写作 per-run。
2. `before_message_write` 与 `tool_result_persist` 统一写作 sync-only modifying hook。
3. `onSessionTranscriptUpdate` 统一写作“可收到 transcript 更新通知，但 `message` 可缺失，不能当成稳定 usage API”。
4. 参考日志统一写作“header 可结构化解析，正文常被换行替换破坏”。

## 五、剩余缺口

本轮没有扩展到以下内容，因此文档中不再保留对应强断言：

- OpenClaw 官方站点文字表述。
- `gateway/session-utils.fs.ts` 之外的所有 usage 汇总 UI 展示路径。
- Comparator 真实运行时失败栈；当前只确认了参数层面的必填缺失和错误吞没。
