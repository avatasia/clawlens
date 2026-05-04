#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { withSessionLock } from "./tmux-session-lock.mjs";

function usage() {
  console.log(`Usage: node scripts/schedule-tmux-continue-on-reset.mjs [options]

Options:
  --session <name>          tmux session name (default: cc1)
  --cli-type <claude|codex> CLI type for quota probe (default: auto-detect from session name)
  --buffer-lines <n>        capture last N pane lines (default: 120)
  --offset-minutes <n>      send continue N minutes after reset (default: 1)
  --dry-run                 parse and print target time without scheduling
  --force                   ignore an existing pending metadata file
  --help                    show this help
`);
}

function parseArgs(argv) {
  const options = {
    session: "cc1",
    cliType: null,
    bufferLines: 120,
    offsetMinutes: 1,
    dryRun: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--session") {
      options.session = argv[++i] ?? "";
      continue;
    }
    if (arg === "--cli-type") {
      options.cliType = argv[++i] ?? "";
      continue;
    }
    if (arg === "--buffer-lines") {
      options.bufferLines = Number(argv[++i]);
      continue;
    }
    if (arg === "--offset-minutes") {
      options.offsetMinutes = Number(argv[++i]);
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.session) {
    throw new Error("--session must be non-empty");
  }
  if (!Number.isInteger(options.bufferLines) || options.bufferLines <= 0) {
    throw new Error("--buffer-lines must be a positive integer");
  }
  if (!Number.isFinite(options.offsetMinutes) || options.offsetMinutes < 0) {
    throw new Error("--offset-minutes must be >= 0");
  }

  // Auto-detect cli type from session name
  if (!options.cliType) {
    if (/codex/i.test(options.session)) {
      options.cliType = "codex";
    } else {
      options.cliType = "claude";
    }
  }
  if (options.cliType !== "claude" && options.cliType !== "codex") {
    throw new Error("--cli-type must be 'claude' or 'codex'");
  }

  return options;
}

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...extra,
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr}`);
  }

  return (result.stdout || "").trimEnd();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseRelativeDuration(text) {
  const hours = Number((text.match(/(\d+)\s*h/i) || [])[1] || 0);
  const minutes = Number((text.match(/(\d+)\s*m/i) || [])[1] || 0);
  const seconds = Number((text.match(/(\d+)\s*s/i) || [])[1] || 0);
  if (hours === 0 && minutes === 0 && seconds === 0) {
    return null;
  }
  return { hours, minutes, seconds };
}

export function extractResetSpec(text) {
  // Codex wraps "...try again\nat H:MM PM." across terminal lines — join first
  const joined = text.replace(/\r?\n/g, " ");
  if (/hit your usage limit/i.test(joined)) {
    const m = joined.match(/try again at\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
    if (m) {
      return [{ kind: "absolute", resetText: m[1].trim(), timezone: null, sourceLine: "You've hit your usage limit" }];
    }
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/limit reached|hit your limit/i.test(line) && !/resets/i.test(line)) {
      continue;
    }

    const absolute = line.match(/resets(?:\s+at|\s*[: ]+)\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)(?!\s*[hms])(?:\s*\(([^)]+)\))?/i);
    if (absolute) {
      candidates.push({
        kind: "absolute",
        resetText: absolute[1].trim(),
        timezone: absolute[2]?.trim() || null,
        sourceLine: line,
      });
      continue;
    }

    const relative = line.match(/resets(?:\s+at|\s*[: ]+)\s*((?:(?:\d+)\s*[hms]\s*){1,3})/i);
    if (relative) {
      const duration = parseRelativeDuration(relative[1]);
      if (duration) {
        candidates.push({
          kind: "relative",
          ...duration,
          sourceLine: line,
        });
      }
    }
  }

  return candidates.length > 0 ? candidates : null;
}

// Parse /usage TUI overlay output from Claude Code.
// Returns { percentLeft, spec } or null.
export function parseClaudeUsage(text) {
  const idx = text.lastIndexOf("Current session");
  if (idx === -1) return null;
  const block = text.slice(idx);

  let percentLeft;
  const percentMatch = block.match(/(\d+)%\s+used/);
  if (percentMatch) {
    percentLeft = 100 - Number(percentMatch[1]);
  } else if (/limit reached/i.test(block)) {
    percentLeft = 0;
  } else {
    return null;
  }

  const resetsMatch = block.match(/Resets\s+(.+)/);
  if (!resetsMatch) return null;
  const resetText = resetsMatch[1].trim();

  const tzMatch = resetText.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  const resetTimeText = tzMatch ? tzMatch[1].trim() : resetText;
  const timezone = tzMatch ? tzMatch[2].trim() : null;

  return {
    percentLeft,
    spec: { kind: "absolute", resetText: resetTimeText, timezone, sourceLine: `Claude /usage: ${resetText}` },
  };
}

// Parse /status output from Codex.
// Returns { percentLeft, spec } or null.
export function parseCodexStatus(text) {
  const m = text.match(/5h\s+limit:.*?(\d+)%\s+left\s+\(resets\s+([^)]+)\)/i);
  if (!m) return null;
  return {
    percentLeft: Number(m[1]),
    spec: { kind: "absolute", resetText: m[2].trim(), timezone: null, sourceLine: `Codex /status: resets ${m[2]}` },
  };
}

function dateInTimezone(format, timezone, dateExpr = "now") {
  return run("date", ["-d", dateExpr, format], {
    env: {
      ...process.env,
      ...(timezone ? { TZ: timezone } : {}),
    },
  });
}

export function computeTargetEpoch(spec, nowEpoch, offsetMinutes) {
  const offsetSeconds = Math.round(offsetMinutes * 60);

  if (spec.kind === "relative") {
    const delaySeconds = spec.hours * 3600 + spec.minutes * 60 + spec.seconds;
    return nowEpoch + delaySeconds + offsetSeconds;
  }

  const timezone = spec.timezone || null;
  const today = dateInTimezone("+%F", timezone);
  let candidate = Number(dateInTimezone("+%s", timezone, `${today} ${spec.resetText}`));
  if (candidate <= nowEpoch) {
    const tomorrow = dateInTimezone("+%F", timezone, "tomorrow");
    candidate = Number(dateInTimezone("+%s", timezone, `${tomorrow} ${spec.resetText}`));
  }
  return candidate + offsetSeconds;
}

function formatEpoch(epoch) {
  return run("date", ["-d", `@${epoch}`, "+%Y-%m-%d %H:%M:%S %Z %z"]);
}

function capturePane(session, bufferLines) {
  return run("tmux", ["capture-pane", "-pt", session, "-S", `-${bufferLines}`]);
}

function currentPaneId(session) {
  return run("tmux", ["display-message", "-p", "-t", session, "#{session_name}:#{window_index}.#{pane_index}"]);
}

function sanitizeName(value) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

// Send /usage or /status to the pane and return parsed quota result.
// Returns { percentLeft, spec } on success, or { skipped: reason } if not attempted.
// Only called when an interruption signal is already detected in the pane.
export function probeQuota(paneId, cliType, captureLines = 120) {
  const command = cliType === "codex" ? "/status" : "/usage";

  // Send command and Enter as separate send-keys calls
  run("tmux", ["send-keys", "-t", paneId, command, ""]);
  spawnSync("sleep", ["0.1"]);
  run("tmux", ["send-keys", "-t", paneId, "Enter", ""]);

  // Poll for parseable output (up to 10s)
  const deadline = Date.now() + 10_000;
  let result = null;
  while (Date.now() < deadline) {
    spawnSync("sleep", ["0.5"]);
    const text = run("tmux", ["capture-pane", "-pt", paneId, "-S", `-${captureLines}`]);
    result = cliType === "codex" ? parseCodexStatus(text) : parseClaudeUsage(text);
    if (result) break;
  }

  // Dismiss Claude Code /usage TUI overlay
  if (cliType === "claude") {
    spawnSync("sleep", ["0.3"]);
    run("tmux", ["send-keys", "-t", paneId, "Escape", ""]);
    spawnSync("sleep", ["0.2"]);
  }

  return result ?? { skipped: "parse-failed" };
}

function makeRunnerScript({ session, delaySeconds, logPath, metadataPath, runnerPath, lockHelperPath }) {
  return `#!/usr/bin/env bash
set -euo pipefail

sleep ${delaySeconds}

TMUX_CONTINUE_SESSION=${shellQuote(session)} \
TMUX_CONTINUE_LOG_PATH=${shellQuote(logPath)} \
TMUX_CONTINUE_METADATA_PATH=${shellQuote(metadataPath)} \
TMUX_CONTINUE_RUNNER_PATH=${shellQuote(runnerPath)} \
TMUX_CONTINUE_LOCK_HELPER=${shellQuote(pathToFileURL(lockHelperPath).href)} \
node --input-type=module <<'NODE'
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const { withSessionLock } = await import(process.env.TMUX_CONTINUE_LOCK_HELPER);

const session = process.env.TMUX_CONTINUE_SESSION;
const logPath = process.env.TMUX_CONTINUE_LOG_PATH;
const metadataPath = process.env.TMUX_CONTINUE_METADATA_PATH;
const runnerPath = process.env.TMUX_CONTINUE_RUNNER_PATH;

function log(line) {
  fs.appendFileSync(logPath, "[" + new Date().toISOString() + "] " + line + "\\n", "utf8");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(command + " " + args.join(" ") + " failed: " + stderr);
  }
  return (result.stdout || "").trimEnd();
}

function isBusy(text) {
  return /•\\s+Working\\b/.test(text) || /tab to queue message/i.test(text) || /Thinking\\.\\.\\./i.test(text) || /Considering Command Execution/i.test(text);
}

function isPromptReady(text) {
  return /Type your message or @path\\/to\\/file|^\\s*[>›]\\s*$/m.test(text);
}

function hasStackedInput(text) {
  return /^\\s*[>›]\\s+\\S/m.test(text);
}

try {
  await withSessionLock(session, async () => {
    const hasSession = spawnSync("tmux", ["has-session", "-t", session], { encoding: "utf8" });
    if (hasSession.status !== 0) {
      log("session missing: " + session);
      return;
    }

    const pane = run("tmux", ["display-message", "-p", "-t", session, "#{session_name}:#{window_index}.#{pane_index}"]);
    log("pane=" + pane);
    const paneText = run("tmux", ["capture-pane", "-pt", pane, "-S", "-120"]);
    if (isBusy(paneText)) {
      log("busy, skipped continue");
      return;
    }
    if (!isPromptReady(paneText)) {
      if (hasStackedInput(paneText)) {
        log("stacked input detected, sending C-c to clear");
        run("tmux", ["send-keys", "-t", pane, "C-c", ""]);
        spawnSync("sleep", ["0.8"]);
        const freshPane = run("tmux", ["capture-pane", "-pt", pane, "-S", "-30"]);
        if (!isPromptReady(freshPane)) {
          log("prompt not clean after clearing stacked input, skipped");
          return;
        }
      } else {
        log("prompt not ready, skipped continue");
        return;
      }
    }
    // Send "continue" text, then Enter twice (second Enter triggers task resume)
    run("tmux", ["send-keys", "-t", pane, "continue", ""]);
    spawnSync("sleep", ["0.1"]);
    run("tmux", ["send-keys", "-t", pane, "Enter", ""]);
    spawnSync("sleep", ["0.3"]);
    run("tmux", ["send-keys", "-t", pane, "Enter", ""]);
    log("sent continue (2x Enter)");
  }, 30_000);
} catch (error) {
  log("runner failed: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(metadataPath, { force: true });
  } catch {}
  try {
    fs.rmSync(runnerPath, { force: true });
  } catch {}
}
NODE
`;
}

// Detect whether the pane shows a task-interruption signal from quota exhaustion.
// Does NOT treat "0% left" as an interruption signal (that can appear from /status output).
export function analyzePane(text) {
  const waitingForReset = /limit reached|hit your limit|hit your usage limit|usage ⚠/i.test(text);
  const spec = extractResetSpec(text);
  return { waitingForReset, spec };
}

export function selectResetCandidate(specs, nowEpoch, offsetMinutes) {
  const absoluteSpecs = specs.filter((spec) => spec.kind === "absolute");
  const relativeSpecs = specs.filter((spec) => spec.kind === "relative");
  const prioritized = absoluteSpecs.length > 0 ? absoluteSpecs : relativeSpecs;

  return prioritized
    .map((spec) => ({
      spec,
      targetEpoch: computeTargetEpoch(spec, nowEpoch, offsetMinutes),
    }))
    .sort((a, b) => a.targetEpoch - b.targetEpoch)[0] ?? null;
}

export function isBusyForContinue(text) {
  return (
    /•\s+Working\b/.test(String(text || "")) ||
    /tab to queue message/i.test(String(text || "")) ||
    /Thinking\.\.\./i.test(String(text || "")) ||
    /Considering Command Execution/i.test(String(text || ""))
  );
}

export function isPromptReadyForContinue(text) {
  return /Type your message or @path\/to\/file|^\s*[>›]\s*$/m.test(String(text || ""));
}

export function hasStackedInputForContinue(text) {
  return /^\s*[>›]\s+\S/m.test(String(text || ""));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const paneText = capturePane(options.session, options.bufferLines);
  const paneId = currentPaneId(options.session);

  // Step 1: Skip if busy
  if (isBusyForContinue(paneText)) {
    console.log(`Session ${options.session}: busy, no action.`);
    return;
  }

  // Step 2: Skip if already scheduled
  const nowEpoch = Math.floor(Date.now() / 1000);
  const metadataDir = path.join(os.tmpdir(), "clawlens-auto-continue");
  const metadataPath = path.join(metadataDir, `${sanitizeName(options.session)}.json`);

  if (fs.existsSync(metadataPath) && !options.force) {
    const existing = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (existing.targetEpoch > nowEpoch) {
      console.log(`Already scheduled for session ${options.session}.`);
      console.log(`Existing target: ${formatEpoch(existing.targetEpoch)}`);
      console.log(`Metadata: ${metadataPath}`);
      console.log(`Log: ${existing.logPath}`);
      return;
    }
  }

  // Step 3: Check for task-interruption signal in pane (gate for probe)
  const analysis = analyzePane(paneText);
  if (!analysis.waitingForReset) {
    console.log(`Session ${options.session}: no interruption signal, no action.`);
    return;
  }

  // Step 4: Probe quota via /status or /usage to get authoritative reset time
  let spec = null;
  if (isPromptReadyForContinue(paneText)) {
    const probe = probeQuota(paneId, options.cliType, options.bufferLines);
    if (!probe.skipped) {
      if (probe.percentLeft > 0) {
        console.log(`Session ${options.session}: quota not exhausted (${probe.percentLeft}% left), no action.`);
        return;
      }
      spec = probe.spec;
    }
  }

  // Fall back to pane-text reset time if probe failed or prompt not ready
  if (!spec && analysis.spec) {
    const specs = Array.isArray(analysis.spec) ? analysis.spec : [analysis.spec];
    const selected = selectResetCandidate(specs, nowEpoch, options.offsetMinutes);
    if (selected) {
      spec = selected.spec;
    }
  }

  if (!spec) {
    console.error(`Session ${options.session}: interruption detected but could not determine reset time.`);
    process.exit(1);
  }

  // Step 5: Compute target and schedule
  const targetEpoch = computeTargetEpoch(spec, nowEpoch, options.offsetMinutes);
  const delaySeconds = Math.max(0, targetEpoch - nowEpoch);
  const jobId = `${sanitizeName(options.session)}-${targetEpoch}`;
  const logPath = path.join(metadataDir, `${jobId}.log`);
  const runnerPath = path.join(metadataDir, `${jobId}.sh`);

  fs.mkdirSync(metadataDir, { recursive: true });

  const metadata = {
    session: options.session,
    cliType: options.cliType,
    paneId,
    sourceLine: spec.sourceLine,
    targetEpoch,
    targetTime: formatEpoch(targetEpoch),
    logPath,
    runnerPath,
    createdAt: formatEpoch(nowEpoch),
  };

  if (options.dryRun) {
    console.log(JSON.stringify(metadata, null, 2));
    return;
  }

  await withSessionLock(options.session, async () => {
    if (fs.existsSync(metadataPath) && !options.force) {
      const existing = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (existing.targetEpoch > nowEpoch) {
        console.log(`Already scheduled for session ${options.session}.`);
        console.log(`Existing target: ${formatEpoch(existing.targetEpoch)}`);
        return;
      }
    }

    fs.writeFileSync(
      runnerPath,
      makeRunnerScript({
        session: options.session,
        delaySeconds,
        logPath,
        metadataPath,
        runnerPath,
        lockHelperPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "tmux-session-lock.mjs"),
      }),
      "utf8",
    );
    fs.chmodSync(runnerPath, 0o755);
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    run("tmux", ["run-shell", "-b", `bash ${shellQuote(runnerPath)}`]);

    console.log(`Scheduled continue for session ${options.session}.`);
    console.log(`Current pane: ${paneId}`);
    console.log(`Trigger: ${spec.sourceLine}`);
    console.log(`Target: ${metadata.targetTime}`);
    console.log(`Metadata: ${metadataPath}`);
    console.log(`Log: ${logPath}`);
  }, 30_000);
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === entryPath) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
