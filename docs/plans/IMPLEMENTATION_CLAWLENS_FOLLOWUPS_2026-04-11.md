# ClawLens Follow-up TODO (2026-04-11)

## Scope

本清单记录当前会话结束后仍需完成的事项，供后续会话直接接续执行。

## Open Items

1. Push pending commits to remote
- Current status: local `main` is ahead of `origin/main` by 2 commits.
- Action:
```bash
git push
```

2. ~~Close full docs governance baseline debt (`--all --strict`)~~
- Resolved: `--all --strict` now passes (verified 2026-04-11).

3. Optional ClawLens run-binding enhancements (deferred by decision)
- `B`: timeline filtering by `run_kind` (only if mismatch is still reproducible).
- `C`: completion/backfill grace refinement (prefer store-level backfill approach).
- Reference:
  - `docs/CLAWLENS_TRANSCRIPT_BINDING_ROLLBACK_PLAYBOOK.md`

## Resume Checklist (New Session)

Run in order:
```bash
git status -sb
git rev-list --left-right --count @{upstream}...HEAD
git log --oneline -5
node scripts/check-docs-governance.mjs
node scripts/check-docs-governance.mjs --all --strict
```

Then review:
- `docs/CLAWLENS_TRANSCRIPT_BINDING_ROLLBACK_PLAYBOOK.md`
- `docs/GOVERNANCE_DOCS_PLAN.md`
- `docs/DOCS_GOVERNANCE_AUTOMATION.md`

## Notes

- Doc-code bidirectional indexing policy and checker are already implemented.
- `entry_points` is warn-level only (non-blocking).
- For runtime transcript binding regressions, prioritize replaying queued Discord message scenarios before implementing `B/C`.
