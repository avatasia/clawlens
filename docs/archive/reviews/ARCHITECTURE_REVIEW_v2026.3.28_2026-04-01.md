# ClawLens 架构审查复核

> 复核时间：2026-04-01
> 复核范围：`extensions/clawlens/`、`projects-ref/openclaw/src/`、`projects-ref/openclaw-llm-api-logger/logs/2026-03-30.jsonl`
> 输出策略：基于原文另存为新文件；原文件未修改。

## 本轮修改/删除说明

1. 将“Comparator 缺少 `sessionId`”改写为“Comparator 传给 `runEmbeddedPiAgent()` 的整组必填参数不完整”，原因是代码中实际还缺少 `prompt`、`runId` 等必填字段，原表述低估了故障范围。
2. 将 API 层的 “`LIMIT NaN` 可注入” 改写为 “未校验的 `Number()` 会把 `NaN` 传入 SQLite 并触发 `datatype mismatch`”，原因是本轮已通过本地执行 `Store.getSessions({ limit: NaN })` / `getAuditSessions({ limit: NaN })` 复现到了具体运行时结果。
3. 保留原文关于 `llm_output` 为 per-run、`officialCost` 未落库、`sessionIdToRunId` 泄漏、`conversation_turns` 保留策略缺失等结论，原因是代码与日志仍直接支持这些判断。

## 结论摘要

1. `llm_output` 在 OpenClaw v2026.3.28 中仍然是 per-run、累计 usage，不是 per-call。
2. ClawLens 当前把 `llm_output` 当作单次 LLM 调用写入 `llm_calls`，瀑布图 token/cost 数据在多轮 tool-use 下会失真。
3. Comparator 路径不仅缺少 `sessionId`，还缺少 `prompt`、`runId` 等 `runEmbeddedPiAgent()` 必填参数；再叠加空 `configSchema`，该功能在正常配置路径下基本不可达。
4. 测试现状不能支撑“已有可靠回归覆盖”的表述：`collector.test.ts`、`cost-calculator.test.ts`、`sse-manager.test.ts` 都直接导入不存在的 `../src/*.js`，且若修正入口后仍有字段名陈旧问题。
5. Store/成本层已确认四处数据完整性缺陷：`cleanup()` 无事务、`computeCostMatch(null, null)` 假阳性、`conversation_turns` 不受保留策略覆盖、`loadCostConfig()` 对不完整 cost 配置校验不足会把 `NaN` 带入成本计算。
6. Collector 的 `sessionIdToRunId` Map 无清理，`recordAgentEnd()` 又要求 `ctx.sessionKey` 必须存在，`flush()` 还会吞掉队列写入异常且不记日志；长时运行会泄漏映射，部分对话轮次和持久化失败都会静默丢失。
7. API/UI 层仍有四类风险：SSE token 暴露在 URL 查询参数、handler 无顶层 try/catch、`limit`/`offset`/`days` 未校验会把 `NaN` 传给底层查询并报错、Audit 面板的 SSE 刷新条件过宽导致无关 run 也会刷新当前 session 详情。

## 一、OpenClaw 侧已核实事实

### 1. `llm_output` 是 per-run

证据：

- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts:1805-1828`
- `projects-ref/openclaw/src/plugins/types.ts:1983-1999`

结论：

- `runLlmOutput()` 只在 run 尾部调用一次。
- `usage` 传入的是 `getUsageTotals()` 的累计值。
- 文档中任何“每次 LLM call 都触发一次 `llm_output`”的说法都不成立。

### 2. Hook 执行模型

证据：

- `projects-ref/openclaw/src/plugins/hooks.ts:270-334`
- `projects-ref/openclaw/src/plugins/hooks.ts:745-868`

结论：

- `llm_input`、`llm_output`、`agent_end`、`after_tool_call` 走 `runVoidHook()`，并行执行，框架 `await Promise.all(...)`。
- `before_agent_start`、`before_model_resolve`、`before_prompt_build`、`before_tool_call` 走 `runModifyingHook()`，顺序执行，逐个 `await`。
- `tool_result_persist`、`before_message_write` 是同步 hook；若 handler 返回 Promise，框架只写 warning，不会 await。
- hook 抛错默认被捕获并记日志，不会上抛阻断主流程。

### 3. `before_agent_start` 仍是 legacy compatibility

证据：

- `projects-ref/openclaw/src/plugins/types.ts:1943-1949`
- `projects-ref/openclaw/src/plugins/status.ts:94-109`

结论：

- 该 hook 仍可用，但 OpenClaw 已把它作为兼容层并提示新工作优先转向 `before_model_resolve` / `before_prompt_build`。

### 4. `allowPromptInjection=false` 的真实影响

证据：

- `projects-ref/openclaw/src/plugins/registry.ts:869-889`

结论：

- `before_prompt_build` 会被直接阻止注册。
- `before_agent_start` 不会整体失效，只会把 prompt mutation 字段约束掉。

### 5. `onSessionTranscriptUpdate` 不是稳定的 per-call usage 总线

证据：

- `projects-ref/openclaw/src/sessions/transcript-events.ts:1-49`
- `projects-ref/openclaw/src/agents/session-tool-result-guard.ts:147-176`
- `projects-ref/openclaw/src/agents/session-tool-result-guard.ts:252-270`
- `projects-ref/openclaw/src/agents/command/attempt-execution.ts:278-296`

结论：

- `message` 在类型上就是 optional。
- 有的路径只发 `sessionFile`，没有 message/usage。
- 它更适合“文件已更新”通知，不适合被描述为稳定提供每次调用 usage 的接口。

## 二、ClawLens 已核实问题

### P0-1 `recordLlmCall()` 把 per-run usage 当 per-call 写入

证据：

- `extensions/clawlens/src/collector.ts:143-202`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts:1805-1828`

结论：

- `collector.recordLlmCall()` 直接把 `event.usage` 写进 `llm_calls`。
- 但 OpenClaw 的 `llm_output` 只在 run 结束时发一次累计 usage。
- 因此 `call_index` 是本地伪造递增值，不是 OpenClaw 提供的真实 per-call 序号。

### P0-2 `officialCost` 被硬编码丢弃

证据：

- `extensions/clawlens/src/collector.ts:181-188`
- `projects-ref/openclaw-llm-api-logger/index.ts:110-117`
- `projects-ref/openclaw-llm-api-logger/logs/2026-03-30.jsonl`

结论：

- ClawLens 明确把 `officialCost` 写成 `undefined`。
- 参考 logger 会把运行时 `event.usage` 原样写入日志。
- 日志样本中可以直接检索到大量 `usage.cost.total`；这说明运行时字段存在过，但它不是当前 `PluginHookLlmOutputEvent` 的显式 TypeScript 契约。

### P1-1 `snapshotIntervalMs` 配置项当前无效

证据：

- `extensions/clawlens/src/collector.ts:39-47`

结论：

- 代码读取了 `pluginConfig.collector?.snapshotIntervalMs`，但 `setInterval()` 仍写死为 `100` ms。

### P1-2 Comparator 对 `runEmbeddedPiAgent()` 的调用参数组不完整

证据：

- `extensions/clawlens/src/comparator.ts:63-91`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/params.ts:27-104`
- `projects-ref/openclaw/src/agents/command/attempt-execution.ts:434-468`

结论：

- `RunEmbeddedPiAgentParams` 明确要求 `sessionId`、`sessionFile`、`workspaceDir`、`prompt`、`timeoutMs`、`runId` 等字段。
- Comparator 调用只传了 `sessionKey`、`sessionFile`、`workspaceDir`、`lane`、`timeoutMs`、`provider`、`model` 等少数字段。
- 原文若只写“缺少 `sessionId`”不够准确；真实问题是 `runtime: any` 抹掉了整组必填参数缺失。

### P1-3 Comparator 异常被完全吞掉

证据：

- `extensions/clawlens/src/comparator.ts:63-93`

结论：

- compare run 启动失败、参数错误、文件系统错误都进入空 `catch`。
- 主 run、日志、SSE、UI 都拿不到失败原因。

### P1-4 空 `configSchema` 阻断正式配置

证据：

- `extensions/clawlens/openclaw.plugin.json:1-7`
- `extensions/clawlens/index.ts:69-90`

结论：

- schema 只允许空对象。
- `compare.enabled` 等任何配置都无法经正常插件配置路径注入。
- 因此 Comparator bug 虽真实存在，但“在正式用户配置中直接触发”的表述需要降级。

### P1-5 `cleanup()` 无事务保护

证据：

- `extensions/clawlens/src/store.ts:611-619`

结论：

- 删除 `llm_calls` / `tool_executions` / `runs` / `session_snapshots` 的过程没有事务。
- 中途崩溃会留下部分清理状态。

### P1-6 `computeCostMatch(null, null)` 返回假阳性

证据：

- `extensions/clawlens/src/store.ts:83-92`

结论：

- 当前语义把“双方都没有数据”显示成“成本匹配”，会误导 audit 结果。

### P1-6b `loadCostConfig()` 会接受不完整 cost 配置并导致 `NaN`

证据：

- `extensions/clawlens/src/cost-calculator.ts:3-10`
- `extensions/clawlens/src/cost-calculator.ts:17-26`

补充验证：

- 本轮本地执行 `loadCostConfig({models:{providers:{p:{models:{m:{cost:{input:1}}}}}}})` 后，再调用 `calculateCost(...)`，返回值为 `NaN`。

结论：

- `loadCostConfig()` 只检查 `cost.input` 是否为 number，就把对象整体当作 `ModelCostConfig` 写入 Map。
- 一旦 `output` / `cacheRead` / `cacheWrite` 缺失，`calculateCost()` 中的乘法会产生 `NaN`。
- 这会污染 `calculatedCost`、SSE 广播和后续 run 聚合。

### P1-7 `sessionIdToRunId` 永不清理

证据：

- `extensions/clawlens/src/collector.ts:34`
- `extensions/clawlens/src/collector.ts:229-234`
- `extensions/clawlens/src/collector.ts:304-309`

结论：

- 只写入不删除。
- 长时运行实例会持续增长该 Map。

### P1-8 `conversation_turns` 不受保留策略覆盖

证据：

- `extensions/clawlens/src/store.ts:167-182`
- `extensions/clawlens/src/store.ts:611-619`

结论：

- `conversation_turns` 无外键级联，也不在 `cleanup()` 删除列表里。
- 历史 `run_id` 被删后会留下孤儿 turn。

### P1-9 `recordAgentEnd()` 无 `sessionKey` 回退

证据：

- `extensions/clawlens/src/collector.ts:304-319`

结论：

- 只要 `ctx.sessionKey` 缺失，即使已能通过 `ctx.sessionId` 查到 `runId`，函数也会直接返回。
- 它没有回退读取 `activeRuns.get(runId)?.sessionKey`。

### P1-9b `flush()` 会吞掉队列操作异常且不留日志

证据：

- `extensions/clawlens/src/collector.ts:72-79`

结论：

- `flush()` 对每个队列操作都包了 `try/catch`，但 catch 体为空。
- 任何 `store.insert*` / `store.completeRun` / `store.updateRunSessionKey` 失败都会被静默吞掉。
- 这属于真实的数据丢失风险，不应仅轻描淡写为“不中断主流程”。

### P1-10 API 查询参数未校验，`NaN` 会触发 SQLite `datatype mismatch`

证据：

- `extensions/clawlens/src/api-routes.ts:73-83`
- `extensions/clawlens/src/api-routes.ts:117-124`
- `extensions/clawlens/src/store.ts:375-398`
- `extensions/clawlens/src/store.ts:443-464`

补充验证：

- 本轮本地执行 `Store.getSessions({ limit: NaN })` 与 `Store.getAuditSessions({ limit: NaN })`，均报 `Error: datatype mismatch`。

结论：

- 这里不是“SQL 注入”问题，而是参数未校验导致的稳定 500 风险。

### P2-1 `patchControlUiIndexHtml()` 直接修改 OpenClaw 产物

证据：

- `extensions/clawlens/index.ts:13-58`

结论：

- 这是脆弱集成，不是稳定扩展点。

### P2-2 Audit 详情会被无关 SSE 事件触发刷新

证据：

- `extensions/clawlens/ui/inject.js:123-137`

结论：

- 当前条件是 `if (S.selSession && (ev.sessionKey === S.selSession || ev.runId)) selectSession(S.selSession);`
- 由于 `run_started` / `run_ended` / `llm_call` / `tool_executed` 事件普遍都带 `runId`，右侧条件几乎恒真。
- 结果是只要有任意 run 事件到来，当前打开的 Audit session 详情都会被重新请求一次，即使该事件与当前 session 无关。
- 这更接近无谓刷新/噪音流量，而不是数据正确性 P1 级问题，因此记为 P2。

## 三、测试与覆盖缺口

### 1. `collector.test.ts` 当前不可直接运行

证据：

- `extensions/clawlens/tests/collector.test.ts:10`
- `extensions/clawlens/package.json:1-8`

补充验证：

- 本轮直接执行 `node --test extensions/clawlens/tests/collector.test.ts`，报 `ERR_MODULE_NOT_FOUND`，因为测试导入的是不存在的 `../src/collector.js`。
- 同类问题也出现在 `extensions/clawlens/tests/cost-calculator.test.ts` 与 `extensions/clawlens/tests/sse-manager.test.ts`，它们分别导入 `../src/cost-calculator.js`、`../src/sse-manager.js`。

### 2. 测试字段名与实现不一致

证据：

- `extensions/clawlens/tests/collector.test.ts:127`
- `extensions/clawlens/tests/collector.test.ts:256`
- `extensions/clawlens/tests/collector.test.ts:369-370`
- `extensions/clawlens/src/collector.ts:261-286`

结论：

- 测试仍使用 `input` / `content` / `isError`。
- 当前实现读取的是 `params` / `result` / `error`。

## 四、统一口径

1. ClawLens 当前采集到的是 per-run 累计 usage，不是 per-call。
2. Comparator 问题应表述为“配置路径被 schema 封死，且实现本身还缺少多项必填参数并吞错”。
3. API 路由的 `NaN` 问题应表述为“参数校验缺失导致查询报错”，不要写成 SQL 注入。
4. UI 层还存在一个独立问题：SSE 事件对 Audit 详情的刷新条件过宽，会造成无关 session 的重复拉取。
5. 成本配置边界也应写清：不完整 `cost` 配置不会自动按 0 处理，而会让 `calculateCost()` 产出 `NaN`。
6. 测试状态应写成“存在测试草稿，但执行入口和断言字段均需修正”，不能写成“已有可靠覆盖”。
