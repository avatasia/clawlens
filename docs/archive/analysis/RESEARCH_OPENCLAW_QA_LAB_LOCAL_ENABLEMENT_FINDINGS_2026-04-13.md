# OpenClaw + QA Lab 本地启用新发现（2026-04-13）

## 范围

本记录聚焦本轮本地联调：

- OpenClaw 源码基线：`projects-ref/openclaw` `v2026.4.11`
- 目标：在本地启用 QA Lab，并验证 ClawLens 在 QA 流量下可观测

## 本轮新增发现

### 1) `qa up` 与 `qa ui` 是两条不同启动路径

- `openclaw qa up` 明确是 Docker-backed 路径（会拉起/构建 QA stack）。
- `openclaw qa ui` 可单独启动 QA Lab UI 与 QA bus，并通过 `--embedded-gateway disabled` + `--control-ui-proxy-target` 复用已有 gateway。

对 ClawLens 联调的直接意义：

- 当目标是“验证插件与现有 gateway 行为”，优先 `qa ui` 复用模式，避免把问题混入 Docker 构建链路。

### 2) 从源码运行 QA，`dist/entry.js` 路径更稳

在本地源码目录中，`pnpm openclaw qa ...` 可能触发运行时 post-build 依赖阶段失败；先构建 `dist` 后用 `node dist/entry.js qa ...` 可绕开该失败面，适合本地功能核验。

### 3) QA Lab 端口不是 gateway API 端口

在 `43124`（QA Lab）访问 `/plugins/clawlens/api/overview` 返回的是 QA SPA HTML，而不是真实插件 API JSON；真实插件 API 应直接打 `18789` gateway。

对调试的直接意义：

- 验证 ClawLens API 时必须使用 gateway 端口，不能误用 QA Lab 端口。

### 4) gateway token 会在配置/重启后变化

本轮观察到在 onboarding 与重启后 token 发生变化；继续使用旧 token 时，Control UI 会出现 `token_missing` / unauthorized。

对联调的直接意义：

- 每次 gateway restart 后都要重新执行 `dashboard --no-open`，并刷新 QA UI 注入 token。

### 5) `minimax-cn-api` 最稳妥配置方式是官方 onboarding

直接用 `config set` 逐项写 `minimax-cn` 会触发 schema 要求（如 `baseUrl`、`models`）。使用 `onboard --auth-choice minimax-cn-api` 能一次性补齐可用配置。

额外观察：

- 运行时可能出现 `minimax-cn` 认证失败后回退 `minimax` 的行为；实际可用 provider 以运行结果为准。

### 6) Chat Audit 的“tool call 总数”与“assistant turn 数”不必相等

一次 assistant turn 可包含多个 toolCall，因此出现 `toolCalls > assistantTurns` 是合理现象。

本轮还修复了一个显示口径问题：

- 之前 `toolCallsCount` 只看顶层 `toolCalls/tool_calls`，会漏掉 `content[]` 里的 `type: "toolCall"`（MiniMax 常见）。
- 修复后 turn 级工具计数与 run 级计数更一致。

### 7) 非默认 gateway 端口需要绑定同一配置上下文

本轮在本地 smoke 自动化中观察到：

- 当 gateway 改为非默认端口（如 `28789`）时，若 `agent` 命令未与 `qa ui` 保持同一配置上下文，`agent` 可能回落到默认 `127.0.0.1:18789`。
- 直接后果是：`agent` 命令可返回，但 ClawLens 审计链路不会在目标端口增长，表现为 `overview` 不增、`audit/session` 为空。

对联调的直接意义：

- 一旦偏离默认 `18789`，必须显式统一 `OPENCLAW_CONFIG_PATH`（或确保所有命令在同一配置文件下运行）。

### 8) 本地 smoke 实测已通过（结构化结果）

本轮完成一轮本地 smoke（修正配置上下文后）并通过，关键指标：

- `result = pass`
- `checks.agentOk = true`
- `checks.overviewIncrement = true`
- `checks.sessionPresent = true`
- `checks.auditRunPresent = true`
- `checks.auditCompleted = true`
- `checks.toolCallObserved = true`

## 可复用命令（本轮实测）

```bash
# 1) 在源码目录先构建
cd projects-ref/openclaw
node scripts/tsdown-build.mjs --no-clean
pnpm qa:lab:build

# 2) 启动 gateway（前台）
node dist/entry.js gateway run --force --port 18789 --bind loopback

# 3) 获取 dashboard token
node dist/entry.js dashboard --no-open

# 4) 启动 QA UI（复用 gateway）
node dist/entry.js qa ui \
  --repo-root . \
  --host 127.0.0.1 \
  --port 43124 \
  --embedded-gateway disabled \
  --control-ui-proxy-target http://127.0.0.1:18789/ \
  --control-ui-token <TOKEN>

# 5) 验证 ClawLens API（用 18789，不用 43124）
curl -s http://127.0.0.1:18789/plugins/clawlens/api/overview
```

## 后续建议

- 把“QA UI 复用 gateway 的无 Docker 路径”写入 ClawLens QA SOP 默认流程。
- 把“token 刷新步骤”和“18789/43124 端口语义”写成强制 preflight 检查项。
- 把“非默认端口必须统一 `OPENCLAW_CONFIG_PATH`”写入 SOP 显式约束，避免 `agent` 命中错误 gateway。
- 持续用 QA 场景回归 `toolCallsCount` 显示口径，避免 provider 差异再次引入偏差。
