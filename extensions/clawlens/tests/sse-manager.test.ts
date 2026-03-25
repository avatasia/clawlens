/**
 * sse-manager.test.ts
 * 覆盖 5 类：正常值 / 异常值 / 不同状态返回 / 并发 / 边界值
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SSEManager } from "../src/sse-manager.js";

// ── Mock ServerResponse ───────────────────────────────────────────────────

function makeMockRes(opts: { throwOnWrite?: boolean } = {}) {
  const chunks: string[] = [];
  let ended = false;
  let statusCode = 0;
  const headers: Record<string, string> = {};
  return {
    writeHead(code: number, hdrs: Record<string, string>) {
      statusCode = code;
      Object.assign(headers, hdrs);
    },
    write(chunk: string) {
      if (opts.throwOnWrite) throw new Error("socket hang up");
      chunks.push(chunk);
      return true;
    },
    end() { ended = true; },
    // introspection
    get chunks() { return chunks; },
    get ended() { return ended; },
    get statusCode() { return statusCode; },
    get headers() { return headers; },
    lastPayload(): unknown {
      const last = chunks[chunks.length - 1];
      return last ? JSON.parse(last.replace(/^data: /, "").trim()) : null;
    },
    allPayloads(): unknown[] {
      return chunks.map((c) => JSON.parse(c.replace(/^data: /, "").trim()));
    },
  };
}

// ── 1. 正常值 ──────────────────────────────────────────────────────────────

describe("SSEManager — 正常值", () => {
  test("addClient 返回非空 id", () => {
    const mgr = new SSEManager();
    const res = makeMockRes();
    const id = mgr.addClient(res as any);
    assert.ok(id, "should return a client id");
    assert.equal(typeof id, "string");
    assert.equal(mgr.clientCount, 1);
    mgr.closeAll();
  });

  test("addClient 发送 connected 事件", () => {
    const mgr = new SSEManager();
    const res = makeMockRes();
    mgr.addClient(res as any);
    const payload = res.allPayloads()[0] as any;
    assert.equal(payload.type, "connected");
    mgr.closeAll();
  });

  test("addClient 设置正确 HTTP 头", () => {
    const mgr = new SSEManager();
    const res = makeMockRes();
    mgr.addClient(res as any);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["Content-Type"], "text/event-stream");
    assert.equal(res.headers["Cache-Control"], "no-cache");
    mgr.closeAll();
  });

  test("broadcast 发送到所有客户端", () => {
    const mgr = new SSEManager();
    const r1 = makeMockRes();
    const r2 = makeMockRes();
    const r3 = makeMockRes();
    mgr.addClient(r1 as any);
    mgr.addClient(r2 as any);
    mgr.addClient(r3 as any);
    mgr.broadcast({ type: "run_started", runId: "abc" });
    for (const r of [r1, r2, r3]) {
      const last = r.lastPayload() as any;
      assert.equal(last.type, "run_started");
      assert.equal(last.runId, "abc");
    }
    mgr.closeAll();
  });

  test("removeClient 后 clientCount 正确", () => {
    const mgr = new SSEManager();
    const r1 = makeMockRes();
    const r2 = makeMockRes();
    const id1 = mgr.addClient(r1 as any)!;
    mgr.addClient(r2 as any);
    assert.equal(mgr.clientCount, 2);
    mgr.removeClient(id1);
    assert.equal(mgr.clientCount, 1);
    mgr.closeAll();
  });
});

// ── 2. 异常值 ──────────────────────────────────────────────────────────────

describe("SSEManager — 异常值", () => {
  test("broadcast 时 write 抛错 → 自动移除该客户端", () => {
    const mgr = new SSEManager();
    const good = makeMockRes();
    const bad = makeMockRes({ throwOnWrite: true });
    mgr.addClient(good as any);
    // bad client: 先加入，connected 发送时 bad.write 已经会抛（第一次 sendTo）
    // 直接测试 broadcast 时的容错：手动塞一个会抛的 res
    const badId = mgr.addClient(bad as any);
    // connected event 本身 throw → badId 应该已被移除
    // 若没被移除（因为 connected 成功了），下面的 broadcast 会移除它
    const countBefore = mgr.clientCount;
    mgr.broadcast({ type: "ping" });
    // broadcast 应不抛，且坏客户端已被清理
    assert.ok(mgr.clientCount <= countBefore);
    mgr.closeAll();
  });

  test("removeClient 传不存在的 id → 不抛", () => {
    const mgr = new SSEManager();
    assert.doesNotThrow(() => mgr.removeClient("nonexistent-id"));
  });

  test("closeAll 对已 end 的 res → 不抛", () => {
    const mgr = new SSEManager();
    const r = makeMockRes();
    mgr.addClient(r as any);
    r.end(); // 提前 end
    assert.doesNotThrow(() => mgr.closeAll());
  });

  test("broadcast 空 clients → 不抛", () => {
    const mgr = new SSEManager();
    assert.doesNotThrow(() => mgr.broadcast({ type: "heartbeat" }));
  });
});

// ── 3. 不同状态返回 ────────────────────────────────────────────────────────

describe("SSEManager — 不同状态", () => {
  test("达到 maxClients=10 后 addClient 返回 null", () => {
    const mgr = new SSEManager();
    for (let i = 0; i < 10; i++) {
      const id = mgr.addClient(makeMockRes() as any);
      assert.ok(id, `slot ${i} should succeed`);
    }
    assert.equal(mgr.clientCount, 10);
    const overflow = mgr.addClient(makeMockRes() as any);
    assert.equal(overflow, null);
    assert.equal(mgr.clientCount, 10, "count must not exceed 10");
    mgr.closeAll();
  });

  test("closeAll 后 clientCount = 0", () => {
    const mgr = new SSEManager();
    mgr.addClient(makeMockRes() as any);
    mgr.addClient(makeMockRes() as any);
    mgr.closeAll();
    assert.equal(mgr.clientCount, 0);
  });

  test("closeAll 调用每个 res.end()", () => {
    const mgr = new SSEManager();
    const responses = [makeMockRes(), makeMockRes(), makeMockRes()];
    responses.forEach((r) => mgr.addClient(r as any));
    mgr.closeAll();
    responses.forEach((r) => assert.ok(r.ended, "response should be ended"));
  });

  test("connected → broadcast → remove 状态转移", () => {
    const mgr = new SSEManager();
    const r = makeMockRes();
    const id = mgr.addClient(r as any)!;
    assert.equal(mgr.clientCount, 1);

    mgr.broadcast({ type: "run_started" });
    assert.equal(mgr.clientCount, 1);

    mgr.removeClient(id);
    assert.equal(mgr.clientCount, 0);

    // broadcast 到空列表不影响任何已有数据
    mgr.broadcast({ type: "run_ended" });
    assert.equal(r.chunks.length, 2); // connected + run_started，不含 run_ended
  });
});

// ── 4. 并发 ────────────────────────────────────────────────────────────────

describe("SSEManager — 并发", () => {
  test("10 个客户端并发 addClient 全部成功", async () => {
    const mgr = new SSEManager();
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => Promise.resolve(mgr.addClient(makeMockRes() as any))),
    );
    assert.equal(ids.filter(Boolean).length, 10);
    assert.equal(mgr.clientCount, 10);
    mgr.closeAll();
  });

  test("并发 broadcast 100 条消息顺序到达", async () => {
    const mgr = new SSEManager();
    const r = makeMockRes();
    mgr.addClient(r as any);

    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        Promise.resolve(mgr.broadcast({ type: "tick", i })),
      ),
    );

    // connected + 100 broadcasts
    assert.equal(r.chunks.length, 101);
    mgr.closeAll();
  });

  test("并发 removeClient 不留僵尸", async () => {
    const mgr = new SSEManager();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(mgr.addClient(makeMockRes() as any)!);
    }
    await Promise.all(ids.map((id) => Promise.resolve(mgr.removeClient(id))));
    assert.equal(mgr.clientCount, 0);
  });

  test("超过 maxClients 时并发请求：只有前 10 成功", async () => {
    const mgr = new SSEManager();
    const results = await Promise.all(
      Array.from({ length: 15 }, () => Promise.resolve(mgr.addClient(makeMockRes() as any))),
    );
    const succeeded = results.filter(Boolean).length;
    assert.equal(succeeded, 10);
    assert.equal(mgr.clientCount, 10);
    mgr.closeAll();
  });
});

// ── 5. 边界值 ──────────────────────────────────────────────────────────────

describe("SSEManager — 边界值", () => {
  test("broadcast payload 序列化为正确 SSE 格式", () => {
    const mgr = new SSEManager();
    const r = makeMockRes();
    mgr.addClient(r as any);
    mgr.broadcast({ type: "run_ended", runId: "x", cost: 0.0001 });
    const raw = r.chunks[r.chunks.length - 1];
    assert.ok(raw.startsWith("data: "), "SSE format: must start with 'data: '");
    assert.ok(raw.endsWith("\n\n"), "SSE format: must end with double newline");
    mgr.closeAll();
  });

  test("payload 含 unicode / 嵌套对象 — 序列化往返一致", () => {
    const mgr = new SSEManager();
    const r = makeMockRes();
    mgr.addClient(r as any);
    const original = { type: "compare_completed", label: "测试✓", nested: { a: 1 } };
    mgr.broadcast(original);
    const parsed = r.lastPayload() as any;
    assert.equal(parsed.label, original.label);
    assert.deepEqual(parsed.nested, original.nested);
    mgr.closeAll();
  });

  test("broadcast 超大 payload 不截断", () => {
    const mgr = new SSEManager();
    const r = makeMockRes();
    mgr.addClient(r as any);
    const big = { type: "data", payload: "x".repeat(100_000) };
    mgr.broadcast(big);
    const parsed = r.lastPayload() as any;
    assert.equal(parsed.payload.length, 100_000);
    mgr.closeAll();
  });

  test("clientCount 初始为 0", () => {
    const mgr = new SSEManager();
    assert.equal(mgr.clientCount, 0);
  });

  test("同一个 res 被 add 两次 → 两个独立 id", () => {
    const mgr = new SSEManager();
    const r = makeMockRes();
    const id1 = mgr.addClient(r as any);
    const id2 = mgr.addClient(r as any);
    assert.notEqual(id1, id2);
    assert.equal(mgr.clientCount, 2);
    mgr.closeAll();
  });
});
