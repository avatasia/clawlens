#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULER_PATH = path.join(__dirname, "schedule-tmux-continue-on-reset.mjs");

const POLL_INTERVAL_MS = 60_000; // Check every minute
const SESSIONS = ["codex", "gemini1", "claude"]; // Target sessions

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function checkAndSchedule() {
  for (const session of SESSIONS) {
    // Check if session exists
    const hasSession = spawnSync("tmux", ["has-session", "-t", session]);
    if (hasSession.status !== 0) continue;

    log(`Checking session: ${session} ...`);
    const result = spawnSync("node", [SCHEDULER_PATH, "--session", session], { encoding: "utf8" });
    
    if (result.status === 0) {
      log(`SUCCESS: Scheduled recovery for ${session}. Output: ${result.stdout.trim().split("\n")[0]}`);
    } else {
      // If it fails, it usually just means "not in a reset-waiting state", which is fine.
      if (!result.stderr.includes("not in a parseable reset-waiting state")) {
        log(`ERROR checking ${session}: ${result.stderr.trim()}`);
      }
    }
  }
}

async function main() {
  log("Starting Tandem Turbo Auto-Resume Observer...");
  log(`Watching sessions: ${SESSIONS.join(", ")}`);
  
  while (true) {
    try {
      await checkAndSchedule();
    } catch (err) {
      log(`FATAL: ${err.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
