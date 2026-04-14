# OpenClaw QA 远程启用与构建链路研究（2026-04-12）

## 背景

本次目标是在远程环境启用 `openclaw qa up`，并在不污染现有运行环境的前提下定位失败根因、收敛最小改动方案。

关键约束：

- 优先复用现有 `openclaw` 安装目录，不做整仓替换。
- 保持 `~/.openclaw` 数据目录可用。
- 仅在必要时补齐 QA 启动所需缺失文件。

## 关键结论

1. `openclaw qa up` 默认走 Docker 构建链路，不是只跑本地已启动服务。
2. 失败主因不是单点，而是“缺文件 + 构建上下文过大 + 磁盘/缓存压力”叠加。
3. `docker-compose.qa.yml` 为运行时生成；支持 `build:` 与 `image:` 两种模式，不是只能 build。
4. 默认策略下 `pull_policy: never`，即使指定 `image:` 也不会自动从远端仓库拉取，需提前 `docker pull` 或 `docker load`。
5. 仅有 `dist/` 等编译产物不足以支撑 `qa up --build`；该流程依赖完整构建输入（`Dockerfile`、`scripts/`、`src/`、`extensions/`、`ui/`、`package*.yaml/json` 等）。

## 已执行的最小化修复与验证

围绕 QA 启用链路执行过以下动作（按先后）：

1. 补齐 QA 命令与场景相关缺失文件（早期阶段）。
2. 发现 `qa up` 报错 `Dockerfile: no such file or directory`，确认安装目录缺少构建根文件。
3. 按报错逐步补齐构建必要文件（`Dockerfile`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.npmrc`、`scripts/`、`packages/`、`tsconfig*`、`tsdown.config.ts`、`extensions/`）。
4. 识别并修复 `.dockerignore` 缺失导致的 build context 膨胀问题。
5. 针对 `ui:build` 报错，补齐 `apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json`。
6. 清理 Docker 构建缓存与镜像，回收空间后重试。

## 失败链路与根因归类

### A. 文件缺失类（可通过最小补齐解决）

- `projects-ref/openclaw/scripts/qa-lab-up.ts` 缺失。
- `Dockerfile` 与 pnpm 清单缺失。
- `scripts/` 构建脚本缺失导致 `build:docker` 失败。
- `packages/plugin-sdk` 相关内容缺失导致 unresolved import。
- `extensions/telegram` 入口缺失导致 unresolved entry。
- `tool-display.json` 缺失导致 `pnpm ui:build` 失败。

### B. 构建环境类（与文件补齐无关）

- `.dockerignore` 缺失，导致构建上下文错误包含大体积目录（如 `node_modules`、`dist`），构建传输过重、时间过长。
- Docker build cache 与镜像累积导致磁盘压力与构建不稳定。

### C. 配置告警类（非本次阻断主因）

- `~/.openclaw/openclaw.json` 中存在校验告警（`messages.tts.providers`、`channels.discord.streaming`），但不是本次 `qa up` 构建失败的直接根因。

## 运维结论（关于空间与清理）

本轮排查显示：空间问题与 Docker 构建高度相关，但不是唯一来源。

主要占用来源曾包括：

- Docker images/build cache。
- `/var/log/journal` 历史日志。
- `~/.npm` 缓存、`/tmp` 临时文件。

后续运维约束已明确：

- 保留 `~/.npm`、`~/.nvm`、`~/.openclaw`。
- 允许清理 `/tmp` 与 Docker 可回收缓存。

## 推荐后续方案

1. 远程环境优先使用预构建镜像模式，减少在线 build：
   - `openclaw qa up --use-prebuilt-image --image <tag> --skip-ui-build`
2. 使用明确版本 tag（如 `v2026.4.10` 对应镜像 tag），避免 `main` 与 tag 来回切换导致镜像语义漂移。
3. 保持 `.dockerignore` 完整，防止构建上下文失控。
4. 将“QA 专用镜像构建”前移到开发机/CI，远程仅 pull/load 与运行。

## 相关文档

- `docs/archive/analysis/RESEARCH_OPENCLAW_QA_LAB_REMOTE_STATUS_2026-04-11.md`
- `docs/CLAWLENS_REMOTE_DEPLOYMENT.md`
- `docs/archive/history/CLAWLENS_REMOTE_DEPLOYMENT_HISTORY.md`
