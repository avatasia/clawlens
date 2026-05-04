# AGENTS.md

本文件记录本仓库内代理执行编辑类任务时必须遵守的本地规则。

## 文档编辑规则

1. 如果用户明确要求“保存为新的文档”“新建版本文件”“不要覆盖原文件”，禁止修改原文件，只能新建文件。
2. 如果目标文档存在未提交改动，默认视为用户工作副本，禁止原位大改。
3. 如果目标文档可明确判定为代理在本轮会话中刚新建的产物，且后续修改仍发生在同一轮会话内、无迹象表明已被用户或其他工具接手编辑，则可直接在该新文件上继续更新；除非用户再次明确要求“另存新文件”。
4. 对文档进行结构性重写前，若确需修改原文件，必须先创建本地备份副本。
5. 对未提交文件发生误改后，不要默认建议使用 git 恢复；优先考虑编辑器本地历史、备份文件、系统快照。

## 输出文件规则

1. 审查、复核、回归验证类产物，优先写入新的带日期或版本号文件。
2. 若用户没有指定文件名，但明确要求“新文件”，默认使用原文件名加日期后缀。

## Docs 治理自动规则

凡是输出、修改、归档目标位于 `docs/` 目录下，默认自动遵照：

- `docs/GOVERNANCE_DOCS_PLAN.md`

执行，不需要用户每次重复说明。

具体包括：

1. 自动判断目标应位于：
   - `docs/` 顶层
   - `docs/prompts/`
   - `docs/archive/<分类>/`
2. 自动遵守文档命名规则。
3. 如果执行归档，自动同步：
   - 修复引用路径
   - 更新对应 `history`
4. 自动避免在 `docs/` 体系中写入本项目文件绝对路径；
   项目内引用统一使用仓库相对路径。
5. 若当前 `docs/` 现状与治理规则冲突，默认以 `docs/GOVERNANCE_DOCS_PLAN.md` 为准。

## 操作前检查

执行任何可能覆盖用户内容的编辑前，先确认：

1. 目标文件是否已有未提交改动。
2. 用户要求是“修改原文件”还是“生成新文件”。
3. 是否已存在可安全承载结果的新文件路径。
4. 若准备直接更新一个新文件，是否有充分证据表明该文件就是本轮会话由代理创建并持续维护的文件。

## 项目启动提示词

新代理接手本仓库时，先使用以下启动提示词建立上下文：

```text
你正在 /home/chlli/github/clawlens 仓库中工作。先把自己当作 ClawLens 项目的维护型工程代理，而不是只执行单点命令的脚本。

项目定位：
- ClawLens 是 OpenClaw 的审计插件，核心目标是给 Chat 侧提供 run-level 可观测性。
- 主代码在 extensions/clawlens/，入口为 index.ts，核心模块包括 src/collector.ts、src/store.ts、src/api-routes.ts、src/sse-manager.ts、src/logger-import.ts、src/logger-message-mapper.ts，以及 ui/inject.js、ui/styles.css。
- 本插件通过 OpenClaw runtime/hooks 采集 agent lifecycle、transcript、llm_input、llm_output、after_tool_call、agent_end 等事件，写入 SQLite store，并通过 API/SSE 给 Chat-side Audit UI 使用。
- projects-ref/openclaw/ 是本地 OpenClaw 参考 checkout，用于理解上游接口和兼容性，不是运行时依赖。

开始工作前：
1. 先读 AGENTS.md、README.md、docs/README.md、docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md，以及本次任务直接相关的代码或文档。
2. 先执行 git status --short，识别未提交改动；默认把已有未提交改动视为用户工作副本，不要覆盖或回滚。
3. 如果任务涉及 docs/，自动遵守 docs/GOVERNANCE_DOCS_PLAN.md：判断目标目录、命名、frontmatter、README 覆盖、history 更新和引用路径修复。
4. 如果任务涉及 OpenClaw 兼容性，优先查看 projects-ref/openclaw/ 与 docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md 中的 main-first 基线和 forward-compat/stable-gate 约束。

常用验证：
- 插件目录内：cd extensions/clawlens && npm run typecheck
- 插件测试：cd extensions/clawlens && npm test
- 稳定门禁：bash scripts/stable-gate.sh
- 前向兼容：bash scripts/forward-compat.sh soft 或 bash scripts/forward-compat.sh strict --use-local-ref
- 文档治理：node scripts/check-docs-governance.mjs
- manifest 检查：node scripts/check-clawlens-manifest.mjs

开发约束：
- 优先沿用现有 TypeScript/ESM 风格和本地 helper，不新增不必要抽象。
- 高风险逻辑要维护 DOC_INDEX / ROLLBACK_INDEX 与文档端 CODE_INDEX 的双向索引。
- 文档中引用仓库内文件时使用仓库相对路径，不写本机绝对路径。
- 做结构性文档重写前，如果必须改原文件，先创建本地备份；如果用户要求新文件或不覆盖原文件，只能新建文件。
- 回答时说明读到的上下文、改了哪些文件、做了哪些验证；如果某项验证因依赖或环境缺失无法执行，要明确说明。
```
