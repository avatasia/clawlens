# OpenClaw Context Pollution Implementation Lessons

> [!IMPORTANT]
> Archived Review: This document records implementation lessons learned after Phase 1 and the current scoped Phase 2 prototype were migrated onto a live `main`-based OpenClaw fork and verified remotely.

## Summary

The OpenClaw context-pollution work produced two stable conclusions:

1. `toolResult replay mitigation` and `assistant conclusion freshness gate` are related, but they are not the same problem.
2. Migration and validation quality depend more on matching the target baseline's real runtime structure than on reusing historical local patches mechanically.

## Lessons Learned

### 1. Phase 1 and Phase 2 must stay split

- `Phase 1` fixes stale diagnostic `toolResult` replay pollution.
- `Phase 2` reduces stale assistant-conclusion reuse for a narrow class of current-environment questions.

They share some structured evidence and metadata, but they should remain separate PRs, separate rollout scopes, and separate history threads.

### 2. Old local patches are not automatically trustworthy

- Earlier local patches can be incomplete even when the prototype behavior looked correct.
- A patch should not be treated as PR-ready unless it is revalidated against the real target baseline and checked for missing added files.

### 3. Migration must follow the target baseline's real entrypoints

- Older local prototypes were anchored to `google.ts`.
- Current `main`-based OpenClaw replay cleanup is anchored in `pi-embedded-runner/replay-history.ts`.

The correct migration strategy is:

- inspect the actual target branch structure first
- identify the live runtime entrypoints
- then port the behavior

not:

- blindly replay an old file-level patch

### 4. Remote validation must use a real built package

- Replacing ad-hoc compiled files is too fragile.
- The stable path is:
  - build the target branch
  - run `runtime-postbuild`
  - `npm pack`
  - install the packed tarball remotely

This matters because runtime package contents and extension manifests must match what the actual gateway expects.

### 5. Remote installation details matter

During remote validation, the package installation needed to follow the active Node prefix explicitly.

In practice, this meant using the same runtime prefix the remote gateway uses, instead of assuming a generic global install path.

### 6. Structured evidence is stronger than natural-language history

The most reliable signal for both phases is structured diagnostic evidence:

- transient metadata
- diagnostic type
- timestamp
- replay omission state

Natural-language assistant history remains useful context, but should not be the primary freshness signal.

### 7. Phase 2 must stay behind an explicit feature flag

The current scoped freshness gate changes answer behavior and prompt construction.

Therefore:

- it must remain explicitly gated
- it must default to off
- it should be rolled out experimentally first

### 8. Transcript inspection is more reliable than noisy CLI stdout

Remote CLI output can be polluted by plugin startup logs and other runtime noise.

For correctness validation, session transcript files were more reliable than raw command stdout when determining:

- whether a tool call was made
- whether fresh evidence was reused
- whether a second query was skipped

## Current Takeaway

The converged operating model is:

- keep `Phase 1` as a stable replay-layer fix
- keep `Phase 2` as a scoped, flagged prompt-build freshness prototype
- validate on the real target baseline, not just on historical local prototypes
