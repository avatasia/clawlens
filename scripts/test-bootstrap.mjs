#!/usr/bin/env node
/**
 * Quick bootstrap diagnostics for robo-squat-launch.
 * Tests: bootstrap extraction, response parsing, and turn parsing.
 */

import {
  extractBootstrapAck,
  extractBootstrapAckDiagnostic,
  exactBootstrapLines,
  parseTurn,
  makeRoster
} from "./robo-squat-launch.mjs";

const opts = {
  claudeSession: "cc1",
  codexSession: "codex",
  geminiSession: "gemini1",
  starterSession: "cc1",
};

const roster = makeRoster(opts);

console.log("Testing extractBootstrapAck and parseTurn...\n");

// Test case 1: Valid bootstrap response
const testName1 = "codex";
const validBootstrap = `
some noise output
Token usage: xyz
› codex 明白
› codex 规则已读
more footer lines
`;
const ack1 = extractBootstrapAck(validBootstrap, testName1);
console.log(`Test 1 (valid bootstrap):`);
console.log(`  Result: ${ack1 ? "✓ PASS" : "✗ FAIL"}`);
if (ack1) console.log(`  Lines: [${ack1.join("], [")}]`);
else {
  const diag = extractBootstrapAckDiagnostic(validBootstrap, testName1);
  console.log(`  Diagnostic: ${JSON.stringify(diag)}`);
}

// Test case 2: Bootstrap with messy output
const testName2 = "codex";
const messyBootstrap = `
╭───────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.121.0)                        │
│                                                   │
│ model:     gpt-5.4-mini medium   /model to change │
│ directory: ~/github/clawlens                      │
╰───────────────────────────────────────────────────╯
Tip: NEW: Prevent sleep while running is now available in /experimental.
Token usage: total=2,524 input=2,389 (+ 9,088 cached) output=135 (reasoning 71)
To continue this session, run codex resume 019dab45-3803-7601-8c67-c280d9a16087
› Roster:
- rank 1: cc1 (claude)
- rank 2: codex (codex)
- rank 3: gemini1 (gemini)
codex 明白
codex 规则已读
gpt-5.4-mini medium · ~/github/clawlens · gpt-5.4-mini · clawlens · 0%
`;
const ack2 = extractBootstrapAck(messyBootstrap, testName2);
console.log(`\nTest 2 (messy bootstrap):`);
console.log(`  Result: ${ack2 ? "✓ PASS" : "✗ FAIL"}`);
if (ack2) console.log(`  Lines: [${ack2.join("], [")}]`);
else {
  const diag = extractBootstrapAckDiagnostic(messyBootstrap, testName2);
  console.log(`  Diagnostic: ${JSON.stringify(diag)}`);
}

// Test case 3: Parse valid turn
const validTurn = "codex蹲codex蹲，codex蹲完cc1蹲\nsome extra text";
const parsed1 = parseTurn(validTurn, roster);
console.log(`\nTest 3 (valid turn):`);
console.log(`  Result: ${parsed1.kind === "turn" ? "✓ PASS" : "✗ FAIL"}`);
console.log(`  Kind: ${parsed1.kind}, Speaker: ${parsed1.speaker}, Target: ${parsed1.target}`);

// Test case 4: Parse turn with extra output
const messyTurn = `
some output from codex
codex蹲codex蹲，codex蹲完gemini1蹲
more footer info
• Working
`;
const parsed2 = parseTurn(messyTurn, roster);
console.log(`\nTest 4 (messy turn):`);
console.log(`  Result: ${parsed2.kind === "turn" ? "✓ PASS" : "✗ FAIL"}`);
console.log(`  Kind: ${parsed2.kind}, Speaker: ${parsed2.speaker}, Target: ${parsed2.target}`);

// Test case 5: Challenge response
const challengeResp = "质疑: codex蹲codex蹲，codex蹲完cc1蹲";
const parsed3 = parseTurn(challengeResp, roster);
console.log(`\nTest 5 (challenge):`);
console.log(`  Result: ${parsed3.kind === "challenge" ? "✓ PASS" : "✗ FAIL"}`);
console.log(`  Kind: ${parsed3.kind}, Text: ${parsed3.text}`);

// Test case 6: Done response
const doneResp = "结束: game ended due to xyz";
const parsed4 = parseTurn(doneResp, roster);
console.log(`\nTest 6 (done):`);
console.log(`  Result: ${parsed4.kind === "done" ? "✓ PASS" : "✗ FAIL"}`);
console.log(`  Kind: ${parsed4.kind}, Text: ${parsed4.text}`);

console.log("\n--- End of tests ---\n");
