/**
 * collector.test.ts
 * 覆盖 5 类：正常值 / 异常值 / 不同状态返回 / 并发 / 边界值
 *
 * Store 作为 mock 注入，不依赖 node:sqlite。
 * 利用 collector.stop() 同步 flush 队列来断言写入。
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Collector } from "../src/collector.js";

// ── Mock Store ────────────────────────────────────────────────────────────

type Call = { method: string; args: unknown[] };

function makeMockStore() {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) =>
      calls.push({ method, args });

  return {
    insertRun: record("insertRun"),
    completeRun: record("completeRun"),
    insertLlmCall: record("insertLlmCall"),
    insertToolExecution: record("insertToolExecution"),
    insertConversationTurn: record("insertConversationTurn"),
    insertSessionSnapshot: record("insertSessionSnapshot"),
    updateRunSessionKey: record("updateRunSessionKey"),
    getOverview: () => ({ activeRuns: 0, totalRuns24h: 0, totalTokens24h: 0, totalCost24h: 0 }),
    getSessions: () => [],
    getRunDetail: () => ({ run: null, llmCalls: [], toolExecutions: [] }),
    cleanup: record("cleanup"),
    close: record("close"),
    // introspection
    calls,
    callsOf: (method: string) => calls.filter((c) => c.method === method),
  };
}

// ── Mock SSEManager ───────────────────────────────────────────────────────

function makeMockSSE() {
  const broadcasts: unknown[] = [];
  return {
    broadcast: (payload: unknown) => broadcasts.push(payload),
    addClient: () => "mock-id",
    removeClient: () => {},
    closeAll: () => {},
    clientCount: 0,
    broadcasts,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makeCollector() {
  const store = makeMockStore();
  const sse = makeMockSSE();
  const collector = new Collector(store as any, sse as any);
  return { collector, store, sse };
}

function lifecycleEvent(
  phase: "start" | "end" | "error",
  overrides: Record<string, unknown> = {},
) {
  return {
    stream: "lifecycle",
    runId: "run-001",
    sessionKey: "sess-001",
    agentId: "agent-001",
    channelId: "ch-001",
    ts: Date.now(),
    data: { phase, startedAt: Date.now() - 1000, endedAt: Date.now(), error: "boom", ...overrides },
  };
}

// ── 1. 正常值 ──────────────────────────────────────────────────────────────

describe("Collector — 正常值", () => {
  test("phase=start → insertRun + broadcast run_started", () => {
    const { collector, store, sse } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.stop();

    const runs = store.callsOf("insertRun");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].args[0], "run-001"); // runId
    assert.equal(runs[0].args[1], "sess-001"); // sessionKey

    const started = sse.broadcasts.filter((b: any) => b.type === "run_started");
    assert.equal(started.length, 1);
  });

  test("phase=end → completeRun + broadcast run_ended (status=completed)", () => {
    const { collector, store, sse } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.handleAgentEvent(lifecycleEvent("end"));
    collector.stop();

    const completed = store.callsOf("completeRun");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].args[2], "completed");

    const ended = sse.broadcasts.filter((b: any) => b.type === "run_ended" && (b as any).status === "completed");
    assert.equal(ended.length, 1);
  });

  test("recordLlmCall → insertLlmCall + broadcast llm_call", () => {
    const { collector, store, sse } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.recordLlmOutput(
      { runId: "run-001", provider: "openai", model: "gpt-4o", usage: { input: 100, output: 50 } },
      { sessionKey: "sess-001" },
    );
    collector.stop();

    assert.equal(store.callsOf("insertLlmCall").length, 1);
    const llmBroadcasts = sse.broadcasts.filter((b: any) => b.type === "llm_call");
    assert.equal(llmBroadcasts.length, 1);
  });

  test("llm duration 由 llm_input 到 llm_output 的时间差计算", () => {
    const { collector, store } = makeCollector();
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      collector.handleAgentEvent(lifecycleEvent("start"));
      now = 2_000;
      collector.recordLlmInput({ runId: "run-001", prompt: "hello" }, {});
      now = 2_650;
      collector.recordLlmOutput({ runId: "run-001", usage: { input: 1, output: 1 } }, {});
      collector.stop();
    } finally {
      Date.now = originalNow;
    }

    const calls = store.callsOf("insertLlmCall");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[2], 2_000);
    const opts = calls[0].args[3] as { endedAt?: number; durationMs?: number };
    assert.equal(opts.endedAt, 2_650);
    assert.equal(opts.durationMs, 650);
  });

  test("lifecycle end 先到时仍可用 llm_input 时间计算 llm duration", () => {
    const { collector, store } = makeCollector();
    const originalNow = Date.now;
    let now = 10_000;
    Date.now = () => now;
    try {
      collector.handleAgentEvent(lifecycleEvent("start"));
      now = 11_000;
      collector.recordLlmInput({ runId: "run-001", prompt: "hello" }, {});
      now = 11_100;
      collector.handleAgentEvent(lifecycleEvent("end", { endedAt: now }));
      now = 11_450;
      collector.recordLlmOutput({ runId: "run-001", usage: { input: 3, output: 5 } }, {});
      collector.stop();
    } finally {
      Date.now = originalNow;
    }

    const calls = store.callsOf("insertLlmCall");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[2], 11_000);
    const opts = calls[0].args[3] as { endedAt?: number; durationMs?: number };
    assert.equal(opts.endedAt, 11_450);
    assert.equal(opts.durationMs, 450);
  });

  test("recordToolCall → insertToolExecution + broadcast tool_executed", () => {
    const { collector, store, sse } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.recordToolCall(
      { toolName: "bash", toolCallId: "tc-1", params: { cmd: "ls" }, durationMs: 42 },
      { runId: "run-001" } as any,
    );
    collector.stop();

    assert.equal(store.callsOf("insertToolExecution").length, 1);
    const toolBroadcasts = sse.broadcasts.filter((b: any) => b.type === "tool_executed");
    assert.equal(toolBroadcasts.length, 1);
  });

  test("llmCallIndex 在同一 run 内递增", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.recordLlmOutput({ runId: "run-001", usage: {} }, {});
    collector.recordLlmOutput({ runId: "run-001", usage: {} }, {});
    collector.recordLlmOutput({ runId: "run-001", usage: {} }, {});
    collector.stop();

    const calls = store.callsOf("insertLlmCall");
    assert.equal(calls.length, 3);
    assert.equal(calls[0].args[1], 0);
    assert.equal(calls[1].args[1], 1);
    assert.equal(calls[2].args[1], 2);
  });
});

// ── 2. 异常值 ──────────────────────────────────────────────────────────────

describe("Collector — 异常值", () => {
  test("非 lifecycle stream → 忽略", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent({ stream: "assistant", data: { text: "hello" } });
    collector.stop();
    assert.equal(store.calls.length, 0);
  });

  test("lifecycle 事件无 phase → 忽略", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent({ stream: "lifecycle", data: {} });
    collector.stop();
    assert.equal(store.calls.length, 0);
  });

  test("phase=end 但 runId 缺失 → 不写入", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent({ stream: "lifecycle", data: { phase: "end" } });
    collector.stop();
    assert.equal(store.callsOf("completeRun").length, 0);
  });

  test("recordLlmCall runId 缺失 → 不写入", () => {
    const { collector, store } = makeCollector();
    collector.recordLlmOutput({ usage: { input: 100 } }, {});
    collector.stop();
    assert.equal(store.callsOf("insertLlmCall").length, 0);
  });

  test("phase=error → completeRun status=error + errorMessage", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.handleAgentEvent(lifecycleEvent("error", { error: "timeout" }));
    collector.stop();

    const completed = store.callsOf("completeRun");
    assert.equal(completed[0].args[2], "error");
    assert.equal(completed[0].args[3], "timeout");
  });

  test("store 写入抛错 → 不影响后续队列", () => {
    const store = makeMockStore();
    let callCount = 0;
    store.insertRun = (..._args: unknown[]) => {
      callCount++;
      if (callCount === 1) throw new Error("DB write error");
      store.calls.push({ method: "insertRun", args: _args });
    };
    const sse = makeMockSSE();
    const collector = new Collector(store as any, sse as any);

    collector.handleAgentEvent(lifecycleEvent("start", { ...{}, runId: "run-a" }));
    collector.handleAgentEvent({ ...lifecycleEvent("start"), runId: "run-b" });
    collector.stop();

    // run-b's insertRun should still have been attempted
    assert.ok(callCount >= 2);
  });
});

// ── 3. 不同状态返回 ────────────────────────────────────────────────────────

describe("Collector — 不同状态", () => {
  test("running 状态: start 后未 end → completeRun 未被调用", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.stop();
    assert.equal(store.callsOf("completeRun").length, 0);
    assert.equal(store.callsOf("insertRun").length, 1);
  });

  test("completed 状态: start → end 序列完整", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.handleAgentEvent(lifecycleEvent("end"));
    collector.stop();
    assert.equal(store.callsOf("insertRun").length, 1);
    assert.equal(store.callsOf("completeRun").length, 1);
    assert.equal(store.callsOf("completeRun")[0].args[2], "completed");
  });

  test("error 状态: start → error 序列", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.handleAgentEvent(lifecycleEvent("error"));
    collector.stop();
    assert.equal(store.callsOf("completeRun")[0].args[2], "error");
  });

  test("同一 runId 重复 start → insertRun 只写一次（OR IGNORE 语义）", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.handleAgentEvent(lifecycleEvent("start")); // duplicate
    collector.stop();
    assert.equal(store.callsOf("insertRun").length, 2); // 两次 enqueue，store 层用 OR IGNORE 去重
  });

  test("tool 执行结果 isError=true 正确传递", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.recordToolCall(
      { toolName: "bash", toolCallId: "tc-err", error: "err", durationMs: 5 },
      { runId: "run-001" } as any,
    );
    collector.stop();
    const toolCalls = store.callsOf("insertToolExecution");
    assert.equal(toolCalls.length, 1);
    const opts = toolCalls[0].args[4] as any;
    assert.equal(opts.isError, true);
  });
});

// ── 4. 并发 ────────────────────────────────────────────────────────────────

describe("Collector — 并发", () => {
  test("50 个 run 的 start 事件并发写入 → 50 条 insertRun", async () => {
    const { collector, store } = makeCollector();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve(
          collector.handleAgentEvent({
            stream: "lifecycle",
            runId: `run-${i}`,
            sessionKey: `sess-${i}`,
            ts: Date.now(),
            data: { phase: "start", startedAt: Date.now() },
          }),
        ),
      ),
    );
    collector.stop();
    assert.equal(store.callsOf("insertRun").length, 50);
  });

  test("同一 run 的 50 个 llmCall 并发 → 50 条 insertLlmCall，index 各异", async () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    await Promise.all(
      Array.from({ length: 50 }, () =>
        Promise.resolve(
          collector.recordLlmOutput(
            { runId: "run-001", usage: { input: 10, output: 5 } },
            { sessionKey: "sess-001" },
          ),
        ),
      ),
    );
    collector.stop();
    const llmCalls = store.callsOf("insertLlmCall");
    assert.equal(llmCalls.length, 50);
    const indices = llmCalls.map((c) => c.args[1] as number);
    const unique = new Set(indices);
    assert.equal(unique.size, 50, "每个 llmCall 应有唯一 index");
  });

  test("start+llm+tool+end 四类事件并发交错 → 各自恰好写入", async () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    await Promise.all([
      Promise.resolve(collector.recordLlmOutput({ runId: "run-001", usage: { input: 100 } }, {})),
      Promise.resolve(collector.recordLlmOutput({ runId: "run-001", usage: { input: 200 } }, {})),
      Promise.resolve(
        collector.recordToolCall({ toolName: "read", toolCallId: "t1", durationMs: 10 }, { runId: "run-001" } as any),
      ),
      Promise.resolve(
        collector.recordToolCall({ toolName: "write", toolCallId: "t2", durationMs: 20 }, { runId: "run-001" } as any),
      ),
    ]);
    collector.handleAgentEvent(lifecycleEvent("end"));
    collector.stop();

    assert.equal(store.callsOf("insertRun").length, 1);
    assert.equal(store.callsOf("insertLlmCall").length, 2);
    assert.equal(store.callsOf("insertToolExecution").length, 2);
    assert.equal(store.callsOf("completeRun").length, 1);
  });

  test("10 个不同 run 并发 start → end → 各自 complete", async () => {
    const { collector, store } = makeCollector();
    await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const runId = `run-par-${i}`;
        collector.handleAgentEvent({
          stream: "lifecycle",
          runId,
          sessionKey: `sess-${i}`,
          ts: Date.now(),
          data: { phase: "start", startedAt: Date.now() },
        });
        collector.handleAgentEvent({
          stream: "lifecycle",
          runId,
          ts: Date.now(),
          data: { phase: "end", endedAt: Date.now() },
        });
      }),
    );
    collector.stop();
    assert.equal(store.callsOf("insertRun").length, 10);
    assert.equal(store.callsOf("completeRun").length, 10);
    store.callsOf("completeRun").forEach((c) => assert.equal(c.args[2], "completed"));
  });
});

// ── 5. 边界值 ──────────────────────────────────────────────────────────────

describe("Collector — 边界值", () => {
  test("tool args/result 截断到 200 字符", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.recordToolCall(
      {
        toolName: "bash",
        toolCallId: "tc-long",
        params: { cmd: "x".repeat(500) },
        result: "y".repeat(500),
        durationMs: 1,
      },
      { runId: "run-001" } as any,
    );
    collector.stop();
    const opts = store.callsOf("insertToolExecution")[0].args[4] as any;
    assert.ok(opts.argsSummary.length <= 200);
    assert.ok(opts.resultSummary.length <= 200);
  });

  test("recordLlmCall 无 usage → insertLlmCall 不崩溃", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.recordLlmOutput({ runId: "run-001" }, {});
    collector.stop();
    assert.equal(store.callsOf("insertLlmCall").length, 1);
  });

  test("recordToolCall durationMs 缺失 → 不崩溃", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.recordToolCall(
      { toolName: "glob", toolCallId: "tc-no-dur" },
      { runId: "run-001" } as any,
    );
    collector.stop();
    assert.equal(store.callsOf("insertToolExecution").length, 1);
  });

  test("1000 个事件入队 → stop() 全量 flush 不丢", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    for (let i = 0; i < 999; i++) {
      collector.recordLlmOutput({ runId: "run-001", usage: { input: 1 } }, {});
    }
    collector.stop();
    assert.equal(store.callsOf("insertLlmCall").length, 999);
  });

  test("stop() 幂等 — 多次调用不重复 flush", () => {
    const { collector, store } = makeCollector();
    collector.handleAgentEvent(lifecycleEvent("start"));
    collector.stop();
    collector.stop();
    assert.equal(store.callsOf("insertRun").length, 1);
  });
});
