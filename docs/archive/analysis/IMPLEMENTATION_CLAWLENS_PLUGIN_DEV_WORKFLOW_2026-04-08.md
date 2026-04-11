# Clawlens Plugin Dev Workflow (2026-04-08)

## 目标与范围

本流程仅适用于 `clawlens` 插件开发与发布节奏，不涉及 OpenClaw 上游功能 PR 分期（如 phase1/phase2）。

目标：

1. 保持对稳定版 OpenClaw 的可用性。
2. 尽早发现 `main` 演进带来的兼容性风险。
3. 在 beta 窗口内完成快速验证与反馈。

## 基线策略

默认采用“双轨”：

1. `stable` 轨：以最新稳定 tag 为开发与发布基线（例如 `v2026.4.8`）。
2. `forward` 轨：持续用 OpenClaw `main` 做兼容验证，不作为直接发布基线。

说明：

- OpenClaw 的 release tag 对应 `main` 上的特定 commit；`main` 本身是持续开发轨道，不等同于随时可发布的 stable，稳定性由 tag 标记。
- 因此 `clawlens` 不建议仅追 `main`，也不建议长期停留在旧 tag。

## 分支与开发流程

1. 为当前稳定周期建立分支：`release/openclaw-<tag>`（例：`release/openclaw-v2026.4.8`，本项目内部约定命名）。
2. 日常需求从该分支切短分支开发，合回该 release 分支。
3. 所有对外发布只从当前 release 分支产出。
4. 单独维护一个 `forward/main-compat`（或同等命名）分支，用于吸收并验证 OpenClaw `main`。

## CI 与验证门禁

建议至少两组检查：

1. `stable-gate`：在 release 分支上执行完整门禁（测试、打包、安装校验），必须通过。
2. `forward-compat`：在 main 兼容分支上执行同等或精简验证，可先设为告警不阻塞发布。

建议新增最小兼容矩阵：

- `openclaw@latest-stable-tag`：必过
- `openclaw@main`：持续观察

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

1. 新建下一个 `release/openclaw-<new-tag>`。
2. 回归 `clawlens` 核心能力并修复阻塞项。
3. 通过 `stable-gate` 后再发布插件版本。

### 新 beta tag 发布后

1. 在 beta 发布后尽快回归（官方窗口通常较短）。
2. 若发现阻塞，在 <https://github.com/openclaw/openclaw/issues> 提交标记为 `Beta blocker` 的 issue 并附修复 PR，同时在插件社区 beta 线程同步状态。
3. 在插件社区线程按固定模板同步：`tag`、`result`（all good / breakage）、`blockers`（issue/PR 链接）。

## 执行清单（每次迭代）

1. 确认当前目标 OpenClaw tag 与 release 分支一致。
2. 完成开发与本地验证。
3. 通过 `stable-gate`。
4. 执行一次 `forward-compat` 验证并记录差异。
5. 更新 manifest 兼容字段与发布说明。
6. 用 `openclaw plugins inspect clawlens` 核对插件 shape 与兼容信号（`non-capability` / advisory / warning）。

## 参考

- OpenClaw Plugin Guide: <https://docs.openclaw.ai/plugins/building-plugins>
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
