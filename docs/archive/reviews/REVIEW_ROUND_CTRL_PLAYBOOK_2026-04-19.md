---
status: merged
superseded_by: docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md
created: 2026-04-19
updated: 2026-04-19
---

# Review Round Card — CTRL Playbook (rounds 1–5)

- 评审对象：[docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md](../../PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md)
- Writer：`claude-opus-4-7`
- Reviewer：codex（cross-family，跨轮保持同一 reviewer）
- 评审周期：2026-04-19 起，预期 > 1 天 → 触发 Layer 4 落盘
- 当前状态：round 5 reviewer 回执 READY（无 findings），`review-processor` subagent 核验 `READY_CONFIRMED`，已归档

## 冻结决策（carried forward through round 5）

- **D1**：Writer 为 Opus 4.7；primary reviewer 跨家族；跨轮保持同一 reviewer。（round 1）
- **D2**：Layer 3 TaskList 为 ephemeral；Layer 4 落盘仅在「评审周期 > 1 天 / 多人接手 / 归档证据链」任一成立时触发。（round 2）
- **D3**：TaskList 禁止落盘到 `docs/`。（round 2）
- **D4**：Layer 3 同轮 `/compact` 例外存在；其它丢失场景一律落到 Layer 4 或从 round 1 重启。（round 3）
- **D5**：Reviewer 输出默认触发 `review-processor` subagent；main agent 从不直接按 reviewer 原文改文档。（round 3）
- **D6**：`Previous-round blockers addressed in this draft` 每条必须四字段齐全（finding title verbatim + section heading + line range + exact quoted sentence）。（round 3）
- **D7**：Frozen-decision 挑战走 Hold / Downgrade / Escalate；silent ignore 禁止；Hold rationale 本身仍可被挑战。（round 3）
- **D8**：成本表与 reviewer 模型表标为 heuristic（order-of-magnitude，未经 A/B 验证）。（round 3）
- **D9**：INVALID findings 独立写入 `Reviewer mis-citations (not addressed)` Handoff 段，不挤入 `Previous-round blockers addressed`。（round 4）
- **D10**：`/clear` / 重启 / 新 session / 新机器后，Layer 3/4 恢复完成前禁止 `TaskUpdate` 与下一 Handoff 生成。（round 4）

## Round 4 blockers → all addressed in v5 draft

| Round-4 finding | Playbook section | Line |
|---|---|---|
| INVALID findings routed into wrong Handoff channel | "Reviewer 输出回到 Claude 后的默认动作" / Handoff template | 155 + 187–191 |
| `/clear` recovery ordering under-specified | "Reviewer 输出回到 Claude 后的默认动作" step 0 | 152 |
| Same-turn `/compact` gate omits 未跨新机器 | "Layer 3 — 跨 session 续跑" | 74 |

证据四字段详见下方 round 5 Handoff Header 的 `Previous-round blockers addressed in this draft` 段。

## Round 5 Handoff Header（贴给 reviewer）

```markdown
## Review Handoff (round 5 of estimated 5)

- Document: docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md
- Writer model: claude-opus-4-7
- Reviewer target: codex (cross-family, stable across rounds 1–5)
- Goal of this round: Confirm READY after the three structural fixes closed all round-4 blockers. Either green-light or raise remaining structural / process blockers — no new scope, no wording-only nits.
- Open questions for this round:
  - Q1: Does line 155 together with the Handoff template block at lines 187–191 cleanly separate `Reviewer mis-citations (not addressed)` from `Previous-round blockers addressed in this draft`, so INVALID findings no longer pollute the four-evidence-field channel?
  - Q2: Is step 0 at line 152 sufficient to forbid `TaskUpdate` and next-Handoff generation before Layer 3/4 recovery, or should it also forbid `review-processor` subagent dispatch until recovery succeeds?
  - Q3: At line 74, are all four negations (未跨 `/clear` / 未跨进程重启 / 未跨 session / 未跨新机器) now stated inside the positive admission gate itself, not only in the trailing prohibition?
- Frozen decisions (do not re-litigate):
  - D1: Writer Opus 4.7; primary reviewer stays cross-family; same reviewer held across rounds. (frozen round 1)
  - D2: Layer 3 TaskList ephemeral; Layer 4 落盘 only on 周期>1天 / 多人接手 / 归档证据链. (frozen round 2)
  - D3: TaskList must NOT be persisted under `docs/`. (frozen round 2)
  - D4: Layer 3 same-turn `/compact` exception exists; other loss modes fall to Layer 4 or round-1 restart. (frozen round 3)
  - D5: Reviewer output triggers `review-processor` subagent by default; main agent never edits directly from reviewer text. (frozen round 3)
  - D6: `Previous-round blockers addressed` entries MUST cite all four evidence fields. (frozen round 3)
  - D7: Frozen-decision challenges resolved via Hold / Downgrade / Escalate; silent ignore prohibited; Hold rationale itself challengeable. (frozen round 3)
  - D8: Cost table and reviewer-model table marked heuristic. (frozen round 3)
  - D9: INVALID findings live in dedicated `Reviewer mis-citations (not addressed)` Handoff section, NOT under `Previous-round blockers addressed`. (frozen round 4)
  - D10: After `/clear` / restart / new session / new machine, Layer 3/4 recovery completes before `TaskUpdate` or next-Handoff generation. (frozen round 4)
- Previous-round blockers addressed in this draft:
  - "INVALID findings are routed into the wrong Handoff channel" -> addressed in section "Reviewer 输出回到 Claude 后的默认动作" (line 155) and in the Handoff Header template (lines 187–191); changed sentence at line 155: "`INVALID` 条目 **不写入** `Previous-round blockers addressed in this draft`（该段保留给有四字段证据的实际修复），而是写入下一轮 Handoff Header 中独立新增的 `Reviewer mis-citations (not addressed)` 段，格式为 `- \"<finding title verbatim>\" — mis-citation in round N, counter-evidence: \"<file:line quoted text>\"`"
  - "/clear recovery ordering is still under-specified" -> addressed in section "Reviewer 输出回到 Claude 后的默认动作" (line 152); changed sentence: "若 `TaskList` 返回 0 条匹配任务（因 `/clear`、进程重启、新 session、新机器等导致），先按 Layer 3 恢复回合状态（同轮 `/compact` 例外适用；其它场景按 Layer 3 步骤 2、3 降级到 Layer 4 或从第 1 轮重启）。**恢复完成前禁止执行 `TaskUpdate`、禁止生成下一个 Handoff Header**；subagent 验收可以并行启动（它不依赖 TaskList），但其输出必须等回合卡恢复后再落到 Handoff。"
  - "Same-turn /compact exception omits one negation in the admission gate" -> addressed in section "Layer 3 — 跨 session 续跑（TaskList 维护"评审回合卡"）" (line 74); changed sentence: "未跨 `/clear`、未跨进程重启、未跨 session、未跨新机器——允许直接从当前对话重建 card"
- Reviewer mis-citations (not addressed):
  - (none this round — all three round-4 findings were validated VALID by the `review-processor` subagent and addressed above)
- Out-of-scope for this review:
  - Cost table numeric precision (已标 heuristic)
  - Reviewer model selection table (已标 heuristic)
  - Writer-side budget / 5h quota handling (operator concern, not playbook scope)
  - Assembly script behavior (separate artifact)
- Governance constraints to respect:
  - Top-level `docs/*.md` must not contain dates.
  - Sub-directory READMEs must index all `.md` files.
  - No absolute repo-root paths in content.
  - Bidirectional `DOC_INDEX` / `CODE_INDEX` must stay consistent.
```

## 跨 session 恢复指引（供下一个 Claude session 使用）

下次新开 session 时，按以下顺序恢复：

1. **读本文件**恢复 D1–D10 frozen decisions 与 round-5 Handoff Header。
2. 把 reviewer 回执（round-5 output）粘给 main agent。
3. 按 playbook §"Reviewer 输出回到 Claude 后的默认动作" **step 0** 先重建 TaskList 回合卡（`TaskCreate`，字段从本文件取），**恢复成功后**再 dispatch `review-processor` subagent。
4. 按验收清单 apply VALID / PARTIAL 修复，INVALID 写入下一轮 Handoff 的 `Reviewer mis-citations (not addressed)`。
5. 若 reviewer 回执为 READY，把本文件 `status` 改为 `merged`，`superseded_by` 指向 `docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md`，按 Layer 4 归档 SOP 原子移入 `docs/archive/reviews/` 并登记 `docs/archive/history/` 下对应主题索引；若无主题索引，同 commit 内新建。

## 相关文件

- 评审主文档：[../../PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md](../../PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md)
- Reviewer 提示词：[../../prompts/ANALYSIS_PROMPT_PLAYBOOK_EXTERNAL_REVIEW.md](../../prompts/ANALYSIS_PROMPT_PLAYBOOK_EXTERNAL_REVIEW.md)
- 评审包组装脚本：[../../../scripts/assemble-review-package.sh](../../../scripts/assemble-review-package.sh)
- 治理归档 SOP：[../../GOVERNANCE_DOCS_PLAN.md](../../GOVERNANCE_DOCS_PLAN.md)
