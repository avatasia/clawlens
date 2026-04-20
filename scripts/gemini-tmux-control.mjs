#!/usr/bin/env node

import process from "node:process";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { withSessionLock } from "./tmux-session-lock.mjs";

const DEFAULTS = {
  session: "gemini1",
  bufferLines: 200,
  timeoutMs: 20_000,
  pollMs: 300,
  settleMs: 500,
  stablePolls: 3,
  json: false,
  includePaneText: false,
};

const HUMAN_METHOD_LABELS = {
  input_block: "BLOCK",
  baseline_fingerprint: "FINGERPRINT",
  tail_fallback: "FRAYED",
};

function usage() {
  console.log(`Usage: node scripts/gemini-tmux-control.mjs <command> [options]

Commands:
  status                       print the current Gemini pane state
  clear                        send /clear and wait for a fresh prompt
  send                         send a message and wait for response
  type                         type a message without submitting it
  submit                       press Enter and wait for response

Options:
  --session <name>             tmux session name (default: gemini1)
  --buffer-lines <n>           capture last N pane lines (default: 200)
  --timeout-ms <n>             monitor timeout in milliseconds (default: 20000)
  --poll-ms <n>                monitor poll interval in milliseconds (default: 300)
  --settle-ms <n>              extra wait after submit before polling (default: 500)
  --stable-polls <n>           consecutive identical idle polls required (default: 3)
  --message <text>             message text for send/type commands
  --json                       emit machine-readable JSON
  --include-pane-text          include raw pane snapshots in JSON output
  --help                       show this help

Examples:
  node scripts/gemini-tmux-control.mjs status --session gemini1
  node scripts/gemini-tmux-control.mjs send --session gemini1 --message "Hello Gemini"
  node scripts/gemini-tmux-control.mjs type --session gemini1 --message "Hello Gemini"
  node scripts/gemini-tmux-control.mjs submit --session gemini1
`);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    usage();
    process.exit(0);
  }

  const options = { ...DEFAULTS };
  const command = argv[0];

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--session") { options.session = argv[++i] ?? ""; continue; }
    if (arg === "--buffer-lines") { options.bufferLines = Number(argv[++i]); continue; }
    if (arg === "--timeout-ms") { options.timeoutMs = Number(argv[++i]); continue; }
    if (arg === "--poll-ms") { options.pollMs = Number(argv[++i]); continue; }
    if (arg === "--settle-ms") { options.settleMs = Number(argv[++i]); continue; }
    if (arg === "--stable-polls") { options.stablePolls = Number(argv[++i]); continue; }
    if (arg === "--message") { options.message = argv[++i] ?? ""; continue; }
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--include-pane-text") { options.includePaneText = true; continue; }
    if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const validCommands = ["status", "clear", "send", "type", "submit"];
  if (!validCommands.includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  if (!options.session) {
    throw new Error("--session must be non-empty");
  }
  for (const key of ["bufferLines", "timeoutMs", "pollMs", "settleMs"]) {
    if (!Number.isInteger(options[key]) || options[key] <= 0) {
      throw new Error(`--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} must be a positive integer`);
    }
  }
  if (!Number.isInteger(options.stablePolls) || options.stablePolls <= 0) {
    throw new Error("--stable-polls must be a positive integer");
  }
  if ((command === "send" || command === "type") && !options.message) {
    throw new Error("--message is required for send/type command");
  }

  return { command, options };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr}`);
  }
  return (result.stdout || "").trimEnd();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentPaneTarget(session) {
  return run("tmux", ["display-message", "-p", "-t", session, "#{session_name}:#{window_index}.#{pane_index}"]);
}

function capturePane(target, bufferLines) {
  return run("tmux", ["capture-pane", "-pt", target, "-S", `-${bufferLines}`]);
}

export function stripAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[^[\]]/g, "")
    .replace(/\r/g, "");
}

export function paneDiagnostics(text) {
  const clean = stripAnsi(text)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trimEnd();
  return {
    paneHash: createHash("sha256").update(clean, "utf8").digest("hex").slice(0, 12),
    capturedChars: clean.length,
    paneLineCount: clean === "" ? 0 : clean.split("\n").length,
  };
}

function isGeminiStopTailNoiseLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return true;
  if (trimmed === "? for shortcuts") return true;
  if (trimmed.startsWith("Shift+Tab to accept edits")) return true;
  if (trimmed.startsWith("workspace (/directory)")) return true;
  if (trimmed.includes("Auto (Gemini 3)") || trimmed.includes("Gemini Code")) return true;
  if (trimmed.startsWith(">")) return true;
  if (/^[▀▄]+$/.test(trimmed)) return true;
  if (/^[─]+$/.test(trimmed)) return true;
  return false;
}

function isGeminiRestartLine(line) {
  const trimmed = line.trim();
  return (
    /^[\s▝▜▄▟▀╭╮╰╯│─┌┐└┘]*Gemini CLI v\d[\w.\-+]*\s*$/i.test(trimmed) ||
    /^[\s▝▜▄▟▀╭╮╰╯│─┌┐└┘]*Signed in with Google\b.*$/i.test(trimmed) ||
    /^[\s▝▜▄▟▀╭╮╰╯│─┌┐└┘]*Plan:\s*Gemini Code Assist\b.*$/i.test(trimmed) ||
    /^[\s▝▜▄▟▀╭╮╰╯│─┌┐└┘]*We're making changes to Gemini CLI\b.*$/i.test(trimmed)
  );
}

export function parseStopState(text) {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);
  let stopLineIndex = -1;
  let stopAt = null;
  let raw = null;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (isGeminiStopTailNoiseLine(line)) continue;

    const match = line.match(/^\s*Stop says:\s*\[done\s+([^\]]+)\]\s*$/i);
    if (match) {
      stopLineIndex = i;
      stopAt = match[1].trim();
      raw = trimmed;
    }
    break;
  }

  if (stopLineIndex < 0) {
    return { stopSeen: false, stopAt: null, stopLineIndex: -1, raw: null };
  }

  return {
    stopSeen: true,
    stopAt,
    stopLineIndex,
    raw,
  };
}

export function parseRestartState(text) {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    if (!isGeminiRestartLine(lines[i])) continue;
    return {
      restartSeen: true,
      restartLineIndex: i,
      raw: lines[i].trim(),
    };
  }

  return {
    restartSeen: false,
    restartLineIndex: -1,
    raw: null,
  };
}

export function formatHumanMethodLabel(method) {
  return HUMAN_METHOD_LABELS[method] || String(method || "UNKNOWN").toUpperCase();
}

function hasGeminiBusySignal(text) {
  return (
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+.+\(esc to cancel/i.test(text) ||
    /Shell awaiting input/i.test(text) ||
    /Considering Command Execution/i.test(text) ||
    /Defining the Task's Constraints/i.test(text)
  );
}

export function isBusy(text) {
  const clean = stripAnsi(text);
  const stop = parseStopState(clean);
  if (stop.stopSeen) {
    const afterStop = clean.split(/\r?\n/).slice(stop.stopLineIndex + 1).join("\n");
    if (!hasGeminiBusySignal(afterStop)) return false;
  }
  if (!isPromptReady(clean)) return true;
  const lastLines = clean.split("\n").slice(-8).join("\n");
  return hasGeminiBusySignal(lastLines);
}

export function isPromptReady(text) {
  const clean = stripAnsi(text);
  return /Type your message or @path\/to\/file/.test(clean) || /^\s*>/m.test(clean);
}

export function nextStableCount(previousText, currentText, previousCount) {
  return previousText === currentText ? previousCount + 1 : 1;
}

export async function waitForReady(target, options) {
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() <= deadline) {
    const text = capturePane(target, options.bufferLines);
    if (!isBusy(text) && isPromptReady(text)) {
      return text;
    }
    await sleep(options.pollMs);
  }

  throw new Error("Gemini pane is not ready for input");
}

export function parseFooterState(text) {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    const autoMatch = line.match(/\b(Auto \([^)]+\))/);
    if (autoMatch) {
      return { model: autoMatch[1] };
    }
    const geminiMatch = line.match(/\b(Gemini [A-Za-z0-9._-]+)\b/);
    if (geminiMatch) {
      return { model: geminiMatch[1] };
    }
  }

  return { model: null };
}

function isGeminiNoiseLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  if (trimmed.includes("Type your message or @path/to/file")) return true;
  if (trimmed === "? for shortcuts") return true;
  if (trimmed.startsWith("Shift+Tab to accept edits")) return true;
  if (trimmed.startsWith("workspace (/directory)")) return true;
  if (trimmed.includes("Auto (Gemini 3)") || trimmed.includes("Gemini Code")) return true;
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+.+\(esc to cancel/i.test(trimmed)) return true;
  if (/Shell awaiting input/i.test(trimmed)) return true;
  if (/Considering Command Execution/i.test(trimmed)) return true;
  if (/^[▀▄]+$/.test(trimmed)) return true;
  if (/^[─]+$/.test(trimmed)) return true;
  return false;
}

function isGeminiInputStart(line) {
  return line.startsWith(" > ");
}

function isGeminiDivider(line) {
  return /^[▀▄]+$/.test(line.trim());
}

function normalizeInlineWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function tokenizeForSimilarity(text) {
  return normalizeInlineWhitespace(text)
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9'"-]*/g) || [];
}

function textSimilarityScore(left, right) {
  const leftTokens = new Set(tokenizeForSimilarity(left).filter((token) => token.length >= 3));
  const rightTokens = new Set(tokenizeForSimilarity(right).filter((token) => token.length >= 3));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function findGeminiInputBlock(lines, sentMessage) {
  const normalizedMessage = normalizeInlineWhitespace(sentMessage);
  const anchor = normalizedMessage.slice(0, 80);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isGeminiInputStart(lines[i])) continue;

    const block = [lines[i].replace(/^ > /, "")];
    let j = i + 1;
    while (j < lines.length && !isGeminiDivider(lines[j])) {
      if (lines[j].startsWith("✦ ")) break;
      block.push(lines[j].trimStart());
      j += 1;
    }

    const blockText = normalizeInlineWhitespace(block.join(" "));
    const similarity = textSimilarityScore(blockText, normalizedMessage);
    if (
      blockText.includes(anchor) ||
      anchor.includes(blockText.slice(0, Math.min(blockText.length, 40))) ||
      similarity >= 0.35
    ) {
      return { start: i, end: j };
    }
  }

  return null;
}

export function extractResponseMeta(baselineRaw, finalRaw, sentMessage) {
  const baselineLines = stripAnsi(baselineRaw).split("\n");
  const finalLines = stripAnsi(finalRaw).split("\n");

  let splitIdx = -1;
  let method = "tail_fallback";
  const inputBlock = findGeminiInputBlock(finalLines, sentMessage);
  if (inputBlock) {
    for (let i = inputBlock.end; i < finalLines.length; i += 1) {
      if (finalLines[i].startsWith("✦ ")) {
        splitIdx = i;
        method = "input_block";
        break;
      }
    }
  }

  if (splitIdx < 0) {
    const fingerprint = baselineLines
      .map((line) => line.trim())
      .filter((line) =>
        line !== "" &&
        !line.startsWith(">") &&
        !isGeminiNoiseLine(line)
      )
      .slice(-5);

    if (fingerprint.length > 0) {
      const trimmedFinal = finalLines.map((line) => line.trim());
      outer:
      for (let i = finalLines.length - fingerprint.length; i >= 0; i -= 1) {
        for (let j = 0; j < fingerprint.length; j += 1) {
          if (trimmedFinal[i + j] !== fingerprint[j]) continue outer;
        }
        splitIdx = i + fingerprint.length;
        method = "baseline_fingerprint";
        break;
      }
    }
  }

  if (splitIdx < 0) {
    splitIdx = Math.max(0, finalLines.length - 60);
    method = "tail_fallback";
  }

  const newLines = finalLines.slice(splitIdx);
  let end = newLines.length;
  for (let i = newLines.length - 1; i >= 0; i -= 1) {
    const raw = newLines[i];
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (isGeminiNoiseLine(raw)) { end = i; continue; }
    break;
  }

  const responseLines = newLines.slice(0, end);
  while (responseLines.length > 0 && (responseLines[0].trim() === "" || isGeminiNoiseLine(responseLines[0]))) {
    responseLines.shift();
  }
  while (
    responseLines.length > 0 &&
    (responseLines[responseLines.length - 1].trim() === "" || isGeminiNoiseLine(responseLines[responseLines.length - 1]))
  ) {
    responseLines.pop();
  }
  return {
    method,
    text: responseLines.join("\n").trim(),
  };
}

export function refineResponseMetaWithWiderCapture(baselineRaw, narrowRaw, wideRaw, sentMessage) {
  const narrowMeta = extractResponseMeta(baselineRaw, narrowRaw, sentMessage);
  if (narrowMeta.method !== "tail_fallback") {
    return narrowMeta;
  }

  const wideMeta = extractResponseMeta(baselineRaw, wideRaw, sentMessage);
  if (wideMeta.method === "tail_fallback") {
    return narrowMeta;
  }

  return wideMeta.text.length >= narrowMeta.text.length ? wideMeta : narrowMeta;
}

export function extractResponse(baselineRaw, finalRaw, sentMessage) {
  return extractResponseMeta(baselineRaw, finalRaw, sentMessage).text;
}

export function buildStatusSnapshot(text) {
  return {
    restart: parseRestartState(text),
    footer: parseFooterState(text),
    busy: isBusy(text),
    stop: parseStopState(text),
    promptReady: isPromptReady(text),
    ...paneDiagnostics(text),
  };
}

async function sendMessage(session, options, message) {
  const target = currentPaneTarget(session);
  const baseline = await waitForReady(target, options);

  run("tmux", ["send-keys", "-t", target, message]);
  await sleep(250);
  run("tmux", ["send-keys", "-t", target, "Enter"]);
  await sleep(options.settleMs);

  const busyDeadline = Date.now() + 10_000;
  let becameBusy = false;
  while (Date.now() <= busyDeadline) {
    const text = capturePane(target, options.bufferLines);
    if (isBusy(text)) {
      becameBusy = true;
      break;
    }
    await sleep(options.pollMs);
  }

  if (becameBusy) {
    const deadline = Date.now() + options.timeoutMs;
    let lastIdleText = null;
    let stableCount = 0;
    while (Date.now() <= deadline) {
      const text = capturePane(target, options.bufferLines);
      if (!isBusy(text)) {
        stableCount = nextStableCount(lastIdleText, text, stableCount);
        lastIdleText = text;
        if (isPromptReady(text) || stableCount >= options.stablePolls) {
          return { target, baseline, output: text, becameBusy: true };
        }
      } else {
        lastIdleText = null;
        stableCount = 0;
      }
      await sleep(options.pollMs);
    }
    throw new Error("Timed out waiting for Gemini to finish responding");
  }

  const finalText = capturePane(target, options.bufferLines);
  return { target, baseline, output: finalText, becameBusy: false };
}

async function typeMessage(session, options, message) {
  const target = currentPaneTarget(session);
  const baseline = await waitForReady(target, options);

  run("tmux", ["send-keys", "-t", target, message]);
  await sleep(250);

  const finalText = capturePane(target, options.bufferLines);
  return { target, baseline, output: finalText, becameBusy: false };
}

async function submitMessage(session, options) {
  const target = currentPaneTarget(session);
  const baseline = await waitForReady(target, options);

  run("tmux", ["send-keys", "-t", target, "Enter"]);
  await sleep(options.settleMs);

  const busyDeadline = Date.now() + 10_000;
  let becameBusy = false;
  while (Date.now() <= busyDeadline) {
    const text = capturePane(target, options.bufferLines);
    if (isBusy(text)) {
      becameBusy = true;
      break;
    }
    await sleep(options.pollMs);
  }

  if (becameBusy) {
    const deadline = Date.now() + options.timeoutMs;
    let lastIdleText = null;
    let stableCount = 0;
    while (Date.now() <= deadline) {
      const text = capturePane(target, options.bufferLines);
      if (!isBusy(text)) {
        stableCount = nextStableCount(lastIdleText, text, stableCount);
        lastIdleText = text;
        if (isPromptReady(text) || stableCount >= options.stablePolls) {
          return { target, baseline, output: text, becameBusy: true };
        }
      } else {
        lastIdleText = null;
        stableCount = 0;
      }
      await sleep(options.pollMs);
    }
    throw new Error("Timed out waiting for Gemini to finish responding");
  }

  const finalText = capturePane(target, options.bufferLines);
  return { target, baseline, output: finalText, becameBusy: false };
}

async function clearConversation(session, options) {
  const target = currentPaneTarget(session);
  const baseline = await waitForReady(target, options);

  run("tmux", ["send-keys", "-t", target, "/clear"]);
  await sleep(200);
  run("tmux", ["send-keys", "-t", target, "Enter"]);
  await sleep(options.settleMs);

  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    const text = capturePane(target, options.bufferLines);
    if (!isBusy(text) && isPromptReady(text)) {
      return { target, baseline, output: text, becameBusy: true };
    }
    await sleep(options.pollMs);
  }

  throw new Error("Timed out waiting for Gemini to finish /clear");
}

function outputResult(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.action === "status") {
    console.log(`Session:       ${result.session}`);
    console.log(`Target pane:   ${result.target}`);
    console.log(`Model:         ${result.footer.model || "unknown"}`);
    console.log(`Restart seen:  ${result.restart.restartSeen}`);
    console.log(`Restart marker: ${result.restart.raw || "n/a"}`);
    console.log(`Busy:          ${result.busy}`);
    console.log(`Stop seen:     ${result.stop.stopSeen}`);
    console.log(`Stop at:       ${result.stop.stopAt || "n/a"}`);
    console.log(`Prompt ready:  ${result.promptReady}`);
    console.log(`Captured:      ${result.capturedChars}`);
    return;
  }

  if (result.action === "clear") {
    console.log(`Action:        ${result.action}`);
    console.log(`Session:       ${result.session}`);
    console.log(`Target pane:   ${result.target}`);
    console.log(`Became busy:   ${result.becameBusy}`);
    console.log(`Captured:      ${result.capturedChars}`);
    console.log(`--- prompt ---`);
    console.log(result.output);
    return;
  }

  if (result.action === "type") {
    console.log(`Action:        ${result.action}`);
    console.log(`Session:       ${result.session}`);
    console.log(`Target pane:   ${result.target}`);
    console.log(`Message:       ${result.message}`);
    console.log(`Captured:      ${result.capturedChars}`);
    console.log(`--- input ---`);
    console.log(result.output);
    return;
  }

  if (result.action === "submit") {
    console.log(`Action:        ${result.action}`);
    console.log(`Session:       ${result.session}`);
    console.log(`Target pane:   ${result.target}`);
    console.log(`Became busy:   ${result.becameBusy}`);
    console.log(`Captured:      ${result.capturedChars}`);
    console.log(`--- response ---`);
    console.log(result.output);
    return;
  }

  console.log(`Action:        ${result.action}`);
  console.log(`Session:       ${result.session}`);
  console.log(`Target pane:   ${result.target}`);
  console.log(`Message:       ${result.message}`);
  console.log(`Became busy:   ${result.becameBusy}`);
  console.log(`Method:        ${formatHumanMethodLabel(result.responseMeta?.method)}`);
  console.log(`Captured:      ${result.capturedChars}`);
  console.log(`--- response ---`);
  console.log(result.output);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "status") {
    const target = currentPaneTarget(options.session);
    const text = capturePane(target, options.bufferLines);
    outputResult({
      action: "status",
      session: options.session,
      target,
      ...buildStatusSnapshot(text),
    }, options.json);
    return;
  }

  if (command === "clear") {
    const result = await withSessionLock(
      options.session,
      async () => clearConversation(options.session, options),
      options.timeoutMs + 10_000,
    );
    const payload = {
      action: "clear",
      session: options.session,
      ...paneDiagnostics(result.output ?? ""),
      ...result,
    };
    if (options.json && !options.includePaneText) {
      delete payload.baseline;
      delete payload.output;
    }
    outputResult(payload, options.json);
    return;
  }

  if (command === "send") {
    const result = await withSessionLock(
      options.session,
      async () => sendMessage(options.session, options, options.message),
      options.timeoutMs + 10_000,
    );
    const widenedOutput = capturePane(result.target, Math.max(options.bufferLines * 4, 600));
    const responseMeta = refineResponseMetaWithWiderCapture(
      result.baseline ?? "",
      result.output,
      widenedOutput,
      options.message,
    );
    if (responseMeta.method !== "tail_fallback") {
      result.output = widenedOutput;
    }
    const payload = {
      action: "send",
      session: options.session,
      message: options.message,
      response: responseMeta.text,
      responseMeta,
      ...paneDiagnostics(result.output ?? ""),
      ...result,
    };
    if (options.json && !options.includePaneText) {
      delete payload.baseline;
      delete payload.output;
    }
    outputResult(payload, options.json);
    return;
  }

  if (command === "type") {
    const result = await withSessionLock(
      options.session,
      async () => typeMessage(options.session, options, options.message),
      options.timeoutMs + 10_000,
    );
    const payload = {
      action: "type",
      session: options.session,
      message: options.message,
      ...paneDiagnostics(result.output ?? ""),
      ...result,
    };
    if (options.json && !options.includePaneText) {
      delete payload.baseline;
      delete payload.output;
    }
    outputResult(payload, options.json);
    return;
  }

  if (command === "submit") {
    const result = await withSessionLock(
      options.session,
      async () => submitMessage(options.session, options),
      options.timeoutMs + 10_000,
    );
    const payload = {
      action: "submit",
      session: options.session,
      ...paneDiagnostics(result.output ?? ""),
      ...result,
    };
    if (options.json && !options.includePaneText) {
      delete payload.baseline;
      delete payload.output;
    }
    outputResult(payload, options.json);
    return;
  }
}

const entryPath = new URL(import.meta.url).pathname;
if (process.argv[1] && entryPath === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
