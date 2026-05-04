---
status: active
created: 2026-05-01
updated: 2026-05-02
---

# ClawLens Structured Preview and JSONL Source Lookup Analysis

## Context

ClawLens currently stores short text previews for user input, transcript turns, and tool data. This keeps the Chat Audit panel fast, but the current truncation strategy is mostly string-based:

- `llm_input` stores a short `user_prompt_preview`.
- `after_tool_call` stores `args_summary` and `result_summary`.
- transcript turns store `content_preview`.

This creates two separate issues:

1. Long JSON-like values lose structure after raw string slicing.
2. Full source text is not available from ClawLens storage after truncation.

The preferred direction is not to store full payloads in the ClawLens database by default. Instead, ClawLens should keep lightweight previews for normal browsing and add on-demand source lookup from OpenClaw transcript JSONL when the user requests full detail.

## Current Problem

The current preview behavior optimizes for size, not semantic readability. For structured values, a raw string slice can cut through:

- JSON keys
- nested arrays or objects
- string escape sequences
- tool call blocks
- tool result blocks
- provider-specific content blocks

This makes the preview harder to trust. A user may see malformed JSON in the audit panel even though the original message or tool payload is valid.

## Design Goals

1. Preserve structure in previews whenever the input is structured.
2. Truncate only large leaves or oversized collections, not the entire serialized object.
3. Keep the default audit list and run detail fast.
4. Preserve enough source anchors for later JSONL lookup.
5. Avoid storing full sensitive payloads in ClawLens SQLite unless an explicit future retention policy is accepted.
6. Handle reset and compaction transcript file movement.

## Non-Goals

1. Do not render full text by default in the audit panel.
2. Do not replace source JSONL with ClawLens as the system of record.
3. Do not add large unbounded blobs to existing summary fields.
4. Do not rely only on llm-api-logger JSONL for transcript recovery.

## Proposed Preview Strategy

Replace raw string slicing with a structured preview builder.

The builder should accept unknown values and return a JSON-safe preview object or preview string with bounded size. It should:

1. Preserve object keys without reusing user key space for ClawLens metadata.
2. Preserve array order for the first N elements.
3. Truncate long string leaves with metadata.
4. Truncate oversized arrays with omitted-count metadata.
5. Truncate deep nesting with depth metadata.
6. Mark circular references if encountered.
7. Return valid JSON when the source value is JSON-like.

### Metadata Namespace

The preview format must avoid metadata collisions with real payload keys. Do not inject keys such as `$type`, `$preview`, `$length`, or `$truncated` into user objects. These keys are common in JSON Schema, MongoDB-like payloads, and provider-specific content blocks.

Use a wrapper format instead:

```json
{
  "__clawlensPreview": {
    "version": 1,
    "node": {
      "kind": "object",
      "entries": []
    },
    "meta": {
      "source": "structured-preview"
    }
  }
}
```

The stored wrapper version and API preview markers are tied together:

- `__clawlensPreview.version: 1` maps to `previewFormat: "structured-json-v1"` and `previewVersion: 1`.
- Missing wrapper metadata maps to `previewFormat: "text-legacy"` and `previewVersion: null`.

Object nodes should represent user keys as data, not as preview metadata fields:

```json
{
  "kind": "object",
  "entries": [
    {
      "key": "$type",
      "value": {
        "kind": "string",
        "value": "user_defined"
      }
    }
  ]
}
```

This keeps a real user key such as `$type` distinct from ClawLens preview metadata.

Example structured preview node:

```json
{
  "kind": "object",
  "entries": [
    {
      "key": "cmd",
      "value": {
        "kind": "string",
        "preview": "very long command...",
        "length": 12420,
        "truncated": true
      }
    },
    {
      "key": "options",
      "value": {
        "kind": "object",
        "entries": [
          { "key": "cwd", "value": { "kind": "string", "value": "extensions/clawlens" } },
          { "key": "timeoutMs", "value": { "kind": "number", "value": 300000 } }
        ]
      }
    }
  ]
}
```

For arrays:

```json
{
  "kind": "array",
  "items": [
    { "kind": "object", "entries": [{ "key": "type", "value": { "kind": "string", "value": "text" } }] },
    { "kind": "object", "entries": [{ "key": "type", "value": { "kind": "string", "value": "toolCall" } }] }
  ],
  "omittedItems": 3
}
```

Initial preview limits:

- string leaf preview: 1000 characters
- array kept items: 20
- object kept entries per object: 50
- maximum preview depth: 8
- maximum serialized preview bytes per field: 32 KiB

These are preview defaults only. JSONL source lookup has separate scan and response limits.

For plain text, the builder can still return a text preview, but it should use a consistent marker:

```json
{
  "kind": "string",
  "preview": "first part of text...",
  "length": 12000,
  "truncated": true
}
```

## Storage Shape Options

### Option A: Keep Existing Columns, Store Structured JSON String

Keep `content_preview`, `args_summary`, `result_summary`, and `user_prompt_preview` as text columns, but store structured preview JSON when the value is structured.

Pros:

- Minimal schema migration.
- Low implementation risk.
- Existing UI can keep rendering escaped text.

Cons:

- UI still needs parsing to render the structure well.
- Existing callers may assume these fields are plain text.

### Option B: Add Separate Structured Preview Columns

Add columns such as:

- `conversation_turns.content_preview_json`
- `tool_executions.args_preview_json`
- `tool_executions.result_preview_json`
- `llm_calls.user_prompt_preview_json`

Pros:

- Backward compatible with current text preview fields.
- UI can opt into structured rendering gradually.

Cons:

- Requires migration and API shape updates.
- More storage fields to maintain.

### Recommendation

Start with Option A for the internal preview builder and tests, but every API response must include a format/version marker so the UI can distinguish legacy text previews from structured previews.

Required API markers:

- `previewFormat: "text-legacy" | "structured-json-v1"`
- `previewVersion: 1 | null`

Under Option A, no additional marker column is required in the first implementation. The API derives the marker at query time:

1. Try to parse the existing text column as JSON.
2. If the parsed object has top-level `__clawlensPreview.version === 1`, return `previewFormat: "structured-json-v1"` and `previewVersion: 1`.
3. Otherwise return `previewFormat: "text-legacy"` and `previewVersion: null`.
4. The UI must never infer structured preview semantics from arbitrary valid JSON unless the wrapper is present.

If the UI needs a richer tree renderer soon, Option B is cleaner.

## JSONL Source Lookup Strategy

Structured previews are not a substitute for full source lookup. The source lookup plan should still be followed.

Default audit endpoints should keep returning previews only. Full data should load on demand through new source endpoints.

Candidate endpoints:

- `GET /plugins/clawlens/api/audit/source/message/:messageId`
- `GET /plugins/clawlens/api/audit/source/tool/:runId/:toolCallId`

These endpoints are sensitive. They must use the same authenticated plugin API boundary as existing audit endpoints and must not be exposed as unauthenticated static routes. Source lookup should be disabled by default unless the ClawLens collector has enough trusted path configuration to constrain file access.

Lookup priority:

1. Use `conversation_turns.session_file` plus `message_id`.
2. If the file exists, stream-read JSONL and stop on the matching `id`.
3. If the file no longer exists, use the stored `session_file` directory as the first candidate root if the path is still present in the database.
4. Include reset archives matching `<sessionId>.jsonl.reset.*`.
5. Include deleted archives matching `<sessionId>.jsonl.deleted.*` only if useful for diagnostics.
6. Include compaction checkpoint files matching `<sessionId>.checkpoint.<uuid>.jsonl`.
7. Include compaction successor files matching `*_<sessionId>.jsonl`.
8. Follow successor header `parentSession` backward from successor to parent when needed and allowed.
9. Stop after a bounded number of parent hops and reject cycles.

Candidate roots:

1. The directory of `conversation_turns.session_file`, even if the file itself no longer exists.
2. Explicitly configured roots such as a future `collector.sourceLookupDirs`.
3. Runtime-provided session roots, if OpenClaw exposes a stable API for them.

Latest-message lookup policy:

1. When a trusted `sessionFile` is already known, direct file reads should be the default path for “latest message” style lookup.
2. Host API history calls should be retained as fallback only.
3. Current implementation status: this is a recommended policy, not a claim that the current ClawLens source tree already implements a host API fallback path.
4. If an API fallback is enabled, the enablement reason should be explicit and reviewable rather than implicit. Valid reasons include:
   - no usable `sessionFile`
   - runtime policy forbids direct file access
   - host-side projection / sanitization semantics are required
   - lifecycle movement temporarily invalidated the file path and host-side assistance is needed first

If no trusted candidate root exists, source lookup must return a typed miss such as `source_root_unavailable`; it must not guess from the process working directory or scan broad filesystem locations.

The lookup should be bounded:

- maximum candidate files: 64
- maximum bytes scanned per request: 256 MiB
- maximum response bytes by default: 2 MiB
- timeout or abort signal support: 5 seconds by default
- maximum parent-session hops: 8
- cycle detection for `parentSession`

### Tool Source Lookup

Tool source lookup has a second matching step after file discovery:

1. Locate the ClawLens `tool_executions` row by `runId` and `toolCallId`.
2. Search candidate JSONL lines for assistant content blocks whose tool call ID matches `toolCallId`.
3. Search candidate JSONL lines for tool result messages whose `toolCallId` or provider-equivalent field matches `toolCallId`.
4. Return separate normalized sections for `toolCall` and `toolResult` when both exist.
5. If only one side is found, return a partial result with `missing: ["toolCall"]` or `missing: ["toolResult"]`.

The endpoint should not rely on text matching for tool lookup unless the structured IDs are absent.

## Reset and Compaction Considerations

Reset can archive transcript files by renaming them to `.jsonl.reset.<timestamp>`. ClawLens should not assume every stored `session_file` still ends with `.jsonl`.

Compaction can rotate to a successor transcript with a new session ID and a new file name. The successor header can point back to the parent session file.

Observed OpenClaw reference points:

- Reset archives are represented as `.jsonl.reset.<timestamp>` in `projects-ref/openclaw/src/gateway/session-reset-service.ts` and `projects-ref/openclaw/src/gateway/session-transcript-files.fs.ts`.
- Archive file classification for reset/deleted transcripts is covered in `projects-ref/openclaw/src/config/sessions/artifacts.test.ts`.
- Compaction successor transcripts are written as `*_<sessionId>.jsonl`, and their header includes `parentSession`, in `projects-ref/openclaw/src/agents/pi-embedded-runner/compaction-successor-transcript.ts`.

Implications:

1. Session ID extraction should support archived transcript names.
2. Source lookup should treat `session_file` as a historical source hint, not as a guaranteed current path.
3. If lookup falls back to directory scanning, it should prefer exact file paths and message IDs over text matching.
4. Text matching should be a last resort because previews may be structured and truncated.
5. `parentSession` traversal is from successor to parent. Forward lookup from a parent to unknown successors is allowed only inside trusted roots and bounded candidate scans.

## Frontend Latency Constraints

Full text rendering must not block the normal audit experience.

The UI should:

1. Render previews only on initial run list and run detail load.
2. Fetch full message/tool payload only when the user expands a specific item.
3. Cache full payloads in memory by `messageId` or `toolCallId`, with an LRU or TTL cap.
4. Render large payloads incrementally or behind a "load more" control.
5. Avoid putting full payloads into attributes such as `title`.
6. Use a stable-height detail area so expanding content does not cause heavy layout churn.

Initial full-payload cache limits:

- maximum entries: 50
- maximum aggregate cached bytes: 16 MiB
- TTL: 15 minutes since last access
- eviction: least recently used first

## Hover Detail Interaction

Message and tool preview content should support hover-based detail inspection.

The hover detail should:

1. Show the complete currently materialized preview content for the hovered message or tool field.
2. Render structured content as a `label: value` form-style view rather than as a single raw JSON string.
3. Preserve nested structure with indentation or grouped sections.
4. Use stable labels derived from object keys, array indexes, or known fields such as `role`, `content`, `toolName`, `toolCallId`, `arguments`, and `result`.
5. Provide collapse/expand controls for long values, long arrays, and nested objects.
6. Default long text leaves to a collapsed preview, with an explicit expand action.
7. Keep the hover surface bounded in width and height, with internal scrolling when necessary.
8. Avoid triggering JSONL source lookup automatically on hover.
9. Debounce hover opening and closing to avoid repeated tree rendering during fast pointer movement.
10. Convert to a pinned popover, drawer, or detail panel before allowing interactive collapse/expand controls.

Pinned mode triggers:

- mouse click on the preview row
- keyboard focus followed by `Enter` or `Space`
- explicit "open details" button inside the hover surface

Plain hover remains read-only. Collapse/expand controls are enabled only after the surface is pinned.

If only the structured preview is available, the hover surface should clearly render that preview and its truncation metadata. Full source content belongs in the explicit click-to-load detail interaction. Hover may show a small "full source available" affordance, but should not render multi-MB cached payloads automatically.

This interaction should not replace explicit click-to-load behavior for large source payloads. Hover should remain lightweight and should not introduce expensive file scans or network requests during normal pointer movement.

The backend should:

1. Stream JSONL instead of loading whole files.
2. Return size metadata.
3. Cap payload size.
4. Mark partial responses with `truncated: true`.

## Suggested API Metadata

Run detail turns should include lightweight source metadata:

```json
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
```

Tool timeline or detail entries should include:

```json
{
  "type": "tool_execution",
  "toolName": "read",
  "toolCallId": "call_...",
  "argsPreview": { "...": "..." },
  "resultPreview": { "...": "..." },
  "hasSourceLookup": true
}
```

## Open Questions

1. Should tool result lookup use transcript JSONL only, or also llm-api-logger request/response logs when configured?
2. Should source lookup expose raw JSONL line data, normalized message data, or both?
3. Which known sensitive fields should be redacted by default in source responses?

The following items are not open questions and must be decided before implementation:

- Source endpoints require authenticated plugin API access.
- Source lookup roots must be explicit or derived from stored `session_file` paths.
- Preview metadata must use a collision-safe wrapper format.
- Hover must not trigger JSONL scanning.

## Acceptance Criteria

Structured preview acceptance:

1. A payload containing user keys named `$type`, `$preview`, `$length`, or `__clawlensPreview` remains distinguishable from ClawLens metadata.
2. Long string leaves are truncated with `length` and `truncated` metadata while surrounding object/array structure remains valid.
3. Oversized arrays preserve item order for kept elements and expose omitted-count metadata.
4. Deep objects stop at a configured depth with explicit truncation metadata.
5. Circular references do not throw and are represented with explicit circular metadata.
6. Legacy rows without `previewFormat` still render as plain text.

Source lookup acceptance:

1. Message lookup resolves an existing `messageId` from the exact `session_file` path.
2. Message lookup resolves a reset archive named `<sessionId>.jsonl.reset.<timestamp>` when the original file has been renamed.
3. Message lookup follows `parentSession` from a compaction successor to its parent within the configured hop limit.
4. Lookup fails with a typed miss when no trusted root is available.
5. Lookup enforces candidate count, byte scan, response size, timeout, and parent-hop limits.
6. Tool lookup can return separate `toolCall` and `toolResult` sections for a matching `toolCallId`.

Security and UI acceptance:

1. Source endpoints are not reachable without the same authorization required by existing audit APIs.
2. Hover renders only structured preview data and never starts JSONL source lookup.
3. Full payload rendering is available only through explicit click-to-load behavior.
4. Full payload cache enforces the initial 50-entry, 16 MiB, 15-minute LRU/TTL cap unless implementation testing changes the constants.
5. Large payload responses include size metadata and `truncated: true` when capped.

## Initial Recommendation

Proceed in two phases:

1. Structured preview phase:
   - Add a shared preview builder.
   - Replace raw `.slice(...)` calls in collector preview paths.
   - Keep preview payloads bounded and valid.
   - Add tests for nested JSON, long strings, arrays, circular values, and plain text.

2. On-demand source lookup phase:
   - Add source resolver service.
   - Add message and tool source endpoints.
   - Add reset and compaction-aware file lookup.
   - Add UI lazy loading and in-memory cache.

This keeps the immediate semantic preview problem small while preserving the longer-term full-source plan.
