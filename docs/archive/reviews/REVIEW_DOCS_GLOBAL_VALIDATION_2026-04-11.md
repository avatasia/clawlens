# Docs Global Validation Report

> Date: 2026-04-11
> Scope: full global validation of `docs/` (structure, links, doc-code indexing, technical accuracy, cross-doc consistency, completeness, freshness, entry-point accuracy, automation gap)

## Section 1: Automated Check Results

| Command | Result | Warnings / Output |
|---|---|---|
| `node scripts/check-docs-governance.mjs --all` | **Fail (exit 1)** | `Docs governance checks failed: - Broken link in docs/plans/PROMPT_DOCS_GLOBAL_VALIDATION_DRAFT_2026-04-11.md: target` |
| `node scripts/check-docs-governance.mjs --all --strict` | **Fail (exit 1)** | Same failure as above |
| `git status --short` | **Pass (exit 0)** | `M docs/CLAWLENS_REMOTE_DEPLOYMENT.md`, `M docs/architecture.md`, `M docs/research/README.md`, `?? docs/plans/PROMPT_DOCS_GLOBAL_VALIDATION_DRAFT_2026-04-11.md`, `?? docs/research/RESEARCH_OPENCLAW_QA_LAB_REMOTE_STATUS_2026-04-11.md` |
| `git log --oneline -10` | **Pass (exit 0)** | Latest: `eb48e6a docs: fix audit findings and upgrade docs audit prompt` |

## Section 2: Severity-Ranked Findings

### Critical

1. Broken link currently breaks governance baseline/strict checks.
- File: `docs/plans/PROMPT_DOCS_GLOBAL_VALIDATION_DRAFT_2026-04-11.md:35`
- Impact: `--all` and `--all --strict` fail, so docs gate is red.
- Fix: Escape or reword ``[text](target)`` in the fenced prompt block so checker doesn’t parse it as a live link.
- Classification: regression (working-tree)

### High

1. `docs/plans` README forward coverage is incomplete (new file not indexed).
- File: `docs/plans/README.md:17`, `docs/plans/PROMPT_DOCS_GLOBAL_VALIDATION_DRAFT_2026-04-11.md:1`
- Impact: Violates bidirectional README discoverability rule.
- Fix: Add the new plan doc to `docs/plans/README.md` (or archive/remove draft if not active).
- Classification: regression (working-tree)

2. Usage doc API semantics drift from code (`/sessions` docs mention `since`, code does not support it).
- File: `docs/clawlens-usage.md:218`, `extensions/clawlens/src/api-routes.ts:87`
- Impact: Users call unsupported query params and assume wrong API behavior.
- Fix: Update `clawlens-usage.md` endpoint parameter table to match code (`channel/model/provider/limit/offset`).
- Classification: pre-existing debt

3. Usage doc says overview refreshes every 5s; UI code is 30s polling (`OVERVIEW_INTERVAL=30000`) plus SSE events.
- File: `docs/clawlens-usage.md:57`, `extensions/clawlens/ui/inject.js:6`
- Impact: Misleading performance/latency expectations.
- Fix: Correct interval statement to 30s polling with SSE-triggered updates.
- Classification: pre-existing debt

4. `PROMPT_IMPLEMENTATION.md` contains outdated factual “confirmed facts” (example: says plugin schema is empty).
- File: `docs/PROMPT_IMPLEMENTATION.md:53`, `extensions/clawlens/openclaw.plugin.json:3`
- Impact: Engineers may apply already-completed or wrong remediation steps.
- Fix: Add “historical snapshot” warning or split into “historical prompt” vs “current implementation guide.”
- Classification: pre-existing debt

5. Dev workflow doc claims `forward-compat` improvements are “proposal only / not implemented,” but script already supports `--use-local-ref` and `--openclaw-bin`.
- File: `docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md:72`, `scripts/forward-compat.sh:8`
- Impact: Process documentation understates current gate capability.
- Fix: Move proposal section to “implemented behavior + optional next improvements.”
- Classification: pre-existing debt

### Medium

1. Remote deployment doc requires local `pnpm build`, but extension package has no `build` script.
- File: `docs/CLAWLENS_REMOTE_DEPLOYMENT.md:12`, `extensions/clawlens/package.json:15`
- Impact: SOP step is non-executable as written.
- Fix: Replace with actual required prep (`pnpm test`/packaging flow) or define a real build command.
- Classification: pre-existing debt

2. Follow-up TODO doc states strict governance “now passes,” but current run fails.
- File: `docs/plans/IMPLEMENTATION_CLAWLENS_FOLLOWUPS_2026-04-11.md:17`
- Impact: Freshness drift; readers trust an invalid status claim.
- Fix: Update line to current state or timestamped conditional claim.
- Classification: regression (working-tree time drift)

3. Per-topic history index missing for two active authoritative topics.
- Files: `docs/CLAWLENS_TRANSCRIPT_BINDING_ROLLBACK_PLAYBOOK.md:1`, `docs/CLAWLENS_REMOTE_DEPLOYMENT.md:1`, `docs/archive/history/*_HISTORY.md`
- Impact: Violates governance expectation that major topics have history entry points.
- Fix: Add dedicated `*_HISTORY.md` for both topics.
- Classification: pre-existing debt

### Low

1. Archive contains many dated filenames not matching current TYPE naming policy (legacy debt).
2. Stale backtick path references in archived docs point to moved/deleted paths.

### Info

1. Doc-code bidirectional indexing is clean: no missing targets, no duplicate IDs across docs, no missing `files:` paths; `entry_points` checks are clean.

2. Policy-Automation gap matrix (`docs/GOVERNANCE_DOCS_PLAN.md` vs `scripts/check-docs-governance.mjs`):

| Rule Group | Auto-enforced? | Gap Class |
|---|---|---|
| Top-level dated file prohibition | Yes | N/A |
| Relative markdown link existence | Yes | N/A |
| Absolute project path prohibition | Yes | N/A |
| `history/README.md` covers all `*_HISTORY.md` | Yes | N/A |
| Doc-code index integrity (`DOC_INDEX`/`ROLLBACK_INDEX`/`CODE_INDEX`) | Yes | N/A |
| Entry point symbol existence warn-level | Yes | N/A |
| `docs/plans|research|prompts|archive/history` README bidirectional coverage | No | automatable |
| Archive subdir classification correctness | No | manual-only |
| Dated filename TYPE whitelist (`ANALYSIS/...`) | No | automatable |
| “One authority per topic” uniqueness | No | manual-only |
| History completeness (all archived significant files registered) | No | manual-only (assisted automatable) |
| Plans/research lifecycle correctness (promote/archive decisions) | No | manual-only |
| Backtick path validity checks | No | automatable |
| Link text vs target basename mismatch checks | No | automatable |
| Reciprocal related-doc consistency | No | manual-only |
| Archive SOP atomicity (move+links+history same commit) | No | out-of-scope/manual |
| Post-archive minimum review checklist completion | No | out-of-scope/manual |

## Section 3: Technical Accuracy Verdict

| Doc | Status | Discrepancies |
|---|---|---|
| `docs/architecture.md` | Accurate | Reference version line matches local `projects-ref/openclaw` commit (`65b781f9ae`). |
| `docs/ANALYSIS_CHAT_AUDIT.md` | Accurate | High-level capability claims align with collector/store/UI behavior. |
| `docs/ANALYSIS_CHAT_AUDIT_ENHANCEMENTS.md` | Accurate | Long-term enhancement framing matches code status. |
| `docs/ANALYSIS_LLM_API_LOGGER_MESSAGE_MAPPING.md` | Accurate | `user-entry` extraction, import endpoint/startup import behavior matches logger files. |
| `docs/PROMPT_IMPLEMENTATION.md` | Stale | Contains outdated “confirmed facts” (e.g., empty `configSchema` claim). |
| `docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md` | Drift | `forward-compat` proposal section is outdated relative to implemented script options. |
| `docs/CLAWLENS_TRANSCRIPT_BINDING_ROLLBACK_PLAYBOOK.md` | Accurate | CODE_INDEX mappings and referenced symbols/files are valid. |
| `docs/CLAWLENS_REMOTE_DEPLOYMENT.md` | Drift | Prerequisite `pnpm build` conflicts with package scripts. |
| `docs/clawlens-usage.md` | Conflict | API/query docs and refresh interval drift from current routes/UI constants. |

## Section 4: Cross-Document Consistency Verdict

Conflicts found:

1. Config path semantics conflict.
- Claim A: `docs/clawlens-usage.md:299` uses top-level `clawlens:` config block.
- Claim B: `README.md:130` and `README.md:140` use `openclaw config set plugins.config.clawlens...`.
- Closer to code truth: README-style `plugins.config.clawlens` flow.
- Fix target: `docs/clawlens-usage.md`.

2. Snapshot interval semantics conflict.
- Claim A: `docs/clawlens-usage.md:303` presents `snapshotIntervalMs` as active snapshot interval.
- Claim B: `docs/architecture.md:520` says it is not wired yet.
- Closer to code truth: architecture statement.
- Fix target: `docs/clawlens-usage.md`.

## Section 5: Per-Topic Completeness Table

| Topic | Authoritative Doc | History | Archive Clean | Verdict |
|---|---|---|---|---|
| Architecture | `docs/architecture.md` | `ARCHITECTURE_HISTORY.md` exists | Yes | Pass |
| Chat Audit | `docs/ANALYSIS_CHAT_AUDIT.md` | `CHAT_AUDIT_HISTORY.md` exists | Yes | Pass |
| Chat Audit Enhancements / Remaining Work | `docs/ANALYSIS_CHAT_AUDIT_ENHANCEMENTS.md` | `CHAT_AUDIT_ENHANCEMENTS_HISTORY.md` + `CHAT_AUDIT_REMAINING_WORK_HISTORY.md` | Yes | Pass |
| LLM API Logger Message Mapping | `docs/ANALYSIS_LLM_API_LOGGER_MESSAGE_MAPPING.md` | `LLM_API_LOGGER_MESSAGE_MAPPING_HISTORY.md` exists | Yes | Pass |
| Implementation Prompt | `docs/PROMPT_IMPLEMENTATION.md` | `IMPLEMENTATION_PROMPT_HISTORY.md` exists | Yes | Pass (but stale content) |
| Analysis Prompt Playbook | `docs/PLAYBOOK_ANALYSIS_PROMPT.md` (+ active branches in `docs/prompts/`) | `ANALYSIS_PROMPT_PLAYBOOK_HISTORY.md` exists | Yes | Pass |
| Engineering Lessons Playbook | `docs/PLAYBOOK_ENGINEERING_LESSONS.md` | `ENGINEERING_LESSONS_PLAYBOOK_HISTORY.md` exists | Yes | Pass |
| Docs Governance | `docs/GOVERNANCE_DOCS_PLAN.md` | `DOCS_GOVERNANCE_HISTORY.md` exists | Yes | Pass |
| ClawLens Plugin Dev Workflow | `docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md` | `CLAWLENS_PLUGIN_DEV_WORKFLOW_HISTORY.md` exists | Yes | Pass (doc drift) |
| ClawLens Transcript Binding | `docs/CLAWLENS_TRANSCRIPT_BINDING_ROLLBACK_PLAYBOOK.md` | Missing dedicated history | Yes | Fail |
| ClawLens Remote Deployment | `docs/CLAWLENS_REMOTE_DEPLOYMENT.md` | Missing dedicated history | Yes | Fail |
| OpenClaw Stale Tool Result Replay Mitigation | No undated active authority (history-only) | `OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_HISTORY.md` exists | Yes | Partial/Fail vs strict requirement |
| OpenClaw Assistant Conclusion Pollution | No undated active authority (history-only) | `OPENCLAW_ASSISTANT_CONCLUSION_POLLUTION_HISTORY.md` exists | Yes | Partial/Fail vs strict requirement |

## Section 6: Pass/Fail Summary

| Category | Result | Notes |
|----------|--------|-------|
| Structural governance | Fail | Broken link + plans README coverage gap + naming legacy debt |
| Link integrity | Fail | One hard broken markdown link; stale backtick refs in archives |
| Bidirectional indexing | Pass | DOC_INDEX/ROLLBACK_INDEX/CODE_INDEX checks clean |
| Technical accuracy | Fail | Drift/stale in usage, implementation prompt, workflow, remote deployment |
| Cross-doc consistency | Fail | Config-path and snapshot-interval contradictions |
| Per-topic completeness | Fail | Missing history for transcript-binding and remote-deployment; strict-topic authority gaps for two OpenClaw topics |
| Content freshness | Fail | Follow-up plan claims `--strict` pass though currently failing |
| README accuracy | Partial Fail | Links resolve; but includes dated archived draft in main README list |
| Policy-automation coverage | Fail | Multiple governance rules not yet automated |

## Section 7: Blocking Items

1. Fix broken link in `docs/plans/PROMPT_DOCS_GLOBAL_VALIDATION_DRAFT_2026-04-11.md` so governance checks pass.
2. Update `docs/clawlens-usage.md` API/config/refresh claims to match current code.
3. Update `docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md` to reflect actual `forward-compat.sh` behavior.
4. Correct `docs/plans/IMPLEMENTATION_CLAWLENS_FOLLOWUPS_2026-04-11.md` stale “strict passes” status.

## Section 8: Non-Blocking Cleanup

1. Add missing history index docs for transcript binding and remote deployment topics. Effort: trivial/small.
2. Normalize/archive-annotate stale backtick path references in historical docs. Effort: small.
3. Decide policy for legacy dated filename noncompliance in `docs/archive/**` and either grandfather or batch-rename with history/link updates. Effort: medium.
4. Extend `scripts/check-docs-governance.mjs` for README bidirectional coverage, TYPE naming, backtick-path checks, and link-text mismatch checks. Effort: medium.
