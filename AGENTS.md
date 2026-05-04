# AGENTS.md

This file records the local rules that agents must follow when performing editing tasks in this repository.

## Document Editing Rules

1. If the user explicitly asks to "save as a new document", "create a new version file", or "do not overwrite the original file", do not modify the original file. Create a new file only.
2. If the target document has uncommitted changes, treat it as the user's working copy by default and do not perform major in-place rewrites.
3. If the target document can be clearly identified as an artifact newly created by the agent in the current conversation, and subsequent edits still happen in the same conversation with no sign that the user or another tool has taken over editing it, the agent may continue updating that new file directly unless the user explicitly asks again to "save as a separate file".
4. Before structurally rewriting a document, if modifying the original file is necessary, create a local backup copy first.
5. If an uncommitted file is modified by mistake, do not default to suggesting `git` recovery. Prefer editor local history, backup files, or system snapshots first.

## Output File Rules

1. Review, recheck, and regression-validation artifacts should preferably be written to new files with a date or version suffix.
2. If the user does not specify a filename but explicitly asks for a "new file", use the original filename plus a date suffix by default.

## Automatic Docs Governance Rules

Whenever the output, modification, or archive target is under `docs/`, automatically follow:

- `docs/GOVERNANCE_DOCS_PLAN.md`

The user does not need to repeat this requirement each time.

This specifically includes:

1. Automatically deciding whether the target belongs in:
   - top-level `docs/`
   - `docs/prompts/`
   - `docs/archive/<category>/`
2. Automatically following the document naming rules.
3. If archiving, automatically synchronizing:
   - reference path fixes
   - the corresponding `history` update
4. Automatically avoiding absolute paths to this project inside the `docs/` system. Internal project references must use repository-relative paths.
5. If the current `docs/` state conflicts with the governance rules, follow `docs/GOVERNANCE_DOCS_PLAN.md` by default.

## Pre-Edit Checks

Before performing any edit that might overwrite user content, confirm:

1. Whether the target file already has uncommitted changes.
2. Whether the user asked to modify the original file or generate a new file.
3. Whether a safe new file path already exists to hold the result.
4. If directly updating a new file, whether there is enough evidence that the file was created by the agent in the current conversation and is still being maintained by the agent.

## Project Startup Prompt

When a new agent takes over this repository, use the following startup prompt to establish context:

```text
You are working in the /home/chlli/github/clawlens repository. Treat yourself as a maintenance-oriented engineering agent for the ClawLens project, not as a script that only executes isolated commands.

Project positioning:
- ClawLens is an OpenClaw audit plugin focused on run-level observability for the Chat side.
- The main code lives under extensions/clawlens/. The entry point is index.ts. Core modules include src/collector.ts, src/store.ts, src/api-routes.ts, src/sse-manager.ts, src/logger-import.ts, src/logger-message-mapper.ts, plus ui/inject.js and ui/styles.css.
- The plugin collects agent lifecycle, transcript, llm_input, llm_output, after_tool_call, agent_end, and related events through OpenClaw runtime/hooks, writes them to a SQLite store, and exposes them through API/SSE for the Chat-side Audit UI.
- projects-ref/openclaw/ is a local OpenClaw reference checkout used to understand upstream interfaces and compatibility. It is not a runtime dependency.

Before starting work:
1. Read AGENTS.md, README.md, docs/README.md, docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md, and any code or documents directly relevant to the current task.
2. Run git status --short first to identify uncommitted changes. Treat existing uncommitted changes as the user's working copy by default; do not overwrite or roll them back.
3. If the task touches docs/, automatically follow docs/GOVERNANCE_DOCS_PLAN.md, including target directory selection, naming, frontmatter, README coverage, history updates, and reference path fixes.
4. If the task involves OpenClaw compatibility, first check projects-ref/openclaw/ and the main-first baseline plus forward-compat/stable-gate constraints in docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md.

Common validation:
- Plugin typecheck: cd extensions/clawlens && npm run typecheck
- Plugin tests: cd extensions/clawlens && npm test
- Stable gate: bash scripts/stable-gate.sh
- Forward compatibility: bash scripts/forward-compat.sh soft or bash scripts/forward-compat.sh strict --use-local-ref
- Docs governance: node scripts/check-docs-governance.mjs
- Manifest check: node scripts/check-clawlens-manifest.mjs

Development constraints:
- Prefer the existing TypeScript/ESM style and local helpers. Do not add unnecessary abstractions.
- Maintain DOC_INDEX / ROLLBACK_INDEX and document-side CODE_INDEX links for high-risk logic.
- Use repository-relative paths when referencing repository files in documents; do not write local absolute project paths.
- Before structurally rewriting a document, create a local backup if the original file must be modified. If the user asks for a new file or asks not to overwrite the original, create only a new file.
- In the final response, state what context was read, which files changed, and what validation was performed. If a validation step could not run because of missing dependencies or environment limitations, say so explicitly.
```
