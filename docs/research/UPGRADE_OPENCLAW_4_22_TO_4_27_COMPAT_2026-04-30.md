# clawlens 在 openclaw 2026.4.22 → 2026.4.27 的兼容性评估

- **结论一句话**: 不需要升级插件代码即可在 4.27 运行。但有 1 个 host 端必填配置 + 2 项强烈建议的 manifest 改进 + 几处可选优化。
- **基线版本**: clawlens `package.json`.openclaw.install.minHostVersion = `>=2026.4.8`
- **目标 host**: `~/.openclaw/node_modules/openclaw@2026.4.27`（远端 szhdy 已就位）
- **采证范围**: `projects-ref/openclaw` 4.27 副本的 CHANGELOG（4.22→4.27 共 5 个版本段）、`docs/plugins/{hooks,manifest,compatibility}.md`、`docs/gateway/configuration-reference.md`、`src/plugins`、`src/plugin-sdk`、`dist/plugin-sdk`，以及 szhdy 上 `openclaw.json` 与 `node_modules/openclaw` 实际安装。

---

## 1. clawlens 当前的 SDK 调用面（兼容性核对清单）

| 调用点 | 4.27 是否仍存在 | 备注 |
|---|---|---|
| `definePluginEntry({ id, name, register })` | 是（`src/plugin-sdk/plugin-entry.ts:254`） | 主入口形态未变 |
| `OpenClawPluginApi`（`api.on / api.config / api.pluginConfig / api.rootDir / api.logger / api.registerService`） | 是 | 全部仍是公共 API |
| `api.on("llm_input"/"llm_output"/"after_tool_call"/"agent_end"/"before_agent_start", …)` | 是 | hooks.md 钩子目录仍包含；`before_agent_start` 标记为「兼容保留」 |
| `api.runtime.events.onAgentEvent / onSessionTranscriptUpdate` | 是 | runtime-types `src/plugins/runtime/types-core.ts:218-219` 仍在；底层来源 `infra/agent-events.ts` 与 `sessions/transcript-events.ts` 也未变 |
| `api.runtime.state.resolveStateDir()` | 是 | 仍是公开 runtime 接口 |
| `api.registerService({ id, start, stop })` | 是 | 服务注册方式不变 |
| `api.registerHttpRoute({ method, path, match, auth, handler })`（在 `src/api-routes.ts` `src/static-server.ts` 用） | 是 | `registerPluginHttpRoute` 仍导出 |
| 直接改 `dist/control-ui/index.html` 注入 `<script>/<link>` | 仍能命中 | 4.27 安装包 `dist/control-ui/index.html` 文件存在（远端实测 + ref 副本） |

**没有任何 clawlens 用到的 API 在 4.22 → 4.27 区间被删/重命名**：

- 4.24 唯一的 BREAKING（`api.registerEmbeddedExtensionFactory` 被移除）→ clawlens 没用，免疫
- 4.27 BREAKING 都集中在 channel-route、模型 catalog、bundled 插件 schema → 与 clawlens 无关
- `openclaw/plugin-sdk/test-utils` 等老子路径已是「兼容别名」→ clawlens 没引用

## 2. 必须改动（红色，否则功能哑火）

### 2.1 host 端：`~/.openclaw/openclaw.json` 增加 `hooks.allowConversationAccess: true`

- **来源**: 4.24 CHANGELOG 落地（fixes #71215, PR #71221），`docs/plugins/hooks.md:226-241` 与 `docs/gateway/configuration-reference.md:193` 写为硬性前提
- **效果**: 非内置插件想拿 `llm_input / llm_output / agent_end / before_agent_finalize` 这四个钩子的原始会话内容，必须在 host config 里逐插件白名单
- **clawlens 命中钩子**: `llm_input` ✅、`llm_output` ✅、`agent_end` ✅ —— 这是 collector 的核心数据源，没开等于把采集的「眼睛」蒙住
- **远端状态（szhdy 已确认）**:
  ```json
  "plugins": {
    "entries": {
      "clawlens": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": { … }
      }
    }
  }
  ```
  → 远端这条已配齐，无需再动。
- **本地 / 其他部署**: 任何接 4.24+ host 的环境都得加。`extensions/clawlens/index.ts` 不需要改。

### 2.2 没有别的「必须改」

- 插件 manifest（`extensions/clawlens/openclaw.plugin.json`）不需要加 hooks 字段——`allowConversationAccess` 是 host 配置，不是 plugin manifest 字段。
- 代码层零改动即可工作。

## 3. 建议改动（黄色，影响向前兼容/可观测性）

### 3.1 `package.json` 提高 `minHostVersion` 到 `>=2026.4.24`

- 现值：`>=2026.4.8`
- 理由：4.24 之前 host 校验器并不认识 `plugins.entries.<id>.hooks.allowConversationAccess`，老 host 上 host config 那段会被 schema 拒绝，从而出现「装得上但跑不动」。把下限抬到 4.24 让安装体验与运行时门槛保持一致。
- 改一行即可：`extensions/clawlens/package.json` → `"minHostVersion": ">=2026.4.24"`。

### 3.2 `openclaw.plugin.json` 显式声明 `activation.onStartup: true`

- 来源：4.27 三连引入 `activation.onStartup`：
  - 添加显式元数据
  - 对未声明的插件触发 `legacy-implicit-startup-sidecar` 兼容警告
  - 提供 `OPENCLAW_DISABLE_LEGACY_IMPLICIT_STARTUP_SIDECARS=1` 让维护者预演「将来严格模式」
- clawlens 必须在 gateway 启动时就 `registerService`、注册 HTTP 路由、订阅 agent events 才能采集到完整数据 → 必须随 gateway 启动加载 → 设 `true`。
- 改动：`openclaw.plugin.json` 顶层加
  ```json
  "activation": { "onStartup": true }
  ```
- 不加的代价：4.27 doctor / plugins status 会持续打 `legacy-implicit-startup-sidecar` 警告；如果 host 端将来打开严格开关或下个大版本默认严格，clawlens 会被启动规划跳过。

## 4. 可选优化（绿色，4.22 之后新增的能力）

| 项 | 来源版本 | 价值 |
|---|---|---|
| `model_call_started` / `model_call_ended`（metadata-only） | 4.25 | 不用动 `allowConversationAccess` 也能拿到 provider/model/durationMs/outcome/请求 ID 哈希 → collector 可以把模型调用计数与时延单独建一张维度更干净的表 |
| `before_agent_finalize` | 4.25 | 可让 comparator 在最终回答前做一次 review/对比；目前 clawlens 用 `before_agent_start`（4.27 docs 标为「兼容保留」） |
| `before_model_resolve` + `before_prompt_build` | 4.20 起 | 推荐替代 `before_agent_start` 的两个细分钩子；clawlens 当前在 compare 路径上仍用 `before_agent_start`，迁移过去更明确 |
| `api.registerSessionExtension(...)` + `api.enqueueNextTurnInjection(...)` | 4.x 期间 | 把 ClawLens 的"上次回顾"或"等待人工对比"这类需要持久到下一轮 prompt 的状态用 SDK 通道走，而不是自己存盘后注入 |
| `OpenClawPluginApi` 不再需要 `as any` 强转 | 4.27 plugin-test-api 子路径 | `registerApiRoutes(api as any, …)` `registerStaticRoutes(api as any, …)` 可以换成 `OpenClawPluginApi` 显式类型，去掉 any 强转 |

这些都属于"清债 + 能力扩展"，不是兼容性必须。

## 5. 验证步骤（升级到 4.27 后跑一遍）

1. 远端 `openclaw doctor` —— 看是否打 `legacy-implicit-startup-sidecar`、是否打 `allowConversationAccess` 相关 warn
2. 远端 `openclaw plugins list` 与 `openclaw plugins status clawlens` —— 应该是 enabled / loaded / no compatibility warnings
3. 触发一次实际对话，检查：
   - clawlens UI 列表里 `llm_input / llm_output / agent_end` 计数是否随对话增加
   - `~/.openclaw/extensions/clawlens` 状态目录里 SQLite 是否写入 run / message / tool 行
   - SSE 通道（`/plugins/clawlens/api/...`）是否仍正常推送
4. 跑插件自测：
   - `cd extensions/clawlens && pnpm typecheck`
   - `cd extensions/clawlens && pnpm test`
5. 检查 Control UI 注入：刷新 `<host>:<port>/`，DevTools 看 `<script src="/plugins/clawlens/ui/inject.js?v=…">` 与 `<link rel="stylesheet" …/styles.css?v=…">` 是否双双在 `<body>` / `<head>` 末尾被 patch 进去

## 6. 风险点

- **风险 A — Control UI 路径假设**：`patchControlUiIndexHtml` 假设构建产物在 `dist/control-ui/index.html`。4.27 仍是该路径（已实测），但这是上游内部产物结构，没有 SDK 契约，未来仍可能动。当前不需要改，但应放进监控/冒烟用例。
- **风险 B — `api.runtime.events.onAgentEvent` 与 `onSessionTranscriptUpdate` 是 runtime 直接订阅**：仍存在但 hooks.md 主要文档是引导用 `api.on(...)`。建议中长期把会话级订阅迁到 `agent_end` + `before_message_write` + `tool_result_persist` 等正式钩子，减少对 runtime 内部 event bus 的依赖。
- **风险 C — `before_agent_start` 在 hooks.md `Upcoming deprecations` 里**：还能用，新版迁移 `before_model_resolve` + `before_prompt_build`，否则下个大版本可能停。
- **风险 D — host 配置漂移**：远端 `openclaw.json.clobbered.*` 文件多次出现（4-30 那天就有 3 个），说明 config 多源写入有冲突。每次升级 host 后需要再核一次 `plugins.entries.clawlens.hooks.allowConversationAccess` 是否仍是 `true`。

---

## 7. 升级动作清单（按"必须 → 建议"排序）

1. ✅（远端已完成）`~/.openclaw/openclaw.json` 中 `plugins.entries.clawlens.hooks.allowConversationAccess: true`
2. ✅ 改 `extensions/clawlens/package.json`：`openclaw.install.minHostVersion` 由 `>=2026.4.8` → `>=2026.4.24`
3. ✅ 改 `extensions/clawlens/openclaw.plugin.json`：顶层加 `"activation": { "onStartup": true }`
4. ✅（已完成）clawlens 的 collector 加 `model_call_started/_ended` 监听，写到调用维度表
5. ✅（已完成）comparator 用 `before_agent_finalize` 替代 `before_agent_start`
6. ✅（已完成）`registerApiRoutes / registerStaticRoutes` 的入参类型从局部 `PluginApi` 升级到 `OpenClawPluginApi`，去 `as any`

只做 2 + 3 已经能让 clawlens 在 4.27 路上无杂音；1 已落地。

---

## 8. 接下来工作的完整提示词（可直接喂给下一段 Claude 会话）

> 我在 clawlens 仓库根目录。openclaw host 已升级到 2026.4.27，远端（szhdy）`openclaw.json` 里 `plugins.entries.clawlens.hooks.allowConversationAccess: true` 已就位。请按下面顺序完成升级，并把每步改动以独立 commit 提交（commit message 用 `chore`/`feat`/`docs` 前缀，简洁中文一句话即可）：
>
> **Step 1（必做，提兼容下限）**
> 修改 `extensions/clawlens/package.json`：把 `openclaw.install.minHostVersion` 从 `">=2026.4.8"` 改成 `">=2026.4.24"`。理由：`hooks.allowConversationAccess` 是 4.24 才进入 host schema 的字段，下限不抬齐会导致老 host 上 schema 校验失败。
>
> **Step 2（必做，去掉 `legacy-implicit-startup-sidecar` 警告）**
> 修改 `extensions/clawlens/openclaw.plugin.json`：在顶层 JSON 加：
> ```json
> "activation": { "onStartup": true }
> ```
> clawlens 在启动时就要订阅 agent events / 注册 HTTP 路由，必须随 gateway 启动加载。`docs/plugins/manifest.md` 第 261-300 行确认 `activation.onStartup: true` 是显式启动激活，未来严格模式必需。
>
> **Step 3（必做，本地校验）**
> 在 `extensions/clawlens/` 下：
> 1. `pnpm typecheck`
> 2. `pnpm test`
> 3. `node ../../scripts/check-clawlens-manifest.mjs`（如果该脚本对 minHostVersion / activation 有断言，按报错补）
>
> **Step 4（必做，远端冒烟）**
> SSH `szhdy`，重启 gateway 后跑：
> 1. `openclaw doctor --non-interactive` —— 不应出现 `legacy-implicit-startup-sidecar` 与任何 `clawlens` 相关 warning
> 2. `openclaw plugins status clawlens` —— enabled / loaded / no warnings
> 3. 在远端发起一次真实 agent turn，然后查 `~/.openclaw/extensions/clawlens/state/*.sqlite`（或 plugin 实际 stateDir）确认 `llm_input / llm_output / agent_end` 三类事件都有新行；同时确认 Control UI 加载了 `inject.js` 与 `styles.css`
>
> **Step 5（建议，迁移 `before_agent_start`）**
> 把 `extensions/clawlens/index.ts` 里 `api.on("before_agent_start", ...)` 这条 compare 路径，按 `docs/plugins/hooks.md` 拆为 `before_model_resolve`（如果 comparator 需要换 provider/model）和 `before_prompt_build`（如果只是注入上下文）。如果 comparator 只是「在原模型回答前并行另一模型」，更合适的位点是 `before_agent_finalize` —— 拿到自然终态后再触发 review。
>
> **Step 6（建议，模型调用计数表）**
> 在 `extensions/clawlens/src/collector.ts` 新增对 `model_call_started` 与 `model_call_ended` 的订阅（不需要 `allowConversationAccess`，metadata-only）。落到 store 里一张新维度表（runId, callId, provider, model, api, transport, durationMs, outcome, upstreamRequestIdHash），UI 端给 collector 视图加一栏「模型调用」。
>
> **Step 7（建议，类型清理）**
> `extensions/clawlens/src/api-routes.ts` 与 `src/static-server.ts` 里把 `type PluginApi = { registerHttpRoute… }` 局部声明换成 `import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry"`，并把 `index.ts` 里 `registerApiRoutes(api as any, …)`、`registerStaticRoutes(api as any, …)` 的 `as any` 全部去掉。
>
> 完成后更新 `docs/research/UPGRADE_OPENCLAW_4_22_TO_4_27_COMPAT_2026-04-30.md` 第 7 节的勾选状态，并把验证截图/日志贴到 PR 描述里。如果 Step 4 里远端冒烟不通过，**先回滚到当前 commit**，再排查；不要在远端反复改 `~/.openclaw/openclaw.json`，那个文件最近多次出现 `*.clobbered.*` 备份，写冲突敏感。
