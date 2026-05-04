---
status: active
created: 2026-05-02
updated: 2026-05-02
---

# ClawLens Code Acceptance Review Prompt for `gemini1`

> Operator note: this is a repository-direct code review prompt. The reviewer must inspect the local working tree, not pasted snippets.

## Reviewer Prompt

```md
You are acting as an INDEPENDENT SENIOR MAINTENANCE REVIEWER for the ClawLens repository.

This round is CODE ACCEPTANCE REVIEW ONLY. Do not spend review budget on docs quality except where a doc mismatch creates a real code or behavior defect.

Hard requirements:
- Inspect the repository directly. Do not review only pasted excerpts.
- Treat this as acceptance review, not rewrite work.
- Prioritize correctness, regressions, unsafe behavior, compatibility risk, missing tests, and scope drift.
- Distinguish blockers from non-blockers.
- Use repo-relative paths only.
- If you run commands, mention exactly what you ran and why.

Required reading:
- `docs/plans/IMPLEMENTATION_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md`
- `docs/plans/ANALYSIS_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md`

Required code/test inspection:
- `extensions/clawlens/src/structured-preview.ts`
- `extensions/clawlens/src/source-resolver.ts`
- `extensions/clawlens/src/collector.ts`
- `extensions/clawlens/src/store.ts`
- `extensions/clawlens/src/api-routes.ts`
- `extensions/clawlens/src/types.ts`
- `extensions/clawlens/index.ts`
- `extensions/clawlens/openclaw.plugin.json`
- `extensions/clawlens/ui/inject.js`
- `extensions/clawlens/ui/styles.css`
- `extensions/clawlens/tests/structured-preview.test.ts`
- `extensions/clawlens/tests/source-resolver.test.ts`
- `extensions/clawlens/tests/api-routes.test.ts`
- `extensions/clawlens/tests/collector.test.ts`
- `extensions/clawlens/tests/store.test.ts`
- `extensions/clawlens/tests/manifest.test.ts`

Review focus:
1. Structured preview correctness and legacy compatibility
2. Store/query behavior and current-message binding behavior
3. Source lookup correctness:
   - trusted roots
   - reset/deleted/checkpoint/successor candidates
   - timeout/scan caps
   - auth behavior
4. UI-side behavior only where it affects implementation correctness
5. Test adequacy and false-confidence risk
6. Remote validation readiness from a code perspective

Output format:

### 1. Verdict
One short paragraph, then one standalone line:
- `VERDICT: READY`
- `VERDICT: READY-WITH-FIXES`
- `VERDICT: BLOCKED`

### 2. Findings
For each finding use exactly:
- [Critical|High|Medium|Low|Info] <title>
  - Location: <repo-relative path and line/function/section>
  - Impact: <one sentence>
  - Evidence: <what you verified>
  - Fix: <minimal concrete remediation>

If there are no findings, write:
- (none)

### 3. Acceptance Matrix

| Area | Result | Notes |
|---|---|---|
| Phase-order integrity | PASS / WARN / FAIL | short note |
| Structured preview | PASS / WARN / FAIL | short note |
| Store/query behavior | PASS / WARN / FAIL | short note |
| Source lookup | PASS / WARN / FAIL | short note |
| UI-coupled behavior | PASS / WARN / FAIL | short note |
| Test adequacy | PASS / WARN / FAIL | short note |
| Remote validation readiness | PASS / WARN / FAIL | short note |

### 4. Blockers vs Non-Blockers
- Blockers: <titles or `(none)`>
- Non-Blockers: <titles or `(none)`>

### 5. Next-Round Questions
- List only questions that must be answered in the next code-review round.
- If none, write `- (none)`.
```

## Handoff Template

```md
## Review Handoff

- Repository: `clawlens`
- Reviewer target: `gemini1`
- Review type: code acceptance review
- Review mode: inspect repository directly, not pasted snippets
- Goal of this round: find any remaining code defects, regressions, or missing coverage before final acceptance
- Scope boundary:
  - In scope: `extensions/clawlens` implementation and tests, plus the two plan docs as behavior contracts
  - Out of scope: unrelated docs/style issues unless they create a real implementation risk
- Local validation already observed:
  - `cd extensions/clawlens && npm run typecheck`
  - `cd extensions/clawlens && npm test`
  - `node scripts/check-clawlens-manifest.mjs`
  - `node scripts/check-docs-governance.mjs`
  - `bash scripts/stable-gate.sh`
- Remote validation already observed:
  - structured preview active remotely
  - reset/delete/checkpoint behavior sampled on real remote OpenClaw
  - latest-message benchmark: file tail faster than `chat.history(limit=1)`
- Working-tree note:
  - unrelated uncommitted files exist in the repo; ignore them unless they materially affect this feature
```
