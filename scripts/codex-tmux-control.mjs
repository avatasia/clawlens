#!/usr/bin/env node

import process from "node:process";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { withSessionLock } from "./tmux-session-lock.mjs";

const DEFAULTS = {
  session: "codex",
  bufferLines: 120,
  timeoutMs: 20_000,
  pollMs: 300,
  settleMs: 600,
  json: false,
  includePaneText: false,
};

// Codex model family matching (for footer verification)
const MODEL_FAMILY_PATTERNS = {
  "gpt-5.4": /^gpt-5\.4(?!-)/i,
  "gpt-5.4-mini": /^gpt-5\.4-mini/i,
  "gpt-5.3": /^gpt-5\.3/i,
  "gpt-5.2": /^gpt-5\.2(?!-)/i,
  "gpt-5.2-codex": /^gpt-5\.2-codex/i,
  "gpt-5.1-codex-max": /^gpt-5\.1-codex-max/i,
  "gpt-5.1-codex-mini": /^gpt-5\.1-codex-mini/i,
};

const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);

// Picker state keywords
const PICKER_MODEL_KEYWORD = "Select Model and Effort";
const PICKER_EFFORT_KEYWORD = "Select Reasoning Level";
// Slash command menu keyword (appears when user types "/" in input)
const SLASH_MENU_KEYWORD = "choose what model and reasoning effort";

// Map internal effort names to what the picker displays
const EFFORT_DISPLAY_ALIASES = {
  xhigh: "extra",
};

function usage() {
  console.log(`Usage: node scripts/codex-tmux-control.mjs <command> [options]

Commands:
  status                       print the current Codex pane state
  clear                        send /clear and wait for a fresh prompt
  send                         send a message and wait for response
  type                         type a message without submitting it
  submit                       press Enter and wait for response
  set-model                    open /model picker, select model + effort
  set-effort                   open /model picker, keep model, change effort
  set-combo                    open /model picker, select model + effort
  toggle-fast                  send /fast to toggle fast mode

Options:
  --session <name>             tmux session name (default: codex)
  --buffer-lines <n>           capture last N pane lines (default: 120)
  --timeout-ms <n>             monitor timeout in milliseconds (default: 20000)
  --poll-ms <n>                monitor poll interval in milliseconds (default: 300)
  --settle-ms <n>              extra wait after submit before polling (default: 600)
  --model <value>              model name for set-model/set-combo (e.g. gpt-5.4)
  --effort <value>             effort level for set-effort/set-combo
  --message <text>             message text for send/type commands
  --json                       emit machine-readable JSON
  --include-pane-text          include raw pane snapshots in JSON output
  --help                       show this help

Examples:
  node scripts/codex-tmux-control.mjs status --session codex
  node scripts/codex-tmux-control.mjs send --session codex --message "Hello Codex"
  node scripts/codex-tmux-control.mjs type --session codex --message "Hello Codex"
  node scripts/codex-tmux-control.mjs submit --session codex
  node scripts/codex-tmux-control.mjs set-model --session codex --model gpt-5.4-mini
  node scripts/codex-tmux-control.mjs set-effort --session codex --effort medium
  node scripts/codex-tmux-control.mjs set-combo --session codex --model gpt-5.4 --effort high
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
    if (arg === "--model") { options.model = argv[++i] ?? ""; continue; }
    if (arg === "--effort") { options.effort = argv[++i] ?? ""; continue; }
    if (arg === "--message") { options.message = argv[++i] ?? ""; continue; }
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--include-pane-text") { options.includePaneText = true; continue; }
    if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const validCommands = ["status", "clear", "send", "type", "submit", "set-model", "set-effort", "set-combo", "toggle-fast"];
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
  if ((command === "send" || command === "type") && !options.message) {
    throw new Error("--message is required for send/type command");
  }
  if ((command === "set-model" || command === "set-combo") && !options.model) {
    throw new Error("--model is required");
  }
  if ((command === "set-effort" || command === "set-combo") && !options.effort) {
    throw new Error("--effort is required");
  }
  if (options.effort && !EFFORT_VALUES.has(String(options.effort).toLowerCase())) {
    throw new Error(`Unsupported effort: ${options.effort}`);
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

function isTransientModelSelectionError(message) {
  return /Timed out waiting for picker:|Timed out waiting for Codex to finish responding|disabled while a task is in progress/i.test(message);
}

function currentPaneTarget(session) {
  return run("tmux", ["display-message", "-p", "-t", session, "#{session_name}:#{window_index}.#{pane_index}"]);
}

function capturePane(target, bufferLines) {
  return run("tmux", ["capture-pane", "-pt", target, "-S", `-${bufferLines}`]);
}

async function interruptCurrentTask(target, settleMs) {
  run("tmux", ["send-keys", "-t", target, "Escape"]);
  await sleep(Math.max(100, Math.min(settleMs, 400)));
  run("tmux", ["send-keys", "-t", target, "C-c"]);
  await sleep(Math.max(100, Math.min(settleMs, 400)));
  run("tmux", ["send-keys", "-t", target, "Escape"]);
  await sleep(Math.max(150, Math.min(settleMs, 1000)));
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[^[\]]/g, "")
    .replace(/\r/g, "");
}

export function paneDiagnostics(text) {
  const clean = stripAnsi(text)
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

function isCodexStopTailNoiseLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return true;
  if (/^\s*•\s+Model changed to\s+\S+\s+(?:low|medium|high|xhigh|max)\b/i.test(trimmed)) return true;
  if (/^\s*\S+\s+(low|medium|high|xhigh|max)\s+·/i.test(trimmed)) return true;
  if (/^\s*Context\s+\d+% used\b/i.test(trimmed)) return true;
  if (/^[▀▄]+$/.test(trimmed)) return true;
  if (/^[─]+$/.test(trimmed)) return true;
  return false;
}

function isCodexRestartLine(line) {
  const trimmed = line.trim();
  return (
    /^[\s▝▜▄▟▀╭╮╰╯│─┌┐└┘]*OpenAI Codex\b.*$/i.test(trimmed) ||
    /^[\s▝▜▄▟▀╭╮╰╯│─┌┐└┘]*Codex CLI\b.*$/i.test(trimmed) ||
    /^[\s▝▜▄▟▀╭╮╰╯│─┌┐└┘]*Welcome to Codex\b.*$/i.test(trimmed) ||
    /^[\s▝▜▄▟▀╭╮╰╯│─┌┐└┘]*Launching Codex\b.*$/i.test(trimmed)
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
    if (isCodexStopTailNoiseLine(line)) continue;

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
    if (!isCodexRestartLine(lines[i])) continue;
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

/**
 * Footer format: "<model> <effort> · <cwd> · ..."
 * e.g. "gpt-5.4 high · ~/github/clawlens · ..."
 */
export function parseFooterState(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const m = line.match(/^\s*(\S+)\s+(low|medium|high|xhigh|max)\s+·/i);
    if (m) {
      return { model: m[1].trim(), effort: m[2].toLowerCase() };
    }
  }
  return { model: null, effort: null };
}

/**
 * Ack format: "• Model changed to <model> <effort>"
 */
function matchLastAck(text) {
  const matches = [...text.matchAll(/•\s+Model changed to\s+(\S+)\s+(low|medium|high|xhigh|max)\b/gi)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return { model: last[1].trim(), effort: last[2].toLowerCase(), raw: last[0].trim() };
}

function countAcks(text) {
  return [...text.matchAll(/•\s+Model changed to\s+\S+\s+(?:low|medium|high|xhigh|max)\b/gi)].length;
}

function hasCodexBusySignal(text) {
  return (
    /•\s+Working\b/.test(text) ||
    /tab to queue message/.test(text) ||
    /background terminal running/.test(text) ||
    /task is in progress/i.test(text) ||
    /disabled while a task is in progress/i.test(text)
  );
}

export function isBusy(text) {
  // Both "• Working" and "tab to queue message" can appear inside message content
  // when Codex echoes what it sent (e.g. in tool-output lines). Only check the last
  // 24 display lines where the actual busy indicators live (above the footer).
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);
  const lastLines = lines.slice(-24).join("\n");
  const stop = parseStopState(clean);

  // The stop hook is authoritative only if nothing busy appears after it.
  if (stop.stopSeen) {
    const afterStop = lines.slice(stop.stopLineIndex + 1).join("\n");
    if (!hasCodexBusySignal(afterStop)) {
      return false;
    }
  }

  if (hasCodexBusySignal(lastLines)) {
    return true;
  }

  // If we don't see a prompt in the tail, we are busy (waiting for it to appear).
  // Use multiline match because sometimes there are trailing empty lines or noise.
  // We check the last 100 lines to be robust against prompt being pushed up.
  const tailForPrompt = lines.slice(-100).join("\n");
  return !/^\s*›\s*/m.test(tailForPrompt);
}

export function isPromptReady(text) {
  const clean = stripAnsi(text);
  const footer = parseFooterState(clean);
  const hasPrompt = /^\s*›\s*/m.test(clean);
  return Boolean(footer.model && footer.effort && hasPrompt);
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

  throw new Error("Codex pane is not ready for input");
}

async function waitForStableReady(target, options, stablePolls = 2) {
  const deadline = Date.now() + options.timeoutMs;
  let stableCount = 0;
  let lastText = null;

  while (Date.now() <= deadline) {
    const text = capturePane(target, options.bufferLines);
    if (!isBusy(text) && isPromptReady(text)) {
      stableCount = text === lastText ? stableCount + 1 : 1;
      lastText = text;
      if (stableCount >= stablePolls) {
        return text;
      }
    } else {
      stableCount = 0;
      lastText = null;
    }
    await sleep(options.pollMs);
  }

  throw new Error("Codex pane did not settle before model change");
}

/**
 * Find the numbered item in a picker list that matches targetName.
 * Returns the item number (1-based) or null.
 * Picker lines look like: "  1. gpt-5.4 (current)   ..." or "› 1. high ..."
 */
export function findPickerItemNumber(text, targetName) {
  const normalized = String(targetName).toLowerCase().trim();
  // Apply display alias (e.g. "xhigh" → "extra" in picker)
  const searchName = EFFORT_DISPLAY_ALIASES[normalized] || normalized;
  const lines = text.split(/\r?\n/);
  const items = [];

  for (const line of lines) {
    // Match "  N. <name>" or "› N. <name>"
    const m = line.match(/[›>\s]*(\d+)\.\s+(\S+)/);
    if (m) {
      const itemName = m[2].replace(/\(current\)|\(default\)/gi, "").toLowerCase().trim();
      items.push({ num: parseInt(m[1], 10), name: itemName });
    }
  }

  // Pass 1: Exact match
  const exact = items.find((it) => it.name === searchName);
  if (exact) return exact.num;

  // Pass 2: Fuzzy match (starts with or included)
  const fuzzy = items.find((it) => it.name.startsWith(searchName) || searchName.startsWith(it.name));
  return fuzzy ? fuzzy.num : null;
}

async function waitForText(target, bufferLines, timeoutMs, pollMs, keyword) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const text = capturePane(target, bufferLines);
    if (text.includes(keyword)) return text;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for picker: "${keyword}"`);
}

async function waitForTextGone(target, bufferLines, timeoutMs, pollMs, keyword) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const text = capturePane(target, bufferLines);
    if (!text.includes(keyword)) return text;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for picker to dismiss: "${keyword}"`);
}

export function countSubstantiveLines(text) {
  const clean = stripAnsi(text);
  let count = 0;
  for (const rawLine of clean.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    if (/^[│┃▌▍▎▏▐▕]*\s*›/.test(trimmed)) continue;
    if (/^\s*\S+\s+(?:low|medium|high|xhigh|max)\s+·/.test(trimmed)) continue;
    if (/^[╭╮╰╯│─]+$/.test(trimmed)) continue;
    if (/^[▀▄]+$/.test(trimmed)) continue;
    count += 1;
  }
  return count;
}

export function hasNewNonInputContent(baseline, current) {
  return countSubstantiveLines(current) > countSubstantiveLines(baseline);
}

async function sendMessage(session, options, message) {
  const target = currentPaneTarget(session);
  const baselineText = await waitForReady(target, options);

  run("tmux", ["send-keys", "-t", target, message]);
  await sleep(300);
  run("tmux", ["send-keys", "-t", target, "Enter"]);
  await sleep(Math.max(options.settleMs, 400));

  // Joint readiness condition: prompt ready AND not busy AND (we saw busy at some point
  // OR pane has grown with non-input-block content). This avoids returning prematurely
  // when Codex is still warming up to respond, without relying on a fixed 15s window.
  const deadline = Date.now() + options.timeoutMs;
  let sawBusy = false;
  while (Date.now() <= deadline) {
    const text = capturePane(target, options.bufferLines);
    const busy = isBusy(text);
    if (busy) {
      sawBusy = true;
    } else if (isPromptReady(text) && (sawBusy || hasNewNonInputContent(baselineText, text))) {
      return { target, baseline: baselineText, output: text, becameBusy: sawBusy };
    }
    await sleep(options.pollMs);
  }
  throw new Error("Timed out waiting for Codex to finish responding");
}

async function typeMessage(session, options, message) {
  const target = currentPaneTarget(session);
  const baselineText = await waitForReady(target, options);

  run("tmux", ["send-keys", "-t", target, message]);
  // Wait longer for long messages to finish typing (estimate ~30ms per 50 chars + base)
  const typeDelayMs = Math.max(300, Math.min(2000, Math.ceil(message.length / 50) * 30 + 100));
  await sleep(typeDelayMs);

  const finalText = capturePane(target, options.bufferLines);
  return { target, baseline: baselineText, output: finalText, becameBusy: false };
}

async function submitMessage(session, options) {
  const target = currentPaneTarget(session);
  const baselineText = await waitForReady(target, options);

  run("tmux", ["send-keys", "-t", target, "Enter"]);
  await sleep(Math.max(options.settleMs, 400));

  const busyDeadline = Date.now() + 15_000;
  let becameBusy = false;
  while (Date.now() <= busyDeadline) {
    const text = capturePane(target, options.bufferLines);
    if (isBusy(text)) { becameBusy = true; break; }
    await sleep(options.pollMs);
  }

  if (becameBusy) {
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() <= deadline) {
      const text = capturePane(target, options.bufferLines);
      if (!isBusy(text) && isPromptReady(text)) {
        return { target, baseline: baselineText, output: text, becameBusy: true };
      }
      await sleep(options.pollMs);
    }
    throw new Error("Timed out waiting for Codex to finish responding");
  }

  const finalText = capturePane(target, options.bufferLines);
  return { target, baseline: baselineText, output: finalText, becameBusy: false };
}

async function clearConversation(session, options) {
  const target = currentPaneTarget(session);
  const initialText = capturePane(target, options.bufferLines);
  if (isBusy(initialText) || !isPromptReady(initialText)) {
    await interruptCurrentTask(target, options.settleMs);
  }
  const baselineText = await waitForReady(target, options);

  run("tmux", ["send-keys", "-t", target, "/clear"]);
  await sleep(200);
  run("tmux", ["send-keys", "-t", target, "Enter"]);
  await sleep(options.settleMs);

  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    const text = capturePane(target, options.bufferLines);
    if (!isBusy(text) && isPromptReady(text)) {
      return { target, baseline: baselineText, output: text, becameBusy: true };
    }
    await sleep(options.pollMs);
  }

  throw new Error("Timed out waiting for Codex to finish /clear");
}

async function setModelAndEffort(session, options, targetModel, targetEffort) {
  const target = currentPaneTarget(session);
  const initialText = capturePane(target, options.bufferLines);
  if (isBusy(initialText) || !isPromptReady(initialText)) {
    await interruptCurrentTask(target, options.settleMs);
  }
  const baselineText = await waitForReady(target, options);
  await waitForStableReady(target, options, 2);
  const baselineAckCount = countAcks(baselineText);

  // Step 1: Open the slash command menu ("/") and select /model with Enter.
  // Sending "/model\n" directly executes the command without showing the picker UI;
  // the interactive path is: type "/" → menu appears → Enter selects /model.
  run("tmux", ["send-keys", "-t", target, "C-u"]);
  await sleep(200);
  run("tmux", ["send-keys", "-t", target, "/"]);
  await waitForText(target, options.bufferLines, 5_000, options.pollMs, SLASH_MENU_KEYWORD);
  run("tmux", ["send-keys", "-t", target, "Enter"]);
  await sleep(options.settleMs);

  // Step 2: Wait for the model list picker.
  const modelPickerText = await waitForText(target, options.bufferLines, options.timeoutMs, options.pollMs, PICKER_MODEL_KEYWORD);

  // Step 3: Navigate to target model.
  // Pressing a number key directly jumps to that item AND auto-advances to effort picker.
  // Pressing Enter (no number) advances with the currently highlighted item.
  if (targetModel) {
    const itemNum = findPickerItemNumber(modelPickerText, targetModel);
    if (itemNum === null) {
      run("tmux", ["send-keys", "-t", target, "Escape", ""]);
      throw new Error(`Model "${targetModel}" not found in picker`);
    }
    run("tmux", ["send-keys", "-t", target, String(itemNum), ""]);
  } else {
    run("tmux", ["send-keys", "-t", target, "Enter"]);
  }
  await sleep(options.settleMs);

  // Step 4: Wait for effort picker (header: "Select Reasoning Level for <model>").
  const effortPickerText = await waitForText(target, options.bufferLines, options.timeoutMs, options.pollMs, PICKER_EFFORT_KEYWORD);

  // Step 5: Navigate to target effort (if specified), then confirm with Enter.
  if (targetEffort) {
    const effortNum = findPickerItemNumber(effortPickerText, targetEffort);
    if (effortNum === null) {
      run("tmux", ["send-keys", "-t", target, "Escape", ""]);
      throw new Error(`Effort "${targetEffort}" not found in picker`);
    }
    run("tmux", ["send-keys", "-t", target, String(effortNum), ""]);
    await sleep(options.pollMs);
  }
  run("tmux", ["send-keys", "-t", target, "Enter"]);

  // Step 6: Wait for ack message "• Model changed to <model> <effort>".
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    const text = capturePane(target, options.bufferLines);
    if (countAcks(text) > baselineAckCount) {
      return { target, footer: parseFooterState(text), ack: matchLastAck(text) };
    }
    await sleep(options.pollMs);
  }

  const finalText = capturePane(target, options.bufferLines);
  throw new Error(
    `Timed out. Last footer: ${parseFooterState(finalText).model || "unknown"} / ${parseFooterState(finalText).effort || "n/a"}`,
  );
}

async function setModelAndEffortWithRetry(session, options, targetModel, targetEffort) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await setModelAndEffort(session, options, targetModel, targetEffort);
    } catch (error) {
      lastError = error;
      if (attempt >= 3 || !isTransientModelSelectionError(String(error?.message || error))) {
        throw error;
      }
      const target = currentPaneTarget(session);
      await interruptCurrentTask(target, options.settleMs);
      await sleep(Math.min(options.pollMs * 4, 2_000));
      await waitForReady(target, options);
    }
  }

  throw lastError;
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
    console.log(`Effort:        ${result.footer.effort || "not visible"}`);
    console.log(`Restart seen:  ${result.restart.restartSeen}`);
    console.log(`Restart marker: ${result.restart.raw || "n/a"}`);
    console.log(`Busy:          ${result.busy}`);
    console.log(`Stop seen:     ${result.stop.stopSeen}`);
    console.log(`Stop at:       ${result.stop.stopAt || "n/a"}`);
    console.log(`Last ack:      ${result.ack?.raw || "n/a"}`);
    console.log(`Captured:      ${result.capturedChars}`);
    return;
  }

  if (result.action === "send") {
    console.log(`Action:        ${result.action}`);
    console.log(`Session:       ${result.session}`);
    console.log(`Target pane:   ${result.target}`);
    console.log(`Message:       ${result.message}`);
    console.log(`Became busy:   ${result.becameBusy}`);
    console.log(`Captured:      ${result.capturedChars}`);
    console.log(`--- response ---`);
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

  if (result.action === "toggle-fast") {
    console.log(`Action:        ${result.action}`);
    console.log(`Session:       ${result.session}`);
    return;
  }

  console.log(`Action:        ${result.action}`);
  console.log(`Session:       ${result.session}`);
  console.log(`Target pane:   ${result.target}`);
  if (result.model) console.log(`Requested model: ${result.model}`);
  if (result.effort) console.log(`Requested effort: ${result.effort}`);
  console.log(`Model:         ${result.footer.model || "unknown"}`);
  console.log(`Effort:        ${result.footer.effort || "not visible"}`);
  if (result.ack) console.log(`Ack:           ${result.ack.raw}`);
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
      restart: parseRestartState(text),
      footer: parseFooterState(text),
      busy: isBusy(text),
      stop: parseStopState(text),
      ack: matchLastAck(text),
      ...paneDiagnostics(text),
    }, options.json);
    return;
  }

  if (command === "clear") {
    const result = await withSessionLock(
      options.session,
      async () => clearConversation(options.session, options),
      options.timeoutMs + 10_000,
    );
    const payload = { action: "clear", session: options.session, ...paneDiagnostics(result.output ?? ""), ...result };
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
    const payload = { action: "send", session: options.session, message: options.message, ...paneDiagnostics(result.output ?? ""), ...result };
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
    const payload = { action: "type", session: options.session, message: options.message, ...paneDiagnostics(result.output ?? ""), ...result };
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
    const payload = { action: "submit", session: options.session, ...paneDiagnostics(result.output ?? ""), ...result };
    if (options.json && !options.includePaneText) {
      delete payload.baseline;
      delete payload.output;
    }
    outputResult(payload, options.json);
    return;
  }

  if (command === "toggle-fast") {
    await withSessionLock(options.session, async () => {
      const target = currentPaneTarget(options.session);
      run("tmux", ["send-keys", "-t", target, "C-u"]);
      await sleep(200);
      run("tmux", ["send-keys", "-t", target, "/fast"]);
      await sleep(300);
      run("tmux", ["send-keys", "-t", target, "Enter"]);
    }, options.timeoutMs + 10_000);
    outputResult({ action: "toggle-fast", session: options.session }, options.json);
    return;
  }

  if (command === "set-model") {
    const result = await withSessionLock(
      options.session,
      async () => setModelAndEffortWithRetry(options.session, options, options.model, null),
      options.timeoutMs + 10_000,
    );
    outputResult({ action: "set-model", session: options.session, model: options.model, ...result }, options.json);
    return;
  }

  if (command === "set-effort") {
    const result = await withSessionLock(
      options.session,
      async () => setModelAndEffortWithRetry(options.session, options, null, options.effort),
      options.timeoutMs + 10_000,
    );
    outputResult({ action: "set-effort", session: options.session, effort: options.effort, ...result }, options.json);
    return;
  }

  if (command === "set-combo") {
    const result = await withSessionLock(
      options.session,
      async () => setModelAndEffortWithRetry(options.session, options, options.model, options.effort),
      options.timeoutMs + 10_000,
    );
    outputResult({ action: "set-combo", session: options.session, model: options.model, effort: options.effort, ...result }, options.json);
  }
}

const entryPath = new URL(import.meta.url).pathname;
if (process.argv[1] && entryPath === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
