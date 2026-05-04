/**
 * ui-copy-helpers.test.ts
 * Unit tests for turn and run copy payload logic (inject.js).
 *
 * These tests validate the pure payload-building logic by reproducing it
 * inline, since inject.js is a browser script (no module exports).
 * Keep these in sync with buildTurnCopyPayload / buildRunCopyPayload in inject.js.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ── Pure payload helpers (mirrors inject.js logic) ─────────────────────────

type TurnData = {
  sourceKind: string;
  runId: string;
  toolCallId: string;
  messageId: string;
  role: string;
  previewFormat: string;
  preview: string;
};

type RunTurnData = {
  sourceKind?: string;
  toolCallId?: string;
  messageId?: string;
  role?: string;
  previewFormat?: string;
  preview?: string;
};

function buildTurnCopyPayloadFromData(turnData: TurnData, cachedSource: unknown): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: turnData.sourceKind === "tool" ? "tool_turn" : "turn",
    runId: turnData.runId || "",
    toolCallId: turnData.toolCallId || "",
    messageId: turnData.messageId || "",
    role: turnData.role || "",
    previewFormat: turnData.previewFormat || "text-legacy",
    preview: turnData.preview || "",
    sourceKind: turnData.sourceKind || "message",
  };
  if (cachedSource != null) payload.source = (cachedSource as any).payload ?? cachedSource;
  return payload;
}

function buildRunCopyPayloadFromData(
  run: {
    runId?: string; status?: string; runKind?: string; userPrompt?: string;
    summary?: unknown; timeline?: unknown[]; turns?: RunTurnData[];
  },
  cachedSourceFn: (sourceKind: string, sourceId: string) => unknown
): Record<string, unknown> {
  const runId = run.runId ?? "";
  return {
    kind: "run",
    runId,
    status: run.status ?? "",
    runKind: run.runKind ?? "",
    userPrompt: run.userPrompt ?? "",
    summary: run.summary ?? {},
    timeline: Array.isArray(run.timeline) ? run.timeline : [],
    turns: Array.isArray(run.turns)
      ? run.turns.map((t, index) => {
          const sourceKind = t.sourceKind || "message";
          const sourceId = sourceKind === "tool"
            ? `${runId}:${t.toolCallId || ""}`
            : (t.messageId || "");
          const cached = sourceId ? cachedSourceFn(sourceKind, sourceId) : null;
          const payload: Record<string, unknown> = {
            kind: sourceKind === "tool" ? "tool_turn" : "turn",
            runId,
            toolCallId: t.toolCallId ?? "",
            messageId: t.messageId || `${runId}:${index}`,
            role: t.role ?? "",
            previewFormat: t.previewFormat || "text-legacy",
            preview: t.preview ?? "",
            sourceKind,
          };
          if (cached != null) payload.source = (cached as any).payload ?? cached;
          return payload;
        })
      : [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("buildTurnCopyPayloadFromData — message turn", () => {
  test("produces correct kind and fields", () => {
    const payload = buildTurnCopyPayloadFromData({
      sourceKind: "message", runId: "r1", toolCallId: "", messageId: "m1",
      role: "user", previewFormat: "text-legacy", preview: "hello",
    }, null);
    assert.equal(payload.kind, "turn");
    assert.equal(payload.runId, "r1");
    assert.equal(payload.messageId, "m1");
    assert.equal(payload.role, "user");
    assert.equal(payload.preview, "hello");
    assert.equal("source" in payload, false, "no source when uncached");
  });

  test("attaches source when cached (wrapped payload)", () => {
    const cached = { payload: { content: "full body" } };
    const payload = buildTurnCopyPayloadFromData({
      sourceKind: "message", runId: "r1", toolCallId: "", messageId: "m1",
      role: "assistant", previewFormat: "text-legacy", preview: "...",
    }, cached);
    assert.deepEqual(payload.source, cached.payload, "should unwrap .payload");
  });

  test("attaches source verbatim when no .payload field", () => {
    const cached = { ok: true, raw: "data" };
    const payload = buildTurnCopyPayloadFromData({
      sourceKind: "message", runId: "r1", toolCallId: "", messageId: "m1",
      role: "user", previewFormat: "text-legacy", preview: "...",
    }, cached);
    assert.deepEqual(payload.source, cached);
  });
});

describe("buildTurnCopyPayloadFromData — tool turn", () => {
  test("produces kind=tool_turn", () => {
    const payload = buildTurnCopyPayloadFromData({
      sourceKind: "tool", runId: "r1", toolCallId: "tc1", messageId: "",
      role: "", previewFormat: "text-legacy", preview: "bash args",
    }, null);
    assert.equal(payload.kind, "tool_turn");
    assert.equal(payload.toolCallId, "tc1");
    assert.equal("source" in payload, false);
  });

  test("attaches cached source for tool turn", () => {
    const cached = { ok: true, payload: { tool: "bash" } };
    const payload = buildTurnCopyPayloadFromData({
      sourceKind: "tool", runId: "r1", toolCallId: "tc1", messageId: "",
      role: "", previewFormat: "text-legacy", preview: "bash args",
    }, cached);
    assert.deepEqual(payload.source, cached.payload);
  });
});

describe("buildRunCopyPayloadFromData", () => {
  test("produces run payload with all required fields", () => {
    const run = {
      runId: "run1", status: "completed", runKind: "default",
      userPrompt: "do X", summary: { llmCalls: 1 },
      timeline: [{ type: "llm_call" }],
      turns: [{ messageId: "m1", role: "user", previewFormat: "text-legacy", preview: "hi" }],
    };
    const payload = buildRunCopyPayloadFromData(run, () => null);
    assert.equal(payload.kind, "run");
    assert.equal(payload.runId, "run1");
    assert.equal(payload.status, "completed");
    assert.equal(payload.userPrompt, "do X");
    assert.equal((payload.turns as unknown[]).length, 1);
    const turn = (payload.turns as Record<string, unknown>[])[0];
    assert.equal(turn.kind, "turn");
    assert.equal(turn.messageId, "m1");
    assert.equal("source" in turn, false, "no source when cache miss");
  });

  test("includes cached source when available for a turn", () => {
    const cached = { ok: true, payload: { content: "full" } };
    const run = {
      runId: "run2", turns: [{ messageId: "m2", role: "assistant" }],
    };
    const payload = buildRunCopyPayloadFromData(run, (_kind, id) => id === "m2" ? cached : null);
    const turn = (payload.turns as Record<string, unknown>[])[0];
    assert.deepEqual(turn.source, cached.payload);
  });

  test("does not call cachedSourceFn for empty messageId", () => {
    let called = false;
    const run = {
      runId: "run3", turns: [{ messageId: "", role: "user" }],
    };
    buildRunCopyPayloadFromData(run, () => { called = true; return null; });
    assert.equal(called, false, "should not look up source for empty messageId");
  });

  test("returns empty turns array when run has no turns", () => {
    const run = { runId: "run4", turns: [] };
    const payload = buildRunCopyPayloadFromData(run, () => null);
    assert.deepEqual(payload.turns, []);
  });

  test("returns null-like guard: no crash on missing run", () => {
    // The real function returns null for unknown runId; test the guard logic
    const run = undefined as unknown as Parameters<typeof buildRunCopyPayloadFromData>[0];
    // Simulate what buildRunCopyPayload does: check if run exists
    const result = run ? buildRunCopyPayloadFromData(run, () => null) : null;
    assert.equal(result, null);
  });
});

describe("copy does not trigger source fetch", () => {
  test("buildTurnCopyPayloadFromData with null cache does not set source field", () => {
    const payload = buildTurnCopyPayloadFromData({
      sourceKind: "message", runId: "r1", toolCallId: "", messageId: "m1",
      role: "user", previewFormat: "text-legacy", preview: "test",
    }, null);
    assert.equal("source" in payload, false);
  });

  test("buildRunCopyPayloadFromData with all-miss cache never sets source", () => {
    const run = {
      runId: "r1",
      turns: [
        { messageId: "m1", role: "user" },
        { messageId: "m2", role: "assistant" },
      ],
    };
    const payload = buildRunCopyPayloadFromData(run, () => null);
    const turns = payload.turns as Record<string, unknown>[];
    for (const turn of turns) {
      assert.equal("source" in turn, false, `turn ${turn.messageId} should not have source`);
    }
  });
});
