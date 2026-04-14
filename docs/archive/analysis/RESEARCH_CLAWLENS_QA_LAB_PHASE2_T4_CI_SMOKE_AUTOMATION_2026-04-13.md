---
status: active
created: 2026-04-13
updated: 2026-04-13
---

# ClawLens QA Lab Phase 2 - T4 CI 轻量自动回归验证（2026-04-13）

## 目标

验证一条最小自动化链路，满足以下条件：

- 不依赖人工 UI 点击
- 可在本地重复执行
- 自动采集 `overview / sessions / audit`
- 失败时输出结构化结果，便于排障

## 新增脚本

- `scripts/run-clawlens-qa-smoke.sh`

脚本职责：

1. 检查 gateway readiness
2. 采集 `preOverview`
3. 触发 1 条 `qa-channel` smoke run
4. 采集 `postOverview`
5. 查询 `sessions`
6. 轮询 `audit/session/<sessionKey>`
7. 输出结构化 JSON，并按校验结果返回退出码

默认 smoke 指令：

```text
Use the session_status tool exactly once, then reply with exactly OK.
```

这样可以稳定验证：

- agent 执行成功
- 至少 1 次工具调用
- ClawLens 审计链路完整写入

## 关键实现点

### 1. `/readyz` 不是纯文本 `ok`

本轮实测：

```http
GET /readyz
200 OK
{"ready":true,"failing":[],"uptimeMs":...}
```

因此脚本已兼容两种 readiness 形式：

- 旧式纯文本 `ok`
- 当前 JSON `{ "ready": true }`

### 2. 失败结果也会结构化输出

脚本不会因为 `agent` 子命令非零退出而直接被 `set -e` 打断。

会保留：

- `agentExitCode`
- `agentStderr`
- `checks.*`

这使得失败样例可直接用于 CI 诊断。

### 3. 非默认端口场景需统一配置上下文

当 gateway 使用非默认端口（例如 `28789`）时，若 `agent` 命令与 gateway/qa ui 不在同一配置上下文（常见为 `OPENCLAW_CONFIG_PATH` 不一致），`agent` 可能回落到默认 `18789`，导致 smoke 误判失败。

建议：

- 在非默认端口 lane 中，统一导出同一个 `OPENCLAW_CONFIG_PATH` 再执行 gateway / qa / agent。
- 或优先使用默认 `18789` lane，减少环境耦合变量。

## 串行验证样例

执行环境：

- OpenClaw repo: `projects-ref/openclaw`
- Gateway: `127.0.0.1:18789`
- 默认模型：`minimax/MiniMax-M2.7`

执行命令（串行）：

```bash
bash scripts/run-clawlens-qa-smoke.sh \
  --repo-root projects-ref/openclaw \
  --session-id qa-ci-seq-1

bash scripts/run-clawlens-qa-smoke.sh \
  --repo-root projects-ref/openclaw \
  --session-id qa-ci-seq-2
```

### Run 1: `qa-ci-seq-1`

结果摘要：

- `result = pass`
- `overviewIncrement = true`
- `sessionPresent = true`
- `auditCompleted = true`
- `toolCallObserved = true`
- `provider = minimax`
- `model = MiniMax-M2.7`
- `runId = 3d1d19d2-6166-4ad3-babb-2e2ac69912aa`
- `summary.toolCalls = 1`
- tool = `session_status`

### Run 2: `qa-ci-seq-2`

结果摘要：

- `result = pass`
- `overviewIncrement = true`
- `sessionPresent = true`
- `auditCompleted = true`
- `toolCallObserved = true`
- `provider = minimax`
- `model = MiniMax-M2.7`
- `runId = 6727c13e-10ec-4a7d-b195-35a7d680aea6`
- `summary.toolCalls = 1`
- tool = `session_status`

## 验收结论

T4 通过。

已满足：

- 本地可脚本化重复执行
- 至少 2 次连续运行通过
- 失败时可输出结构化排障信息
- 不依赖人工 UI 点击

## 对 SOP / 后续自动化的直接影响

1. 主 SOP 可引用本脚本作为“快速自检”路径，而不是只给手工 `curl` 步骤。
2. 后续若接 CI，只需保证：
   - gateway 已启动
   - ClawLens 已加载
   - `projects-ref/openclaw/dist` 已构建
3. 若要进一步强化，可追加：
   - 非 `minimax` lane 版本的 smoke 任务
   - 固定输出到工件目录的 JSON 报告
   - 失败时自动抓取 gateway 日志摘录
4. 若引入“端口参数化”lane，SOP 与 CI 均需显式增加“配置上下文一致性”检查（`config file` + `OPENCLAW_CONFIG_PATH`）。
