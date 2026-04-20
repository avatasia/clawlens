import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function lockDirForSession(session) {
  const baseDir = path.join(os.tmpdir(), "clawlens-tmux-locks");
  fs.mkdirSync(baseDir, { recursive: true });
  const safeName = String(session).replace(/[^A-Za-z0-9_.-]+/g, "_");
  return path.join(baseDir, `${safeName}.lock`);
}

function ownerFileForLockDir(lockDir) {
  return path.join(lockDir, "owner");
}

function parseOwnerPid(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  const directPid = Number.parseInt(text, 10);
  if (Number.isInteger(directPid) && directPid > 0) return directPid;

  try {
    const parsed = JSON.parse(text);
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0) return parsed.pid;
  } catch {}

  return null;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export function readLockOwner(lockDir) {
  try {
    return parseOwnerPid(fs.readFileSync(ownerFileForLockDir(lockDir), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function isLockStale(lockDir) {
  const ownerPid = readLockOwner(lockDir);
  if (!ownerPid) return true;
  return !isPidAlive(ownerPid);
}

export function clearStaleLock(lockDir) {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

export async function withSessionLock(session, fn, timeoutMs = 60_000) {
  const lockDir = lockDirForSession(session);
  const deadline = Date.now() + timeoutMs;
  const parentDir = path.dirname(lockDir);
  const lockPrefix = `${path.basename(lockDir)}.`;

  while (true) {
    const stagingDir = fs.mkdtempSync(path.join(parentDir, lockPrefix));
    try {
      fs.writeFileSync(ownerFileForLockDir(stagingDir), JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }), "utf8");
      fs.renameSync(stagingDir, lockDir);
      break;
    } catch (error) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY" || error?.code === "EPERM") {
        if (isLockStale(lockDir)) {
          clearStaleLock(lockDir);
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for session lock: ${session}`);
        }
        await sleep(250);
        continue;
      }
      throw error;
    }
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
