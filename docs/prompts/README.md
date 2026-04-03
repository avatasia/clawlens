# Prompts

本目录存放**当前仍在使用的提示词分支文档**，不存放历史提示词归档。

顶层主索引仍是：

- [PLAYBOOK_ANALYSIS_PROMPT.md](../PLAYBOOK_ANALYSIS_PROMPT.md)

这里的文件用于把主索引拆成更具体的使用场景，减少顶层目录噪音，同时保留可直接复用的分支提示词。

## 当前分支

- [ANALYSIS_PROMPT_PLAYBOOK_GENERAL.md](ANALYSIS_PROMPT_PLAYBOOK_GENERAL.md)
  通用分析阶段提示词。
- [ANALYSIS_PROMPT_PLAYBOOK_DOC_REVIEW.md](ANALYSIS_PROMPT_PLAYBOOK_DOC_REVIEW.md)
  文档审查与复核场景提示词。
- [ANALYSIS_PROMPT_PLAYBOOK_DEBUG.md](ANALYSIS_PROMPT_PLAYBOOK_DEBUG.md)
  代码、日志、UI 排障场景提示词。

## 使用边界

1. 如果只是想找“分析提示词总入口”，优先看顶层 [PLAYBOOK_ANALYSIS_PROMPT.md](../PLAYBOOK_ANALYSIS_PROMPT.md)。
2. 如果已经确定场景，再进入本目录选择具体分支文档。
3. 历史提示词、旧版本提示词、阶段性修订提示词，不放在本目录，应在：
   [archive/prompts/](../archive/prompts)
4. 提示词演进历史与索引，优先看：
   [ANALYSIS_PROMPT_PLAYBOOK_HISTORY.md](../archive/history/ANALYSIS_PROMPT_PLAYBOOK_HISTORY.md)
