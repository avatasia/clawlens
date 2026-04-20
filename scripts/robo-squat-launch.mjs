#!/usr/bin/env node

import { randomInt } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { extractResponse as extractClaudeResponse } from "./claude-codex-dialogue.mjs";
import { extractCodexResponse } from "./gemini-codex-dialogue.mjs";
import { extractResponse as extractGeminiResponse } from "./gemini-tmux-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  claudeSession: "cc1",
  codexSession: "codex",
  geminiSession: "gemini1",
  starterSession: "cc1",
  turns: 100,
  timeoutMs: 120_000,
  pollMs: 300,
  settleMs: 600,
  bufferLines: 2_000,
  clearFirst: true,
};

const CONTROL_SCRIPTS = {
  claude: path.join(__dirname, "claude-tmux-control.mjs"),
  codex: path.join(__dirname, "codex-tmux-control.mjs"),
  gemini: path.join(__dirname, "gemini-tmux-control.mjs"),
};

function usage() {
  console.log(`Usage: node scripts/robo-squat-launch.mjs [options]

Options:
  --claude-session <name>   Claude session name (default: ${DEFAULTS.claudeSession})
  --codex-session <name>    Codex session name (default: ${DEFAULTS.codexSession})
  --gemini-session <name>   Gemini session name (default: ${DEFAULTS.geminiSession})
  --starter-session <name>  Session that starts the game (default: ${DEFAULTS.starterSession})
  --turns <n>               Max rounds to run (default: ${DEFAULTS.turns})
  --timeout-ms <n>          Per-call timeout in ms (default: ${DEFAULTS.timeoutMs})
  --poll-ms <n>             Poll interval in ms (default: ${DEFAULTS.pollMs})
  --settle-ms <n>           Post-submit settle in ms (default: ${DEFAULTS.settleMs})
  --buffer-lines <n>        Pane capture lines (default: ${DEFAULTS.bufferLines})
  --no-clear-first          Skip the initial /clear bootstrap
  --help                    Show this help

This launcher clears each session separately, teaches them the game rules,
waits for the bootstrap acknowledgements, then relays turns among the three
sessions.
`);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    usage();
    process.exit(0);
  }

  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--claude-session") { opts.claudeSession = argv[++i] ?? ""; continue; }
    if (arg === "--codex-session") { opts.codexSession = argv[++i] ?? ""; continue; }
    if (arg === "--gemini-session") { opts.geminiSession = argv[++i] ?? ""; continue; }
    if (arg === "--starter-session") { opts.starterSession = argv[++i] ?? ""; continue; }
    if (arg === "--turns") { opts.turns = Number(argv[++i]); continue; }
    if (arg === "--timeout-ms") { opts.timeoutMs = Number(argv[++i]); continue; }
    if (arg === "--poll-ms") { opts.pollMs = Number(argv[++i]); continue; }
    if (arg === "--settle-ms") { opts.settleMs = Number(argv[++i]); continue; }
    if (arg === "--buffer-lines") { opts.bufferLines = Number(argv[++i]); continue; }
    if (arg === "--no-clear-first") { opts.clearFirst = false; continue; }
    if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    throw new Error(`Unknown argument: ${arg}`);
  }

  for (const key of ["claudeSession", "codexSession", "geminiSession", "starterSession"]) {
    if (!String(opts[key] || "").trim()) {
      throw new Error(`--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} must be non-empty`);
    }
  }
  for (const key of ["turns", "timeoutMs", "pollMs", "settleMs", "bufferLines"]) {
    if (!Number.isInteger(opts[key]) || opts[key] <= 0) {
      throw new Error(`--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} must be a positive integer`);
    }
  }

  const roster = [opts.claudeSession, opts.codexSession, opts.geminiSession];
  if (new Set(roster).size !== roster.length) {
    throw new Error("Session names must be distinct");
  }
  if (!roster.includes(opts.starterSession)) {
    throw new Error("--starter-session must be one of the three configured sessions");
  }

  return opts;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr}`);
  }
  return (result.stdout || "").trimEnd();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return String(text || "").replace(/\r/g, "").trim();
}

function normalizeLines(text) {
  return normalizeText(text)
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function assertExactLines(actualLines, expectedLines, context) {
  if (actualLines.length !== expectedLines.length) {
    throw new Error(`${context} expected ${expectedLines.length} lines but saw ${actualLines.length}: ${JSON.stringify(actualLines)}`);
  }
  for (let i = 0; i < expectedLines.length; i += 1) {
    if (actualLines[i] !== expectedLines[i]) {
      throw new Error(`${context} line ${i + 1} mismatch: expected ${JSON.stringify(expectedLines[i])}, saw ${JSON.stringify(actualLines[i])}`);
    }
  }
}

function currentPaneTarget(session) {
  return run("tmux", ["display-message", "-p", "-t", session, "#{session_name}:#{window_index}.#{pane_index}"]);
}

function callControl(role, command, session, opts, message = null) {
  const script = CONTROL_SCRIPTS[role];
  const args = [
    script,
    command,
    "--session", session,
    "--buffer-lines", String(opts.bufferLines),
    "--timeout-ms", String(opts.timeoutMs),
    "--poll-ms", String(opts.pollMs),
    "--settle-ms", String(opts.settleMs),
    "--json",
    "--include-pane-text",
  ];
  if (message !== null) {
    args.push("--message", message);
  }
  return JSON.parse(run("node", args));
}

function sessionRole(session, opts) {
  if (session === opts.claudeSession) return "claude";
  if (session === opts.codexSession) return "codex";
  if (session === opts.geminiSession) return "gemini";
  throw new Error(`Unknown session: ${session}`);
}

export function makeRoster(opts) {
  const roster = [
    { session: opts.claudeSession, role: "claude" },
    { session: opts.codexSession, role: "codex" },
    { session: opts.geminiSession, role: "gemini" },
  ];
  const sortedNames = [...roster.map((entry) => entry.session)].sort((a, b) => a.localeCompare(b));
  const ranks = new Map(sortedNames.map((name, index) => [name, index + 1]));
  return roster.map((entry) => ({
    ...entry,
    name: entry.session,
    rank: ranks.get(entry.session),
  }));
}

function otherEntries(roster, sessionName) {
  return roster
    .filter((entry) => entry.name !== sessionName)
    .sort((left, right) => left.rank - right.rank);
}

export function exactBootstrapLines(name) {
  return [`${name} 明白`, `${name} 规则已读`];
}

function normalizeBootstrapLine(line) {
  return String(line || "")
    .replace(/^[\s›>❯●•*-]+/, "")
    .trim();
}

export function extractBootstrapAck(text, name) {
  const lines = normalizeLines(text).map(normalizeBootstrapLine);
  const required = exactBootstrapLines(name);

  for (let i = lines.length - 2; i >= 0; i -= 1) {
    if (lines[i] === required[0] && lines[i + 1] === required[1]) {
      return lines.slice(i, i + 2);
    }
  }

  return null;
}

export function extractBootstrapAckDiagnostic(text, name) {
  const lines = normalizeLines(text).map(normalizeBootstrapLine);
  const required = exactBootstrapLines(name);
  return {
    lineCount: lines.length,
    lastLines: lines.slice(-5),
    required,
    found: lines.some((line, i) => i + 1 < lines.length && line === required[0] && lines[i + 1] === required[1]),
  };
}

export function buildBootstrapPrompt(entry, roster, starterName, turns) {
  const rosterLines = roster
    .map((rosterEntry) => `- rank ${rosterEntry.rank}: ${rosterEntry.name} (${rosterEntry.role})`)
    .join("\n");
  const peerList = roster
    .filter((rosterEntry) => rosterEntry.name !== entry.name)
    .map((rosterEntry) => rosterEntry.name)
    .join(", ");
  const watcherOrder = otherEntries(roster, entry.name)
    .map((rosterEntry) => `${rosterEntry.rank}:${rosterEntry.name}`)
    .join(", ");

  return [
    `You are participant ${entry.name} in a 3-session tmux game called "萝卜蹲".`,
    `Your role is ${entry.role}; your fixed rank is ${entry.rank}.`,
    "",
    "Roster:",
    rosterLines,
    "",
    `Starter session: ${starterName}`,
    `Your peers are: ${peerList}`,
    `Your watcher order for tie-breaks is: ${watcherOrder}.`,
    "",
    "Bootstrap handshake:",
    `- On reading this prompt, reply with exactly two lines:`,
    `  - ${entry.name} 明白`,
    `  - ${entry.name} 规则已读`,
    "- Do not add any other text to the bootstrap handshake.",
    "- Do not ask the operator questions.",
    "- Do not use partial-name matching.",
    "- Session names must not contain the character 蹲.",
    "- Session names must also avoid envelope-breaking characters [, ], ,, =.",
    "",
    "Runtime rules:",
    '- The only valid turn sentence is `X蹲X蹲，X蹲完Y蹲`.',
    '- X must equal your own session name when you are the active speaker.',
    '- Y must be exactly one of the other two roster names.',
    '- If you are the named target, answer with exactly one turn sentence and nothing else.',
    '- If you are not the named target, stay silent unless you are challenging an error.',
    '- If you detect a malformed turn, wrong name, wrong target, duplicate response, or out-of-turn response, reply with a challenge that starts with `质疑:`.',
    '- If both non-active sessions detect the same error, only the lower-ranked watcher may challenge; the higher-ranked watcher must stay silent.',
    '- Do not challenge before the broadcast deadline if one is present.',
    '- If a broadcast contains a deadline, treat it as the only silence cutoff.',
    '- If no deadline is present, wait one prompt-ready cycle and then judge silence.',
    '- Round count advances only on accepted turn sentences.',
    '- Challenges do not count as rounds.',
    `- Stop at round ${turns} by emitting \`结束:\` plus a one-sentence summary.`,
    "",
    entry.name === starterName
      ? `Starter behavior: after bootstrap, wait for the launcher kickoff and then produce the first valid turn. Do not start the game on your own.`
      : `Non-starter behavior: after bootstrap, stay idle until the launcher routes a turn or challenge to you. Do not start the game on your own.`,
  ].join("\n");
}

export function buildKickoffPrompt(round, speaker, target, recipients, deadline) {
  return [
    `[robo-squat kickoff round=${round} speaker=${speaker.name} target=${target.name} audience=${recipients.map((entry) => entry.name).join(",")} deadline=${deadline}]`,
    `Produce exactly one line: ${speaker.name}蹲${speaker.name}蹲，${speaker.name}蹲完${target.name}蹲`,
    "No extra text.",
  ].join("\n");
}

export function buildTurnBroadcast(round, currentTurn, recipients, deadline) {
  return [
    `[robo-squat round=${round} speaker=${currentTurn.speaker} target=${currentTurn.target} audience=${recipients.map((entry) => entry.name).join(",")} deadline=${deadline}]`,
    currentTurn.text,
  ].join("\n");
}

export function buildChallengeBroadcast(round, reporter, offender, recipients, reason, deadline) {
  return [
    `[robo-squat challenge round=${round} reporter=${reporter.name} offender=${offender.name} audience=${recipients.map((entry) => entry.name).join(",")} deadline=${deadline}]`,
    `质疑: round=${round} reporter=${reporter.name} offender=${offender.name} reason=${reason}`,
  ].join("\n");
}

export function parseTurn(text, roster) {
  const lines = normalizeLines(text).map(line => line.replace(/^[•›❯●•*-]+\s*/, "").trim());
  for (const line of lines) {
    if (line.startsWith("结束:")) {
      return { kind: "done", text: line };
    }
    if (line.startsWith("质疑:")) {
      return { kind: "challenge", text: line };
    }
  }

  for (const speaker of roster) {
    for (const target of roster) {
      if (speaker.name === target.name) continue;
      const expected = `${speaker.name}蹲${speaker.name}蹲，${speaker.name}蹲完${target.name}蹲`;
      for (const line of lines) {
        if (line === expected) {
          return {
            kind: "turn",
            speaker: speaker.name,
            target: target.name,
            text: expected,
          };
        }
      }
    }
  }

  return {
    kind: "other",
    text: normalizeText(text),
  };
}

function extractRoleResponse(role, result, sentMessage) {
  if (role === "claude") {
    return extractClaudeResponse(result.output ?? "", "claude", sentMessage);
  }
  if (role === "codex") {
    return extractCodexResponse(result.baseline ?? "", result.output ?? "", sentMessage);
  }
  return extractGeminiResponse(result.baseline ?? "", result.output ?? "", sentMessage);
}

export function classifyRecipientResponse(entry, text, roster) {
  const parsed = parseTurn(text, roster);
  if (parsed.kind === "turn") {
    if (parsed.speaker !== entry.name) {
      return {
        kind: "out_of_turn",
        entry,
        parsed,
        text,
        reason: `expected speaker ${entry.name} but saw ${parsed.speaker}`,
      };
    }
    return { kind: "turn", entry, parsed, text };
  }
  if (parsed.kind === "challenge") {
    return { kind: "challenge", entry, parsed, text, reason: parsed.text };
  }
  if (parsed.kind === "done") {
    return { kind: "done", entry, parsed, text };
  }
  if (parsed.text === "") {
    return { kind: "empty", entry, parsed, text };
  }
  return { kind: "other", entry, parsed, text, reason: parsed.text };
}

async function clearSession(entry, opts) {
  const result = await callControl(entry.role, "clear", entry.session, opts);
  await sleep(200);
  return result;
}

async function sendSession(entry, message, opts) {
  return callControl(entry.role, "send", entry.session, opts, message);
}

async function typeSession(entry, message, opts) {
  return callControl(entry.role, "type", entry.session, opts, message);
}

async function submitSession(entry, opts) {
  return callControl(entry.role, "submit", entry.session, opts);
}

async function bootstrapSession(entry, starterName, roster, opts) {
  if (opts.clearFirst) {
    process.stdout.write(`\n[setup] clearing ${entry.session} … `);
    await clearSession(entry, opts);
    process.stdout.write(`done\n`);
  }

  const prompt = buildBootstrapPrompt(entry, roster, starterName, opts.turns);
  process.stdout.write(`[setup] teaching ${entry.session} … `);
  await typeSession(entry, prompt, opts);
  await sleep(300);
  const result = await submitSession(entry, opts);
  const responseText = extractRoleResponse(entry.role, result, prompt);
  const responseLines =
    extractBootstrapAck(responseText, entry.name) ??
    extractBootstrapAck(result.output ?? "", entry.name);
  if (!responseLines) {
    const extractedLines = normalizeLines(responseText);
    const diagnostic = extractBootstrapAckDiagnostic(result.output ?? "", entry.name);
    const preview = extractedLines.slice(0, 10).map(l => `  ${l}`).join("\n");
    throw new Error(
      `Bootstrap ack from ${entry.session} expected 2 lines but saw ${extractedLines.length}.\n` +
      `Last 5 lines: ${JSON.stringify(diagnostic.lastLines)}\n` +
      `First lines:\n${preview}`
    );
  }
  const required = exactBootstrapLines(entry.name);
  assertExactLines(responseLines, required, `Bootstrap ack from ${entry.session}`);
  process.stdout.write(`done\n`);
  return { prompt, responseText: responseLines.join("\n"), result };
}

export function pickInitialTarget(starter, roster) {
  const candidates = roster.filter((entry) => entry.name !== starter.name);
  return candidates[randomInt(0, candidates.length)];
}

async function relayBroadcast(round, currentTurn, roster, opts) {
  const recipients = otherEntries(roster, currentTurn.speaker);
  const deadline = new Date(Date.now() + opts.timeoutMs).toISOString();
  const broadcast = buildTurnBroadcast(round, currentTurn, recipients, deadline);
  const sendChallenge = async (reporter, offender, reason) => {
    const challengeRecipients = roster.filter((entry) => entry.name !== reporter.name);
    const challengeText = buildChallengeBroadcast(
      round,
      reporter,
      offender,
      challengeRecipients,
      reason,
      deadline,
    );
    process.stdout.write(`  [challenge] ${reporter.name} -> ${offender.name}: ${reason}\n`);
    for (const recipient of challengeRecipients) {
      process.stdout.write(`  [relay-challenge] ${recipient.name} … `);
      await sendSession(recipient, challengeText, opts);
      process.stdout.write(`done\n`);
    }
  };

  process.stdout.write(`[round ${round}] ${currentTurn.text}\n`);

  const deliveries = [];
  for (const recipient of recipients) {
    process.stdout.write(`  [route] ${recipient.name} … `);
    const result = await sendSession(recipient, broadcast, opts);
    const responseText = extractRoleResponse(recipient.role, result, broadcast);
    const classification = classifyRecipientResponse(recipient, responseText, roster);
    deliveries.push({ recipient, result, responseText, classification });
    process.stdout.write(`done\n`);
  }

  const targetDelivery = deliveries.find((delivery) => delivery.recipient.name === currentTurn.target);
  const watcherDelivery = deliveries.find((delivery) => delivery.recipient.name !== currentTurn.target);
  if (!targetDelivery || !watcherDelivery) {
    throw new Error(`Invalid routing state for round ${round}`);
  }

  if (targetDelivery.classification.kind === "done") {
    return { done: true, finalText: targetDelivery.classification.parsed.text };
  }

  if (targetDelivery.classification.kind === "challenge") {
    // Target challenged the speaker
    await sendChallenge(targetDelivery.recipient, { name: currentTurn.speaker }, targetDelivery.classification.reason);
    return {
      done: false,
      challenge: true,
      reason: targetDelivery.classification.reason,
      offender: currentTurn.speaker,
    };
  }

  if (targetDelivery.classification.kind !== "turn") {
    const reason = targetDelivery.classification.reason || targetDelivery.classification.text || "target did not produce a valid turn";
    await sendChallenge(watcherDelivery.recipient, targetDelivery.recipient, reason);
    return {
      done: false,
      challenge: true,
      reason,
      offender: targetDelivery.recipient.name,
    };
  }

  if (watcherDelivery.classification.kind === "challenge") {
    // Watcher challenged the speaker or target
    await sendChallenge(watcherDelivery.recipient, targetDelivery.recipient, watcherDelivery.classification.reason);
    return {
      done: false,
      challenge: true,
      reason: watcherDelivery.classification.reason,
      offender: targetDelivery.recipient.name,
    };
  }

  if (watcherDelivery.classification.kind === "turn") {
    const reason = `out-of-turn response from ${watcherDelivery.recipient.name}`;
    await sendChallenge(targetDelivery.recipient, watcherDelivery.recipient, reason);
    return {
      done: false,
      challenge: true,
      reason,
      offender: watcherDelivery.recipient.name,
    };
  }

  // Watcher empty is expected behavior
  return {
    done: false,
    nextTurn: targetDelivery.classification.parsed,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const roster = makeRoster(opts);
  const starter = roster.find((entry) => entry.name === opts.starterSession);
  if (!starter) {
    throw new Error("Starter session is not in roster");
  }

  console.log(`\n${"═".repeat(72)}`);
  console.log(` 萝卜蹲 Launcher`);
  console.log(` Starter: ${starter.name}`);
  console.log(` Roster: ${roster.map((entry) => `${entry.rank}:${entry.name}`).join(" | ")}`);
  console.log(`${"═".repeat(72)}`);

  for (const entry of roster) {
    await bootstrapSession(entry, starter.name, roster, opts);
  }

  const kickoffTarget = pickInitialTarget(starter, roster);
  const kickoffDeadline = new Date(Date.now() + opts.timeoutMs).toISOString();
  const kickoffPrompt = buildKickoffPrompt(1, starter, kickoffTarget, otherEntries(roster, starter.name), kickoffDeadline);

  process.stdout.write(`\n[kickoff] asking ${starter.name} for round 1 … `);
  const kickoffResult = await sendSession(starter, kickoffPrompt, opts);
  const kickoffResponseText = extractRoleResponse(starter.role, kickoffResult, kickoffPrompt);
  const kickoffResponse = classifyRecipientResponse(starter, kickoffResponseText, roster);
  if (kickoffResponse.kind !== "turn") {
    throw new Error(`Starter did not produce a valid first turn: ${kickoffResponseText}`);
  }
  process.stdout.write(`done\n`);

  let round = 1;
  let currentTurn = kickoffResponse.parsed;

  while (round <= opts.turns) {
    const result = await relayBroadcast(round, currentTurn, roster, opts);
    if (result.done) {
      console.log(`[done] ${result.finalText}`);
      return;
    }
    if (result.challenge) {
      throw new Error(`Round ${round} challenge from ${result.offender}: ${result.reason}`);
    }
    currentTurn = result.nextTurn;
    round += 1;
  }

  console.log(`[done] reached round limit ${opts.turns}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
