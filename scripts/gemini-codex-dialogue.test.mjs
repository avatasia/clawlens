import test from "node:test";
import assert from "node:assert/strict";

import {
  assertForwardingSafe,
  advanceCheckpointState,
  buildDecisionEscalationPrompt,
  computeTurnHealth,
  createCheckpointState,
  defaultCheckpointFile,
  buildDecisionModeWorkerSource,
  assertDistinctBridgeSessions,
  extractCodexResponse,
  extractCodexResponseMeta,
  formatProgressStatus,
  markDecisionModeApplied,
  markDecisionModePaused,
  isRetryableSendError,
  prepareForwardingText,
  parseDecisionEscalationReply,
  resolveDecisionEscalationTarget,
  summarizeDialogueHealth,
  shouldEscalateDecisionModel,
} from "./gemini-codex-dialogue.mjs";

test("extractCodexResponse handles wrapped Codex input blocks", () => {
  const baseline = `
› Earlier prompt

• Earlier response
`;
  const final = `
› Earlier prompt

• Earlier response

› Please keep this short and mention
  one concrete next step for the bridge.

• Use a dedicated dialogue session for bridge traffic.
• It avoids operator-task contamination.

gpt-5.4 high · ~/github/clawlens · gpt-5.4 · clawlens · main · Context 0% used
`;

  assert.equal(
    extractCodexResponse(
      baseline,
      final,
      "Please keep this short and mention one concrete next step for the bridge.",
    ),
    "• Use a dedicated dialogue session for bridge traffic.\n• It avoids operator-task contamination.",
  );
});

test("extractCodexResponse falls back to baseline fingerprint when input block is missing", () => {
  const baseline = `
• Status line
• Earlier response
`;
  const final = `
• Status line
• Earlier response

• New response line one
• New response line two

gpt-5.4 high · ~/github/clawlens · gpt-5.4 · clawlens · main · Context 0% used
`;

  assert.equal(
    extractCodexResponse(baseline, final, "Unmatched prompt"),
    "• New response line one\n• New response line two",
  );
});

test("extractCodexResponseMeta reports fallback method", () => {
  const baseline = `
• Status line
• Earlier response
`;
  const final = `
• Status line
• Earlier response

• New response line one

gpt-5.4 high · ~/github/clawlens · gpt-5.4 · clawlens · main · Context 0% used
`;

  assert.deepEqual(
    extractCodexResponseMeta(baseline, final, "Unmatched prompt"),
    { method: "baseline_fingerprint", text: "• New response line one" },
  );
});

test("prepareForwardingText prefers natural cut points", () => {
  const text = [
    "Line one is short.",
    "",
    "Line two is also short.",
    "",
    "Line three keeps going so the helper should cut before the final sentence if needed.",
  ].join("\n");

  assert.equal(
    prepareForwardingText(text, 60),
    "Line one is short.\n\nLine two is also short.\n\n[... truncated at 60 chars]",
  );
});

test("isRetryableSendError matches transient send failures", () => {
  assert.equal(isRetryableSendError("Timed out waiting for Codex to finish responding"), true);
  assert.equal(isRetryableSendError("send failed (gemini-tmux-control.mjs): timeout"), true);
  assert.equal(isRetryableSendError("Unknown argument: --bad"), false);
});

test("defaultCheckpointFile uses the temp checkpoint directory", () => {
  assert.match(defaultCheckpointFile(), /clawlens-dialogue-checkpoints\/gemini-codex-/);
});

test("assertDistinctBridgeSessions rejects identical Gemini and Codex sessions", () => {
  assert.doesNotThrow(() => assertDistinctBridgeSessions("gemini1", "codex"));
  assert.throws(
    () => assertDistinctBridgeSessions("gemini1", "gemini1"),
    /must be different to avoid self-routing/,
  );
});

test("checkpoint state advances with each completed turn", () => {
  const initial = createCheckpointState("Hello bridge", {
    turns: 3,
    firstSpeaker: "gemini",
    geminiSession: "gemini1",
    codexSession: "codex",
  }, "/tmp/bridge.json");

  const advanced = advanceCheckpointState(initial, {
    turn: 1,
    speaker: "gemini",
    session: "gemini1",
    sent: "Hello bridge",
    responseMeta: { method: "input_block", text: "✦ Hi" },
    forwarded: "✦ Hi",
    timestamp: "2026-04-20T03:00:00.000Z",
  }, "codex", "✦ Hi");

  assert.equal(advanced.nextTurn, 2);
  assert.equal(advanced.currentRole, "codex");
  assert.equal(advanced.currentMessage, "✦ Hi");
  assert.equal(advanced.history.length, 1);
  assert.equal(advanced.history[0].speaker, "gemini");
});

test("formatProgressStatus includes role, attempt, and elapsed time", () => {
  assert.equal(
    formatProgressStatus("gemini", 2, 3, 2400),
    "··  GEMINI attempt 2/3 waiting 2.4s",
  );
});

test("computeTurnHealth grades extraction outcomes", () => {
  assert.equal(computeTurnHealth({ method: "input_block", text: "hello" }, "hello"), "THREAD_STABLE");
  assert.equal(computeTurnHealth({ method: "baseline_fingerprint", text: "hello" }, "hello"), "THREAD_STRETCHED");
  assert.equal(computeTurnHealth({ method: "tail_fallback", text: "hello" }, "hello"), "THREAD_FRAYED");
  assert.equal(computeTurnHealth({ method: "input_block", text: "hello world" }, "hello"), "THREAD_FRAYED");
});

test("assertForwardingSafe rejects tail fallback extraction", () => {
  assert.throws(
    () => assertForwardingSafe({ method: "tail_fallback", text: "uncertain" }),
    /THREAD_FRAYED/,
  );
  assert.doesNotThrow(() => assertForwardingSafe({ method: "input_block", text: "safe" }));
});

test("summarizeDialogueHealth counts turn health states", () => {
  assert.deepEqual(
    summarizeDialogueHealth([
      { health: "THREAD_STABLE" },
      { health: "THREAD_STRETCHED" },
      { health: "THREAD_STABLE" },
      { health: "THREAD_FRAYED" },
    ]),
    {
      THREAD_STABLE: 2,
      THREAD_STRETCHED: 1,
      THREAD_FRAYED: 1,
    },
  );
});

test("decision escalation helpers prefer the stronger Codex combo", () => {
  const prompt = buildDecisionEscalationPrompt(
    { model: "gpt-5.4-mini", effort: "medium" },
    "gpt-5.4",
    "high",
  );

  assert.match(prompt, /Current Codex combo: gpt-5\.4-mini medium/);
  assert.match(prompt, /Proposed target combo: gpt-5\.4 high/);
  assert.match(prompt, /Codex busy: no/);
  assert.match(prompt, /Confirm intent or reply WAIT if Codex is busy\./);
  assert.equal(shouldEscalateDecisionModel({ model: "gpt-5.4-mini", effort: "medium" }, "gpt-5.4", "high"), true);
  assert.equal(shouldEscalateDecisionModel({ model: "gpt-5.4", effort: "high" }, "gpt-5.4", "high"), false);
});

test("parseDecisionEscalationReply reads Gemini approval and adjustments", () => {
  assert.deepEqual(parseDecisionEscalationReply("OK"), { action: "ok", raw: "OK" });
  assert.deepEqual(parseDecisionEscalationReply("可接受。"), { action: "ok", raw: "可接受。" });
  assert.deepEqual(parseDecisionEscalationReply("WAIT"), { action: "wait", raw: "WAIT" });
  assert.deepEqual(parseDecisionEscalationReply("CONTINUE"), { action: "continue", raw: "CONTINUE" });
  assert.deepEqual(parseDecisionEscalationReply("ADJUST model=gpt-5.4 effort=high"), {
    action: "adjust",
    model: "gpt-5.4",
    effort: "high",
    raw: "ADJUST model=gpt-5.4 effort=high",
  });
  assert.deepEqual(parseDecisionEscalationReply("Maybe later"), {
    action: "unknown",
    raw: "Maybe later",
  });
});

test("resolveDecisionEscalationTarget keeps OK/unknown on the default combo and blocks WAIT", () => {
  const defaultTarget = { model: "gpt-5.4", effort: "high" };

  assert.deepEqual(resolveDecisionEscalationTarget({ action: "ok" }, defaultTarget), defaultTarget);
  assert.deepEqual(resolveDecisionEscalationTarget({ action: "unknown" }, defaultTarget), defaultTarget);
  assert.deepEqual(resolveDecisionEscalationTarget({
    action: "adjust",
    model: "gpt-5.2-codex",
    effort: "medium",
  }, defaultTarget), {
    model: "gpt-5.2-codex",
    effort: "medium",
  });
  assert.deepEqual(resolveDecisionEscalationTarget({ action: "continue" }, defaultTarget), defaultTarget);
  assert.equal(resolveDecisionEscalationTarget({ action: "wait" }, defaultTarget), null);
});

test("markDecisionModePaused stores the pending pause state for CONTINUE", () => {
  const state = createCheckpointState("topic", {
    turns: 2,
    firstSpeaker: "gemini",
    geminiSession: "gemini1",
    codexSession: "codex",
  }, "/tmp/topic.json");

  const updated = markDecisionModePaused(state, {
    requested: { model: "gpt-5.4", effort: "high" },
    confirmed: { model: "gpt-5.4", effort: "high" },
    current: { model: "gpt-5.4-mini", effort: "medium" },
    geminiReply: "WAIT",
    geminiAction: "wait",
    preflightAttempts: 1,
    waitedForIdle: false,
    resumeSignal: "CONTINUE",
  });

  assert.equal(updated.status, "paused");
  assert.equal(updated.decisionMode.applied, false);
  assert.equal(updated.decisionMode.pending, true);
  assert.equal(updated.decisionMode.resumeSignal, "CONTINUE");
});

test("buildDecisionModeWorkerSource embeds the upgrade and resume commands", () => {
  const source = buildDecisionModeWorkerSource({
    nodePath: "/usr/local/bin/node",
    codexScript: "/repo/scripts/codex-tmux-control.mjs",
    geminiScript: "/repo/scripts/gemini-tmux-control.mjs",
    codexSession: "codex",
    geminiSession: "gemini1",
    checkpointFile: "/tmp/checkpoint.json",
    logPath: "/tmp/worker.log",
    runnerPath: "/tmp/worker.mjs",
    model: "gpt-5.4",
    effort: "high",
    resumeMessage: "Decision mode confirmed: Codex upgraded to gpt-5.4 high. Continue with the decision analysis.",
    timeoutMs: 180000,
    pollMs: 250,
    settleMs: 750,
  });

  assert.match(source, /set-combo/);
  assert.match(source, /gpt-5\.4/);
  assert.match(source, /Decision mode confirmed: Codex upgraded to gpt-5\.4 high/);
  assert.match(source, /checkpoint patched/);
  assert.match(source, /--timeout-ms/);
  assert.match(source, /180000/);
  assert.match(source, /--poll-ms/);
  assert.match(source, /--settle-ms/);
});

test("buildDecisionModeWorkerSource rejects identical Gemini and Codex sessions", () => {
  assert.throws(
    () => buildDecisionModeWorkerSource({
      nodePath: "/usr/local/bin/node",
      codexScript: "/repo/scripts/codex-tmux-control.mjs",
      geminiScript: "/repo/scripts/gemini-tmux-control.mjs",
      codexSession: "bridge",
      geminiSession: "bridge",
      checkpointFile: "/tmp/checkpoint.json",
      logPath: "/tmp/worker.log",
      runnerPath: "/tmp/worker.mjs",
      model: "gpt-5.4",
      effort: "high",
      resumeMessage: "Decision mode confirmed: Codex upgraded to gpt-5.4 high. Continue with the decision analysis.",
      timeoutMs: 180000,
      pollMs: 250,
      settleMs: 750,
    }),
    /must be different to avoid self-routing/,
  );
});

test("markDecisionModeApplied stores the escalation outcome in checkpoint state", () => {
  const state = createCheckpointState("topic", {
    turns: 2,
    firstSpeaker: "gemini",
    geminiSession: "gemini1",
    codexSession: "codex",
  }, "/tmp/topic.json");

  const updated = markDecisionModeApplied(state, {
    requested: { model: "gpt-5.4", effort: "high" },
    confirmed: { model: "gpt-5.4", effort: "high" },
    current: { model: "gpt-5.4-mini", effort: "medium" },
    geminiReply: "OK",
    geminiAction: "ok",
    preflightAttempts: 1,
    waitedForIdle: false,
    verified: true,
  });

  assert.equal(updated.decisionMode.applied, true);
  assert.deepEqual(updated.decisionMode.requested, { model: "gpt-5.4", effort: "high" });
  assert.deepEqual(updated.decisionMode.confirmed, { model: "gpt-5.4", effort: "high" });
  assert.deepEqual(updated.decisionMode.current, { model: "gpt-5.4-mini", effort: "medium" });
  assert.equal(updated.decisionMode.geminiReply, "OK");
  assert.equal(updated.decisionMode.geminiAction, "ok");
  assert.equal(updated.decisionMode.preflightAttempts, 1);
  assert.equal(updated.decisionMode.waitedForIdle, false);
  assert.equal(updated.decisionMode.verified, true);
});
