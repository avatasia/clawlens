# ClawLens UI preview/source interaction and copy actions implementation

Use your highest-capability available model for this implementation if your environment allows model selection.

You are now implementing, not reviewing.

Work in the `.` repository. Read the implementation plan and edit the real files directly. Do not stop at analysis.

## Required context

Read these first:

- `AGENTS.md`
- `docs/plans/IMPLEMENTATION_CLAWLENS_UI_PREVIEW_INTERACTION_AND_COPY_ACTIONS_2026-05-02.md`
- `extensions/clawlens/ui/inject.js`
- `extensions/clawlens/ui/styles.css`
- any existing tests that are directly relevant

Start with:

- `git status --short`

Treat existing uncommitted changes as the user's working tree. Do not revert unrelated changes.

## Task

Implement the approved UI-only plan from:

- `docs/plans/IMPLEMENTATION_CLAWLENS_UI_PREVIEW_INTERACTION_AND_COPY_ACTIONS_2026-05-02.md`

Concrete goals:

1. Fix preview surface lifetime
   - hover can open
   - moving the mouse away must not auto-close
   - click outside closes
   - clicking another turn switches context without hide/show flicker
   - detail lock must not be overridden by pure hover

2. Fix source/detail surface stability
   - remove width jitter when loading source
   - keep bottom gutter / scroll usability for long content
   - make preview/source transition feel like one continuous detail surface

3. Add copy actions
   - add `Copy` next to each turn/tool `Source`
   - add run-level `Copy` next to `Turns`
   - copy must not trigger extra source requests
   - use cached source only if already loaded

4. Keep scope tight
   - no backend changes
   - no schema changes
   - no unrelated UI redesign

## Implementation constraints from the approved plan

Honor these explicitly:

1. `S.previewPinnedKey` remains the sole writable mode truth
   - do not add a parallel writable `previewMode`
2. when `S.previewPinnedKey != null`, keep `S.previewSurfaceKey === S.previewPinnedKey`
3. detail lock ignores pure hover context switching
4. copy feedback must not rely on full preview rerender
5. Source + Copy layout must not keep the old single-button absolute-position assumption
6. message turns should explicitly carry `data-source-kind="message"`
7. explicit click / keyboard switching to a new turn:
   - use cached source immediately if present
   - otherwise reset that turn's source section to idle

## Validation

You should implement and validate as much as possible locally.

At minimum run:

- `cd extensions/clawlens && npm run typecheck`
- `cd extensions/clawlens && npm test`
- `cd extensions/clawlens && node --check ui/inject.js`

If you add front-end interaction tests, run them as part of `npm test`.

## Later remote verification hint

After implementation, another round will handle remote deployment and UI verification.
When that happens, you may use browser network inspection / capture to verify:

1. hover does not trigger source requests
2. clicking `Source` does trigger the request
3. clicking `Copy` does not trigger extra source requests

## Output format

When done, report:

1. what files you changed
2. what behaviors were fixed
3. what tests/validation you ran
4. any remaining limitation or manual verification item

