# ClawLens QA Lab Phase2 T1 本地 Docker Lane 验证（2026-04-13）

## 任务

- 任务编号：T1
- 来源：`docs/archive/analysis/IMPLEMENTATION_CLAWLENS_QA_LAB_PHASE2_VALIDATION_TASKS_2026-04-13.md`
- 目标：验证 `qa up` Docker lane 在本地是否可执行。

## 环境

- OpenClaw：`v2026.4.11`
- Docker：`Docker version 29.3.0`
- Docker Compose：`v5.1.1`
- 端口隔离：`gateway=18790`、`qa-lab=43125`
- Docker registry mirror：`https://docker.actima.top/`

## 执行记录

### Case 0: Docker scaffold 产物生成

命令：

```bash
cd projects-ref/openclaw
node dist/entry.js qa docker-scaffold \
  --repo-root . \
  --output-dir .artifacts/qa-docker-manual \
  --qa-lab-port 43125 \
  --gateway-port 18790
```

结果：成功。

产物：

- `.artifacts/qa-docker-manual/docker-compose.qa.yml`
- `.artifacts/qa-docker-manual/state/openclaw.json`
- `.artifacts/qa-docker-manual/README.md`

结论：

- CLI/脚手架层可用，当前阻塞集中在 Docker 镜像供应链（build/pull/image availability）。

### Case 0b: 预检查脚本验证

脚本：

- `scripts/qa-docker-lane-precheck.sh`

执行结果（2026-04-13，首次）：

- `shell_https_proxy = http://192.168.50.190:10808`
- `daemon_proxy_env = <empty>`
- `mirror = ["https://docker.actima.top/"]`
- `image_present = false`（缺 `openclaw:qa-local-prebaked`）
- `qa_network_residual = true`
- `base_pull_ok = false`（`docker pull node:24-bookworm` 超时）
- 推荐：`stay_on_qa_ui_lane`

结论：

- 该脚本可作为 T1 的固定 preflight gate，避免把环境阻塞误判为业务回归失败。
- shell 网络与 Docker daemon 网络路径可能不一致；即使移除 mirror，daemon 仍可能无法直接访问 DockerHub。

### Case 0c: 移除 mirror 后的复测

执行：

- `docker info --format '{{json .RegistryConfig.Mirrors}}'` → `[]`
- `docker pull node:24-bookworm` → 超时
- `docker pull docker/dockerfile:1.7` → 超时
- `qa docker-build-image` 仍失败，错误为：
  - `failed to resolve source metadata for docker.io/docker/dockerfile:1.7`
  - `dial tcp ...:443: i/o timeout`

结论：

- `docker.actima.top` 已不再是当前主阻塞；根因转为 Docker daemon 到 DockerHub 的网络可达性问题（并伴随 shell proxy 与 daemon proxy 配置不一致）。

### Case C: 配置 daemon proxy 后复测（网络链路恢复）

观测：

- `docker login` 成功
- `docker pull node:24-bookworm` 成功
- `docker pull docker/dockerfile:1.7` 成功
- 直接 `docker build -t openclaw:qa-local-prebaked ...` 成功，镜像已生成

结论：

- T1 的“镜像供应链阻塞”已解除。

### Case D: `qa up --use-prebuilt-image` 启动成功，但默认不加载 ClawLens

命令：

```bash
cd projects-ref/openclaw
node dist/entry.js qa up \
  --repo-root . \
  --skip-ui-build \
  --use-prebuilt-image \
  --image openclaw:qa-local-prebaked \
  --qa-lab-port 43125 \
  --gateway-port 18790
```

结果：

- 命令返回成功，并打印：
  - `QA Lab UI: http://127.0.0.1:43125`
  - `Gateway UI: http://127.0.0.1:18790/`
- `docker compose ps` 显示三服务 healthy。
- 但 `curl http://127.0.0.1:18790/plugins/clawlens/api/overview` 返回 `Not Found`。
- `curl http://127.0.0.1:18790/plugins/clawlens/api/sessions?...` 返回 `Not Found`。
- compose 日志显示 gateway `ready (1 plugin: qa-channel; ...)`，未加载 `clawlens`。

结论：

- 当前 `qa up` Docker lane 可用性已恢复（基础 QA stack 可起），
  但尚未满足“ClawLens 联调”目标，因为 Docker lane 默认未加载 ClawLens 插件。

### Case E: Docker lane 的 ClawLens 可执行 workaround（已验证）

在 `qa up` 成功后，执行：

```bash
docker exec qa-docker-openclaw-qa-gateway-1 \
  node dist/index.js plugins install -l /tmp/clawlens
```

说明：

- 该路径依赖 compose 中额外挂载 `extensions/clawlens -> /tmp/clawlens`。
- 安装后可直接访问：
  - `GET /plugins/clawlens/api/overview`
  - `GET /plugins/clawlens/api/sessions`
  - `GET /plugins/clawlens/api/audit/session/<key>`

本轮 smoke 证据：

- session key: `agent:main:explicit:qa-docker-clawlens-smoke`
- `overview`: `totalRuns24h = 1`, `totalTokens24h = 88`
- `sessions` 命中该 session
- `audit/session` 返回 completed run（`runId=d2c9bc99-ff67-4835-90cd-84bb9f199eb4`）

限制：

- 该安装是运行期注入；gateway 重启后会回到 scaffold 配置，需要重新执行安装步骤。

### Case F: Docker lane 自动化脚本（已验证）

新增脚本：

- `scripts/run-clawlens-qa-docker-smoke.sh`

脚本能力：

1. 自动执行 `qa up --use-prebuilt-image`
2. 自动注入 ClawLens（容器内 `plugins install -l /tmp/clawlens`）
3. 轮询等待 ClawLens API 可用
4. 触发 1 条 smoke run
5. 自动核验 `overview/sessions/audit`
6. 输出结构化 JSON（`result=pass/fail`）

本轮实测：

- `result = pass`
- `checks.agentOk = true`
- `checks.sessionPresent = true`
- `checks.auditPresent = true`
- `checks.auditCompleted = true`
- `sessionKey = agent:main:explicit:qa-docker-smoke-1776085516`

### Case A: 预构建镜像模式（`--use-prebuilt-image`）

命令：

```bash
cd projects-ref/openclaw
node dist/entry.js qa up \
  --repo-root . \
  --skip-ui-build \
  --use-prebuilt-image \
  --image openclaw:qa-local-prebaked \
  --qa-lab-port 43125 \
  --gateway-port 18790
```

结果：失败。

关键错误（实测）：

- `No such image: openclaw:qa-local-prebaked`
- 首轮出现残留网络冲突：`network with name qa-docker_default already exists`
- 清理 `docker network rm qa-docker_default` 后复测，冲突消失，稳定回到“镜像缺失”单一错误

结论：

- 预构建镜像模式可执行前提是本地必须先有目标镜像（build/pull/load 任一方式）。
- 失败重试前建议先清理残留 `qa-docker_default` 网络或旧容器，避免误判。

### Case B: 默认 build 模式（`up --build -d`）

命令：

```bash
cd projects-ref/openclaw
node dist/entry.js qa up \
  --repo-root . \
  --skip-ui-build \
  --qa-lab-port 43125 \
  --gateway-port 18790
```

结果：失败。

关键错误（最新复测）：

- 先触发 image 缺失（同 Case A）：`No such image: openclaw:qa-local-prebaked`
- 直接执行 `qa docker-build-image` 时，卡在 Dockerfile syntax frontend 拉取阶段：
  - `failed to fetch anonymous token`
  - `Get "https://docker.actima.top/token?...": net/http: TLS handshake timeout`
- 独立验证 `docker pull node:24-bookworm` 也失败：
  - `context deadline exceeded (Client.Timeout exceeded while awaiting headers)`

结论：

- 当前阻塞主因是 Docker registry/mirror 网络可达性，而非 OpenClaw `qa up` 参数或 compose 结构本身。

## 当前判定

- T1 状态：`completed`
- 主阻断项：
  - 无（本地范围内已闭环；当前通过自动化脚本保障可执行性）

## 建议下一步

1. 增加验收门槛：
   - `healthz` 成功不算通过，必须验证 `plugins/clawlens/api/overview` 返回 JSON。
2. 在 SOP 中保留 `qa ui + 复用 gateway` 作为默认主流程，Docker lane 作为扩展路径。

## 是否纳入主 SOP

已纳入 SOP 作为辅助扩展路径（非默认 lane）。

说明：

- Docker lane 已通过自动化脚本验证（`scripts/run-clawlens-qa-docker-smoke.sh`），可作为扩展路径写入 SOP。
- 默认主流程仍为 `qa ui + 复用 gateway`，Docker lane 在 SOP 中作为 “Docker lane 预检查（草案）” 附加章节。
- 进入 Docker lane 前必须先通过 `scripts/qa-docker-lane-precheck.sh`。
