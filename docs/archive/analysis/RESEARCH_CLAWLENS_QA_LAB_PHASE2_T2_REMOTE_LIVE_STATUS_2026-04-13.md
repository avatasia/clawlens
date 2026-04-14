---
status: active
created: 2026-04-13
updated: 2026-04-13
---

# ClawLens QA Lab Phase 2 - T2 远程链路实时状态（2026-04-13）

## 目标

在既有远程研究基础上，复核当前远程环境的实时状态，确认 T2 的最新阻断点是否仍是“缺文件/打包链路”，还是已经切换成新的配置层问题。

## 实时发现

### 1. 远端版本已变化

本轮通过远端绝对路径执行：

```bash
/home/openclaw/.nvm/versions/node/v24.14.0/bin/openclaw --version
```

结果：

- `OpenClaw 2026.4.11 (769908e)`

结论：

- 当前远端已不是旧研究中的 `2026.4.10` 基线。
- 旧结论不能直接当作“当前阻断”继续沿用。

### 2. 远端非交互 SSH 不满足文档中的 PATH 假设

本轮通过：

```bash
ssh szhdy 'bash -lc "source ~/.bashrc && echo PATH=$PATH && which node || true && which pnpm || true && which openclaw || true"'
```

结果（摘要）：

- PATH 仅为系统默认：`/usr/local/bin:/usr/bin:/bin:/usr/games`
- 只有 `/usr/bin/node`
- `pnpm` / `openclaw` 未进入 PATH

结论：

- 当前 `docs/CLAWLENS_REMOTE_DEPLOYMENT.md` 中“`source ~/.bashrc` 后即可直接使用 `openclaw` / `pnpm`”的 SSH 模板已经失效。
- 远端排障和自动化脚本应优先使用绝对路径，至少在当前机器上如此。

### 3. `openclaw qa` 的第一层阻断是 `plugins.allow`

使用绝对路径执行：

```bash
/home/openclaw/.nvm/versions/node/v24.14.0/bin/openclaw qa --help
```

结果（摘要）：

- CLI 启动失败
- 错误信息明确指出：
  - `plugins.allow` excludes `"qa"`
  - 如需该 CLI surface，需将 `"qa"` 加入 `plugins.allow`

结论：

- 当前阻断不是“qa 目录缺失”或“qa-lab 文件没打包”。
- 至少在 `2026.4.11` 远端当前安装态下，最前置阻断是配置 allowlist。

### 4. 远端 `plugins.allow` 确实未包含 `qa`

读取远端 `~/.openclaw/openclaw.json` 的 `plugins.allow` 后确认：

- allowlist 包含 `google`、`discord`、`wecom`、`minimax`、`clawlens` 等
- 不包含 `qa`

结论：

- CLI 报错与当前配置一致，属于可直接解释的真实阻断。

### 5. 已做最小试探：临时加入 `qa` 后，问题继续下钻

本轮做过一次最小配置试探：

- 先备份远端 `~/.openclaw/openclaw.json`
- 临时将 `"qa"` 加入 `plugins.allow`
- 复测 `openclaw qa --help`

结果（摘要）：

- 配置校验警告把 `qa` 视为 `plugin not found: qa (stale config entry ignored)`
- `openclaw qa --help` 没有进入预期 QA 子命令帮助
- 临时变更已在验证后回滚，当前远端 `plugins.allow` 已恢复原状

结论：

- 这不是单纯的 allowlist 缺项问题。
- 继续把 `qa` 写进生产配置没有价值，且会制造 stale config 告警。

### 6. 远端 npm 安装包缺失 `qa-lab` public CLI surface

本轮对比：

- 本地源码构建产物存在：
  - `dist/extensions/qa-lab/cli.js`
  - `dist/extensions/qa-lab/api.js`
  - `dist/extensions/qa-lab/index.js`
- 远端 npm 安装目录仅存在：
  - `dist/extensions/qa-lab/runtime-api.js`

同时，上游发布策略明确排除了私有 QA 产物进入公开 npm 包：

- `package.json` 中：
  - `!dist/extensions/qa-lab/**`
  - 仅保留 `dist/extensions/qa-lab/runtime-api.js`
- `test/openclaw-npm-release-check.test.ts` 明确校验：
  - `dist/extensions/qa-lab/src/cli.js` 属于 forbidden packed path

结论：

- 当前远端 global npm 安装形态下，`qa-lab` 的 public CLI facade 不会随包发布。
- 因此远端想直接使用 `openclaw qa`，与当前上游 npm 发布策略本身冲突。

### 7. 已验证的最小补齐方案：先补 2 个 public surface 文件

本轮未复制整套源码，只补了两个 public surface 文件到远端 npm 安装目录：

1. `dist/extensions/qa-lab/cli.js`
2. `dist/extensions/qa-channel/api.js`

补齐后结果：

- `openclaw qa --help` 恢复正常
- `openclaw qa ui --help` 恢复正常
- `openclaw qa up --help` 恢复正常

进一步实测：

```bash
openclaw qa run --repo-root <install-root> --output /tmp/openclaw-qa-selfcheck-2026-04-13.md
```

结果：

- 成功生成报告：`/tmp/openclaw-qa-selfcheck-2026-04-13.md`
- 报告摘要：
  - `Passed: 2`
  - `Failed: 0`

结论：

- 对于“恢复远端 QA CLI + self-check”这一层，最小补齐方案已被实测证明可行。
- 这也证明真正缺的是少量 private public surface 文件，而不是整个 QA 目录树。

### 8. `qa ui` 后端可启动，但 npm 安装包默认不带前端静态资源

在仅补齐上述 2 个 public surface 文件后，进一步实测：

```bash
openclaw qa ui --repo-root . --port 43131
```

结果：

- 进程可正常启动，并输出：
  - `QA Lab UI: http://127.0.0.1:43131`
- `http://127.0.0.1:43131/api/bootstrap` 返回正常 JSON
- 但 `http://127.0.0.1:43131/` 返回的是内置 fallback HTML：
  - `QA Lab UI not built`
  - `pnpm qa:lab:build`

对应本地代码 `projects-ref/openclaw/extensions/qa-lab/src/lab-server.ts` 可确认：

- `qa ui` 的静态资源查找顺序为：
  1. `extensions/qa-lab/web/dist`
  2. `dist/extensions/qa-lab/web/dist`
  3. 打包后模块相对路径 `../web/dist`
- 若找不到 `index.html`，则服务端返回内置的 “UI not built” fallback 页面

本轮继续做最小补齐，只同步本地已构建好的 3 个前端产物到远端：

1. `dist/extensions/qa-lab/web/dist/index.html`
2. `dist/extensions/qa-lab/web/dist/assets/index-BnfVyI_0.css`
3. `dist/extensions/qa-lab/web/dist/assets/index-CWXEhULX.js`

补齐后结果：

- `http://127.0.0.1:43131/` 返回正常 QA Lab HTML 壳
- `http://127.0.0.1:43131/assets/index-CWXEhULX.js` 返回真实 JS bundle
- 说明 `qa ui` 的后端逻辑并未缺失，缺的是 npm 安装形态下未随包发布的前端静态资源

结论：

- 对远端 global npm 安装形态，恢复 `qa ui` 的最小缺失文件面并不是整套源码，而是：
  1. `dist/extensions/qa-lab/cli.js`
  2. `dist/extensions/qa-channel/api.js`
  3. `dist/extensions/qa-lab/web/dist/index.html`
  4. `dist/extensions/qa-lab/web/dist/assets/index-BnfVyI_0.css`
  5. `dist/extensions/qa-lab/web/dist/assets/index-CWXEhULX.js`
- 其中前 2 个负责恢复 QA CLI surface，后 3 个负责恢复 QA Lab 前端静态资源。

### 9. `qa up` 已重新进入真实运行链路，但仍 blocked

在最小补齐后，远端 `qa up` 已可真正执行到 docker orchestration 层。

#### 路径 A：`--use-prebuilt-image`

命令（摘要）：

```bash
openclaw qa up \
  --repo-root . \
  --use-prebuilt-image \
  --image openclaw:qa-local-prebaked \
  --skip-ui-build \
  --qa-lab-port 43129 \
  --gateway-port 18795 \
  --output-dir .artifacts/qa-up-2026-04-13
```

结果：

- 失败
- 直接 blocker：`No such image: openclaw:qa-local-prebaked`

补充对上游代码的核对：

- 本地代码 `projects-ref/openclaw/extensions/qa-lab/src/docker-harness.ts` 中，
  `docker-build-image` 实际执行的是：
  - `docker build -t <image> --build-arg OPENCLAW_EXTENSIONS=qa-channel qa-lab -f Dockerfile .`

结论：

- `qa up --use-prebuilt-image` 需要的不是任意 `openclaw` 运行镜像，而是包含
  `qa-channel` 与 `qa-lab` 的专用预构建镜像。
- 普通 npm global 安装与普通运行态 gateway 镜像，不能直接替代这个前置条件。

#### 路径 B：默认 build 模式

命令（摘要）：

```bash
openclaw qa up \
  --repo-root . \
  --skip-ui-build \
  --qa-lab-port 43130 \
  --gateway-port 18796 \
  --output-dir .artifacts/qa-up-build-2026-04-13
```

结果：

- 失败
- 直接 blocker：`failed to read dockerfile: open Dockerfile: no such file or directory`

进一步对比生成器与远端产物：

- 本地代码 `projects-ref/openclaw/extensions/qa-lab/src/docker-harness.ts` 明确写死：
  - `build.context = <repoRoot>`
  - `build.dockerfile = Dockerfile`
- 远端失败后生成的 `.artifacts/qa-up-build-2026-04-13/docker-compose.qa.yml` 也确实是：
  - `context: ../..`
  - `dockerfile: Dockerfile`
- 远端 npm 安装目录实测：
  - 有 `dist/index.js`
  - 有 `dist/control-ui`
  - 缺 `Dockerfile`

结论：

- 远端 npm 安装形态下：
  - `qa run` 可通过最小 public surface 补齐恢复
  - `qa ui` 可通过最小 public surface + UI dist 补齐恢复
  - `qa up` 仍被安装形态与镜像前置条件阻断
  - 其中 build 模式的精确根因不是“dist 不全”，而是 npm 安装目录不满足 `Dockerfile + repo root build context` 这一构建假设

### 10. 远端已有候选 prebuilt image，但 gateway 容器在启动后被 OOM kill

本轮继续验证发现，远端 Docker 本地已有 3 个 QA 相关镜像：

- `qa-docker-qa-mock-openai:latest`
- `qa-docker-openclaw-qa-gateway:latest`
- `qa-docker-qa-lab:latest`

据此再次执行：

```bash
openclaw qa up \
  --repo-root . \
  --use-prebuilt-image \
  --image qa-docker-openclaw-qa-gateway:latest \
  --skip-ui-build \
  --qa-lab-port 43132 \
  --gateway-port 18797 \
  --output-dir .artifacts/qa-up-prebuilt-existing-2026-04-13
```

实测过程：

- `qa-mock-openai` 变为 `healthy`
- `qa-lab` 变为 `healthy`
- `openclaw-qa-gateway` 成功拉起并打印：
  - `loading configuration…`
  - `resolving authentication…`
  - `starting HTTP server...`
  - `MCP loopback server listening on http://127.0.0.1:39443/mcp`
  - `heartbeat started`

随后容器退出，状态为：

- `Exited (137)`
- `docker inspect` 明确：
  - `OOMKilled=true`
  - `ExitCode=137`

同时远端宿主机资源快照显示：

- 总内存约 `3.8GiB`
- 无 swap
- 当时空闲内存约 `704MiB`

结论：

- prebuilt-image 模式的 blocker 已不再是 “No such image”，因为远端已有可复用的候选镜像。
- 当前更深一层的 blocker 是：在远端这台约 4 GiB、无 swap 的主机上，
  `openclaw-qa-gateway` 容器启动后被 OOM kill。
- 因此，T2 现阶段的真实状态是：
  - `qa --help` / `qa run` / `qa ui` 可通过最小补齐恢复
  - `qa up` 的 build 模式被安装形态阻断
  - `qa up` 的 prebuilt 模式已可启动到 gateway 阶段，但被内存上限阻断

### 11. 工具链来源复核：默认 PATH 仍会命中系统 `/usr/bin`，必须固定到 nvm

本轮补充核对远端二进制来源：

```bash
ssh szhdy 'bash -lc "command -v node; command -v npm; command -v pnpm; command -v openclaw"'
```

结果（摘要）：

- 默认 PATH 下：
  - `node` -> `/usr/bin/node`（`v24.13.0`）
  - `npm` -> `/usr/bin/npm`（`11.6.2`）
  - `pnpm` / `openclaw` 不在默认 PATH

同时核对 nvm 路径：

```bash
/home/openclaw/.nvm/versions/node/v24.14.0/bin/node -v
/home/openclaw/.nvm/versions/node/v24.14.0/bin/npm -v
/home/openclaw/.nvm/versions/node/v24.14.0/bin/pnpm -v
/home/openclaw/.nvm/versions/node/v24.14.0/bin/openclaw --version
```

结果（摘要）：

- nvm 工具链版本：
  - `node v24.14.0`
  - `npm 11.9.0`
  - `pnpm 10.33.0`
  - `OpenClaw 2026.4.11`

结论：

- 在 `szhdy` 上，远端命令必须显式固定 nvm 工具链（绝对路径或显式导出 nvm PATH）。
- 仅依赖默认 PATH 会落到系统 `node/npm`，存在版本与行为漂移风险。

### 12. `qa up` prebuilt 再次复测：从“立即 OOM”变为“gateway unhealthy 超时”

本轮在清理残留 `openclaw-qa` 进程后，再次复测 prebuilt lane：

```bash
openclaw qa up \
  --repo-root . \
  --use-prebuilt-image \
  --image qa-docker-openclaw-qa-gateway:latest \
  --skip-ui-build \
  --qa-lab-port 43133 \
  --gateway-port 18798 \
  --output-dir .artifacts/qa-up-prebuilt-after-qa-kill-2026-04-13
```

结果（摘要）：

- 命令最终失败：
  - `openclaw-qa-gateway did not become healthy within 367s (limit 360s)`
- 失败形态与上一轮不同（上一轮是 `OOMKilled=true`），说明该 lane 在当前机器资源压力下存在不稳定性。

结论：

- 该机器上 prebuilt lane 目前仍不可作为稳定可执行路径。
- 当前阻断应表述为：
  - prebuilt lane 在资源受限机器上表现不稳定（`OOMKilled` 或长期 `unhealthy` 超时）。

## 与本地代码的对应证据

本地上游代码 `projects-ref/openclaw/src/cli/run-main.ts` 明确实现了：

- 当 `plugins.allow` 存在且不包含目标 bundled plugin id 时
- CLI 返回：
  - `The openclaw <cmd> command is unavailable because plugins.allow excludes "<pluginId>"`

这与远端实际报错完全一致。

同时，本地 CLI 注册逻辑显示：

- `qa` 根命令由 `src/plugin-sdk/qa-lab.ts` 提供
- 该 facade 依赖 `@openclaw/qa-lab/cli.js`
- 若该 public surface 不可解析，则 `qa` CLI surface 不应可用

## 当前判定

T2 状态：`blocked`

当前最新阻断链如下：

1. 远端 SSH 非交互 shell 无法依赖 `~/.bashrc` 提供 nvm PATH
2. `openclaw qa --help` 的第一层报错体现为 `plugins.allow` 排除 `qa`
3. allowlist 不是最终根因；远端 npm 安装包缺少 `qa-lab/cli.js` 与 `qa-channel/api.js`
4. 补齐 `dist/extensions/qa-lab/cli.js` 与 `dist/extensions/qa-channel/api.js` 后，`qa` CLI 与 `qa run` 可以恢复
5. 再补齐 `dist/extensions/qa-lab/web/dist` 的 3 个静态文件后，`qa ui` 也可以恢复
6. `qa up` 的 build 模式仍卡在：
   - npm 安装目录缺少 `Dockerfile`
7. `qa up` 的 prebuilt-image 模式已可推进到容器启动，但在当前远端机器上仍不稳定：
   - 可能出现 `OOMKilled=true`
   - 或出现 gateway 长时间 `unhealthy` 后超时

## 本轮执行与回滚

本轮已执行过的最小试探：

- 已备份远端 `openclaw.json`
- 已临时将 `qa` 写入 `plugins.allow`
- 已复测 `openclaw qa --help`
- 已将该临时 allowlist 变更回滚
- 已最小补齐 2 个 public surface 文件
- 已最小补齐 3 个 QA Lab UI 静态资源文件
- 已实测 `qa run` 成功
- 已实测 `qa ui` 后端可起，且补齐静态资源后首页恢复
- 已实测 `qa up` 的 prebuilt-image 与 build 两条路径失败点
- 已实测复用远端现有 prebuilt image 后，gateway 容器 OOMKilled=true
- 已实测再次复测 prebuilt lane 时，gateway 在 360s 窗口内持续 `unhealthy` 并超时

本轮仍未执行：

- 未重启远端 gateway
- 未继续推进远端 `qa up`

原因：

- 配置层问题已排除；当前主要是安装形态与镜像前置条件问题。

## 最小下一步

若继续推进 T2，最小验证动作应为：

1. 不再尝试仅靠远端 `plugins.allow` 修复
2. 若只需恢复远端 `qa --help` / `qa run` / `qa ui`，直接采用：
   - `docs/archive/analysis/IMPLEMENTATION_OPENCLAW_QA_REMOTE_NPM_ENABLEMENT_DRAFT_2026-04-13.md`
3. 选择以下三类方案之一：
   - 方案 A：继续保留 npm 安装形态，但只把“5 文件最小补齐”固化为临时 enablement 手册，明确其只能恢复 `qa --help` / `qa run` / `qa ui`
   - 方案 B：若必须远端跑 `qa up`，则改用更高内存主机或为当前主机补 swap，再复测现有 prebuilt image
   - 方案 C：改用源码仓库/完整构建产物运行 `qa up`，避免 npm 安装形态的 `Dockerfile` 构建约束
4. 若坚持 npm 安装形态且坚持 `qa up`，当前最现实路径是：
   - 保留已补齐的 2 个 public surface 文件
   - 预置 QA 镜像
   - 避免走远端 build 模式

## 对文档的直接影响

1. `docs/CLAWLENS_REMOTE_DEPLOYMENT.md` 中 SSH 模板需要补充“当前机器必须使用绝对路径”的限制说明。
2. T2 的 blocker 应更新为“远端 npm 安装包对 `qa run` 可通过最小补齐恢复，但 `qa up` 仍受镜像/构建输入缺失阻断”。
