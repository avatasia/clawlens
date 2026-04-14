---
status: merged
created: 2026-04-13
updated: 2026-04-14
superseded_by: docs/CLAWLENS_QA_LAB_TEST_SOP.md
---

# ClawLens QA Lab 测试 SOP（草案 — 已提升）

> **本文件已提升为正式 SOP**：[CLAWLENS_QA_LAB_TEST_SOP.md](../../CLAWLENS_QA_LAB_TEST_SOP.md)。
> 以下内容保留为历史参考，不再作为操作依据。

## 适用范围

- 目标：在本地用 QA Lab 回归验证 ClawLens。

## 执行策略（分阶段收敛）

- 本文只纳入”已确认可执行”的步骤。
- 未充分验证但计划纳入的项，先记录在”待验证后纳入”清单。
- 采用”先落地、再扩展”的方式迭代，不一次性并入高风险链路。

## 当前纳入范围（已确认）

- 环境范围：本地源码仓库（`projects-ref/openclaw`）。
- 主流程：`qa ui` 复用现有 gateway（非 Docker）。
- 验收目标：ClawLens 的 `overview/sessions/audit` 三层可观测性闭环。

## 0. 前置条件

- 已有本地仓库：`clawlens/` 与 `projects-ref/openclaw/`
- Node / pnpm 可用
- `jq` 与 `curl` 可用（smoke 脚本 9b 必要依赖）
- 本地可写 `~/.openclaw`
- 至少一个可用 model provider 已完成 onboarding（若未完成见步骤 2b）

## 0b. 端口预检（避免与 SSH tunnel 冲突）

在启动本地 gateway 前，先确认本机 `18789` 未被占用：

```bash
ss -tlnp | grep 18789 || echo "port 18789 is free"
```

若输出显示端口已被占用，根据下方处理原则释放或改端口后再继续。

常见冲突来源：

- 已打开的 SSH tunnel（例如：`ssh -L 18789:127.0.0.1:18789 <remote>`）
- 其他本地 OpenClaw/gateway 进程

处理原则：

- 若 `18789` 已占用，先释放冲突进程，或改用其他本地端口（例如 `28789`）。
- 若改端口，后续所有 `18789` 相关命令与 URL 必须同步替换为新端口。
- 若改端口，需确保 `gateway run`、`qa ui`、`agent` 三者使用同一份配置上下文；推荐固定一个 `OPENCLAW_CONFIG_PATH`，避免 `agent` 回落到默认 `127.0.0.1:18789`。

## 1. 准备 OpenClaw 构建产物

```bash
cd projects-ref/openclaw
node scripts/tsdown-build.mjs --no-clean
pnpm qa:lab:build
```

成功判据：

- `tsdown-build.mjs` 以退出码 0 完成，无 `ERROR` 级输出。
- `pnpm qa:lab:build` 以退出码 0 完成；`dist/entry.js` 文件存在。

失败处理：

- 若 `tsdown-build.mjs` 报错，先检查 Node 版本（≥ 22.5.0）与 `pnpm install` 是否已执行。
- 若 `qa:lab:build` 失败，查看 pnpm 输出中是否有缺失依赖提示，执行 `pnpm install` 后重试。

## 2. 安装/链接 ClawLens 到本地 OpenClaw

```bash
cd projects-ref/openclaw
node dist/entry.js plugins install -l ../../extensions/clawlens
```

成功判据：

- 命令以退出码 0 完成，输出中包含 `installed` 或 `linked` 字样（含 `clawlens`）。

失败处理：

- 若报 `ENOENT` 或路径错误，确认当前工作目录为 `projects-ref/openclaw`，且 `../../extensions/clawlens` 可达。
- 若报插件已存在冲突，先执行 `node dist/entry.js plugins uninstall clawlens` 后重试。

## 2b. 配置 provider（首次运行必做）

前置条件：`onboard` 需要连接运行中的 gateway 来验证 provider 可达性。若尚未启动 gateway，先完成步骤 3，再回到本步骤执行。

```bash
cd projects-ref/openclaw
node dist/entry.js onboard --auth-choice minimax-cn-api
```

若你已配置其他 provider，可跳过该步骤。

成功判据：

- `onboard` 完成后退出码为 0。
- 执行一次快速验证：`node dist/entry.js agent --session-id provider-check --message "reply OK" --json`，输出 JSON 中 `status` 为 `"ok"`。

失败处理：

- 若 `onboard` 报交互中断或 API key 无效，重新执行并确认 key 正确。
- 禁止使用零散 `config set` 手动拼 provider 配置（易遗漏 `baseUrl`/`models` 等必填字段导致 schema 错误）。
- 若 provider-check agent 调用失败，检查 gateway 日志中是否有 `provider`/`auth` 相关错误。

## 3. 启动 gateway（18789）

```bash
cd projects-ref/openclaw
node dist/entry.js gateway run --force --port 18789 --bind loopback
```

成功判据：

- 前台日志出现 `gateway ready`。
- `curl -sS http://127.0.0.1:18789/readyz` 返回 JSON（如 `{"ready":true,"failing":[],"uptimeMs":...}`）或纯文本 `ok`（旧版本）。

可选一致性检查（建议）：

```bash
cd projects-ref/openclaw
node dist/entry.js config file
```

确认后续步骤在同一配置文件上下文中执行。

## 4. 获取 Control UI token

```bash
cd projects-ref/openclaw
node dist/entry.js dashboard --no-open
```

成功判据：

- 输出包含形如 `http://...#token=<TOKEN>` 的 URL，其中 `<TOKEN>` 为非空字符串。

失败处理：

- 若无 token 输出，确认 gateway（Step 3）正在运行且 `readyz` 返回正常。
- 若输出为错误信息，检查 `~/.openclaw` 目录权限与配置文件完整性。

记录输出中的 `#token=...` 值，后续步骤需要使用。

## 5. 启动 QA Lab UI（43124，复用现有 gateway）

```bash
cd projects-ref/openclaw
node dist/entry.js qa ui \
  --repo-root . \
  --host 127.0.0.1 \
  --port 43124 \
  --embedded-gateway disabled \
  --control-ui-proxy-target http://127.0.0.1:18789/ \
  --control-ui-token <TOKEN>
```

说明：

- `--repo-root .` 依赖当前工作目录为 `projects-ref/openclaw`。
- 如果你在其他目录执行，请把 `--repo-root` 改为 OpenClaw 仓库绝对路径。

成功判据：

- 前台日志出现 `listening` 或 `ready`，且包含端口 `43124`。
- `curl -sS http://127.0.0.1:43124/` 返回 HTML（QA SPA 页面）。

失败处理：

- 若端口被占用，先释放 43124 或改用其他端口（同步更新步骤 6 的访问 URL）。
- 若报 token 无效，确认 `--control-ui-token` 与步骤 4 获取的 token 一致。

## 6. 访问路径

- QA Lab UI: `http://127.0.0.1:43124/`
- Embedded Control UI: `http://127.0.0.1:43124/control-ui/#token=<TOKEN>`

## 7. 插件健康检查（硬门禁，必须走 18789）

本步骤为**硬前置门禁**：任一检查失败，不得进入步骤 8 及后续 QA 执行。

### 7a. 插件加载验证（CLI）

```bash
cd projects-ref/openclaw
node dist/entry.js plugins inspect clawlens
```

成功判据：

- 输出包含插件 ID `clawlens`，显示 `status: loaded`（或等价的已加载标识）。
- 输出中可见注册的 routes/services（如 `/plugins/clawlens/api/...`）。

失败处理：

- 若输出 `not found` 或无 `clawlens` 条目，回到步骤 2 重新安装插件。
- 若输出 `status: error`，检查 gateway 日志中与 `clawlens` 相关的报错。

### 7b. 插件 API 验证（HTTP）

```bash
curl -s http://127.0.0.1:18789/plugins/clawlens/api/overview
curl -s 'http://127.0.0.1:18789/plugins/clawlens/api/sessions?limit=5&offset=0'
```

成功判据：

- `overview` 返回 JSON，包含 `activeRuns`/`totalRuns24h`/`totalTokens24h` 字段。
- `sessions` 返回 JSON 数组（可为空数组 `[]`）。

失败处理：

- 若返回 HTML，说明端口用错（误打到 43124）。所有 API 验证必须走 `18789`。
- 若返回 401/unauthorized，重新获取 token（步骤 4）并刷新 QA Lab UI（步骤 5）。
- 若返回 404/`Not Found`，说明插件未成功加载，回到 7a 排查。

## 8. 触发 QA 会话（产生审计数据）

```bash
cd projects-ref/openclaw
node dist/entry.js agent \
  --session-id qa-smoke \
  --channel qa-channel \
  --message "Use the session_status tool exactly once, then reply with exactly OK."
```

说明：

- `--session-id qa-smoke` 会映射为审计查询 key：`agent:main:explicit:qa-smoke`。
- 若你使用了非默认 gateway 端口（例如 `28789`），需在与步骤 3/5 相同的 shell 环境执行本步骤（含相同 `OPENCLAW_CONFIG_PATH`）；否则 `agent` 可能仍尝试连接默认 `18789`。

成功判据：

- `agent` 命令以退出码 0 完成。
- 若加了 `--json`，输出 JSON 中 `status` 为 `"ok"`。

失败处理：

- 若报连接错误，确认 gateway（Step 3）仍在运行，且端口与配置上下文一致。
- 若报 provider 错误（如 `no provider available`），回到步骤 2b 确认 provider 配置。
- 若命令挂起超过 2 分钟，`Ctrl+C` 终止后检查 gateway 日志。

## 9. 审计核验

```bash
curl -s http://127.0.0.1:18789/plugins/clawlens/api/overview
curl -s 'http://127.0.0.1:18789/plugins/clawlens/api/sessions?limit=20&offset=0'
curl -s 'http://127.0.0.1:18789/plugins/clawlens/api/audit/session/agent%3Amain%3Aexplicit%3Aqa-smoke?limit=20'
```

核验点：

- `totalRuns24h` 增长
- `sessions` 包含目标 `session_key`
- `audit/session` 返回 `runs` 非空

失败处理：

- 若 `totalRuns24h` 未增长，先检查步骤 8 命令是否成功返回。
- 若 `sessions` 不含目标 key，核对第 8 步 `--session-id` 与第 9 步 URL 是否一致映射。
- 若 `audit/session` 为空，确认当前查询的是完整 session key（不是裸 `qa-smoke`）。

## 9b. 快速脚本化自检（可选）

在完成第 3 步 gateway 启动后，可直接运行 smoke 脚本进行一次端到端核验。

注意：此脚本位于 **clawlens 仓库根目录**，而非 `projects-ref/openclaw`。前面步骤 3–8 的 `cd projects-ref/openclaw` 会改变工作目录，执行本步骤前必须先切回 clawlens 仓库根目录。

```bash
cd /path/to/clawlens  # 切回 clawlens 仓库根目录
bash scripts/run-clawlens-qa-smoke.sh \
  --repo-root projects-ref/openclaw \
  --session-id qa-smoke-$(date +%s)
```

通过判据：

- 脚本输出 JSON 且 `result` 为 `pass`。
- `checks.agentOk/overviewIncrement/sessionPresent/auditRunPresent/auditCompleted/toolCallObserved` 全为 `true`。

## 10. Chat Audit 口径检查

### 10a. 计数口径说明

ClawLens audit 数据中有三个工具调用计数维度，它们的含义与关系如下：

| 计数维度 | 位置 | 含义 |
|---|---|---|
| `summary.toolCalls` | `audit/session/<key>` → `runs[].summary.toolCalls` | 整个 run 级别的工具调用总数 |
| assistant turn 数 | `runs[].turns[]` 中 `role == "assistant"` 的条目数 | assistant 回合数（一个 turn 可包含 0 或多次工具调用） |
| `turn.toolCallsCount` | 每个 turn 的 `toolCallsCount` 字段 | 该 turn 内检测到的工具调用次数 |

关键规则：

- `summary.toolCalls` 与 assistant turn 数**不要求相等**。一个 assistant turn 可以触发多次工具调用，也可以不触发。
- `turn.toolCallsCount` 的计算方式：取 `Math.max(explicitToolCalls, contentToolCalls)`，其中 `explicitToolCalls` 来自顶层 `toolCalls`/`tool_calls` 数组，`contentToolCalls` 来自 `content[].type == "toolCall"` 计数。取较大值是为了避免同一调用被双重计数（不同 provider 可能将工具调用放在不同位置）。

### 10b. 核验方法

```bash
curl -s 'http://127.0.0.1:18789/plugins/clawlens/api/audit/session/agent%3Amain%3Aexplicit%3Aqa-smoke?limit=5' | \
  jq '{
    summaryToolCalls: .runs[0].summary.toolCalls,
    assistantTurns: [.runs[0].turns[] | select(.role=="assistant")] | length,
    turnToolCallsCounts: [.runs[0].turns[] | select(.role=="assistant") | .toolCallsCount]
  }'
```

预期：

- `summaryToolCalls` ≥ 1。
- `turnToolCallsCounts` 数组中至少一项 > 0。

### 10c. 计数口径回归用例

每次发版前应执行一次包含至少一次工具调用的 QA 会话用于回归验证：

```bash
cd projects-ref/openclaw
node dist/entry.js agent \
  --session-id qa-toolcall-regression \
  --channel qa-channel \
  --message "Use the session_status tool exactly once, then reply with exactly OK."
```

验证：

```bash
curl -s 'http://127.0.0.1:18789/plugins/clawlens/api/audit/session/agent%3Amain%3Aexplicit%3Aqa-toolcall-regression?limit=5' | \
  jq '[.runs[0].turns[] | select(.role=="assistant") | .toolCallsCount] | any(. > 0)'
```

成功判据：输出为 `true`。若为 `false`，说明 `toolCallsCount` 计算存在回归。

## 11. token 轮换恢复流程

当 gateway 重启、配置变更、或 QA UI/Control UI 出现 401/unauthorized 时，必须执行以下恢复流程：

### 11a. 获取新 token

```bash
cd projects-ref/openclaw
node dist/entry.js dashboard --no-open
```

记录新输出中的 `#token=<NEW_TOKEN>`。

### 11b. 重启 QA Lab UI

在运行 `qa ui` 的终端 `Ctrl+C` 停止旧实例，然后使用新 token 重启：

```bash
cd projects-ref/openclaw
node dist/entry.js qa ui \
  --repo-root . \
  --host 127.0.0.1 \
  --port 43124 \
  --embedded-gateway disabled \
  --control-ui-proxy-target http://127.0.0.1:18789/ \
  --control-ui-token <NEW_TOKEN>
```

### 11c. 验证恢复

```bash
curl -s http://127.0.0.1:18789/plugins/clawlens/api/overview
```

成功判据：

- `overview` 返回 JSON（非 401/unauthorized）。
- 浏览器访问 `http://127.0.0.1:43124/control-ui/#token=<NEW_TOKEN>` 正常加载，无授权错误。

失败处理：

- 若新 token 仍返回 unauthorized，检查 gateway 是否正常运行（`curl -sS http://127.0.0.1:18789/readyz`）。
- 若 gateway 已崩溃，从步骤 3 重新启动整个流程。

## 12. 停止服务

- 在各前台窗口 `Ctrl+C` 停止 `gateway run` 和 `qa ui`。

## 13. 状态保留说明

- 不删除 `~/.openclaw`，以保留 token、会话历史、ClawLens 审计数据与排障上下文。

## 相关文档

- `docs/archive/analysis/RESEARCH_OPENCLAW_QA_LAB_LOCAL_ENABLEMENT_FINDINGS_2026-04-13.md`
- `docs/archive/analysis/ANALYSIS_CLAWLENS_QA_LAB_SOP_IMPROVEMENTS_2026-04-13.md`

## 已完成并纳入（本轮）

- [x] provider 最小矩阵能力已取证（`minimax` / `openai-codex` / fallback 组合），结论已写入相关研究文档。
- [x] CI 轻量回归入口已纳入（`scripts/run-clawlens-qa-smoke.sh`，见 9b）。
- [x] `qa up` Docker lane 已有可执行 workaround：`qa up` 成功后，容器内执行 `plugins install -l /tmp/clawlens` 可打通 `overview/sessions/audit`。
- [x] `qa up` Docker lane 自动化入口已就绪：`scripts/run-clawlens-qa-docker-smoke.sh`（自动 `qa up` + 插件注入 + 审计核验）。

## 待验证后纳入（下一阶段）

- 无（本地范围内）。

### Docker lane 预检查（草案）

在继续 `qa up` Docker lane 前，先确认：

1. 本机存在 `openclaw:qa-local-prebaked`（或已明确可成功 `qa docker-build-image`）。
2. `docker pull node:24-bookworm` 可达（基础镜像链路正常）。
3. 无残留 `qa-docker_default` 网络冲突。
4. 若 shell 使用代理，确认 Docker daemon 也有对应代理环境（避免 shell 可联网但 daemon 拉取超时）。
5. Docker lane 启动后，`/plugins/clawlens/api/overview` 必须返回 JSON（非 `Not Found`）。

建议先执行（从 clawlens 仓库根目录）：

```bash
cd /path/to/clawlens  # 确保在 clawlens 仓库根目录
bash scripts/qa-docker-lane-precheck.sh
```

若上述任一不满足，维持 `qa ui + 复用 gateway` 作为主流程，不进入 Docker lane。

临时 workaround（当前可执行）：

```bash
# qa up 成功后
docker exec qa-docker-openclaw-qa-gateway-1 \
  node dist/index.js plugins install -l /tmp/clawlens
```

然后验证：

```bash
curl -sS http://127.0.0.1:18790/plugins/clawlens/api/overview
```

自动化执行（推荐，从 clawlens 仓库根目录）：

```bash
cd /path/to/clawlens  # 确保在 clawlens 仓库根目录
bash scripts/run-clawlens-qa-docker-smoke.sh
```

## 附录 A: 评审检查单

每轮 QA 执行结束后，按以下表格自检。供人工评审或 AI 评审统一使用。

### Severity 定义

| 级别 | 含义 | 处置 |
|---|---|---|
| Critical | 阻断执行或产生错误结论 | 必须修复后才能继续 |
| High | 影响可复现性或数据准确性 | 当轮修复 |
| Medium | 文档不一致或遗漏，不影响执行 | 下一轮修复 |
| Low | 格式、措辞、可读性 | 按需修复 |

### Pass/Fail 自检表

| SOP 步骤 | 检查项 | 通过条件 | 结果 |
|---|---|---|---|
| 0 | 前置条件 | Node/pnpm/jq/curl 可用，`clawlens/` 与 `projects-ref/openclaw/` 存在，`~/.openclaw` 可写 | |
| 0b | 端口预检 | `ss -tlnp \| grep 18789` 无输出（端口空闲），或已按处理原则释放/改端口 | |
| 1 | 构建产物 | `tsdown-build.mjs` 与 `qa:lab:build` 退出码 0，`dist/entry.js` 存在 | |
| 2 | 插件安装 | `plugins install` 退出码 0，输出含 `clawlens` | |
| 2b | provider 配置 | `onboard` 退出码 0，provider-check agent 返回 `status: "ok"`（或已有可用 provider） | |
| 3 | gateway 就绪 | `readyz` 返回 `ready:true` 或 `ok` | |
| 4 | token 获取 | `dashboard --no-open` 输出含非空 `#token=...` | |
| 5 | QA UI 启动 | `curl http://127.0.0.1:43124/` 返回 HTML | |
| 6 | 访问路径 | QA Lab UI 和 Embedded Control UI 可在浏览器中正常加载 | |
| 7a | 插件 inspect | `plugins inspect clawlens` 显示 `loaded` 且有 routes | |
| 7b | 端口语义 | API 验证全部走 18789，`overview` 返回 JSON 含 `activeRuns` | |
| 7b | token 有效 | QA UI / Control UI 无 401/unauthorized | |
| 8 | smoke run | `agent` 命令退出码 0 | |
| 9 | overview 增量 | `totalRuns24h` 比执行前增长 | |
| 9 | session 可见 | `sessions` 含目标 `session_key` | |
| 9 | audit 非空 | `audit/session/<key>` 返回 `runs` 非空 | |
| 10 | toolCall 口径 | 至少一个 assistant turn 的 `toolCallsCount > 0` | |
| 9b | 脚本化自检 | smoke 脚本输出 `result: "pass"`，所有 `checks.*` 为 `true` | |
| 10c | 口径回归 | 回归会话中 `toolCallsCount` 有 > 0 项 | |
| 11 | token 轮换 | gateway 重启后执行 11a–11c，恢复验证通过 | |
| 12 | 停止服务 | `Ctrl+C` 停止 gateway 和 qa ui，无残留进程 | |
| 13 | 状态保留 | `~/.openclaw` 目录保留，未被误删 | |

### 评审输出要求

- 每条 finding 必须包含：severity / 类型（regression 或 pre-existing） / 证据引用（文件:行号 或命令输出）/ 最小修复建议
- 区分 blocking（Critical/High）和 non-blocking（Medium/Low）
- 无证据支撑的结论标记为 `unverified`
