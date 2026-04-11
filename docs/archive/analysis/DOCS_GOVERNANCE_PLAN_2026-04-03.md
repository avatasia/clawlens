# Docs Governance Plan 2026-04-03

本文用于梳理当前 `docs/` 目录的角色分工，判断哪些文档应保留为主文档，哪些应版本化保留，哪些适合归档或合并。

注意：

- 本文先给治理建议，不直接移动现有文件。
- 目标是建立“当前主文档 + 历史快照 + 实施/排障产物”的稳定结构。

## 一、结论

### 1. 架构文档不应只有“一份文件”，而应有“两层”

最佳实践不是只保留一份架构文件，也不是不断覆盖最初始文档，而是：

- 保留 1 份**当前主架构文档**
- 保留多份**按版本/日期冻结的复核或审计快照**

推荐做法：

- 当前主架构文档：
  - [architecture.md](../../architecture.md)
- 历史/版本化架构复核：
  - [ARCHITECTURE_REVIEW_v2026.3.28_2026-04-01.md](../reviews/ARCHITECTURE_REVIEW_v2026.3.28_2026-04-01.md)

原因：

- 主架构文档用于描述“当前代码应该是什么样”
- 版本化复核文档用于保留“当时检查到了什么问题、结论是什么”
- 两者职责不同，不应互相替代

### 2. 初始分析稿不应持续更新，应转为历史材料

例如：

- [analysis-raw.md](./analysis-raw.md)
- [ARCHITECTURE_REVIEW_v2026.3.28.md](../reviews/ARCHITECTURE_REVIEW_v2026.3.28.md)
- [HOOK_ANALYSIS_v2026.3.28.md](../reviews/HOOK_ANALYSIS_v2026.3.28.md)

这类文件更适合作为：

- 历史输入材料
- 某一轮分析起点
- 回溯证据

不应再原位持续修正为“当前真相源”。

### 3. 当前文档层级建议

推荐把 `docs/` 分成 4 层理解：

1. 当前主文档
2. 版本化审查/复核快照
3. 专项分析与实施产物
4. 提示词/方法论文档

---

## 二、当前主文档建议保留名单

这类文档适合作为“当前入口”长期保留在 `docs/` 顶层。

### 产品 / 架构 / 使用

- [architecture.md](../../architecture.md)
- [clawlens-usage.md](../../clawlens-usage.md)
- [IMPLEMENTATION_PROMPT_2026-04-01.md](../prompts/IMPLEMENTATION_PROMPT_2026-04-01.md)

### 当前方法论 / 规范

- [ENGINEERING_LESSONS_PLAYBOOK_2026-04-03.md](./ENGINEERING_LESSONS_PLAYBOOK_2026-04-03.md)
- [ANALYSIS_PROMPT_PLAYBOOK_GENERAL_2026-04-03.md](../prompts/ANALYSIS_PROMPT_PLAYBOOK_GENERAL_2026-04-03.md)
- [ANALYSIS_PROMPT_PLAYBOOK_DOC_REVIEW_2026-04-03.md](../prompts/ANALYSIS_PROMPT_PLAYBOOK_DOC_REVIEW_2026-04-03.md)
- [ANALYSIS_PROMPT_PLAYBOOK_DEBUG_2026-04-03.md](../prompts/ANALYSIS_PROMPT_PLAYBOOK_DEBUG_2026-04-03.md)

### 当前剩余工作主线

- [CHAT_AUDIT_REMAINING_WORK_ANALYSIS_2026-04-02.md](../chat-audit/CHAT_AUDIT_REMAINING_WORK_ANALYSIS_2026-04-02.md)
- [CHAT_AUDIT_REMAINING_WORK_IMPLEMENTATION_PLAN_2026-04-02.md](../chat-audit/CHAT_AUDIT_REMAINING_WORK_IMPLEMENTATION_PLAN_2026-04-02.md)

---

## 三、建议保留为版本化快照的文档

这类文档不建议合并回主文档，但应继续保留，作为冻结快照。

### 代码 / 架构 / Hook / 参考项目复核

- [ARCHITECTURE_REVIEW_v2026.3.28_2026-04-01.md](../reviews/ARCHITECTURE_REVIEW_v2026.3.28_2026-04-01.md)
- [HOOK_ANALYSIS_v2026.3.28_2026-04-01.md](../reviews/HOOK_ANALYSIS_v2026.3.28_2026-04-01.md)
- [PLUGIN_GUIDELINES_REVIEW_2026-04-01.md](../reviews/PLUGIN_GUIDELINES_REVIEW_2026-04-01.md)
- [REF_ANALYSIS_llm-api-logger_2026-04-01.md](../reviews/REF_ANALYSIS_llm-api-logger_2026-04-01.md)

原因：

- 它们是某一轮“核实后产物”
- 适合保留当时口径
- 不适合继续拿来做滚动主文档

---

## 四、已归档的文档

这类文件仍有价值，但不应继续占据顶层“当前入口”位置。

### 1. 被新版本替代的旧稿

- [ARCHITECTURE_REVIEW.md](../reviews/ARCHITECTURE_REVIEW.md)
- [ARCHITECTURE_REVIEW_v2026.3.28.md](../reviews/ARCHITECTURE_REVIEW_v2026.3.28.md)
- [HOOK_ANALYSIS_v2026.3.28.md](../reviews/HOOK_ANALYSIS_v2026.3.28.md)
- [PLUGIN_GUIDELINES_REVIEW.md](../reviews/PLUGIN_GUIDELINES_REVIEW.md)
- [REF_ANALYSIS_llm-api-logger.md](../reviews/REF_ANALYSIS_llm-api-logger.md)
- [IMPLEMENTATION_PROMPT_2026-04-01.md](../prompts/IMPLEMENTATION_PROMPT_2026-04-01.md)

### 2. 明显属于过程性中间稿

- [analysis-raw.md](../analysis/analysis-raw.md)
- [ARCHITECTURE_v2.md](../analysis/ARCHITECTURE_v2.md)
- [POSTMORTEM_2026-04-01.md](../analysis/POSTMORTEM_2026-04-01.md)
- [RECTIFICATION.md](../analysis/RECTIFICATION.md)

说明：

- `ARCHITECTURE_v2.md` 的标签名不像当前主文档，更像演进稿
- 若其内容仍有价值，建议合并吸收后归档

### 3. 明显属于临时提示词或迁移脚本提示

- [claude-code-prompt.md](../prompts/claude-code-prompt.md)
- [claude-code-prompt-update.md](../prompts/claude-code-prompt-update.md)
- [IMPLEMENTATION_PROMPT_REMOTE_REVISED_2026-04-02.md](../prompts/IMPLEMENTATION_PROMPT_REMOTE_REVISED_2026-04-02.md)
- [IMPLEMENTATION_PROMPT_REMOTE_UPDATE_PROMPT_2026-04-02.md](../prompts/IMPLEMENTATION_PROMPT_REMOTE_UPDATE_PROMPT_2026-04-02.md)
- [REVIEW_PROMPT.md](../prompts/REVIEW_PROMPT.md)

说明：

- 它们仍可保留
- 但更适合进入 `docs/archive/prompts/`

### 4. 过程日志或不应长期留在顶层的文件

- `error.log`（历史日志，当前仓库已不保留该路径）

说明：

- 这类文件建议移出顶层 `docs/`
- 更适合放到 `docs/archive/logs/` 或直接删除

---

## 五、已收敛/已继续归档的文档

### 1. Chat Audit 专项问题已收敛

当前这组文件已归档到 `docs/archive/chat-audit/`：

- [CHAT_AUDIT_EMPTY_STATE_FIX_2026-04-02.md](../chat-audit/CHAT_AUDIT_EMPTY_STATE_FIX_2026-04-02.md)
- [CHAT_AUDIT_TURNS_DETAIL_FIX_2026-04-02.md](../chat-audit/CHAT_AUDIT_TURNS_DETAIL_FIX_2026-04-02.md)
- [CHAT_AUDIT_UI_ANALYSIS_2026-04-02.md](../chat-audit/CHAT_AUDIT_UI_ANALYSIS_2026-04-02.md)
- [CHAT_AUDIT_UI_BOTTOM_EDGE_ANALYSIS_2026-04-02.md](../chat-audit/CHAT_AUDIT_UI_BOTTOM_EDGE_ANALYSIS_2026-04-02.md)
- [CHAT_AUDIT_UI_FIXES_2026-04-02.md](../chat-audit/CHAT_AUDIT_UI_FIXES_2026-04-02.md)
- [CHAT_AUDIT_FINAL_FIX_SUMMARY_2026-04-02.md](../chat-audit/CHAT_AUDIT_FINAL_FIX_SUMMARY_2026-04-02.md)
- [CHAT_AUDIT_DETAIL_CAPTURE_FIX_2026-04-02.md](../chat-audit/CHAT_AUDIT_DETAIL_CAPTURE_FIX_2026-04-02.md)
- [CHAT_AUDIT_DEBUG_LOG_SWITCH_2026-04-02.md](../chat-audit/CHAT_AUDIT_DEBUG_LOG_SWITCH_2026-04-02.md)
- [CHAT_AUDIT_INCREMENTAL_LOADING_PLAN_2026-04-02.md](../chat-audit/CHAT_AUDIT_INCREMENTAL_LOADING_PLAN_2026-04-02.md)

建议收敛方式：

- 当前主总结保留：
  - [CHAT_AUDIT_CHANGELOG_2026-04-03.md](../chat-audit/CHAT_AUDIT_CHANGELOG_2026-04-03.md)
- 剩余工作主线保留：
  - [CHAT_AUDIT_REMAINING_WORK_ANALYSIS_2026-04-02.md](../chat-audit/CHAT_AUDIT_REMAINING_WORK_ANALYSIS_2026-04-02.md)
  - [CHAT_AUDIT_REMAINING_WORK_IMPLEMENTATION_PLAN_2026-04-02.md](../chat-audit/CHAT_AUDIT_REMAINING_WORK_IMPLEMENTATION_PLAN_2026-04-02.md)
- 其余专项文件归档

### 2. message mapping 与排序研究的主线/补充关系

当前推荐保留在顶层：

- [LLM_API_LOGGER_MESSAGE_MAPPING_RESEARCH_2026-04-02.md](../analysis/LLM_API_LOGGER_MESSAGE_MAPPING_RESEARCH_2026-04-02.md)
- [LLM_API_LOGGER_MESSAGE_MAPPING_IMPLEMENTATION_PLAN_2026-04-02.md](../analysis/LLM_API_LOGGER_MESSAGE_MAPPING_IMPLEMENTATION_PLAN_2026-04-02.md)

以下文档已归档到 `docs/archive/analysis/`，作为补充材料保留：

- [CHAT_AUDIT_MESSAGE_MAPPING_DUAL_LAYER_DESIGN_2026-04-02.md](../analysis/CHAT_AUDIT_MESSAGE_MAPPING_DUAL_LAYER_DESIGN_2026-04-02.md)
- [CHAT_AUDIT_ORDERING_RESEARCH_2026-04-02.md](../analysis/CHAT_AUDIT_ORDERING_RESEARCH_2026-04-02.md)
- [CHAT_AUDIT_LIVE_UPDATE_AND_MESSAGE_MAPPING_ANALYSIS_2026-04-02.md](../analysis/CHAT_AUDIT_LIVE_UPDATE_AND_MESSAGE_MAPPING_ANALYSIS_2026-04-02.md)
- [CHAT_AUDIT_REMAINING_WORK_2026-04-02.md](../chat-audit/CHAT_AUDIT_REMAINING_WORK_2026-04-02.md)
- [LOG_ANALYSIS_2026-03-30.md](../analysis/LOG_ANALYSIS_2026-03-30.md)

---

## 六、建议的目录治理方式

### 方案

顶层 `docs/` 只保留：

- 当前主架构/使用/实现文档
- 当前方法论文档
- 当前剩余工作主线
- 最新 changelog / 当前版本总结

建议未来新增：

- `docs/archive/reviews/`
- `docs/archive/chat-audit/`
- `docs/archive/prompts/`
- `docs/archive/logs/`

### 判断标准

满足以下任一条件即可考虑归档：

- 已被带日期的新版本替代
- 只是单次修复过程产物
- 只服务于某轮提示词/某次远程部署
- 对当前代码不再是主入口

---

## 七、对 README 的建议口径

README 应只引用：

- 当前主架构文档
- 当前使用文档
- 当前实现/治理入口

不应继续把过多历史中间稿直接挂在 README 中。

推荐 README 只保留这类入口：

- `architecture.md`
- `clawlens-usage.md`
- `IMPLEMENTATION_PROMPT.md`
- `CHAT_AUDIT_CHANGELOG_2026-04-03.md`
- `ENGINEERING_LESSONS_PLAYBOOK_2026-04-03.md`

---

## 八、结论

最优做法不是“只保留一份架构文档”，而是：

- 1 份当前主架构文档
- 多份版本化复核快照
- 将旧稿和过程稿归档

也不建议继续原位更新最初始分析稿。更稳的方式是：

- 当前真相写进主文档
- 某次复核结果写进带日期/版本的快照
- 旧稿只保留为历史材料
