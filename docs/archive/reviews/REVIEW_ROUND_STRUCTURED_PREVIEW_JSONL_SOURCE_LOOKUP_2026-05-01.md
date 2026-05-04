---
status: merged
superseded_by: docs/plans/IMPLEMENTATION_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md
created: 2026-05-01
updated: 2026-05-01
---

# Review Round Card — Structured Preview / JSONL Source Lookup Plan

- Review target: [docs/plans/IMPLEMENTATION_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md](../../plans/IMPLEMENTATION_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md)
- Review scope: implementation-plan correctness, sequencing, compatibility assumptions, UI/API boundary clarity, and docs governance fit for the active plan.
- Writer: `codex / GPT-5`
- Reviewer: `gemini1`
- Layer 4 trigger reason: multi-round external review over tmux with explicit persistence for cross-session recovery.

## Frozen Decisions

- D1: Keep the target document in `docs/plans/` during review; do not promote it to a top-level authority document during this review cycle.
- D2: Start with existing text columns for preview storage; no schema migration in the first structured-preview phase.
- D3: Use `__clawlensPreview.version === 1` as the only structured-preview marker.
- D4: Hover stays preview-only; full source must remain behind explicit user action.
- D5: Source lookup must stay behind authenticated plugin API routes and remain disabled unless trusted roots are available.

## Round 1 Handoff Header

```markdown
## Review Handoff (round 1 of estimated multi-round)

- Document: docs/plans/IMPLEMENTATION_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md
- Writer model: codex / GPT-5
- Reviewer target: gemini1
- Goal of this round: Review this implementation plan as an active design/implementation handoff. Find sequencing bugs, missing compatibility constraints, API/UI contract ambiguity, unsafe assumptions, and governance mismatches. Treat this as a plan review only; do not ask for code implementation.
- Open questions for this round:
  - Q1: Does the phase ordering cleanly protect existing transcript binding, logger preview mapping, and run-kind classification before structured preview storage changes land?
  - Q2: Are the proposed API markers and `hasSourceLookup` rules sufficiently precise for UI and backend implementers, or do they leave avoidable ambiguity?
  - Q3: Does the source-lookup design define trusted-root handling, reset/compaction traversal, auth requirements, and failure semantics tightly enough to implement without new policy decisions?
  - Q4: Are the acceptance gates and rollout sequencing complete, or is any critical precondition / verification step missing?
  - Q5: Does the plan leave any open decisions that are too central to defer?
- Frozen decisions (do not re-litigate):
  - D1: Keep the target document in `docs/plans/` during review; do not promote it during this review cycle.
  - D2: Start with existing text columns for preview storage; no schema migration in the first structured-preview phase.
  - D3: Use `__clawlensPreview.version === 1` as the only structured-preview marker.
  - D4: Hover stays preview-only; full source must remain behind explicit user action.
  - D5: Source lookup must stay behind authenticated plugin API routes and remain disabled unless trusted roots are available.
- Previous-round blockers addressed in this draft:
  - (none — round 1)
- Reviewer mis-citations (not addressed):
  - (none)
- Out-of-scope for this review:
  - Implementing the code changes
  - Promoting or archiving the document
  - Reviewing unrelated repo changes outside this plan and its directly referenced code surface
- Governance constraints to respect:
  - Keep the document as an active dated plan under `docs/plans/`
  - Do not assume arbitrary valid JSON implies structured-preview semantics without the explicit wrapper
  - Do not relax auth requirements for source lookup
  - Prefer findings grounded in this document’s current text and the currently described code surface
```

## Round Tracking

- Review cycle status: complete
- Final blocker count: 0
- Final reviewed draft version: draft v3

## Round 1 Outcome (2026-05-01)

- Reviewer verdict: **READY-WITH-FIXES**
- Findings summary:
  - [Medium] Ambiguous failure status convention for typed lookup misses
  - [Low] Resolver helper logic drift between Phase 0 and Phase 5
  - [Low] Unspecified redaction scope for source responses
  - [Info] Bounded candidate query window should be made explicit
- Writer disposition:
  - Ambiguous failure status convention — **VALID**
  - Resolver helper logic drift — **VALID**
  - Unspecified redaction scope — **PARTIAL but applied now**
  - Candidate query window explicitness — **PARTIAL but applied now**
- Fixes applied in draft v2:
  - Chose typed lookup misses = HTTP 200 with `ok: false`, leaving 404 for unknown rows and auth failures to auth-specific responses.
  - Added a shared `resolveTranscriptSourceCandidates(...)` interface to make Phase 0 and Phase 5 reuse the same candidate-resolution path.
  - Added a minimum baseline redaction key list for source responses.
  - Added an explicit default bounded candidate query window of about +/- 1 minute.

## Round 2 Handoff Header

```markdown
## Review Handoff (round 2 of estimated multi-round)

- Document: docs/plans/IMPLEMENTATION_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md
- Writer model: codex / GPT-5
- Reviewer target: gemini1
- Goal of this round: Confirm the round-1 findings are resolved in draft v2 without introducing new ambiguity. Focus on closure of the typed-miss HTTP convention, shared resolver interface, baseline redaction scope, and explicit candidate-window constraint.
- Open questions for this round:
  - Q1: Does the new typed-miss convention now leave enough clarity for route tests and UI miss-state handling?
  - Q2: Does the shared resolver interface now adequately prevent Phase 0 / Phase 5 parser drift?
  - Q3: Is the baseline redaction scope specific enough for initial rollout without overcommitting the implementation?
  - Q4: Does the explicit +/- 1 minute candidate-query window improve implementability without creating a wrong hard guarantee?
- Frozen decisions (do not re-litigate):
  - D1: Keep the target document in `docs/plans/` during review; do not promote it during this review cycle.
  - D2: Start with existing text columns for preview storage; no schema migration in the first structured-preview phase.
  - D3: Use `__clawlensPreview.version === 1` as the only structured-preview marker.
  - D4: Hover stays preview-only; full source must remain behind explicit user action.
  - D5: Source lookup must stay behind authenticated plugin API routes and remain disabled unless trusted roots are available.
- Previous-round blockers addressed in this draft:
  - "Ambiguous Failure Status Convention" -> addressed in section "Phase 6: Source API Routes" and "Open Implementation Decisions"; changed sentence: "Return typed lookup misses as HTTP 200 with `ok: false`, and document that convention in route tests."
  - "Resolver Helper Logic Drift" -> addressed in section "Phase 0: Preview-Dependent Path Audit" and "Phase 5: JSONL Source Resolver"; changed sentence: "Phase 0 and Phase 5 must share the same transcript-candidate resolution entry point."
  - "Unspecified Redaction Scope" -> addressed in section "Phase 5: JSONL Source Resolver"; changed sentence: "Apply a baseline redaction pass to obvious sensitive keys before returning source payloads."
  - "Performance of Bounded Candidate Queries" -> addressed in section "Phase 0: Preview-Dependent Path Audit"; changed sentence: "keep the initial query to a small bounded range such as the same session plus a default `timestamp` window of about +/- 1 minute around the target event"
- Reviewer mis-citations (not addressed):
  - (none)
- Out-of-scope for this review:
  - Implementing the code changes
  - Promoting or archiving the document
  - Reviewing unrelated repo changes outside this plan and its directly referenced code surface
- Governance constraints to respect:
  - Keep the document as an active dated plan under `docs/plans/`
  - Do not assume arbitrary valid JSON implies structured-preview semantics without the explicit wrapper
  - Do not relax auth requirements for source lookup
  - Prefer findings grounded in this document’s current text and the currently described code surface
```

## Round 2 Outcome (2026-05-01)

- Reviewer verdict: **READY-WITH-FIXES**
- Findings summary:
  - [High] Secret leakage risk in structured previews
  - [Medium] Resource exhaustion risk from concurrent large JSONL scans
  - [Low] Redaction key matching should use substring containment
  - [Low] Structured preview tree state should persist across live refresh
  - [Info] Add an explicit 32 KiB SQLite round-trip test
- Writer disposition:
  - Secret leakage in structured previews — **VALID**
  - Resource exhaustion (concurrency) — **VALID**
  - Redaction scope substring matching — **VALID**
  - UI state inconsistency — **VALID**
  - Column length constraints test — **VALID**
- Fixes applied in draft v3:
  - Phase 1 now requires preview serialization to use the same baseline redaction helper as Phase 5 full-source responses.
  - Phase 5 now defines an initial max concurrent scan count of 1 and requires stream-based/incremental scan behavior.
  - Baseline redaction matching is now defined as case-insensitive substring containment.
  - Phase 4 now requires expansion/pin state to be keyed by stable identifiers through live refresh.
  - The test plan now includes a 32 KiB preview SQLite round-trip assertion.

## Round 3 Handoff Header

```markdown
## Review Handoff (round 3 of estimated multi-round)

- Document: docs/plans/IMPLEMENTATION_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md
- Writer model: codex / GPT-5
- Reviewer target: gemini1
- Goal of this round: Confirm that the round-2 blockers are resolved in draft v3, with special attention to preview redaction parity and source-scan resource controls. This is a closure check.
- Open questions for this round:
  - Q1: Does draft v3 now close the secret-leakage gap between stored previews and full-source responses?
  - Q2: Is the source-resolver concurrency/resource guidance now specific enough for safe initial implementation?
  - Q3: Do the substring redaction rule, refresh-stable UI state requirement, and 32 KiB storage test remove the remaining low-level ambiguity?
- Frozen decisions (do not re-litigate):
  - D1: Keep the target document in `docs/plans/` during review; do not promote it during this review cycle.
  - D2: Start with existing text columns for preview storage; no schema migration in the first structured-preview phase.
  - D3: Use `__clawlensPreview.version === 1` as the only structured-preview marker.
  - D4: Hover stays preview-only; full source must remain behind explicit user action.
  - D5: Source lookup must stay behind authenticated plugin API routes and remain disabled unless trusted roots are available.
- Previous-round blockers addressed in this draft:
  - "Secret Leakage in Structured Previews" -> addressed in section "Phase 1: Shared Structured Preview Builder and Feature Gates"; changed sentence: "`buildStructuredPreview` and `serializePreviewForTextColumn` must apply the same baseline sensitive-key redaction policy used by full source lookup before any preview is serialized into SQLite text columns."
  - "Resource Exhaustion (Concurrency)" -> addressed in section "Phase 5: JSONL Source Resolver"; changed sentence: "maximum concurrent scans per process: 1 initially, with later expansion requiring explicit load testing"
  - "Redaction Scope (Substring Match)" -> addressed in section "Phase 5: JSONL Source Resolver"; changed sentence: "case-insensitive substring matching for `key`, `token`, `password`, `secret`, `authorization`, `cookie`, `set-cookie`, `api-key`, and `x-api-key`"
  - "UI State Inconsistency" -> addressed in section "Phase 4: UI Structured Preview Rendering"; changed sentence: "Tree expansion, collapse, and pin state must survive live refresh by keying UI state to stable row identifiers such as `messageId`, `runId`, and `toolCallId`."
  - "Column Length Constraints" -> addressed in section "Test Plan"; changed sentence: "a 32 KiB structured preview payload survives SQLite storage and readback without silent truncation."
- Reviewer mis-citations (not addressed):
  - (none)
- Out-of-scope for this review:
  - Implementing the code changes
  - Promoting or archiving the document
  - Reviewing unrelated repo changes outside this plan and its directly referenced code surface
- Governance constraints to respect:
  - Keep the document as an active dated plan under `docs/plans/`
  - Do not assume arbitrary valid JSON implies structured-preview semantics without the explicit wrapper
  - Do not relax auth requirements for source lookup
  - Prefer findings grounded in this document’s current text and the currently described code surface
```

## Round 3 Outcome (2026-05-01)

- Reviewer verdict: **READY**
- Findings summary:
  - No blockers.
  - [Info] Keep the redaction helper export shared between preview generation and source lookup.
  - [Info] Prefer a default "reject" behavior for scan-concurrency collisions to avoid backpressure during large scans.
- Review closure:
  - Round 1 closed the typed-miss convention, shared resolver interface, baseline redaction scope, and candidate window ambiguity.
  - Round 2 closed preview redaction parity, source-scan concurrency constraints, refresh-stable UI state, and the 32 KiB SQLite round-trip test requirement.
  - Round 3 confirmed the implementation plan is ready for downstream coding work without reopening the core design.

## Final Outcome

- Final reviewer verdict: **READY**
- Remaining items are non-blocking implementation preferences, not document blockers.
- This review round card is archived as completed external review evidence for the active implementation plan.

## Next Action

1. Assemble the round 1 review package.
2. Dispatch it to `gemini1` through the tmux review flow.
3. Capture Gemini output and classify each finding as `VALID`, `PARTIAL`, or `INVALID` against the current document before editing the plan.
4. Run a closure-check round after the blocker fixes land.

## Recovery Notes

If the writer session is cleared or replaced before the review closes:

1. Re-open this round-card first.
2. Reconstruct the current review round from the latest recorded handoff and outcome section.
3. Continue the review loop only after restoring the target document path, frozen decisions, and remaining blocker list.
