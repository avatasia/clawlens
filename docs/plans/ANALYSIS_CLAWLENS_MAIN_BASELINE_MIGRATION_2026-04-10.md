# ClawLens Plugin Dev Workflow Baseline Migration Analysis

> **Date:** 2026-04-10
> **Scope:** Analysis-only. No code changes performed.
> **Baseline:** `projects-ref/openclaw` `main` at commit `65b781f9ae`, version `2026.4.10`
> **Note:** Document and file status descriptions below are snapshots as of 2026-04-10 and may no longer reflect current working tree state.

---

## 1. Current Authoritative Docs

| Document | Role | Status |
|---|---|---|
| `docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md` | Intended current workflow doc. Defines baseline strategy, branching, CI gates, manifest rules, version rhythm, and execution checklist. | Present in working tree, functions as the current workflow draft, but currently untracked. |
| `docs/architecture.md` | Current architecture truth source. Plugin shape, data sources, data model, API routes, frontend architecture. | Has uncommitted modifications. |
| `docs/clawlens-usage.md` | End-user usage guide. Installation verification, UI features, API reference, config, troubleshooting. | Clean. |
| `docs/GOVERNANCE_DOCS_PLAN.md` | Docs directory governance rules. Naming, archive SOP, path reference rules. | Clean. |
| `docs/DOCS_GOVERNANCE_AUTOMATION.md` | Local automation (pre-commit/pre-push hooks, gate commands). | Present in working tree but currently untracked. |
| `docs/research/RESEARCH_OPENCLAW_V2026_4_5_COMPAT_ANALYSIS_2026-04-06.md` | Historical compat analysis against v2026.4.5. Still useful for PR strategy context. | Clean. |

---

## 2. Verified Environment Facts

### Local Machine

| Item | Status | Detail |
|---|---|---|
| `node` | Available | In PATH |
| `pnpm` | Available | In PATH |
| `openclaw` CLI | **Not in PATH** | Local installation state not confirmed |
| `projects-ref/openclaw` | Present | Branch: `main`, commit: `65b781f9ae`, version: `2026.4.10` |

### Remote Server (`ssh szhdy`)

| Item | Status | Detail |
|---|---|---|
| SSH key login | Works | Via `ssh szhdy` |
| `pnpm` | Installed, **not in default non-interactive SSH PATH** | Binary at `/home/openclaw/.local/share/pnpm/pnpm` |
| `openclaw` CLI | Installed, **not in default PATH** | Binary at `/home/openclaw/.nvm/versions/node/v24.14.0/bin/openclaw` |
| OpenClaw gateway | Running; `localhost:18789` plugin endpoints reachable and currently return 404 | Binding address is an inference; gateway process running and endpoints reachable are verified |
| `~/.openclaw/extensions/clawlens` | **Does not exist** | Plugin not deployed yet |

**Key distinction:** Both `pnpm` and `openclaw` on the remote are "installed but not in default non-interactive SSH PATH." Commands via `ssh szhdy <cmd>` will fail unless PATH is explicitly adjusted.

---

## 3. Compatibility Assessment Against Local `projects-ref/openclaw main`

**Local reference:** Branch `main`, commit `65b781f9ae3a0d0463dda4b4c6710d8f0b3a2bad`, version `2026.4.10`.

### 3.1 SDK Import Surface

| ClawLens uses | Verified in `2026.4.10` | Status |
|---|---|---|
| `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry"` | `src/plugin-sdk/plugin-entry.ts:179` exports `definePluginEntry` | OK |
| `import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry"` | Re-exported from `src/plugins/types.ts` | OK |

### 3.2 Plugin API Surface

| API used by ClawLens | Verified location | Status |
|---|---|---|
| `api.runtime.events.onAgentEvent(...)` | `src/plugins/runtime/types-core.ts:101`, wired in `runtime-events.ts` | OK |
| `api.runtime.events.onSessionTranscriptUpdate(...)` | `src/plugins/runtime/types-core.ts:102`, wired in `runtime-events.ts` | OK |
| `api.on("llm_input", ...)` | Listed in `src/plugins/types.ts:2303` | OK |
| `api.on("llm_output", ...)` | Listed in `src/plugins/types.ts:2304` | OK |
| `api.on("after_tool_call", ...)` | Listed in `src/plugins/types.ts:2314` | OK |
| `api.on("agent_end", ...)` | Listed in `src/plugins/types.ts:2305` | OK |
| `api.on("before_agent_start", ...)` | Listed in `src/plugins/types.ts:2301` | OK |
| `api.registerService(...)` | `src/plugins/types.ts:2193` | OK |
| `api.runtime.state.resolveStateDir()` | `src/plugins/runtime/index.ts:230`, typed at `types-core.ts:112` | OK |
| `api.rootDir` | `src/plugins/api-builder.ts:11` | OK |
| `api.pluginConfig` | `src/plugins/api-builder.ts:14` | OK |
| `api.config` | `src/plugins/api-builder.ts:13` (as `OpenClawConfig`) | OK |
| `api.logger` | `src/plugins/api-builder.ts:122` | OK |

### 3.3 Manifest Compatibility

| Field | ClawLens value | Assessment |
|---|---|---|
| `minHostVersion` | `>=2026.4.8` | Compatible with `2026.4.10` |
| `openclaw.extensions` | `["./index.ts"]` | Valid entry point exists |
| `openclaw.plugin.json.id` | `"clawlens"` | Non-empty string, passes manifest check |
| `openclaw.plugin.json.configSchema` | Full schema object | Non-null object, passes manifest check |

### 3.4 Summary

**No hard API-surface blockers detected from static inspection against `projects-ref/openclaw main`.**

The entire plugin SDK surface that ClawLens depends on -- `definePluginEntry`, `OpenClawPluginApi`, all hook names, runtime event subscriptions, service registration, state directory resolution -- still exists and has a compatible shape in `2026.4.10`. This conclusion is based on static source inspection only and does not constitute a runtime load verification.

### 3.5 Warnings / Legacy Usage (Non-blocking)

| Item | Detail | Severity |
|---|---|---|
| `api as any` casts | `index.ts:144-145` casts `api` to `any` when passing to `registerApiRoutes` and `registerStaticRoutes`. Works but bypasses type safety. | Low -- technical debt |
| Architecture doc version reference | `docs/architecture.md` still states `v2026.4.2 (d74a12264a)` as the reference version. Actual local ref is `2026.4.10 (65b781f9ae)`. | Low -- doc staleness |
| `node:sqlite` dependency | ClawLens requires `node:sqlite` (Node 22.5.0+). Remote server has Node `v24.14.0` which is fine. | Info -- no issue |
| `findControlUiIndexHtml` path probing | Uses multiple heuristic candidates to find `dist/control-ui/index.html`. Fragile to upstream layout changes but has worked across versions. | Low -- monitor on upgrade |

---

## 4. Documentation and Workflow Gaps

### 4.1 Workflow Doc Still Reflects Old Model

`docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md` lines 19-28 define the "dual-track" baseline strategy:

> 1. `stable` track: use latest stable tag as development and release baseline.
> 2. `forward` track: continuously validate with OpenClaw `main`, not used as direct release baseline.

This directly contradicts the new intent to develop against `main` as the default baseline. The branching model (line 32-35: `release/openclaw-<tag>` + `forward/main-compat`) and the gate structure (line 41-43: `stable-gate` as primary, `forward-compat` as advisory) all assume the old model.

### 4.2 Gate Scripts Do Not Actually Verify `main` Compatibility

- **`stable-gate.sh`**: Runs docs governance check, manifest check, and `pnpm test`. None of these verify compatibility against any specific OpenClaw version. The tests run in isolation without loading the plugin into an OpenClaw runtime.
- **`forward-compat.sh`**: Runs manifest check + `openclaw plugins inspect clawlens`. But:
  - `openclaw` is not in local PATH, so `soft` mode always skips.
  - `openclaw` is not in remote default PATH without explicit adjustment.
  - Even when it runs, it only inspects the plugin manifest/shape -- it does not verify runtime hook compatibility, API route registration, or data model compatibility against a specific `main` commit.

**Conclusion:** Neither gate currently proves that ClawLens works with `projects-ref/openclaw main`. They prove manifest correctness and test isolation only.

### 4.3 Remote Debug Docs Are Incomplete

The usage doc (`docs/clawlens-usage.md:389-395`) mentions SSH tunnel:

```bash
ssh -L 18789:127.0.0.1:18789 user@remote-host
```

But there is no documented remote deployment procedure for:

1. Copying the plugin to `~/.openclaw/extensions/clawlens` on the remote.
2. Adjusting PATH for `pnpm` and `openclaw` in non-interactive SSH.
3. Registering the plugin in remote `openclaw.yaml`.
4. Restarting the remote gateway after deployment.
5. Verifying plugin load in remote gateway logs.

The docs do not mention `szhdy` or the actual remote paths. They also do not warn about PATH issues.

### 4.4 Architecture Doc Version Drift

`docs/architecture.md:14` states:

> Current reference version: `OpenClaw v2026.4.2 (d74a12264a)`

The actual local reference is now `2026.4.10 (65b781f9ae)`. This file has uncommitted modifications, so per AGENTS.md rules, it should not receive a large in-place rewrite in this task.

### 4.5 Compat Analysis is Historical

`docs/research/RESEARCH_OPENCLAW_V2026_4_5_COMPAT_ANALYSIS_2026-04-06.md` analyzed against `v2026.4.5`. The current local ref is `2026.4.10`. This doc is not wrong -- it accurately records its analysis target -- but it should not be treated as current compat evidence for the new baseline.

---

## 5. Required Rectification Items Before Implementation

### 5A. Docs Updates

- [ ] **Update workflow doc**: Rewrite `docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md` baseline strategy section to reflect "develop against `main`" as default. Remove the dual-track assumption. Redefine the gate purpose accordingly.
- [ ] **Update architecture reference version**: Update the reference version line in `docs/architecture.md` from `v2026.4.2` to `2026.4.10`. Caution: this file has uncommitted changes -- apply only a minimal targeted edit.
- [ ] **Create remote deployment SOP**: Document the actual steps to deploy ClawLens to `szhdy`, including exact PATH commands, file copy, config registration, gateway restart, and verification.
- [ ] **Update or annotate compat research**: Add a note to `RESEARCH_OPENCLAW_V2026_4_5_COMPAT_ANALYSIS_2026-04-06.md` that the current baseline has moved to `2026.4.10` and that this analysis is historical.

### 5B. Validation/Gate Updates

- [ ] **Redesign `forward-compat.sh`**: The current gate is ineffective because `openclaw` is never in PATH. Options:
  - Accept a `--openclaw-bin` argument for explicit binary path.
  - Source PATH from a config file or environment variable.
  - Add a local-only mode that uses `projects-ref/openclaw` source to verify import resolution.
- [ ] **Add runtime compat verification**: Neither gate currently verifies that the plugin can actually load and register in an OpenClaw runtime. Consider adding a minimal "dry-run load" test that uses `projects-ref/openclaw` as the host.
- [ ] **Clarify what `stable-gate` proves**: Document that `stable-gate` currently only proves manifest correctness and test isolation, not runtime compatibility.

### 5C. Remote Debug / Process Updates

- [ ] **Document correct SSH PATH adjustment**: For `szhdy`, document the exact PATH export needed:
  ```bash
  export PATH="/home/openclaw/.nvm/versions/node/v24.14.0/bin:/home/openclaw/.local/share/pnpm:$PATH"
  ```
- [ ] **Document rsync/scp deployment command**: The exact command to deploy `extensions/clawlens/` to `~/.openclaw/extensions/clawlens` on the remote.
- [ ] **Document remote openclaw.yaml registration**: The yaml stanza needed to register clawlens as a local-path plugin.
- [ ] **Document gateway restart command**: Using the exact `openclaw` binary path.
- [ ] **Document verification steps**: Checking gateway logs for `ClawLens plugin started`, testing API endpoint, and setting up SSH tunnel for browser access.
- [ ] **Remove assumptions about `rssh`/`rscp`/`sshpass`**: If any docs reference these aliases, they should be replaced with standard `ssh`/`scp`/`rsync` commands.

### 5D. Possible Later Code Adaptation Items

- [ ] **Consider removing `api as any` casts**: Use proper typing for route and static registration calls. Non-urgent.
- [ ] **Update `minHostVersion`**: If the new baseline moves beyond `2026.4.8`, consider bumping the minimum version to match the actual test baseline.
- [ ] **Verify `findControlUiIndexHtml` path candidates**: Confirm that the path probing heuristics in `index.ts:29-38` still resolve correctly in a `2026.4.10` layout. This should be verified during the first real remote deployment, not speculatively.

---

## 6. Recommended Documentation Outputs

| Action | Target | Rationale |
|---|---|---|
| **Update in-place** | `docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md` | Intended current workflow doc. Currently untracked (no prior committed version to overwrite). Safe to update. |
| **Minimal targeted edit** | `docs/architecture.md` | Only update the reference version line. The file has uncommitted changes -- a full rewrite would violate AGENTS.md rule 2. |
| **Create new dated doc** | `docs/plans/ANALYSIS_CLAWLENS_MAIN_BASELINE_MIGRATION_2026-04-10.md` | This document. Records the analysis as a dated plan/analysis artifact per governance rules. |
| **Create new doc** | `docs/CLAWLENS_REMOTE_DEPLOYMENT.md` (undated, as a new authoritative doc) | Remote deployment SOP with verified environment facts. |
| **Do not modify** | `docs/research/RESEARCH_OPENCLAW_V2026_4_5_COMPAT_ANALYSIS_2026-04-06.md` | Historical. Add cross-reference from the new analysis doc instead. |
| **Do not modify** | `docs/DOCS_GOVERNANCE_AUTOMATION.md` | Content is accurate for current gate behavior. Gate behavior changes should update this doc in the implementation phase, not now. |

---

## 7. Clear Handoff Prompt

The following prompt is ready to use for the next phase:

---

**Task type:** Implementation planning and rectification.

**Context:**
An analysis has been completed (see `docs/plans/ANALYSIS_CLAWLENS_MAIN_BASELINE_MIGRATION_2026-04-10.md`) confirming that no hard API-surface blockers were detected from static inspection of ClawLens against `projects-ref/openclaw main` at version `2026.4.10` (commit `65b781f9ae`). The task now is to rectify the documentation, gates, and remote deployment workflow so they reflect the new baseline: "develop directly against `projects-ref/openclaw main`."

**Verified environment facts (do not re-investigate these):**

- Local: `node` and `pnpm` in PATH. `openclaw` CLI is not in local PATH; local installation state not confirmed.
- Remote (`ssh szhdy`): `pnpm` at `/home/openclaw/.local/share/pnpm/pnpm`, `openclaw` at `/home/openclaw/.nvm/versions/node/v24.14.0/bin/openclaw`. Neither is in default non-interactive SSH PATH. `~/.openclaw/extensions/clawlens` does not exist. Gateway is running; `localhost:18789` plugin endpoints are reachable and currently return 404. Binding address `127.0.0.1:18789` is an inference.

**Deliverables:**

1. Update `docs/CLAWLENS_PLUGIN_DEV_WORKFLOW.md` to replace the dual-track baseline strategy with a main-first strategy. Preserve the manifest rules and shape-classification sections that are still accurate.
2. Create `docs/CLAWLENS_REMOTE_DEPLOYMENT.md` as the authoritative remote deployment SOP, using the verified environment facts above.
3. Minimally update `docs/architecture.md` reference version line from `v2026.4.2 (d74a12264a)` to reflect `2026.4.10 (65b781f9ae)`. Do not rewrite other sections -- the file has uncommitted changes.
4. Propose concrete gate script modifications for `scripts/forward-compat.sh` (to accept explicit `openclaw` binary path or use `projects-ref/openclaw` for import verification), but do not apply code changes yet -- output the proposal as a plan section in the workflow doc or as a separate plan doc.
5. Follow `AGENTS.md` and `docs/GOVERNANCE_DOCS_PLAN.md` for all doc outputs.

**Constraints:**

- Do not modify `extensions/clawlens/` source code.
- Do not modify files under `projects-ref/openclaw/`.
- Do not modify `scripts/*.sh` or `scripts/*.mjs` in this phase -- only propose changes.
- If `docs/architecture.md` still has uncommitted changes, apply only the version line edit and nothing else.

---

## Related Information Sources

- [CLAWLENS_PLUGIN_DEV_WORKFLOW.md](../CLAWLENS_PLUGIN_DEV_WORKFLOW.md)
- [architecture.md](../architecture.md)
- [clawlens-usage.md](../clawlens-usage.md)
- [GOVERNANCE_DOCS_PLAN.md](../GOVERNANCE_DOCS_PLAN.md)
- [DOCS_GOVERNANCE_AUTOMATION.md](../DOCS_GOVERNANCE_AUTOMATION.md)
- [RESEARCH_OPENCLAW_V2026_4_5_COMPAT_ANALYSIS_2026-04-06.md](../research/RESEARCH_OPENCLAW_V2026_4_5_COMPAT_ANALYSIS_2026-04-06.md)
- [extensions/clawlens/package.json](../../extensions/clawlens/package.json)
- [extensions/clawlens/index.ts](../../extensions/clawlens/index.ts)
- [extensions/clawlens/openclaw.plugin.json](../../extensions/clawlens/openclaw.plugin.json)
- [scripts/stable-gate.sh](../../scripts/stable-gate.sh)
- [scripts/forward-compat.sh](../../scripts/forward-compat.sh)
- [scripts/check-clawlens-manifest.mjs](../../scripts/check-clawlens-manifest.mjs)
