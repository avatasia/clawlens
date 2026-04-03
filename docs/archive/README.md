# Docs Archive

本目录用于存放**历史材料**，而不是当前主入口文档。

归档的目的不是删除价值，而是把：

- 当前仍在使用的主文档
- 某一轮分析/复核/修复过程中产生的中间稿

明确分开，避免后续阅读者把旧稿误当成“当前真相源”。

主题历史索引请优先看：

- [archive/history/README.md](history/README.md)

## 何时应该看 archive

以下场景适合先查归档文档：

- 需要追溯某一轮分析/修复当时的判断过程
- 需要对比旧口径与新口径是如何变化的
- 需要复用某次提示词、远程部署提示、专项排障记录
- 需要查看被新版本替代的旧审查稿

## 何时不应该优先看 archive

以下场景不要先从 archive 开始：

- 你想了解当前架构
- 你想了解当前实现状态
- 你想看当前剩余工作主线
- 你想找当前版本可执行的实施方案

这类需求应先看 `docs/` 顶层当前主文档。

## 目录说明

### `reviews/`

存放被新版本替代的旧复核稿、旧审查稿。

典型内容：

- 旧版架构复核
- 旧版 hook 分析
- 旧版 plugin guideline review
- 旧版参考项目复核

用途：

- 回溯当时的技术判断
- 对比新旧结论差异

### `analysis/`

存放过程性分析稿、中间稿、阶段性复盘稿。

典型内容：

- 原始分析记录
- 架构演进中间稿
- postmortem
- rectification 类过程文档

用途：

- 看“当时是怎么想的”
- 不适合作为当前架构入口

### `prompts/`

存放阶段性提示词、迁移提示、远程部署提示、旧实现提示。

典型内容：

- 旧 implementation prompt 版本
- 远程部署/远程修订提示词
- 旧 review prompt
- Claude/Codex 生成提示词中间稿

其中有些文件属于同一条提示词链，应成组理解，而不是拆开单看。

例如：

- [IMPLEMENTATION_PROMPT_REMOTE_REVISED_2026-04-02.md](prompts/IMPLEMENTATION_PROMPT_REMOTE_REVISED_2026-04-02.md)
- [IMPLEMENTATION_PROMPT_REMOTE_UPDATE_PROMPT_2026-04-02.md](prompts/IMPLEMENTATION_PROMPT_REMOTE_UPDATE_PROMPT_2026-04-02.md)

这两个文件属于同一个 remote prompt chain：

- 前者是远程部署/测试章节的修订结果稿
- 后者是用于推动 `PROMPT_IMPLEMENTATION.md` 远程章节修订的提示词

因此它们是同主题成组材料，不应误判为两份互不相关的独立主文档。

用途：

- 复用历史提示词
- 对比提示词演进

### `chat-audit/`

存放 Chat Audit 修复过程中拆分过细的专项分析/专项修复稿。

这些文件通常仍有价值，但粒度太细，不适合继续占据顶层入口位置。

典型内容：

- empty state 专项
- turns detail 专项
- UI 底边/布局专项
- debug log switch 专项
- 单轮 fix summary

用途：

- 查某个具体问题当时怎么定位、怎么修
- 不适合作为“当前 chat audit 总览”

## 使用规则

1. 当前主文档优先放在 `docs/` 顶层。
2. 某轮修复完成后，如果文档只是过程材料，应尽早归档。
3. 如果某份归档文档再次变成当前主入口，不要直接在 archive 里长期维护，应重新提升到 `docs/` 顶层或生成新的主文档。

## 当前应优先阅读的非归档文档

优先看这些，而不是先翻 archive：

- [architecture.md](../architecture.md)
- [PROMPT_IMPLEMENTATION.md](../PROMPT_IMPLEMENTATION.md)
- [ANALYSIS_CHAT_AUDIT.md](../ANALYSIS_CHAT_AUDIT.md)
- [ANALYSIS_CHAT_AUDIT_REMAINING_WORK.md](../ANALYSIS_CHAT_AUDIT_REMAINING_WORK.md)
- [IMPLEMENTATION_CHAT_AUDIT_REMAINING_WORK.md](../IMPLEMENTATION_CHAT_AUDIT_REMAINING_WORK.md)
- [PLAYBOOK_ENGINEERING_LESSONS.md](../PLAYBOOK_ENGINEERING_LESSONS.md)
- [GOVERNANCE_DOCS_PLAN.md](../GOVERNANCE_DOCS_PLAN.md)
