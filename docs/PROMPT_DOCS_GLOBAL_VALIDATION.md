# Docs Global Validation Prompt

> [!IMPORTANT]
> Current Authority: This is the active master version for full docs global validation.
>
> 当前主文档，用于执行 `docs/` 体系全局验证（9 维度）。
> 日常治理审计请用 [PROMPT_DOCS_AUDIT.md](PROMPT_DOCS_AUDIT.md)（6 维度）。

```md
Perform a full global validation of the `docs/` documentation system. This goes beyond governance structure — it validates that the content is technically accurate, internally consistent, and faithfully represents current code and project state.

Prerequisites:
1. `node scripts/check-docs-governance.mjs --all`
2. `node scripts/check-docs-governance.mjs --all --strict`
3. `git status --short`
4. `git log --oneline -10`

Record the output of each command before proceeding. If either governance check fails, list the failures but continue the full validation.

---

## Dimension 1: Structural Governance

1.1 Top-level `docs/*.md` naming: no dated filenames allowed.

1.2 Sub-directory README coverage (bidirectional):
  - Forward: every `.md` file in the directory (excluding `README.md`) is linked from its `README.md`.
  - Reverse: every file linked from `README.md` exists on disk.
  - Apply to: `docs/plans/`, `docs/research/`, `docs/prompts/`, `docs/archive/history/`.

1.3 Archive classification: files in `docs/archive/` are in the correct subdirectory per governance rules (`reviews/`, `analysis/`, `prompts/`, `chat-audit/`, `history/`).

1.4 Naming convention compliance: dated files follow `TYPE_TOPIC[_DETAIL]_YYYY-MM-DD.md`. Valid TYPE prefixes: ANALYSIS, RESEARCH, IMPLEMENTATION, PROMPT, REVIEW, FIX, CHANGELOG, POSTMORTEM, GOVERNANCE, PLAYBOOK, HISTORY.

---

## Dimension 2: Link and Path Integrity

2.1 Markdown link resolution: every `[text](target)` where target is a relative path must resolve to an existing file.

2.2 Absolute project path leakage: no doc may contain the repo root absolute path. Remote/external system paths (e.g., `/home/openclaw/...` on deployment servers) are permitted per governance rule §4.

2.3 Backtick path references: inline-code references matching `*.md` with path separators or known directory prefixes (`docs/`, `archive/`, `plans/`, `research/`, `prompts/`, `patches/`, `extensions/`, `scripts/`) — verify the file exists at the stated path. Flag stale references where the file has been moved or deleted.

2.4 Link text vs target mismatch: if link text matches a filename pattern (`*.md`, `*.patch`, `*.ts`, `*.js`) but its basename differs from the target's basename, flag as misleading.

2.5 Cross-document reference consistency: when doc A links to doc B, and doc B links back to doc A (or claims to be related), verify the relationship is reciprocal and neither side is stale.

---

## Dimension 3: Bidirectional Doc-Code Indexing

3.1 Every code marker (`DOC_INDEX`, `ROLLBACK_INDEX`) in `extensions/**` and `scripts/**` has `-> <repo-relative-doc-path>`.
3.2 Target doc exists.
3.3 Target doc contains matching `CODE_INDEX: <ID>`.
3.4 Every `CODE_INDEX` in docs maps back to at least one code-side marker.
3.5 `CODE_INDEX files:` paths exist and are repo-relative.
3.6 Same ID in code must point to a single target doc path.
3.7 Duplicate `CODE_INDEX` IDs across multiple docs must be flagged.
3.8 `entry_points:` symbol existence — warn-level, non-blocking.

---

## Dimension 4: Technical Content Accuracy

Cross-check the following authoritative docs against current code. Read the relevant source files — do not rely solely on doc claims.

Target docs and their code counterparts:

| Doc | Verify against |
|-----|---------------|
| `docs/architecture.md` | `extensions/clawlens/index.ts`, `openclaw.plugin.json`, `src/store.ts`, `src/collector.ts`, `src/api-routes.ts`, `src/types.ts` |
| `docs/ANALYSIS_CHAT_AUDIT.md` | `src/collector.ts`, `src/store.ts`, `ui/inject.js` |
| `docs/ANALYSIS_CHAT_AUDIT_ENHANCEMENTS.md` | `src/collector.ts`, `src/store.ts`, `ui/inject.js` |
| `docs/ANALYSIS_LLM_API_LOGGER_MESSAGE_MAPPING.md` | `src/logger-import.ts`, `src/logger-message-mapper.ts` |
| `docs/PROMPT_IMPLEMENTATION.md` | `extensions/clawlens/index.ts`, `src/collector.ts`, `src/store.ts`, `src/api-routes.ts` |
| `docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md` | `extensions/clawlens/package.json`, `scripts/stable-gate.sh`, `scripts/forward-compat.sh` |
| `docs/CLAWLENS_TRANSCRIPT_BINDING_ROLLBACK_PLAYBOOK.md` | Files listed in its own `CODE_INDEX` blocks |
| `docs/CLAWLENS_REMOTE_DEPLOYMENT.md` | `extensions/clawlens/package.json`, `scripts/forward-compat.sh` |
| `docs/clawlens-usage.md` | `src/api-routes.ts`, `ui/inject.js`, `openclaw.plugin.json` |

Check for:
4.1 Doc claims a feature exists but the implementing code is absent or commented out.
4.2 Doc claims a feature does NOT exist but the code has since added it.
4.3 API route paths, query parameters, or response shapes documented incorrectly.
4.4 Config schema fields documented but absent from `openclaw.plugin.json`, or vice versa.
4.5 Architecture doc reference version does not match `projects-ref/openclaw` state (check the version line).
4.6 "Current status" or capability claims that conflate implemented vs planned.

---

## Dimension 5: Cross-Document Consistency

5.1 Same capability described differently across docs (one says "done", another says "planned").
5.2 Same API endpoint listed with different paths or semantics in different docs.
5.3 Same config field described with different schema, defaults, or behavior.
5.4 Architecture conclusions in `architecture.md` contradicted by topic-specific docs.
5.5 History summaries that contradict the current authoritative doc for their topic.

For each conflict found: name both files, quote the conflicting claims, identify which is closer to current code truth, and recommend which to fix.

---

## Dimension 6: Per-Topic Completeness

For each major topic, verify:

| Check | Requirement |
|-------|------------|
| Authoritative doc | Exactly one undated doc in `docs/` top-level (or appropriate subdirectory) |
| History index | Corresponding `*_HISTORY.md` in `docs/archive/history/` |
| History completeness | All significant archived files for this topic are registered |
| Archive cleanliness | No stale drafts remain outside `docs/archive/` |
| No competing authority | No second doc claims to be the current source of truth for the same topic |

Topics to cover (at minimum):
- Architecture
- Chat Audit
- Chat Audit Enhancements / Remaining Work
- LLM API Logger Message Mapping
- Implementation Prompt
- Analysis Prompt Playbook
- Engineering Lessons Playbook
- Docs Governance
- ClawLens Plugin Dev Workflow
- ClawLens Transcript Binding
- ClawLens Remote Deployment
- OpenClaw Stale Tool Result Replay Mitigation
- OpenClaw Assistant Conclusion Pollution

---

## Dimension 7: Content Freshness

7.1 Active plan docs (`docs/plans/`): flag any status claims, environment state descriptions, or ahead/behind counts that are hardcoded and likely stale.
7.2 Follow-up / TODO docs: flag items marked as open but actually completed (verify against code and git history).
7.3 Research docs (`docs/research/`): flag any that should have been archived (conclusions fully absorbed into authoritative docs) or promoted (converted into active plans).
7.4 Snapshot markers: any doc that describes point-in-time state should have a visible date/snapshot annotation. Flag docs that read as "current" but are actually frozen snapshots.

---

## Dimension 8: README and Entry Point Accuracy

8.1 `README.md` only links to current authoritative docs, not archived dated drafts.
8.2 `README.md` document list matches what actually exists in `docs/`.
8.3 `docs/archive/README.md` "recommended current docs" section is accurate and up-to-date.
8.4 No README references a file that has been moved or deleted.

---

## Dimension 9: Policy-Automation Gap Analysis

9.1 List every rule in `docs/GOVERNANCE_DOCS_PLAN.md`.
9.2 For each rule, state whether `scripts/check-docs-governance.mjs` enforces it automatically.
9.3 Classify each gap: automatable (should add to script), manual-only (inherently requires human judgment), or out-of-scope (not worth automating).

---

## Output Format (strict)

### Section 1: Automated Check Results
Table: command, result, warnings (if any).

### Section 2: Severity-Ranked Findings
Order: Critical → High → Medium → Low → Info.
Each finding must include: file path + line reference, concrete impact, fix recommendation, classification (regression vs pre-existing debt).

### Section 3: Technical Accuracy Verdict
Per-doc table: doc name, code alignment status (Accurate / Drift / Stale / Conflict), specific discrepancies if any.

### Section 4: Cross-Document Consistency Verdict
List of conflicts found, or explicit "No cross-doc conflicts detected."

### Section 5: Per-Topic Completeness Table
Columns: Topic, Authoritative Doc, History, Archive Clean, Verdict.

### Section 6: Pass/Fail Summary
| Category | Result | Notes |
|----------|--------|-------|
| Structural governance | | |
| Link integrity | | |
| Bidirectional indexing | | |
| Technical accuracy | | |
| Cross-doc consistency | | |
| Per-topic completeness | | |
| Content freshness | | |
| README accuracy | | |
| Policy-automation coverage | | |

### Section 7: Blocking Items
Explicit list of items that must be fixed before the docs system can be considered reliable.

### Section 8: Non-Blocking Cleanup
Clearly separated from blockers. Include effort estimate (trivial / small / medium).

---

## Constraints

- Read actual source files before judging technical accuracy — do not trust doc claims alone.
- Use repo-relative file references throughout.
- Do not propose broad rewrites unless structurally necessary.
- Prefer minimal, targeted fixes.
- Distinguish pre-existing baseline debt from newly introduced regressions.
- If a doc's technical claims cannot be verified because the referenced code file does not exist, flag that explicitly rather than skipping silently.
```
