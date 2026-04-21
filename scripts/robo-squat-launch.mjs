#!/usr/bin/env node

import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { extractResponse as extractClaudeResponse } from "./claude-codex-dialogue.mjs";
import { extractCodexResponse, extractCodexResponseMeta } from "./gemini-codex-dialogue.mjs";
import { extractResponse as extractGeminiResponse } from "./gemini-tmux-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHALLENGE_MODES = Object.freeze({
  GAMEMASTER: "gamemaster",
  DISTRIBUTED: "distributed",
});

const GAME_MASTER = Object.freeze({ name: "game-master", rank: 0, role: "launcher" });

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
  challengeMode: CHALLENGE_MODES.GAMEMASTER,
};

const CONTROL_SCRIPTS = {
  claude: path.join(__dirname, "claude-tmux-control.mjs"),
  codex: path.join(__dirname, "codex-tmux-control.mjs"),
  gemini: path.join(__dirname, "gemini-tmux-control.mjs"),
};

const ROLE_ADAPTERS = Object.freeze({
  claude: {
    clear(session, opts) {
      return callControl("claude", "clear", session, opts);
    },
    send(session, opts, message, sendOptions = {}) {
      return callControl("claude", "send", session, opts, message, sendOptions);
    },
    type(session, opts, message) {
      return callControl("claude", "type", session, opts, message);
    },
    submit(session, opts) {
      return callControl("claude", "submit", session, opts);
    },
    extractResponse(result, sentMessage) {
      return extractClaudeResponse(result.output ?? "", "claude", sentMessage);
    },
    extractResponseMeta(result, sentMessage) {
      return {
        responseText: extractClaudeResponse(result.output ?? "", "claude", sentMessage),
        method: null,
      };
    },
  },
  codex: {
    clear(session, opts) {
      return callControl("codex", "clear", session, opts);
    },
    send(session, opts, message, sendOptions = {}) {
      return callControl("codex", "send", session, opts, message, sendOptions);
    },
    type(session, opts, message) {
      return callControl("codex", "type", session, opts, message);
    },
    submit(session, opts) {
      return callControl("codex", "submit", session, opts);
    },
    extractResponse(result, sentMessage) {
      return extractCodexResponse(result.baseline ?? "", result.output ?? "", sentMessage);
    },
    extractResponseMeta(result, sentMessage) {
      const meta = extractCodexResponseMeta(result.baseline ?? "", result.output ?? "", sentMessage);
      return { responseText: meta.text, method: meta.method };
    },
  },
  gemini: {
    clear(session, opts) {
      return callControl("gemini", "clear", session, opts);
    },
    send(session, opts, message, sendOptions = {}) {
      return callControl("gemini", "send", session, opts, message, sendOptions);
    },
    type(session, opts, message) {
      return callControl("gemini", "type", session, opts, message);
    },
    submit(session, opts) {
      return callControl("gemini", "submit", session, opts);
    },
    extractResponse(result, sentMessage) {
      return extractGeminiResponse(result.baseline ?? "", result.output ?? "", sentMessage);
    },
    extractResponseMeta(result, sentMessage) {
      return {
        responseText: extractGeminiResponse(result.baseline ?? "", result.output ?? "", sentMessage),
        method: null,
      };
    },
  },
});

function roleAdapter(role) {
  const adapter = ROLE_ADAPTERS[role];
  if (!adapter) {
    throw new Error(`Unknown role: ${role}`);
  }
  return adapter;
}

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
  --challenge-mode <mode>   Challenge policy: gamemaster (default) | distributed
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
    if (arg === "--challenge-mode") { opts.challengeMode = String(argv[++i] ?? "").trim().toLowerCase(); continue; }
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

  const validModes = new Set(Object.values(CHALLENGE_MODES));
  if (!validModes.has(opts.challengeMode)) {
    throw new Error(
      `--challenge-mode must be one of: ${[...validModes].join(", ")} (got ${JSON.stringify(opts.challengeMode)})`
    );
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
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: command === "tmux" ? 10_000 : undefined,
    killSignal: "SIGKILL",
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${command} ${args.join(" ")} timed out`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr}`);
  }
  return (result.stdout || "").trimEnd();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function broadcastGameOver(roster, opts) {
  for (const entry of roster) {
    try {
      await sendSession(entry, "结束游戏", opts, { waitForResponse: false });
    } catch (_) {
      // fire-and-forget
    }
  }
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

function callControl(role, command, session, opts, message = null, sendOptions = {}) {
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
  if (command === "send" && sendOptions.waitForResponse === false) {
    args.push("--no-wait");
  }
  return JSON.parse(run("node", args));
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

export function buildBootstrapPrompt(entry, roster, starterName, turns, challengeMode = "gamemaster") {
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

  const isGameMaster = challengeMode === CHALLENGE_MODES.GAMEMASTER;

  const outputContract = isGameMaster
    ? "- OUTPUT CONTRACT: After bootstrap, output EXACTLY one line: a turn sentence when you are the named target, or `结束:` plus a one-sentence summary at round limit. Do NOT emit 质疑: yourself. No preamble, no bullets, no UI symbols (✦/✓), no chain-of-thought."
    : "- OUTPUT CONTRACT: The bootstrap handshake is the ONLY time two lines are allowed. After bootstrap, output EXACTLY one line matching one of: a turn sentence, a line starting with '质疑:', or a line starting with '结束:'. No preamble, no bullets, no UI symbols (✦/✓), no chain-of-thought.";

  const adjudicationBlock = isGameMaster
    ? [
        "Judge / Game Master rules:",
        "- A Game Master (GM) exists outside the 3-player roster. The GM is the launcher process itself, not an AI peer.",
        "- The GM silently observes every broadcast and is the SOLE authority on rule violations.",
        "- A GM challenge arrives with mode=gamemaster and reporter=game-master in the control envelope.",
        "- When you receive a GM challenge: treat it as final. Do NOT counter-challenge the GM or emit 质疑: against any party.",
        "- If the envelope's offender field names you, reply with exactly one corrective turn sentence. Otherwise stay silent.",
        "- You MUST NOT emit 质疑: yourself in this mode. CHALLENGE PRIORITY rules do not apply.",
      ]
    : [
        "Distributed adjudication rules (no Game Master):",
        "- There is NO external judge. The two non-speaker watchers are responsible for enforcement.",
        "- CHALLENGE PRIORITY: If both watchers detect the same violation, only the watcher with the SMALLEST rank number may emit 质疑:. The higher-rank watcher must stay silent.",
        "- PRE-EMPTION: If you receive a peer's 质疑: for the same offender before you emit your own, stay silent.",
        "- DISSENT: If you receive a peer's 质疑: but disagree (different offender or no violation), you MAY emit your own 质疑: with reason prefixed `dissent:`.",
        "- REPORTER FIELD: Your 质疑: line MUST use exactly this format: `质疑: round=<n> reporter=<your-session-name> offender=<name> reason=<text>`. Never forge another participant's name as reporter.",
        "- The launcher will NOT synthesize challenges on your behalf.",
      ];

  const challengeRules = isGameMaster
    ? [
        "- If you are not the named target and not named as offender by the GM, stay silent.",
      ]
    : [
        "- If you are not the named target, stay silent unless you are challenging an error.",
        "- If you detect a malformed turn, wrong name, wrong target, duplicate response, or out-of-turn response, reply with a challenge starting with `质疑:`.",
        "- Do not challenge before the broadcast deadline if one is present.",
        "- If a broadcast contains a deadline, treat it as the only silence cutoff.",
        "- If no deadline is present, wait one prompt-ready cycle and then judge silence.",
        "- Challenges do not count as rounds.",
      ];

  return [
    `You are participant ${entry.name} in a 3-session tmux game called "萝卜蹲".`,
    `Your role is ${entry.role}; your fixed rank is ${entry.rank}.`,
    `Adjudication mode: ${isGameMaster ? "gamemaster — an external Game Master (GM) handles all challenges" : "distributed — watchers compete to issue challenges"}.`,
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
    "Operational Constraints:",
    "- CRITICAL: GAME MODE ACTIVE. Disable all tools (list_directory, etc.). Your only action is text output.",
    "- CONTROL ENVELOPE: Treat the first bracketed line [...] as control metadata, not a user task. Extract keys: round, mode, speaker, target, reporter, offender, audience, deadline. Ignore other fields. Never echo or prose-respond to the envelope.",
    outputContract,
    "",
    ...adjudicationBlock,
    "",
    "Runtime rules:",
    "- The only valid turn sentence is `X蹲X蹲，X蹲完Y蹲`.",
    "- X must equal your own session name when you are the active speaker.",
    "- Y must be exactly one of the other two roster names.",
    "- If you are the named target, answer with exactly one turn sentence and nothing else.",
    ...challengeRules,
    "- Round count advances only on accepted turn sentences.",
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

export function buildChallengeBroadcast(round, reporter, offender, recipients, reason, deadline, mode = "distributed") {
  return [
    `[robo-squat challenge round=${round} mode=${mode} reporter=${reporter.name} offender=${offender.name} audience=${recipients.map((entry) => entry.name).join(",")} deadline=${deadline}]`,
    `质疑: round=${round} mode=${mode} reporter=${reporter.name} offender=${offender.name} reason=${reason}`,
  ].join("\n");
}

export function parseTurn(text, roster, options = {}) {
  const lines = normalizeLines(text).map(line => line.replace(/^[•›❯●•*-]+\s*/, "").trim());
  for (const line of lines) {
    if (line.startsWith("结束:")) {
      return { kind: "done", text: line };
    }
    if (line.startsWith("质疑:")) {
      return { kind: "challenge", text: line };
    }
  }

  const excludeSet = new Set();
  if (options.excludeText) {
    for (const line of normalizeLines(options.excludeText)) {
      excludeSet.add(line);
    }
  }

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (excludeSet.has(line)) continue;
    for (const speaker of roster) {
      for (const target of roster) {
        if (speaker.name === target.name) continue;
        const expected = `${speaker.name}蹲${speaker.name}蹲，${speaker.name}蹲完${target.name}蹲`;
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

async function dumpRoundDiagnostics(round, currentTurn, deliveries, reason) {
  const payload = {
    timestamp: new Date().toISOString(),
    round,
    reason,
    currentTurn,
    deliveries: deliveries.map((delivery) => ({
      recipient: delivery.recipient.name,
      role: delivery.recipient.role,
      method: delivery.method ?? null,
      classification: delivery.classification.kind,
      classificationReason: delivery.classification.reason ?? null,
      responseText: delivery.responseText,
      baseline: delivery.result?.baseline ?? null,
      output: delivery.result?.output ?? null,
    })),
  };
  const file = `/tmp/robo-squat-round-${round}.json`;
  try {
    await fs.promises.writeFile(file, JSON.stringify(payload, null, 2));
    process.stdout.write(`  [diagnostics] saved ${file} (${reason})\n`);
  } catch (error) {
    process.stdout.write(`  [diagnostics] failed to save ${file}: ${error?.message || error}\n`);
  }
}

export function classifyRecipientResponse(entry, text, roster, options = {}) {
  const parsed = parseTurn(text, roster, { excludeText: options.excludeText });
  if (parsed.kind === "turn") {
    if (parsed.speaker === entry.name) {
      return { kind: "turn", entry, parsed, text };
    }
    if (options.previousSpeaker && parsed.speaker === options.previousSpeaker) {
      return {
        kind: "stale_echo",
        entry,
        parsed,
        text,
        reason: `observed ${parsed.speaker}'s prior sentence instead of a fresh turn from ${entry.name}`,
      };
    }
    return {
      kind: "out_of_turn",
      entry,
      parsed,
      text,
      reason: `expected speaker ${entry.name} but saw ${parsed.speaker}`,
    };
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

export function narrowResponseRegion(text, maxLines = 30) {
  const lines = normalizeLines(text);
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(-maxLines).join("\n");
}

export function tighterReparse(text, roster, currentTurn) {
  const narrowed = narrowResponseRegion(text);
  return parseTurn(narrowed, roster, { excludeText: currentTurn.text });
}

async function clearSession(entry, opts) {
  const result = await roleAdapter(entry.role).clear(entry.session, opts);
  await sleep(200);
  return result;
}

async function sendSession(entry, message, opts, sendOptions = {}) {
  return roleAdapter(entry.role).send(entry.session, opts, message, sendOptions);
}

async function typeSession(entry, message, opts) {
  return roleAdapter(entry.role).type(entry.session, opts, message);
}

async function submitSession(entry, opts) {
  return roleAdapter(entry.role).submit(entry.session, opts);
}

async function bootstrapSession(entry, starterName, roster, opts) {
  if (opts.clearFirst) {
    process.stdout.write(`\n[setup] clearing ${entry.session} … `);
    await clearSession(entry, opts);
    process.stdout.write(`done\n`);
  }

  const prompt = buildBootstrapPrompt(entry, roster, starterName, opts.turns, opts.challengeMode);
  process.stdout.write(`[setup] teaching ${entry.session} … `);
  await typeSession(entry, prompt, opts);
  await sleep(300);
  const result = await submitSession(entry, opts);
  const responseText = roleAdapter(entry.role).extractResponse(result, prompt);
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

function inferOffenderFromChallenge(challengeText, currentTurn, roster) {
  const match = /offender=([^\s,\]]+)/.exec(challengeText || "");
  if (match) {
    const hit = roster.find((r) => r.name === match[1]);
    if (hit) return hit;
  }
  return roster.find((r) => r.name === currentTurn.speaker) ?? roster[0];
}

async function relayBroadcastGameMaster(round, currentTurn, roster, opts) {
  const recipients = otherEntries(roster, currentTurn.speaker);
  const deadline = new Date(Date.now() + opts.timeoutMs).toISOString();
  const broadcast = buildTurnBroadcast(round, currentTurn, recipients, deadline);

  const sendChallenge = async (reporter, offender, reason) => {
    const challengeRecipients = roster.filter((entry) => entry.name !== reporter.name);
    const challengeText = buildChallengeBroadcast(round, reporter, offender, challengeRecipients, reason, deadline, "gamemaster");
    process.stdout.write(`  [gm-challenge] ${reporter.name} -> ${offender.name}: ${reason}\n`);
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
    const { responseText, method } = roleAdapter(recipient.role).extractResponseMeta(result, broadcast);
    const classification = classifyRecipientResponse(recipient, responseText, roster, {
      excludeText: currentTurn.text,
      previousSpeaker: currentTurn.speaker,
    });
    deliveries.push({ recipient, result, responseText, method, classification });
    process.stdout.write(`done${method ? ` (method=${method})` : ""}\n`);
  }

  const targetDelivery = deliveries.find((d) => d.recipient.name === currentTurn.target);
  const watcherDelivery = deliveries.find((d) => d.recipient.name !== currentTurn.target);
  if (!targetDelivery || !watcherDelivery) {
    throw new Error(`Invalid routing state for round ${round}`);
  }

  if (targetDelivery.classification.kind === "done") {
    return { done: true, finalText: targetDelivery.classification.parsed.text };
  }

  // In GM mode, players must not emit 质疑: — treat as violation
  if (targetDelivery.classification.kind === "challenge") {
    const reason = "player emitted 质疑: in gamemaster mode (forbidden)";
    await sendChallenge(GAME_MASTER, targetDelivery.recipient, reason);
    return { done: false, challenge: true, reason, offender: targetDelivery.recipient.name };
  }
  if (watcherDelivery.classification.kind === "challenge") {
    const reason = "player emitted 质疑: in gamemaster mode (forbidden)";
    await sendChallenge(GAME_MASTER, watcherDelivery.recipient, reason);
    return { done: false, challenge: true, reason, offender: watcherDelivery.recipient.name };
  }

  if (targetDelivery.classification.kind === "stale_echo") {
    const reparsed = tighterReparse(targetDelivery.responseText, roster, currentTurn);
    if (reparsed.kind === "turn" && reparsed.speaker === currentTurn.target) {
      process.stdout.write(`  [stale_echo] recovered via tighter re-parse\n`);
      return { done: false, nextTurn: reparsed };
    }
    await dumpRoundDiagnostics(round, currentTurn, deliveries, "stale_echo_persisted");
    return { done: false, ambiguous: true, reason: `stale_echo persisted for target ${currentTurn.target} after tighter re-parse` };
  }

  if (targetDelivery.classification.kind !== "turn") {
    const reason = targetDelivery.classification.reason || targetDelivery.classification.text || "target did not produce a valid turn";
    await sendChallenge(GAME_MASTER, targetDelivery.recipient, reason);
    return { done: false, challenge: true, reason, offender: targetDelivery.recipient.name };
  }

  if (watcherDelivery.classification.kind === "turn") {
    const reason = `out-of-turn response from ${watcherDelivery.recipient.name}`;
    await sendChallenge(GAME_MASTER, watcherDelivery.recipient, reason);
    return { done: false, challenge: true, reason, offender: watcherDelivery.recipient.name };
  }

  return { done: false, nextTurn: targetDelivery.classification.parsed };
}

async function relayBroadcastDistributed(round, currentTurn, roster, opts) {
  const recipients = otherEntries(roster, currentTurn.speaker);
  const deadline = new Date(Date.now() + opts.timeoutMs).toISOString();
  const broadcast = buildTurnBroadcast(round, currentTurn, recipients, deadline);

  const sendChallenge = async (reporter, offender, reason) => {
    const challengeRecipients = roster.filter((entry) => entry.name !== reporter.name);
    const challengeText = buildChallengeBroadcast(round, reporter, offender, challengeRecipients, reason, deadline, "distributed");
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
    const { responseText, method } = roleAdapter(recipient.role).extractResponseMeta(result, broadcast);
    const classification = classifyRecipientResponse(recipient, responseText, roster, {
      excludeText: currentTurn.text,
      previousSpeaker: currentTurn.speaker,
    });
    deliveries.push({ recipient, result, responseText, method, classification });
    process.stdout.write(`done${method ? ` (method=${method})` : ""}\n`);
  }

  const targetDelivery = deliveries.find((d) => d.recipient.name === currentTurn.target);
  const watcherDelivery = deliveries.find((d) => d.recipient.name !== currentTurn.target);
  if (!targetDelivery || !watcherDelivery) {
    throw new Error(`Invalid routing state for round ${round}`);
  }

  if (targetDelivery.classification.kind === "done") {
    return { done: true, finalText: targetDelivery.classification.parsed.text };
  }

  // Collect all real challenges from any recipient, rank-sorted ascending
  const realChallenges = deliveries
    .filter((d) => d.classification.kind === "challenge")
    .map((d) => ({
      reporter: d.recipient,
      offender: inferOffenderFromChallenge(d.classification.parsed?.text ?? d.classification.reason ?? "", currentTurn, roster),
      reason: d.classification.reason ?? d.classification.text ?? "",
    }))
    .sort((a, b) => a.reporter.rank - b.reporter.rank);

  if (realChallenges.length > 0) {
    const [primary, ...rest] = realChallenges;
    await sendChallenge(primary.reporter, primary.offender, primary.reason);
    for (const extra of rest) {
      if (extra.offender.name !== primary.offender.name) {
        await sendChallenge(extra.reporter, extra.offender, `dissent: ${extra.reason}`);
      } else {
        process.stdout.write(`  [pre-empted] ${extra.reporter.name} suppressed (same offender as primary)\n`);
      }
    }
    return { done: false, challenge: true, reason: primary.reason, offender: primary.offender.name };
  }

  if (targetDelivery.classification.kind === "stale_echo") {
    const reparsed = tighterReparse(targetDelivery.responseText, roster, currentTurn);
    if (reparsed.kind === "turn" && reparsed.speaker === currentTurn.target) {
      process.stdout.write(`  [stale_echo] recovered via tighter re-parse\n`);
      return { done: false, nextTurn: reparsed };
    }
    await dumpRoundDiagnostics(round, currentTurn, deliveries, "stale_echo_persisted");
    return { done: false, ambiguous: true, reason: `stale_echo persisted for target ${currentTurn.target} after tighter re-parse` };
  }

  if (targetDelivery.classification.kind !== "turn") {
    await dumpRoundDiagnostics(round, currentTurn, deliveries, "target_invalid_no_challenge");
    return {
      done: false,
      ambiguous: true,
      reason: `target ${targetDelivery.recipient.name} invalid but no watcher challenged (distributed mode)`,
    };
  }

  if (watcherDelivery.classification.kind === "turn") {
    await dumpRoundDiagnostics(round, currentTurn, deliveries, "watcher_out_of_turn_no_challenge");
    return {
      done: false,
      ambiguous: true,
      reason: `watcher ${watcherDelivery.recipient.name} spoke out of turn; no peer challenged (distributed mode)`,
    };
  }

  return { done: false, nextTurn: targetDelivery.classification.parsed };
}

async function relayBroadcast(round, currentTurn, roster, opts) {
  if (opts.challengeMode === CHALLENGE_MODES.DISTRIBUTED) {
    return relayBroadcastDistributed(round, currentTurn, roster, opts);
  }
  return relayBroadcastGameMaster(round, currentTurn, roster, opts);
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
  console.log(` Challenge mode: ${opts.challengeMode}`);
  console.log(`${"═".repeat(72)}`);

  for (const entry of roster) {
    await bootstrapSession(entry, starter.name, roster, opts);
  }

  const kickoffTarget = pickInitialTarget(starter, roster);
  const kickoffDeadline = new Date(Date.now() + opts.timeoutMs).toISOString();
  const kickoffPrompt = buildKickoffPrompt(1, starter, kickoffTarget, otherEntries(roster, starter.name), kickoffDeadline);

  process.stdout.write(`\n[kickoff] asking ${starter.name} for round 1 … `);
  const kickoffResult = await sendSession(starter, kickoffPrompt, opts);
  const kickoffResponseText = roleAdapter(starter.role).extractResponse(kickoffResult, kickoffPrompt);
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
      await broadcastGameOver(roster, opts);
      return;
    }
    if (result.ambiguous) {
      console.error(`[ambiguous] round ${round}: ${result.reason}`);
      console.error(`  diagnostics: /tmp/robo-squat-round-${round}.json`);
      console.error(`  no auto-challenge issued; halting for manual inspection`);
      await broadcastGameOver(roster, opts);
      process.exitCode = 2;
      return;
    }
    if (result.challenge) {
      await broadcastGameOver(roster, opts);
      throw new Error(`Round ${round} challenge from ${result.offender}: ${result.reason}`);
    }
    currentTurn = result.nextTurn;
    round += 1;
  }

  console.log(`[done] reached round limit ${opts.turns}`);
  await broadcastGameOver(roster, opts);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
