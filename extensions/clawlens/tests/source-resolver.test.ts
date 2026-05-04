import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { SourceResolver, hasTrustedSourceRoots } from "../src/source-resolver.js";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawlens-source-resolver-"));
}

function writeJsonl(filePath: string, rows: unknown[]) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

describe("source-resolver", () => {
  test("resolves exact session_file message lookup", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "11111111-1111-1111-1111-111111111111.jsonl");
    writeJsonl(file, [
      { id: "msg-1", role: "user", content: "hello" },
    ]);

    const resolver = new SourceResolver({ sourceLookupDirs: [dir] });
    const result = await resolver.resolveMessageSource({
      messageId: "msg-1",
      sessionFile: file,
      sourceKind: "transcript_explicit",
    });
    assert.equal(result.ok, true);
    assert.equal((result as any).messageId, "msg-1");
    assert.equal((result as any).payload.id, "msg-1");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("resolves reset archive lookup when original file is missing", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "22222222-2222-2222-2222-222222222222.jsonl");
    const reset = `${file}.reset.20260501`;
    writeJsonl(reset, [
      { id: "msg-reset", role: "user", content: "from reset" },
    ]);

    const resolver = new SourceResolver({ sourceLookupDirs: [dir] });
    const result = await resolver.resolveMessageSource({
      messageId: "msg-reset",
      sessionFile: file,
      sourceKind: "transcript_explicit",
    });
    assert.equal(result.ok, true);
    assert.match((result as any).sessionFile, /\.reset\./);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("resolves deleted archive lookup when original file is missing", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "23232323-2323-2323-2323-232323232323.jsonl");
    const archived = `${file}.deleted.20260501`;
    writeJsonl(archived, [
      { id: "msg-deleted", role: "user", content: "from deleted archive" },
    ]);

    const resolver = new SourceResolver({ sourceLookupDirs: [dir] });
    const result = await resolver.resolveMessageSource({
      messageId: "msg-deleted",
      sessionFile: file,
      sourceKind: "transcript_explicit",
    });
    assert.equal(result.ok, true);
    assert.match((result as any).sessionFile, /\.deleted\./);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("resolves compaction successor candidate by filename", async () => {
    const dir = makeTmpDir();
    const original = path.join(dir, "33333333-3333-3333-3333-333333333333.jsonl");
    const successor = path.join(dir, "compacted_33333333-3333-3333-3333-333333333333.jsonl");
    writeJsonl(successor, [
      { id: "header-successor", role: "system", parentSession: "77777777-7777-7777-7777-777777777777" },
      { id: "msg-successor", role: "assistant" },
    ]);
    const parent = path.join(dir, "77777777-7777-7777-7777-777777777777.jsonl");
    writeJsonl(parent, [
      { id: "msg-parent", role: "user", content: "from parent" },
    ]);

    const resolver = new SourceResolver({ sourceLookupDirs: [dir] });
    const result = await resolver.resolveMessageSource({
      messageId: "msg-parent",
      sessionFile: original,
      sourceKind: "transcript_explicit",
    });
    assert.equal(result.ok, true);
    assert.match((result as any).sessionFile, /77777777/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("resolves checkpoint transcript when sessionFile already points at checkpoint artifact", async () => {
    const dir = makeTmpDir();
    const checkpoint = path.join(
      dir,
      "34343434-3434-3434-3434-343434343434.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
    );
    writeJsonl(checkpoint, [
      { id: "msg-checkpoint", role: "assistant", content: "from checkpoint" },
    ]);

    const resolver = new SourceResolver({ sourceLookupDirs: [dir] });
    const result = await resolver.resolveMessageSource({
      messageId: "msg-checkpoint",
      sessionFile: checkpoint,
      sourceKind: "transcript_explicit",
    });
    assert.equal(result.ok, true);
    assert.match((result as any).sessionFile, /\.checkpoint\./);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("discovers checkpoint transcript from original session id when primary file is missing", async () => {
    const dir = makeTmpDir();
    const original = path.join(dir, "35353535-3535-3535-3535-353535353535.jsonl");
    const checkpoint = path.join(
      dir,
      "35353535-3535-3535-3535-353535353535.checkpoint.22222222-2222-4222-8222-222222222222.jsonl",
    );
    writeJsonl(checkpoint, [
      { id: "msg-checkpoint-discovered", role: "assistant", content: "from discovered checkpoint" },
    ]);

    const resolver = new SourceResolver({ sourceLookupDirs: [dir] });
    const result = await resolver.resolveMessageSource({
      messageId: "msg-checkpoint-discovered",
      sessionFile: original,
      sourceKind: "transcript_explicit",
    });
    assert.equal(result.ok, true);
    assert.match((result as any).sessionFile, /\.checkpoint\./);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns source_root_unavailable when no trusted roots exist", async () => {
    const resolver = new SourceResolver({ sourceLookupDirs: [] });
    const result = await resolver.resolveMessageSource({
      messageId: "msg-miss",
      sessionFile: undefined,
      sourceKind: "transcript_explicit",
    });
    assert.deepEqual(result, {
      ok: false,
      miss: "session_file_missing",
      candidatesTried: [],
    });
  });

  test("tool lookup can return partial result", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "44444444-4444-4444-4444-444444444444.jsonl");
    writeJsonl(file, [
      {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", toolCallId: "tool-1", toolName: "read" }],
      },
    ]);

    const resolver = new SourceResolver({ sourceLookupDirs: [dir] });
    const result = await resolver.resolveToolSource({
      runId: "run-1",
      toolCallId: "tool-1",
      sessionFiles: [file],
    });
    assert.equal(result.ok, true);
    assert.equal((result as any).toolCallId, "tool-1");
    assert.ok((result as any).toolCall);
    assert.equal((result as any).toolResult, null);
    assert.deepEqual((result as any).missing, ["toolResult"]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("tool lookup can return partial result when tool call entry is missing", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "45454545-4545-4545-4545-454545454545.jsonl");
    writeJsonl(file, [
      {
        id: "tool-1-result",
        role: "tool",
        toolCallId: "tool-1",
        content: "done",
      },
    ]);

    const resolver = new SourceResolver({ sourceLookupDirs: [dir] });
    const result = await resolver.resolveToolSource({
      runId: "run-1",
      toolCallId: "tool-1",
      sessionFiles: [file],
    });
    assert.equal(result.ok, true);
    assert.equal((result as any).toolCallId, "tool-1");
    assert.equal((result as any).toolCall, null);
    assert.ok((result as any).toolResult);
    assert.deepEqual((result as any).missing, ["toolCall"]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("trusted roots helper accepts explicit root or session file dir", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "55555555-5555-5555-5555-555555555555.jsonl");
    writeJsonl(file, []);
    assert.equal(hasTrustedSourceRoots(file, []), true);
    assert.equal(hasTrustedSourceRoots(undefined, [dir]), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns scan_limit_exceeded when byte cap is hit before match", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "66666666-6666-6666-6666-666666666666.jsonl");
    writeJsonl(file, [
      { id: "msg-a", content: "x".repeat(100) },
      { id: "msg-b", content: "y".repeat(100) },
    ]);
    const resolver = new SourceResolver({ sourceLookupDirs: [dir], maxScanBytes: 10 });
    const result = await resolver.resolveMessageSource({
      messageId: "msg-b",
      sessionFile: file,
      sourceKind: "transcript_explicit",
    });
    assert.equal(result.ok, false);
    assert.equal((result as any).miss, "scan_limit_exceeded");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns scan_timeout when deadline is exceeded during scan", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "67676767-6767-6767-6767-676767676767.jsonl");
    writeJsonl(file, [
      { id: "msg-a", content: "x".repeat(50) },
      { id: "msg-b", content: "y".repeat(50) },
    ]);

    const originalNow = Date.now;
    let fakeNow = 1_000;
    Date.now = () => {
      fakeNow += 10;
      return fakeNow;
    };
    try {
      const resolver = new SourceResolver({ sourceLookupDirs: [dir], timeoutMs: 1 });
      const result = await resolver.resolveMessageSource({
        messageId: "msg-b",
        sessionFile: file,
        sourceKind: "transcript_explicit",
      });
      assert.equal(result.ok, false);
      assert.equal((result as any).miss, "scan_timeout");
    } finally {
      Date.now = originalNow;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parentSession cycle does not recurse forever", async () => {
    const dir = makeTmpDir();
    const original = path.join(dir, "abababab-abab-abab-abab-abababababab.jsonl");
    const successorA = path.join(dir, "next_abababab-abab-abab-abab-abababababab.jsonl");
    const parentB = path.join(dir, "bcbcbcbc-bcbc-bcbc-bcbc-bcbcbcbcbcbc.jsonl");
    const successorB = path.join(dir, "next_bcbcbcbc-bcbc-bcbc-bcbc-bcbcbcbcbcbc.jsonl");

    writeJsonl(successorA, [
      { id: "header-a", parentSession: "bcbcbcbc-bcbc-bcbc-bcbc-bcbcbcbcbcbc" },
    ]);
    writeJsonl(parentB, [
      { id: "seed-b", content: "parent-b" },
    ]);
    writeJsonl(successorB, [
      { id: "header-b", parentSession: "abababab-abab-abab-abab-abababababab" },
    ]);

    const resolver = new SourceResolver({ sourceLookupDirs: [dir], maxParentHops: 4 });
    const result = await resolver.resolveMessageSource({
      messageId: "missing-msg",
      sessionFile: original,
      sourceKind: "transcript_explicit",
    });
    assert.equal(result.ok, false);
    assert.equal((result as any).miss, "message_not_found");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("concurrent lookups on one resolver both succeed", async () => {
    const dir = makeTmpDir();
    const fileA = path.join(dir, "78787878-7878-7878-7878-787878787878.jsonl");
    const fileB = path.join(dir, "89898989-8989-8989-8989-898989898989.jsonl");
    writeJsonl(fileA, [{ id: "msg-a", content: "A" }]);
    writeJsonl(fileB, [{ id: "msg-b", content: "B" }]);

    const resolver = new SourceResolver({ sourceLookupDirs: [dir] });
    const [a, b] = await Promise.all([
      resolver.resolveMessageSource({ messageId: "msg-a", sessionFile: fileA, sourceKind: "transcript_explicit" }),
      resolver.resolveMessageSource({ messageId: "msg-b", sessionFile: fileB, sourceKind: "transcript_explicit" }),
    ]);
    assert.equal(a.ok, true);
    assert.equal((a as any).payload.id, "msg-a");
    assert.equal(b.ok, true);
    assert.equal((b as any).payload.id, "msg-b");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("oversized source payload returns structured preview envelope with truncated marker", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "90909090-9090-9090-9090-909090909090.jsonl");
    writeJsonl(file, [
      { id: "msg-large", role: "user", content: "x".repeat(2000) },
    ]);

    const resolver = new SourceResolver({
      sourceLookupDirs: [dir],
      maxResponseBytes: 128,
    });
    const result = await resolver.resolveMessageSource({
      messageId: "msg-large",
      sessionFile: file,
      sourceKind: "transcript_explicit",
    });
    assert.equal(result.ok, true);
    assert.equal((result as any).truncated, true);
    assert.equal((result as any).payload.__clawlensPreview.version, 1);
    assert.match(JSON.stringify((result as any).payload.__clawlensPreview.node), /max_bytes_truncated/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("serialized scan queue runs lookups one at a time", async () => {
    const dir = makeTmpDir();
    const fileA = path.join(dir, "91919191-9191-9191-9191-919191919191.jsonl");
    const fileB = path.join(dir, "92929292-9292-9292-9292-929292929292.jsonl");
    writeJsonl(fileA, [{ id: "msg-a", content: "A" }]);
    writeJsonl(fileB, [{ id: "msg-b", content: "B" }]);

    const originalCreateReadStream = fs.createReadStream;
    const starts: string[] = [];
    let activeScans = 0;
    let maxConcurrentScans = 0;
    fs.createReadStream = ((filePath: fs.PathLike, options?: any) => {
      const basename = path.basename(String(filePath));
      if (basename === path.basename(fileA) || basename === path.basename(fileB)) {
        return Readable.from((async function* () {
          starts.push(basename);
          activeScans += 1;
          maxConcurrentScans = Math.max(maxConcurrentScans, activeScans);
          await new Promise((resolve) => setTimeout(resolve, 25));
          yield `${JSON.stringify({
            id: basename === path.basename(fileA) ? "msg-a" : "msg-b",
            content: basename,
          })}\n`;
          activeScans -= 1;
        })()) as any;
      }
      return originalCreateReadStream(filePath, options);
    }) as typeof fs.createReadStream;

    try {
      const resolver = new SourceResolver({ sourceLookupDirs: [dir] });
      const [a, b] = await Promise.all([
        resolver.resolveMessageSource({ messageId: "msg-a", sessionFile: fileA, sourceKind: "transcript_explicit" }),
        resolver.resolveMessageSource({ messageId: "msg-b", sessionFile: fileB, sourceKind: "transcript_explicit" }),
      ]);
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      assert.deepEqual(starts, [path.basename(fileA), path.basename(fileB)]);
      assert.equal(maxConcurrentScans, 1);
    } finally {
      fs.createReadStream = originalCreateReadStream;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
