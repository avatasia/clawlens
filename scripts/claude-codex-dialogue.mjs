#!/usr/bin/env node
/**
 * Multi-turn dialogue orchestrator between Claude Code (tmux) and Codex (tmux).
 *
 * Response extraction strategy (from Codex's own analysis):
 *   1. Capture baseline BEFORE sending (now included in send --json as `baseline`).
 *   2. After response, strip ANSI from baseline and final output.
 *   3. Build a fingerprint: last 5 non-empty, non-idle, non-footer lines of baseline.
 *   4. Find the LAST occurrence of that fingerprint in final lines.
 *   5. Take everything after the fingerprint as the new response.
 *   6. Strip trailing idle/footer/Working markers.
 *   7. Fallback to last 80 lines if fingerprint not found.
 *
 * Usage:
 *   node scripts/claude-codex-dialogue.mjs \
 *     --topic "What is the hardest problem in distributed systems?" \
 *     --turns 6 \
 *     --claude-session cc1 \
 *     --codex-session codex
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  claudeSession: "cc1",
  codexSession: "codex",
  turns: 4,
  timeoutMs: 120_000,
  bufferLines: 2000,   // large to avoid truncation; equivalent to history-limit
  maxMsgLen: 3000,
  firstSpeaker: "claude",
  pollMs: 300,
  settleMs: 600,
  fingerprintSize: 5,
};

export function assertDistinctBridgeSessions(claudeSession, codexSession) {
  if (String(claudeSession || "").trim() === String(codexSession || "").trim()) {
    throw new Error(
      `Claude and Codex sessions must be different to avoid self-routing (${claudeSession}). ` +
      "Use separate tmux sessions for bridge traffic.",
    );
  }
}

// ── ANSI / terminal cleanup ────────────────────────────────────────────────

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[^[\]]/g, "")
    .replace(/\r/g, "");
}

// ── Response extraction ────────────────────────────────────────────────────

/**
 * Both UIs echo the submitted message with a role-specific input-prompt prefix:
 *   Claude Code:  ❯ [message]
 *   Codex:        › [message]
 *
 * Strategy:
 *   1. Find the LAST prompt line containing the first 60 chars of sentMessage.
 *   2. Take every line after that anchor.
 *   3. Strip trailing noise from the end:
 *      - bare idle prompt (❯ / ›)
 *      - Codex footer line (contains ·)
 *      - Codex Working timer
 *      - Claude Code sidebar stats (░█ progress bars, ⏱️, "resets in", "hooks")
 */
export function extractResponse(finalRaw, role, sentMessage) {
  const lines    = stripAnsi(finalRaw).split("\n");
  const anchor   = sentMessage.slice(0, 60);
  const promptRe = role === "codex" ? /^\s*›/ : /^\s*❯/;

  // Find the LAST prompt line that echoes our message
  let anchorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (promptRe.test(lines[i]) && lines[i].includes(anchor)) {
      anchorIdx = i;
    }
  }

  const startIdx = anchorIdx >= 0 ? anchorIdx + 1 : Math.max(0, lines.length - 60);
  const after    = lines.slice(startIdx);

  // Strip trailing noise from end
  let end = after.length;
  for (let i = after.length - 1; i >= 0; i--) {
    const raw = after[i];
    const t   = raw.trim();
    if (t === "") continue;
    // Bare idle prompt (nothing after the prompt char)
    if (promptRe.test(raw) && t.replace(/^[›❯>]\s*/, "") === "") { end = i; continue; }
    // Layout separator lines (─── repeated)
    if (/^─{4,}$/.test(t)) { end = i; continue; }
    // Codex footer (contains ·)
    if (role === "codex" && /·/.test(t)) { end = i; continue; }
    // Codex Working timer
    if (role === "codex" && /^•\s+Working\b/.test(t)) { end = i; continue; }
    // Claude Code sidebar stats
    if (role === "claude" && /[░█]|⏱️|resets in|\bhooks\b/.test(t)) { end = i; continue; }
    break;
  }

  let extracted = after.slice(0, end).join("\n").trim();

  // Strip Claude Code UI decorations from extracted text:
  //   ⎿  sub-output lines (tool metadata like "Stop says: [done …]")
  //   ● prefix on response lines → keep the text, drop the bullet
  if (role === "claude") {
    extracted = extracted
      .split("\n")
      .filter(l => !/^\s*⎿/.test(l))           // drop sub-output lines
      .map(l => l.replace(/^\s*●\s*/, ""))       // strip leading ● bullet
      .join("\n")
      .trim();
  }

  return extracted;
}

// ── Script caller ──────────────────────────────────────────────────────────

function callSend(scriptPath, session, message, opts) {
  const args = [
    scriptPath,
    "send",
    "--session",      session,
    "--message",      message,
    "--buffer-lines", String(opts.bufferLines),
    "--timeout-ms",   String(opts.timeoutMs),
    "--poll-ms",      String(opts.pollMs),
    "--settle-ms",    String(opts.settleMs),
    "--json",
    "--include-pane-text",
  ];
  const result = spawnSync("node", args, {
    encoding:  "utf8",
    timeout:   opts.timeoutMs + 30_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `send failed (${path.basename(scriptPath)}): ${(result.stderr || result.stdout || "").slice(0, 400)}`
    );
  }
  return JSON.parse(result.stdout);
}

// ── Formatting ─────────────────────────────────────────────────────────────

function hr(char = "─", width = 64) { return char.repeat(width); }

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n\n[... truncated at ${maxLen} chars]`;
}

function printTurn(turn, total, speaker, sent, response) {
  console.log(`\n${hr()}`);
  console.log(`Turn ${turn}/${total}  →  ${speaker.toUpperCase()}`);
  console.log(hr("·"));
  const preview = sent.slice(0, 160) + (sent.length > 160 ? " [...]" : "");
  console.log(`SENT:\n${preview}`);
  console.log(hr("·"));
  console.log(`${speaker.toUpperCase()} RESPONDS:\n${response}`);
}

// ── Args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  let topic = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--topic")           { topic = argv[++i]; continue; }
    if (a === "--turns")           { opts.turns = Number(argv[++i]); continue; }
    if (a === "--claude-session")  { opts.claudeSession = argv[++i]; continue; }
    if (a === "--codex-session")   { opts.codexSession = argv[++i]; continue; }
    if (a === "--timeout-ms")      { opts.timeoutMs = Number(argv[++i]); continue; }
    if (a === "--buffer-lines")    { opts.bufferLines = Number(argv[++i]); continue; }
    if (a === "--max-msg-len")     { opts.maxMsgLen = Number(argv[++i]); continue; }
    if (a === "--poll-ms")         { opts.pollMs = Number(argv[++i]); continue; }
    if (a === "--settle-ms")       { opts.settleMs = Number(argv[++i]); continue; }
    if (a === "--first-speaker")   { opts.firstSpeaker = argv[++i]; continue; }
    if (a === "--fingerprint-size"){ opts.fingerprintSize = Number(argv[++i]); continue; }
    if (a === "--help" || a === "-h") {
      console.log(`Usage: node scripts/claude-codex-dialogue.mjs --topic "..." [options]

Options:
  --topic <text>            Opening topic / first message (required)
  --turns <n>               Total turns (default: ${DEFAULTS.turns})
  --first-speaker <role>    "claude" or "codex" (default: ${DEFAULTS.firstSpeaker})
  --claude-session <name>   tmux session for Claude Code (default: ${DEFAULTS.claudeSession})
  --codex-session <name>    tmux session for Codex (default: ${DEFAULTS.codexSession})
  --timeout-ms <n>          Per-turn timeout ms (default: ${DEFAULTS.timeoutMs})
  --buffer-lines <n>        Pane capture lines (default: ${DEFAULTS.bufferLines})
  --max-msg-len <n>         Max chars forwarded to next AI (default: ${DEFAULTS.maxMsgLen})
  --poll-ms <n>             Poll interval ms (default: ${DEFAULTS.pollMs})
  --settle-ms <n>           Post-submit settle ms (default: ${DEFAULTS.settleMs})
  --fingerprint-size <n>    Lines used as diff anchor (default: ${DEFAULTS.fingerprintSize})
`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${a}`);
  }

  if (!topic) throw new Error("--topic is required");
  if (!["claude", "codex"].includes(opts.firstSpeaker)) {
    throw new Error('--first-speaker must be "claude" or "codex"');
  }
  return { topic, opts };
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const { topic, opts } = parseArgs(process.argv.slice(2));
  assertDistinctBridgeSessions(opts.claudeSession, opts.codexSession);

  const claudeScript = path.join(__dirname, "claude-tmux-control.mjs");
  const codexScript  = path.join(__dirname, "codex-tmux-control.mjs");

  console.log(`\n${"═".repeat(64)}`);
  console.log(` CLAUDE ↔ CODEX DIALOGUE   (${opts.turns} turns, first: ${opts.firstSpeaker})`);
  console.log(` Topic: ${topic.slice(0, 80)}`);
  console.log(`${"═".repeat(64)}`);

  let currentMessage = topic;
  let currentRole    = opts.firstSpeaker;

  for (let turn = 1; turn <= opts.turns; turn++) {
    const isClaudeRole = currentRole === "claude";
    const session      = isClaudeRole ? opts.claudeSession : opts.codexSession;
    const script       = isClaudeRole ? claudeScript : codexScript;

    process.stdout.write(`\n[turn ${turn}/${opts.turns}] → ${currentRole.toUpperCase()} … `);

    let result;
    try {
      result = callSend(script, session, currentMessage, opts);
    } catch (err) {
      console.error(`\nFATAL on turn ${turn}: ${err.message}`);
      process.exit(1);
    }

    const response  = extractResponse(result.output, currentRole, currentMessage);
    const forwarded = truncate(response, opts.maxMsgLen);

    process.stdout.write(`done (${forwarded.length} chars)\n`);
    printTurn(turn, opts.turns, currentRole, currentMessage, forwarded);

    currentRole    = isClaudeRole ? "codex" : "claude";
    currentMessage = forwarded;
  }

  console.log(`\n${"═".repeat(64)}`);
  console.log(` Dialogue complete. ${opts.turns} turns logged.`);
  console.log(`${"═".repeat(64)}\n`);
}

const entryPath = new URL(import.meta.url).pathname;
if (process.argv[1] && path.resolve(process.argv[1]) === entryPath) {
  main();
}
