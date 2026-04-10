# ClawLens Local Automation

本文件说明 `clawlens` 仓库内本地自动检查命令（docs 治理 + 开发门禁）的使用方式。

## 命令清单（Docs）

1. `node scripts/check-docs-governance.mjs`
   默认模式。检查当前 `git staged` 的 `docs/**/*.md` 改动。
2. `node scripts/check-docs-governance.mjs --all`
   全量模式。扫描整个 `docs/` 目录（适合周期性治理清理）。
3. `bash scripts/install-git-hooks.sh`
   安装本地 `pre-commit` / `pre-push` 自动检查钩子。

## 命令清单（Development Gates）

1. `bash scripts/stable-gate.sh`
   执行 `stable` 门禁：docs 检查 + manifest 检查 + 插件测试。
2. `bash scripts/forward-compat.sh soft`
   执行 `forward` 兼容检查（soft 模式：无 `openclaw` CLI 时跳过）。
3. `bash scripts/forward-compat.sh strict`
   执行严格 `forward` 兼容检查（缺 CLI 或 inspect 失败即失败）。
4. `bash scripts/forward-compat.sh soft --use-local-ref --openclaw-bin <path>`
   在 mode 参数后可追加可选 flags，扩展本地兼容校验能力。

## 默认检查项（Docs）

- `docs/` 顶层 markdown 文件名不得带日期。
- `docs/archive/history/README.md` 必须覆盖所有 `*_HISTORY.md`。
- 目标 markdown 文件中的相对链接必须可解析。
- 目标 markdown 文件中不得出现仓库绝对路径。
- 默认模式只检查 `staged` 文档改动；全量治理请使用 `--all`。

## 默认检查项（Development Gates）

- `stable-gate`：
  - `node scripts/check-docs-governance.mjs`
  - `node scripts/check-clawlens-manifest.mjs`
  - `pnpm test`（`extensions/clawlens/`）
- `forward-compat`：
  - `node scripts/check-clawlens-manifest.mjs`
  - `openclaw plugins inspect clawlens`（soft/strict 模式行为不同）
  - `--use-local-ref`：增加本地引用校验，检查 `openclaw/plugin-sdk/*` 是否可在 `projects-ref/openclaw/src/plugin-sdk/` 解析。
  - `--openclaw-bin <path>`：使用指定 CLI 路径执行 `plugins inspect`，不再依赖 PATH 查找。
  - 注：测试对象是当前已安装的 `openclaw` CLI，不强制验证 `main` 版本。

## 推荐用法

日常开发：

```bash
node scripts/check-docs-governance.mjs
```

首次启用自动守规：

```bash
bash scripts/install-git-hooks.sh
```

周期性审计：

```bash
node scripts/check-docs-governance.mjs --all
```

本地发布前：

```bash
bash scripts/stable-gate.sh
bash scripts/forward-compat.sh soft
```

## 失败处理

1. 若默认模式失败，先修复当前 staged 文件中的坏链或路径问题。
2. 若全量模式失败，通常是历史归档文档遗留问题；可按批次治理，不阻塞当前功能开发。
3. 若 `stable-gate` 的测试受本地环境限制，可临时使用 `CLAWLENS_GATE_SKIP_TESTS=1 bash scripts/stable-gate.sh`，但不应作为发布前最终结果。
4. 需要临时绕过本地钩子时，可使用 `git commit --no-verify` / `git push --no-verify`，但建议仅用于紧急情况。

## 相关文件

- [GOVERNANCE_DOCS_PLAN.md](GOVERNANCE_DOCS_PLAN.md)
- [scripts/check-docs-governance.mjs](../scripts/check-docs-governance.mjs)
- [scripts/check-clawlens-manifest.mjs](../scripts/check-clawlens-manifest.mjs)
- [scripts/stable-gate.sh](../scripts/stable-gate.sh)
- [scripts/forward-compat.sh](../scripts/forward-compat.sh)
- [scripts/install-git-hooks.sh](../scripts/install-git-hooks.sh)
