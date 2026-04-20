import test from "node:test";
import assert from "node:assert/strict";

import { assertDistinctBridgeSessions } from "./claude-codex-dialogue.mjs";

test("assertDistinctBridgeSessions rejects identical Claude and Codex sessions", () => {
  assert.doesNotThrow(() => assertDistinctBridgeSessions("cc1", "codex"));
  assert.throws(
    () => assertDistinctBridgeSessions("bridge", "bridge"),
    /must be different to avoid self-routing/,
  );
});
