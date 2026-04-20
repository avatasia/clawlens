import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeEffortCommandProgress,
  analyzeModelCommandProgress,
  buildPaneSnapshot,
  parseFooterState,
  isClaudeBusy,
  isClaudeIdle,
} from "./claude-tmux-control.mjs";

test("parseFooterState reads model and effort from a Sonnet footer", () => {
  const text = `
────────────────────────────────────────────────────────
  [Sonnet 4.6] │ clawlens git:(main*)
  ⏵⏵ bypass permissions on (shift+tab to cycle)                                                                                           ◐ medium · /effort
`;

  assert.deepEqual(parseFooterState(text), {
    model: "Sonnet 4.6",
    effort: "medium",
    effortVisible: true,
  });
});

test("parseFooterState handles Haiku footer without visible effort", () => {
  const text = `
────────────────────────────────────────────────────────
  [Haiku 4.5] │ clawlens git:(main*)
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

  assert.deepEqual(parseFooterState(text), {
    model: "Haiku 4.5",
    effort: null,
    effortVisible: false,
  });
});

test("analyzeModelCommandProgress accepts ack plus footer verification", () => {
  const baselineText = `
❯ /model sonnet
  ⎿  Set model to Sonnet 4.6
  [Sonnet 4.6] │ clawlens git:(main*)
`;
  const currentText = `
❯ /model sonnet
  ⎿  Set model to Sonnet 4.6
❯ /model opus
  ⎿  Set model to Opus 4.7
  [Opus 4.7] │ clawlens git:(main*)
`;

  const baseline = buildPaneSnapshot(baselineText, "/model opus");
  const current = buildPaneSnapshot(currentText, "/model opus");

  assert.deepEqual(analyzeModelCommandProgress(current, baseline, "opus"), {
    done: true,
    ok: true,
    verification: ["ack", "footer"],
  });
});

test("analyzeModelCommandProgress reports model validation failure", () => {
  const baseline = buildPaneSnapshot("", "/model bad-model");
  const current = buildPaneSnapshot(`
❯ /model bad-model
Failed to validate model: bad-model
`, "/model bad-model");

  assert.deepEqual(analyzeModelCommandProgress(current, baseline, "bad-model"), {
    done: true,
    ok: false,
    reason: "Failed to validate model: bad-model",
  });
});

test("analyzeEffortCommandProgress requires only ack on Haiku", () => {
  const baselineText = `
  [Haiku 4.5] │ clawlens git:(main*)
`;
  const currentText = `
❯ /effort medium
  ⎿  Set effort level to medium: Balanced approach with standard implementation and testing
  [Haiku 4.5] │ clawlens git:(main*)
`;

  const baseline = buildPaneSnapshot(baselineText, "/effort medium");
  const current = buildPaneSnapshot(currentText, "/effort medium");

  assert.deepEqual(analyzeEffortCommandProgress(current, baseline, "medium", "Haiku 4.5"), {
    done: true,
    ok: true,
    verification: ["ack"],
  });
});

test("analyzeEffortCommandProgress accepts footer-only verification on Sonnet", () => {
  const baselineText = `
  [Sonnet 4.6] │ clawlens git:(main*)
  ⏵⏵ bypass permissions on (shift+tab to cycle)                                                                                           ○ low · /effort
`;
  const currentText = `
❯ /effort medium
  [Sonnet 4.6] │ clawlens git:(main*)
  ⏵⏵ bypass permissions on (shift+tab to cycle)                                                                                           ◐ medium · /effort
`;

  const baseline = buildPaneSnapshot(baselineText, "/effort medium");
  const current = buildPaneSnapshot(currentText, "/effort medium");

  assert.deepEqual(analyzeEffortCommandProgress(current, baseline, "medium", "Sonnet 4.6"), {
    done: true,
    ok: true,
    verification: ["footer"],
  });
});

test("analyzeEffortCommandProgress reports invalid effort", () => {
  const baseline = buildPaneSnapshot("", "/effort ultra");
  const current = buildPaneSnapshot(`
❯ /effort ultra
assistant has invalid effort 'ultra'
`, "/effort ultra");

  assert.deepEqual(analyzeEffortCommandProgress(current, baseline, "ultra", "Opus 4.7"), {
    done: true,
    ok: false,
    reason: "has invalid effort 'ultra'",
  });
});

test("isClaudeBusy ignores stale spinner noise outside the tail window", () => {
  const text = `
old output
⠋ working on something long ago
${"x\n".repeat(60)}❯ 
`;

  assert.equal(isClaudeBusy(text), false);
  assert.equal(isClaudeIdle(text), true);
});
