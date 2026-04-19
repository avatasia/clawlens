---
status: active
created: 2026-04-19
updated: 2026-04-19
---

# Analysis Prompt Playbook - Document Review

> 当前主文档，对应通用文档审查阶段提示词。
>
> 适用：让 AI 对一份技术文档、SOP、playbook、方案文档做结构化评审。
> 不适用：跨工具多轮评审交接场景。那类场景请优先用
> [ANALYSIS_PROMPT_PLAYBOOK_EXTERNAL_REVIEW.md](ANALYSIS_PROMPT_PLAYBOOK_EXTERNAL_REVIEW.md)。

## 直接可用提示词

> **使用方式**
> 把下面整段提示词发给 reviewer，然后在后面补：
> 1. 你的评审目标
> 2. 需要遵守的边界
> 3. 待评审文档全文

```md
你现在是一个严格的技术文档 reviewer。你的任务不是改写文档，而是识别其中的漏洞、歧义、遗漏前提、流程断点、治理冲突和容易导致执行失败的表达。

评审时遵守以下规则：

1. 不要重写整篇文档。
2. 不要输出“我会如何重构全文”这类大而空建议。
3. 只指出你能从输入中直接证实的问题；不要臆造文件、规则、能力或工具行为。
4. 如果某个问题只是“可以更好”，但不影响执行、审计或一致性，降级为 Low 或 Info，不要夸大。
5. 如果文档已经明确声明某项内容 out-of-scope，不要把该项重新打成 blocker，除非这个排除本身造成流程漏洞。
6. 你的首要任务是找会导致执行失败、误执行、重复劳动、审计断链或跨轮漂移的问题。

重点检查以下维度：

- Feasibility & Clarity
  文档是否足够明确，能让后续操作者或 AI 按文执行，而不是靠猜。
- Process Integrity
  生命周期、步骤顺序、前置条件、恢复路径是否闭环。
- Risk & Edge Cases
  是否覆盖并行执行、人为跳步、局部失败、重试、恢复、错误输入等边界情况。
- Governance Fit
  是否与已知治理规则、目录规则、命名规则、索引规则冲突。
- Evidence Quality
  关键结论是否有足够依据，还是靠模糊判断词支撑。

输出要求：

按以下结构输出，且只输出这四部分：

## 1. Verdict
只能是以下三者之一：
- READY
- READY-WITH-FIXES
- BLOCKED

## 2. Findings
按严重程度排序。每条 finding 用以下格式：

- [Critical|High|Medium|Low|Info] 标题
  - Location: 章节名、段落名或一句可定位原文
  - Why it matters: 这会导致什么实际问题
  - Minimal fix: 最小修复建议

如果没有 finding，写：
- (none)

## 3. Open Questions
列出下一轮最值得澄清的问题。
如果没有，写：
- (none)

## 4. What Not To Re-Litigate
列出你认为文档里已经足够明确、下一轮不应重复争论的点。
如果没有，写：
- (none)

额外要求：

- 优先指出 blocker，而不是风格偏好。
- 如果某条是 pre-existing debt，而不是本轮引入，请明确标注 `(pre-existing)`。
- 若某维度不适用，可以在相应 finding 或 open question 中简短说明，不要为了凑数硬写问题。
- 若文档总体可用但存在局部修补项，优先给 `READY-WITH-FIXES`，不要轻易给 `BLOCKED`。
```

## 最小调用模板

```md
请按下面提示词审查这份文档。

[把上面的“直接可用提示词”完整贴入]

本轮评审目标：
- 判断这份文档是否已经可以给团队直接使用
- 优先抓流程漏洞、恢复缺口、治理冲突

本轮不关注：
- 文风是否优雅
- 措辞是否更简洁
- 与当前 scope 无关的扩展建议

待评审文档：

[在这里粘贴文档全文]
```

## 什么时候用这个 prompt

- 你要快速让另一个模型做一次严格文档复核。
- 你不需要多轮 handoff header / frozen decisions 机制。
- 你只想拿到 blockers、open questions 和下一轮不必重打的点。

## 什么时候不要用

- 你在跑跨工具、多轮、带 frozen decisions 的正式评审闭环。
- 你需要 reviewer 严格遵守 5 段输出格式并与 handoff header 对齐。
- 你需要人工复制粘贴给外部 reviewer，并控制跨轮 continuity。

这些场景请改用：

- [ANALYSIS_PROMPT_PLAYBOOK_EXTERNAL_REVIEW.md](ANALYSIS_PROMPT_PLAYBOOK_EXTERNAL_REVIEW.md)

## 历史版本

- [ANALYSIS_PROMPT_PLAYBOOK_DOC_REVIEW_2026-04-03.md](../archive/prompts/ANALYSIS_PROMPT_PLAYBOOK_DOC_REVIEW_2026-04-03.md)
