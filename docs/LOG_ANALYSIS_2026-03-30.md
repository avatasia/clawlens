# 日志分析 — openclaw-llm-api-logger 2026-03-30.jsonl

> 分析日期：2026-03-31
> 日志文件：`projects-ref/openclaw-llm-api-logger/logs/2026-03-30.jsonl`
> 目的：基于真实运行数据验证现有 4 份分析文档的准确性

---

## 一、日志文件结构

### 1.1 格式确认

日志文件**不是标准 JSONL**，每条记录由三部分组成：

```
{header-json-1-line}
------
{request-json-multiline}
------
{response-json-multiline}
```

其中 `formatEntry()` 在写入前执行 `.replace(/\\n/g, '\n')`，把 JSON 字符串中的 `\n` 转义序列替换为真实换行符，导致 request/response 块跨多行、无法被标准 JSON parser 解析。这与 `REF_ANALYSIS_llm-api-logger.md §3.7` 的结论一致。

**附加发现**：`redactSensitive()` 会把键名包含 "token" 的字段值替换为 `[REDACTED]`，导致 `totalTokens` 字段被误 redact（非敏感数据）。

### 1.2 文件规模

| 维度 | 数量 |
|------|------|
| 总行数 | 166,515 |
| JSON 行 | 3,138 |
| 分隔符行 | 107（2 个/记录 × ~53） |
| 空行 | 25,194 |
| 其他（非 JSON 字符串内容） | 135,806 |
| 完整解析记录数 | **47** |

---

## 二、数据概览

### 2.1 提供商与模型分布

| 提供商 | 模型 | 记录数 |
|--------|------|--------|
| minimax-cn | MiniMax-M2.7-highspeed | 47 |

**本日志只有单一提供商**，所有结论仅对 minimax-cn 成立，不能直接推广到其他提供商。

### 2.2 Session 分布

| sessionId（前8位） | 运行次数 | 时间跨度 |
|-------------------|---------|---------|
| 24d16859 | 18 | 13:08–13:36 |
| 0fc83e7e | 1 | 13:08 |
| slug-gen | 1 | 13:36 |
| 33abd7ba | 16 | 13:36–14:52 |
| 9c25aa30 | 1 | 13:52 |
| 7190946d | 6 | 15:32–15:41 |
| adcf2d07 | 1 | 19:00 |
| 4752c173 | 3 | 22:39–23:31 |

**8 个 session，47 次 run**。

---

## 三、核心发现

### 3.1 ⚠️ 重大发现：`llm_output` 运行时包含 `usage.cost` 字段

**TypeScript 类型声明（types.ts ~1986）**：
```typescript
usage?: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  // ← 无 cost 字段
}
```

**实际运行时数据（minimax-cn provider）**：
```json
{
  "usage": {
    "input": 27814,
    "output": 91,
    "cacheRead": 27928,
    "cacheWrite": 0,
    "totalTokens": "[REDACTED]",
    "cost": {
      "input": 0.022251,
      "output": 0.000273,
      "cacheRead": 0.002234,
      "cacheWrite": 0,
      "total": 0.024758
    }
  }
}
```

**结论**：TypeScript 类型**未声明** `cost` 字段，但 minimax-cn provider 在运行时确实注入了该字段。可通过 `(event.usage as any)?.cost?.total` 在 `llm_output` hook 中直接获取 officialCost，**无需** `onSessionTranscriptUpdate`。

⚠️ **重要限制**：此字段是否在其他 provider（anthropic、openai 等）中存在，无法从本日志确认。可能是 minimax-cn 的特有扩展。

### 3.2 `llm_output` 确认为 per-run（每 run 触发一次）

每个 `runId` 在日志中只出现一次，与 ARCHITECTURE_REVIEW §1.1 结论一致。47 个 runId 对应 47 条记录，无重复。

### 3.3 同一 session 内多 run 的 usage 可能完全相同

Session `33abd7ba` 的最后 13 个 run（13:41:08 至 14:52:41）usage 值完全一致：

```
in=16205, out=183, cacheR=27928, cacheW=0, cost=$0.015747
```

这些 run 间隔从几秒到 47 分钟不等，但 token 计数完全相同。原因分析：
- 这些可能是 heartbeat/announce 自动触发的轻量 run（`runId=announce...` 印证）
- LLM 调用使用了相同的 cache 命中组合
- 不是 per-call 计数的 bug，而是实际业务模式

**对 ClawLens 的影响**：如果用 `llm_output` 的 usage 生成瀑布图，多次 run 可能显示完全相同的 token 数，视觉上有误导性（用户会误以为数据冻结）。这进一步印证了瀑布图需要 per-call 数据的设计判断。

### 3.4 `input=0` 的 run 存在

Session `24d16859` 中有 3 个 run 显示 `input=0`（13:28:14, 13:29:07, 13:29:46）。这些 run 仍有 cacheRead tokens（67000+），说明 LLM 完全命中 cache，新 input token 为 0。这是正常现象（prompt caching 完全命中）。

### 3.5 `durationMs` 范围宽广

- 最短：2885ms（2.9 秒）
- 最长：409,463ms（6.8 分钟！）
- 中位数（估）：约 14,000ms

一条记录 dur=409463ms 的 run（session `9c25aa30`）特别异常，可能是一个复杂的多步骤 run。

### 3.6 `totalTokens` 字段被误 redact

`usage.totalTokens`（总 token 数，非敏感信息）被 redact 为 `[REDACTED]`，因为 key 名含 "token" 匹配了 `SENSITIVE_PATTERNS`。这是 `redactSensitive()` 的误判，但不影响 ClawLens（ClawLens 不使用此字段）。

---

## 四、对 4 份文档的影响评估

### 4.1 ARCHITECTURE_REVIEW_v2026.3.28.md

| 节 | 原声明 | 实际数据结论 | 需修正 |
|----|--------|------------|--------|
| §1.2 | "usage 无 cost 字段" | TypeScript 类型无 cost，但 minimax-cn 运行时有 | **需修正** |
| §2.2 | "officialCost 始终 undefined" | 可从 `(event.usage as any)?.cost?.total` 获取（provider 依赖） | **需修正** |
| §5.2 | "使用 onSessionTranscriptUpdate 修复 officialCost" | llm_output 已有 cost（至少 minimax-cn），可直接使用 | **需修正** |
| §2.1 | "llm_output per-run 累计值" | 确认正确 | ✓ |
| §5.1 | "瀑布图需要 per-call 数据" | 确认：同 session 多 run 可有相同 usage，waterfall 仍需 per-call | ✓ |

### 4.2 REF_ANALYSIS_llm-api-logger.md

| 节 | 原声明 | 实际数据结论 | 需修正 |
|----|--------|------------|--------|
| §2.2 | "runId 关联模式" | 确认有效 | ✓ |
| §3.7 | "不是标准 JSONL" | 确认，.replace(\n) 破坏 JSON | ✓ |
| §四 | "触发顺序" | 确认 per-run | ✓ |
| —— | 未提及 cost 字段 | 应补充：运行时 usage 包含 cost（minimax-cn） | **需补充** |
| —— | 未提及同 session 相同 usage | 应补充：heartbeat run 可导致相同 usage | **需补充** |

### 4.3 HOOK_ANALYSIS_v2026.3.28.md

| 节 | 原声明 | 实际数据结论 | 需修正 |
|----|--------|------------|--------|
| §2.1 | "llm_output: per-run 累计 usage" | 确认正确 | ✓ |
| —— | 未提及运行时 cost 字段 | 应在 llm_output 描述中注明 | **需补充** |

### 4.4 PLUGIN_GUIDELINES_REVIEW.md

| 节 | 原声明 | 实际数据结论 | 需修正 |
|----|--------|------------|--------|
| §P0-1 | cost 相关描述 | 不涉及 cost，无需修改 | ✓ |
| —— | configSchema | 无影响 | ✓ |

---

## 五、总结：最重要的修正点

**优先级最高**：ARCHITECTURE_REVIEW §1.2 和 §2.2 关于 `cost` 字段的结论需要修正。

- **错误原结论**："TypeScript 类型没有 cost，因此 officialCost 不可用"
- **正确结论**："TypeScript 类型未声明 cost，但 minimax-cn provider 在运行时注入了 cost 字段。可以通过 `(event.usage as any)?.cost?.total` 直接从 `llm_output` 获取 officialCost，无需 `onSessionTranscriptUpdate`。但其他 provider 是否注入此字段未知，需做 undefined 保护。"

这个修正影响 §5.2（officialCost 修复方案），使修复方案更简单：

```typescript
// 简化版修复（无需 onSessionTranscriptUpdate）:
recordLlmCall(event) {
  const officialCost = (event.usage as any)?.cost?.total ?? undefined;
  // ...
}
```

但对于瀑布图的 per-call 数据需求，`llm_output` 仍然不够（确认 per-run）。**更正**：`onSessionTranscriptUpdate` 的 `message` 字段在主执行路径（`attempt-execution.ts:300`）中始终为 undefined，无法获取 per-call usage；正确的 per-call 数据来源是 `before_message_write` 钩子（见 ARCHITECTURE_REVIEW §5.1 更正）。
