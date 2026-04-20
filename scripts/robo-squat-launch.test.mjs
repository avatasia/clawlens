import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBootstrapPrompt,
  buildChallengeBroadcast,
  buildKickoffPrompt,
  buildTurnBroadcast,
  extractBootstrapAck,
  classifyRecipientResponse,
  exactBootstrapLines,
  makeRoster,
  parseTurn,
} from "./robo-squat-launch.mjs";

function sampleRoster() {
  return makeRoster({
    claudeSession: "cc1",
    codexSession: "codex",
    geminiSession: "gemini1",
  });
}

test("makeRoster assigns deterministic ranks", () => {
  const roster = sampleRoster();
  assert.deepEqual(
    roster.map((entry) => ({ name: entry.name, rank: entry.rank, role: entry.role })),
    [
      { name: "cc1", rank: 1, role: "claude" },
      { name: "codex", rank: 2, role: "codex" },
      { name: "gemini1", rank: 3, role: "gemini" },
    ],
  );
});

test("bootstrap prompt asks for exact two-line acknowledgement", () => {
  const roster = sampleRoster();
  const prompt = buildBootstrapPrompt(roster[0], roster, "cc1");
  for (const line of exactBootstrapLines("cc1")) {
    assert.match(prompt, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(prompt, /Roster:/);
  assert.match(prompt, /watcher order for tie-breaks/);
  assert.match(prompt, /wait for the launcher kickoff/);
  assert.match(prompt, /Do not start the game on your own/);
});

test("bootstrap prompt distinguishes starter and non-starter behavior", () => {
  const roster = sampleRoster();
  const starterPrompt = buildBootstrapPrompt(roster[0], roster, "cc1");
  const watcherPrompt = buildBootstrapPrompt(roster[1], roster, "cc1");
  assert.match(starterPrompt, /Starter behavior: after bootstrap, wait for the launcher kickoff/);
  assert.match(watcherPrompt, /Non-starter behavior: after bootstrap, stay idle until the launcher routes a turn or challenge to you/);
});

test("extractBootstrapAck finds the last exact two-line acknowledgement", () => {
  const ack = extractBootstrapAck(`
noise
● cc1 明白
  cc1 规则已读
more noise
`, "cc1");

  assert.deepEqual(ack, exactBootstrapLines("cc1"));
});

test("extractBootstrapAck tolerates common prompt and bullet prefixes", () => {
  const ack = extractBootstrapAck(`
╭────────────────────────╮
│ OpenAI Codex           │
╰────────────────────────╯
› cc1 明白
● cc1 规则已读
`, "cc1");

  assert.deepEqual(ack, exactBootstrapLines("cc1"));
});

test("extractBootstrapAck tolerates unicode bullet prefixes", () => {
  const ack = extractBootstrapAck(`
• cc1 明白
• cc1 规则已读
`, "cc1");

  assert.deepEqual(ack, exactBootstrapLines("cc1"));
});

test("kickoff and turn broadcasts keep the turn sentence and structured header", () => {
  const roster = sampleRoster();
  const kickoff = buildKickoffPrompt(1, roster[0], roster[1], roster.slice(1), "2026-04-20T00:00:00.000Z");
  assert.match(kickoff, /\[robo-squat kickoff round=1 speaker=cc1 target=codex audience=codex,gemini1 deadline=/);
  assert.match(kickoff, /cc1蹲cc1蹲，cc1蹲完codex蹲/);

  const turn = buildTurnBroadcast(
    1,
    { speaker: "cc1", target: "codex", text: "cc1蹲cc1蹲，cc1蹲完codex蹲" },
    roster.slice(1),
    "2026-04-20T00:00:00.000Z",
  );
  assert.match(turn, /\[robo-squat round=1 speaker=cc1 target=codex audience=codex,gemini1 deadline=/);
  assert.match(turn, /cc1蹲cc1蹲，cc1蹲完codex蹲/);
});

test("parseTurn recognizes turn, challenge, and done responses", () => {
  const roster = sampleRoster();
  assert.deepEqual(
    parseTurn("cc1蹲cc1蹲，cc1蹲完codex蹲", roster),
    { kind: "turn", speaker: "cc1", target: "codex", text: "cc1蹲cc1蹲，cc1蹲完codex蹲" },
  );
  assert.deepEqual(
    parseTurn("质疑: missing response", roster),
    { kind: "challenge", text: "质疑: missing response" },
  );
  assert.deepEqual(
    parseTurn("结束: round limit reached", roster),
    { kind: "done", text: "结束: round limit reached" },
  );
});

test("classifyRecipientResponse flags out-of-turn turns", () => {
  const roster = sampleRoster();
  const response = classifyRecipientResponse(
    roster[1],
    "cc1蹲cc1蹲，cc1蹲完codex蹲",
    roster,
  );
  assert.equal(response.kind, "out_of_turn");
  assert.match(response.reason, /expected speaker codex but saw cc1/);
});

test("challenge broadcasts carry offender and audience fields", () => {
  const roster = sampleRoster();
  const challenge = buildChallengeBroadcast(
    1,
    roster[2],
    roster[1],
    roster.filter((entry) => entry.name !== "gemini1"),
    "missing response",
    "2026-04-20T00:00:00.000Z",
  );
  assert.match(challenge, /\[robo-squat challenge round=1 reporter=gemini1 offender=codex audience=cc1,codex deadline=/);
  assert.match(challenge, /质疑: round=1 reporter=gemini1 offender=codex reason=missing response/);
});

test("challenge audience excludes only the reporter", () => {
  const roster = sampleRoster();
  const challenge = buildChallengeBroadcast(
    1,
    roster[0],
    roster[1],
    roster.filter((entry) => entry.name !== "cc1"),
    "missing response",
    "2026-04-20T00:00:00.000Z",
  );
  assert.match(challenge, /audience=codex,gemini1/);
});
