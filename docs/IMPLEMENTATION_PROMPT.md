# ClawLens — 代码实现提示词（完整版）

> 基于四份复核文档（2026-04-01）生成。
> 涵盖 Bug 修复、功能补全、本地验证与远程部署，合并自 `claude-code-prompt.md` 和 `claude-code-prompt-update.md`。

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
| Comparator 对 `runEmbeddedPiAgent()` 的调用缺少必填参数 `sessionId`、`prompt`、`runId` | `comparator.ts:72-96`, `params.ts:27-105` |
| `loadCostConfig()` 只检查 `cost.input` 是否为 number，`output`/`cacheRead`/`cacheWrite` 缺失时 `calculateCost()` 返回 `NaN` | `cost-calculator.ts:17-26` |
| `Store.getSessions({ limit: NaN })` 会触发 SQLite `datatype mismatch`（已本地复现） | `api-routes.ts:83`, `store.ts:401` |
| `collector.test.ts`/`cost-calculator.test.ts`/`sse-manager.test.ts` 导入不存在的 `../src/*.js`，直接报 `ERR_MODULE_NOT_FOUND` | 三个测试文件 import 行 |
| `patchControlUiIndexHtml()` 会直接改写 OpenClaw 自身 `dist/control-ui/index.html` | `index.ts:34-58,102` |
| SSE 当前通过 `/events?token=...` 传 token，token 暴露在 URL 查询参数；原生 `EventSource` 不支持自定义请求头，不能简单改成 Bearer header | `api-routes.ts:33-58`, `inject.js:125-127` |

---

## 3. Bug 修复清单（按优先级）

### P0 — 数据根本性错误

#### P0-1 修正 `recordLlmCall()` 的语义注释和 run-level 汇总逻辑

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
// event 的类型是 any，运行时字段不在 TS 类型中
const rawUsage = (event as any).usage ?? {};
const officialCost =
  typeof rawUsage?.cost?.total === "number" && Number.isFinite(rawUsage.cost.total)
    ? (rawUsage.cost.total as number)
    : null;
```

---

### P1 — Store / 数据完整性

#### P1-1 修复 `openclaw.plugin.json` — 开放 configSchema

把空对象 schema 替换为实际支持的配置字段，否则用户无法通过正常路径传入任何配置：

```json
{
  "id": "clawlens",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "collector": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "enabled":            { "type": "boolean" },
          "snapshotIntervalMs": { "type": "number" },
          "retentionDays":      { "type": "number" }
        }
      },
      "compare": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "enabled":       { "type": "boolean" },
          "models":        { "type": "array", "items": { "type": "object" } },
          "channels":      { "type": "array", "items": { "type": "string" } },
          "timeoutMs":     { "type": "number" },
          "maxConcurrent": { "type": "number" }
        }
      }
    }
  }
}
```

#### P1-2 `snapshotIntervalMs` 配置项当前无效（不要改动 flush() 间隔）

`collector.ts` 的 `start()` 读取了 `intervalMs`（默认 60_000），但 `setInterval` 写死为 `100ms`——这两个数字语义不同：100ms 是写队列排空节奏，60s 是 snapshot 采集节奏，直接替换会让写库从 100ms 变成 60s，造成严重延迟。

本轮二选一：

1. **保守修复**：保留 `setInterval(..., 100)` 不变，仅在注释中说明 `snapshotIntervalMs` 目前未生效，等待 snapshot 采集逻辑实现后再接入。
2. **完整修复**：新增独立 snapshot scheduler，明确 snapshot 数据来源后，再让 `snapshotIntervalMs` 控制该 scheduler 的间隔。

**不要把 `intervalMs` 直接传给 `flush()` 的 `setInterval`。**

#### P1-3 修复 `loadCostConfig()` — 校验全部四个字段

只有四个数值字段都是有限数字时才入表：

```typescript
// 改前：
if (cost && typeof cost.input === "number") map.set(...)
// 改后：
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

#### P1-4 修复 `computeCostMatch(null, null)` 假阳性

双方都没有数据时不应显示为"匹配"：

```typescript
// 改前：
if (official == null && calculated == null) return { costMatch: true };
// 改后：
if (official == null && calculated == null) return { costMatch: false, costDiffReason: "no cost data available" };
```

#### P1-5 修复 `cleanup()` — 加事务

把现有多个 DELETE 操作包进一个事务，防止中途崩溃产生部分清理状态：

```typescript
cleanup(retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const deletedRuns = this.db.prepare("SELECT run_id FROM runs WHERE started_at < ?").all(cutoff) as { run_id: string }[];

  this.db.exec("BEGIN");
  try {
    for (const { run_id } of deletedRuns) {
      this.db.prepare("DELETE FROM conversation_turns WHERE run_id = ?").run(run_id);
      this.db.prepare("DELETE FROM llm_calls WHERE run_id = ?").run(run_id);
      this.db.prepare("DELETE FROM tool_executions WHERE run_id = ?").run(run_id);
    }
    this.stmtCleanup.run(cutoff);  // DELETE FROM runs WHERE started_at < ?
    this.db.prepare("DELETE FROM session_snapshots WHERE snapshot_at < ?").run(cutoff);
    this.db.exec("COMMIT");
  } catch (e) {
    this.db.exec("ROLLBACK");
    throw e;
  }
}
```

注意：`conversation_turns` 也在这里删除了（下一条 P1-6 的修复已合并进来）。

#### P1-6 修复 `conversation_turns` 不受保留策略覆盖

已合并到 P1-5 的 `cleanup()` 修复中（在事务内对每个 `run_id` 先删 `conversation_turns`）。

#### P1-7 修复 `sessionIdToRunId` 永不清理

在 `stop()` 方法末尾加：

```typescript
this.sessionIdToRunId.clear();
```

#### P1-8 修复 `recordAgentEnd()` 无 `sessionKey` 回退

当 `ctx.sessionKey` 缺失时，回退到 `activeRuns` 中存储的 sessionKey：

```typescript
recordAgentEnd(event: { messages?: unknown[]; success?: boolean; durationMs?: number }, ctx: { sessionKey?: string; sessionId?: string }): void {
  const runId = ctx.sessionId ? this.sessionIdToRunId.get(ctx.sessionId) : undefined;
  if (!runId) return;
  // 回退：优先用 ctx.sessionKey，没有则从 activeRuns 取
  const sessionKey = ctx.sessionKey ?? this.activeRuns.get(runId)?.sessionKey;
  if (!sessionKey) return;

  const messages = (event.messages ?? []) as Array<{ role?: string; content?: string | unknown[] }>;
  let turnIndex = 0;
  this.enqueue(() => {
    for (const msg of messages) {
      const role = msg.role ?? "unknown";
      const raw = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content ?? "");
      this.store.insertConversationTurn(runId, sessionKey, turnIndex++, role, raw.slice(0, 500), raw.length, Date.now());
    }
  });
}
```

#### P1-9 修复 `flush()` 静默吞错

catch 体不能为空，至少输出一条日志（Collector 持有 logger 的话用 logger，否则用 console.error）：

```typescript
private flush(): void {
  const ops = this.queue.splice(0);
  for (const op of ops) {
    try {
      op();
    } catch (e) {
      console.error("[clawlens] flush: store write failed:", e);
    }
  }
}
```

---

### P1 — API 层

#### P1-10 SSE token 暴露在 URL 查询参数

当前 `/events?token=...` 把认证 token 放在 URL 里，会出现在服务端访问日志、浏览器历史、代理日志中。

**注意**：原生 `EventSource` 不支持自定义请求头，不能简单改成 `Authorization: Bearer`。可接受的修复方向只有两类：

1. 改成基于 `fetch()` 的 SSE 客户端（`inject.js` 侧），这样可以走 `Authorization: Bearer ...`
2. 改为由更安全的同源会话/cookie 机制承载认证

如果本轮不打算重构 SSE 客户端，就暂不处理此项，不要引入半成品修复。

#### P1-11 修复 API handler 无顶层 try/catch

在 `api-routes.ts` 的 handler 函数体最外层包一层 try/catch：

```typescript
handler(req, res) {
  try {
    // ... 现有所有路由逻辑 ...
  } catch (err) {
    sendJson(res, 500, { error: "internal server error" });
  }
}
```

#### P1-12 修复 NaN 注入 — 校验 Number() 转换结果

所有从 query string 转换为数字的地方，加有效性检查：

```typescript
// 通用工具函数（加在文件顶部）：
function parseIntParam(value: string | null, defaultValue: number): number {
  if (value === null) return defaultValue;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultValue;
}

// 使用：
filters.limit  = parseIntParam(url.searchParams.get("limit"), 50);
filters.offset = parseIntParam(url.searchParams.get("offset"), 0);
const days     = parseIntParam(url.searchParams.get("days"), 7);
const limit    = parseIntParam(url.searchParams.get("limit"), 100);
```

---

### P2 — UI / 次要问题

#### P2-1 修复 SSE 刷新条件过宽

`inject.js:137` 的条件 `|| ev.runId` 会让所有带 `runId` 的事件都触发 audit 详情刷新。
改为只在 sessionKey 匹配时刷新：

```javascript
// 改前：
if (S.selSession && (ev.sessionKey === S.selSession || ev.runId)) selectSession(S.selSession);
// 改后：
if (S.selSession && ev.sessionKey === S.selSession) selectSession(S.selSession);
```

#### P2-2 移除 `patchControlUiIndexHtml()` 的默认调用

`index.ts` 的 `start()` 中调用了 `patchControlUiIndexHtml(api)`，会直接改写 OpenClaw 自身 `dist/control-ui/index.html`。这与约束"不修改 OpenClaw 本体"矛盾。

本轮至少做到以下之一：
- 从 `start()` 中移除该调用
- 改为记录 warning 并跳过

不要继续把改写 OpenClaw dist 产物当成可接受实现。

#### P2-3 `getSessionRuns()` 死代码（可选清理）

`store.ts` 中的 `getSessionRuns()` 方法当前无调用方，且只读取了旧的 `cost_usd` 字段，未包含 `official_cost`/`calculated_cost`。"无调用方"本身只是候选死代码证据，不足以强制删除。

处理方式：
- 若已全局搜索确认无计划使用，可删除
- 否则保留，留待后续单独做 dead-code 清理

#### P2-4 修复 `index.ts` 浅合并丢失嵌套配置

```typescript
// 改前：
const config: ClawLensConfig = { ...defaultConfig, ...(api.pluginConfig as ClawLensConfig) };
// 改后（深合并 collector 和 compare 子对象）：
const userConfig = (api.pluginConfig ?? {}) as Partial<ClawLensConfig>;
const config: ClawLensConfig = {
  collector: { ...defaultConfig.collector, ...(userConfig.collector ?? {}) },
  compare:   { ...defaultConfig.compare,   ...(userConfig.compare   ?? {}) },
};
```

#### P2-5 Comparator 补充必填参数（configSchema 修复后才有意义）

完成 P1-1 的 configSchema 修复后，再修正 `comparator.ts` 的 `runEmbeddedPiAgent()` 调用。
当前缺失的必填参数：`sessionId`、`prompt`、`runId`。

- `sessionId`：可从 `ctx.sessionId` 传入（若存在），或用 `randomUUID()` 生成。
- `prompt`：Comparator 从 `before_agent_start` 事件中已拿到原始 prompt，从 `event.prompt` 传入。
- `runId`：`randomUUID()` 生成。

同时在 catch 块加日志：

```typescript
} catch (err) {
  console.error(`[clawlens] compare run failed (${provider}/${model}):`, err);
}
```

---

## 4. 测试文件修复

当前三个测试文件导入不存在的 `.js` 文件：

```
tests/collector.test.ts       → ../src/collector.js       (不存在)
tests/cost-calculator.test.ts → ../src/cost-calculator.js (不存在)
tests/sse-manager.test.ts     → ../src/sse-manager.js     (不存在)
```

**注意**：`extensions/clawlens/` 目录下没有本地 `tsconfig*.json`，不能直接用 `tsc --outDir dist-test` 方案。

**先修测试内容本身**：
- 把 `collector.test.ts` 里陈旧的 `input`/`content`/`isError` 改为 `params`/`result`/`error`（与当前 `recordToolCall` 实现对齐）
- 同步更新 `recordLlmCall` 改名带来的调用点

**再选择运行方案（二选一）**：

1. 若工作区现成可用 `tsx`，优先用运行时转译：

```json
{
  "scripts": {
    "test": "node --import tsx --test tests/*.test.ts"
  }
}
```

2. 若必须走编译产物，则需同时补齐 `tsconfig.test.json` 和正确输出路径：

```json
{
  "scripts": {
    "test:build": "tsc -p tsconfig.test.json --outDir dist-test",
    "test": "npm run test:build && node --test dist-test/tests/*.test.js"
  }
}
```

只有在运行方案确认可用后，才把测试命令写进验证步骤。

---

## 5. 验证

### 5-A 本地验证（每批改完立即跑）

```bash
# 1. inject.js 语法
node --check extensions/clawlens/ui/inject.js && echo "✅ inject.js OK"

# 2. cost-calculator NaN 修复验证（纯 JS，无需构建）
node -e "
function loadCostConfig(config) {
  const map = new Map();
  const providers = config?.models?.providers;
  if (!providers) return map;
  for (const [pName, pConfig] of Object.entries(providers)) {
    for (const [mName, mConfig] of Object.entries(pConfig.models ?? {})) {
      const cost = mConfig.cost;
      if (cost &&
          typeof cost.input === 'number' && Number.isFinite(cost.input) &&
          typeof cost.output === 'number' && Number.isFinite(cost.output) &&
          typeof cost.cacheRead === 'number' && Number.isFinite(cost.cacheRead) &&
          typeof cost.cacheWrite === 'number' && Number.isFinite(cost.cacheWrite)) {
        map.set(pName + ':' + mName, cost);
      }
    }
  }
  return map;
}
// 不完整 config 不应入表
const m = loadCostConfig({models:{providers:{p:{models:{m:{cost:{input:1}}}}}}});
console.assert(m.size === 0, '不完整 config 不应入表');
// 完整 config 应入表
const m2 = loadCostConfig({models:{providers:{p:{models:{m:{cost:{input:1,output:2,cacheRead:0,cacheWrite:0}}}}}}});
console.assert(m2.size === 1, '完整 config 应入表');
console.log('✅ cost-calculator NaN 修复 OK');
"

# 3. NaN 查询参数修复验证（SQLite，纯 JS）
node -e "
const { DatabaseSync } = require('node:sqlite');
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
console.assert(rows.length === 1, '应返回 1 行');
console.log('✅ NaN 防护 OK');
"
```

### 5-B 远程部署

> 以下命令依赖本地已配置的 `rscp`/`rssh` alias、`$REMOTE_HOST`/`$REMOTE_PORT` 环境变量。
> 这些不是仓库内可推导出的通用前提，执行前确认环境已就绪。

```bash
# 同步文件到远程（rscp 为已配置的 alias）
rscp -r extensions/clawlens/ $REMOTE_HOST:~/.openclaw/extensions/clawlens/

# 重启 gateway
rssh "openclaw gateway restart 2>&1"
sleep 10

# 验证插件加载
rssh "openclaw gateway logs 2>&1 | grep -i clawlens | tail -10"

# 验证 API 端点
rssh "curl -s http://localhost:18789/plugins/clawlens/api/overview"
rssh "curl -s 'http://localhost:18789/plugins/clawlens/api/sessions?limit=5'"
rssh "curl -s 'http://localhost:18789/plugins/clawlens/api/audit?days=7&limit=10'"

# 验证 NaN 修复（应返回正常数据，不是 500）
rssh "curl -s 'http://localhost:18789/plugins/clawlens/api/sessions?limit=foo'"
rssh "curl -s 'http://localhost:18789/plugins/clawlens/api/audit?days=foo'"
```

### 5-C UI 验证（截图）

> 依赖 `sshpass`、`google-chrome --headless`，以及已配置的 `rssh` alias。确认本地环境具备后再执行。

```bash
# 建立 SSH 隧道（若尚未建立）
sshpass -e ssh -o StrictHostKeyChecking=no -p $REMOTE_PORT \
  -L 18789:127.0.0.1:18789 -N -f $REMOTE_HOST

# 获取 dashboard URL
DASHBOARD_URL=$(rssh "openclaw dashboard --no-open 2>&1" | grep -oP 'http://[^\s]+')
TOKEN=$(echo "$DASHBOARD_URL" | grep -oP 'token=\K[^&]+')

# Overview 截图
google-chrome --headless=new --no-sandbox --disable-gpu \
  --screenshot=/tmp/clawlens-overview.png \
  --window-size=2560,1440 \
  "${DASHBOARD_URL}"

# Chat + Audit 侧栏截图
google-chrome --headless=new --no-sandbox --disable-gpu \
  --screenshot=/tmp/clawlens-chat.png \
  --window-size=2560,1440 \
  "http://localhost:18789/chat?token=${TOKEN}"

echo "截图: /tmp/clawlens-overview.png  /tmp/clawlens-chat.png"
```

---

## 6. 约束

- 只修改 `extensions/clawlens/` 目录下的文件
- 不修改 OpenClaw 的任何文件（包括 `dist/control-ui/index.html`）
- 不安装全局包
- Hook 注册用 `api.on()`，不是 `api.registerHook()`
- 所有颜色用 CSS 变量 `var(--name, fallback)`
- SQLite 用 `node:sqlite`（`DatabaseSync`）
- `agent_end` hook 的 context 没有 `runId`，通过 `sessionIdToRunId` Map 关联
- 不要在 `before_message_write` / `tool_result_persist` handler 里返回 Promise（会被框架忽略）
- 不要把 `snapshotIntervalMs` 直接改成 `flush()` 的 setInterval 间隔

---

## 7. 改动顺序建议

1. `openclaw.plugin.json` — configSchema（改完立即能测试配置注入）
2. `src/cost-calculator.ts` — NaN 防护（影响所有成本计算）
3. `src/store.ts` — cleanup 事务、computeCostMatch（getSessionRuns 可选清理）
4. `src/collector.ts` — recordLlmOutput 改名、officialCost、flush 加日志、sessionIdToRunId 清理、recordAgentEnd 回退（snapshotIntervalMs 保守处理，不改 flush 间隔）
5. `index.ts` — 更新 hook 名称、深合并 config、移除 patchControlUiIndexHtml 默认调用
6. `src/api-routes.ts` — try/catch、NaN 防护（SSE token 修复见下条）
7. `ui/inject.js` — SSE 刷新条件修窄；SSE token 认证重构（若本轮决定处理，需同步改 inject.js 和 api-routes.ts）
8. `tests/` — 先修字段名，再确认运行方案后修 import 路径
9. Comparator（最后，依赖 configSchema 修复）
