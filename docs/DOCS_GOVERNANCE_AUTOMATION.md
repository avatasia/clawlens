# ClawLens Local Automation

本文件说明 `clawlens` 仓库内本地自动检查命令（docs 治理 + 开发门禁）的使用方式。

## 命令清单（Docs）

1. `node scripts/check-docs-governance.mjs`
   默认模式。检查当前 `git staged` 的 `docs/**/*.md` 改动。
2. `node scripts/check-docs-governance.mjs --all`
   全量模式。扫描整个 `docs/` 目录（适合周期性治理清理）。
3. `node scripts/check-docs-governance.mjs --all --strict`
   全量严格模式。双向索引一致性检查始终执行；`--strict` 将不一致项从警告提升为失败。
4. `bash scripts/install-git-hooks.sh`
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

始终执行（所有模式）：

- `docs/` 顶层 markdown 文件名不得带日期。
- `docs/archive/history/README.md` 必须覆盖所有 `*_HISTORY.md`。
- `docs/plans/README.md`、`docs/research/README.md`、`docs/prompts/README.md` 必须覆盖各自目录下所有 `.md` 文件。
- `DOC_INDEX/ROLLBACK_INDEX/CODE_INDEX` 双向索引一致性（默认 warn，`--strict` fail）。
- 若配置 `entry_points:`，执行 warn 级别符号存在性提示（不阻断）。

仅对目标文件执行（默认 staged，`--all` 全量）：

- 目标 markdown 文件中的相对链接必须可解析（自动跳过 fenced code block 内容）。
- 目标 markdown 文件中不得出现仓库绝对路径。

仅 `--all` 模式额外执行：

- `README.md` 完整性：所有 `docs/` 顶层 `.md` 应被根 `README.md` 列出（warn 级别）。
- 带日期文件 TYPE 前缀合规：首单词必须属于治理规则允许列表（warn 级别）。

## 已知未自动化的治理规则

以下规则依赖人工纪律或审计提示词覆盖，脚本无法自动检查：

- 归档分类正确性（文件是否在正确的 archive 子目录）。
- 每主题仅保留一个顶层主文档。
- 归档操作原子性（移动 + 链接修复 + history 登记应在同一提交）。
- 文档内容与代码的技术一致性。
- 跨文档口径冲突。

以下规则已实现自动 warn 级别检查（2026-04-11 起）：

- Backtick 路径引用时效性：inline code 中匹配已知目录前缀的文件路径存在性检查。
- Link text/target basename mismatch：当链接文本看起来像文件名时，校验其 basename 与 target 的 basename 是否一致。

定期执行 `docs/PROMPT_DOCS_AUDIT.md` 或全局验证提示词可覆盖上述维度。

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
