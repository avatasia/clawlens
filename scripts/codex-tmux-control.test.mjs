import test from "node:test";
import assert from "node:assert/strict";

import { countSubstantiveLines, hasNewNonInputContent, isBusy, isPromptReady, paneDiagnostics, parseFooterState, parseRestartState, parseStopState, findPickerItemNumber } from "./codex-tmux-control.mjs";

test("parseFooterState reads Codex model and effort footer", () => {
  const text = `
gpt-5.4 high · ~/github/clawlens · gpt-5.4 · clawlens · main · Context 0% used
`;

  assert.deepEqual(parseFooterState(text), {
    model: "gpt-5.4",
    effort: "high",
  });
});

test("isPromptReady requires a visible Codex footer and prompt", () => {
  assert.equal(
    isPromptReady("gpt-5.4 high · ~/github/clawlens · gpt-5.4 · clawlens · main · Context 0% used\n› "),
    true,
  );
  assert.equal(
    isPromptReady("gpt-5.4 high · ~/github/clawlens · gpt-5.4 · clawlens · main · Context 0% used"),
    false,
  );
  assert.equal(
    isPromptReady("Select Model and Effort\n  1. gpt-5.4\n"),
    false,
  );
});

test("isBusy is false if prompt is seen even if it is followed by a hint or tip", () => {
  assert.equal(isBusy("› Use /skills to list available skills"), false);
});

test("findPickerItemNumber distinguishes between gpt-5.4 and gpt-5.4-mini", () => {
  const text = `
Select Model and Effort
  1. gpt-5.4
  2. gpt-5.4-mini
`;
  assert.equal(findPickerItemNumber(text, "gpt-5.4"), 1);
  assert.equal(findPickerItemNumber(text, "gpt-5.4-mini"), 2);
});

test("paneDiagnostics ignores trailing whitespace and ANSI noise", () => {
  const clean = paneDiagnostics("hello\nworld");
  const noisy = paneDiagnostics("hello\x1b[0m\nworld   \n");

  assert.equal(clean.paneLineCount, 2);
  assert.equal(noisy.paneLineCount, 2);
  assert.equal(clean.capturedChars, 11);
  assert.equal(noisy.capturedChars, 11);
  assert.equal(clean.paneHash, noisy.paneHash);
});

test("parseRestartState reads a Codex startup banner", () => {
  const text = `
OpenAI Codex CLI v1.0.0
Welcome to Codex
`;

  assert.deepEqual(parseRestartState(text), {
    restartSeen: true,
    restartLineIndex: 1,
    raw: "OpenAI Codex CLI v1.0.0",
  });
});

test("parseRestartState ignores banner-like text inside normal output", () => {
  const text = `
This paragraph mentions OpenAI Codex CLI v1.0.0 in docs.
It is not a session restart marker.
`;

  assert.equal(parseRestartState(text).restartSeen, false);
});

test("parseStopState reads the stop hook marker and timestamp", () => {
  const text = `
Some output
Stop says: [done 12:14:47]
`;

  assert.deepEqual(parseStopState(text), {
    stopSeen: true,
    stopAt: "12:14:47",
    stopLineIndex: 2,
    raw: "Stop says: [done 12:14:47]",
  });
});

test("parseStopState ignores stop markers embedded in normal content", () => {
  const text = `
This is a quoted example:
Stop says: [done 12:14:47]
The explanation continues below.
`;

  assert.equal(parseStopState(text).stopSeen, false);
});

test("isBusy yields false when a stop hook marker is present", () => {
  const text = `
• Working
Stop says: [done 12:14:47]
`;

  assert.equal(isBusy(text), false);
});

test("isBusy still detects working text when no stop hook marker is present", () => {
  assert.equal(isBusy("• Working"), true);
  assert.equal(isBusy("tab to queue message"), true);
  assert.equal(isBusy("idle footer only"), true);
  assert.equal(
    isBusy(`
gpt-5.4 high · ~/github/clawlens · gpt-5.4 · clawlens · main · Context 0% used
› 
`),
    false,
  );
});

test("isBusy ignores stale stop markers if later working text appears", () => {
  const text = `
Stop says: [done 12:14:47]
• Working
`;

  assert.equal(isBusy(text), true);
});

test("isBusy detects background terminal activity near the footer", () => {
  const text = `
gpt-5.4 mini · ~/github/clawlens · gpt-5.4 · clawlens · main · Context 30% used
• Working (1m 10s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close
`;

  assert.equal(isBusy(text), true);
});

test("countSubstantiveLines ignores input prompt, footer, and box borders", () => {
  const text = [
    "╭────────────────╮",
    "│ › some input",
    "╰────────────────╯",
    "gpt-5.4 high · ~/x · gpt-5.4 · clawlens · main · Context 0% used",
    "• Real reply line one",
    "• Real reply line two",
    "",
  ].join("\n");
  assert.equal(countSubstantiveLines(text), 2);
});

test("hasNewNonInputContent detects real pane growth", () => {
  const baseline = [
    "› earlier prompt",
    "gpt-5.4 high · ~/x · gpt-5.4 · clawlens · main · Context 0% used",
    "• Earlier reply",
  ].join("\n");
  const current = [
    "› earlier prompt",
    "gpt-5.4 high · ~/x · gpt-5.4 · clawlens · main · Context 0% used",
    "• Earlier reply",
    "• New reply",
  ].join("\n");
  assert.equal(hasNewNonInputContent(baseline, current), true);
});

test("hasNewNonInputContent ignores pure input-block and footer growth", () => {
  const baseline = [
    "• existing reply",
    "gpt-5.4 high · ~/x · gpt-5.4 · clawlens · main · Context 0% used",
  ].join("\n");
  const current = [
    "• existing reply",
    "╭────────────────╮",
    "│ › typed input",
    "╰────────────────╯",
    "gpt-5.4 high · ~/x · gpt-5.4 · clawlens · main · Context 0% used",
  ].join("\n");
  assert.equal(hasNewNonInputContent(baseline, current), false);
});
