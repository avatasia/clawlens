---
status: active
created: 2026-05-01
updated: 2026-05-02
---

# ClawLens Structured Preview and JSONL Source Lookup Implementation Plan

## Source Plan

This document turns `docs/plans/ANALYSIS_CLAWLENS_STRUCTURED_PREVIEW_AND_JSONL_SOURCE_LOOKUP_2026-05-01.md` into an implementation sequence.

The implementation must preserve the analysis plan's core constraints:

1. Keep default audit views preview-only and fast.
2. Preserve structured preview semantics instead of slicing serialized JSON.
3. Store previews in existing text columns first.
4. Load full JSONL source only through explicit user action.
5. Treat full source endpoints as sensitive authenticated plugin API routes.
6. Handle transcript reset and compaction file movement with bounded lookup.

## Post-Plan Validation Notes

2026-05-01 / 2026-05-02 remote validation added two concrete constraints that should now be treated as implementation requirements:

1. For “latest message from a current session”, direct file access is materially faster than host API history calls when a trusted `sessionFile` is already known.
2. Current upstream manual compaction produces `.checkpoint.<uuid>.jsonl` snapshots alongside the main transcript file, so checkpoint names must be recognized by the shared transcript source candidate resolver.

Decision impact:

- use file-first, API-fallback for latest-message style lookup work;
- treat checkpoint transcript artifacts as first-class shared resolver candidates, not as undocumented noise.

## Current Code Surface

Primary implementation files:

- `extensions/clawlens/src/types.ts`
- `extensions/clawlens/src/collector.ts`
- `extensions/clawlens/src/store.ts`
- `extensions/clawlens/src/api-routes.ts`
- `extensions/clawlens/ui/inject.js`
- `extensions/clawlens/ui/styles.css`
- `extensions/clawlens/tests/collector.test.ts`
- `extensions/clawlens/tests/store.test.ts`

Current preview write points:

- `extensions/clawlens/src/collector.ts`
  - `recordLlmInput` stores `active.lastUserPrompt` using string slicing.
  - `recordToolCall` stores `argsSummary` and `resultSummary` using `JSON.stringify(...).slice(...)`.
  - `recordAgentEnd` stores fallback transcript turns using `raw.slice(0, 500)`.
  - `normalizeTranscriptMessage` stores transcript turn preview using `raw.slice(0, 500)`.
- `extensions/clawlens/src/store.ts`
  - `insertLlmCall` stores `user_prompt_preview`.
  - `insertToolExecution` stores `args_summary` and `result_summary`.
  - `insertConversationTurn` stores `content_preview`.
  - `buildRunAuditDetail` returns `userPrompt` and `turns[].preview` without preview format metadata.
- `extensions/clawlens/ui/inject.js`
  - `renderTurns` renders `t.preview` as plain text and also puts it in a `title` attribute.
  - Chat Audit expands run detail by calling `/audit/run/:runId`.

Current source anchors:

- `conversation_turns.message_id`
- `conversation_turns.session_file`
- `conversation_turns.source_kind`
- `conversation_turns.source_session_id`
- `tool_executions.run_id`
- `tool_executions.tool_call_id`

## Phase 0: Preview-Dependent Path Audit

Do this before replacing any stored preview text.

The current code has runtime behavior that depends on preview columns containing raw adjacent text. These paths must be made preview-format-aware first, otherwise structured previews will break transcript binding and logger import matching.

Blocking preview-dependent paths:

1. `Store.findUnknownRunIdByPromptMessageId`
   - Current behavior searches `llm_calls.user_prompt_preview` with SQL `LIKE` patterns such as `"message_id":"..."`.
   - Structured preview storage changes raw JSON adjacency into `entries: [{ key, value }]`, so the existing SQL patterns will stop matching.
   - Required fix: replace the direct preview `LIKE` dependency with a bounded candidate query by session/time window, then inspect each candidate in TypeScript using a helper that can extract message IDs from both legacy preview text and `structured-json-v1` nodes.
   - Candidate window constraint: keep the initial query to a small bounded range such as the same session plus a default `timestamp` window of about +/- 1 minute around the target event, with tests proving the fallback still binds correctly inside that window.
2. `Store.applyLoggerSessionPreviewMapping`
   - Current behavior matches logger user text against `conversation_turns.content_preview` with SQL `LIKE`.
   - Structured preview JSON escaping can make normal text such as quotes and backslashes fail the match.
   - Required fix: keep the SQL query as a coarse bounded prefilter by role, `session_file`, and timestamp, then parse each preview in TypeScript and compare against a normalized searchable text string extracted from either legacy text or structured preview nodes.
3. Transcript kind classification in `recordTranscriptUpdate`
   - Current behavior calls `classifyTranscriptTurnKind(normalized)`, where `normalized.preview` is derived from the stored preview string.
   - After structured preview storage, classification must not depend on serialized preview JSON.
   - Required fix: make `normalizeTranscriptMessage` return separate fields for raw/searchable content and stored preview. Use the raw/searchable content for `classifyTranscriptTurnKind`, including heartbeat/chat classification, and the structured preview only for storage/rendering.
4. `extractSessionIdFromSessionFile`
   - Current behavior only matches `<sessionId>.jsonl`.
   - Required fix: update this helper or replace it with a resolver helper that supports reset/deleted archive names before source lookup phases depend on archived transcript paths.

Recommended shared helpers:

```ts
export function extractSearchTextFromPreview(previewText: string | null | undefined): string;
export function extractMessageIdsFromPreview(previewText: string | null | undefined): string[];
export function normalizeSearchText(value: string): string;
export function resolveTranscriptSourceCandidates(input: ResolveTranscriptSourceCandidatesInput): ResolveTranscriptSourceCandidatesResult;
```

These helpers must support:

- legacy plain preview text
- `structured-json-v1` wrappers
- string leaves stored as `value`
- truncated string leaves stored as `preview`
- object entries where keys and values are separated
- arrays of provider content blocks
- reset/deleted/checkpoint/compacted transcript filename variants through the shared source-candidate resolver, not a second ad hoc parser later

Add tests for these helpers before Phase 2 changes collector writes.

## Phase 1: Shared Structured Preview Builder and Feature Gates

Add a shared preview builder and typed feature gates before changing storage or UI rendering.

Recommended new file:

- `extensions/clawlens/src/structured-preview.ts`

Public API:

```ts
export type PreviewFormat = "text-legacy" | "structured-json-v1";

export type StructuredPreviewEnvelope = {
  __clawlensPreview: {
    version: 1;
    node: StructuredPreviewNode;
    meta: {
      source: "structured-preview";
    };
  };
};

export type PreviewBuildOptions = {
  maxStringChars?: number;
  maxArrayItems?: number;
  maxObjectEntries?: number;
  maxDepth?: number;
  maxSerializedBytes?: number;
};

export function buildStructuredPreview(value: unknown, options?: PreviewBuildOptions): StructuredPreviewEnvelope | string;
export function serializePreviewForTextColumn(value: unknown, options?: PreviewBuildOptions): string;
export function parsePreviewFormat(value: unknown): {
  previewFormat: PreviewFormat;
  previewVersion: 1 | null;
  previewNode?: StructuredPreviewEnvelope["__clawlensPreview"]["node"];
};
export function extractSearchTextFromPreview(previewText: string | null | undefined): string;
export function extractMessageIdsFromPreview(previewText: string | null | undefined): string[];
export function normalizeSearchText(value: string): string;
```

Default limits:

- string leaf preview: 1000 characters
- array kept items: 20
- object kept entries per object: 50
- maximum preview depth: 8
- maximum serialized preview bytes per field: 32 KiB

Node format requirements:

1. Never add ClawLens metadata directly into user object key space.
2. Store object fields as `entries: [{ key, value }]`.
3. Represent arrays as ordered `items`.
4. Include `omittedItems` for truncated arrays.
5. Include `omittedEntries` for truncated objects.
6. Include `length` and `truncated` for long strings.
7. Include explicit metadata for depth truncation and circular references.
8. If the final serialized preview exceeds `maxSerializedBytes`, return a valid structured preview with a top-level truncation node rather than an invalid partial JSON string.

Compatibility rules:

1. Rows that do not contain a valid top-level `__clawlensPreview.version === 1` wrapper are `text-legacy`.
2. The UI must never treat arbitrary valid JSON text as structured preview.
3. Existing rows require no migration.

Redaction requirement:

1. `buildStructuredPreview` and `serializePreviewForTextColumn` must apply the same baseline sensitive-key redaction policy used by full source lookup before any preview is serialized into SQLite text columns.
2. Redaction behavior must be shared through one helper so preview storage and Phase 5 full-source responses cannot drift.
3. Initial matching rule should use case-insensitive substring containment for the baseline key list, so names such as `CLAUDE_API_KEY`, `sessionToken`, and `user_password_hint` are still redacted.

Config type targets:

- `extensions/clawlens/src/types.ts`
  - Add the feature gate fields before Phase 2 uses them:
    - `collector.structuredPreviews?: boolean`
    - `collector.sourceLookupDirs?: string[]`
    - `collector.sourceLookupEnabled?: boolean`

## Phase 2: Replace Collector Preview Slicing

Replace preview generation at collector boundaries, but keep the current SQLite schema.

Implementation targets:

- `recordLlmInput`
  - Store `active.lastUserPrompt` as a serialized preview string.
  - Keep `classifyPromptRunKind` working from the original prompt value, not from the serialized preview.
  - Keep queued-message run binding working by updating `findUnknownRunIdByPromptMessageId` before this storage change lands.
- `recordToolCall`
  - Store `argsSummary` with `serializePreviewForTextColumn(event.params)`.
  - Store `resultSummary` with `serializePreviewForTextColumn(event.result)` when a result exists.
  - Store error text as a bounded string preview.
- `recordAgentEnd`
  - Store fallback content preview with the shared builder.
  - Preserve `content_length` as the raw serialized content length.
- `normalizeTranscriptMessage`
  - Keep `raw` generation for `content_length`.
  - Store `preview` using the shared builder.
  - Keep tool-call counting on the original message content.
  - Return a separate raw/searchable content field for `classifyTranscriptTurnKind`.

Important compatibility notes:

1. Do not change table schemas in Phase 2.
2. Do not remove existing plain text handling.
3. Do not make run kind classification depend on rendered preview text.
4. Preserve existing source anchor writes for `message_id`, `session_file`, and source metadata.
5. Do not land Phase 2 until Phase 0 tests prove safe-message-anchor binding, logger preview mapping, and heartbeat/chat classification still work with structured preview rows.
6. Phase 2 preview writes must inherit the baseline redaction helper from Phase 1 so secrets are not exposed in default audit previews.

## Phase 3: API Preview Metadata

Update API response shaping so every preview-bearing field carries format metadata.

Store-layer targets:

- `extensions/clawlens/src/store.ts`
  - Add a small helper that parses text columns through `parsePreviewFormat`.
  - Use it in `buildRunAuditDetail`.
  - Add markers to run-level user prompt and turn previews.
  - Project `session_file` from `conversation_turns` where `hasSourceLookup` needs it.
  - Update or replace `stmtFindConvTurnByMessageId` in Phase 3 so later source lookup work can read `session_file`, `source_kind`, `source_session_id`, and `source_logger_ts` without another store API redesign.
- `extensions/clawlens/src/types.ts`
  - Reuse the feature gate fields added in Phase 1.
- `extensions/clawlens/src/api-routes.ts`
  - Pass source lookup configuration into response shaping, or compute `hasSourceLookup` at the API layer instead of inside `Store`.
  - `hasSourceLookup` must be false when source lookup is disabled or no trusted root exists.

Suggested response shape for run detail:

```json
{
  "userPrompt": "...",
  "userPromptPreviewFormat": "text-legacy",
  "userPromptPreviewVersion": null,
  "turns": [
    {
      "role": "user",
      "preview": "...",
      "previewFormat": "structured-json-v1",
      "previewVersion": 1,
      "length": 12000,
      "messageId": "msg_...",
      "sourceKind": "transcript_explicit",
      "hasSourceLookup": true
    }
  ]
}
```

For list and compact endpoints, keep payloads lightweight. It is acceptable for compact responses to include only text previews and markers needed by the UI, not expanded source metadata.

`hasSourceLookup` should be true only when there is enough anchor data to try lookup:

- message lookup: `messageId` plus `session_file` or a trusted source root is available.
- tool lookup: `runId` and `toolCallId` exist.

Config dependency:

- The store currently does not own plugin config.
- Either pass a source lookup capability object into store response builders, or compute source capability flags in `api-routes.ts` after store data is loaded.
- Do not make `hasSourceLookup` a pure database-derived field; it must reflect `collector.sourceLookupEnabled` and trusted-root availability.

## Phase 4: UI Structured Preview Rendering

Update Chat Audit rendering without triggering source lookup.

Implementation targets:

- `extensions/clawlens/ui/inject.js`
- `extensions/clawlens/ui/styles.css`

Renderer requirements:

1. Add a parser for structured preview envelopes.
2. Render `text-legacy` exactly as plain text.
3. Render `structured-json-v1` as a bounded label/value tree.
4. Show truncation metadata such as `length`, `truncated`, `omittedItems`, and `omittedEntries`.
5. Remove full preview content from `title` attributes for structured payloads and long strings.
6. Keep list and run-detail rendering stable during live refresh.

Hover behavior:

1. Hover renders only the currently materialized preview.
2. Hover does not call JSONL source endpoints.
3. Hover open and close are debounced.
4. Plain hover is read-only.
5. Collapse/expand controls are active only after the surface is pinned.
6. Pin triggers are:
   - mouse click on the preview row
   - keyboard focus followed by `Enter` or `Space`
   - explicit "open details" button inside the hover surface
7. Large values are collapsed by default.
8. The hover surface has bounded width and height with internal scrolling.
9. Tree expansion, collapse, and pin state must survive live refresh by keying UI state to stable row identifiers such as `messageId`, `runId`, and `toolCallId`.

Implementation approach:

1. Convert each `.clawlens-turn` into a data-backed row with preview metadata attributes or an in-memory render state keyed by `messageId`.
2. Add a delegated hover controller at the audit panel root.
3. Reuse the same renderer for hover and pinned detail.
4. Keep full source loading separate from hover state.

## Phase 5: JSONL Source Resolver

Add source lookup only after preview rendering is stable.

Recommended new file:

- `extensions/clawlens/src/source-resolver.ts`

Shared interface note:

- Phase 0 and Phase 5 must share the same transcript-candidate resolution entry point.
- Do not land a temporary Phase 0 filename fixer that later gets replaced by a separate Phase 5 parser.
- Minimum shared API:

```ts
export type ResolveTranscriptSourceCandidatesInput = {
  sessionFile: string | null | undefined;
  sourceLookupDirs?: string[];
  maxParentHops?: number;
  maxCandidateFiles?: number;
};

export type ResolveTranscriptSourceCandidatesResult = {
  sessionId: string | null;
  candidates: string[];
  misses: Array<"session_file_missing" | "session_id_unparseable" | "source_root_unavailable">;
};
```

- Phase 0 may use only the `sessionId` extraction and candidate enumeration subset, but it must call this shared interface so Phase 5 extends the same logic instead of forking it.
- In the current layered implementation, the shared helper owns basename/session-ID parsing and candidate typing, while trusted-root availability is enforced one layer up in `SourceResolver.collectCandidateFiles(...)`. If that split remains, `source_root_unavailable` should be treated as a resolver-layer typed miss, not as a requirement that every direct helper call emit it independently.

Configuration addition:

```ts
export type ClawLensConfig = {
  collector?: {
    structuredPreviews?: boolean;
    sourceLookupEnabled?: boolean;
    sourceLookupDirs?: string[];
  };
};
```

Lookup limits:

- maximum candidate files: 64
- maximum bytes scanned per request: 256 MiB
- maximum response bytes by default: 2 MiB
- timeout: 5 seconds by default
- maximum parent-session hops: 8
- maximum concurrent scans per process: 1 initially, with later expansion requiring explicit load testing

Source roots:

1. Directory of `conversation_turns.session_file`, even if the original file no longer exists.
2. Explicit `collector.sourceLookupDirs`.
3. Runtime-provided session roots if OpenClaw exposes a stable API later.

If no trusted root exists, return a typed miss. The following body is illustrative only; the HTTP status convention remains an Open Implementation Decision until Phase 6:

```json
{
  "ok": false,
  "miss": "source_root_unavailable"
}
```

Candidate files:

1. Exact `session_file` path.
2. Reset archives matching `<sessionId>.jsonl.reset.*`.
3. Deleted archives matching `<sessionId>.jsonl.deleted.*` only when diagnostics require it.
4. Checkpoint snapshots matching `<sessionId>.checkpoint.<uuid>.jsonl`.
5. Compaction successors matching `*_<sessionId>.jsonl`.
6. Parent transcript files referenced by successor header `parentSession`, within hop and cycle limits.

Latest-message lookup policy:

1. When ClawLens already has a trusted `sessionFile`, prefer direct file reads for “latest message” retrieval.
2. Keep host API history calls as an explicit fallback path, not the default path.
3. Current implementation status: this document sets the policy boundary, but the host API fallback path is not implemented in the current ClawLens source tree.
4. If an API fallback is enabled later, document the exact enablement reason in code comments or implementation docs. Acceptable reasons:
   - no usable `sessionFile`
   - runtime cannot read transcript files directly
   - caller needs host-side projection / sanitization semantics
   - lifecycle movement made the file path temporarily unusable and host-side assistance is needed first

Message lookup:

1. Load the `conversation_turns` row by `messageId`.
2. Ensure this query includes `session_file`, `source_kind`, `source_session_id`, and `source_logger_ts`; the current `stmtFindConvTurnByMessageId` is not sufficient as-is.
3. Build candidates from the stored `session_file`.
4. Stream JSONL line by line.
5. Parse one line at a time and stop when `id === messageId`.
6. Return normalized source metadata and capped payload content.

Tool lookup:

1. Load the `tool_executions` row by `runId` and `toolCallId`.
2. Use the run's conversation turns as source-root hints when possible.
3. Search assistant messages for content blocks whose tool call ID matches `toolCallId`.
4. Search tool result messages for `toolCallId` or provider-equivalent fields.
5. Return separate `toolCall` and `toolResult` sections.
6. If only one side is found, return a partial result with a `missing` array.

Security requirements:

1. Reject paths outside trusted roots.
2. Resolve symlinks before root containment checks when the platform supports it.
3. Do not scan broad filesystem locations.
4. Do not expose source lookup through unauthenticated static routes.
5. Cap response bytes and mark `truncated: true` when capped.
6. Treat the current no-token case in `api-routes.ts` as insufficient for source lookup. Source endpoints must require either configured plugin auth or an equivalent authenticated plugin boundary; if no token/auth context is available, return a disabled/unauthorized response instead of serving source content.
7. Apply a baseline redaction pass to obvious sensitive keys before returning source payloads. Minimum default key match list: case-insensitive substring matching for `key`, `token`, `password`, `secret`, `authorization`, `cookie`, `set-cookie`, `api-key`, and `x-api-key`.

Transcript file parsing:

- Use the Phase 0 resolver helper that supports:
  - `<sessionId>.jsonl`
  - `<sessionId>.jsonl.reset.<timestamp>`
  - `<sessionId>.jsonl.deleted.*`
  - compaction successor names such as `*_<sessionId>.jsonl`
- Do not add a second ad hoc parser in source lookup; share the Phase 0 helper.
- Source scanning must be stream-based or equivalently incremental; do not require fully loading multi-hundred-MiB transcript files into memory or blocking the extension on parallel synchronous scans.

## Phase 6: Source API Routes

Add source endpoints in `extensions/clawlens/src/api-routes.ts`.

Routes:

- `GET /plugins/clawlens/api/audit/source/message/:messageId`
- `GET /plugins/clawlens/api/audit/source/tool/:runId/:toolCallId`

Route ordering:

1. Register these before generic `/audit/message/:messageId` handling.
2. Keep them inside the existing `/plugins/clawlens/api` route.
3. Use the same Bearer token and plugin auth path as current audit endpoints.
4. Refuse source responses when no auth token or equivalent plugin auth context is configured.
5. Return 404 only for unknown rows.
6. Return typed lookup misses as HTTP 200 with `ok: false`, and document that convention in route tests.

Suggested success response:

```json
{
  "ok": true,
  "sourceKind": "transcript_explicit",
  "messageId": "msg_...",
  "sessionFile": "...",
  "payload": {
    "role": "user",
    "content": "..."
  },
  "bytes": 12345,
  "truncated": false
}
```

Suggested tool partial response:

```json
{
  "ok": true,
  "toolCallId": "call_...",
  "toolCall": { "payload": {} },
  "toolResult": null,
  "missing": ["toolResult"],
  "truncated": false
}
```

## Phase 7: Explicit Full Source UI

Add explicit source loading after the endpoints are covered by backend tests.

UI requirements:

1. Show a small affordance when `hasSourceLookup` is true.
2. Fetch full source only on explicit click.
3. Cache full payloads in memory by `messageId` or `toolCallId`.
4. Enforce cache limits:
   - maximum entries: 50
   - maximum aggregate cached bytes: 16 MiB
   - TTL: 15 minutes since last access
   - eviction: least recently used first
5. Render large source payloads behind expand/load-more controls.
6. Never put full payloads in `title` attributes.
7. Show typed miss states clearly, including `source_root_unavailable`.

## Test Plan

Unit tests:

- `extensions/clawlens/tests/store.test.ts`
  - `findUnknownRunIdByPromptMessageId` works for legacy raw prompt previews.
  - `findUnknownRunIdByPromptMessageId` works for structured preview rows whose message ID is represented as object entries.
  - `applyLoggerSessionPreviewMapping` works when the stored preview is structured and the user text contains quotes or backslashes.
  - `classifyTranscriptTurnKind` uses raw/searchable content, not serialized structured preview JSON.
- `extensions/clawlens/tests/collector.test.ts`
  - `recordToolCall` stores valid structured preview JSON for nested args and results.
  - long strings keep object structure while truncating only the leaf.
  - arrays preserve order and expose omitted counts.
  - circular values do not throw.
  - fallback transcript turns still store length from raw content.
  - preview serialization redacts sensitive keys before data reaches preview columns.
- `extensions/clawlens/tests/store.test.ts`
  - legacy text rows return `previewFormat: "text-legacy"`.
  - structured wrapper rows return `previewFormat: "structured-json-v1"`.
  - arbitrary valid JSON without wrapper remains `text-legacy`.
  - run detail includes preview markers for user prompt and turns.
  - source lookup row helpers find message and tool anchors.
  - `hasSourceLookup` is false when lookup is disabled or no trusted source root is configured.
  - `extractSessionIdFromSessionFile` or its replacement supports reset/deleted archive names.
  - a 32 KiB structured preview payload survives SQLite storage and readback without silent truncation.
- New source resolver tests:
  - exact `session_file` lookup.
  - reset archive lookup.
  - compaction successor-to-parent lookup.
  - cycle rejection.
  - trusted root rejection.
  - scan byte limit and response byte cap.
  - concurrency guard rejects or queues a second simultaneous scan per process, according to the chosen implementation.
  - scan timeout returns the chosen typed miss without leaking partial unredacted payloads.
  - tool call and tool result partial lookup.

Frontend checks:

- legacy text still renders as before.
- structured preview renders as label/value tree.
- hover does not call source endpoints.
- pinned detail enables collapse/expand.
- long values do not resize the full sidebar unexpectedly.
- full source loads only after explicit click.
- full source cache evicts by entry count, byte count, and TTL.

Commands:

```bash
cd extensions/clawlens
npm run typecheck
npm test
```

Docs governance check:

```bash
node scripts/check-docs-governance.mjs
```

## Rollout Plan

1. Land Phase 0 compatibility fixes and tests for preview-dependent matching/classification paths.
2. Land the preview builder, config type fields, feature gates, and tests with no caller changes.
3. Switch collector preview generation to the builder.
4. Add API metadata and preview capability flags.
5. Pass the Phase 3 to Phase 4 acceptance gate.
6. Update UI to render legacy and structured previews.
7. Add hover and pinned detail interaction.
8. Add source resolver behind trusted root configuration.
9. Add authenticated source API routes.
10. Add explicit full-source UI and bounded cache.

Recommended feature gates:

- `collector.structuredPreviews?: boolean`
- `collector.sourceLookupDirs?: string[]`
- `collector.sourceLookupEnabled?: boolean`

Default rollout:

1. `structuredPreviews` can default to enabled after unit tests pass because it does not change schema.
2. `sourceLookupEnabled` should default to false unless trusted roots are configured.
3. Full source UI should hide explicit load buttons when the backend reports `hasSourceLookup: false`.

## Acceptance Gates

Do not start Phase 4 until:

1. Phase 3 API responses include `previewFormat` and `previewVersion` for every preview-bearing field the UI renders.
2. Legacy rows are verified as `text-legacy`.
3. Structured wrapper rows are verified as `structured-json-v1`.
4. `hasSourceLookup` reflects source lookup config and trusted-root availability.

Do not start Phase 5 until:

1. Structured preview tests pass.
2. API responses distinguish `text-legacy` and `structured-json-v1`.
3. The UI can render both formats.
4. Hover is preview-only and does not issue source requests.
5. `extractSessionIdFromSessionFile` or its replacement handles reset/deleted archive names.

Do not expose source endpoints until:

1. Auth behavior is covered by route tests or manual verification.
2. Trusted-root containment is tested.
3. Scan limits and response caps are tested.
4. Reset and compaction lookup cases have fixtures.
5. The no-token/open-by-default case cannot return source payloads.

Do not enable full source UI until:

1. Source endpoint typed misses render cleanly.
2. Full payload cache limits are implemented.
3. Large source payloads render incrementally or behind explicit expansion.

## Open Implementation Decisions

These decisions remain open from the analysis plan and must be closed during implementation:

1. Whether tool result lookup should use transcript JSONL only, or also llm-api-logger request/response logs when configured.
2. Whether source lookup should expose raw JSONL line data, normalized message data, or both.
3. Which known sensitive fields should be redacted by default in source responses.

The following decisions are closed and should not be reopened during implementation without a new design review:

1. Start with existing text columns for structured preview storage.
2. Use `__clawlensPreview.version === 1` as the only structured preview marker.
3. Keep hover preview-only.
4. Require authenticated plugin API access for source endpoints.
5. Disable source lookup unless trusted roots are available.
6. Return typed lookup misses as HTTP 200 with `ok: false`; reserve 404 for unknown rows and 401/403-style responses for auth failures.
7. Phase 0 and Phase 5 must share one transcript source-candidate resolver interface.
8. Apply a minimum baseline sensitive-key redaction pass in source responses using the default key list defined in Phase 5.
