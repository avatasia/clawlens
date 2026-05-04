---
status: active
created: 2026-05-02
updated: 2026-05-02
---

# ClawLens UI preview/source interaction code acceptance review

Use your highest-capability available model for this review if your environment allows model selection.

You are reviewing the implemented code, not proposing a fresh redesign.

Work in the `.` repository. Read the real files directly. Do not review only pasted snippets.

## Review target

- `docs/plans/IMPLEMENTATION_CLAWLENS_UI_PREVIEW_INTERACTION_AND_COPY_ACTIONS_2026-05-02.md`
- `extensions/clawlens/ui/inject.js`
- `extensions/clawlens/ui/styles.css`
- any directly relevant tests and validation output

## Required context

Read these before giving a verdict:

- `AGENTS.md`
- `docs/README.md`
- `docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md`
- `docs/plans/IMPLEMENTATION_CLAWLENS_UI_PREVIEW_INTERACTION_AND_COPY_ACTIONS_2026-05-02.md`
- `extensions/clawlens/ui/inject.js`
- `extensions/clawlens/ui/styles.css`
- any UI- or copy-related tests that are directly relevant

## Scope

This review is only about the UI interaction changes for:

1. preview surface lifetime
2. source/detail surface stability
3. preview/source transition coherence
4. run-level and turn-level copy actions

Do not expand scope into:

1. new backend routes
2. schema changes
3. broad UI redesign
4. unrelated audit features

## What to evaluate

Focus on:

1. Whether hover/detail/source state behavior matches the approved plan.
2. Whether the implementation avoids auto-close on mouse leave and only closes on outside click or explicit replacement.
3. Whether clicking `Source` keeps one continuous surface without avoidable width/height jitter.
4. Whether long source payloads remain scrollable without bottom clipping.
5. Whether `Copy` actions are correctly scoped:
   - run copy at `Turns`
   - turn/tool copy near `Source`
   - no implicit source fetch on copy
   - cached source included only when already loaded
6. Whether the implementation introduced duplicate state, dead branches, or event conflicts.
7. Whether local validation is adequate for this scope.

## Validation already run locally

The implementation has already run:

- `cd extensions/clawlens && node --check ui/inject.js`
- `cd extensions/clawlens && npm run typecheck`
- `cd extensions/clawlens && npm test`

Current local suite result: `151/151` passing.

Reviewer should still inspect whether any important UI-coupled risk remains despite those checks.

## Output format

Return:

1. `VERDICT:`
   - `READY`
   - `READY-WITH-FIXES`
   - `BLOCKED`
2. `Findings`
   - list only real bugs, regressions, state conflicts, missing validation, or design/implementation mismatch
   - order by severity
   - cite concrete file references
3. `What is already strong`
   - short list
4. `Required fixes before acceptance`
   - only if verdict is not `READY`
5. `Remote verification notes`
   - only if useful for the next deployment/verification round

Be strict about real behavioral issues. This is an acceptance review, not a brainstorming pass.
