---
status: active
created: 2026-04-13
updated: 2026-04-13
---

# OpenClaw QA Remote NPM Enablement Draft

## 适用范围

- 目标：在远端 `npm global` 安装形态下，最小恢复 `openclaw qa` 的可用面。
- 本草案只覆盖：
  - `openclaw qa --help`
  - `openclaw qa run`
  - `openclaw qa ui`
- 本草案明确不覆盖：
  - `openclaw qa up`
  - 基于 `Dockerfile` 的 build lane
  - 远端源码仓库部署

## 背景结论

- 远端 `npm global` 安装包默认不带 `qa-lab` 的 public CLI facade。
- 远端 `npm global` 安装包默认不带 QA Lab 前端静态资源。
- 因此，直接执行 `openclaw qa` 时，通常会缺：
  - CLI facade
  - UI static bundle

证据来源：

- `docs/archive/analysis/RESEARCH_CLAWLENS_QA_LAB_PHASE2_T2_REMOTE_LIVE_STATUS_2026-04-13.md`

## 前置条件

- 本地已具备源码仓库：`projects-ref/openclaw`
- 本地已完成：

```bash
cd projects-ref/openclaw
node scripts/tsdown-build.mjs --no-clean
pnpm qa:lab:build
```

- 远端已存在 OpenClaw npm 安装目录：
  - 例如：`~/.nvm/versions/node/v24.14.0/lib/node_modules/openclaw/`
- 远端 SSH 可达
- 远端不要求额外复制整套源码

## 最小缺失文件面

只同步以下 5 个文件：

1. `projects-ref/openclaw/dist/extensions/qa-lab/cli.js`
2. `projects-ref/openclaw/dist/extensions/qa-channel/api.js`
3. `projects-ref/openclaw/extensions/qa-lab/web/dist/index.html`
4. `projects-ref/openclaw/extensions/qa-lab/web/dist/assets/index-BnfVyI_0.css`
5. `projects-ref/openclaw/extensions/qa-lab/web/dist/assets/index-CWXEhULX.js`

对应远端目标位置：

1. `<remote-install-root>/dist/extensions/qa-lab/cli.js`
2. `<remote-install-root>/dist/extensions/qa-channel/api.js`
3. `<remote-install-root>/dist/extensions/qa-lab/web/dist/index.html`
4. `<remote-install-root>/dist/extensions/qa-lab/web/dist/assets/index-BnfVyI_0.css`
5. `<remote-install-root>/dist/extensions/qa-lab/web/dist/assets/index-CWXEhULX.js`

## 推荐同步步骤

假设：

- 本地工作目录位于本仓库根目录
- 远端主机别名为 `<remote-host>`
- 远端安装目录为 `<remote-install-root>`

`szhdy` 当前建议固定变量：

```bash
OPENCLAW_BIN=/home/openclaw/.nvm/versions/node/v24.14.0/bin/openclaw
```

先创建远端目标目录：

```bash
ssh <remote-host> "mkdir -p \
  <remote-install-root>/dist/extensions/qa-lab \
  <remote-install-root>/dist/extensions/qa-channel \
  <remote-install-root>/dist/extensions/qa-lab/web/dist/assets"
```

再同步 5 个文件：

```bash
rsync -avz projects-ref/openclaw/dist/extensions/qa-lab/cli.js \
  <remote-host>:<remote-install-root>/dist/extensions/qa-lab/cli.js

rsync -avz projects-ref/openclaw/dist/extensions/qa-channel/api.js \
  <remote-host>:<remote-install-root>/dist/extensions/qa-channel/api.js

rsync -avz projects-ref/openclaw/extensions/qa-lab/web/dist/index.html \
  <remote-host>:<remote-install-root>/dist/extensions/qa-lab/web/dist/index.html

rsync -avz projects-ref/openclaw/extensions/qa-lab/web/dist/assets/index-BnfVyI_0.css \
  <remote-host>:<remote-install-root>/dist/extensions/qa-lab/web/dist/assets/index-BnfVyI_0.css

rsync -avz projects-ref/openclaw/extensions/qa-lab/web/dist/assets/index-CWXEhULX.js \
  <remote-host>:<remote-install-root>/dist/extensions/qa-lab/web/dist/assets/index-CWXEhULX.js
```

## 验证步骤

## 1. 验证 CLI surface

```bash
$OPENCLAW_BIN qa --help
$OPENCLAW_BIN qa ui --help
$OPENCLAW_BIN qa up --help
```

成功判据：

- 三条命令都能正常输出帮助，而不是报 `plugins.allow excludes "qa"` 或模块缺失错误。

## 2. 验证 self-check

```bash
cd <remote-install-root>
$OPENCLAW_BIN qa run --repo-root . --output /tmp/openclaw-qa-selfcheck.md
```

成功判据：

- 成功生成 Markdown 报告
- 报告中 `Passed` 大于 0

## 3. 验证 QA UI

```bash
cd <remote-install-root>
$OPENCLAW_BIN qa ui --repo-root . --host 127.0.0.1 --port 43124
```

成功判据：

- 前台输出 `QA Lab UI: http://127.0.0.1:43124`
- `curl http://127.0.0.1:43124/api/bootstrap` 返回 JSON
- 浏览器访问 `http://127.0.0.1:43124/` 时，不再出现 `QA Lab UI not built`

## 不要做的事

- 不要为此复制整套 `openclaw` 源码到远端 npm 安装目录。
- 不要把这套 workaround 当成 `qa up` 可用的证据。
- 不要把临时 `plugins.allow += qa` 当成根因修复；它只会带来 stale config 告警。

## 当前边界

- 这套最小补齐只解决 `qa` CLI facade 与 `qa ui` 静态资源缺失问题。
- 它不能解决 `qa up` 的两个更深 blocker：
  - build 模式：远端 npm 安装目录缺 `Dockerfile`
  - prebuilt 模式：即便远端已有候选镜像，gateway 仍可能因内存不足被 OOM kill

## 验收结论写法

若本草案执行成功，建议在验收中明确写成：

- “远端 npm 安装形态下，`qa --help` / `qa run` / `qa ui` 已恢复。”
- “`qa up` 仍不在该草案范围内，需单独满足镜像与内存前置条件。”
