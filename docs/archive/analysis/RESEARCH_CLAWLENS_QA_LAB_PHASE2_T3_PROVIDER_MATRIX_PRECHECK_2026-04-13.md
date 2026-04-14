---
status: active
created: 2026-04-13
updated: 2026-04-13
---

# ClawLens QA Lab Phase 2 - T3 Provider 矩阵预检（2026-04-13）

## 目标

验证 T3（provider 多配置矩阵）的当前可执行边界，并完成最小矩阵的实测取证：

- `minimax-cn-api`
- `openai-codex`
- 一条 fallback 组合

## 实测环境

- 仓库：`projects-ref/openclaw`（`v2026.4.11`）
- Gateway：`127.0.0.1:18789`
- 插件：`clawlens`（`plugins inspect` 显示 `Status: loaded`）

## 证据 1：CLI 支持的 provider onboarding 范围

命令：

```bash
cd projects-ref/openclaw
node dist/entry.js onboard --help
```

结果（摘录）：

- `--auth-choice` 已包含 `minimax-cn-api`、`openai-api-key`、`openai-codex` 等多 provider 选项。

结论：

- 从 CLI 能力看，矩阵测试具备配置入口。

## 证据 2：当前配置与认证能力拆分

命令：

```bash
cd projects-ref/openclaw
node dist/entry.js config get models.providers
```

结果（摘要）：

- 仅返回 `minimax` provider 配置（`MiniMax-M2.7`）。

补充读取：

```bash
jq '.profiles | with_entries(.value |= {provider, type})' \
  ~/.openclaw/agents/main/agent/auth-profiles.json
```

结果（摘要）：

- `minimax:cn` -> `provider=minimax`, `type=api_key`
- `openai-codex:default` -> `provider=openai-codex`, `type=oauth`

结论：

- `openclaw.json` 里只有 `minimax` provider 配置。
- 但运行态 auth profile 中额外存在 `openai-codex` OAuth，可用于第二条 lane。

## 证据 3：minimax lane smoke 采样（已执行）

前置健康检查：

```bash
cd projects-ref/openclaw
node dist/entry.js plugins inspect clawlens
```

结果（摘要）：

- `Status: loaded`
- HTTP routes: `2`

执行：

```bash
cd projects-ref/openclaw
node dist/entry.js agent \
  --session-id qa-provider-minimax \
  --channel qa-channel \
  --message "provider matrix smoke minimax"
```

采样：

```bash
curl -sS http://127.0.0.1:18789/plugins/clawlens/api/overview
curl -sS 'http://127.0.0.1:18789/plugins/clawlens/api/sessions?limit=20&offset=0'
curl -sS 'http://127.0.0.1:18789/plugins/clawlens/api/audit/session/agent%3Amain%3Aexplicit%3Aqa-provider-minimax?limit=20'
```

结果（摘要）：

- `overview.totalRuns24h`：`3 -> 4`
- `sessions` 出现：`agent:main:explicit:qa-provider-minimax`
- `audit/session` 存在对应 run（`runId=8e1821e2-d235-4e9e-8381-74dd64222ea8`）

注意：

- 本次 run 在采样时为 `status=running`，`summary.toolCalls` 已累计（未结束态）。
- 这说明 T3 采样已打通“写入审计链路”，但不代表“该 run 已完成并稳定收敛”。

## 证据 4：openai-codex lane smoke 采样（已完成）

临时切换：

```bash
cd projects-ref/openclaw
node dist/entry.js models set openai-codex/gpt-5.4
```

执行：

```bash
cd projects-ref/openclaw
node dist/entry.js agent \
  --session-id qa-provider-openai-fallback \
  --channel qa-channel \
  --json \
  --message "Reply with exactly OK and do not use any tools."
```

采样：

```bash
curl -sS http://127.0.0.1:18789/plugins/clawlens/api/overview
curl -sS 'http://127.0.0.1:18789/plugins/clawlens/api/sessions?limit=20&offset=0'
curl -sS 'http://127.0.0.1:18789/plugins/clawlens/api/audit/session/agent%3Amain%3Aexplicit%3Aqa-provider-openai-fallback?limit=20'
```

结果（摘要）：

- agent 返回 `status=ok`
- `agentMeta.provider = openai-codex`
- `agentMeta.model = gpt-5.4`
- `overview.totalRuns24h`：`4 -> 5`
- `sessions` 出现：`agent:main:explicit:qa-provider-openai-fallback`
- `audit/session` 显示：
  - `status=completed`
  - `provider=openai-codex`
  - `model=gpt-5.4`
  - `llmCalls=1`

结论：

- 本地环境具备可用的 `openai-codex` OAuth lane。

## 证据 5：fallback 组合（openai -> openai-codex）验证（已完成）

临时切换：

```bash
cd projects-ref/openclaw
node dist/entry.js models fallbacks clear
node dist/entry.js models set openai/gpt-5.4
node dist/entry.js models fallbacks add openai-codex/gpt-5.4
```

执行：

```bash
cd projects-ref/openclaw
node dist/entry.js agent \
  --session-id qa-provider-fallback-combo \
  --channel qa-channel \
  --json \
  --message "Reply with exactly OK and do not use any tools."
```

gateway 诊断日志（摘要）：

- 首个 candidate `openai/gpt-5.4` 因缺少 `OPENAI_API_KEY` 失败。
- fallback 决策转到 `openai-codex/gpt-5.4`。
- fallback candidate 成功并返回 `OK`。

采样：

```bash
curl -sS http://127.0.0.1:18789/plugins/clawlens/api/overview
curl -sS 'http://127.0.0.1:18789/plugins/clawlens/api/sessions?limit=20&offset=0'
curl -sS 'http://127.0.0.1:18789/plugins/clawlens/api/audit/session/agent%3Amain%3Aexplicit%3Aqa-provider-fallback-combo?limit=20'
```

结果（摘要）：

- agent 返回 `status=ok`
- `agentMeta.provider = openai-codex`
- `agentMeta.model = gpt-5.4`
- `overview.totalRuns24h`：`5 -> 6`
- `sessions` 出现：`agent:main:explicit:qa-provider-fallback-combo`
- `audit/session` 显示：
  - `status=completed`
  - `provider=openai-codex`
  - `model=gpt-5.4`

结论：

- 缺失 `OPENAI_API_KEY` 时，当前环境可从 `openai/gpt-5.4` 自动回退到 `openai-codex/gpt-5.4`。
- 错误信息与分流路径清晰，可直接写入 SOP 的 failure handling。

## 环境回滚

验证结束后，已恢复本地默认模型配置：

```bash
cd projects-ref/openclaw
node dist/entry.js models set minimax/MiniMax-M2.7
node dist/entry.js models fallbacks clear
node dist/entry.js config set agents.defaults.models \
  '{"minimax-cn/MiniMax-M2.7":{},"minimax/MiniMax-M2.7":{"alias":"Minimax"}}' \
  --strict-json
```

最终核对结果：

- `agents.defaults.model.primary = minimax/MiniMax-M2.7`
- `agents.defaults.model.fallbacks = []`

## 当前判定

- T3 状态：`completed`
- 已验证：
  - minimax lane 可进入 ClawLens 审计链路
  - openai-codex lane 可稳定完成 smoke run
  - openai -> openai-codex fallback lane 可自动分流并完成 smoke run

## 对 SOP 的直接影响

1. `openai-codex` 可作为 `minimax` 之外的第二条本地验证 lane。
2. 若 operator 误把 primary 设为 `openai/gpt-5.4` 但未配置 `OPENAI_API_KEY`，可通过 fallback 组合维持验证链路。
3. SOP 中应显式加入：
   - `models set` / `models fallbacks` 的回滚步骤
   - `No API key found for provider "openai"` 的分流说明
