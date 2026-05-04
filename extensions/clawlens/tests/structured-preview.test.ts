import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStructuredPreview,
  extractMessageIdsFromPreview,
  extractSearchTextFromPreview,
  normalizeSearchText,
  parsePreviewFormat,
  resolveTranscriptSourceCandidates,
  serializePreviewForTextColumn,
} from "../src/structured-preview.js";

describe("structured-preview", () => {
  test("legacy plain preview can extract search text and message ids", () => {
    const preview = 'hello {"message_id":"msg-123"} world';
    assert.equal(extractSearchTextFromPreview(preview), preview);
    assert.deepEqual(extractMessageIdsFromPreview(preview), ["msg-123"]);
  });

  test("structured preview can extract search text and message ids", () => {
    const preview = serializePreviewForTextColumn({
      blocks: [
        { type: "text", text: 'say "hello" \\ world' },
        { message_id: "msg-structured-1" },
      ],
    });
    const searchText = extractSearchTextFromPreview(preview);
    assert.match(searchText, /hello/);
    assert.match(searchText, /message_id/);
    assert.deepEqual(extractMessageIdsFromPreview(preview), ["msg-structured-1"]);
  });

  test("arbitrary JSON text is not treated as structured preview", () => {
    const rawJson = JSON.stringify({ hello: "world" });
    assert.deepEqual(parsePreviewFormat(rawJson), {
      previewFormat: "text-legacy",
      previewVersion: null,
    });
  });

  test("preview builder handles nested object/array, long strings, circular values, and redaction", () => {
    const circular: Record<string, unknown> = {
      items: [{ deep: { text: "x".repeat(1100) } }],
      apiKey: "secret-value",
    };
    circular.self = circular;

    const serialized = serializePreviewForTextColumn(circular);
    const parsed = parsePreviewFormat(serialized);
    assert.equal(parsed.previewFormat, "structured-json-v1");
    const nodeText = JSON.stringify(parsed.previewNode);
    assert.match(nodeText, /"kind":"array"/);
    assert.match(nodeText, /"omitted|truncated|length"/);
    assert.match(nodeText, /"kind":"circular_reference"/);
    assert.match(nodeText, /"kind":"redacted"|__clawlensRedacted/);
  });

  test("32 KiB max bytes returns valid truncation wrapper instead of partial JSON", () => {
    const serialized = serializePreviewForTextColumn({
      large: Array.from({ length: 200 }, (_, i) => ({ index: i, text: "z".repeat(300) })),
    }, {
      maxStringChars: 300,
      maxArrayItems: 200,
      maxObjectEntries: 20,
      maxSerializedBytes: 512,
    });
    const parsed = parsePreviewFormat(serialized);
    assert.equal(parsed.previewFormat, "structured-json-v1");
    assert.match(JSON.stringify(parsed.previewNode), /max_bytes_truncated/);
  });

  test("normalizeSearchText collapses whitespace and case", () => {
    assert.equal(normalizeSearchText('  A "B"   \\\\ C  '), 'a "b" \\\\ c');
  });

  test("transcript source candidate resolver supports exact, reset, deleted, checkpoint, and compaction successor names", () => {
    const exact = resolveTranscriptSourceCandidates({ sessionFile: "/tmp/11111111-1111-1111-1111-111111111111.jsonl" });
    assert.equal(exact.sessionId, "11111111-1111-1111-1111-111111111111");
    assert.equal(exact.candidates[0]?.type, "exact");
    assert.deepEqual(exact.misses, []);

    const reset = resolveTranscriptSourceCandidates({ sessionFile: "/tmp/22222222-2222-2222-2222-222222222222.jsonl.reset.20260501" });
    assert.equal(reset.sessionId, "22222222-2222-2222-2222-222222222222");
    assert.equal(reset.candidates[0]?.type, "reset");
    assert.deepEqual(reset.misses, []);

    const deleted = resolveTranscriptSourceCandidates({ sessionFile: "/tmp/33333333-3333-3333-3333-333333333333.jsonl.deleted.20260501" });
    assert.equal(deleted.sessionId, "33333333-3333-3333-3333-333333333333");
    assert.equal(deleted.candidates[0]?.type, "deleted");
    assert.deepEqual(deleted.misses, []);

    const checkpoint = resolveTranscriptSourceCandidates({
      sessionFile: "/tmp/44444444-4444-4444-4444-444444444444.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
    });
    assert.equal(checkpoint.sessionId, "44444444-4444-4444-4444-444444444444");
    assert.equal(checkpoint.candidates[0]?.type, "compaction_checkpoint");
    assert.deepEqual(checkpoint.misses, []);

    const successor = resolveTranscriptSourceCandidates({ sessionFile: "/tmp/compacted_55555555-5555-5555-5555-555555555555.jsonl" });
    assert.equal(successor.sessionId, "55555555-5555-5555-5555-555555555555");
    assert.equal(successor.candidates[0]?.type, "compaction_successor");
    assert.deepEqual(successor.misses, []);
  });

  test("transcript source candidate resolver reports explicit misses", () => {
    assert.deepEqual(resolveTranscriptSourceCandidates({ sessionFile: null }), {
      sessionId: null,
      candidates: [],
      misses: ["session_file_missing"],
    });
    assert.deepEqual(resolveTranscriptSourceCandidates({ sessionFile: "/tmp/not-a-session-name.jsonl" }), {
      sessionId: null,
      candidates: [],
      misses: ["session_id_unparseable"],
    });
  });

  test("buildStructuredPreview returns envelope object", () => {
    const built = buildStructuredPreview({ ok: true });
    assert.equal(typeof built, "object");
    assert.equal((built as any).__clawlensPreview.version, 1);
  });
});
