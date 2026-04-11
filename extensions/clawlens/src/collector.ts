import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { SSEManager } from "./sse-manager.js";
import { calculateCost, loadCostConfig } from "./cost-calculator.js";
import type { ClawLensConfig } from "./types.js";
import { isClawLensDebugEnabled, logClawLensDebug } from "./debug.js";

type ActiveRun = {
  runId: string;
  sessionKey: string;
  startedAt: number;
  llmCallIndex: number;
  lastUserPrompt?: string;
  systemPromptHash?: string;
  runKind?: "heartbeat" | "chat";
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

type PendingTranscriptTurn = {
  sessionFile: string;
  sessionKey: string;
  messageId: string;
  kind: "heartbeat" | "chat";
  normalized: {
    role: string;
    preview: string;
    length: number;
    timestamp?: number;
    toolCallsCount: number;
    tokensUsed?: number;
    explicitRunId?: string;
  };
};

type LiveLlmStream = {
  startedAt: number;
  lastAt: number;
  chunkCount: number;
  lastEmitAt: number;
};

function classifyPromptRunKind(prompt?: string): "heartbeat" | "chat" {
  const text = prompt ?? "";
  if (
    text.includes("Read HEARTBEAT.md if it exists (workspace context).") ||
    text.includes("/home/openclaw/.openclaw/workspace/HEARTBEAT.md") ||
    text.includes("HEARTBEAT_OK")
  ) {
    return "heartbeat";
  }
  return "chat";
}

function classifyTranscriptTurnKind(normalized: {
  role: string;
  preview: string;
}): "heartbeat" | "chat" {
  const text = normalized.preview ?? "";
  if (
    text.includes("Read HEARTBEAT.md if it exists (workspace context).") ||
    text.includes("/home/openclaw/.openclaw/workspace/HEARTBEAT.md") ||
    text.includes("HEARTBEAT_OK")
  ) {
    return "heartbeat";
  }
  return "chat";
}

export class Collector {
  private activeRuns = new Map<string, ActiveRun>();
  private llmStartQueueByRunId = new Map<string, number[]>();
  private pendingCompletes = new Map<string, PendingComplete>();
  private sessionIdToRunId = new Map<string, string>();
  private pendingTranscriptTurns = new Map<string, PendingTranscriptTurn[]>();
  private queue: Array<() => void> = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private costMap = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
  private debugEnabled = false;
  private liveLlmByRunId = new Map<string, LiveLlmStream>();
  // ROLLBACK_INDEX: CLAWLENS_TRANSCRIPT_BINDING_STRATEGY
  // Keep legacy as default. Switch explicitly via collector.transcriptBindingStrategy.
  private transcriptBindingStrategy: "legacy_recent_window" | "safe_message_anchor" = "legacy_recent_window";

  constructor(
    private store: Store,
    private sseManager: SSEManager,
  ) {}

  start(runtime: unknown, globalConfig: unknown, pluginConfig: ClawLensConfig): void {
    this.costMap = loadCostConfig(globalConfig);
    this.debugEnabled = isClawLensDebugEnabled(pluginConfig.collector?.debugLogs);
    this.transcriptBindingStrategy = pluginConfig.collector?.transcriptBindingStrategy ?? "legacy_recent_window";

    // NOTE: snapshotIntervalMs is not yet wired up.
    // This interval drives the write-queue flush at 100ms cadence, which is intentional.
    // snapshotIntervalMs is reserved for a future independent snapshot scheduler —
    // it must NOT be passed here, as that would slow DB writes from 100ms to 60s.
    // const intervalMs = pluginConfig.collector?.snapshotIntervalMs ?? 60_000;

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
    this.llmStartQueueByRunId.clear();
    this.liveLlmByRunId.clear();
    this.sessionIdToRunId.clear();
    this.flush();
  }

  private enqueueLlmStart(runId: string, ts: number): void {
    const queue = this.llmStartQueueByRunId.get(runId) ?? [];
    queue.push(ts);
    this.llmStartQueueByRunId.set(runId, queue);
  }

  private consumeLlmStart(runId: string): number | undefined {
    const queue = this.llmStartQueueByRunId.get(runId);
    if (!queue?.length) return undefined;
    const startedAt = queue.shift();
    if (!queue.length) this.llmStartQueueByRunId.delete(runId);
    return startedAt;
  }

  private debug(message: string, details: Record<string, unknown>): void {
    logClawLensDebug("clawlens-debug", message, details, this.debugEnabled);
  }

  private flush(): void {
    const ops = this.queue.splice(0);
    for (const op of ops) {
      try {
        op();
      } catch (e) {
        console.error("[clawlens] flush: store write failed:", e);
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
    if (evt.stream === "assistant") {
      this.recordAssistantChunk(evt);
      return;
    }
    if (evt.stream !== "lifecycle") return;
    const data = evt.data ?? {};
    const phase = data.phase as string | undefined;

    if (phase === "start") {
      const runId = evt.runId ?? randomUUID();
      // Build session key: prefer evt.sessionKey; fall back to "agent:{agentId}:{channelId}" or "unknown"
      const agentId = data.agentId as string | undefined;
      const channelId = data.channelId as string | undefined;
      const sessionKey = evt.sessionKey
        ?? (agentId && channelId ? `agent:${agentId}:${channelId}` : undefined)
        ?? (agentId ? `agent:${agentId}` : undefined)
        ?? "unknown";
      const startedAt = (data.startedAt as number | undefined) ?? evt.ts ?? Date.now();

      const active: ActiveRun = { runId, sessionKey, startedAt, llmCallIndex: 0 };
      this.activeRuns.set(runId, active);
      this.debug("lifecycle:start", { runId, sessionKey, startedAt });

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
      this.debug("lifecycle:end", { runId, ts: evt.ts });
      this.endLiveLlmStream(runId, (data.endedAt as number | undefined) ?? evt.ts ?? Date.now());
      const endedAt = (data.endedAt as number | undefined) ?? evt.ts ?? Date.now();
      this.scheduleComplete(runId, endedAt, "completed");
    } else if (phase === "error") {
      const runId = evt.runId;
      if (!runId) return;
      this.debug("lifecycle:error", { runId, ts: evt.ts, error: data.error });
      this.endLiveLlmStream(runId, evt.ts ?? Date.now());
      const endedAt = evt.ts ?? Date.now();
      const errorMessage = (data.error as string | undefined) ?? "unknown error";
      this.scheduleComplete(runId, endedAt, "error", errorMessage);
    }
  }

  private recordAssistantChunk(evt: {
    runId: string;
    sessionKey?: string;
    data: Record<string, unknown>;
    ts: number;
  }): void {
    const runId = evt.runId;
    if (!runId) return;
    const text = extractAssistantDeltaText(evt.data);
    if (!text) return;

    const now = evt.ts ?? Date.now();
    const existing = this.liveLlmByRunId.get(runId);
    const stream: LiveLlmStream = existing
      ? {
          ...existing,
          lastAt: now,
          chunkCount: existing.chunkCount + 1,
        }
      : {
          startedAt: now,
          lastAt: now,
          chunkCount: 1,
          lastEmitAt: 0,
        };
    this.liveLlmByRunId.set(runId, stream);

    this.persistLiveLlmMetrics(runId, stream);

    const shouldEmit = stream.chunkCount === 1 || now - stream.lastEmitAt >= 250;
    if (!shouldEmit) return;
    stream.lastEmitAt = now;

    this.sseManager.broadcast({
      type: "llm_stream_progress",
      runId,
      sessionKey: evt.sessionKey ?? this.activeRuns.get(runId)?.sessionKey,
      startedAt: stream.startedAt,
      lastAt: stream.lastAt,
      chunkCount: stream.chunkCount,
      elapsedMs: Math.max(0, stream.lastAt - stream.startedAt),
    });
  }

  private endLiveLlmStream(runId: string, endedAt: number): void {
    const live = this.liveLlmByRunId.get(runId);
    if (!live) return;
    this.liveLlmByRunId.delete(runId);
    this.persistLiveLlmMetrics(runId, {
      ...live,
      lastAt: Math.max(live.lastAt, endedAt),
    });
    this.sseManager.broadcast({
      type: "llm_stream_end",
      runId,
      startedAt: live.startedAt,
      endedAt,
      elapsedMs: Math.max(0, endedAt - live.startedAt),
      chunkCount: live.chunkCount,
    });
  }

  private persistLiveLlmMetrics(runId: string, stream: LiveLlmStream): void {
    this.enqueue(() => {
      try {
        this.store.updateRunLlmStreamMetrics(runId, {
          chunkCount: stream.chunkCount,
          firstAt: stream.startedAt,
          lastAt: stream.lastAt,
        });
      } catch (err) {
        console.error("[clawlens] persistLiveLlmMetrics: store write failed:", err);
      }
    });
  }

  private scheduleComplete(runId: string, endedAt: number, status: string, errorMessage?: string): void {
    // Cancel any existing timer for this run (in case of duplicate events)
    const existing = this.pendingCompletes.get(runId);
    if (existing) clearTimeout(existing.timer);

    // Delay by 800ms to let any trailing llm_output / after_tool_call events flush first
    const timer = setTimeout(() => {
      this.pendingCompletes.delete(runId);
      this.llmStartQueueByRunId.delete(runId);
      this.activeRuns.delete(runId);
      this.enqueue(() => {
        this.store.completeRun(runId, endedAt, status, errorMessage);
        this.sseManager.broadcast({ type: "run_ended", runId, endedAt, status });
      });
    }, 800);

    this.pendingCompletes.set(runId, { endedAt, status, errorMessage, timer });
  }

  /**
   * Triggered by the `llm_output` hook. Called once per run — the written
   * usage values are the full-run cumulative totals, not a single LLM call.
   */
  recordLlmOutput(
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
    this.endLiveLlmStream(runId, Date.now());
    this.debug("llm_output", {
      runId,
      sessionId: event.sessionId,
      sessionKey: ctx.sessionKey,
      provider: event.provider,
      model: event.model,
      hasActiveRun: this.activeRuns.has(runId),
      usage: event.usage,
    });

    const active = this.activeRuns.get(runId);
    const callIndex = active ? active.llmCallIndex++ : 0;
    const now = Date.now();
    const startedAt = this.consumeLlmStart(runId) ?? now;
    const durationMs = Math.max(0, now - startedAt);

    const costKey = `${event.provider}:${event.model}`;
    const calculatedCost = calculateCost(
      {
        input: event.usage?.input,
        output: event.usage?.output,
        cacheRead: event.usage?.cacheRead,
        cacheWrite: event.usage?.cacheWrite,
      },
      this.costMap.get(costKey),
    );

    // event type is `any`; cost.total is a runtime field not in the TS type
    const rawUsage = (event as any).usage ?? {};
    const officialCost =
      typeof rawUsage?.cost?.total === "number" && Number.isFinite(rawUsage.cost.total)
        ? (rawUsage.cost.total as number)
        : null;

    const userPromptPreview = active?.lastUserPrompt;
    const systemPromptHash = active?.systemPromptHash ?? event.systemPromptHash;

    try {
      this.store.insertLlmCall(runId, callIndex, startedAt, {
        endedAt: now,
        durationMs,
        inputTokens: event.usage?.input,
        outputTokens: event.usage?.output,
        cacheRead: event.usage?.cacheRead,
        cacheWrite: event.usage?.cacheWrite,
        calculatedCost: calculatedCost ?? undefined,
        officialCost: officialCost ?? undefined,
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
        calculatedCost,
      });
    } catch (err) {
      console.error("[clawlens] recordLlmOutput: store write failed:", err);
    }
  }

  recordLlmInput(
    event: {
      runId?: string;
      sessionId?: string;
      prompt?: string;
      systemPrompt?: string;
    },
    ctx: { sessionKey?: string; agentId?: string; channelId?: string },
  ): void {
    const runId = event.runId;
    if (!runId) return;
    this.debug("llm_input", {
      runId,
      sessionId: event.sessionId,
      sessionKey: ctx.sessionKey,
      hasActiveRun: this.activeRuns.has(runId),
      promptPreview: typeof event.prompt === "string" ? event.prompt.slice(0, 80) : undefined,
    });

    // Map sessionId → runId for agent_end correlation
    if (event.sessionId) {
      this.sessionIdToRunId.set(event.sessionId, runId);
    }

    const active = this.activeRuns.get(runId);
    this.enqueueLlmStart(runId, Date.now());
    if (active) {
      if (event.prompt) active.lastUserPrompt = event.prompt.slice(0, 200);
      if (event.systemPrompt) active.systemPromptHash = simpleHash(event.systemPrompt);
      const runKind = classifyPromptRunKind(event.prompt);
      if (active.runKind !== runKind) {
        active.runKind = runKind;
        this.enqueue(() => {
          this.store.updateRunKind(runId, runKind);
          const pendingTranscriptTurns = this.drainPendingTranscriptTurns(active.sessionKey, runKind);
          for (const turn of pendingTranscriptTurns) {
            this.persistTranscriptTurn(runId, turn);
          }
        });
      }

      // Backfill session key: lifecycle events may lack channelId so keys like
      // "agent:main" get stored instead of the full "agent:main:main". The ctx
      // from llm_input always carries the complete key, so we upgrade whenever
      // ctx provides a more specific key (is a proper extension of the stored one).
      if (ctx.sessionKey && ctx.sessionKey !== "unknown" && ctx.sessionKey !== active.sessionKey) {
        const isMoreSpecific = active.sessionKey === "unknown" ||
          ctx.sessionKey.startsWith(active.sessionKey + ":");
        if (isMoreSpecific) {
          active.sessionKey = ctx.sessionKey;
          const newKey = ctx.sessionKey;
          this.enqueue(() => this.store.updateRunSessionKey(runId, newKey));
        }
      }
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
    this.debug("after_tool_call", {
      runId,
      sessionKey: ctx.sessionKey,
      toolName: event.toolName,
      toolCallId: event.toolCallId ?? ctx.toolCallId,
      hasError: event.error !== undefined && event.error !== null,
    });

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

    try {
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
    } catch (err) {
      console.error("[clawlens] recordToolCall: store write failed:", err);
    }
  }

  recordAgentEnd(
    event: { messages?: unknown[]; success?: boolean; durationMs?: number },
    ctx: { sessionKey?: string; sessionId?: string },
  ): void {
    const runId = ctx.sessionId ? this.sessionIdToRunId.get(ctx.sessionId) : undefined;
    this.debug("agent_end", {
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      resolvedRunId: runId,
      messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
    });
    if (!runId) return;
    // Fall back to sessionKey stored in activeRuns when ctx.sessionKey is absent
    const sessionKey = ctx.sessionKey ?? this.activeRuns.get(runId)?.sessionKey;
    if (!sessionKey) return;

    const messages = (event.messages ?? []) as Array<{ role?: string; content?: string | unknown[] }>;
    let turnIndex = 0;
    const now = Date.now();

    this.enqueue(() => {
      if (this.store.getConversationTurnCount(runId) > 0) {
        return;
      }
      for (const msg of messages) {
        const role = msg.role ?? "unknown";
        const raw = typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content ?? "");
        this.store.insertConversationTurn(
          runId, sessionKey, turnIndex++, role,
          raw.slice(0, 500), raw.length, now,
          { sourceKind: "session_fallback" },
        );
      }
    });
  }

  recordTranscriptUpdate(update: {
    sessionFile: string;
    sessionKey?: string;
    message?: unknown;
    messageId?: string;
  }): void {
    const sessionKey = update.sessionKey;
    if (!sessionKey || !update.messageId) return;

    const normalized = normalizeTranscriptMessage(update.message);
    if (!normalized) return;
    const turnKind = classifyTranscriptTurnKind(normalized);
    const runId = this.resolveTranscriptRunId(sessionKey, turnKind, normalized);
    this.debug("transcript_update", {
      sessionKey,
      messageId: update.messageId,
      explicitRunId: normalized.explicitRunId,
      strategy: this.transcriptBindingStrategy,
      resolvedRunId: runId,
      turnKind,
      role: normalized.role,
      timestamp: normalized.timestamp,
    });
    const pendingTurn: PendingTranscriptTurn = {
      sessionFile: update.sessionFile,
      sessionKey,
      messageId: update.messageId,
      kind: turnKind,
      normalized,
    };

    this.enqueue(() => {
      if (!runId) {
        this.queuePendingTranscriptTurn(pendingTurn);
        return;
      }
      this.persistTranscriptTurn(runId, pendingTurn);
    });
  }

  private resolveTranscriptRunId(
    sessionKey: string,
    turnKind: "heartbeat" | "chat",
    normalized: {
      explicitRunId?: string;
      timestamp?: number;
      role: string;
      preview: string;
    },
  ): string | null {
    const explicit = normalized.explicitRunId;
    if (explicit) return explicit;
    const active = this.findActiveRunIdForSessionKind(sessionKey, turnKind);
    if (active) return active;

    if (this.transcriptBindingStrategy === "safe_message_anchor") {
      // Stricter fallback: narrow window and only bind to running / just-ended runs.
      // This reduces cross-turn merge when queued messages arrive after completion.
      return this.store.findRecentRunIdForSession(sessionKey, {
        timestamp: normalized.timestamp,
        kind: turnKind,
        windowMs: 90 * 1000,
        bindGraceMs: 20 * 1000,
      });
    }

    // Legacy behavior (default): broader window, no ended-run guard.
    return this.store.findRecentRunIdForSession(sessionKey, {
      timestamp: normalized.timestamp,
      kind: turnKind,
    });
  }

  private findActiveRunIdForSessionKind(sessionKey: string | undefined, kind: "heartbeat" | "chat"): string | null {
    if (!sessionKey) return null;
    let candidate: ActiveRun | null = null;
    for (const active of this.activeRuns.values()) {
      const sameSession =
        active.sessionKey === sessionKey
        || sessionKey.startsWith(active.sessionKey + ":")
        || active.sessionKey.startsWith(sessionKey + ":");
      if (!sameSession) continue;
      if (active.runKind && active.runKind !== kind) continue;
      if (!candidate || active.startedAt > candidate.startedAt) {
        candidate = active;
      }
    }
    return candidate?.runId ?? null;
  }

  private queuePendingTranscriptTurn(turn: PendingTranscriptTurn): void {
    const existing = this.pendingTranscriptTurns.get(turn.sessionKey) ?? [];
    if (existing.some((entry) => entry.messageId === turn.messageId)) {
      return;
    }
    existing.push(turn);
    this.pendingTranscriptTurns.set(turn.sessionKey, existing);
  }

  private drainPendingTranscriptTurns(sessionKey: string, kind: "heartbeat" | "chat"): PendingTranscriptTurn[] {
    const pending = this.pendingTranscriptTurns.get(sessionKey) ?? [];
    if (!pending.length) return [];
    const matched = pending.filter((turn) => turn.kind === kind);
    const remaining = pending.filter((turn) => turn.kind !== kind);
    if (remaining.length) {
      this.pendingTranscriptTurns.set(sessionKey, remaining);
    } else {
      this.pendingTranscriptTurns.delete(sessionKey);
    }
    return matched;
  }

  private persistTranscriptTurn(runId: string, turn: PendingTranscriptTurn): void {
    const timestamp = turn.normalized.timestamp ?? Date.now();
      this.store.upsertConversationTurnByMessageId(
        runId,
        turn.sessionKey,
        turn.normalized.role,
      turn.normalized.preview,
      turn.normalized.length,
      timestamp,
      {
        messageId: turn.messageId,
        sessionFile: turn.sessionFile,
        sourceKind: "transcript_explicit",
        toolCallsCount: turn.normalized.toolCallsCount,
        tokensUsed: turn.normalized.tokensUsed,
      },
    );
    this.sseManager.broadcast({
      type: "transcript_turn",
      runId,
      sessionKey: turn.sessionKey,
      messageId: turn.messageId,
    });
  }
}

function extractAssistantDeltaText(data?: Record<string, unknown>): string {
  if (!data) return "";
  const directDelta = typeof data.delta === "string" ? data.delta : "";
  if (directDelta.trim()) return directDelta;
  const directText = typeof data.text === "string" ? data.text : "";
  if (directText.trim()) return directText;
  const message = data.message;
  if (message && typeof message === "object") {
    const payload = message as Record<string, unknown>;
    const content = payload.content;
    if (typeof content === "string" && content.trim()) return content;
  }
  return "";
}

function normalizeTranscriptMessage(message: unknown): {
  role: string;
  preview: string;
  length: number;
  timestamp?: number;
  toolCallsCount: number;
  tokensUsed?: number;
  explicitRunId?: string;
} | null {
  if (!message || typeof message !== "object") return null;
  const msg = message as Record<string, unknown>;
  const role = typeof msg.role === "string" ? msg.role : "unknown";
  const content = msg.content;
  const raw = typeof content === "string" ? content : JSON.stringify(content ?? "");
  const toolCalls = Array.isArray(msg.toolCalls)
    ? msg.toolCalls.length
    : Array.isArray(msg.tool_calls)
      ? msg.tool_calls.length
      : 0;
  const usage = (msg.usage && typeof msg.usage === "object") ? msg.usage as Record<string, unknown> : null;
  const tokensUsed = typeof usage?.totalTokens === "number"
    ? usage.totalTokens as number
    : typeof usage?.total_tokens === "number"
      ? usage.total_tokens as number
      : undefined;
  const explicitRunId = extractExplicitRunId(msg);
  return {
    role,
    preview: raw.slice(0, 500),
    length: raw.length,
    timestamp: typeof msg.timestamp === "number" ? msg.timestamp : undefined,
    toolCallsCount: toolCalls,
    tokensUsed,
    explicitRunId,
  };
}

function extractExplicitRunId(message: Record<string, unknown>): string | undefined {
  const abortMeta = (message.openclawAbort && typeof message.openclawAbort === "object")
    ? message.openclawAbort as Record<string, unknown>
    : null;
  if (typeof abortMeta?.runId === "string" && abortMeta.runId.trim()) {
    return abortMeta.runId.trim();
  }

  const idempotencyKey = typeof message.idempotencyKey === "string"
    ? message.idempotencyKey.trim()
    : "";
  if (!idempotencyKey) return undefined;

  if (idempotencyKey.endsWith(":assistant")) {
    const runId = idempotencyKey.slice(0, -":assistant".length).trim();
    return runId || undefined;
  }

  if (/^[A-Za-z0-9:_-]+$/.test(idempotencyKey) && !idempotencyKey.startsWith("idem-")) {
    return idempotencyKey;
  }

  return undefined;
}
