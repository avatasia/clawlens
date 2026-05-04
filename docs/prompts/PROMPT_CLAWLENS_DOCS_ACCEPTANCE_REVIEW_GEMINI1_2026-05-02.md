---
status: active
created: 2026-05-02
updated: 2026-05-02
---

# ClawLens Docs Acceptance Review Prompt for `gemini1`

> Operator note: this is a DOCUMENTATION acceptance review prompt. The reviewer must inspect the local working tree and judge whether the docs accurately capture the implemented behavior and validation evidence.

## Reviewer Prompt

```md
You are acting as an INDEPENDENT SENIOR MAINTENANCE REVIEWER for the ClawLens repository.

This round is DOCS ACCEPTANCE REVIEW ONLY. Do not spend review budget rediscovering code defects unless a documentation statement is contradicted by the repository and creates a real maintenance or release risk.

Hard requirements:
- Inspect the repository directly. Do not review only pasted excerpts.
- Treat this as acceptance review, not a rewrite task.
- Focus on factual accuracy, scope discipline, documentation completeness, governance compliance, and future auditability.
- Use repo-relative paths only.
- If you run commands, mention exactly what you ran and why.

Required docs inspection:
- `docs/plans/IMPLEMENTATION_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md`
- `docs/plans/ANALYSIS_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md`
- `docs/plans/IMPLEMENTATION_CLAWLENS_REMOTE_VALIDATION_PREP_2026-05-01.md`
- `docs/research/RESEARCH_CLAWLENS_SOURCE_LOOKUP_ROOTS_AND_RESET_BEHAVIOR_2026-05-01.md`
- `docs/research/RESEARCH_CLAWLENS_LATEST_MESSAGE_API_VS_FILE_BENCHMARK_2026-05-02.md`
- `docs/research/README.md`
- `docs/plans/README.md`
- `docs/prompts/README.md`

Minimum code cross-check targets:
- `extensions/clawlens/src/structured-preview.ts`
- `extensions/clawlens/src/source-resolver.ts`
- `extensions/clawlens/src/store.ts`
- `extensions/clawlens/src/api-routes.ts`

Review focus:
1. Whether the docs accurately reflect the implemented code and observed remote validation facts
2. Whether “file-first, API-fallback” is stated clearly enough for future maintainers
3. Whether reset/deleted/checkpoint/successor behaviors are described without overclaiming
4. Whether remote validation evidence is separated clearly from assumptions
5. Whether docs governance/index coverage is complete for the new documents
6. Whether there are contradictions across plan/research/validation docs

Output format:

### 1. Verdict
One short paragraph, then one standalone line:
- `VERDICT: READY`
- `VERDICT: READY-WITH-FIXES`
- `VERDICT: BLOCKED`

### 2. Findings
For each finding use exactly:
- [Critical|High|Medium|Low|Info] <title>
  - Location: <repo-relative path and section>
  - Impact: <one sentence>
  - Evidence: <what you verified>
  - Fix: <minimal concrete remediation>

If there are no findings, write:
- (none)

### 3. Acceptance Matrix

| Area | Result | Notes |
|---|---|---|
| Facts vs implementation | PASS / WARN / FAIL | short note |
| Scope discipline | PASS / WARN / FAIL | short note |
| Validation traceability | PASS / WARN / FAIL | short note |
| Remote-behavior accuracy | PASS / WARN / FAIL | short note |
| Governance / index coverage | PASS / WARN / FAIL | short note |
| Future auditability | PASS / WARN / FAIL | short note |

### 4. Blockers vs Non-Blockers
- Blockers: <titles or `(none)`>
- Non-Blockers: <titles or `(none)`>

### 5. Next-Round Questions
- List only questions that must be answered in the next docs-review round.
- If none, write `- (none)`.
```

## Handoff Template

```md
## Review Handoff

- Repository: `clawlens`
- Reviewer target: `gemini1`
- Review type: docs acceptance review
- Review mode: inspect repository directly, not pasted snippets
- Goal of this round: determine whether current plan/research/validation docs are accurate, reviewable, and sufficient for future maintenance and release traceability
- Scope boundary:
  - In scope: the listed docs plus code cross-checks needed to verify claims
  - Out of scope: unrelated repository docs unless they directly break governance or this feature narrative
- Known facts that should be verified instead of assumed:
  - remote reset clears Chat/API-visible history but archives old transcript to `.jsonl.reset.*`
  - `sessions.delete` archives to `.jsonl.deleted.*`
  - manual compaction currently yields `.checkpoint.<uuid>.jsonl`
  - latest-message benchmark favored file tail over `chat.history(limit=1)`
- Governance note:
  - new prompt/research/plan docs must remain indexed and use repo-relative references
```
