import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { SSEManager } from "../src/sse-manager.js";
import { registerApiRoutes } from "../src/api-routes.js";
import { serializePreviewForTextColumn } from "../src/structured-preview.js";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawlens-api-routes-"));
}

function makeApiHarness(token = "test-token", gatewayToken?: string) {
  let handler: any;
  const api = {
    config: {
      auth: token ? { token } : {},
      gateway: gatewayToken ? { auth: { token: gatewayToken } } : {},
    },
    registerHttpRoute(route: any) {
      handler = route.handler;
    },
  };
  return {
    api,
    getHandler() {
      if (!handler) throw new Error("handler not registered");
      return handler;
    },
  };
}

function makeReq(url: string, token?: string) {
  return {
    url,
    method: "GET",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    on() {},
  } as any;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body = String(body);
    },
  } as any;
}

describe("api-routes", () => {
  test("audit session shapes hasSourceLookup false when lookup disabled", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const sse = new SSEManager();
    const { api, getHandler } = makeApiHarness();
    registerApiRoutes(api as any, store, sse, {
      collector: {
        sourceLookupEnabled: false,
        sourceLookupDirs: [dir],
      },
    });

    const ts = Date.now();
    store.insertRun("r1", "sess-1", ts);
    store.insertLlmCall("r1", 0, ts, { userPromptPreview: serializePreviewForTextColumn({ text: "hello" }) });
    store.insertConversationTurn("r1", "sess-1", 0, "user", serializePreviewForTextColumn({ text: "hello" }), 5, ts, {
      messageId: "msg-1",
      sessionFile: path.join(dir, "11111111-1111-1111-1111-111111111111.jsonl"),
      sourceKind: "transcript_explicit",
    });
    const res = makeRes();
    await getHandler()(makeReq("/plugins/clawlens/api/audit/session/sess-1", "test-token"), res);
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.runs[0].turns[0].hasSourceLookup, false);

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("audit session shapes hasSourceLookup false when lookup enabled but no trusted root exists", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const sse = new SSEManager();
    const { api, getHandler } = makeApiHarness();
    registerApiRoutes(api as any, store, sse, {
      collector: {
        sourceLookupEnabled: true,
        sourceLookupDirs: [],
      },
    });

    const ts = Date.now();
    store.insertRun("r1", "sess-1", ts);
    store.insertLlmCall("r1", 0, ts, { userPromptPreview: serializePreviewForTextColumn({ text: "hello" }) });
    store.insertConversationTurn("r1", "sess-1", 0, "user", serializePreviewForTextColumn({ text: "hello" }), 5, ts, {
      messageId: "msg-1",
      sessionFile: "/nonexistent-root/11111111-1111-1111-1111-111111111111.jsonl",
      sourceKind: "transcript_explicit",
    });
    const res = makeRes();
    await getHandler()(makeReq("/plugins/clawlens/api/audit/session/sess-1", "test-token"), res);
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.runs[0].turns[0].hasSourceLookup, false);

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("audit run tool timeline keeps hasSourceLookup false when run has no trusted transcript file", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const sse = new SSEManager();
    const { api, getHandler } = makeApiHarness();
    registerApiRoutes(api as any, store, sse, {
      collector: {
        sourceLookupEnabled: true,
        sourceLookupDirs: [dir],
      },
    });

    const ts = Date.now();
    store.insertRun("r1", "sess-1", ts);
    store.insertToolExecution("r1", "tool-1", "read", ts, {
      argsSummary: serializePreviewForTextColumn({ path: "/tmp/a.txt" }),
      resultSummary: serializePreviewForTextColumn({ ok: true }),
    });
    store.completeRun("r1", ts + 5, "completed");

    const res = makeRes();
    await getHandler()(makeReq("/plugins/clawlens/api/audit/run/r1", "test-token"), res);
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.timeline[0].type, "tool_execution");
    assert.equal(body.timeline[0].hasSourceLookup, false);

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("source route returns 403 when token not configured for source access", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const sse = new SSEManager();
    const { api, getHandler } = makeApiHarness("");
    registerApiRoutes(api as any, store, sse, {
      collector: {
        sourceLookupEnabled: true,
        sourceLookupDirs: [dir],
      },
    });

    const ts = Date.now();
    store.insertRun("r1", "sess-1", ts);
    store.insertConversationTurn("r1", "sess-1", 0, "user", "preview", 7, ts, {
      messageId: "msg-1",
      sessionFile: path.join(dir, "11111111-1111-1111-1111-111111111111.jsonl"),
      sourceKind: "transcript_explicit",
    });
    const res = makeRes();
    await getHandler()(makeReq("/plugins/clawlens/api/audit/source/message/msg-1"), res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /requires configured auth token/);

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("preview-only route remains open when only gateway auth token exists", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const sse = new SSEManager();
    const { api, getHandler } = makeApiHarness("", "gateway-token");
    registerApiRoutes(api as any, store, sse, {
      collector: {
        sourceLookupEnabled: true,
        sourceLookupDirs: [dir],
      },
    });

    const res = makeRes();
    await getHandler()(makeReq("/plugins/clawlens/api/overview"), res);
    assert.equal(res.statusCode, 200);

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("source route accepts gateway auth token as fallback auth boundary", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const sse = new SSEManager();
    const { api, getHandler } = makeApiHarness("", "gateway-token");
    registerApiRoutes(api as any, store, sse, {
      collector: {
        sourceLookupEnabled: true,
        sourceLookupDirs: [dir],
      },
    });

    const ts = Date.now();
    const sessionFile = path.join(dir, "11111111-1111-1111-1111-111111111111.jsonl");
    fs.writeFileSync(sessionFile, `${JSON.stringify({ id: "msg-1", role: "user", content: "hello" })}\n`, "utf8");
    store.insertRun("r1", "sess-1", ts);
    store.insertConversationTurn("r1", "sess-1", 0, "user", "preview", 7, ts, {
      messageId: "msg-1",
      sessionFile,
      sourceKind: "transcript_explicit",
    });
    const res = makeRes();
    await getHandler()(makeReq("/plugins/clawlens/api/audit/source/message/msg-1", "gateway-token"), res);
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.payload.id, "msg-1");

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("source message route returns typed miss as 200 when lookup fails", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const sse = new SSEManager();
    const { api, getHandler } = makeApiHarness();
    registerApiRoutes(api as any, store, sse, {
      collector: {
        sourceLookupEnabled: true,
        sourceLookupDirs: [dir],
      },
    });

    const ts = Date.now();
    store.insertRun("r1", "sess-1", ts);
    store.insertConversationTurn("r1", "sess-1", 0, "user", "preview", 7, ts, {
      messageId: "msg-1",
      sessionFile: path.join(dir, "11111111-1111-1111-1111-111111111111.jsonl"),
      sourceKind: "transcript_explicit",
    });
    const res = makeRes();
    await getHandler()(makeReq("/plugins/clawlens/api/audit/source/message/msg-1", "test-token"), res);
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, false);

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("source message route returns source payload when file exists", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const sse = new SSEManager();
    const { api, getHandler } = makeApiHarness();
    registerApiRoutes(api as any, store, sse, {
      collector: {
        sourceLookupEnabled: true,
        sourceLookupDirs: [dir],
      },
    });

    const ts = Date.now();
    const sessionFile = path.join(dir, "11111111-1111-1111-1111-111111111111.jsonl");
    fs.writeFileSync(sessionFile, `${JSON.stringify({ id: "msg-1", role: "user", content: "hello" })}\n`, "utf8");
    store.insertRun("r1", "sess-1", ts);
    store.insertConversationTurn("r1", "sess-1", 0, "user", "preview", 7, ts, {
      messageId: "msg-1",
      sessionFile,
      sourceKind: "transcript_explicit",
    });
    const res = makeRes();
    await getHandler()(makeReq("/plugins/clawlens/api/audit/source/message/msg-1", "test-token"), res);
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.payload.id, "msg-1");

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("source tool route returns payload when tool transcript exists", async () => {
    const dir = makeTmpDir();
    const store = new Store(dir);
    const sse = new SSEManager();
    const { api, getHandler } = makeApiHarness();
    registerApiRoutes(api as any, store, sse, {
      collector: {
        sourceLookupEnabled: true,
        sourceLookupDirs: [dir],
      },
    });

    const ts = Date.now();
    const sessionFile = path.join(dir, "12121212-1212-1212-1212-121212121212.jsonl");
    fs.writeFileSync(sessionFile, [
      JSON.stringify({
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", toolCallId: "tool-1", toolName: "read" }],
      }),
      JSON.stringify({
        id: "tool-1-result",
        role: "tool",
        toolCallId: "tool-1",
        content: "done",
      }),
    ].join("\n") + "\n", "utf8");

    store.insertRun("r1", "sess-1", ts);
    store.insertToolExecution("r1", "tool-1", "read", ts, {
      argsSummary: serializePreviewForTextColumn({ path: "/tmp/a.txt" }),
    });
    store.insertConversationTurn("r1", "sess-1", 0, "assistant", "preview", 7, ts, {
      messageId: "msg-tool",
      sessionFile,
      sourceKind: "transcript_explicit",
    });

    const res = makeRes();
    await getHandler()(makeReq("/plugins/clawlens/api/audit/source/tool/r1/tool-1", "test-token"), res);
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.toolCallId, "tool-1");
    assert.ok(body.toolCall);
    assert.ok(body.toolResult);

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
