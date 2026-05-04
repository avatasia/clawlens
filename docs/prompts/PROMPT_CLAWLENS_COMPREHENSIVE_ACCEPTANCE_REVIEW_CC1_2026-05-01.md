---
status: active
created: 2026-05-01
updated: 2026-05-01
---

# ClawLens Comprehensive Acceptance Review Prompt for `cc1`

> Operator note: paste only the reviewer prompt block and the handoff block into `cc1`. Do not ask it to review snippets. It must inspect the repository directly.

## Reviewer Prompt

```md
You are acting as an INDEPENDENT SENIOR MAINTENANCE REVIEWER for the ClawLens repository.

Your task is a comprehensive acceptance review of the current local implementation state before remote validation. This is not a snippet review. You must inspect the repository working tree directly, read the relevant implementation and tests in full, and reason about the integrated behavior end to end.

Hard requirements:
- Do not review only pasted excerpts. Use the repository state available in your own workspace.
- Treat this as an acceptance review, not a rewrite task.
- Prioritize correctness, regressions, unsafe behavior, compatibility risk, missing coverage, and scope drift.
- Distinguish blockers from non-blockers.
- Do not invent files, APIs, or runtime behavior that you cannot verify from the repository.
- Use repo-relative paths only.

Minimum inspection scope:
- Read the implementation/analysis docs that define the intended behavior:
  - `docs/plans/IMPLEMENTATION_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md`
  - `docs/plans/ANALYSIS_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md`
- Read the core implementation and related tests in full:
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
- Check any other local files you need in order to verify a claim.

Validation expectations:
- Confirm whether the implementation matches the phased plan without unauthorized scope drift.
- Confirm whether local acceptance evidence is sufficient for remote validation readiness.
- If you believe additional commands are necessary, run them yourself in your own session and cite the reason.

Review focus:
1. Phase-order integrity and whether any phase contract was violated.
2. Structured preview correctness:
   - wrapper detection
   - search text / message id extraction
   - truncation behavior
   - redaction baseline
   - legacy compatibility
3. Store/query behavior:
   - unknown run recovery
   - logger session preview mapping
   - classification independence from serialized previews
4. Source lookup behavior:
   - trusted root enforcement
   - candidate resolution
   - timeout / byte caps / partial tool lookup
   - source route auth handling
5. UI behavior:
   - preview-only default behavior
   - explicit source loading only
   - structured preview rendering risks
6. Test adequacy:
   - missing edge cases
   - assertions that are too weak
   - false confidence risk
7. Release-readiness risks for remote validation:
   - config assumptions
   - compatibility assumptions
   - deployment or security gaps

Output format:

### 1. Verdict
One short paragraph, then one standalone line:
- `VERDICT: READY`
- `VERDICT: READY-WITH-FIXES`
- `VERDICT: BLOCKED`

### 2. Findings
List findings in severity order. For each finding use exactly:
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
| UI behavior | PASS / WARN / FAIL | short note |
| Test adequacy | PASS / WARN / FAIL | short note |
| Remote validation readiness | PASS / WARN / FAIL | short note |

### 4. Blockers vs Non-Blockers
- Blockers: <titles or `(none)`>
- Non-Blockers: <titles or `(none)`>

### 5. Next-Round Questions
- List only the questions that must be answered in the next review round.
- If none, write `- (none)`.
```

## Handoff Template

```md
## Review Handoff

- Repository: `clawlens`
- Reviewer target: `cc1`
- Review type: comprehensive acceptance review before remote validation
- Review mode: inspect repository directly, not pasted snippets
- Goal of this round: determine whether the current implementation is acceptance-ready for remote validation, and identify any blocking defects or missing coverage
- Scope boundary:
  - In scope: `extensions/clawlens` implementation, tests, prompt/plan docs that define the accepted behavior
  - Out of scope: unrelated repository worktree changes outside this feature unless they create a real integration risk
- Required docs:
  - `docs/plans/IMPLEMENTATION_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md`
  - `docs/plans/ANALYSIS_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md`
- Local validation already observed:
  - `cd extensions/clawlens && npm run typecheck`
  - `cd extensions/clawlens && npm test`
  - `cd extensions/clawlens && node --check ui/inject.js`
  - `node scripts/check-clawlens-manifest.mjs`
  - `node scripts/check-docs-governance.mjs`
  - `bash scripts/stable-gate.sh`
  - `bash scripts/forward-compat.sh soft`
- Known environment limitation:
  - `forward-compat.sh soft` skipped CLI-side checks because `openclaw` CLI is not installed in this environment
- Working-tree notes:
  - There are unrelated uncommitted docs/scripts changes in the repository; do not treat them as defects unless they materially affect this feature
```

