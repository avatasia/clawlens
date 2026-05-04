import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzePane,
  computeTargetEpoch,
  extractResetSpec,
  hasStackedInputForContinue,
  isBusyForContinue,
  isPromptReadyForContinue,
  parseClaudeUsage,
  parseCodexStatus,
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

test("analyzePane reports waiting state for Claude Code limit message", () => {
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

test("analyzePane does NOT flag 0% left without limit message (status bar only)", () => {
  // Codex showing 0% in status bar but no interruption message in pane
  const text = `
• Stop hook (completed)
  warning: Stop says: [done 20:43:35]

› Find and fix a bug in @filename
  gpt-5.4 medium · 5h 0% · weekly 31%
`;
  const result = analyzePane(text);
  assert.equal(result.waitingForReset, false);
});

test("analyzePane reports waiting for Usage ⚠ signal", () => {
  const text = `
Usage ⚠ Limit reached (resets 2h 29m)
❯
`;
  const result = analyzePane(text);
  assert.equal(result.waitingForReset, true);
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

test("extractResetSpec handles Codex wrapped exhaustion message", () => {
  const text = [
    "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), v",
    "isit https://chatgpt.com/codex/settings/usage to purchase more credits or try again",
    "at 5:20 PM.",
  ].join("\n");

  assert.deepEqual(extractResetSpec(text), [
    {
      kind: "absolute",
      resetText: "5:20 PM",
      timezone: null,
      sourceLine: "You've hit your usage limit",
    },
  ]);
});

test("analyzePane detects Codex quota exhaustion mid-task", () => {
  const text = [
    "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), v",
    "isit https://chatgpt.com/codex/settings/usage to purchase more credits or try again",
    "at 5:20 PM.",
    "›",
  ].join("\n");

  const result = analyzePane(text);
  assert.equal(result.waitingForReset, true);
  assert.equal(result.spec?.[0]?.kind, "absolute");
  assert.equal(result.spec?.[0]?.resetText, "5:20 PM");
});

test("isPromptReadyForContinue accepts Codex › prompt", () => {
  assert.equal(isPromptReadyForContinue("›"), true);
  assert.equal(isPromptReadyForContinue("  ›  "), true);
});

test("hasStackedInputForContinue detects stacked commands in input box", () => {
  const stackedPane = "› continue\n  /usage\n  /stats\n  q";
  assert.equal(hasStackedInputForContinue(stackedPane), true);

  assert.equal(hasStackedInputForContinue("›"), false);
  assert.equal(hasStackedInputForContinue("  ›  "), false);
  assert.equal(hasStackedInputForContinue(">"), false);

  assert.equal(isPromptReadyForContinue(stackedPane), false);
});

// --- parseClaudeUsage ---

test("parseClaudeUsage parses /usage output with percentage", () => {
  const text = `
   Status   Config   Usage   Stats

  Session
  Total cost:            $0.0000

  Current session
  █████████████████████████████████████              74% used
  Resets 1:20am (Asia/Shanghai)

  Current week (all models)
  ██████████████████████████                         52% used
  Resets May 5, 11pm (Asia/Shanghai)
`;

  const result = parseClaudeUsage(text);
  assert.ok(result);
  assert.equal(result.percentLeft, 26);
  assert.equal(result.spec.kind, "absolute");
  assert.equal(result.spec.resetText, "1:20am");
  assert.equal(result.spec.timezone, "Asia/Shanghai");
});

test("parseClaudeUsage returns percentLeft=0 when Limit reached text appears", () => {
  const text = `
  Current session
  ████████████████████████████████████████████████  Limit reached
  Resets 12pm (Asia/Shanghai)
`;

  const result = parseClaudeUsage(text);
  assert.ok(result);
  assert.equal(result.percentLeft, 0);
  assert.equal(result.spec.resetText, "12pm");
  assert.equal(result.spec.timezone, "Asia/Shanghai");
});

test("parseClaudeUsage returns null when Current session block absent", () => {
  assert.equal(parseClaudeUsage("some random text"), null);
});

// --- parseCodexStatus ---

test("parseCodexStatus parses /status output at 0% left", () => {
  const text = `
  5h limit:             [░░░░░░░░░░░░░░░░░░░░] 0% left (resets 22:28)
  Weekly limit:         [██████░░░░░░░░░░░░░░] 31% left (resets 13:40 on 5 May)
`;

  const result = parseCodexStatus(text);
  assert.ok(result);
  assert.equal(result.percentLeft, 0);
  assert.equal(result.spec.kind, "absolute");
  assert.equal(result.spec.resetText, "22:28");
  assert.equal(result.spec.timezone, null);
});

test("parseCodexStatus parses /status output with remaining quota", () => {
  const text = `
  5h limit:             [████████████░░░░░░░░] 40% left (resets 22:28)
`;

  const result = parseCodexStatus(text);
  assert.ok(result);
  assert.equal(result.percentLeft, 40);
  assert.equal(result.spec.resetText, "22:28");
});

test("parseCodexStatus returns null when 5h limit line absent", () => {
  assert.equal(parseCodexStatus("Weekly limit: 50% left (resets 10:00)"), null);
});
