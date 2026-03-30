# ClawLens 架构文档评审报告

> 基于 OpenClaw v2026.3.23 源码分析与 architecture.md v1.0 对比
> 生成日期：2026-03-27

---

## 一、文档质量总评

**文档质量：良好**，结构清晰，描述详细，但存在若干与实际代码不一致之处。

主要问题分类：
- **事实错误**：数据源描述、成本计算方式与实现不符
- **功能缺失**：文档描述的部分功能在实际代码中未实现
- **过度设计**：文档描述的部分细节在实际代码中被简化或改变
- **表述模糊**：部分关键机制描述不够准确

---

## 二、文档与代码不一致的纰漏

### 2.1 数据源问题（严重）

#### 问题 1：`llm_output` 是 per-call 还是 per-run？

**文档描述（Section 3.1 + 注释）**：
```
"llm_output hook 是 per-run 触发，不是 per-LLM-call"
"getUsageTotals() 返回的是整个 run 的累计 usage"
"如果一个 run 中有 3 次 LLM 调用，hook 只返回总和"
"瀑布图需要 per-call 数据，必须用 onSessionTranscriptUpdate"
```

**实际代码**：
```typescript
// index.ts
api.on("llm_output", (event: any, ctx: any) => collector.recordLlmCall(event, ctx));
```

**分析**：文档明确说 `llm_output` 是 per-run，瀑布图需要 `onSessionTranscriptUpdate`。但实际代码使用 `llm_output` 做 per-call 数据采集。

查阅 OpenClaw 源码 `PluginHookLlmOutputEvent`：
```typescript
export type PluginHookLlmOutputEvent = {
  runId: string;
  sessionId: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};
```

`llm_output` hook 在每次 LLM 调用结束时触发（与 `message_end` 事件关联），**确实提供 per-call usage**。文档对 `llm_output` 的描述是错误的。

#### 问题 2：`onSessionTranscriptUpdate` 完全未使用

**文档描述（Section 3.1）**：
```
"Per-call usage（瀑布图必需）：通过 runtime.events.onSessionTranscriptUpdate
  监听每条 assistant message 写入，提取 per-message usage"
```

**实际代码**：整个代码库中没有调用 `onSessionTranscriptUpdate`。

**影响**：如果 `llm_output` 存在遗漏或数据不完整，瀑布图将无法获取数据。当前实现依赖 `llm_output`，而文档说必须用 `onSessionTranscriptUpdate`。

---

### 2.2 成本计算方式（严重）

#### 问题 3：未使用官方 `resolveModelCostConfig` + `estimateUsageCost`

**文档描述（Section 3.1 注释 + Section 3.2）**：
```typescript
import { resolveModelCostConfig, estimateUsageCost } from "../../utils/usage-format.js";
const costConfig = resolveModelCostConfig({ provider, model, config });
const calculatedCost = estimateUsageCost({ usage, cost: costConfig });
```

文档强调用官方的三层 fallback：
1. `models.json`（bundled model pricing）
2. `config.models.providers.*.cost`（用户配置）
3. gateway model pricing cache（运行时缓存）

**实际代码**：
```typescript
// cost-calculator.ts
export function calculateCost(usage, costConfig) {
  // 简单的 4 项乘积，无任何 fallback
  return input * cost.input + output * cost.output + cacheRead * cost.cacheRead + cacheWrite * cost.cacheWrite;
}
```

`loadCostConfig` 只从 `config.models.providers` 读取配置，无任何 fallback 机制。

**影响**：当用户未配置自定义定价时，成本计算会返回 `null`（实际代码中 `officialCost: undefined`），无法提供成本估算。

---

### 2.3 `officialCost` 未实现（严重）

#### 问题 4：文档说从 `message.usage.cost` 提取 official cost

**文档描述**：
```
"层次 1：官方口径 cost — 从 message.usage.cost 直接提取（pi-ai 内置定价计算）"
```

**实际代码**：
```typescript
// collector.ts recordLlmCall
officialCost: undefined,   // not yet provided by hook events
```

**影响**：文档描述的三层 cost 对比机制（Official vs Calculated vs Exclusive）无法实现。UI 无法显示绿色勾或黄色差异提示，因为 `officialCost` 始终为 `undefined`。

---

### 2.4 模块 B（并发对比）实现不完整

#### 问题 5：`before_agent_start` 的返回值不阻止主运行

**文档描述（Section 4.1）**：
```
"如果匹配:
   ├─ 异步启动 N 个对比运行（不阻塞原始流程）
   └─ return（原始模型正常返回给用户）"
```

但注释说 "return（原始模型正常返回给用户）"，暗示 `return` 有控制作用。实际上 `before_agent_start` 是 Modifying hook，其返回值用于合并，而不是控制流程。

**实际代码**：
```typescript
// comparator.ts
async maybeForCompare(event, ctx, config): Promise<undefined> {
  // ... 启动对比运行
  return undefined;  // 不返回任何阻止主流程的内容
}
```

文档和代码的行为描述实际上是一致的（不阻塞原始流程），但表述可能造成误解。

#### 问题 6：`before_agent_start` 中获取主模型的方式

**文档描述（Section 4.1 注释）**：
```
"before_agent_start hook 的 PluginHookAgentContext 中没有 model/provider 信息
（此时 model resolve 尚未完成）"
```

**实际代码**：确实如此，代码通过 `sessionStore` 读取主模型。

**评价**：文档对这一点的说明是准确的。

---

### 2.5 API 端点缺失

#### 问题 7：以下 API 端点在代码中未实现

| 文档描述 | 实际代码 |
|---------|---------|
| `GET /api/compare/:groupId` | ❌ 未实现 |
| `GET /api/compare/list` | ❌ 未实现 |
| `POST /api/compare/trigger` | ❌ 未实现 |
| `POST /api/config` | ❌ 未实现 |
| `GET /api/stats/channels` | ❌ 未实现 |
| `GET /api/stats/models` | ❌ 未实现 |
| `GET /api/session/:sessionKey` | ❌ 未实现（只有 `/sessions` 列表） |

**已实现的端点**：
- `GET /api/overview` ✓
- `GET /api/sessions` ✓
- `GET /api/run/:runId` ✓
- `GET /api/audit` ✓
- `GET /api/audit/run/:runId` ✓
- `GET /api/audit/session/:sessionKey` ✓
- `GET /api/events` (SSE) ✓

---

### 2.6 Store 缺失方法

#### 问题 8：文档描述的 `recordCompareEvent/Result/Error` 方法不存在

**文档描述**：
```typescript
onAgentEvent: (evt) => {
  params.store.recordCompareEvent(params.groupId, target, runId, evt);
},
.then((result) => {
  params.store.recordCompareResult(params.groupId, target, result);
})
```

**实际代码**：对比运行的事件直接写入 runs 表，通过 `compare_group_id` 关联。没有独立的 `recordCompare*` 方法。

**评价**：这是一个实现简化，不影响功能，但与文档描述不符。

---

### 2.7 配置字段不一致

#### 问题 9：`workspaceMode` 字段缺失

**文档描述（Section 4.5）**：
```yaml
compare:
  workspaceMode: "copy"    # copy | sandbox | shared
```

**实际代码**：
```typescript
type CompareConfig = {
  enabled?: boolean;
  models?: Array<{ provider: string; model: string }>;
  channels?: string[];
  timeoutMs?: number;
  maxConcurrent?: number;
  // 无 workspaceMode
};
```

---

### 2.8 文件结构小差异

#### 问题 10：`static-server.ts` vs `api-routes.ts`

**文档描述**：
```
src/
├── api-routes.ts           # HTTP API 路由注册
├── static-server.ts        # 静态文件服务
```

**实际代码**：静态文件服务合并在 `registerStaticRoutes` 函数中，位于 `api-routes.ts` 内。没有独立的 `static-server.ts`。

---

## 三、文档本身的问题

### 3.1 段落编号混乱

- Section 3.1 → 3.3 是审计数据模型
- Section 4.1 突然跳到"模块 B：并发对比的触发机制"（应该是 Section 3.4）
- Section 5 是数据存储层
- Section 6 是 API 层
- Section 7 是 UI 注入层
- Section 8 是 Plugin 入口
- Section 9 是文件结构
- Section 10 是安装部署
- Section 11 是风险和约束
- Section 12 是实施路径
- Section 13 又是审计视图（与 Section 3.x 重复）

建议重新组织编号体系。

---

### 3.2 部分描述过于详细，部分过于简略

**过详**：Section 3.1 的伪代码实现过于详细，且与实际代码有出入
**过简**：Section 4.2-4.4 缺少关键实现细节（如 `runEmbeddedPiAgent` 的具体参数）

---

## 四、文档建议改进

### 4.1 数据源描述修正

将 Section 3.1 数据源表格更正为：

| 数据源 | 粒度 | 采集内容 |
|--------|------|---------|
| `runtime.events.onAgentEvent` | per-run | run 生命周期（start/end/error） |
| `api.on("llm_output")` | per-LLM-call | 每次 LLM 调用的 usage + provider/model（瀑布图核心数据源） |
| `api.on("llm_input")` | per-LLM-call | system prompt hash + user prompt preview |
| `api.on("after_tool_call")` | per-tool-call | tool 名称、参数、结果、耗时 |

**删除** `onSessionTranscriptUpdate` 相关描述（当前未使用）。

---

### 4.2 成本计算描述修正

将成本计算描述修正为实际实现：
- 当前使用自定义 `cost-calculator.ts`
- 只有一层 fallback（从 config.models.providers 读取）
- `officialCost` 暂未实现

---

### 4.3 补充缺失功能说明

- 模块 B 的对比结果查询 API 当前未实现
- Config 热更新 API 当前未实现
- SSE auth 方式与文档描述一致

---

### 4.4 重新组织段落结构

建议采用：
- Section 1: 系统定位
- Section 2: 整体架构
- Section 3: 模块 A（Collector）
  - 3.1 数据采集
  - 3.2 数据模型
  - 3.3 Collector 实现
- Section 4: 模块 B（Comparator）
  - 4.1 触发机制
  - 4.2 对比运行执行
  - 4.3 Lane 隔离
  - 4.4 Workspace 隔离
- Section 5: 数据存储层
- Section 6: API 层
- Section 7: UI 注入层
- Section 8: Plugin 入口
- Section 9: 文件结构
- Section 10: 实施路径
- Appendix: 风险和约束（从 Section 11 移出）

---

## 五、总结

| 类别 | 问题数 | 严重程度 |
|------|--------|---------|
| 事实错误（数据源） | 2 | 高 |
| 功能缺失 | 3 | 高 |
| 描述不准确 | 3 | 中 |
| 字段不一致 | 1 | 低 |
| 文档结构问题 | 2 | 中 |

**最需修复的问题**：
1. `officialCost` 未实现 - 影响核心审计功能
2. `onSessionTranscriptUpdate` 未使用 - 文档描述与实现不符
3. API 端点大面积缺失 - 影响功能可用性
4. 成本计算无 fallback - 与文档描述的三层 fallback 不符
