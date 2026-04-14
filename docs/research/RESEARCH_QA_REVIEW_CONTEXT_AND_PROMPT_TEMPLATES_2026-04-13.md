# RESEARCH: QA Review Context + Prompt + Output Templates (2026-04-13)

## 目的

沉淀一套可复用的 QA 文档评审输入模板，避免“只给一句话评审”导致结果不稳定。本文将以下内容合并为一份研究记录：

1. 上下文包模板（Context Pack）
2. 评审提示词模板（Review Prompt）
3. 评审输出格式模板（Output Skeleton）
4. 三者区别与推荐使用方式（含分轮/漏斗式评审）

## 三者区别（先看这个）

| 模板 | 性质 | 作用 | 何时必须用 |
|---|---|---|---|
| Context Pack | 输入数据模板 | 给模型“事实上下文” | 多文档、跨代码、需要高可复现 |
| Review Prompt | 指令模板 | 告诉模型“怎么审” | 所有评审都需要 |
| Output Skeleton | 输出约束模板 | 统一评审报告结构 | 团队协作/需对比多轮结果 |

结论：

- 快速单轮评审：`Review Prompt` 即可。
- 严格评审（高准确）：`Context Pack + Review Prompt + Output Skeleton`。
- 漏斗式评审：第一轮可简化 Context；第二轮和终审使用完整三件套。

## 模板 A: Context Pack（可填写版）

```markdown
# Review Context Pack Template

## 1) Task Objective
- Goal:
- What decision is needed from reviewer:
- Expected output format:

## 2) Scope / Non-Scope
- In scope:
- Out of scope:
- Hard constraints:
  - e.g. local QA only, no remote deployment
  - no broad rewrites, minimal targeted changes

## 3) Baseline Snapshot
- Date/time (absolute):
- Branch:
- Tag/version:
- `git status --short`:
- `git log --oneline -10`:

## 4) Environment Contract
- OS / shell:
- Node path (must use):
- pnpm path (must use):
- openclaw binary path (must use):
- Port constraints:
  - Gateway:
  - QA Lab UI:
  - Known conflicts:
- Docker prerequisites (if applicable):
- Proxy prerequisites (if applicable):

## 5) Source of Truth Files
- SOP doc:
- Research doc(s):
- Analysis doc(s):
- Related governance/policy doc(s):
- Code files to verify against:

## 6) Changes in This Round
- Added files:
- Modified files:
- Deleted files:
- For each file: why changed + intended impact

## 7) Evidence Bundle (Required)
- Commands run (exact):
- Key command outputs (raw):
- API checks (request + response snippet):
  - overview:
  - sessions:
  - audit:
- Logs:
- Screenshots/URLs (if UI involved):

## 8) Validation Criteria
- Pass criteria per step:
- Fail criteria per step:
- Blocking vs non-blocking definition:

## 9) Open Risks / Unknowns
- Known unknowns:
- Assumptions needing verification:
- Deferred items (with reason):

## 10) Reviewer Instructions
- Review focus order:
  1. correctness
  2. reproducibility
  3. consistency
- Must classify each finding:
  - severity: Critical/High/Medium/Low/Info
  - type: regression / pre-existing debt
  - evidence reference (file + line / command output)
  - fix recommendation (minimal)

## 11) Deliverables Expected from Reviewer
- A) Findings list (severity-ranked)
- B) Executability verdict for SOP
- C) Consistency verdict across docs
- D) Final go/no-go and blockers
```

## 模板 B: Review Prompt（标准版）

```markdown
You are reviewing a documentation package for ClawLens QA Lab local validation.

Use the provided Context Pack as source of truth. Do not infer missing facts when raw evidence is absent; mark as "unverified".

Review targets:
1) SOP executability
2) Technical correctness vs evidence
3) Cross-document consistency
4) Promotion readiness (draft -> authoritative)

Rules:
- Prefer evidence-backed findings only.
- Distinguish regression vs pre-existing debt.
- Recommend minimal, targeted fixes.
- Use repo-relative paths.
- If a claim cannot be verified from provided evidence, flag explicitly.

Output format (strict):
1. Automated Check Results (table)
2. Severity-Ranked Findings (Critical -> Info)
3. Technical Accuracy Verdict (per-doc table)
4. Cross-Document Consistency Verdict
5. Per-Topic Completeness Table
6. Pass/Fail Summary table by category
7. Blocking Items
8. Non-Blocking Cleanup (with effort: trivial/small/medium)
```

## 模板 C: Output Skeleton（报告骨架）

```markdown
## Section 1: Automated Check Results
| command | result | warnings |
|---|---|---|

## Section 2: Severity-Ranked Findings
### Critical
- [path:line] impact / recommendation / classification

### High
- ...

### Medium
- ...

### Low
- ...

### Info
- ...

## Section 3: Technical Accuracy Verdict
| doc | status (Accurate/Drift/Stale/Conflict) | discrepancies |
|---|---|---|

## Section 4: Cross-Document Consistency Verdict
- conflict list or "No cross-doc conflicts detected."

## Section 5: Per-Topic Completeness Table
| Topic | Authoritative Doc | History | Archive Clean | Verdict |
|---|---|---|---|---|

## Section 6: Pass/Fail Summary
| Category | Result | Notes |
|---|---|---|

## Section 7: Blocking Items
- ...

## Section 8: Non-Blocking Cleanup
- [item] effort: trivial/small/medium
```

## 分轮评审建议（与“两个提示词”关系）

如果后续需要“同一任务同时给两种评审提示词”，建议固定为以下组合：

1. 第一轮（Strict Defect Pass）
- 目标：只抓错误与阻断项，低噪声。
- 输入：最小 Context Pack + 严格 Prompt。
- 输出：只要 Critical/High，禁止泛化建议。

2. 第二轮（Consolidation Pass）
- 目标：汇总第一轮结果，补一致性与优先级。
- 输入：完整 Context Pack + 第一轮 findings + 标准 Prompt。
- 输出：最终 blocker 列表 + 可执行修复顺序。

说明：

- 第一轮像“专职找问题”。
- 第二轮像“主审整合与裁决”。
- 若任务风险高，可加第三轮 Go/No-Go（仅检查放行条件）。

## 适用边界

- 本文是评审方法研究，不直接替代具体 SOP。
- 具体项目仍需附真实证据（命令输出、接口响应、代码行引用），否则只能得到“未验证结论”。
