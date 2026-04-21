import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStatusSnapshot,
  extractResponse,
  extractResponseMeta,
  formatHumanMethodLabel,
  refineResponseMetaWithWiderCapture,
  paneDiagnostics,
  isBusy,
  isPromptReady,
  nextStableCount,
  parseFooterState,
  parseRestartState,
  parseStopState,
  stripAnsi,
} from "./gemini-tmux-control.mjs";

test("stripAnsi removes Gemini color codes", () => {
  const text = "\x1b[38;2;255;255;255mGemini CLI\x1b[39m";
  assert.equal(stripAnsi(text), "Gemini CLI");
});

test("isBusy detects the Thinking marker", () => {
  const text = `
⠸ Thinking... (esc to cancel, 1s)
`;
  assert.equal(isBusy(text), true);
});

test("isBusy detects other Gemini progress states", () => {
  const text = `
⠼ Defining the Task's Constraints (esc to cancel, 6s)
`;
  assert.equal(isBusy(text), true);
});

test("isPromptReady detects the idle input placeholder", () => {
  const text = `
 >   Type your message or @path/to/file
`;
  assert.equal(isPromptReady(text), true);
});

test("isPromptReady accepts an active Gemini input line", () => {
  const text = `
 > continue
`;
  assert.equal(isPromptReady(text), true);
});

test("nextStableCount increments only when pane text is unchanged", () => {
  assert.equal(nextStableCount(null, "A", 0), 1);
  assert.equal(nextStableCount("A", "A", 1), 2);
  assert.equal(nextStableCount("A", "B", 2), 1);
});

test("parseFooterState reads Gemini model footer", () => {
  const text = `
 workspace (/directory)                                                             branch                                                            sandbox                                                                         /model
 ~/github/clawlens                                                                  main                                                              no sandbox                                                             Auto (Gemini 3)
`;

  assert.deepEqual(parseFooterState(text), {
    model: "Auto (Gemini 3)",
  });
});

test("parseRestartState reads the Gemini startup banner", () => {
  const text = `
 ▝▜▄     Gemini CLI v0.38.2
   ▝▜▄
  ▗▟▀    Signed in with Google /auth
 ▝▀      Plan: Gemini Code Assist in Google One AI Pro /upgrade
`;

  assert.deepEqual(parseRestartState(text), {
    restartSeen: true,
    restartLineIndex: 1,
    raw: "▝▜▄     Gemini CLI v0.38.2",
  });
});

test("parseRestartState ignores banner-like text inside normal output", () => {
  const text = `
The docs mention Gemini CLI v0.38.2 in a changelog example.
This is not a restart marker.
`;

  assert.equal(parseRestartState(text).restartSeen, false);
});

test("parseStopState reads the stop hook marker and timestamp", () => {
  const text = `
some output
Stop says: [done 12:14:47]
`;

  assert.deepEqual(parseStopState(text), {
    stopSeen: true,
    stopAt: "12:14:47",
    stopLineIndex: 2,
    raw: "Stop says: [done 12:14:47]",
  });
});

test("parseStopState tolerates leading/trailing whitespace on the stop line", () => {
  const text = "  Stop says: [done 12:14:47]  \n";
  assert.equal(parseStopState(text).stopSeen, true);
  assert.equal(parseStopState(text).stopAt, "12:14:47");
});

test("parseStopState ignores stop markers embedded in normal content", () => {
  const text = `
Here is an example of the hook format:
Stop says: [done 12:14:47]
But the answer keeps going after that.
`;

  assert.equal(parseStopState(text).stopSeen, false);
});

test("isBusy yields false when a stop hook marker is present", () => {
  const text = `
⠸ Thinking... (esc to cancel, 1s)
Stop says: [done 12:14:47]
`;

  assert.equal(isBusy(text), false);
});

test("isBusy still uses Gemini spinner and shell heuristics when stop is absent", () => {
  assert.equal(isBusy("⠸ Thinking... (esc to cancel, 1s)"), true);
  assert.equal(isBusy("Shell awaiting input"), true);
});

test("isBusy stays true until Gemini prompt is visible", () => {
  assert.equal(isBusy("some output without prompt"), true);
  assert.equal(isBusy(" >   Type your message or @path/to/file"), false);
});

test("isBusy ignores stale stop markers if later busy output appears", () => {
  const text = `
Stop says: [done 12:14:47]
⠸ Thinking... (esc to cancel, 1s)
`;

  assert.equal(isBusy(text), true);
});

test("buildStatusSnapshot exposes stop state and keeps busy false when stop is present", () => {
  const text = `
 ▝▜▄     Gemini CLI v0.38.2
   ▝▜▄
  ▗▟▀    Signed in with Google /auth
 ▝▀      Plan: Gemini Code Assist in Google One AI Pro /upgrade
workspace (/directory)                                                             branch                                                            sandbox                                                                         /model
~/github/clawlens                                                                  main                                                              no sandbox                                                             Auto (Gemini 3)
⠸ Thinking... (esc to cancel, 1s)
Stop says: [done 12:14:47]
 >   Type your message or @path/to/file
`;

  assert.deepEqual(buildStatusSnapshot(text), {
    restart: {
      restartSeen: true,
      restartLineIndex: 1,
      raw: "▝▜▄     Gemini CLI v0.38.2",
    },
    footer: { model: "Auto (Gemini 3)" },
    busy: false,
    stop: {
      stopSeen: true,
      stopAt: "12:14:47",
      stopLineIndex: 8,
      raw: "Stop says: [done 12:14:47]",
    },
    promptReady: true,
    paneHash: paneDiagnostics(text).paneHash,
    capturedChars: paneDiagnostics(text).capturedChars,
    paneLineCount: paneDiagnostics(text).paneLineCount,
  });
});

test("extractResponse returns Gemini reply after the sent prompt", () => {
  const baseline = `
 > Previous message
✦ Earlier reply
`;
  const final = `
 > Previous message
✦ Earlier reply
▀▀▀▀▀▀▀▀▀▀
 > What soundtrack fits deep work best?
▄▄▄▄▄▄▄▄▄▄
✦ Ambient, low-variance music works best for long focus blocks.
  Something steady is better than lyrical.

? for shortcuts
────────────────────────
Shift+Tab to accept edits
▀▀▀▀▀▀▀▀▀▀
 >   Type your message or @path/to/file
▄▄▄▄▄▄▄▄▄▄
workspace (/directory)                                                             branch                                                            sandbox                                                                         /model
~/github/clawlens                                                                  main                                                              no sandbox                                                             Auto (Gemini 3)
`;

  assert.equal(
    extractResponse(baseline, final, "What soundtrack fits deep work best?"),
    "Ambient, low-variance music works best for long focus blocks.\n  Something steady is better than lyrical.",
  );
});

test("extractResponse handles wrapped Gemini input blocks", () => {
  const baseline = `
 > Earlier message
✦ Earlier reply
`;
  const final = `
 > Earlier message
✦ Earlier reply
▀▀▀▀▀▀▀▀▀▀
 > Please keep this answer short and practical while
   mentioning one concrete next step for the bridge.
▄▄▄▄▄▄▄▄▄▄
✦ Use a dedicated dialogue session.
  Then extraction and reset logic stop fighting operator context.

? for shortcuts
────────────────────────
Shift+Tab to accept edits
▀▀▀▀▀▀▀▀▀▀
 >   Type your message or @path/to/file
▄▄▄▄▄▄▄▄▄▄
workspace (/directory)                                                             branch                                                            sandbox                                                                         /model
~/github/clawlens                                                                  main                                                              no sandbox                                                             Auto (Gemini 3)
`;

  assert.equal(
    extractResponse(
      baseline,
      final,
      "Please keep this answer short and practical while mentioning one concrete next step for the bridge.",
    ),
    "Use a dedicated dialogue session.\n  Then extraction and reset logic stop fighting operator context.",
  );
});

test("extractResponseMeta reports extraction method", () => {
  const final = `
 > Wrapped prompt starts here and continues
   on the next line.
▄▄▄▄▄▄▄▄▄▄
✦ Reply body
`;

  assert.deepEqual(
    extractResponseMeta("", final, "Wrapped prompt starts here and continues on the next line."),
    { method: "input_block", text: "Reply body" },
  );
});

test("extractResponseMeta tolerates noisy leading prompt text", () => {
  const final = `
 > continue
   Focus on the logging signals that matter most for the bridge.
▄▄▄▄▄▄▄▄▄▄
✦ Keep the timestamp, the extraction method, and the exact pane target.
`;

  assert.deepEqual(
    extractResponseMeta("", final, "Focus on the logging signals that matter most for the bridge."),
    {
      method: "input_block",
      text: "Keep the timestamp, the extraction method, and the exact pane target.",
    },
  );
});

test("refineResponseMetaWithWiderCapture prefers the wider non-fallback capture", () => {
  const baseline = `
 > Earlier message
✦ Earlier reply
`;
  const narrow = `
 > continue
   noise only
`;
  const wide = `
 > continue
   Please keep the logging hints short and practical.
▄▄▄▄▄▄▄▄▄▄
✦ Keep the timestamp, the method tag, and the pane target.
`;

  assert.deepEqual(
    refineResponseMetaWithWiderCapture(baseline, narrow, wide, "Please keep the logging hints short and practical."),
    {
      method: "input_block",
      text: "Keep the timestamp, the method tag, and the pane target.",
    },
  );
});

test("paneDiagnostics ignores ANSI noise and reports stable counts", () => {
  const clean = paneDiagnostics("hello\nworld");
  const noisy = paneDiagnostics("\x1b[31mhello\x1b[0m\nworld\n");

  assert.equal(clean.paneLineCount, 2);
  assert.equal(noisy.paneLineCount, 2);
  assert.equal(clean.capturedChars, 11);
  assert.equal(noisy.capturedChars, 11);
  assert.equal(clean.paneHash, noisy.paneHash);
});

test("formatHumanMethodLabel maps extraction methods to short labels", () => {
  assert.equal(formatHumanMethodLabel("input_block"), "BLOCK");
  assert.equal(formatHumanMethodLabel("baseline_fingerprint"), "FINGERPRINT");
  assert.equal(formatHumanMethodLabel("tail_fallback"), "FRAYED");
});
