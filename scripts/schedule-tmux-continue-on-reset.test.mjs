import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzePane,
  computeTargetEpoch,
  extractResetSpec,
} from "./schedule-tmux-continue-on-reset.mjs";

test("extractResetSpec parses absolute reset time with timezone", () => {
  const text = `
Usage ⚠ Limit reached (resets 12pm (Asia/Shanghai))
`;

  assert.deepEqual(extractResetSpec(text), {
    kind: "absolute",
    resetText: "12pm",
    timezone: "Asia/Shanghai",
    sourceLine: "Usage ⚠ Limit reached (resets 12pm (Asia/Shanghai))",
  });
});

test("extractResetSpec parses relative reset time", () => {
  const text = `
Usage ⚠ Limit reached (resets 2h 29m)
`;

  assert.deepEqual(extractResetSpec(text), {
    kind: "relative",
    hours: 2,
    minutes: 29,
    seconds: 0,
    sourceLine: "Usage ⚠ Limit reached (resets 2h 29m)",
  });
});

test("extractResetSpec prefers absolute reset time over stale relative text", () => {
  const text = `
You've hit your limit · resets 12pm (Asia/Shanghai)
Usage ⚠ Limit reached (resets 2h 29m)
`;

  assert.deepEqual(extractResetSpec(text), {
    kind: "absolute",
    resetText: "12pm",
    timezone: "Asia/Shanghai",
    sourceLine: "You've hit your limit · resets 12pm (Asia/Shanghai)",
  });
});

test("analyzePane reports waiting state", () => {
  const text = `
You've hit your limit · resets 12pm (Asia/Shanghai)
❯
`;

  const result = analyzePane(text);
  assert.equal(result.waitingForReset, true);
  assert.equal(result.spec?.kind, "absolute");
  assert.equal(result.spec?.resetText, "12pm");
});

test("computeTargetEpoch applies offset to relative reset windows", () => {
  const nowEpoch = 1_000;
  const targetEpoch = computeTargetEpoch(
    {
      kind: "relative",
      hours: 2,
      minutes: 29,
      seconds: 0,
      sourceLine: "Usage ⚠ Limit reached (resets 2h 29m)",
    },
    nowEpoch,
    1,
  );

  assert.equal(targetEpoch, 1_000 + 2 * 3600 + 29 * 60 + 60);
});
