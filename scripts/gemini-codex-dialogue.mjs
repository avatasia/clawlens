#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

import {
  extractResponse as extractGeminiResponse,
  extractResponseMeta as extractGeminiResponseMeta,
  formatHumanMethodLabel,
  isBusy as isGeminiBusy,
  isPromptReady as isGeminiPromptReady,
} from "./gemini-tmux-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  geminiSession: "gemini1",
  codexSession: "codex",
  turns: 4,
  timeoutMs: 120_000,
  retries: 2,
  retryDelayMs: 1_500,
  bufferLines: 2000,
  maxMsgLen: 3000,
  firstSpeaker: "gemini",
  pollMs: 300,
  settleMs: 600,
  clearFirst: false,
  checkpointFile: null,
  resumeFrom: null,
  decisionMode: false,
  decisionModel: "gpt-5.4",
  decisionEffort: "high",
  progress: true,
  progressIntervalMs: 1_000,
};

const DEFAULT_DECISION_ESCALATION = {
  model: "gpt-5.4",
  effort: "high",
};

export function assertDistinctBridgeSessions(geminiSession, codexSession) {
  if (String(geminiSession || "").trim() === String(codexSession || "").trim()) {
    throw new Error(
      `Gemini and Codex sessions must be different to avoid self-routing (${geminiSession}). ` +
      "Use separate tmux sessions for bridge traffic.",
    );
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(command + " " + args.join(" ") + " failed: " + stderr);
  }
  return (result.stdout || "").trimEnd();
}

function runJson(command, args) {
  return JSON.parse(run(command, args));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function defaultCheckpointFile() {
  return path.join(os.tmpdir(), "clawlens-dialogue-checkpoints", `gemini-codex-${timestampSlug()}.json`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function currentPaneTarget(session) {
  return run("tmux", ["display-message", "-p", "-t", session, "#{session_name}:#{window_index}.#{pane_index}"]);
}

async function pauseCodexTask(session, settleMs) {
  const target = currentPaneTarget(session);
  run("tmux", ["send-keys", "-t", target, "Escape"]);
  await sleep(Math.max(150, Math.min(settleMs, 1000)));
}

export function buildDecisionModeWorkerSource({
  nodePath,
  codexScript,
  geminiScript,
  codexSession,
  geminiSession,
  checkpointFile,
  logPath,
  runnerPath,
  model,
  effort,
  resumeMessage,
  timeoutMs,
  pollMs,
  settleMs,
}) {
  assertDistinctBridgeSessions(geminiSession, codexSession);
  const envBlock = {
    CLAWLENS_CHECKPOINT_FILE: checkpointFile,
    CLAWLENS_DECISION_MODEL: model,
    CLAWLENS_DECISION_EFFORT: effort,
  };
  return [
    "#!/usr/bin/env node",
    'import fs from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    "",
    `const NODE_PATH = ${JSON.stringify(nodePath)};`,
    `const CODEX_SCRIPT = ${JSON.stringify(codexScript)};`,
    `const GEMINI_SCRIPT = ${JSON.stringify(geminiScript)};`,
    `const CODEX_SESSION = ${JSON.stringify(codexSession)};`,
    `const GEMINI_SESSION = ${JSON.stringify(geminiSession)};`,
    `const CHECKPOINT_FILE = ${JSON.stringify(checkpointFile)};`,
    `const LOG_PATH = ${JSON.stringify(logPath)};`,
    `const RUNNER_PATH = ${JSON.stringify(runnerPath)};`,
    `const MODEL = ${JSON.stringify(model)};`,
    `const EFFORT = ${JSON.stringify(effort)};`,
    `const RESUME_MESSAGE = ${JSON.stringify(resumeMessage)};`,
    `const TIMEOUT_MS = ${JSON.stringify(timeoutMs ?? 120_000)};`,
    `const POLL_MS = ${JSON.stringify(pollMs ?? 300)};`,
    `const SETTLE_MS = ${JSON.stringify(settleMs ?? 600)};`,
    `const ENV_BLOCK = ${JSON.stringify(envBlock)};`,
    "",
    "function log(line) {",
    '  fs.appendFileSync(LOG_PATH, "[" + new Date().toISOString() + "] " + line + "\\n", "utf8");',
    "}",
    "",
    "function run(command, args) {",
    '  const result = spawnSync(command, args, { encoding: "utf8" });',
    "  if (result.status !== 0) {",
    '    const stderr = (result.stderr || result.stdout || "").trim();',
    '    throw new Error(command + " " + args.join(" ") + " failed: " + stderr);',
    "  }",
    '  return (result.stdout || "").trimEnd();',
    "}",
    "",
    "function patchCheckpoint() {",
    '  const state = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));',
    "  const now = new Date().toISOString();",
    '  state.status = "running";',
    "  state.updatedAt = now;",
    "  state.decisionMode = {",
    "    ...(state.decisionMode || {}),",
    "    applied: true,",
    "    pending: false,",
    "    requested: { model: MODEL, effort: EFFORT },",
    "    confirmed: { model: MODEL, effort: EFFORT },",
    "    current: { model: MODEL, effort: EFFORT },",
    '    geminiReply: "CONTINUE",',
    '    geminiAction: "continue",',
    "    verified: true,",
    '    resumeSignal: "CONTINUE",',
    "    updatedAt: now,",
    "  };",
    '  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(state, null, 2) + "\\n", "utf8");',
    "}",
    "",
    "try {",
    '  log("worker start target=" + MODEL + " " + EFFORT);',
    '  log("runner=" + RUNNER_PATH);',
    '  log("env=" + JSON.stringify(ENV_BLOCK));',
    '  run(NODE_PATH, [CODEX_SCRIPT, "set-combo", "--session", CODEX_SESSION, "--model", MODEL, "--effort", EFFORT, "--timeout-ms", String(TIMEOUT_MS), "--poll-ms", String(POLL_MS), "--settle-ms", String(SETTLE_MS), "--json"]);',
    '  log("codex set-combo complete");',
    '  run(NODE_PATH, [GEMINI_SCRIPT, "send", "--session", GEMINI_SESSION, "--message", RESUME_MESSAGE, "--timeout-ms", String(TIMEOUT_MS), "--poll-ms", String(POLL_MS), "--settle-ms", String(SETTLE_MS), "--json"]);',
    '  log("gemini resume sent");',
    "  patchCheckpoint();",
    '  log("checkpoint patched");',
    "  fs.unlinkSync(RUNNER_PATH);",
    '  log("runner removed");',
    "} catch (error) {",
    '  log("worker failed: " + (error instanceof Error ? error.message : String(error)));',
    "  process.exit(1);",
    "}",
    "",
  ].join("\n");
}

export function scheduleDecisionModeWorker(details) {
  assertDistinctBridgeSessions(details?.geminiSession, details?.codexSession);
  const workerDir = path.join(os.tmpdir(), "clawlens-decision-mode");
  fs.mkdirSync(workerDir, { recursive: true });
  const stamp = timestampSlug();
  const runnerPath = path.join(workerDir, `resume-${stamp}.mjs`);
  const logPath = path.join(workerDir, `resume-${stamp}.log`);
  const source = buildDecisionModeWorkerSource({ ...details, logPath, runnerPath });
  fs.writeFileSync(runnerPath, source, "utf8");
  fs.chmodSync(runnerPath, 0o755);
  const child = spawn(process.execPath, [runnerPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { runnerPath, logPath };
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[^[\]]/g, "")
    .replace(/\r/g, "");
}

function isCodexDivider(line) {
  return /^[─]+$/.test(line.trim());
}

function normalizeInlineWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

// Strip left-column decoration (box borders, left-bar markers) so prompt
// detection still works when Codex renders the input inside a bordered box
// like "│ › ..." or with a selection-bar prefix like "▌› ...".
const INPUT_DECORATION_RE = /^[\s│┃┆┇┊┋▌▍▎▏▐▕│]+/;

function stripInputDecoration(line) {
  return String(line || "").replace(INPUT_DECORATION_RE, "");
}

function lineStartsWithPrompt(line) {
  const stripped = stripInputDecoration(line).trimStart();
  return stripped.startsWith("›");
}

function findCodexInputBlock(lines, sentMessage) {
  const normalizedMessage = normalizeInlineWhitespace(sentMessage);
  const anchor = normalizedMessage.slice(0, 80);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lineStartsWithPrompt(lines[i])) continue;

    const firstLine = stripInputDecoration(lines[i]).replace(/^\s*›\s?/, "");
    const block = [firstLine];
    let j = i + 1;
    while (j < lines.length) {
      const raw = lines[j];
      const trimmed = raw.trim();
      if (trimmed === "") break;
      if (raw.trimStart().startsWith("•")) break;
      if (lineStartsWithPrompt(raw)) break;
      if (isCodexDivider(raw)) break;
      if (/gpt-[^·]+\s+(?:low|medium|high|xhigh|max)\s+·/.test(trimmed)) break;
      block.push(stripInputDecoration(raw).trim());
      j += 1;
    }

    const blockText = normalizeInlineWhitespace(block.join(" "));
    if (blockText.includes(anchor) || anchor.includes(blockText.slice(0, Math.min(blockText.length, 40)))) {
      return { start: i, end: j };
    }
  }

  return null;
}

export { findCodexInputBlock, stripInputDecoration, lineStartsWithPrompt };

export function extractCodexResponseMeta(baselineRaw, finalRaw, sentMessage) {
  const baselineLines = stripAnsi(baselineRaw).split("\n");
  const lines = stripAnsi(finalRaw).split("\n");
  const inputBlock = findCodexInputBlock(lines, sentMessage);
  let method = inputBlock ? "input_block" : "tail_fallback";
  let startIdx = inputBlock ? inputBlock.end : -1;

  if (startIdx < 0) {
    const fingerprint = baselineLines
      .map((line) => line.trim())
      .filter((line) =>
        line !== "" &&
        !line.startsWith("›") &&
        !line.startsWith("• Working") &&
        !isCodexDivider(line) &&
        !/gpt-[^·]+\s+(?:low|medium|high|xhigh|max)\s+·/.test(line)
      )
      .slice(-5);

    if (fingerprint.length > 0) {
      const trimmedFinal = lines.map((line) => line.trim());
      outer:
      for (let i = lines.length - fingerprint.length; i >= 0; i -= 1) {
        for (let j = 0; j < fingerprint.length; j += 1) {
          if (trimmedFinal[i + j] !== fingerprint[j]) continue outer;
        }
        startIdx = i + fingerprint.length;
        method = "baseline_fingerprint";
        break;
      }
    }
  }

  if (startIdx < 0) {
    startIdx = Math.max(0, lines.length - 60);
    method = "tail_fallback";
  }
  const after = lines.slice(startIdx);

  let end = after.length;
  for (let i = after.length - 1; i >= 0; i -= 1) {
    const raw = after[i];
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (/·/.test(trimmed)) { end = i; continue; }
    if (raw.trimStart().startsWith("›")) { end = i; continue; }
    if (/^•\s+Working\b/.test(trimmed)) { end = i; continue; }
    break;
  }

  return {
    method,
    text: after.slice(0, end).join("\n").trim(),
  };
}

export function extractCodexResponse(baselineRaw, finalRaw, sentMessage) {
  return extractCodexResponseMeta(baselineRaw, finalRaw, sentMessage).text;
}

function extractResponseMeta(baselineRaw, finalRaw, role, sentMessage) {
  if (role === "gemini") return extractGeminiResponseMeta(baselineRaw, finalRaw, sentMessage);
  return extractCodexResponseMeta(baselineRaw, finalRaw, sentMessage);
}

async function clearSession(scriptPath, role, session, opts) {
  const result = await callControl(scriptPath, "clear", session, opts);
  if (!result || result.action !== "clear") {
    throw new Error(`Unexpected ${role} clear response from ${path.basename(scriptPath)}`);
  }
  return true;
}

function buildSendArgs(scriptPath, session, message, opts) {
  const includePaneText = !path.basename(scriptPath).startsWith("gemini");
  return [
    scriptPath,
    "send",
    "--session", session,
    "--message", message,
    "--buffer-lines", String(opts.bufferLines),
    "--timeout-ms", String(opts.timeoutMs),
    "--poll-ms", String(opts.pollMs),
    "--settle-ms", String(opts.settleMs),
    "--json",
    ...(includePaneText ? ["--include-pane-text"] : []),
  ];
}

function buildControlArgs(scriptPath, command, session, opts) {
  return [
    scriptPath,
    command,
    "--session", session,
    "--buffer-lines", String(opts.bufferLines),
    "--timeout-ms", String(opts.timeoutMs),
    "--poll-ms", String(opts.pollMs),
    "--settle-ms", String(opts.settleMs),
    "--json",
  ];
}

export function formatProgressStatus(role, attempt, retries, elapsedMs) {
  const frames = ["·  ", "·· ", "···", " ··", "  ·"];
  const frame = frames[Math.floor(elapsedMs / 400) % frames.length];
  const elapsedSeconds = (elapsedMs / 1000).toFixed(elapsedMs >= 10_000 ? 0 : 1);
  return `${frame} ${role.toUpperCase()} attempt ${attempt}/${retries} waiting ${elapsedSeconds}s`;
}

async function callSend(scriptPath, session, message, opts, progressMeta = null) {
  const args = buildSendArgs(scriptPath, session, message, opts);

  return new Promise((resolve, reject) => {
    const child = spawn("node", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    const start = Date.now();
    let lastReportedSecond = -1;

    const stopProgress = () => {
      if (progressTimer) clearInterval(progressTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (opts.progress && progressMeta && process.stdout.isTTY) {
        process.stdout.write("\r\x1b[K");
      }
    };

    const progressTimer = opts.progress && progressMeta ? setInterval(() => {
      const elapsedMs = Date.now() - start;
      if (process.stdout.isTTY) {
        process.stdout.write(`\r${formatProgressStatus(progressMeta.role, progressMeta.attempt, progressMeta.retries, elapsedMs)}`);
        return;
      }

      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      if (elapsedSeconds > lastReportedSecond) {
        lastReportedSecond = elapsedSeconds;
        process.stdout.write(`[wait ${progressMeta.role} ${progressMeta.attempt}/${progressMeta.retries} ${elapsedSeconds}s] `);
      }
    }, opts.progressIntervalMs) : null;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, opts.timeoutMs + 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      stopProgress();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      stopProgress();
      if (timedOut) {
        reject(new Error(`send failed (${path.basename(scriptPath)}): timed out after ${opts.timeoutMs + 30_000}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`send failed (${path.basename(scriptPath)}): ${(stderr || stdout).slice(0, 400)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function callControl(scriptPath, command, session, opts) {
  const args = buildControlArgs(scriptPath, command, session, opts);

  return new Promise((resolve, reject) => {
    const child = spawn("node", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer = null;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, opts.timeoutMs + 30_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`control failed (${path.basename(scriptPath)} ${command}): timed out after ${opts.timeoutMs + 30_000}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`control failed (${path.basename(scriptPath)} ${command}): ${(stderr || stdout).slice(0, 400)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function isRetryableSendError(message) {
  return /timed out/i.test(message) || /send failed/i.test(message);
}

async function callSendWithRetry(scriptPath, session, message, opts) {
  let lastError = null;

  for (let attempt = 1; attempt <= opts.retries; attempt += 1) {
    try {
      return await callSend(scriptPath, session, message, opts, {
        role: path.basename(scriptPath).startsWith("gemini") ? "gemini" : "codex",
        attempt,
        retries: opts.retries,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= opts.retries || !isRetryableSendError(String(error?.message || error))) {
        throw error;
      }
      process.stdout.write(`retry ${attempt + 1}/${opts.retries} … `);
      await sleep(opts.retryDelayMs);
    }
  }

  throw lastError;
}

function hr(char = "─", width = 64) {
  return char.repeat(width);
}

function writeCheckpoint(checkpointFile, state) {
  fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
  fs.writeFileSync(checkpointFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function readCheckpoint(checkpointFile) {
  return JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
}

export function createCheckpointState(topic, opts, checkpointFile) {
  return {
    version: 1,
    topic,
    checkpointFile,
    totalTurns: opts.turns,
    nextTurn: 1,
    currentRole: opts.firstSpeaker,
    currentMessage: topic,
    history: [],
    sessions: {
      gemini: opts.geminiSession,
      codex: opts.codexSession,
    },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    decisionMode: null,
  };
}

export function advanceCheckpointState(state, turnRecord, nextRole, nextMessage) {
  return {
    ...state,
    history: [...state.history, turnRecord],
    nextTurn: turnRecord.turn + 1,
    currentRole: nextRole,
    currentMessage: nextMessage,
    updatedAt: new Date().toISOString(),
  };
}

function markCheckpointFailure(state, error, failedTurn) {
  return {
    ...state,
    failedTurn,
    updatedAt: new Date().toISOString(),
    status: "failed",
    error: String(error instanceof Error ? error.message : error),
  };
}

function markCheckpointComplete(state) {
  return {
    ...state,
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "completed",
  };
}

export function buildDecisionEscalationPrompt(currentFooter, targetModel, targetEffort, codexBusy = false) {
  const currentModel = currentFooter?.model || "unknown";
  const currentEffort = currentFooter?.effort || "n/a";
  return [
    "Decision mode preflight.",
    `Current Codex combo: ${currentModel} ${currentEffort}.`,
    `Proposed target combo: ${targetModel} ${targetEffort}.`,
    `Codex busy: ${codexBusy ? "yes" : "no"}.`,
    "Confirm intent or reply WAIT if Codex is busy.",
    "Reply with exactly one line:",
    "OK",
    "or:",
    `ADJUST model=<model> effort=<effort>`,
    "If you are resuming after a pause, reply CONTINUE.",
    "Use WAIT if Codex is busy; I will ask again after it becomes idle.",
    "Only use ADJUST if a different Codex combo is materially better for the decision pass.",
  ].join("\n");
}

export function parseDecisionEscalationReply(text) {
  const clean = String(text || "").trim();
  const adjustMatch = clean.match(/ADJUST\s+model=([^\s]+)\s+effort=([^\s]+)/i);
  if (adjustMatch) {
    return {
      action: "adjust",
      model: adjustMatch[1].trim().replace(/[。.!?,;，。]+$/g, ""),
      effort: adjustMatch[2].toLowerCase().replace(/[。.!?,;，。]+$/g, ""),
      raw: clean,
    };
  }
  if (/^WAIT(?:$|[\s。.!?,;，])/i.test(clean)) {
    return { action: "wait", raw: clean };
  }
  if (/^CONTINUE(?:$|[\s。.!?,;，])/i.test(clean)) {
    return { action: "continue", raw: clean };
  }
  if (/^(OK|YES|APPROVE|可接受|接受|没问题|同意|继续|可以|行)(?:$|[\s。.!?,;，])/i.test(clean)) {
    return { action: "ok", raw: clean };
  }
  return { action: "unknown", raw: clean };
}

export function resolveDecisionEscalationTarget(parsedReply, defaultTarget) {
  if (parsedReply?.action === "adjust") {
    return {
      model: parsedReply.model,
      effort: parsedReply.effort,
    };
  }
  if (parsedReply?.action === "ok" || parsedReply?.action === "unknown" || parsedReply?.action === "continue") {
    return defaultTarget;
  }
  return null;
}

export function shouldEscalateDecisionModel(currentFooter, targetModel, targetEffort) {
  return currentFooter?.model !== targetModel || currentFooter?.effort !== targetEffort;
}

export function markDecisionModeApplied(state, info) {
  return {
    ...state,
    decisionMode: {
      applied: true,
      requested: info.requested,
      confirmed: info.confirmed,
      current: info.current,
      geminiReply: info.geminiReply,
      geminiAction: info.geminiAction,
      preflightAttempts: info.preflightAttempts,
      waitedForIdle: Boolean(info.waitedForIdle),
      verified: Boolean(info.verified),
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}

export function markDecisionModePaused(state, info) {
  return {
    ...state,
    status: "paused",
    decisionMode: {
      applied: false,
      pending: true,
      requested: info.requested,
      confirmed: info.confirmed,
      current: info.current,
      geminiReply: info.geminiReply,
      geminiAction: info.geminiAction,
      preflightAttempts: info.preflightAttempts,
      waitedForIdle: Boolean(info.waitedForIdle),
      verified: false,
      resumeSignal: info.resumeSignal || "CONTINUE",
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}

export function computeTurnHealth(responseMeta, forwarded) {
  if (forwarded.length < responseMeta.text.length) return "THREAD_FRAYED";
  if (responseMeta.method === "tail_fallback") return "THREAD_FRAYED";
  if (responseMeta.method === "baseline_fingerprint") return "THREAD_STRETCHED";
  return "THREAD_STABLE";
}

export function assertForwardingSafe(responseMeta) {
  if (responseMeta.method === "tail_fallback") {
    throw new Error(`THREAD_FRAYED: extraction fell back to tail capture; aborting instead of forwarding uncertain context`);
  }
}

export function summarizeDialogueHealth(history) {
  const summary = {
    THREAD_STABLE: 0,
    THREAD_STRETCHED: 0,
    THREAD_FRAYED: 0,
  };
  for (const turn of history) {
    if (summary[turn.health] !== undefined) summary[turn.health] += 1;
  }
  return summary;
}

function normalizeForForwarding(text) {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function prepareForwardingText(text, maxLen) {
  const normalized = normalizeForForwarding(text);
  if (normalized.length <= maxLen) return normalized;

  const minCut = Math.max(20, Math.floor(maxLen * 0.4));
  const window = normalized.slice(0, maxLen);
  const candidates = [
    window.lastIndexOf("\n\n"),
    window.lastIndexOf("\n"),
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
  ].filter((index) => index >= minCut);

  const cutIdx = candidates.length > 0 ? Math.max(...candidates) : maxLen;
  const body = normalized.slice(0, cutIdx).trimEnd();
  return `${body}\n\n[... truncated at ${maxLen} chars]`;
}

function printTurn(turn, total, speaker, sent, responseMeta, forwarded) {
  const health = computeTurnHealth(responseMeta, forwarded);
  console.log(`\n${hr()}`);
  console.log(`Turn ${turn}/${total}  →  ${speaker.toUpperCase()}`);
  console.log(hr("·"));
  console.log(`Method: ${formatHumanMethodLabel(responseMeta.method)}`);
  console.log(`Captured: ${responseMeta.text.length} chars`);
  console.log(`Health: ${health}`);
  if (forwarded.length < responseMeta.text.length) {
    console.log(`Warning: forwarded=${forwarded.length} < captured=${responseMeta.text.length}`);
  }
  const preview = sent.slice(0, 160) + (sent.length > 160 ? " [...]" : "");
  console.log(`SENT:\n${preview}`);
  console.log(hr("·"));
  console.log(`${speaker.toUpperCase()} RESPONDS:\n${forwarded}`);
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  let topic = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--topic") { topic = argv[++i]; continue; }
    if (arg === "--turns") { opts.turns = Number(argv[++i]); continue; }
    if (arg === "--gemini-session") { opts.geminiSession = argv[++i]; continue; }
    if (arg === "--codex-session") { opts.codexSession = argv[++i]; continue; }
    if (arg === "--timeout-ms") { opts.timeoutMs = Number(argv[++i]); continue; }
    if (arg === "--retries") { opts.retries = Number(argv[++i]); continue; }
    if (arg === "--retry-delay-ms") { opts.retryDelayMs = Number(argv[++i]); continue; }
    if (arg === "--buffer-lines") { opts.bufferLines = Number(argv[++i]); continue; }
    if (arg === "--max-msg-len") { opts.maxMsgLen = Number(argv[++i]); continue; }
    if (arg === "--poll-ms") { opts.pollMs = Number(argv[++i]); continue; }
    if (arg === "--settle-ms") { opts.settleMs = Number(argv[++i]); continue; }
    if (arg === "--first-speaker") { opts.firstSpeaker = argv[++i]; continue; }
    if (arg === "--checkpoint-file") { opts.checkpointFile = argv[++i] ?? null; continue; }
    if (arg === "--resume-from") { opts.resumeFrom = argv[++i] ?? null; continue; }
    if (arg === "--decision-mode") { opts.decisionMode = true; continue; }
    if (arg === "--decision-model") { opts.decisionModel = argv[++i] ?? ""; continue; }
    if (arg === "--decision-effort") { opts.decisionEffort = argv[++i] ?? ""; continue; }
    if (arg === "--progress-interval-ms") { opts.progressIntervalMs = Number(argv[++i]); continue; }
    if (arg === "--no-progress") { opts.progress = false; continue; }
    if (arg === "--clear-first") { opts.clearFirst = true; continue; }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/gemini-codex-dialogue.mjs --topic "..." [options]

Options:
  --topic <text>            Opening topic / first message (required)
  --resume-from <path>      Resume from a saved checkpoint file
  --turns <n>               Total turns (default: ${DEFAULTS.turns})
  --first-speaker <role>    "gemini" or "codex" (default: ${DEFAULTS.firstSpeaker})
  --gemini-session <name>   tmux session for Gemini CLI (default: ${DEFAULTS.geminiSession})
  --codex-session <name>    tmux session for Codex (default: ${DEFAULTS.codexSession})
  --timeout-ms <n>          Per-turn timeout ms (default: ${DEFAULTS.timeoutMs})
  --retries <n>             Send attempts per turn (default: ${DEFAULTS.retries})
  --retry-delay-ms <n>      Delay between retries ms (default: ${DEFAULTS.retryDelayMs})
  --buffer-lines <n>        Pane capture lines (default: ${DEFAULTS.bufferLines})
  --max-msg-len <n>         Max chars forwarded to next AI (default: ${DEFAULTS.maxMsgLen})
  --poll-ms <n>             Poll interval ms (default: ${DEFAULTS.pollMs})
  --settle-ms <n>           Post-submit settle ms (default: ${DEFAULTS.settleMs})
  --checkpoint-file <path>  Write run state to this checkpoint file
  --decision-mode           upgrade Codex to a stronger combo before turn 1
  --decision-model <name>    target Codex model for decision mode (default: ${DEFAULT_DECISION_ESCALATION.model})
  --decision-effort <lvl>   target Codex effort for decision mode (default: ${DEFAULT_DECISION_ESCALATION.effort})
  --progress-interval-ms <n> Progress update interval ms (default: ${DEFAULTS.progressIntervalMs})
  --no-progress             Disable live wait updates
  --clear-first             send /clear to both sessions before starting
`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!topic && !opts.resumeFrom) throw new Error("--topic is required unless --resume-from is provided");
  if (!["gemini", "codex"].includes(opts.firstSpeaker)) {
    throw new Error('--first-speaker must be "gemini" or "codex"');
  }
  if (opts.decisionEffort && !["low", "medium", "high", "xhigh", "max"].includes(String(opts.decisionEffort).toLowerCase())) {
    throw new Error(`Unsupported decision effort: ${opts.decisionEffort}`);
  }
  if (!Number.isInteger(opts.progressIntervalMs) || opts.progressIntervalMs <= 0) {
    throw new Error("--progress-interval-ms must be a positive integer");
  }

  return { topic, opts };
}

function main() {
  return mainAsync();
}

async function mainAsync() {
  const { topic, opts } = parseArgs(process.argv.slice(2));
  assertDistinctBridgeSessions(opts.geminiSession, opts.codexSession);

  const geminiScript = path.join(__dirname, "gemini-tmux-control.mjs");
  const codexScript = path.join(__dirname, "codex-tmux-control.mjs");

  console.log(`\n${"═".repeat(64)}`);
  console.log(` GEMINI ↔ CODEX DIALOGUE   (${opts.turns} turns, first: ${opts.firstSpeaker})`);
  console.log(` Topic: ${(topic ?? "[resume]").slice(0, 80)}`);
  console.log(`${"═".repeat(64)}`);

  const checkpointFile = opts.resumeFrom ?? opts.checkpointFile ?? defaultCheckpointFile();
  let checkpointState = opts.resumeFrom
    ? readCheckpoint(opts.resumeFrom)
    : createCheckpointState(topic, opts, checkpointFile);
  checkpointState = {
    ...checkpointState,
    checkpointFile,
    totalTurns: opts.turns,
    sessions: {
      gemini: opts.geminiSession,
      codex: opts.codexSession,
    },
    status: "running",
    updatedAt: new Date().toISOString(),
  };
  writeCheckpoint(checkpointFile, checkpointState);
  console.log(` Checkpoint: ${checkpointFile}`);

  if (opts.clearFirst) {
    process.stdout.write(`\n[setup] clearing GEMINI and CODEX sessions … `);
    await clearSession(geminiScript, "gemini", opts.geminiSession, opts);
    await clearSession(codexScript, "codex", opts.codexSession, opts);
    process.stdout.write(`done\n`);
  }

  if (opts.decisionMode) {
    const decisionTarget = {
      model: opts.decisionModel || DEFAULT_DECISION_ESCALATION.model,
      effort: String(opts.decisionEffort || DEFAULT_DECISION_ESCALATION.effort).toLowerCase(),
    };
    const existingDecision = checkpointState.decisionMode;
    const decisionAlreadyApplied =
      existingDecision?.applied &&
      existingDecision?.confirmed?.model === decisionTarget.model &&
      existingDecision?.confirmed?.effort === decisionTarget.effort;

    if (decisionAlreadyApplied) {
      process.stdout.write(`\n[decision-mode] checkpoint already records ${decisionTarget.model} ${decisionTarget.effort}; skipping preflight\n`);
    } else {
      const codexStatus = runJson("node", [
        codexScript,
        "status",
        "--session", opts.codexSession,
        "--json",
      ]);
      let currentFooter = codexStatus.footer || { model: null, effort: null };
      let needsUpgrade = shouldEscalateDecisionModel(currentFooter, decisionTarget.model, decisionTarget.effort);
      let parsedReply = null;
      let confirmedTarget = decisionTarget;
      let preflightAttempts = 0;
      let scheduleUpgrade = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        preflightAttempts = attempt;
        const codexStatus = runJson("node", [
          codexScript,
          "status",
          "--session", opts.codexSession,
          "--json",
        ]);
        const currentFooter = codexStatus.footer || { model: null, effort: null };
        const codexBusy = Boolean(codexStatus.busy);
        const preflightMessage = buildDecisionEscalationPrompt(
          currentFooter,
          decisionTarget.model,
          decisionTarget.effort,
          codexBusy,
        );

        process.stdout.write(`\n[decision-mode] asking GEMINI to confirm Codex target … `);
        const geminiPreflight = await callSendWithRetry(geminiScript, opts.geminiSession, preflightMessage, opts);
        const geminiReply = String(geminiPreflight.response ?? geminiPreflight.output ?? "");
        parsedReply = parseDecisionEscalationReply(geminiReply);
        confirmedTarget = resolveDecisionEscalationTarget(parsedReply, decisionTarget);

        if (parsedReply.action === "wait") {
          scheduleUpgrade = true;
          process.stdout.write(`\n[decision-mode] Gemini asked to wait; pausing current Codex task and scheduling background recovery … `);
          checkpointState = markDecisionModePaused(checkpointState, {
            requested: decisionTarget,
            confirmed: decisionTarget,
            current: currentFooter,
            geminiReply: parsedReply.raw,
            geminiAction: parsedReply.action,
            preflightAttempts,
            waitedForIdle: false,
            resumeSignal: "CONTINUE",
          });
          writeCheckpoint(checkpointFile, checkpointState);
          await pauseCodexTask(opts.codexSession, opts.settleMs);
          break;
        }

        if (parsedReply.action === "adjust") {
          process.stdout.write(`\n[decision-mode] Gemini adjusted target -> ${confirmedTarget.model} ${confirmedTarget.effort}\n`);
        } else if (parsedReply.action === "ok") {
          process.stdout.write(`\n[decision-mode] Gemini approved target -> ${confirmedTarget.model} ${confirmedTarget.effort}\n`);
        } else {
          process.stdout.write(`\n[decision-mode] Gemini reply unclear; using default target -> ${confirmedTarget.model} ${confirmedTarget.effort}\n`);
        }
        break;
      }

      if (!parsedReply) {
        throw new Error("Decision mode preflight did not produce a usable reply");
      }
      const currentTargetState = {
        model: currentFooter.model,
        effort: currentFooter.effort,
      };
      needsUpgrade = shouldEscalateDecisionModel(currentTargetState, decisionTarget.model, decisionTarget.effort);
      const shouldUpgradeAfterPreflight = shouldEscalateDecisionModel(currentTargetState, confirmedTarget.model, confirmedTarget.effort);

      let verified = false;
      let workerInfo = null;
      if (needsUpgrade || shouldUpgradeAfterPreflight) {
        process.stdout.write(`[decision-mode] scheduling CODEX upgrade to ${confirmedTarget.model} ${confirmedTarget.effort} in the background … `);
        workerInfo = scheduleDecisionModeWorker({
          nodePath: process.execPath,
          codexScript,
          geminiScript,
          codexSession: opts.codexSession,
          geminiSession: opts.geminiSession,
          checkpointFile,
          model: confirmedTarget.model,
          effort: confirmedTarget.effort,
          timeoutMs: Math.max(opts.timeoutMs, 120_000),
          pollMs: opts.pollMs,
          settleMs: opts.settleMs,
          resumeMessage: `Decision mode confirmed: Codex upgraded to ${confirmedTarget.model} ${confirmedTarget.effort}. Continue with the decision analysis.`,
        });
        const pendingState = markDecisionModePaused(checkpointState, {
          requested: decisionTarget,
          confirmed: confirmedTarget,
          current: currentFooter,
          geminiReply: parsedReply.raw,
          geminiAction: parsedReply.action,
          preflightAttempts,
          waitedForIdle: parsedReply.action === "wait",
          resumeSignal: "CONTINUE",
        });
        checkpointState = {
          ...pendingState,
          decisionMode: {
            ...pendingState.decisionMode,
            worker: workerInfo,
          },
        };
        writeCheckpoint(checkpointFile, checkpointState);
        process.stdout.write(`done\n`);
        return;
      }

      const decisionSummary = {
        requested: decisionTarget,
        confirmed: confirmedTarget,
        current: currentFooter,
        applied: false,
        geminiReply: parsedReply.raw,
        geminiAction: parsedReply.action,
        preflightAttempts,
        waitedForIdle: parsedReply.action === "wait",
        verified,
        updatedAt: new Date().toISOString(),
      };
      checkpointState = markDecisionModeApplied(checkpointState, decisionSummary);
      writeCheckpoint(checkpointFile, checkpointState);

      const decisionAckMessage = `Decision mode confirmed: Codex already at ${confirmedTarget.model} ${confirmedTarget.effort}. Continue with the decision analysis.`;
      process.stdout.write(`[decision-mode] notifying GEMINI that analysis can continue … `);
      await callSendWithRetry(geminiScript, opts.geminiSession, decisionAckMessage, opts);
      process.stdout.write(`done\n`);

      process.stdout.write(`[decision-mode] clearing GEMINI session before main dialogue … `);
      await clearSession(geminiScript, "gemini", opts.geminiSession, opts);
      process.stdout.write(`done\n`);
    }
  }

  let currentMessage = checkpointState.currentMessage;
  let currentRole = checkpointState.currentRole;

  try {
    for (let turn = checkpointState.nextTurn; turn <= opts.turns; turn += 1) {
      const isGeminiRole = currentRole === "gemini";
      const session = isGeminiRole ? opts.geminiSession : opts.codexSession;
      const script = isGeminiRole ? geminiScript : codexScript;

      process.stdout.write(`\n[turn ${turn}/${opts.turns}] → ${currentRole.toUpperCase()} … `);

      const result = await callSendWithRetry(script, session, currentMessage, opts);

      const responseMeta = currentRole === "gemini"
        ? (result.responseMeta ?? { method: "unknown", text: result.response ?? extractGeminiResponse(result.baseline ?? "", result.output, currentMessage) })
        : extractResponseMeta(result.baseline ?? "", result.output, currentRole, currentMessage);
      assertForwardingSafe(responseMeta);
      const forwarded = prepareForwardingText(responseMeta.text, opts.maxMsgLen);
      const health = computeTurnHealth(responseMeta, forwarded);

      process.stdout.write(`done [captured=${responseMeta.text.length} forwarded=${forwarded.length} method=${responseMeta.method}]\n`);
      printTurn(turn, opts.turns, currentRole, currentMessage, responseMeta, forwarded);

      const nextRole = isGeminiRole ? "codex" : "gemini";
      checkpointState = advanceCheckpointState(checkpointState, {
        turn,
        speaker: currentRole,
        session,
        sent: currentMessage,
        responseMeta,
        forwarded,
        health,
        paneHash: result.paneHash,
        capturedChars: result.capturedChars,
        paneLineCount: result.paneLineCount,
        timestamp: new Date().toISOString(),
      }, nextRole, forwarded);
      writeCheckpoint(checkpointFile, checkpointState);
      currentRole = nextRole;
      currentMessage = forwarded;
    }
  } catch (error) {
    checkpointState = markCheckpointFailure(checkpointState, error, checkpointState.nextTurn);
    writeCheckpoint(checkpointFile, checkpointState);
    throw error;
  }

  checkpointState = markCheckpointComplete(checkpointState);
  writeCheckpoint(checkpointFile, checkpointState);
  const healthSummary = summarizeDialogueHealth(checkpointState.history);
  console.log(`\n${"═".repeat(64)}`);
  console.log(` Dialogue complete. ${opts.turns} turns logged.`);
  console.log(` Health summary: stable=${healthSummary.THREAD_STABLE} stretched=${healthSummary.THREAD_STRETCHED} frayed=${healthSummary.THREAD_FRAYED}`);
  console.log(`${"═".repeat(64)}\n`);
}

const entryPath = new URL(import.meta.url).pathname;
if (process.argv[1] && path.resolve(process.argv[1]) === entryPath) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  });
}
