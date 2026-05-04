# ClawLens UI preview/source interaction design review

Use your highest-capability available model for this review if your environment allows model selection.

You are reviewing a design, not implementing it yet.

Work in the `.` repository. Read the design document directly and inspect the referenced UI code. Do not review only pasted snippets.

## Review target

- `docs/plans/IMPLEMENTATION_CLAWLENS_UI_PREVIEW_INTERACTION_AND_COPY_ACTIONS_2026-05-02.md`
- `extensions/clawlens/ui/inject.js`
- `extensions/clawlens/ui/styles.css`

## Context

This design addresses four concrete UI problems in ClawLens Chat Audit:

1. Hover preview surface closes too eagerly on mouseout.
2. Clicking `Source` causes preview width jitter and long-content bottom clipping.
3. Preview/source transitions inside the surface are abrupt/conflicting.
4. The UI lacks one-click copy for run detail and turn detail.

The intended workflow is:

1. Review the design for correctness and implementation risk.
2. If the design is acceptable, implementation will be delegated in a later round.
3. Later validation should include browser-network inspection to confirm hover does not trigger source requests and copy does not trigger unexpected fetches.

## What to evaluate

Focus on:

1. Whether the proposed interaction model is internally consistent.
2. Whether the hover/detail/source state split is implementable in the current `inject.js` architecture without unnecessary rewrites.
3. Whether the copy behavior is well-scoped and avoids hidden side effects.
4. Whether the acceptance boundaries are crisp enough to guide implementation and later QA.
5. Whether the proposal accidentally expands scope beyond the stated UI-only intent.

## What not to require

Do not require:

1. new backend routes
2. schema changes
3. broad UI redesign
4. speculative framework migrations

## Output format

Return:

1. `VERDICT:`
   - `READY`
   - `READY-WITH-FIXES`
   - `NOT-READY`
2. `Findings`
   - list only real design issues, ambiguities, regressions, or missing acceptance criteria
   - order by severity
   - cite file/section references where relevant
3. `What is already strong`
   - short list
4. `Required fixes before implementation`
   - only if verdict is not `READY`
5. `Optional suggestions`
   - only if they are truly non-blocking

Be strict about behavioral ambiguity. This is a design acceptance review, not a brainstorming session.

