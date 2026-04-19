---
status: merged
superseded_by: docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md
created: 2026-04-19
updated: 2026-04-19
---

# Review Round Card — CTRL Playbook D11 Addition (rounds 1–2)

- 评审对象：[docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md](../../PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md)
- 评审范围：D11 "Context high-water 决策" 节新增 + Layer 2 标题/首句松绑 + Layer 4 触发列表新增第 4 条 + 成本表补一行。全部变更均为同一 commit。
- Writer：`claude-opus-4-7`
- Reviewer：codex（延续 round 1–5 的 cross-family 同一 reviewer，复用其对本 playbook 的既有语境）
- 前序评审：rounds 1–5 已于 2026-04-19 READY 归档，见 [REVIEW_ROUND_CTRL_PLAYBOOK_2026-04-19.md](REVIEW_ROUND_CTRL_PLAYBOOK_2026-04-19.md)
- Layer 4 触发理由：评审产物进归档证据链；同时若本轮未一次 READY，评审周期将 > 1 天

## 前序冻结决策（从 rounds 1–5 继承，D11 不重开）

D1–D10 原文见 [REVIEW_ROUND_CTRL_PLAYBOOK_2026-04-19.md](REVIEW_ROUND_CTRL_PLAYBOOK_2026-04-19.md)。本轮 Handoff Header 仅列与 D11 存在直接耦合的子集（D2 / D4 / D7 / D10），其余 D1 / D3 / D5 / D6 / D8 / D9 不在本轮作用域。

## Round 1 Handoff Header（贴给 reviewer）

```markdown
## Review Handoff (round 1 of estimated 2)

- Document: docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md
- Writer model: claude-opus-4-7
- Reviewer target: codex (cross-family, same reviewer as rounds 1–5 of the prior review cycle)
- Goal of this round: Validate that the newly added §"Context high-water 决策：/compact-continue vs /clear-restart" cleanly composes with existing Layer 2, Layer 3, Layer 4, D7 (frozen-decision challenge handling), and D10 (post-clear recovery ordering), without introducing implicit conflicts or duplicated triggers. Confirm the new cost-table row is consistent with the heuristic disclaimer above it. Do NOT re-litigate D1–D10 frozen in the prior review cycle.
- Open questions for this round:
  - Q1: Does the Path B 5-step sequence (create/update Layer 4 card → update plans README + under-external-review marker → git-commit → /clear → Layer 3 step-0 recovery) cleanly compose with the existing Layer 3 recovery steps 1–3? Is any recovery edge missed (e.g., Layer 4 file exists but was not committed before /clear)?
  - Q2: Is the "不作为高水位触发信号" negative list sufficient to prevent D11 from overlapping with D7 (reviewer re-challenging frozen items → Hold / Downgrade / Escalate) and with writer-side budget concerns (already scoped out in round 5)?
  - Q3: Is the Layer 4 trigger list now internally consistent after adding the 4th bullet ("Writer 选择 /clear-restart")? Does it create a circular trigger with D11 step 1?
  - Q4: Does the new cost-table row ("Layer 4 persist + /clear-restart + 新 session 读 round-card") agree with the heuristic disclaimer that precedes the table, or does it imply precision the disclaimer disclaims?
  - Q5: Should D11 itself be added to the Frozen decisions list of the round-card once this review reaches READY, or does it live only in the playbook prose?
- Frozen decisions (do not re-litigate — carried forward from rounds 1–5 of the prior review cycle):
  - D2: Layer 3 TaskList ephemeral; Layer 4 落盘 only on 周期>1天 / 多人接手 / 归档证据链. (D11 extends this list with a 4th trigger — that extension IS in scope for this round.)
  - D4: Layer 3 same-turn `/compact` exception exists; other loss modes fall to Layer 4 or round-1 restart. (D11 Path B builds on this recovery path.)
  - D7: Frozen-decision challenges resolved via Hold / Downgrade / Escalate; silent ignore prohibited. (D11 explicitly excludes "reviewer repetition" as a high-water trigger to avoid overlap with D7.)
  - D10: After `/clear` / restart / new session / new machine, Layer 3/4 recovery completes before `TaskUpdate` or next-Handoff generation. (D11 is the pre-clear decision rule; D10 is the post-clear recovery rule. They must compose cleanly.)
- Previous-round blockers addressed in this draft:
  - (none — this is round 1 of a new review cycle for the D11 addition; no prior-round blockers exist)
- Reviewer mis-citations (not addressed):
  - (none)
- Out-of-scope for this review:
  - D1, D3, D5, D6, D8, D9 from the prior review cycle (frozen and not touched by D11)
  - Cost-table numeric precision (already marked heuristic in rounds 1–5)
  - Reviewer-model selection table (already marked heuristic in rounds 1–5)
  - Writer-side budget / 5h quota handling (explicitly scoped out in round 5)
  - Assembly script behavior (separate artifact)
- Governance constraints to respect:
  - Top-level `docs/*.md` must not contain dates.
  - Sub-directory READMEs must index all `.md` files.
  - No absolute repo-root paths in content.
  - Bidirectional `DOC_INDEX` / `CODE_INDEX` must stay consistent.
```

## Round 1 Outcome（2026-04-19）

- Reviewer verdict: **READY-WITH-FIXES**
- review-processor 验证结果：3 条 findings 全部为 VALID 或 PARTIAL，无 mis-citation
  - [High] Canonical flow still bypasses the D11 branch — **VALID**
  - [Medium] Uncommitted Layer 4 card has no defined post-clear recovery — **VALID**
  - [Low] 1-hour TTL wording is stale (pre-existing) — **PARTIAL**（范围排除 rationale 仍成立，仅改 framing）
- Fixes applied in draft v2（均在本轮同 commit 内）：
  - 标准每轮流程 diagram 增加 D11 两路分支节点（Path A /compact-continue / Path B Layer 4 persist + /clear-restart）
  - Layer 3 step 2 明确"未 git-commit 的 round-card 不得作为恢复源"，降级到步骤 3
  - 成本表 heuristic 注记把 1h TTL 改为"Anthropic 已在 API 层提供，但 Claude Code 未暴露接口，不建模"
- Open questions 归置：
  - Q1（end-of-round branch 顺序）→ 通过 Fix 1 diagram 分支回答
  - Q2（未 commit 的 round-card 恢复边）→ 通过 Fix 2 Layer 3 step 2 回答
  - Q3（Layer 4 触发表第 4 条循环）→ round 1 reviewer 未提新发现，视为 PASS
  - Q4（成本表新增行 vs heuristic disclaimer）→ round 1 reviewer 未提新发现，视为 PASS
  - Q5（D11 是否加入 Frozen decisions）→ 留到 round 2 READY 时再决定，不在本轮作用域

## Round 2 Handoff Header（贴给 reviewer）

```markdown
## Review Handoff (round 2 of estimated 2)

- Document: docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md
- Writer model: claude-opus-4-7
- Reviewer target: codex (cross-family, same reviewer as round 1 and as rounds 1–5 of the prior review cycle)
- Goal of this round: Confirm the three round-1 blockers are cleanly resolved in draft v2 without regressions, and that the diagram branch + Layer 3 step-2 amendment do not conflict with D2 / D4 / D7 / D10. Do NOT re-litigate D1–D10 frozen in the prior review cycle.
- Previous-round blockers addressed in this draft:
  - "Canonical flow still bypasses the D11 branch" —
    file:line before=docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md:178 (v1 single-node /compact)
    file:line after=docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md:178-191 (v2 two-node diagram with D11 decision + Path A/B branch)
    quoted text before: "... draft v(N+1) → TaskUpdate → /compact → verify TaskList still present; if empty, see Layer 3 recovery rules ..."
    quoted text after: "[Claude] §\"Context high-water 决策\" check (D11) — Path A or Path B, 不得默认继续叠加 / ├─ Path A /compact-continue → ... / └─ Path B Layer 4 persist (write/refresh round-card) → 原子 commit README + under-external-review marker → 确认 git-commit 已落盘 → /clear（或新 session）→ 新 session 按 §\"Reviewer 输出回到 Claude 后的默认动作\" step 0 走 Layer 3 恢复再续轮"
  - "Uncommitted Layer 4 card has no defined post-clear recovery" —
    file:line before=docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md:77 (v1 single sentence "若存在，读最新一份恢复语境")
    file:line after=docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md:77 (v2 amended — committed vs uncommitted explicitly split)
    quoted text before: "若存在，读最新一份恢复语境，视为 Layer 3 降级到 Layer 4。"
    quoted text after: "若存在，**先用 `git log -- <path>` 或 `git status` 确认该文件已 commit**；已 commit 则读最新一份恢复语境，视为 Layer 3 降级到 Layer 4。若文件存在但**未 git-commit**（典型场景：Path B 步骤 3 被跳过的裸 `/clear` 后文件仍残留在同机器 worktree 中），不得作为可信恢复源——视为 Layer 4 未持久化，降级到下一步从第 1 轮重启，并在下一轮 Handoff Header 的 `Reviewer mis-citations (not addressed)` 邻近独立记录本次 bare-/clear 事件以便后续审计。"
  - "1-hour TTL wording is stale (pre-existing)" —
    file:line before=docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md:286 (v1 conditional "若 Anthropic 后续开放")
    file:line after=docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md:286 (v2 factual "Anthropic 已在 API 层提供，但")
    quoted text before: "关于更长 TTL：本 playbook 不建模 \"1h 扩展 cache\"（若 Anthropic 后续开放）这类 API-level 选项，因为它不是 Claude Code session 内由 writer 决定的变量；等 API 层稳定提供 + Claude Code 暴露相应接口后再修本章。"
    quoted text after: "关于更长 TTL：Anthropic 已在 API 层提供 1h 扩展 cache，但本 playbook 不建模这类 API-level 选项，因为它不是 Claude Code session 内由 writer 决定的变量；等 Claude Code 暴露相应接口后再修本章。"
- Reviewer mis-citations (not addressed):
  - (none — round 1 的 3 条 findings 全部 VALID/PARTIAL，全部 applied)
- Open questions for this round:
  - Q1: 新 diagram 两路分支是否覆盖了 D11 节的全部决策表达（与 Path A/B 动作序列一致、不引入新的循环触发）？
  - Q2: Layer 3 step 2 的 committed-vs-uncommitted 分叉，是否与 Path B 步骤 3 "确认 Layer 4 文件已提交到 git" 形成无隙闭环？
  - Q3: 成本表 1h TTL 新措辞是否恰好落在 heuristic disclaimer 允许的范围内（承认 API 层存在、拒绝在本 playbook 建模）？
  - Q4: 进入 READY 时 D11 是否应当加入后续 round-card 的 Frozen decisions 列表、避免下一轮 reviewer 重开？
- Frozen decisions (do not re-litigate — carried forward from rounds 1–5 of the prior review cycle):
  - D2 / D4 / D7 / D10（内容同 round 1 Handoff）
- Out-of-scope for this review:
  - D1, D3, D5, D6, D8, D9 from the prior review cycle
  - Cost-table numeric precision（heuristic 已声明）
  - Reviewer-model selection table（heuristic 已声明）
  - Writer-side budget / 5h quota（round 5 已排除）
  - Assembly script behavior（separate artifact）
- Governance constraints to respect:
  - Top-level `docs/*.md` must not contain dates.
  - Sub-directory READMEs must index all `.md` files.
  - No absolute repo-root paths in content.
  - Bidirectional `DOC_INDEX` / `CODE_INDEX` must stay consistent.
```

## 本轮评审目标（operator view）

1. 验证 D11 与现有 Layer 2 / Layer 3 / Layer 4 / D7 / D10 的耦合一致性（不出现隐含冲突或循环触发）。
2. 验证 Path B 的 5 步 `/clear-restart` 动作序列是否完整、与 Layer 3 恢复路径是否无缝。
3. 验证 Layer 4 触发列表新增第 4 条不与其它 3 条重叠/矛盾。
4. 验证成本表新增行与 heuristic disclaimer 一致。
5. 不重开 D1–D10。

## 跨 session 恢复指引

若本轮未在当前 session 内闭环：

1. 下次新开 session 时先读本文件恢复 round 1 Handoff 与继承的 D2 / D4 / D7 / D10。
2. 把 reviewer 回执粘给 main agent。
3. 按 playbook §"Reviewer 输出回到 Claude 后的默认动作" **step 0** 先重建 TaskList，**恢复成功后**再 dispatch `review-processor` subagent。
4. READY 后按 Layer 4 归档 SOP 原子移入 `docs/archive/reviews/`，并登记 `docs/archive/history/` 下对应主题索引。

## Round 2 Outcome（2026-04-19）

- Reviewer verdict: **READY**（0 findings）
- Open questions 全部确认 Yes：
  - Q1: 新 diagram 两路分支完整覆盖 D11 决策（Path A/B，无第三隐含路径）
  - Q2: Layer 3 step 2 committed/uncommitted 分叉与 Path B "确认 git-commit 已落盘" 形成无隙闭环
  - Q3: 成本表 1h TTL 新措辞落在 heuristic disclaimer 允许范围内（承认 API 层存在，不建模）
  - Q4: D11 应加入后续 round-card Handoff Frozen decisions 列表（handoff hygiene，非本草稿缺陷）
- 残余风险：低；reviewer 补注 `git log -- <path>` 是 committed/uncommitted 检查的更强证明（prose 已自洽）
- **结论**：评审周期 READY，触发 Layer 4 归档 SOP

## 相关文件

- 评审主文档：[../../PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md](../../PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md)
- Reviewer 提示词：[../../prompts/ANALYSIS_PROMPT_PLAYBOOK_EXTERNAL_REVIEW.md](../../prompts/ANALYSIS_PROMPT_PLAYBOOK_EXTERNAL_REVIEW.md)
- 评审包组装脚本：[../../../scripts/assemble-review-package.sh](../../../scripts/assemble-review-package.sh)
- 前序评审归档：[REVIEW_ROUND_CTRL_PLAYBOOK_2026-04-19.md](REVIEW_ROUND_CTRL_PLAYBOOK_2026-04-19.md)
- 治理归档 SOP：[../../GOVERNANCE_DOCS_PLAN.md](../../GOVERNANCE_DOCS_PLAN.md)
