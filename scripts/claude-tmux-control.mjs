#!/usr/bin/env node

import process from "node:process";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { withSessionLock } from "./tmux-session-lock.mjs";

const DEFAULTS = {
  session: "cc1",
  bufferLines: 120,
  timeoutMs: 15_000,
  pollMs: 250,
  settleMs: 400,
  json: false,
  includePaneText: false,
};

const MODEL_FAMILY_PATTERNS = {
  opus: /^Opus\b/i,
  sonnet: /^Sonnet\b/i,
  haiku: /^Haiku\b/i,
};

const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);

const MODEL_FAILURE_PATTERNS = [
  /Model '.*' is not available\.[^\n]*/g,
  /Failed to validate model:[^\n]*/g,
  /Your organization restricts model selection\.[^\n]*/g,
  /^Usage: \/model[^\n]*$/gm,
];

const EFFORT_FAILURE_PATTERNS = [
  /has invalid effort '[^']*'/g,
  /^Usage: \/effort[^\n]*$/gm,
];

function usage() {
  console.log(`Usage: node scripts/claude-tmux-control.mjs <command> [options]

Commands:
  status                       print the current Claude pane state
  clear                        send /clear and wait for a fresh prompt
  send                         send a message and wait for response
  type                         type a message without submitting it
  submit                       press Enter and wait for response
  set-model                    send /model <value> and monitor the result
  set-effort                   send /effort <value> and monitor the result
  set-combo                    send /model then /effort with monitoring

Options:
  --session <name>             tmux session name (default: cc1)
  --buffer-lines <n>           capture last N pane lines (default: 120)
  --timeout-ms <n>             monitor timeout in milliseconds (default: 15000)
  --poll-ms <n>                monitor poll interval in milliseconds (default: 250)
  --settle-ms <n>              extra wait after submit before polling (default: 400)
  --model <value>              model alias or model id for set-model/set-combo
  --effort <value>             effort for set-effort/set-combo
  --message <text>             message text for send/type commands
  --json                       emit machine-readable JSON
  --include-pane-text          include raw pane snapshots in JSON output
  --help                       show this help

Examples:
  node scripts/claude-tmux-control.mjs status --session cc1
  node scripts/claude-tmux-control.mjs send --session cc1 --message "Hello Claude"
  node scripts/claude-tmux-control.mjs type --session cc1 --message "Hello Claude"
  node scripts/claude-tmux-control.mjs submit --session cc1
  node scripts/claude-tmux-control.mjs set-model --session cc1 --model opus
  node scripts/claude-tmux-control.mjs set-effort --session cc1 --effort medium
  node scripts/claude-tmux-control.mjs set-combo --session cc1 --model sonnet --effort high
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
    if (arg === "--session") {
      options.session = argv[++i] ?? "";
      continue;
    }
    if (arg === "--buffer-lines") {
      options.bufferLines = Number(argv[++i]);
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[++i]);
      continue;
    }
    if (arg === "--poll-ms") {
      options.pollMs = Number(argv[++i]);
      continue;
    }
    if (arg === "--settle-ms") {
      options.settleMs = Number(argv[++i]);
      continue;
    }
    if (arg === "--model") {
      options.model = argv[++i] ?? "";
      continue;
    }
    if (arg === "--effort") {
      options.effort = argv[++i] ?? "";
      continue;
    }
    if (arg === "--message") {
      options.message = argv[++i] ?? "";
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--include-pane-text") {
      options.includePaneText = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!["status", "clear", "send", "type", "submit", "set-model", "set-effort", "set-combo"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  if (!options.session) {
    throw new Error("--session must be non-empty");
  }
  for (const key of ["bufferLines", "timeoutMs", "pollMs", "settleMs"]) {
    if (!Number.isInteger(options[key]) || options[key] <= 0) {
      throw new Error(`--${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)} must be a positive integer`);
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
  const result = spawnSync(command, args, {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr}`);
  }

  return (result.stdout || "").trimEnd();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[^[\]]/g, "")
    .replace(/\r/g, "");
}

function paneDiagnostics(text) {
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countMatches(text, regex) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  let count = 0;
  while (re.exec(text) !== null) {
    count += 1;
  }
  return count;
}

function matchLast(text, regex) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  let last = null;
  for (const match of text.matchAll(re)) {
    last = match;
  }
  return last;
}

function familyPatternForModel(model) {
  if (!model) return null;
  const lowered = String(model).toLowerCase();
  if (lowered.includes("opus")) return MODEL_FAMILY_PATTERNS.opus;
  if (lowered.includes("sonnet")) return MODEL_FAMILY_PATTERNS.sonnet;
  if (lowered.includes("haiku")) return MODEL_FAMILY_PATTERNS.haiku;
  return null;
}

function supportsVisibleEffort(modelLabel) {
  if (!modelLabel) return false;
  return /^Opus\b/i.test(modelLabel) || /^Sonnet\b/i.test(modelLabel);
}

export function parseFooterState(text) {
  const lines = text.split(/\r?\n/);
  let model = null;
  let effort = null;
  let footerLine = null;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!model) {
      const modelMatch = line.match(/\[([^\]]+)\]\s*│/);
      if (modelMatch) {
        model = modelMatch[1].trim();
      }
    }
    if (!effort && /\/effort\b/.test(line)) {
      const effortMatch = line.match(/\b(low|medium|high|xhigh|max)\b(?=\s*·\s*\/effort)/i);
      if (effortMatch) {
        effort = effortMatch[1].toLowerCase();
        footerLine = line.trim();
      }
    }
    if (model && (effort || footerLine)) break;
  }

  return {
    model,
    effort,
    effortVisible: Boolean(footerLine),
  };
}

function summarizeFailures(text, patterns) {
  const failures = [];
  for (const regex of patterns) {
    const match = matchLast(text, regex);
    if (match?.[0]) {
      failures.push(match[0].trim());
    }
  }
  return failures;
}

function countFailures(text, patterns) {
  return patterns.reduce((sum, regex) => sum + countMatches(text, regex), 0);
}

function commandRegex(commandText) {
  return new RegExp(`^❯\\s+${escapeRegExp(commandText)}$`, "gm");
}

export function buildPaneSnapshot(text, commandText) {
  const footer = parseFooterState(text);
  const lastModelAck = matchLast(text, /Set model to ([^\n]+)/g)?.[1]?.trim() ?? null;
  const lastEffortAck = matchLast(text, /Set effort level to ([^\n]+)/g)?.[1]?.trim() ?? null;
  return {
    text,
    footer,
    commandCount: commandText ? countMatches(text, commandRegex(commandText)) : 0,
    modelAckCount: countMatches(text, /Set model to [^\n]+/g),
    effortAckCount: countMatches(text, /Set effort level to [^\n]+/g),
    modelFailureCount: countFailures(text, MODEL_FAILURE_PATTERNS),
    effortFailureCount: countFailures(text, EFFORT_FAILURE_PATTERNS),
    lastModelAck,
    lastEffortAck,
  };
}

export function analyzeModelCommandProgress(current, baseline, modelValue) {
  if (current.modelFailureCount > baseline.modelFailureCount) {
    return {
      done: true,
      ok: false,
      reason: summarizeFailures(current.text, MODEL_FAILURE_PATTERNS)[0] || "model switch failed",
    };
  }

  if (current.commandCount <= baseline.commandCount) {
    return { done: false, ok: false };
  }

  const familyPattern = familyPatternForModel(modelValue);
  const footerMatches = familyPattern ? familyPattern.test(current.footer.model || "") : false;
  const ackAdvanced = current.modelAckCount > baseline.modelAckCount;

  if (ackAdvanced && (footerMatches || !familyPattern)) {
    return {
      done: true,
      ok: true,
      verification: footerMatches ? ["ack", "footer"] : ["ack"],
    };
  }

  if (!ackAdvanced && footerMatches && current.footer.model !== baseline.footer.model) {
    return {
      done: true,
      ok: true,
      verification: ["footer"],
    };
  }

  if (ackAdvanced) {
    return {
      done: true,
      ok: true,
      verification: ["ack"],
    };
  }

  return { done: false, ok: false };
}

export function analyzeEffortCommandProgress(current, baseline, effortValue, modelLabel) {
  if (current.effortFailureCount > baseline.effortFailureCount) {
    return {
      done: true,
      ok: false,
      reason: summarizeFailures(current.text, EFFORT_FAILURE_PATTERNS)[0] || "effort change failed",
    };
  }

  if (current.commandCount <= baseline.commandCount) {
    return { done: false, ok: false };
  }

  const normalizedEffort = String(effortValue).toLowerCase();
  const visibleFooterExpected = supportsVisibleEffort(modelLabel || current.footer.model || baseline.footer.model);
  const footerMatches = current.footer.effort === normalizedEffort;
  const ackAdvanced = current.effortAckCount > baseline.effortAckCount;

  if (ackAdvanced && (footerMatches || !visibleFooterExpected)) {
    return {
      done: true,
      ok: true,
      verification: footerMatches ? ["ack", "footer"] : ["ack"],
    };
  }

  if (!ackAdvanced && visibleFooterExpected && footerMatches && current.footer.effort !== baseline.footer.effort) {
    return {
      done: true,
      ok: true,
      verification: ["footer"],
    };
  }

  if (ackAdvanced) {
    return {
      done: true,
      ok: true,
      verification: ["ack"],
    };
  }

  return { done: false, ok: false };
}

export function isClaudeBusy(text) {
  // Claude Code can leave old spinner noise in long pane captures.
  // Only inspect the tail where the live status indicators appear.
  const clean = stripAnsi(text);
  const lastLines = clean.split(/\r?\n/).slice(-24).join("\n");
  return /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(lastLines) || /Esc to interrupt/.test(lastLines);
}

export function isClaudeIdle(text) {
  // Claude Code shows the "❯" prompt when waiting for input
  return /^❯\s*$/m.test(text) || /^>\s*$/m.test(text);
}

async function interruptCurrentTask(target, settleMs) {
  run("tmux", ["send-keys", "-t", target, "Escape"]);
  await sleep(Math.max(100, Math.min(settleMs, 400)));
  run("tmux", ["send-keys", "-t", target, "C-c"]);
  await sleep(Math.max(100, Math.min(settleMs, 400)));
  run("tmux", ["send-keys", "-t", target, "Escape"]);
  await sleep(Math.max(150, Math.min(settleMs, 1000)));
}

async function waitForReady(target, options) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    const text = capturePane(target, options.bufferLines);
    if (!isClaudeBusy(text) && isClaudeIdle(text)) {
      return text;
    }
    await sleep(options.pollMs);
  }

  throw new Error("Timed out waiting for Claude to become ready");
}

async function sendMessageToClaude(session, options, message) {
  const target = currentPaneTarget(session);
  const baselineText = await waitForReady(target, options);

  run("tmux", ["send-keys", "-t", target, message]);
  await sleep(300);
  run("tmux", ["send-keys", "-t", target, "Enter"]);
  await sleep(options.settleMs);

  // Wait for busy then idle
  const busyDeadline = Date.now() + 5_000;
  let becameBusy = false;
  while (Date.now() <= busyDeadline) {
    const text = capturePane(target, options.bufferLines);
    if (isClaudeBusy(text)) { becameBusy = true; break; }
    await sleep(options.pollMs);
  }

  if (becameBusy) {
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() <= deadline) {
      const text = capturePane(target, options.bufferLines);
      if (!isClaudeBusy(text) && isClaudeIdle(text)) {
        return { target, baseline: baselineText, output: text, becameBusy: true };
      }
      await sleep(options.pollMs);
    }
    throw new Error("Timed out waiting for Claude to finish responding");
  }

  const finalText = capturePane(target, options.bufferLines);
  return { target, baseline: baselineText, output: finalText, becameBusy: false };
}

async function typeMessageToClaude(session, options, message) {
  const target = currentPaneTarget(session);
  const baselineText = await waitForReady(target, options);

  run("tmux", ["send-keys", "-t", target, message]);
  await sleep(300);

  const finalText = capturePane(target, options.bufferLines);
  return { target, baseline: baselineText, output: finalText, becameBusy: false };
}

async function submitMessageToClaude(session, options) {
  const target = currentPaneTarget(session);
  const baselineText = await waitForReady(target, options);

  run("tmux", ["send-keys", "-t", target, "Enter"]);
  await sleep(options.settleMs);

  // Wait for busy then idle
  const busyDeadline = Date.now() + 5_000;
  let becameBusy = false;
  while (Date.now() <= busyDeadline) {
    const text = capturePane(target, options.bufferLines);
    if (isClaudeBusy(text)) { becameBusy = true; break; }
    await sleep(options.pollMs);
  }

  if (becameBusy) {
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() <= deadline) {
      const text = capturePane(target, options.bufferLines);
      if (!isClaudeBusy(text) && isClaudeIdle(text)) {
        return { target, baseline: baselineText, output: text, becameBusy: true };
      }
      await sleep(options.pollMs);
    }
    throw new Error("Timed out waiting for Claude to finish responding");
  }

  const finalText = capturePane(target, options.bufferLines);
  return { target, baseline: baselineText, output: finalText, becameBusy: false };
}

async function clearConversation(session, options) {
  const target = currentPaneTarget(session);
  const initialText = capturePane(target, options.bufferLines);
  if (isClaudeBusy(initialText) || !isClaudeIdle(initialText)) {
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
    if (!isClaudeBusy(text) && isClaudeIdle(text)) {
      return { target, baseline: baselineText, output: text, becameBusy: true };
    }
    await sleep(options.pollMs);
  }

  throw new Error("Timed out waiting for Claude to finish /clear");
}

function currentPaneTarget(session) {
  return run("tmux", ["display-message", "-p", "-t", session, "#{session_name}:#{window_index}.#{pane_index}"]);
}

function capturePane(target, bufferLines) {
  return run("tmux", ["capture-pane", "-pt", target, "-S", `-${bufferLines}`]);
}

async function sendSlashCommand(target, commandText) {
  run("tmux", ["send-keys", "-t", target, "C-u"]);
  await sleep(200);
  run("tmux", ["send-keys", "-t", target, commandText]);
  await sleep(300);
  run("tmux", ["send-keys", "-t", target, "Enter"]);
}

async function monitorUntil({ target, bufferLines, timeoutMs, pollMs, settleMs, commandText, analyze }) {
  const baselineText = capturePane(target, bufferLines);
  const baseline = buildPaneSnapshot(baselineText, commandText);

  await sendSlashCommand(target, commandText);
  await sleep(settleMs);

  const deadline = Date.now() + timeoutMs;
  let last = baseline;

  while (Date.now() <= deadline) {
    const text = capturePane(target, bufferLines);
    const current = buildPaneSnapshot(text, commandText);
    last = current;
    const progress = analyze(current, baseline);
    if (progress.done) {
      if (!progress.ok) {
        throw new Error(progress.reason);
      }
      return {
        target,
        commandText,
        verification: progress.verification,
        footer: current.footer,
        lastModelAck: current.lastModelAck,
        lastEffortAck: current.lastEffortAck,
      };
    }
    await sleep(pollMs);
  }

  throw new Error(
    `Timed out waiting for ${commandText}. Last footer: ${last.footer.model || "unknown"} / ${last.footer.effort || "n/a"}`,
  );
}

async function runSetModel(session, options) {
  const target = currentPaneTarget(session);
  const commandText = `/model ${options.model}`;
  const result = await monitorUntil({
    target,
    bufferLines: options.bufferLines,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
      settleMs: options.settleMs,
      commandText,
      analyze: (current, baseline) => analyzeModelCommandProgress(current, baseline, options.model),
    });
  return {
    action: "set-model",
    session,
    model: options.model,
    ...result,
  };
}

async function runSetEffort(session, options, overrideModelLabel = null) {
  const target = currentPaneTarget(session);
  const commandText = `/effort ${String(options.effort).toLowerCase()}`;
  const baselineFooter = parseFooterState(capturePane(target, options.bufferLines));
  const result = await monitorUntil({
    target,
    bufferLines: options.bufferLines,
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
    settleMs: options.settleMs,
    commandText,
    analyze: (current, baseline) => analyzeEffortCommandProgress(
      current,
      baseline,
      options.effort,
      overrideModelLabel || baselineFooter.model,
    ),
  });
  return {
    action: "set-effort",
    session,
    effort: String(options.effort).toLowerCase(),
    ...result,
  };
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
    console.log(`Model ack:     ${result.lastModelAck || "n/a"}`);
    console.log(`Effort ack:    ${result.lastEffortAck || "n/a"}`);
    return;
  }

  if (result.action === "send") {
    console.log(`Action:        ${result.action}`);
    console.log(`Session:       ${result.session}`);
    console.log(`Target pane:   ${result.target}`);
    console.log(`Message:       ${result.message}`);
    console.log(`Became busy:   ${result.becameBusy}`);
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

  console.log(`Action:        ${result.action}`);
  console.log(`Session:       ${result.session}`);
  console.log(`Target pane:   ${result.target}`);
  if (result.model) {
    console.log(`Requested model: ${result.model}`);
  }
  if (result.effort) {
    console.log(`Requested effort: ${result.effort}`);
  }
  console.log(`Model:         ${result.footer.model || "unknown"}`);
  console.log(`Effort:        ${result.footer.effort || "not visible"}`);
  console.log(`Verification:  ${Array.from(new Set(result.verification)).join(", ")}`);
  if (result.lastModelAck) {
    console.log(`Model ack:     ${result.lastModelAck}`);
  }
  if (result.lastEffortAck) {
    console.log(`Effort ack:    ${result.lastEffortAck}`);
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "status") {
    const target = currentPaneTarget(options.session);
    const text = capturePane(target, options.bufferLines);
    const snapshot = buildPaneSnapshot(text, "");
    outputResult({
      action: "status",
      session: options.session,
      target,
      footer: snapshot.footer,
      lastModelAck: snapshot.lastModelAck,
      lastEffortAck: snapshot.lastEffortAck,
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
      async () => sendMessageToClaude(options.session, options, options.message),
      options.timeoutMs + 10_000,
    );
    const payload = { action: "send", session: options.session, message: options.message, ...result };
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
      async () => typeMessageToClaude(options.session, options, options.message),
      options.timeoutMs + 10_000,
    );
    const payload = { action: "type", session: options.session, message: options.message, ...result };
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
      async () => submitMessageToClaude(options.session, options),
      options.timeoutMs + 10_000,
    );
    const payload = { action: "submit", session: options.session, ...result };
    if (options.json && !options.includePaneText) {
      delete payload.baseline;
      delete payload.output;
    }
    outputResult(payload, options.json);
    return;
  }

  if (command === "set-model") {
    outputResult(
      await withSessionLock(
        options.session,
        async () => runSetModel(options.session, options),
        options.timeoutMs + 10_000,
      ),
      options.json,
    );
    return;
  }

  if (command === "set-effort") {
    outputResult(
      await withSessionLock(
        options.session,
        async () => runSetEffort(options.session, options),
        options.timeoutMs + 10_000,
      ),
      options.json,
    );
    return;
  }

  if (command === "set-combo") {
    const comboResult = await withSessionLock(options.session, async () => {
      const modelResult = await runSetModel(options.session, options);
      const effortResult = await runSetEffort(options.session, options, modelResult.footer.model);
      return {
        action: "set-combo",
        session: options.session,
        target: effortResult.target,
        model: options.model,
        effort: String(options.effort).toLowerCase(),
        verification: Array.from(new Set([...modelResult.verification, ...effortResult.verification])),
        footer: effortResult.footer,
        lastModelAck: effortResult.lastModelAck,
        lastEffortAck: effortResult.lastEffortAck,
      };
    }, options.timeoutMs + 10_000);
    outputResult({
      ...comboResult,
    }, options.json);
  }
}

const entryPath = new URL(import.meta.url).pathname;
if (process.argv[1] && entryPath === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
