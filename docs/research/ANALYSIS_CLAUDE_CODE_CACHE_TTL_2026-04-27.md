# Claude Code 提示缓存 TTL 分析

**日期**: 2026-04-27  
**数据来源**: `~/.claude/projects/-home-chlli-github-clawlens/*.jsonl`（assistant 类型记录）

---

## 可观测字段

每条 `assistant` 记录的 `message.usage` 包含：

| 字段 | 含义 |
|------|------|
| `input_tokens` | 未命中缓存的实际读取 tokens |
| `output_tokens` | 输出 tokens |
| `cache_creation_input_tokens` | 缓存写入总量（= 5m + 1h） |
| `cache_read_input_tokens` | 缓存命中读取 |
| `cache_creation.ephemeral_5m_input_tokens` | 5分钟 TTL 写入 |
| `cache_creation.ephemeral_1h_input_tokens` | 1小时 TTL 写入 |

---

## 本账号统计（截至 2026-04-27）

### 按模型

| 模型 | 请求数 | cache_write | cache_read | 命中率 |
|------|--------|-------------|------------|--------|
| claude-sonnet-4-6 | 5,315 | 18,932,696 | 435,542,612 | 95.8% |
| claude-opus-4-6 | 1,748 | 7,398,490 | 125,267,035 | 94.4% |
| claude-opus-4-7 | 801 | 3,839,504 | 55,894,462 | 93.6% |
| claude-haiku-4-5 | 73 | 661,854 | 2,852,497 | 80.8% |

### TTL 分布

- `ephemeral_5m` 累计：**0 tokens**（本账号从未出现 5m 缓存写入）
- `ephemeral_1h` 累计：**30,840,787 tokens**（100% 为 1h TTL）

---

## TTL 历史回顾（社区数据，issue #46829）

| 时期 | 行为 | 备注 |
|------|------|------|
| 2026-01 前 | 5m ONLY | 1h tier 尚未上线 |
| 2026-02-01 ~ 03-05 | 1h ONLY | Anthropic 将主对话默认改为 1h |
| 2026-03-06 起 | 混合：主对话 ~1h，子agent ~5m | 服务端按请求类型分级 |
| 2026-04-01 起 | 主对话 0~6% 5m，子agent 100% 5m | v2.1.90 修复了 overage 触发的回退 |

---

## 设计逻辑（Anthropic 官方回应）

> "Different request types benefit from different TTL tiers, and the client selects per request."

- **主对话** → 1h TTL：轮次间隔可能超过 5 分钟，1h 能有效减少重建
- **子 agent** → 5m TTL：中位间隔 1.4 秒，缓存几乎不会在 5 分钟内过期；5m 写入（1.25× 基础价）比 1h（2×）更便宜，一次性调用无需更长 TTL

---

## 已知 Bug

| Issue | 问题 | 状态 |
|-------|------|------|
| #45381 | `DISABLE_TELEMETRY=1` 导致订阅用户退回 5m TTL | v2.1.108 已修复 |
| #34629 | `--print --resume` 导致 cache_read 不增长，成本 20× | 已修复 |

---

## 环境变量说明

| 变量 | 作用 | 适用范围 |
|------|------|---------|
| `ENABLE_PROMPT_CACHING_1H=1` | 强制主对话使用 1h TTL | **API key / Bedrock / Vertex / Foundry 专用**，订阅用户无效 |
| `FORCE_PROMPT_CACHING_5M=1` | 强制 5m TTL | 同上 |

订阅用户（claude.ai 登录）的 TTL 由服务端通过 telemetry/experiment gate 决定，无法手动覆盖。

---

## 缓存失效检测 Hook

已部署 `~/.claude/hooks/cache-alert.py`，在每次对话结束（Stop hook）时检测当前 session 是否发生缓存失效：

- **5m 失效**：上一轮距本轮 > 5min，且本轮 `ephemeral_5m_input_tokens > 20k`
- **1h 失效**：上一轮距本轮 > 1h，且本轮 `ephemeral_1h_input_tokens > 20k`

触发时输出 `systemMessage` 告警，显示失效时间、间隔时长、重建 token 量。

---

## 参考链接

- [Prompt caching - Anthropic Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Issue #46829: Cache TTL regressed from 1h to 5m](https://github.com/anthropics/claude-code/issues/46829)
- [Issue #45381: DISABLE_TELEMETRY disables 1h TTL](https://github.com/anthropics/claude-code/issues/45381)
- [The Register: Claude quota drain not caused by cache tweaks](https://www.theregister.com/2026/04/13/claude_code_cache_confusion/)
