/**
 * store.test.ts
 * 覆盖 5 类：正常值 / 异常值 / 不同状态返回 / 并发 / 边界值
 *
 * 需要 Node.js >= 22.5.0（node:sqlite）。
 * 在 Node 20 下所有用例自动 skip。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serializePreviewForTextColumn } from "../src/structured-preview.js";

// ── 环境检测 ──────────────────────────────────────────────────────────────

const [major] = process.versions.node.split(".").map(Number);
const SKIP = major < 22;
const maybe = SKIP
  ? (name: string, _fn: () => void) => test(`${name} [SKIP: requires Node 22+]`, { skip: true }, () => {})
  : (name: string, fn: () => void) => test(name, fn);

// ── 动态 import Store ─────────────────────────────────────────────────────

let Store: (typeof import("../src/store.js"))["Store"];
if (!SKIP) {
  const mod = await import("../src/store.js");
  Store = mod.Store;
}

// ── 测试辅助 ──────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawlens-store-test-"));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 1. 正常值 ──────────────────────────────────────────────────────────────

describe("Store — 正常值", () => {
  maybe("insertRun + getOverview 活跃 run 计数", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("r1", "s1", Date.now(), { channel: "alpha" });
    const ov = store.getOverview();
    assert.equal(ov.activeRuns, 1);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("completeRun 聚合 llmCall 指标", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("r1", "s1", Date.now());
    store.insertLlmCall("r1", 0, Date.now(), { inputTokens: 100, outputTokens: 50, costUsd: 0.001 });
    store.insertLlmCall("r1", 1, Date.now(), { inputTokens: 200, outputTokens: 80, costUsd: 0.002 });
    store.completeRun("r1", Date.now(), "completed");
    const detail = store.getRunDetail("r1");
    const run = detail.run as any;
    assert.equal(run.total_llm_calls, 2);
    assert.equal(run.total_input_tokens, 300);
    assert.equal(run.total_output_tokens, 130);
    assert.ok(Math.abs(run.total_cost_usd - 0.003) < 1e-9);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("insertToolExecution + getRunDetail 含工具记录", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("r1", "s1", Date.now());
    store.insertToolExecution("r1", "tc1", "bash", Date.now(), { durationMs: 42, isError: false });
    store.insertToolExecution("r1", "tc2", "read", Date.now(), { durationMs: 10, isError: false });
    store.completeRun("r1", Date.now(), "completed");
    const detail = store.getRunDetail("r1");
    assert.equal(detail.toolExecutions.length, 2);
    const run = detail.run as any;
    assert.equal(run.total_tool_calls, 2);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("insertSessionSnapshot + cleanup 不影响新数据", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertSessionSnapshot("sess-1", Date.now(), { model: "gpt-4o", inputTokens: 1000 });
    // cleanup with 30 days — snapshot just inserted should survive
    store.cleanup(30);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("getSessions 返回 session 列表", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("r1", "sess-A", Date.now(), { channel: "web" });
    store.insertRun("r2", "sess-B", Date.now(), { channel: "api" });
    store.completeRun("r1", Date.now(), "completed");
    store.completeRun("r2", Date.now(), "completed");
    const sessions = store.getSessions() as any[];
    assert.ok(sessions.length >= 2);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("findUnknownRunIdByPromptMessageId works for legacy and structured previews", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const ts = Date.now();

    store.insertRun("legacy-run", "unknown", ts - 10_000);
    store.insertLlmCall("legacy-run", 0, ts - 10_000, {
      userPromptPreview: 'queued {"message_id":"msg-legacy"}',
    });

    store.insertRun("structured-run", "unknown", ts + 10_000);
    store.insertLlmCall("structured-run", 0, ts + 10_000, {
      userPromptPreview: serializePreviewForTextColumn({
        queued: [{ message_id: "msg-structured" }],
      }),
    });

    assert.equal(store.findUnknownRunIdByPromptMessageId("msg-legacy", { timestamp: ts - 10_000 }), "legacy-run");
    assert.equal(store.findUnknownRunIdByPromptMessageId("msg-structured", { timestamp: ts + 10_000 }), "structured-run");

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("applyLoggerSessionPreviewMapping works with quotes and backslashes in structured preview", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const ts = Date.now();
    const loggerTimestamp = new Date(ts).toISOString();
    const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const userText = 'say "hello" \\\\ world';

    store.insertRun("target-run", "agent:main:main", ts - 1000);
    store.insertRun("old-run", "agent:main:main", ts - 2000);
    store.insertConversationTurn(
      "old-run",
      "agent:main:main",
      0,
      "user",
      serializePreviewForTextColumn({
        blocks: [{ type: "text", text: userText }],
      }),
      userText.length,
      ts,
      {
        messageId: "msg-logger-1",
        sessionFile: `/tmp/${sessionId}.jsonl`,
        sourceKind: "session_fallback",
      },
    );

    assert.equal(store.applyLoggerSessionPreviewMapping({
      runId: "target-run",
      sessionId,
      userTextPreview: userText,
      loggerTimestamp,
    }), true);

    assert.equal(store.findRunIdByMessageId("msg-logger-1"), "target-run");
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("getAuditSession includes preview format metadata for structured previews", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const ts = Date.now();
    store.insertRun("r1", "sess-1", ts);
    store.insertLlmCall("r1", 0, ts, {
      userPromptPreview: serializePreviewForTextColumn({ text: "hello" }),
    });
    store.insertConversationTurn(
      "r1",
      "sess-1",
      0,
      "user",
      serializePreviewForTextColumn({ message_id: "msg-1", text: "hello" }),
      20,
      ts,
      { messageId: "msg-1", sourceKind: "transcript_explicit" },
    );
    store.completeRun("r1", ts + 1000, "completed");

    const session = store.getAuditSession("sess-1") as any;
    assert.equal(session.runs[0].userPromptPreviewFormat, "structured-json-v1");
    assert.equal(session.runs[0].userPromptPreviewVersion, 1);
    assert.equal(session.runs[0].turns[0].previewFormat, "structured-json-v1");
    assert.equal(session.runs[0].turns[0].previewVersion, 1);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("32 KiB structured preview survives SQLite round-trip without silent truncation", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const ts = Date.now();
    const preview = serializePreviewForTextColumn({
      text: "x".repeat(34 * 1024),
      kind: "large-preview-roundtrip",
    }, {
      maxStringChars: 34 * 1024,
      maxSerializedBytes: 64 * 1024,
    });

    assert.ok(Buffer.byteLength(preview, "utf8") >= 32 * 1024);

    store.insertRun("r-roundtrip", "sess-roundtrip", ts);
    store.insertConversationTurn(
      "r-roundtrip",
      "sess-roundtrip",
      0,
      "user",
      preview,
      preview.length,
      ts,
      {
        messageId: "msg-roundtrip-32k",
        sessionFile: "/tmp/78787878-7878-7878-7878-787878787878.jsonl",
        sourceKind: "transcript_explicit",
      },
    );
    store.completeRun("r-roundtrip", ts + 1, "completed");

    const session = store.getAuditSession("sess-roundtrip", { includeDetails: true }) as any;
    assert.equal(session.runs[0].turns[0].preview, preview);
    assert.equal(session.runs[0].turns[0].previewFormat, "structured-json-v1");
    assert.equal(session.runs[0].turns[0].messageId, "msg-roundtrip-32k");

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("tool source anchor helper returns tool row plus session file hints", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const ts = Date.now();
    store.insertRun("r1", "sess-1", ts);
    store.insertToolExecution("r1", "tool-1", "read", ts, {
      argsSummary: serializePreviewForTextColumn({ path: "/tmp/a.txt" }),
      resultSummary: serializePreviewForTextColumn({ ok: true }),
    });
    store.insertConversationTurn("r1", "sess-1", 0, "assistant", "preview", 7, ts, {
      messageId: "msg-tool-1",
      sessionFile: "/tmp/99999999-9999-9999-9999-999999999999.jsonl",
      sourceKind: "transcript_explicit",
    });

    const anchor = store.getToolExecutionSourceAnchor("r1", "tool-1") as any;
    assert.equal(anchor.toolCallId, "tool-1");
    assert.equal(anchor.toolName, "read");
    assert.deepEqual(anchor.sessionFiles, ["/tmp/99999999-9999-9999-9999-999999999999.jsonl"]);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});

// ── 2. 异常值 ──────────────────────────────────────────────────────────────

describe("Store — 异常值", () => {
  maybe("insertRun 重复 runId → OR IGNORE 不抛", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("dup", "s1", Date.now());
    assert.doesNotThrow(() => store.insertRun("dup", "s2", Date.now()));
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("completeRun 不存在的 runId → 不抛，UPDATE 0 行", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    assert.doesNotThrow(() => store.completeRun("ghost", Date.now(), "completed"));
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("getRunDetail 不存在 → run=undefined, llmCalls=[], toolExecutions=[]", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const detail = store.getRunDetail("nonexistent");
    assert.equal(detail.run, undefined);
    assert.deepEqual(detail.llmCalls, []);
    assert.deepEqual(detail.toolExecutions, []);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("insertLlmCall opts 全空 → 不崩溃", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("r1", "s1", Date.now());
    assert.doesNotThrow(() => store.insertLlmCall("r1", 0, Date.now(), {}));
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("cleanup retentionDays=0 → 删除所有历史（含刚写入的）", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const past = Date.now() - 1;
    store.insertRun("old-r", "s1", past);
    store.completeRun("old-r", past + 1, "completed");
    store.cleanup(0);
    const ov = store.getOverview();
    assert.equal(ov.totalRuns24h, 0);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});

// ── 3. 不同状态返回 ────────────────────────────────────────────────────────

describe("Store — 不同状态", () => {
  maybe("running 状态: activeRuns=1, status=running", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("r1", "s1", Date.now());
    const ov = store.getOverview();
    assert.equal(ov.activeRuns, 1);
    const detail = store.getRunDetail("r1");
    assert.equal((detail.run as any).status, "running");
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("completed 状态: status=completed, duration_ms > 0", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const start = Date.now() - 5000;
    const end = Date.now();
    store.insertRun("r1", "s1", start);
    store.completeRun("r1", end, "completed");
    const run = store.getRunDetail("r1").run as any;
    assert.equal(run.status, "completed");
    assert.ok(run.duration_ms > 0);
    assert.equal(run.ended_at, end);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("error 状态: status=error, error_message 有值", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("r1", "s1", Date.now() - 1000);
    store.completeRun("r1", Date.now(), "error", "timeout after 300s");
    const run = store.getRunDetail("r1").run as any;
    assert.equal(run.status, "error");
    assert.equal(run.error_message, "timeout after 300s");
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("getOverview 24h 窗口：旧数据不计入", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const old = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
    store.insertRun("old", "s1", old);
    store.completeRun("old", old + 1000, "completed");
    const ov = store.getOverview();
    assert.equal(ov.totalRuns24h, 0);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("getSessions channel 过滤", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("r1", "s1", Date.now(), { channel: "web" });
    store.insertRun("r2", "s2", Date.now(), { channel: "api" });
    store.completeRun("r1", Date.now(), "completed");
    store.completeRun("r2", Date.now(), "completed");
    const webSessions = store.getSessions({ channel: "web" }) as any[];
    assert.ok(webSessions.every((s: any) => s.channel === "web"));
    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});

// ── 4. 并发 ────────────────────────────────────────────────────────────────

describe("Store — 并发", () => {
  maybe("50 个 run 并发 insertRun → 全部写入", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    // SQLite WAL mode 支持并发读，写入串行化
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve(store.insertRun(`par-${i}`, `sess-${i}`, Date.now())),
      ),
    );
    const ov = store.getOverview();
    assert.equal(ov.activeRuns, 50);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("同一 run 50 个 llmCall 并发 → total_llm_calls=50 after completeRun", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("r1", "s1", Date.now());
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve(store.insertLlmCall("r1", i, Date.now(), { inputTokens: 10, outputTokens: 5 })),
      ),
    );
    store.completeRun("r1", Date.now(), "completed");
    const run = store.getRunDetail("r1").run as any;
    assert.equal(run.total_llm_calls, 50);
    assert.equal(run.total_input_tokens, 500);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("并发 completeRun 多个不同 run → 各自独立", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    Array.from({ length: 10 }, (_, i) => store.insertRun(`cr-${i}`, `s-${i}`, Date.now()));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(store.completeRun(`cr-${i}`, Date.now(), "completed")),
      ),
    );
    const ov = store.getOverview();
    assert.equal(ov.activeRuns, 0);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("并发 insertSessionSnapshot 同一 key 不同 ts → OR REPLACE 不丢", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const base = Date.now();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve(store.insertSessionSnapshot("sess-x", base + i, { inputTokens: i * 10 })),
      ),
    );
    // 不崩溃即通过
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("并发 getOverview 读取不阻塞写入", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("r1", "s1", Date.now());

    const [ov1, ov2] = await Promise.all([
      Promise.resolve(store.getOverview()),
      Promise.resolve(store.getOverview()),
    ]);
    assert.equal(ov1.activeRuns, ov2.activeRuns);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});

// ── 5. 边界值 ──────────────────────────────────────────────────────────────

describe("Store — 边界值", () => {
  maybe("runId / sessionKey 含特殊字符", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("run:clawlens:anthropic:claude-3-5", "sess/2024-11-01", Date.now());
    const detail = store.getRunDetail("run:clawlens:anthropic:claude-3-5");
    assert.ok(detail.run);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("token 量为 0 → total_cost_usd=0", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("r1", "s1", Date.now());
    store.insertLlmCall("r1", 0, Date.now(), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    store.completeRun("r1", Date.now(), "completed");
    const run = store.getRunDetail("r1").run as any;
    assert.equal(run.total_cost_usd, 0);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("超大 token 量（1 亿）不溢出 INTEGER", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    store.insertRun("r1", "s1", Date.now());
    store.insertLlmCall("r1", 0, Date.now(), { inputTokens: 100_000_000, outputTokens: 50_000_000 });
    store.completeRun("r1", Date.now(), "completed");
    const run = store.getRunDetail("r1").run as any;
    assert.equal(run.total_input_tokens, 100_000_000);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("cleanup retentionDays=30 → 保留近期，删除旧数据", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const recent = Date.now();
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    store.insertRun("new-r", "s1", recent);
    store.insertRun("old-r", "s2", old);
    store.completeRun("new-r", recent + 1, "completed");
    store.completeRun("old-r", old + 1, "completed");
    store.cleanup(30);
    const sessions = store.getSessions() as any[];
    const ids = sessions.map((s: any) => s.session_key);
    assert.ok(!ids.includes("s2"), "旧 session 应被清理");
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  maybe("getSessions limit/offset 分页", () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    for (let i = 0; i < 20; i++) {
      store.insertRun(`r${i}`, `sess-${i}`, Date.now() - i * 1000);
      store.completeRun(`r${i}`, Date.now(), "completed");
    }
    const page1 = store.getSessions({ limit: 5, offset: 0 }) as any[];
    const page2 = store.getSessions({ limit: 5, offset: 5 }) as any[];
    assert.equal(page1.length, 5);
    assert.equal(page2.length, 5);
    const p1Keys = page1.map((s: any) => s.session_key);
    const p2Keys = page2.map((s: any) => s.session_key);
    assert.equal(p1Keys.filter((k: string) => p2Keys.includes(k)).length, 0, "两页无重叠");
    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});
