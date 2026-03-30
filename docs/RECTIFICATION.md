# ClawLens 代码整改文档

> 基于 architecture.md v2.0 与当前代码的对比分析
> 生成日期：2026-03-27

---

## 一、整改概览

| 优先级 | 问题 | 影响 | 整改工作量 |
|--------|------|------|-----------|
| P0 | `officialCost` 未实现 | 核心审计功能（cost 对比）不可用 | 中 |
| P0 | 成本计算无 fallback | 无配置时 cost 全为 null | 中 |
| P1 | `onSessionTranscriptUpdate` 未使用 | 文档与实现不一致 | 低 |
| P1 | 对比 API 端点缺失 | 模块 B 功能不完整 | 高 |
| P1 | `workspaceMode` 字段缺失 | 配置与文档不一致 | 低 |
| P2 | 文档伪代码与实现细节不符 | 维护困扰 | 低 |

---

## 二、P0 级整改（核心功能）

### 2.1 实现 `officialCost`（从 `message.usage.cost` 提取）

**问题**：`recordLlmCall` 中 `officialCost` 始终为 `undefined`，导致 cost 对比功能不可用。

**整改方案**：

`llm_output` hook 的 `PluginHookLlmOutputEvent` 中是否有 `usage.cost`？

查阅 OpenClaw 源码 `PluginHookLlmOutputEvent`：
```typescript
export type PluginHookLlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};
```

**问题**：`usage` 类型定义中**没有** `cost` 字段。

这意味着 `llm_output` hook 本身不提供 `usage.cost` 数据。需要另寻数据源。

**可能的方案**：
1. **从 `onSessionTranscriptUpdate` 获取**（如果该事件包含完整 `message.usage`）
2. **从 `agent_end` 的 `event.messages` 中查找最后一条 assistant message 的 usage**
3. **在 `collector.ts` 中同时监听 transcript update**作为补充

**推荐实施**：

在 `collector.ts` 中添加 `onSessionTranscriptUpdate` 监听：

```typescript
// 在 Collector.start() 中注册
private unsubTranscript: (() => void) | null = null;

start(runtime: any, config: any, pluginConfig: ClawLensConfig) {
  // ...
  // 从 transcript 更新中提取完整的 message.usage（包含 cost）
  this.unsubTranscript = runtime.events.onSessionTranscriptUpdate((update: any) => {
    const msg = update.message;
    if (msg?.role !== 'assistant') return;
    const usage = msg.usage as any;
    if (usage?.cost?.total != null) {
      // 通过 sessionKey 找到对应的 run，更新其 officialCost
      this.updateRunOfficialCost(update.sessionKey, usage.cost.total);
    }
  });
}

stop() {
  // ...
  this.unsubTranscript?.();
}
```

**注意**：需要验证 `onSessionTranscriptUpdate` 是否能正常工作。OpenClaw 的 transcript 更新机制需要确认。

---

### 2.2 实现三层 fallback 成本计算

**问题**：`cost-calculator.ts` 只有单层 fallback（从 config 读取），文档描述应为三层 fallback。

**整改方案**：

有两种选择：

**方案 A（推荐）**：使用 OpenClaw 官方函数

```typescript
// cost-calculator.ts

// 从 openclaw 官方 utils 导入（如果可用）
import { resolveModelCostConfig, estimateUsageCost } from "../../utils/usage-format.js";

export function calculateCost(
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  provider: string | undefined,
  model: string | undefined,
  globalConfig: any,
): number | null {
  const costConfig = resolveModelCostConfig({ provider, model, config: globalConfig });
  if (!costConfig) return null;
  return estimateUsageCost({ usage, cost: costConfig });
}
```

**注意**：extensions 在同一个 monorepo 中，可以 import 官方 utils。但需要确认这些函数的可用性和兼容性。

**方案 B**：在 `cost-calculator.ts` 中自己实现三层 fallback

```typescript
export function resolveModelCostConfig(params: {
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
}): ModelCostConfig | undefined {
  // Layer 1: 从 config.models.providers 读取
  const providerConfig = params.config?.models?.providers?.[params.provider ?? ''];
  const modelConfig = providerConfig?.models?.[params.model ?? ''];
  if (modelConfig?.cost) {
    return modelConfig.cost;
  }

  // Layer 2: gateway model pricing cache（需要 runtime 支持）
  // TODO: 从 runtime 获取 cached pricing

  // Layer 3: bundled models.json（需要读取 agent dir）
  // TODO: 从 agent dir 读取 models.json

  return undefined;
}
```

**建议**：先实现 Layer 1（当前已有），标记 Layer 2/3 为 TODO，保持与文档描述的接口一致。

---

## 三、P1 级整改（功能完整）

### 3.1 实现对比 API 端点

**缺失的端点**：
- `GET /api/compare/:groupId`
- `GET /api/compare/list`
- `POST /api/compare/trigger`

**整改方案**：

在 `api-routes.ts` 中添加：

```typescript
// /compare/list
if (pathname.match(/\/compare\/list$/)) {
  const since = url.searchParams.get("since");
  const limit = url.searchParams.get("limit") ?? "50";
  sendJson(res, 200, store.getCompareList(Number(limit), since ? Number(since) : undefined));
  return;
}

// /compare/:groupId
const compareGroupMatch = pathname.match(/\/compare\/([^/]+)$/);
if (compareGroupMatch) {
  const groupId = decodeURIComponent(compareGroupMatch[1]);
  sendJson(res, 200, store.getCompareGroup(groupId));
  return;
}

// /compare/trigger (POST)
if (pathname.endsWith("/compare/trigger") && req.method === "POST") {
  // 触发手动对比运行
  // 需要将控制权交给 comparator
  sendJson(res, 501, { error: "not implemented yet" });
  return;
}
```

在 `store.ts` 中添加方法：

```typescript
getCompareList(limit: number, since?: number): unknown[] {
  const cutoff = since ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
  return this.db.prepare(`
    SELECT compare_group_id, COUNT(*) as run_count,
           MIN(started_at) as started_at,
           MAX(ended_at) as ended_at
    FROM runs
    WHERE compare_group_id IS NOT NULL
      AND started_at >= ?
    GROUP BY compare_group_id
    ORDER BY started_at DESC
    LIMIT ?
  `).all(cutoff, limit);
}

getCompareGroup(groupId: string): unknown {
  const runs = this.db.prepare(`
    SELECT * FROM runs WHERE compare_group_id = ? ORDER BY started_at
  `).all(groupId);

  const runIds = runs.map((r: any) => r.run_id);
  if (runIds.length === 0) return { groupId, runs: [] };

  const llmCalls = this.db.prepare(`
    SELECT * FROM llm_calls WHERE run_id IN (${runIds.map(() => '?').join(',')})
    ORDER BY started_at
  `).all(...runIds);

  return { groupId, runs, llmCalls };
}
```

---

### 3.2 移除 `workspaceMode` 配置项

**问题**：文档描述了 `workspaceMode` 配置项，但代码未实现。

**整改方案**：

从 `types.ts` 的 `ClawLensConfig` 中删除该字段（如果已添加）。当前代码中不存在该字段，无需操作。

如果后续需要实现，添加到配置中。

---

### 3.3 实现 Config 热更新 API

**缺失的端点**：`POST /api/config`

**整改方案**：

```typescript
// api-routes.ts
if (pathname.endsWith("/config") && req.method === "POST") {
  let body = "";
  req.on("data", chunk => body += chunk);
  req.on("end", () => {
    try {
      const newConfig = JSON.parse(body);
      // 更新内存中的 config（需要通过某种机制传递回 index.ts）
      sseManager.broadcast({ type: "config_updated", config: newConfig });
      sendJson(res, 200, { success: true });
    } catch {
      sendJson(res, 400, { error: "invalid config" });
    }
  });
  return;
}
```

**注意**：这需要 index.ts 和 api-routes.ts 之间有配置共享机制（当前通过 closure 或直接传递）。

---

### 3.4 实现统计 API

**缺失的端点**：
- `GET /api/stats/channels`
- `GET /api/stats/models`

**整改方案**：

```typescript
// api-routes.ts
if (pathname.endsWith("/stats/channels")) {
  sendJson(res, 200, store.getChannelStats());
  return;
}

if (pathname.endsWith("/stats/models")) {
  sendJson(res, 200, store.getModelStats());
  return;
}

// store.ts
getChannelStats(): unknown {
  return this.db.prepare(`
    SELECT channel,
           COUNT(*) as run_count,
           SUM(total_input_tokens + total_output_tokens) as total_tokens,
           SUM(total_cost_usd) as total_cost,
           AVG(duration_ms) as avg_duration_ms
    FROM runs
    WHERE channel IS NOT NULL
    GROUP BY channel
    ORDER BY total_cost DESC
  `).all();
}

getModelStats(): unknown {
  return this.db.prepare(`
    SELECT provider, model,
           COUNT(*) as run_count,
           SUM(total_input_tokens + total_output_tokens) as total_tokens,
           SUM(total_cost_usd) as total_cost,
           AVG(duration_ms) as avg_duration_ms
    FROM runs
    WHERE model IS NOT NULL
    GROUP BY provider, model
    ORDER BY total_cost DESC
  `).all();
}
```

---

## 四、P2 级整改（文档对齐）

### 4.1 文档伪代码 vs 实际代码

**问题**：architecture.md v1.0 中的伪代码与实际实现有出入。

**说明**：architecture.md v2.0 已修正这些问题，本整改文档建议保持代码不变，文档已同步更新。

**无需代码整改**。

---

### 4.2 `onSessionTranscriptUpdate` 使用问题

**问题**：文档说要用 `onSessionTranscriptUpdate`，但代码未使用。

**分析**：这是一个设计选择问题。当前使用 `llm_output` hook 是可行的，因为该 hook 确实提供 per-call 数据。

**建议**：
1. 如果未来发现 `llm_output` 数据不完整（如缺少 `usage.cost`），则添加 `onSessionTranscriptUpdate` 作为补充
2. architecture.md v2.0 已更新描述，不再说必须使用 `onSessionTranscriptUpdate`

**无需代码整改**。

---

## 五、整改实施建议

### 优先级排序

1. **立即处理**：`officialCost` 实现（影响核心功能）
2. **下一个 sprint**：
   - 对比 API 端点（/compare/list, /compare/:groupId）
   - 三层 fallback 成本计算 Layer 1
3. **后续迭代**：
   - 统计 API
   - Config 热更新
   - Layer 2/3 fallback

### 实施检查清单

```markdown
## P0 整改检查清单

### officialCost 实现
- [ ] 调研 onSessionTranscriptUpdate 的 message.usage.cost 可用性
- [ ] 在 collector.ts 中添加 transcript 监听
- [ ] 实现 updateRunOfficialCost 逻辑
- [ ] 验证 cost 对比 UI 显示正确

### 三层 fallback
- [ ] 确认官方 resolveModelCostConfig 可用性
- [ ] 实现 Layer 1 fallback（已有）
- [ ] 标记 Layer 2/3 为 TODO
- [ ] 验证无配置时 cost 计算行为

## P1 整改检查清单

### 对比 API
- [ ] 添加 store.getCompareList()
- [ ] 添加 store.getCompareGroup()
- [ ] 在 api-routes.ts 添加路由
- [ ] 验证前端可以查询对比结果

### 统计 API
- [ ] 添加 store.getChannelStats()
- [ ] 添加 store.getModelStats()
- [ ] 在 api-routes.ts 添加路由

### Config 热更新
- [ ] 设计配置共享机制
- [ ] 实现 POST /api/config
- [ ] 验证配置更新生效
```

---

## 六、测试建议

### 6.1 核心功能测试

1. **Cost 对比显示**
   - 配置自定义定价 → cost 显示 CALCULATED
   - 使用 pi-ai 内置定价（配置为空）→ cost 为 null 或 fallback
   - 验证 UI 显示正确

2. **瀑布图数据完整性**
   - 单次 LLM 调用 → 1 个 timeline 条目
   - 带 2 次 tool call 的运行 → 5 个 timeline 条目（LLM → tool → tool → LLM）
   - 验证 timeline 时间顺序正确

### 6.2 集成测试

1. **对比运行**
   - 启用 compare，发送消息到目标 channel
   - 验证主运行正常完成
   - 验证对比运行被触发
   - 验证 compare_group_id 正确关联

2. **SSE 推送**
   - 启动 SSE 连接
   - 触发一个 run
   - 验证收到 run_started, llm_call, tool_executed, run_ended 事件

### 6.3 边界测试

1. **无配置时 cost 计算**
   - 清空 config.models.providers
   - 触发一个 run
   - 验证 calculated_cost 为 null，不报错

2. **Session key 回退**
   - heartbeat agent（无 sessionKey）
   - 验证 sessionKey 回退到 `agent:{agentId}` 或 `unknown`

---

## 七、总结

本次整改的核心目标是**让代码与 architecture.md v2.0 保持一致**。

**最高优先级的整改**：
1. `officialCost` 实现 —— 需要找到 `usage.cost` 的数据源
2. 三层 fallback 成本计算 —— 需要确认官方函数可用性

**次优先级整改**：
3. 对比 API 端点 —— 代码实现成本不高
4. 统计 API —— 代码实现成本不高

**无需整改**：
- 文档伪代码问题（已通过文档更新解决）
- `onSessionTranscriptUpdate` 未使用（设计选择，代码可行）
