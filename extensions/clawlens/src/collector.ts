import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { SSEManager } from "./sse-manager.js";
import { calculateCost, loadCostConfig } from "./cost-calculator.js";
import type { ClawLensConfig } from "./types.js";

type ActiveRun = {
  runId: string;
  sessionKey: string;
  startedAt: number;
  llmCallIndex: number;
  lastUserPrompt?: string;
  systemPromptHash?: string;
};

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

type PendingComplete = {
  endedAt: number;
  status: string;
  errorMessage?: string;
  timer: ReturnType<typeof setTimeout>;
};

export class Collector {
  private activeRuns = new Map<string, ActiveRun>();
  private pendingCompletes = new Map<string, PendingComplete>();
  private sessionIdToRunId = new Map<string, string>();
  private queue: Array<() => void> = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private costMap = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();

  constructor(
    private store: Store,
    private sseManager: SSEManager,
  ) {}

  start(runtime: unknown, globalConfig: unknown, pluginConfig: ClawLensConfig): void {
    this.costMap = loadCostConfig(globalConfig);

    const intervalMs = pluginConfig.collector?.snapshotIntervalMs ?? 60_000;

    this.flushInterval = setInterval(() => {
      this.flush();
    }, 100);
  }

  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    // Flush any pending completions immediately
    for (const [runId, pending] of this.pendingCompletes) {
      clearTimeout(pending.timer);
      this.enqueue(() => {
        this.store.completeRun(runId, pending.endedAt, pending.status, pending.errorMessage);
        this.sseManager.broadcast({ type: "run_ended", runId, endedAt: pending.endedAt, status: pending.status });
      });
    }
    this.pendingCompletes.clear();
    this.flush();
  }

  private flush(): void {
    const ops = this.queue.splice(0);
    for (const op of ops) {
      try {
        op();
      } catch (e) {
        // swallow individual op errors
      }
    }
  }

  private enqueue(op: () => void): void {
    this.queue.push(op);
  }

  handleAgentEvent(evt: {
    runId: string;
    sessionKey?: string;
    stream: string;
    data: Record<string, unknown>;
    ts: number;
    // Note: AgentEventPayload does NOT include agentId/channelId
  }): void {
    if (evt.stream !== "lifecycle") return;
    const data = evt.data ?? {};
    const phase = data.phase as string | undefined;

    if (phase === "start") {
      const runId = evt.runId ?? randomUUID();
      const sessionKey = evt.sessionKey ?? "unknown";
      const startedAt = (data.startedAt as number | undefined) ?? evt.ts ?? Date.now();

      const active: ActiveRun = { runId, sessionKey, startedAt, llmCallIndex: 0 };
      this.activeRuns.set(runId, active);

      this.enqueue(() => {
        this.store.insertRun(runId, sessionKey, startedAt, {
          channel: data.channelId as string | undefined,
          agentId: data.agentId as string | undefined,
        });
        this.sseManager.broadcast({ type: "run_started", runId, sessionKey, startedAt });
      });
    } else if (phase === "end") {
      const runId = evt.runId;
      if (!runId) return;
      this.activeRuns.delete(runId);
      const endedAt = (data.endedAt as number | undefined) ?? evt.ts ?? Date.now();
      this.scheduleComplete(runId, endedAt, "completed");
    } else if (phase === "error") {
      const runId = evt.runId;
      if (!runId) return;
      this.activeRuns.delete(runId);
      const endedAt = evt.ts ?? Date.now();
      const errorMessage = (data.error as string | undefined) ?? "unknown error";
      this.scheduleComplete(runId, endedAt, "error", errorMessage);
    }
  }

  private scheduleComplete(runId: string, endedAt: number, status: string, errorMessage?: string): void {
    // Cancel any existing timer for this run (in case of duplicate events)
    const existing = this.pendingCompletes.get(runId);
    if (existing) clearTimeout(existing.timer);

    // Delay by 800ms to let any trailing llm_output / after_tool_call events flush first
    const timer = setTimeout(() => {
      this.pendingCompletes.delete(runId);
      this.enqueue(() => {
        this.store.completeRun(runId, endedAt, status, errorMessage);
        this.sseManager.broadcast({ type: "run_ended", runId, endedAt, status });
      });
    }, 800);

    this.pendingCompletes.set(runId, { endedAt, status, errorMessage, timer });
  }

  recordLlmCall(
    event: {
      runId?: string;
      sessionId?: string;
      provider?: string;
      model?: string;
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
      stopReason?: string;
      systemPromptHash?: string;
      toolCallsInResponse?: number;
    },
    ctx: { sessionKey?: string; agentId?: string; channelId?: string },
  ): void {
    const runId = event.runId;
    if (!runId) return;

    const active = this.activeRuns.get(runId);
    const callIndex = active ? active.llmCallIndex++ : 0;
    const now = Date.now();

    const costKey = `${event.provider}:${event.model}`;
    const costUsd = calculateCost(
      {
        input: event.usage?.input,
        output: event.usage?.output,
        cacheRead: event.usage?.cacheRead,
        cacheWrite: event.usage?.cacheWrite,
      },
      this.costMap.get(costKey),
    );

    const userPromptPreview = active?.lastUserPrompt;
    const systemPromptHash = active?.systemPromptHash ?? event.systemPromptHash;

    this.enqueue(() => {
      this.store.insertLlmCall(runId, callIndex, now, {
        endedAt: now,
        inputTokens: event.usage?.input,
        outputTokens: event.usage?.output,
        cacheRead: event.usage?.cacheRead,
        cacheWrite: event.usage?.cacheWrite,
        costUsd: costUsd ?? undefined,
        stopReason: event.stopReason,
        provider: event.provider,
        model: event.model,
        systemPromptHash,
        toolCallsInResponse: event.toolCallsInResponse,
        userPromptPreview,
      });
      this.sseManager.broadcast({
        type: "llm_call",
        runId,
        provider: event.provider,
        model: event.model,
        inputTokens: event.usage?.input,
        outputTokens: event.usage?.output,
        costUsd,
      });
    });
  }

  recordLlmInput(
    event: {
      runId?: string;
      sessionId?: string;
      prompt?: string;
      systemPrompt?: string;
    },
    _ctx: { sessionKey?: string; agentId?: string; channelId?: string },
  ): void {
    const runId = event.runId;
    if (!runId) return;

    // Map sessionId → runId for agent_end correlation
    if (event.sessionId) {
      this.sessionIdToRunId.set(event.sessionId, runId);
    }

    const active = this.activeRuns.get(runId);
    if (active) {
      if (event.prompt) active.lastUserPrompt = event.prompt.slice(0, 200);
      if (event.systemPrompt) active.systemPromptHash = simpleHash(event.systemPrompt);
    }
  }

  recordToolCall(
    // PluginHookAfterToolCallEvent — params/result/error are the actual field names
    event: {
      toolName: string;
      params?: Record<string, unknown>;
      runId?: string;
      toolCallId?: string;
      result?: unknown;
      error?: string;
      durationMs?: number;
    },
    ctx: { sessionKey?: string; agentId?: string; runId?: string; toolCallId?: string },
  ): void {
    const runId = event.runId ?? (ctx as any).runId;
    if (!runId) return;

    const toolCallId = event.toolCallId ?? ctx.toolCallId ?? randomUUID();
    const toolName = event.toolName ?? "unknown";
    const now = Date.now();
    const durationMs = event.durationMs;
    const isError = event.error !== undefined && event.error !== null;

    const argsSummary = event.params
      ? JSON.stringify(event.params).slice(0, 200)
      : undefined;
    const resultSummary = event.result
      ? JSON.stringify(event.result).slice(0, 200)
      : event.error?.slice(0, 200);

    this.enqueue(() => {
      this.store.insertToolExecution(runId, toolCallId, toolName, durationMs ? now - durationMs : now, {
        endedAt: now,
        durationMs,
        isError,
        argsSummary,
        resultSummary,
      });
      this.sseManager.broadcast({
        type: "tool_executed",
        runId,
        toolName,
        isError,
        durationMs,
      });
    });
  }

  recordAgentEnd(
    event: { messages?: unknown[]; success?: boolean; durationMs?: number },
    ctx: { sessionKey?: string; sessionId?: string },
  ): void {
    const runId = ctx.sessionId ? this.sessionIdToRunId.get(ctx.sessionId) : undefined;
    if (!runId || !ctx.sessionKey) return;

    const messages = (event.messages ?? []) as Array<{ role?: string; content?: string | unknown[] }>;
    let turnIndex = 0;
    const sessionKey = ctx.sessionKey;
    const now = Date.now();

    this.enqueue(() => {
      for (const msg of messages) {
        const role = msg.role ?? "unknown";
        const raw = typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content ?? "");
        this.store.insertConversationTurn(
          runId, sessionKey, turnIndex++, role,
          raw.slice(0, 500), raw.length, now,
        );
      }
    });
  }
}
