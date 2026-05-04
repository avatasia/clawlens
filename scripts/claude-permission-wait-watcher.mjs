#!/usr/bin/env node
/**
 * Permission Wait Watcher
 *
 * Companion script for the permission-wait notification hook system.
 * Reads the hook's state file and reports elapsed wait time.
 *
 * Usage:
 *   node scripts/claude-permission-wait-watcher.mjs --session <session-id>
 *   # or to watch all sessions:
 *   node scripts/claude-permission-wait-watcher.mjs --all
 *
 * Output:
 *   Human-readable: "⏳ waiting 3m 12s" or "no active permission wait"
 *   --json:         {"waiting":true,"elapsed_seconds":192,"first_seen_at":"...","session_id":"..."}
 *
 * Integration:
 *   - tmux status line: add to status-right via run-shell
 *   - Manual check: run from terminal to see current wait state
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

const STATE_DIR = "/tmp";
const STATE_PREFIX = "claude-permission-wait-";

function usage() {
  console.log(`Usage: node scripts/claude-permission-wait-watcher.mjs [options]

Options:
  --session <id>        Check wait state for a specific session
  --all                 Check all active wait states
  --json                Emit machine-readable JSON
  --help                Show this help

Output:
  plain: "⏳ waiting 3m 12s"  or  "no active permission wait"
  json:  {"waiting":true,"elapsed_seconds":192,...}
`);
}

function parseArgs(argv) {
  const options = { json: false, all: false, session: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--all") { options.all = true; continue; }
    if (arg === "--session") { options.session = argv[++i] || ""; continue; }
    if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function sanitize(s) {
  return s.replace(/[^A-Za-z0-9\-_.]/g, "_");
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function readState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function collectAllStates() {
  const results = [];
  try {
    const files = fs.readdirSync(STATE_DIR);
    for (const file of files) {
      if (!file.startsWith(STATE_PREFIX)) continue;
      const state = readState(path.join(STATE_DIR, file));
      if (state) results.push(state);
    }
  } catch {
    // /tmp not readable
  }
  return results;
}

function computeWaitInfo(state) {
  if (!state || !state.first_seen_at) return null;
  const firstSeen = new Date(state.first_seen_at);
  const now = new Date();
  const elapsedMs = now.getTime() - firstSeen.getTime();
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  return {
    waiting: true,
    elapsed_seconds: elapsedSeconds,
    elapsed_human: formatDuration(elapsedSeconds),
    first_seen_at: state.first_seen_at,
    session_id: state.session_id || "unknown",
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  let states;
  if (options.session) {
    const filePath = path.join(STATE_DIR, `${STATE_PREFIX}${sanitize(options.session)}.json`);
    const state = readState(filePath);
    states = state ? [state] : [];
  } else if (options.all) {
    states = collectAllStates();
  } else {
    states = collectAllStates();
  }

  if (states.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ waiting: false, sessions: [] }));
    } else {
      console.log("no active permission wait");
    }
    return;
  }

  const infos = states.map(computeWaitInfo).filter(Boolean);

  if (options.json) {
    console.log(JSON.stringify({ waiting: infos.length > 0, sessions: infos }, null, 2));
    return;
  }

  for (const info of infos) {
    console.log(`⏳ waiting ${info.elapsed_human} (since ${info.first_seen_at})`);
  }
}

const entryPath = new URL(import.meta.url).pathname;
if (process.argv[1] && entryPath === process.argv[1]) {
  try {
    main();
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
