# ClawLens 架构文档 vs OpenClaw v2026.3.28 代码对比分析

> 基于 OpenClaw v2026.3.28 源码重新验证 architecture.md 文档的准确性
> 分析日期：2026-03-30
> ClawLens 代码版本：当前 extensions/clawlens/

---

## 执行摘要

本次重新分析解决了两个核心问题：
1. 之前基于 v2026.3.23 的分析是否需要修正
2. 新版 openclaw 是否有破坏性变更影响 ClawLens

**结论**：OpenClaw v2026.3.28 相对 v2026.3.23 **没有破坏性变更**。但 ClawLens 代码与 architecture.md 之间存在**结构性不匹配**——文档描述的数据采集方式与实际代码实现不符。

---

## 一、OpenClaw v2026.3.28 变更确认

### 1.1 `llm_output` 触发机制：**确认 per-run**

通过阅读 `src/agents/pi-embedded-runner/run/attempt.ts` 确认：

```typescript
// attempt.ts 第 3133-3158 行
// 在 finally 块中调用，整个 run 结束后执行一次
if (hookRunner?.hasHooks("llm_output")) {
  hookRunner.runLlmOutput({
    runId: params.runId,
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.modelId,
    assistantTexts,
    lastAssistant,
    usage: getUsageTotals(),  // ← 整个 run 的累计 usage
  }, { /* context */ });
}
```

**结论**：`llm_output` 是 **per-run** 触发，不是 per-LLM-call。architecture.md 对此的描述**正确**。

### 1.2 `PluginHookLlmOutputEvent.usage`** 无 `cost` 字段

```typescript
// src/plugins/types.ts 第 1586-1600 行
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
    // ⚠️ 没有 cost 字段！
  };
};
```

`cost` breakdown 只存在于 transcript JSONL 中（`message.usage.cost`），不在 hook event 中。

**结论**：architecture.md 第 40-41 行描述"`message.usage.cost`"是"从 `onSessionTranscriptUpdate` 监听到的 `message.usage` 中直接提取"，这是**正确的**（transcript 中的 message 包含 cost）。但 ClawLens 代码**没有使用** `onSessionTranscriptUpdate`。

### 1.3 `resolveModelCostConfig` + `estimateUsageCost`** 三层 Fallback 存在

```typescript
// src/utils/usage-format.ts 第 137-158 行
export function resolveModelCostConfig(params: {...}): ModelCostConfig | undefined {
  // Layer 1: models.json
  const modelsJsonCost = loadModelsJsonCostIndex().get(key);
  if (modelsJsonCost) return modelsJsonCost;
  // Layer 2: config.models.providers
  const configuredCost = findConfiguredProviderCost(params);
  if (configuredCost) return configuredCost;
  // Layer 3: gateway model pricing cache
  return getCachedGatewayModelPricing(params);
}
```

**结论**：三层 fallback 机制**存在且未变更**。但 ClawLens 的 `cost-calculator.ts` 没有调用这些函数。

### 1.4 `RunEmbeddedPiAgentParams`** 新增可选参数

新增的**可选**参数（不影响现有调用）：
- `allowTransientCooldownProbe`
- `bootstrapContextMode` / `bootstrapContextRunKind`
- `bootstrapPromptWarningSignaturesSeen` / `bootstrapPromptWarningSignature`
- `inputProvenance`
- `ownerNumbers`
- `enforceFinalTag`

**结论**：没有新增**必需**参数。`lane` 参数仍然存在。

### 1.5 Hook 类型和 `registerService` API：**无变更**

---

## 二、ClawLens 代码与 Architecture.md 的结构性不匹配

### 2.1 核心问题：`llm_output` 的使用方式与文档不符

**文档描述**：
- Section 3.1: "Per-call usage（瀑布图必需）：通过 `runtime.events.onSessionTranscriptUpdate` 监听每条 assistant message 写入，提取 per-message usage"
- Section 3.3: "`llm_output` hook 仍然保留注册，用于 Overview 面板的 per-run 汇总更新"（暗示不用于瀑布图）
- 注释明确说："`llm_output` hook 是 per-run 触发，不是 per-LLM-call"，"**瀑布图需要 per-call 数据，必须用 `onSessionTranscriptUpdate` 获取**"

**实际代码**：
```typescript
// index.ts
api.on("llm_output", (event: any, ctx: any) => collector.recordLlmCall(event, ctx));

// collector.ts
recordLlmCall(event: {...}, ctx: {...}) {
  // 使用 event.usage（per-run 累计值）作为 per-call 数据写入 llm_calls 表
  this.store.insertLlmCall(runId, callIndex, now, {
    inputTokens: event.usage?.input,    // 实际是整个 run 的累计值
    outputTokens: event.usage?.output,   // 不是单次 LLM 调用的值
    ...
  });
}
```

**问题**：
1. 文档说要用 `onSessionTranscriptUpdate` 获取 per-call 数据做瀑布图，但代码**没有使用** `onSessionTranscriptUpdate`
2. 代码用 `llm_output` 获取数据，而 `llm_output` 是 per-run 累计值
3. 如果一个 run 有 3 次 LLM 调用，`llm_output` 只返回 3 次的**总和**，代码会错误地将这个总和当作"一次调用"的数据

### 2.2 `officialCost` 始终为 `undefined`

**文档描述**：
- 层次 1 cost：`message.usage.cost.total` — "pi-ai 从内置定价表计算并写入"

**实际代码**：
```typescript
// collector.ts line 199
officialCost: undefined,   // not yet provided by hook events
```

`llm_output` hook 的 `event.usage` 不包含 `cost` 字段。而 `onSessionTranscriptUpdate`（虽然没被使用）理论上可以获取 transcript 中的 `message.usage.cost`。

**影响**：cost 对比功能（Official vs Calculated）**无法实现**，因为 officialCost 始终为空。

### 2.3 `resolveModelCostConfig` 未被使用

**文档描述**：
```typescript
import { resolveModelCostConfig, estimateUsageCost } from "../../utils/usage-format.js";
const calculatedCost = estimateUsageCost({ usage, cost: resolveModelCostConfig(...) });
```

**实际代码**：
```typescript
// cost-calculator.ts — 独立实现，无 fallback
export function calculateCost(usage, costConfig) {
  if (!costConfig) return null;
  return input * cost.input + output * cost.output + ...;
}
```

`loadCostConfig` 只从 `config.models.providers` 读取，没有三层 fallback。

### 2.4 `before_agent_start` 的使用方式

**文档描述**（Section 4.1）：`before_agent_start` hook 中没有 model/provider 信息，需要从 session store 读取。

**实际代码**：实现方式与文档描述**一致**。

---

## 三、问题分类与优先级

### P0 — 核心功能缺陷

| # | 问题 | 描述 | 影响 |
|---|------|------|------|
| 1 | **瀑布图数据错误** | 用 `llm_output`（per-run 累计值）代替 `onSessionTranscriptUpdate`（per-call 值），多 LLM 调用场景下 token/cost 数据会是总和而非单次 | 瀑布图显示错误的 token 数量 |
| 2 | **officialCost 始终 undefined** | `llm_output.usage` 无 cost 字段，未使用 `onSessionTranscriptUpdate` 获取 | cost 对比 UI 无法工作 |
| 3 | **成本计算无 fallback** | 未使用官方 `resolveModelCostConfig`/`estimateUsageCost`，只有单层 fallback | 某些情况下无法计算成本 |

### P1 — 功能缺失

| # | 问题 | 描述 | 影响 |
|---|------|------|------|
| 4 | `onSessionTranscriptUpdate` 未使用 | 文档强调的数据源被忽略 | 瀑布图数据不可靠 |
| 5 | 对比 API 端点缺失 | `/compare/:groupId`, `/compare/list` 等未实现 | 对比功能不完整 |
| 6 | `workspaceMode` 配置项文档有但代码无 | 文档 Section 4.5 提到但实现中不存在 | 配置与文档不一致 |

---

## 四、OpenClaw v2026.3.23 → v2026.3.28 变更总结

| 项目 | v2026.3.23 | v2026.3.28 | 影响 |
|------|-----------|-------------|------|
| `llm_output` 触发频率 | per-run | per-run | 无 |
| `PluginHookLlmOutputEvent.usage` | 无 cost | 无 cost | 无 |
| 3层 fallback | 存在 | 存在 | 无 |
| `RunEmbeddedPiAgent.lane` | 支持 | 支持 | 无 |
| 新增可选参数 | — | 7个 | 无 |
| `registerService` API | 不变 | 不变 | 无 |

**结论**：从 v2026.3.23 到 v2026.3.28 没有破坏性变更。之前基于旧版本的分析结论对核心问题（`llm_output` 是 per-run、`usage` 无 cost 字段）的判断是准确的。

---

## 五、整改建议

### 5.1 瀑布图数据修复（P0）

**方案**：启用 `onSessionTranscriptUpdate` 监听

```typescript
// collector.ts
private unsubTranscript: (() => void) | null = null;

start(runtime: any, config: any, pluginConfig: ClawLensConfig) {
  // ...
  this.unsubTranscript = runtime.events.onSessionTranscriptUpdate((update: any) => {
    this.handleTranscriptUpdate(update, config);
  });
}

handleTranscriptUpdate(update: any, config: any) {
  const msg = update.message;
  if (msg?.role !== 'assistant') return;

  const usage = msg.usage as any;
  if (!usage) return;

  const sessionKey = update.sessionKey;
  const run = sessionKey
    ? [...this.activeRuns.values()].find(r => r.sessionKey === sessionKey)
    : undefined;
  if (!run) return;

  // 从 transcript 的 message 获取 cost（onSessionTranscriptUpdate 能获取完整 message）
  const officialCost = usage.cost?.total;  // 官方口径 cost

  // 用官方函数计算 calculated cost
  const costConfig = resolveModelCostConfig({ provider: msg.provider, model: msg.model, config });
  const calculatedCost = estimateUsageCost({ usage, cost: costConfig });

  this.store.insertLlmCall({...});
}
```

**关键**：transcript 中的 `message.usage.cost` 包含 pi-ai 计算的 cost breakdown，`onSessionTranscriptUpdate` 监听的是这个数据写入。

### 5.2 officialCost 修复（P0）

使用 `onSessionTranscriptUpdate` 后，`message.usage.cost.total` 就是 officialCost。

### 5.3 成本计算修复（P1）

将 `cost-calculator.ts` 改为调用官方函数，或直接 import 使用。

---

## 六、总结

| 维度 | 结论 |
|------|------|
| OpenClaw API 稳定性 | v2026.3.23 → v2026.3.28 无破坏性变更 |
| architecture.md 准确性 | 文档描述的数据采集方式（`onSessionTranscriptUpdate`）是正确的，但代码未按文档实现 |
| ClawLens 代码问题 | `llm_output` 的使用方式与文档不符；`officialCost` 未实现；成本计算无 fallback |
| 核心矛盾 | **文档说用 `onSessionTranscriptUpdate`，代码用 `llm_output`** |

最重要的整改是让 ClawLens 按照 architecture.md 文档的描述，使用 `onSessionTranscriptUpdate` 作为瀑布图的核心数据源，同时从中提取 `message.usage.cost` 实现 officialCost 对比。
