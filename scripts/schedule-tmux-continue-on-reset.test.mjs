import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzePane,
  computeTargetEpoch,
  extractResetSpec,
  isBusyForContinue,
  isPromptReadyForContinue,
  selectResetCandidate,
} from "./schedule-tmux-continue-on-reset.mjs";

test("extractResetSpec parses absolute reset time with timezone", () => {
  const text = `
Usage ⚠ Limit reached (resets 12pm (Asia/Shanghai))
`;

  assert.deepEqual(extractResetSpec(text), [
    {
      kind: "absolute",
      resetText: "12pm",
      timezone: "Asia/Shanghai",
      sourceLine: "Usage ⚠ Limit reached (resets 12pm (Asia/Shanghai))",
    },
  ]);
});

test("extractResetSpec parses absolute reset time with at syntax", () => {
  const text = `
Usage ⚠ Limit reached (resets at 12:00pm (Asia/Shanghai))
`;

  assert.deepEqual(extractResetSpec(text), [
    {
      kind: "absolute",
      resetText: "12:00pm",
      timezone: "Asia/Shanghai",
      sourceLine: "Usage ⚠ Limit reached (resets at 12:00pm (Asia/Shanghai))",
    },
  ]);
});

test("extractResetSpec parses relative reset time", () => {
  const text = `
Usage ⚠ Limit reached (resets 2h 29m)
`;

  assert.deepEqual(extractResetSpec(text), [
    {
      kind: "relative",
      hours: 2,
      minutes: 29,
      seconds: 0,
      sourceLine: "Usage ⚠ Limit reached (resets 2h 29m)",
    },
  ]);
});

test("extractResetSpec parses relative reset time with colon syntax", () => {
  const text = `
Usage ⚠ Limit reached (resets: 3h 5m)
`;

  assert.deepEqual(extractResetSpec(text), [
    {
      kind: "relative",
      hours: 3,
      minutes: 5,
      seconds: 0,
      sourceLine: "Usage ⚠ Limit reached (resets: 3h 5m)",
    },
  ]);
});

test("extractResetSpec prefers absolute reset time over stale relative text", () => {
  const text = `
You've hit your limit · resets 12pm (Asia/Shanghai)
Usage ⚠ Limit reached (resets 2h 29m)
`;

  assert.deepEqual(extractResetSpec(text), [
    {
      kind: "absolute",
      resetText: "12pm",
      timezone: "Asia/Shanghai",
      sourceLine: "You've hit your limit · resets 12pm (Asia/Shanghai)",
    },
    {
      kind: "relative",
      hours: 2,
      minutes: 29,
      seconds: 0,
      sourceLine: "Usage ⚠ Limit reached (resets 2h 29m)",
    },
  ]);
});

test("analyzePane reports waiting state", () => {
  const text = `
You've hit your limit · resets 12pm (Asia/Shanghai)
❯
`;

  const result = analyzePane(text);
  assert.equal(result.waitingForReset, true);
  assert.equal(Array.isArray(result.spec), true);
  assert.equal(result.spec?.[0]?.kind, "absolute");
  assert.equal(result.spec?.[0]?.resetText, "12pm");
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

test("selectResetCandidate prefers absolute reset specs over stale relative text", () => {
  const selected = selectResetCandidate(
    [
      {
        kind: "absolute",
        resetText: "12pm",
        timezone: "Asia/Shanghai",
        sourceLine: "You've hit your limit · resets 12pm (Asia/Shanghai)",
      },
      {
        kind: "relative",
        hours: 2,
        minutes: 29,
        seconds: 0,
        sourceLine: "Usage ⚠ Limit reached (resets 2h 29m)",
      },
    ],
    1_000,
    1,
  );

  assert.equal(selected?.spec.kind, "absolute");
});

test("isBusyForContinue flags active Codex panes", () => {
  assert.equal(isBusyForContinue("• Working on response"), true);
  assert.equal(isBusyForContinue("tab to queue message"), true);
  assert.equal(isBusyForContinue("Thinking..."), true);
  assert.equal(isBusyForContinue("ready prompt"), false);
});

test("isPromptReadyForContinue accepts prompt-ready Codex panes", () => {
  assert.equal(isPromptReadyForContinue(" >   Type your message or @path/to/file"), true);
  assert.equal(isPromptReadyForContinue(" >"), true);
  assert.equal(isPromptReadyForContinue("working"), false);
});
