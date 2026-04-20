import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  isLockStale,
  lockDirForSession,
  readLockOwner,
  withSessionLock,
} from "./tmux-session-lock.mjs";

test("lockDirForSession normalizes unsafe session names", () => {
  const lockPath = lockDirForSession("gemini/alpha beta");
  assert.match(lockPath, /gemini_alpha_beta\.lock$/);
});

test("withSessionLock serializes concurrent work for the same session", async () => {
  const session = `lock-test-${Date.now()}`;
  const events = [];

  const first = withSessionLock(session, async () => {
    events.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 250));
    events.push("first:end");
    return "first";
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const second = withSessionLock(session, async () => {
    events.push("second:start");
    events.push("second:end");
    return "second";
  });

  const results = await Promise.all([first, second]);

  assert.deepEqual(results, ["first", "second"]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("withSessionLock clears stale lock directories left by dead owners", async () => {
  const session = `lock-stale-${Date.now()}`;
  const lockDir = lockDirForSession(session);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    `${lockDir}/owner`,
    JSON.stringify({ pid: 999_999_999, createdAt: "2026-04-20T00:00:00.000Z" }),
    "utf8",
  );

  assert.equal(readLockOwner(lockDir), 999_999_999);
  assert.equal(isLockStale(lockDir), true);

  const result = await withSessionLock(session, async () => "recovered");
  assert.equal(result, "recovered");
});
