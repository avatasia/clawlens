# Clawlens Plugin Dev Workflow

## Owner

- Owner: `clawlens` maintainers
- Review cadence: OpenClaw `main` 有重大 SDK/plugin-api 变更后 24 小时内完成一次复核

## 目标与范围

本流程仅适用于 `clawlens` 插件开发与发布节奏，不涉及 OpenClaw 上游功能 PR 分期。

目标：

1. 保持对 OpenClaw `main` 的持续可用性。
2. 尽早发现 `main` 演进带来的兼容性风险。
3. 在 beta 窗口内完成快速验证与反馈。

## 基线策略

默认采用 **main-first**：以 `projects-ref/openclaw` 的 `main` 分支作为开发与验证基线。

说明：

- 经过 `2026-04-10` 的兼容性分析（见 [ANALYSIS_CLAWLENS_MAIN_BASELINE_MIGRATION_2026-04-10.md](plans/ANALYSIS_CLAWLENS_MAIN_BASELINE_MIGRATION_2026-04-10.md)），确认 ClawLens 对 OpenClaw 的 SDK 与 plugin API 依赖在 `main` 当前版本（`2026.4.10`，commit `65b781f9ae`）上无硬阻塞。
- 旧的"双轨"模型（`stable` 轨 + `forward` 轨）已废弃。该模型的问题是：`forward-compat` 门禁实际上无法有效执行（本地无 `openclaw` CLI），且 `stable` 轨的标签追踪带来不必要的分支管理开销。
- 当 OpenClaw 发布新 stable tag 时，仍应做一次回归验证，但不再为此建立专用 release 分支。

### 从旧模型迁移

| 旧模型 | 新模型 |
|---|---|
| `stable` 轨以最新 stable tag 为基线 | 以 `projects-ref/openclaw main` 为基线 |
| `forward` 轨持续验证 `main` | 不再区分轨道，`main` 即默认基线 |
| `release/openclaw-<tag>` 分支 | 不再建立；按需在 tag 发布时做回归 |
| `forward/main-compat` 分支 | 不再需要 |

## 分支与开发流程

1. 日常开发从 `main` 切短分支，完成后合回。
2. 不再为 OpenClaw stable tag 建立专用 release 分支。
3. 当 OpenClaw 发布新 stable tag 时，更新 `projects-ref/openclaw` 到该 tag，执行一次回归验证。

## CI 与验证门禁

### `stable-gate`

当前 `stable-gate` 的实际验证范围：

- `check-docs-governance.mjs`：文档治理规则检查。
- `check-clawlens-manifest.mjs`：manifest 格式与必填字段检查。
- `pnpm test`：插件单元测试。

**`stable-gate` 不验证运行时兼容性。** 它证明的是 manifest 正确性与测试隔离通过，不证明插件能在 OpenClaw 运行时中成功加载。

### `forward-compat`

当前 `forward-compat` 的实际行为：

- 运行 manifest 检查。
- 尝试调用 `openclaw plugins inspect clawlens`。
- 若 `openclaw` 不在 PATH 中，`soft` 模式直接跳过，`strict` 模式报错退出。

**当前问题：** 本地和远端的 `openclaw` 均不在默认 PATH 中，因此 `soft` 模式下该门禁始终跳过，实际上从未执行过 inspect 验证。

### 最小兼容矩阵（目标）

- `openclaw@main`（`projects-ref/openclaw`）：持续验证，必过。
- `openclaw@latest-stable-tag`：tag 发布时做回归验证。

## `forward-compat` 门禁改进提案

> **注意：以下是提案，不是已实施的变更。实施需修改 `scripts/forward-compat.sh`，属于后续代码变更阶段。**

### 问题分析

`forward-compat.sh` 当前依赖 `command -v openclaw` 来寻找 CLI。由于：

1. 本地未安装 `openclaw` CLI（或未在 PATH 中）。
2. 远端 `openclaw` 在 `/home/openclaw/.nvm/versions/node/v24.14.0/bin/openclaw`，不在默认非交互式 SSH PATH 中。

因此门禁在 `soft` 模式下始终跳过，从未产生过实际验证结果。

### 方案 A：接受 `--openclaw-bin` 参数

```bash
# 示例用法
bash scripts/forward-compat.sh soft --openclaw-bin /path/to/openclaw
```

修改要点：

- 新增 `--openclaw-bin <path>` 可选参数。
- 若提供，则直接使用该路径执行 `plugins inspect`，跳过 `command -v` 检测。
- 若未提供，回退到当前的 PATH 检测逻辑。

优势：不改变默认行为，向后兼容。
劣势：仍需要一个可运行的 `openclaw` 实例。

### 方案 B：使用 `projects-ref/openclaw` 做 import 验证

```bash
# 无需 openclaw CLI，直接用本地参考源
bash scripts/forward-compat.sh soft --use-local-ref
```

修改要点：

- 新增 `--use-local-ref` 模式。
- 使用 Node.js 解析 `extensions/clawlens/index.ts` 中的 `openclaw/plugin-sdk/*` 导入。
- 在 `projects-ref/openclaw/src/` 中验证对应导出是否存在。
- 不需要 `openclaw` CLI 运行时。

优势：完全本地化，可在任何环境执行。
劣势：仅验证 import 解析，不验证运行时行为（如 hook 注册、API route 可用性）。

### 方案 C：结合 A + B

- 默认使用方案 B（本地 import 验证）作为基线检查。
- 可选使用方案 A（`--openclaw-bin`）做更深层的 `plugins inspect` 验证。
- 两者结果都记录到门禁输出。

### 建议

推荐 **方案 C**，分阶段实施：

1. 先实现方案 B，使 `forward-compat` 在无 CLI 环境下也能产生有意义的验证结果。
2. 再补充方案 A，为有 CLI 的环境提供更深层验证。

### `stable-gate` 补充说明

`stable-gate` 当前行为准确，不需要修改。但应在文档中明确其验证边界：

- 它证明 manifest 正确、文档合规、测试通过。
- 它**不**证明插件能在 OpenClaw 运行时中加载运行。
- 运行时兼容性验证是 `forward-compat` 的职责。

## 版本与清单约束（Manifest）

OpenClaw 插件 manifest 分两处维护，职责不同：

### `openclaw.plugin.json`（控制面，加载前读取）

必填字段：

- `id`：插件 canonical ID，与 `plugins.entries.<id>` 对齐。
- `configSchema`：JSON Schema，即使无配置项也必须显式声明为 `{}`。

### `package.json` 的 `openclaw` 块（打包/安装行为）

建议维护以下官方字段与目标版本一致：

- `openclaw.install.minHostVersion`：最低宿主版本要求（示例：`>=2026.4.8`）。
- `openclaw.extensions`：插件入口声明。
- `openclaw.install.npmSpec`：npm 包标识符。

注：

- clawlens 内部构建流程可能额外写入 `openclaw.compat.*` / `openclaw.build.*` 等私有字段用于版本追踪；这些不应被视为 OpenClaw 官方控制面输入。

并遵守：

- 使用 `openclaw/plugin-sdk/<subpath>` 导入，不使用已弃用的根导入。
- 当前 `clawlens` 以 service/route/hook 为主；若未来新增 tool，工具名需避免与 core tools 冲突。

## Clawlens 定位映射（官方术语）

结合 `extensions/clawlens/index.ts` 当前实现，`clawlens` 的官方 shape 分类为：

1. 插件形状：`non-capability`。
   注册了 service、routes、静态 UI，但未注册 provider/channel capability。可用 `openclaw plugins inspect clawlens` 验证。
2. 内部机制：hook 驱动。
   通过 `api.on(...)` 与 `api.runtime.events.on...` 采集与拦截事件。hook 是实现机制，不直接决定 shape。
3. 警戒线：若未来移除所有 service/route 仅保留 hook，shape 将退化为 `hook-only` 并触发 advisory warning。
4. 兼容结论：属于官方兼容路径，无需迁移为 capability-only 设计。
5. 演进方向：逐步收敛为清晰的 service/API 边界，避免隐式耦合到未文档化内部实现。

## 新版本节奏（Tag/Beta）

### 新稳定 tag 发布后

1. 更新 `projects-ref/openclaw` 到新 tag。
2. 执行 `stable-gate` 和 `forward-compat` 回归验证。
3. 修复阻塞项（如有）。
4. 如需发布插件新版本，从 `main` 分支产出。

### 新 beta tag 发布后

1. 在 beta 发布后尽快回归（官方窗口通常较短）。
2. 若发现阻塞，在 <https://github.com/openclaw/openclaw/issues> 提交标记为 `Beta blocker` 的 issue 并附修复 PR，同时在插件社区 beta 线程同步状态。
3. 在插件社区线程按固定模板同步：`tag`、`result`（all good / breakage）、`blockers`（issue/PR 链接）。

## 执行清单（每次迭代）

1. 确认 `projects-ref/openclaw` 已更新到目标版本。
2. 完成开发与本地验证。
3. 通过 `stable-gate`。
4. 执行 `forward-compat` 验证并记录差异。
5. 更新 manifest 兼容字段与发布说明。
6. 用 `openclaw plugins inspect clawlens` 核对插件 shape 与兼容信号（`non-capability` / advisory / warning）。

## 自动执行约束（本地）

当前本仓库已提供本地自动化门禁：

1. `pre-commit`：执行 `node scripts/check-docs-governance.mjs`。
2. `pre-push`：执行 `bash scripts/stable-gate.sh` 与 `bash scripts/forward-compat.sh soft`。
3. 手工命令：
   - `bash scripts/stable-gate.sh`
   - `bash scripts/forward-compat.sh soft|strict`

入口文档：

- [DOCS_GOVERNANCE_AUTOMATION.md](DOCS_GOVERNANCE_AUTOMATION.md)

## 运行时验证前置条件

以下步骤需要 CI 环境才能执行，本地沙箱可能无法满足：

- `openclaw plugins inspect clawlens`：需安装 `openclaw` CLI（本地沙箱可能缺失）。
- `pnpm test`（`extensions/clawlens/`）：需访问 npm registry（本地沙箱可能受网络限制）。

在具备依赖和 CLI 的 CI 环境中，`stable-gate` / `forward-compat` 作为最终发布门禁。

## 参考

- OpenClaw Plugin Guide: <https://docs.openclaw.ai/plugins/building-plugins>
- Plugin Manifest: <https://docs.openclaw.ai/plugins/manifest>
- Plugin Entry Points: <https://docs.openclaw.ai/plugins/sdk-entrypoints>
- Plugin SDK Overview: <https://docs.openclaw.ai/plugins/sdk-overview>
- Plugin Internals / Architecture: <https://docs.openclaw.ai/plugins/architecture>
- OpenClaw Releases: <https://github.com/openclaw/openclaw/releases>
- Hooks (Automation): <https://docs.openclaw.ai/automation/hooks>
- Hooks CLI: <https://docs.openclaw.ai/cli/hooks>
- OpenClaw release workflows:
  - <https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-npm-release.yml>
  - <https://github.com/openclaw/openclaw/blob/main/.github/workflows/docker-release.yml>
  - <https://github.com/openclaw/openclaw/blob/main/.github/workflows/macos-release.yml>

## 相关分析文档

- 基线迁移分析：[ANALYSIS_CLAWLENS_MAIN_BASELINE_MIGRATION_2026-04-10.md](plans/ANALYSIS_CLAWLENS_MAIN_BASELINE_MIGRATION_2026-04-10.md)
- 历史兼容性分析（v2026.4.5）：[RESEARCH_OPENCLAW_V2026_4_5_COMPAT_ANALYSIS_2026-04-06.md](research/RESEARCH_OPENCLAW_V2026_4_5_COMPAT_ANALYSIS_2026-04-06.md)

## 历史版本

- 过程版本（已归档）：
  [IMPLEMENTATION_CLAWLENS_PLUGIN_DEV_WORKFLOW_2026-04-08.md](archive/analysis/IMPLEMENTATION_CLAWLENS_PLUGIN_DEV_WORKFLOW_2026-04-08.md)
- 主题历史入口：
  [CLAWLENS_PLUGIN_DEV_WORKFLOW_HISTORY.md](archive/history/CLAWLENS_PLUGIN_DEV_WORKFLOW_HISTORY.md)
