# Docs Audit Prompt

> [!IMPORTANT]
> Current Authority: This is the active master version for docs audit prompts.
>
> 当前主文档，用于执行 `docs/` 体系治理审计。

```md
Perform a full governance audit for the `docs/` tree, covering doc quality, structural compliance, link integrity, and doc-code bidirectional indexing consistency.

Audit scope:
- All documents under `docs/` (top-level + subdirs + archive).
- Related code markers in `extensions/**/*.{ts,js}` and `scripts/**/*.{js,mjs,ts}`.
- Governance references: `docs/GOVERNANCE_DOCS_PLAN.md`, `docs/DOCS_GOVERNANCE_AUTOMATION.md`.

Run these automated checks first:
1. `node scripts/check-docs-governance.mjs --all`
2. `node scripts/check-docs-governance.mjs --all --strict`

Then perform manual cross-checks for the gaps the script cannot catch.

Required audit dimensions:

1. Structural governance
   - Top-level `docs/*.md` naming: no dates allowed.
   - Sub-directory README coverage (script only checks `archive/history/`):
     - `docs/plans/README.md` must link every `.md` in `docs/plans/` (excluding README itself).
     - `docs/research/README.md` must link every `.md` in `docs/research/`.
     - `docs/prompts/README.md` must link every `.md` in `docs/prompts/`.
     - `docs/archive/history/README.md` must link every `*_HISTORY.md`.
   - Reverse check: every file listed in a sub-directory README must exist on disk.

2. Link and path integrity
   - Broken relative markdown links in all docs.
   - Absolute project path leakage (repo root in content).
   - Backtick path references: detect inline-code references matching `*.md` that contain path separators or known directory prefixes (`docs/`, `archive/`, `plans/`, `research/`, `prompts/`, `patches/`). Verify the referenced file exists at the stated or implied path. Flag stale references where the file has been moved or deleted.
   - Link text vs target mismatch: if link text matches a filename pattern (`*.md`, `*.patch`, `*.ts`) but its basename differs from the target's basename, flag as misleading.
   - Post-archive/move reference correctness.

3. Bidirectional doc-code indexing
   - Every code marker (`DOC_INDEX`, `ROLLBACK_INDEX`) has `-> <repo-relative-doc-path>`.
   - Target doc exists.
   - Target doc contains matching `CODE_INDEX: <ID>`.
   - Every `CODE_INDEX` maps back to at least one code-side marker.
   - `CODE_INDEX files:` paths exist and are repo-relative.
   - Same ID in code must point to a single target doc path.
   - Duplicate `CODE_INDEX` IDs across multiple docs must be flagged.
   - `entry_points:` warnings (symbol not found) are non-blocking unless policy says otherwise.

4. Policy-automation consistency
   - `GOVERNANCE_DOCS_PLAN.md` rules match actual checker behavior.
   - `DOCS_GOVERNANCE_AUTOMATION.md` command semantics match script behavior.
   - Identify any governance rule that has no corresponding automated check (document the gap).

5. Content freshness (manual only)
   - Flag factual claims about tooling or check status that contradict current state (e.g., "check X still fails" when it now passes).
   - Flag TODO/follow-up items that reference completed or deleted work.
   - This dimension is inherently non-automatable; check `docs/plans/` files first as they are most likely to go stale.

6. Uncommitted state review
   - Run `git status` and review all uncommitted changes (modified, deleted, untracked) for consistency with governance rules.
   - Verify that archive moves are atomic: file deletion, new file addition, README updates, and history registration should form a coherent set.

Output format (strict):
1. Severity-ranked findings (Critical / High / Medium / Low / Info).
2. For each finding: file path + line reference + concrete impact + fix recommendation.
3. Pass/Fail summary table with columns: Category, Result, Notes.
   Categories: Structural governance, Link integrity, Bidirectional indexing, Policy-automation consistency, Content freshness.
4. Explicit list of blocking items to reach `--all --strict` green.
5. Non-blocking cleanup suggestions, clearly separated from blockers.

Constraints:
- Use repo-relative file references.
- Do not propose broad rewrites.
- Prefer minimal, actionable remediation steps.
- Distinguish pre-existing baseline debt vs newly introduced regressions.
```

For full technical content validation (9 dimensions including code accuracy, cross-doc consistency, per-topic completeness), see [PROMPT_DOCS_GLOBAL_VALIDATION.md](PROMPT_DOCS_GLOBAL_VALIDATION.md).

历史日期版：

- [PROMPT_DOCS_AUDIT_2026-04-03.md (旧版中文)](archive/history/DOCS_AUDIT_PROMPT_HISTORY.md)
