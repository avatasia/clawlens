# ClawLens QA Lab SOP 改进分析（含证据）（2026-04-13）

## 目标

结合当前 QA 相关文档与本轮本地实测，分析现有 ClawLens QA 流程可补强点。

说明：

- 本文只给“建议 + 证据”。
- 仅操作步骤版 SOP 草案单独见：`docs/archive/analysis/IMPLEMENTATION_CLAWLENS_QA_LAB_TEST_SOP_DRAFT_2026-04-13.md`。

## 证据清单

### E1. 官方命令职责分离（Docker vs UI）

- `openclaw qa up --help` 描述为 Docker-backed QA stack。
- `openclaw qa ui --help` 支持 `--embedded-gateway`、`--control-ui-proxy-target`、`--control-ui-token`，可复用现有 gateway。
- 参考：
  - `projects-ref/openclaw/docs/concepts/qa-e2e-automation.md`
  - `projects-ref/openclaw/docs/help/testing.md`

### E2. QA Bootstrap 显示 Control UI 通过 43124 `/control-ui/` 嵌入

- `GET http://127.0.0.1:43124/api/bootstrap` 返回 `controlUiUrl` 与 `controlUiEmbeddedUrl`。

### E3. 端口语义不同：43124 不是插件 API 端口

- `GET http://127.0.0.1:43124/plugins/clawlens/api/overview` 返回 HTML（QA SPA fallback）。
- `GET http://127.0.0.1:18789/plugins/clawlens/api/overview` 返回真实 JSON。

### E4. token 失配会导致 UI 未授权

- 本轮 gateway 日志出现 `token_missing`/unauthorized，且在重启/配置变更后需要刷新 token。
- `dashboard --no-open` 在重启后返回的新 token 与旧 token 不同。

### E5. provider 配置应走官方 onboarding

- 直接 `config set models.providers.minimax-cn.apiKey` 触发 schema 错误（还要求 `baseUrl`、`models`）。
- `onboard --auth-choice minimax-cn-api` 一次性完成可用配置并通过实际 agent run。

### E6. Chat Audit 计数口径

- `qa-smoke` run：`summary.toolCalls = 11`，`assistantTurns = 7`，属正常（一个 assistant turn 可含多个 tool calls）。
- 修复前实测（runId=`075efdfc-b4b1-4b00-bfdf-6de91bcfa0b8`）：assistant turns 的 `toolCallsCount` 为 `[0,0,0,0,0,0,0]`（漏计 `content[]` 中 `toolCall`）。
- 修复后实测（runId=`7b23ad18-8452-4615-8f24-f21cc3f060bf`）：assistant turns 的 `toolCallsCount` 为 `[2,0]`，可反映工具调用的 turn 内分布。
- 代码修复点：`extensions/clawlens/src/collector.ts`（`normalizeTranscriptMessage`）。

### E7. 现有文档缺口

- `docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md` 聚焦兼容门禁，未定义“QA Lab 复用 gateway 的本地回归 SOP”。
- 现有 QA 研究文档已记录远程链路问题，但未沉淀为统一本地操作规程：
  - `docs/archive/analysis/RESEARCH_OPENCLAW_QA_LAB_REMOTE_STATUS_2026-04-11.md`
  - `docs/archive/analysis/RESEARCH_OPENCLAW_QA_REMOTE_ENABLEMENT_2026-04-12.md`

## SOP 改进建议（每条含证据）

### R1. 将 QA 流程拆成两条 lane（默认 lane 与扩展 lane）

建议：

- 默认 lane：`qa ui` 复用现有 gateway（用于 ClawLens 回归）。
- 扩展 lane：`qa up` Docker stack（用于完整环境回归）。

证据：E1, E7

### R2. 在 SOP 开头新增“端口语义检查”

建议：

- 明确：`18789` 是插件 API truth source，`43124` 是 QA UI。
- 所有 API 验证命令统一走 `18789`。

证据：E2, E3

### R3. 增加 token 刷新步骤（强制）

建议：

- 每次 gateway restart 后，必须重新执行 `dashboard --no-open`。
- QA UI 如嵌入 Control UI，需同步替换 `--control-ui-token`。

证据：E4

### R4. provider 配置统一走 `onboard --auth-choice ...`

建议：

- 禁止在 SOP 中用零散 `config set` 拼 provider 配置。
- 对 MiniMax CN 固定采用 `minimax-cn-api` onboarding。

证据：E5

### R5. 增加“run 级/turn 级计数口径说明”

建议：

- SOP 中显式写明：`toolCalls` 与 `assistantTurns` 不要求相等。
- 核验应看三组数据：`summary.toolCalls`、assistant turn 数、`turn.toolCallsCount`。

证据：E6

### R6. 增加“计数口径回归用例”

建议：

- 每次发布前跑一个至少包含两次 tool call 的短会话。
- 验证 assistant turn 中 `toolCallsCount` 至少有一条 > 0。

证据：E6

### R7. 增加“插件加载真值检查”

建议：

- 将 `plugins inspect clawlens` 与 `overview` API 作为硬前置。
- 任一失败则不进入 QA 执行步骤。

证据：E3, E7

### R8. 补一条“数据对齐检查”

建议：

- 执行 smoke run 后，要求同时看到：
  - `overview.totalRuns24h` 增长
  - `sessions` 出现目标 `session_key`
  - `audit/session/<session_key>` 返回 `runs` 非空

证据：E3, E6

## 优先级建议

| 建议 | Severity | 处置 | 状态 |
|---|---|---|---|
| R2 端口语义检查 | Critical | 当轮纳入 SOP | 已纳入 |
| R3 token 刷新 | Critical | 当轮纳入 SOP | 已纳入 |
| R4 provider onboarding | Critical | 当轮纳入 SOP | 已纳入 |
| R7 插件加载真值检查 | Critical | 当轮纳入 SOP | 已纳入 |
| R8 数据对齐检查 | Critical | 当轮纳入 SOP | 已纳入 |
| R1 QA lane 拆分 | High | 下一轮纳入 | 待验证 |
| R5 计数口径说明 | High | 下一轮纳入 | 待验证 |
| R6 计数口径回归用例 | Medium | 持续回归项 | 待验证 |

## 纳入策略建议（与当前执行一致）

- 本轮仅纳入已验证项（P0）进入主操作流程。
- `qa up`/远程链路/CI 自动化保持在待验证清单，逐项验证后再并入 SOP。
- 避免在主流程提前混入未稳定链路，降低执行歧义与排障成本。

## 结论

当前文档体系已经覆盖了“QA 能做什么”，但还缺“如何稳定用于 ClawLens 回归”的操作规约。按本分析引入上述改进后，可显著降低以下误判：

- 端口误用导致的“假 200”
- token 失配导致的 UI 假故障
- provider 配置不完整导致的假回归失败
- toolCall/turn 口径混淆导致的错误结论

## 口径补充（关于实现细节）

当前实现对 turn 级工具数采用“取两种表示的较大值”而非求和：

- top-level: `toolCalls/tool_calls`
- content array: `content[].type == "toolCall"`

实现为 `Math.max(explicitToolCalls, contentToolCalls)`，用于避免同一调用被双重计数。
