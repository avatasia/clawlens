# ClawLens — 代码实现提示词（修订版）

> 基于四份复核文档（2026-04-01）与对 `docs/IMPLEMENTATION_PROMPT.md` 的审查生成。
> 输出策略：基于原文另存为新文件；原文件未修改。

## 本轮修改原因

1. 原文把 `snapshotIntervalMs` 直接接到 `flush()` 定时器上，这会把默认写库节奏从 `100ms` 拉长到 `60_000ms`，与“snapshot”语义不符，且会明显恶化数据落盘延迟。
2. 原文遗漏了四个已确认问题：`patchControlUiIndexHtml()` 直接修改 OpenClaw 产物、SSE token 暴露在 URL 查询参数、chat audit 的 `unknown` fallback 会混入无关数据、`CHAT_STATE.pollTimer` 没有清理。
3. 原文给出的测试脚本 `tsc --outDir dist-test && node --test tests/*.test.js` 路径不正确，而且 `extensions/clawlens/` 下没有本地 `tsconfig*.json`，不能直接按该方案执行。
4. 原文对 Comparator / `before_agent_start` / `sessionId` 的表述基本成立，但测试与部署部分存在若干“可选方案被写成现成可执行命令”的问题，因此改为更保守、可落地的说法。

---

## 0. 执行规则

- 不要中途停下来问问题，一次性完成所有改动。
- 改动只在 `extensions/clawlens/` 目录下进行，不碰 OpenClaw 本体。
- **先读后改**：每个文件改之前先完整读取，理解现有实现再动手。
- 改完一批就运行本地验证，验证通过再继续下一批。
- 验证失败时读错误信息修复，不要绕过。
- 不要把 `snapshotIntervalMs` 直接复用为队列 `flush()` 间隔；若要实现 snapshot 功能，必须新增独立 snapshot 调度逻辑。

---

## 1. 开始前先读这些文件

```bash
cat extensions/clawlens/openclaw.plugin.json
cat extensions/clawlens/index.ts
cat extensions/clawlens/src/types.ts
cat extensions/clawlens/src/store.ts
cat extensions/clawlens/src/collector.ts
cat extensions/clawlens/src/comparator.ts
cat extensions/clawlens/src/cost-calculator.ts
cat extensions/clawlens/src/api-routes.ts
cat extensions/clawlens/src/sse-manager.ts
cat extensions/clawlens/ui/inject.js
cat extensions/clawlens/ui/styles.css
```

---

## 2. 已确认的架构事实（不要自行推翻）

以下结论已经过代码核实，写代码时直接用，不要重新猜测：

| 事实 | 来源 |
|---|---|
| `llm_output` hook 每个 run 只触发一次，`usage` 是累计值，不是单次 LLM call | `attempt.ts:1808-1833` |
| `onSessionTranscriptUpdate` 的 `message` 是 optional，有些路径只发 `sessionFile`，不是稳定的 per-call usage 总线 | `transcript-events.ts:1-49` |
| `llm_input`/`llm_output`/`agent_end`/`after_tool_call` 是 void hook，框架 `Promise.all` 并行等待 | `hooks.ts:270-291` |
| `before_agent_start` 是 modifying hook，框架逐个 `await`（顺序执行） | `hooks.ts:494-513` |
| `tool_result_persist`/`before_message_write` 是同步 hook；handler 返回 Promise 会被警告并忽略 | `hooks.ts:745-878` |
| `openclaw.plugin.json` 的 `configSchema` 为空对象 + `additionalProperties: false`，会拒绝所有用户配置 | `openclaw.plugin.json:1-7` |
| Comparator 对 `runEmbeddedPiAgent()` 的调用缺少必填参数 `sessionId`、`prompt`、`runId`；`before_agent_start` 的 `ctx` 类型本身允许带 `sessionId` | `comparator.ts:72-96`, `params.ts:27-105`, `types.ts:1878-1887` |
| `loadCostConfig()` 只检查 `cost.input` 是否为 number，`output`/`cacheRead`/`cacheWrite` 缺失时 `calculateCost()` 返回 `NaN` | `cost-calculator.ts:17-26` |
| `Store.getSessions({ limit: NaN })` 会触发 SQLite `datatype mismatch`（已本地复现） | `api-routes.ts:83`, `store.ts` |
| `collector.test.ts`/`cost-calculator.test.ts`/`sse-manager.test.ts` 导入不存在的 `../src/*.js`，直接报 `ERR_MODULE_NOT_FOUND` | 三个测试文件 import 行 |
| `patchControlUiIndexHtml()` 会直接改写 OpenClaw 自身 `dist/control-ui/index.html` | `index.ts:34-58,102` |
| SSE 当前通过 `/events?token=...` 传 token，token 暴露在 URL 查询参数 | `api-routes.ts:33-58`, `inject.js:123-127` |

---

## 3. Bug 修复清单（按优先级）

### P0 — 数据根本性错误

#### P0-1 修正 `recordLlmCall()` 的语义注释和命名

当前 `collector.ts` 在 `llm_output` 触发时把累计 usage 当成单次 LLM call 写入 `llm_calls`。
由于暂时没有稳定的 per-call 数据源，**不要删除现有写入逻辑**，但需要：

1. 把函数名改为 `recordLlmOutput`，并在注释中明确写：
   > 此方法由 `llm_output` hook 触发，一个 run 只调用一次，写入的是全 run 累计 usage。

2. 同步更新 `index.ts` 中的 hook 注册：

```typescript
// 改前：
api.on("llm_output", (event: any, ctx: any) => collector.recordLlmCall(event, ctx));
// 改后：
api.on("llm_output", (event: any, ctx: any) => collector.recordLlmOutput(event, ctx));
```

#### P0-2 尝试读取 `officialCost`

`llm_output` 的 TypeScript 类型没有 `cost` 字段，但运行时日志证明 `event.usage.cost?.total` 在实际运行时存在。
在 `recordLlmOutput`（原 `recordLlmCall`）中，把硬编码的 `officialCost: undefined` 改为：

```typescript
const rawUsage = (event as any).usage ?? {};
const officialCost =
  typeof rawUsage?.cost?.total === "number" && Number.isFinite(rawUsage.cost.total)
    ? (rawUsage.cost.total as number)
    : null;
```

---

### P1 — Store / 数据完整性

#### P1-1 修复 `openclaw.plugin.json` — 开放 configSchema

把空对象 schema 替换为实际支持的配置字段，否则用户无法通过正常路径传入任何配置。

#### P1-2 修复 `loadCostConfig()` — 校验全部四个字段

只有四个数值字段都是有限数字时才入表：

```typescript
if (
  cost &&
  typeof cost.input === "number" && Number.isFinite(cost.input) &&
  typeof cost.output === "number" && Number.isFinite(cost.output) &&
  typeof cost.cacheRead === "number" && Number.isFinite(cost.cacheRead) &&
  typeof cost.cacheWrite === "number" && Number.isFinite(cost.cacheWrite)
) {
  map.set(`${pName}:${mName}`, cost as ModelCostConfig);
}
```

#### P1-3 修复 `computeCostMatch(null, null)` 假阳性

双方都没有数据时不应显示为“匹配”：

```typescript
if (official == null && calculated == null) {
  return { costMatch: false, costDiffReason: "no cost data available" };
}
```

#### P1-4 修复 `cleanup()` — 加事务并覆盖 `conversation_turns`

把现有多个 DELETE 操作包进一个事务，且把 `conversation_turns` 纳入同一清理路径。

#### P1-5 修复 `sessionIdToRunId` 永不清理

在 run 结束后或 `stop()` 收尾时清理 `sessionIdToRunId`，不要让 Map 无限增长。

#### P1-6 修复 `recordAgentEnd()` 无 `sessionKey` 回退

当 `ctx.sessionKey` 缺失时，回退到 `activeRuns` 中存储的 `sessionKey`。

#### P1-7 修复 `flush()` 静默吞错

`flush()` 的 catch 体不能为空，至少要记录失败日志；否则持久化失败会静默丢数。

#### P1-8 不要把 `snapshotIntervalMs` 直接绑定到 `flush()`

原提示词这条修复建议不成立。当前已确认的事实只是：

- `snapshotIntervalMs` 被读取
- 但没有任何 snapshot 生产逻辑使用它
- `flush()` 当前是写队列排空机制，默认 100ms

因此本轮正确处理方式是二选一：

1. 保守修复：承认 `snapshotIntervalMs` 目前未生效，不把它接到 `flush()` 上。
2. 完整修复：新增独立 snapshot scheduler，并明确 snapshot 数据来源后，再让 `snapshotIntervalMs` 控制该 scheduler。

如果没有新增 snapshot 采集实现，**就不要改动 `flush()` 的 100ms 节奏**。

---

### P1 — API / 安全

#### P1-9 修复 API handler 无顶层 try/catch

在 `api-routes.ts` 的 handler 最外层包一层 try/catch，避免未捕获异常直接炸出 500 栈。

#### P1-10 修复 NaN 参数问题

所有从 query string 转成数字的地方，都要做 `Number.isFinite()` 校验并提供默认值。

#### P1-11 SSE token 暴露问题

原提示词遗漏了这一项。当前 SSE 通过 `?token=` 传认证信息，已确认这是风险点。

但注意：**不要把这条修复简化成“改成 Bearer header”**，因为原生 `EventSource` 不能自定义请求头。

本轮可接受的修复方向只有两类：

1. 改成基于 `fetch()` 的 SSE 客户端，这样可以走 `Authorization: Bearer ...`
2. 改为由更安全的同源会话/cookie 机制承载认证

如果这轮不打算重构 SSE 客户端，就不要在提示词里把这项描述成“顺手改一下就行”的小改动。

---

### P2 — UI / 次要问题

#### P2-1 修复 SSE 刷新条件过宽

`inject.js:137` 的条件 `|| ev.runId` 会让所有带 `runId` 的事件都触发 audit 详情刷新。
改为只在 `sessionKey` 匹配时刷新：

```javascript
// 改前：
if (S.selSession && (ev.sessionKey === S.selSession || ev.runId)) selectSession(S.selSession);
// 改后：
if (S.selSession && ev.sessionKey === S.selSession) selectSession(S.selSession);
```

#### P2-2 移除 `patchControlUiIndexHtml()` 的默认调用

原提示词遗漏了这一项。既然约束已经明确“不要修改 OpenClaw 本体”，那就不能继续在 `start()` 中调用 `patchControlUiIndexHtml(api)`。

本轮至少应做到：

- 从 `start()` 中移除该调用，或
- 明确禁用该行为并记录 warning

不要再把直接改写 OpenClaw `dist/control-ui/index.html` 当成可接受实现。

#### P2-3 `getSessionRuns()` 删除应降级为可选清理

`getSessionRuns()` 当前确实没有调用方，但“无调用方”本身只证明它是候选死代码，不足以把删除写成硬性修复项。

本轮更稳妥的表述应是：

- 若你已完成全局搜索并确认无未来计划使用，可删
- 否则保留，并在后续单独做 dead-code 清理

#### P2-4 `index.ts` 浅合并丢失嵌套配置

这条修复成立，应改为 collector / compare 两层深合并。

#### P2-5 Comparator 补充必填参数

完成 configSchema 修复后，再修正 `comparator.ts` 的 `runEmbeddedPiAgent()` 调用。
当前缺失的必填参数包括：`sessionId`、`prompt`、`runId`。

- `sessionId`：优先用 `ctx.sessionId`
- `prompt`：从 `event.prompt` 传入
- `runId`：`randomUUID()` 生成

同时不要继续空吞 compare 失败，应记录日志。

#### P2-6 移除 chat audit 的 `unknown` fallback

`refreshChatAudit()` 当前在精确 key 和逐级缩短前缀都查不到结果后，还会回退到 `/audit/session/unknown`。
这个桶聚合的是所有无法解析 sessionKey 的 run，与当前 chat session 不一定相关，会把无关数据混进当前侧栏。

因此本轮应：

- 保留“逐级缩短前缀”的 fallback
- 删除最终的 `/audit/session/unknown` fallback

不要为了“有数据可看”而牺牲关联准确性。

#### P2-7 清理 `CHAT_STATE.pollTimer`

`startChatPolling()` 会创建持续轮询的 `setInterval`，但 `hideChatAuditSidebar()` 当前只移除 DOM，不清理 `pollTimer`。

本轮应在隐藏侧栏时补上：

```javascript
if (CHAT_STATE.pollTimer) {
  clearInterval(CHAT_STATE.pollTimer);
  CHAT_STATE.pollTimer = null;
}
```

否则即使侧栏关闭或路由切走，轮询仍会继续运行。

---

## 4. 测试文件修复

当前三个测试文件导入不存在的 `.js` 文件：

```text
tests/collector.test.ts       → ../src/collector.js
tests/cost-calculator.test.ts → ../src/cost-calculator.js
tests/sse-manager.test.ts     → ../src/sse-manager.js
```

### 4-A 先修测试内容本身

- 把 `collector.test.ts` 里陈旧的 `input` / `content` / `isError` 断言更新为 `params` / `result` / `error`
- 同步更新 `recordLlmCall` 改名带来的调用点

### 4-B 不要照搬原提示词里的错误脚本

原文提供的这段方案：

```json
{
  "scripts": {
    "test": "tsc --noEmit false --outDir dist-test && node --test tests/*.test.js"
  }
}
```

有两个问题：

1. `extensions/clawlens/` 目录下当前没有本地 `tsconfig*.json`
2. 编译到 `dist-test` 后，再跑 `tests/*.test.js` 路径不对

因此本轮应改成下面两类之一：

1. 若工作区现成可用 `tsx`，优先用运行时转译：

```json
{
  "scripts": {
    "test": "node --import tsx --test tests/*.test.ts"
  }
}
```

2. 若必须走编译产物，则脚本必须同时补齐 tsconfig 和正确输出路径，例如：

```json
{
  "scripts": {
    "test:build": "tsc -p tsconfig.test.json --outDir dist-test",
    "test": "npm run test:build && node --test dist-test/tests/*.test.js"
  }
}
```

不要把“半成品脚本”直接写进实施提示词。

---

## 5. 验证

### 5-A 本地验证（保留可直接复验的项）

```bash
# 1. inject.js 语法
node --check extensions/clawlens/ui/inject.js

# 2. cost-calculator NaN 修复验证
node -e "
import { calculateCost, loadCostConfig } from './extensions/clawlens/src/cost-calculator.ts';
const m = loadCostConfig({models:{providers:{p:{models:{m:{cost:{input:1}}}}}}});
console.assert(m.size === 0, '不完整 config 不应入表');
const m2 = loadCostConfig({models:{providers:{p:{models:{m:{cost:{input:1,output:2,cacheRead:0,cacheWrite:0}}}}}}});
console.assert(m2.size === 1, '完整 config 应入表');
console.log('OK');
"

# 3. NaN 查询参数修复验证（验证修复后的解析逻辑，而不是只复现旧错误）
node -e "
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE runs (run_id TEXT, started_at INTEGER)');
db.exec(\"INSERT INTO runs VALUES ('r1', 1000)\");
function parseIntParam(v, d) {
  if (v === null) return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
}
const limit = parseIntParam('foo', 50);
const rows = db.prepare('SELECT * FROM runs LIMIT ? OFFSET ?').all(limit, 0);
console.assert(rows.length === 1, '修复后应返回 1 行，而不是 datatype mismatch');
console.log('OK');
"
```

### 5-B 测试命令

只有在你先补齐测试运行方案后，才执行测试；不要把“尚未配置完成的命令”当成必过验证。

### 5-C 远程部署

远程部署命令可以保留为操作示例，但在提示词里应明确它们依赖本地 alias / 远端环境：

- `rscp`
- `rssh`
- `sshpass`
- `google-chrome --headless`

这些不是仓库内可推导出的通用前提，不能写成“默认一定存在”。

---

## 6. 约束

- 只修改 `extensions/clawlens/` 目录下的文件
- 不修改 OpenClaw 的任何文件（包括 `dist/control-ui/index.html`）
- 不安装全局包
- Hook 注册用 `api.on()`，不是 `api.registerHook()`
- SQLite 用 `node:sqlite`（`DatabaseSync`）
- `agent_end` hook 的 context 没有 `runId`，通过 `sessionIdToRunId` Map 关联
- 不要在 `before_message_write` / `tool_result_persist` handler 里返回 Promise（会被框架忽略）
- 不要把 `snapshotIntervalMs` 简单改成 `flush()` 间隔

---

## 7. 改动顺序建议

1. `openclaw.plugin.json` — configSchema
2. `src/cost-calculator.ts` — NaN 防护
3. `src/store.ts` — cleanup 事务、computeCostMatch
4. `src/collector.ts` — `recordLlmOutput` 改名、`officialCost`、`flush` 加日志、`sessionIdToRunId` 清理、`recordAgentEnd` 回退
5. `index.ts` — 更新 hook 名称、深合并 config、移除 `patchControlUiIndexHtml(api)` 默认调用
6. `src/api-routes.ts` — try/catch、NaN 防护
7. `ui/inject.js` — SSE 刷新条件修窄、移除 `unknown` fallback、清理 `pollTimer`；若本轮重构 SSE 认证，再一起处理 token in query
8. `tests/` — 修复 import 路径和字段名，再补测试运行方案
9. Comparator（最后，依赖 configSchema 修复）
