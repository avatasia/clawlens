---
status: active
created: 2026-04-19
updated: 2026-04-19
---

# Cross-Tool Review Loop (CTRL) Playbook

> **Under external review** — round-card at [plans/REVIEW_ROUND_CTRL_PLAYBOOK_2026-04-19.md](plans/REVIEW_ROUND_CTRL_PLAYBOOK_2026-04-19.md). 编辑本文件前请先读回合卡，避免破坏本轮冻结决策。

> 目的：Claude 作为 writer、异构模型（Codex / GPT-5 / Gemini 等）作为 reviewer、人工承担复制-粘贴传递的多轮文档评审场景下，同时控制两类成本：
>
> 1. Anthropic prompt cache 的 5 分钟 TTL 失效；
> 2. Claude session 随轮次单调膨胀导致的重 cache 成本。
>
> 配套英文提示词：[prompts/ANALYSIS_PROMPT_PLAYBOOK_EXTERNAL_REVIEW.md](prompts/ANALYSIS_PROMPT_PLAYBOOK_EXTERNAL_REVIEW.md)

## 适用场景

- ClawLens 任意文档（架构、SOP、分析、提示词）产出后需要外部模型做同行评审。
- 评审通道是人工复制-粘贴，不是工具直连。
- 预期评审不会一次通过，需要 2~4 轮往返。
- 不适用：纯 Claude-内部评审（直接用 Agent 后台评审即可）；一次性小改动（直接让人工看）。

## 核心问题

1. **Cache TTL**：prompt cache 5 分钟，评审往返常常超过此窗口，空等将产生一次全量重 cache。
2. **Session 膨胀**：每轮都向 session 叠加 draft + 评审意见 + 修改讨论，到第 3~4 轮时 session 常见 50k+ tokens，单次 cache miss 的绝对成本变高。
3. **语境漂移**：Reviewer 不共享 Claude 的 session 记忆，轮次之间若没有显式交接，reviewer 容易反复提相同问题，或忽视已做决策。

## 四层防护

### Layer 1 — 轮内 cache 保活（预计等待 ≤ 15 min）

保活可行路径取决于操作者是否处于 Claude Code `/loop` 动态模式。**不要假设 Claude 可以在普通对话里自己定时唤醒**——`ScheduleWakeup` 在非 `/loop` 动态模式下不可用。

(a) **`/loop` 动态模式下（Claude 可自调度）**
操作者用 `/loop <task-description>`（**不带 interval 参数**）启动评审守候。在此模式下，Claude 可调用 `ScheduleWakeup(delaySeconds: 240, ...)` 每 240s 自唤醒刷新 cache。
- 240s 是 5 分钟 TTL 的安全边际。
- 选 300s / 600s 是最差策略：付了 cache miss，又没利用更长的空闲窗口。
- 若已预判等待 > 15 min，直接躺平，不要保活 6 次以上。

(b) **普通对话下（未进入 `/loop`）**
Claude 无法主动定时唤醒自己。可行 fallback：
- 操作者手动每 ≤ 4 分钟向 Claude 发一条任意消息（"进度？"、"继续"、回车等）即可刷新 cache 窗口；
- 或直接接受一次 cache miss，等评审回来再一次性付 cache write 成本。等待越长这个选项越划算。

选择准则：预计 reviewer 回来 ≤ 10 min 且你愿意留在终端前 → (b) 的手动保活；预计 10~15 min 且已在 `/loop` 中 → (a) 的 `ScheduleWakeup`；预计 > 15 min 或人要离开 → 躺平。

### Layer 2 — 轮尾手动 `/compact`

Claude 处理完本轮评审意见、产出 v(N+1) 之后，立刻 `/compact`。

- 把本轮完整对话压成摘要，作为后续 cache 基础。
- 对保留"本轮为什么这样改"的因果链非常关键；不 compact 则下一轮评审回来时语境会和 session 历史混在一起，噪音增加。

### Layer 3 — 跨 session 续跑（TaskList 维护"评审回合卡"）

用 `TaskCreate` 建立一条评审任务，字段包含：
- 文档 repo-relative 路径；
- 当前版本号（v1 / v2 / ...）；
- 上一轮 blockers 清单；
- 已冻结决策清单（避免下一轮 reviewer 重提）；
- 下一步动作。

每轮结束用 `TaskUpdate` 刷新。

**TaskList 的持久性边界**（严格注意，不要假设它无限持久）：

- 保证存活：同一 Claude Code session 内跨消息、跨 Agent 调用、跨短暂的网络抖动。
- 不保证存活：主动 `/clear`、Claude Code 进程重启、主动 `/compact`（实现相关——不要依赖它跨 compact 一定保留）、新建 session。
- 绝不跨：不同机器、不同账户、其他 Claude 产品形态（Web app、Desktop app、API 直调）。

**当 `TaskList` 返回 0 条匹配任务**（上述任一"不保证"边界已越过），操作者和 Claude 必须按以下顺序恢复：

1. **同轮 `/compact` 例外**：若 TaskList 丢失发生在刚做完 `/compact` 的当轮——Handoff Header 与 draft 仍在 compact 后的对话摘要内、未跨 `/clear`、未跨进程重启、未跨 session、未跨新机器——允许直接从当前对话重建 card（再次 `TaskCreate`，内容取自当前 session 的 compact 摘要）。这是标准流程的明示退路，不触发下面的 2、3 步。其它任何丢失场景（`/clear`、重启、新 session、新机器）一律 **不允许** 凭记忆重建。
2. 跨 `/clear`、跨进程、跨 session 导致的丢失：查看 `docs/plans/` 下是否存在本评审对应的 `REVIEW_ROUND_<topic>_*.md`（即 Layer 4 产物）。若存在，读最新一份恢复语境，视为 Layer 3 降级到 Layer 4。
3. 若 `docs/plans/` 下没有对应文件，视为评审未持久化——从第 1 轮重启评审；不要猜测上轮结论。
4. 不要从 git 历史里捞 Claude 之前的输出冒充 TaskList——历史对话不等于可信的 frozen decisions。

不要把 TaskList 的内容落到 `docs/` ——它是 ephemeral 状态，落盘会违反治理原则。任何需要跨 session 硬持久化的场景，统一走 Layer 4。

### Layer 4 — 跨日 / 多人交接（只有此时才落盘）

只有同时满足以下任一条件时，把评审回合卡落盘：

- 评审周期 > 1 天，需要跨 Claude 进程持久化；
- 多人轮流接手同一评审；
- 评审产物本身要进入归档证据链。

落盘位置：`docs/plans/` 目录下，命名形如 `REVIEW_ROUND_<topic>_<YYYY-MM-DD>.md`，必须带 frontmatter：

```yaml
---
status: active
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

**文件名冲突规则（避免同主题 / 同日并行评审相撞）：**

- 同一 topic 当日首次评审：`REVIEW_ROUND_<topic>_<YYYY-MM-DD>.md`。
- 当日对同一 topic 已存在 `status: active` 的 round-card：**不要**新建同名文件，直接在现有文件里追加本轮 Handoff 与评审结果（一张 card 贯穿多轮）。
- 当日对同一 topic 存在 `status: active` card 但**确实是不同评审任务**（例如不同 reviewer、不同目标）：追加后缀区分，如 `REVIEW_ROUND_<topic>_<YYYY-MM-DD>__r2reviewer.md`，并在两份文件彼此顶部互链。
- "latest" 的判定顺序：`status: active` > `updated` 日期较新 > 文件名字典序更大。判断产生歧义即视为冲突，按上一条处理。

**创建时（必须原子完成，同一 commit）：**

1. 按上述命名规则在 `docs/plans/` 下新建或复用文件，带 frontmatter。
2. 在 `docs/plans/README.md` 中新增一条索引（该目录的 README 覆盖率是 `check-docs-governance.mjs --all` 强制检查项，不更新 README 会 FAIL）。
3. 如有被评审的主文档，在其顶部或 frontmatter 附近标注 "under external review: see docs/plans/REVIEW_ROUND_..."，便于后续 reviewer 和 auditor 追踪。

**终稿合入后（同样原子，同一 commit），严格对应治理 `GOVERNANCE_DOCS_PLAN.md` 的归档 SOP：**

1. 把 `status` 改为 `merged`（或本轮被放弃则 `deprecated`），`superseded_by` 填写最终主文档的 repo-relative 路径。
2. 移入 `docs/archive/reviews/`。评审过程稿 (round-card) 按治理分类属于"审查稿"，归入 `reviews/`；**不要**放入 `docs/archive/history/`（该目录只放主题索引，不放过程稿），也**不要**放入 `docs/archive/plans/`（治理未批准该子目录）。
3. **强制**在 `docs/archive/history/` 下对应主题的 `*_HISTORY.md` 中登记本次归档条目（治理规则："仅把文件移动到 `docs/archive/` 而不更新 history，视为不完整归档"）。若该主题尚无 history 索引文件，一并在同 commit 内新建。
4. 同步更新 `docs/plans/README.md`（移除条目），`docs/archive/history/README.md`（若新增了主题 history），移除被评审主文档上的 "under external review" 标注。

**禁止：**

- 放在 `docs/` 顶层（会被 `check-docs-governance.mjs` 的"顶层无日期"规则拦截）；
- 创建后不更新 `docs/plans/README.md`（覆盖率 FAIL）；
- 归档到 `docs/archive/history/`、`docs/archive/plans/` 或任何治理未批准的子目录；
- 归档不登记到主题 `_HISTORY.md`（治理明文禁止：不完整归档）；
- 把创建 / 合入 / history 登记拆成多个 commit（违反归档原子性，审计追溯会断）。

## 标准每轮流程

```
[Claude]  draft vN + Handoff Header
    │
    ▼
[human copy]  → External Reviewer Prompt + Handoff Header + Draft
    │
    ▼
[Reviewer]  structured review (see prompt output schema)
    │
    ▼
[human paste]  → Claude
    │
    ▼
[Claude]  dispatch review-processor subagent → verified findings → apply VALID/PARTIAL fixes → draft v(N+1) → TaskUpdate → /compact → verify TaskList still present; if empty, see Layer 3 recovery rules (the same-turn /compact exception applies here; all other loss modes must fall through to Layer 4 or a round-1 restart)
    │
    ▼
(repeat until reviewer returns READY)
```

## Reviewer 输出回到 Claude 后的默认动作

当人工把 reviewer 的 5 段输出粘回 Claude（无论是否先做了 `/clear`），main agent 的默认动作 **不是** 按 finding 直接改文档，而是：

0. **若 `TaskList` 返回 0 条匹配任务**（因 `/clear`、进程重启、新 session、新机器等导致），先按 Layer 3 恢复回合状态（同轮 `/compact` 例外适用；其它场景按 Layer 3 步骤 2、3 降级到 Layer 4 或从第 1 轮重启）。**恢复完成前禁止执行 `TaskUpdate`、禁止生成下一个 Handoff Header**；subagent 验收可以并行启动（它不依赖 TaskList），但其输出必须等回合卡恢复后再落到 Handoff。
1. **Dispatch `review-processor` subagent**（定义见 `.claude/agents/review-processor.md`）。把 reviewer 原文 + 被评审文档的 repo-relative 路径交给它，让它在干净的 subagent 上下文里逐条核验每个 finding 是否与现行文档一致。
2. Subagent 返回验证后的清单（每条标 `VALID` / `INVALID` / `PARTIAL`，附 `file:line` 证据）与最小化修复建议。
3. Main agent 只对 `VALID` / `PARTIAL` 条目动手；`INVALID` 条目 **不写入** `Previous-round blockers addressed in this draft`（该段保留给有四字段证据的实际修复），而是写入下一轮 Handoff Header 中独立新增的 `Reviewer mis-citations (not addressed)` 段，格式为 `- "<finding title verbatim>" — mis-citation in round N, counter-evidence: "<file:line quoted text>"`，避免 reviewer 下一轮继续复述同一误读。

为什么走 subagent：

- `/clear` 是 Claude Code harness 级动作，Claude 自己不能触发；subagent 的"新起上下文"是目前最接近自动 clear 的机制。
- Main session 承载本轮的改动意图和冻结决策语境；把事实核验混进来会让下一轮错误"服从"错 finding，腐化 frozen decisions 的可信度。
- 验收只需要对"reviewer 所说 vs 文档实际内容"做单轮事实核对，不需要 session 历史，subagent 的狭窄视野反而更合适。

**禁止**：

- Main agent 直接读 reviewer 输出后按 finding 编辑文档（跳过验收 = 放大 reviewer 幻觉/误读）；
- 在 subagent 里重写文档（subagent 只返回验收结论与最小化修复建议，应用修复仍由 main agent 执行）；
- 把 subagent 的单次验收结论当成 frozen decision——冻结仍走 Handoff Header 正规流程。

## Handoff Header 模板（Claude 每轮生成，随 draft 一起贴给 reviewer）

```markdown
## Review Handoff (round N of estimated M)

- Document: <repo-relative path, e.g., docs/PLAYBOOK_X.md>
- Writer model: claude-opus-4-7
- Reviewer target: <codex | gpt-5 | gemini-2.5-pro | ...>
- Goal of this round: <one sentence>
- Open questions for this round:
  - Q1: ...
  - Q2: ...
- Frozen decisions (do not re-litigate):
  - D1: ... (frozen in round K)
  - D2: ...
- Previous-round blockers addressed in this draft:
  - "<Blocker finding title verbatim from prior round>" -> addressed in section "<doc section heading>", lines L<start>-L<end>; changed sentence: "<exact quoted sentence from the new draft>"
  - (each item MUST cite ALL four: prior finding title verbatim + section heading + concrete line range + an exact quoted sentence from the new draft. Free-form summary of the edit is NOT an acceptable substitute. Items that omit any of these four are rejected by the next-round reviewer. INVALID mis-citations do NOT belong here — list them in the next section.)
- Reviewer mis-citations (not addressed):
  - "<Finding title verbatim from prior round>" — mis-citation in round N, counter-evidence: "<file:line quoted text from the document that refutes the finding>"
  - (this section is only for findings that the `review-processor` subagent marked INVALID. Each item requires the original finding title + the round number + an exact quote from the document that contradicts the reviewer's claim. Leaving INVALID findings out of Handoff entirely is prohibited — reviewers will re-raise them next round.)
- Out-of-scope for this review:
  - ...
- Governance constraints to respect:
  - Top-level `docs/*.md` must not contain dates.
  - Sub-directory READMEs must index all `.md` files.
  - No absolute repo-root paths in content.
  - Bidirectional `DOC_INDEX` / `CODE_INDEX` must stay consistent.
```

将该 Header 置于 draft **之前**，再贴 External Reviewer Prompt 在最前。完整送出顺序：

```
[External Reviewer Prompt]
+
[Handoff Header]
+
[Draft Document]
```

## Frozen decision challenge handling

当 reviewer 在后续轮次再次提出针对已 Frozen 条目的反对意见时，writer 在下一轮 Handoff Header 必须**显式选择**以下三条处置路径之一，不能默认忽略：

1. **Hold（维持冻结）**
   在 Frozen decisions 对应条目后追加 `(challenged round N, held; reason: <一句话>)`。reviewer 下一轮见到此标记则不再评估该条。
2. **Downgrade（降级回 Open）**
   把条目从 Frozen decisions 移回 Open questions，标注 `(unfrozen in round N because <reason>)`，接受 reviewer 在下一轮继续讨论。
3. **Escalate（专项升级）**
   在 Frozen decisions 对应条目后追加 `(escalated to round N for dedicated review)`，并把下一轮 Handoff 的 `Goal of this round` 改为 "re-litigate D<K>"，暂停其他维度，单独处置这一条。

**Hold 的 rationale 本身仍可被挑战。** Hold 标记让 reviewer 不再评估"原条目是否仍需讨论"，但 reviewer 仍可以在 Process Integrity 或 Governance Fit 维度对 **Hold rationale 本身**提出 finding——例如 rationale 与治理规则冲突、rationale 引入新的流程漏洞、rationale 逻辑不自洽等。这类 finding 不等于重启原条目的评审，而是对 writer 如何使用 Hold 这一动作的独立审查。writer 遇到此类 finding 仍必须按 Hold / Downgrade / Escalate 重新处置——不可以递归 Hold（用 Hold 来屏蔽对上一次 Hold rationale 的 finding）。

**禁止**：忽略 reviewer 对冻结项的重复挑战而不更新 Handoff。这是 silent frozen leak——writer 表面上"锁着决策"，实际上 reviewer 每轮都在提同一问题，noise 会污染 Findings 列表并消耗轮次预算。

## 评审模型选择建议

> **Heuristic section — judgement calls, not empirically verified.**
> 下表基于写作者（claude-opus-4-7）的使用经验与跨模型家族的训练差异推测，未经系统性 A/B 验证。实际执行时应以你所在团队观察到的 reviewer 质量为准；若某个"跨家族"组合在你的语料上效果反而不好，以实际效果覆盖本表。

| 角色 | 推荐 | 原因 | 不推荐 |
|---|---|---|---|
| Writer | Opus 4.7 | 长上下文合成、创造性结构 | Haiku / 同家族小模型 |
| Primary Reviewer | Codex / GPT-5 / Gemini 2.5 Pro | **跨模型家族**最大化盲点覆盖；Codex 偏"devil's advocate"，Gemini 偏长文一致性 | Claude 家族模型（易同质化、赞美倾向） |
| Secondary / 终审 Reviewer | 人工 | 判断业务语境、治理张力 | 任何单一模型都不宜作为 final signoff |

关键原则：

1. **Writer 和 Reviewer 必须跨家族**。同家族互评对 tokenizer bias、价值观对齐、推理路径高度重合，评审效果退化为"rubber-stamp"。
2. **同一 reviewer 不要跨轮切换**。每次换模型，reviewer 的语境都要重建；保持稳定 reviewer 能让 Open Questions 跨轮累积。
3. **Reviewer 模型选择应匹配文档类型**：
   - 流程 / SOP 类 → Codex / GPT-5（结构严谨性强）
   - 长文一致性 / 跨文档比对 → Gemini 2.5 Pro（长上下文）
   - 代码 / 实现类 → Codex（代码语义强）
4. **避免用温度过高的配置**。评审任务要稳定输出结构化结果，不要创造性。

## 成本粗估（Opus 4.7 单轮）

> **Heuristic section — order-of-magnitude estimates only.**
> 表中数字依赖 Anthropic 当期定价、session 的实际 token 量、以及"cache read ≈ cache write 10%"这条经验比。定价和比值会随时间变化，数字不是精确预算。表格的作用是指出**策略之间的相对关系**（保活 vs 躺平 vs compact 配合），不是给出某一轮的绝对 USD 成本。
>
> 关于更长 TTL：本 playbook 不建模 "1h 扩展 cache"（若 Anthropic 后续开放）这类 API-level 选项，因为它不是 Claude Code session 内由 writer 决定的变量；等 API 层稳定提供 + Claude Code 暴露相应接口后再修本章。

假设 Claude session 在第 3 轮达到 50k tokens：

| 策略 | 单轮 cache 成本 | 备注 |
|---|---|---|
| 裸等（> 5min） | 1 × full cache write | 基线成本 |
| 保活（ScheduleWakeup 240s × N） | N × cache read ≈ 0.1N × full write | N=6 时约 0.6 × full；等待 > 15 min 后反而更贵 |
| 保活 + 轮尾 /compact | 同上，但下轮基础从 50k 降到 ~10k | **最优**：单轮便宜 + 后续轮次也便宜 |
| 不保活 + 轮尾 /compact | 1 × full cache write（但基础小） | 可接受，适合不确定等待时长 |

经验值：等待 ≤ 10 min 选保活；10~20 min 看情况；> 20 min 躺平 + 轮尾 compact。

## 反模式

1. 在 `docs/` 顶层建立常驻 `REVIEWS_PENDING.md`。治理脚本会挂；即使放行也会腐化为"长期二级索引"。
2. 多个评审并行、共用一份锚点文件。必然产生冲突；一任务一文件。
3. Claude 评 Claude。盲点重合；至少换个家族的模型做 primary reviewer。
4. 评审意见粘贴回 Claude 时只贴 reviewer 原文、丢掉 Handoff Header。下一轮 Claude 会丢失"已冻结决策"语境，反复改已经定稿的部分。
5. 不更新 TaskList。跨 session 时除了 scroll-back 没有其他线索。
6. 用 `--no-verify` 绕过治理钩子把评审文档强行合入。应该按 Layer 4 的 frontmatter / 归档 SOP 走正规流程。

## 相关文件

- [prompts/ANALYSIS_PROMPT_PLAYBOOK_EXTERNAL_REVIEW.md](prompts/ANALYSIS_PROMPT_PLAYBOOK_EXTERNAL_REVIEW.md) — 贴给 reviewer 的英文提示词（与本 playbook 配套）
- [scripts/assemble-review-package.sh](../scripts/assemble-review-package.sh) — 一键组装评审包（拼接 reviewer prompt + Handoff Header + 文档全文）
- [PROMPT_DOCS_AUDIT.md](PROMPT_DOCS_AUDIT.md) — Claude 自审时使用的 7 维度审计提示词（与 CTRL 互补）
- [PROMPT_DOCS_GLOBAL_VALIDATION.md](PROMPT_DOCS_GLOBAL_VALIDATION.md) — 10 维度全量验证
- [research/RESEARCH_QA_REVIEW_CONTEXT_AND_PROMPT_TEMPLATES_2026-04-13.md](research/RESEARCH_QA_REVIEW_CONTEXT_AND_PROMPT_TEMPLATES_2026-04-13.md) — Context Pack / Review Prompt / Output Skeleton 三件套（单模型评审通用）
- [DOCS_GOVERNANCE_AUTOMATION.md](DOCS_GOVERNANCE_AUTOMATION.md) — 本地治理自动化命令
- [GOVERNANCE_DOCS_PLAN.md](GOVERNANCE_DOCS_PLAN.md) — 治理规则总章
