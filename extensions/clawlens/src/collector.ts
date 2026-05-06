import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Store } from "./store.js";
import type { SSEManager } from "./sse-manager.js";
import { calculateCost, loadCostConfig } from "./cost-calculator.js";
import type { ClawLensConfig } from "./types.js";
import { isClawLensDebugEnabled, logClawLensDebug } from "./debug.js";
import {
  resolveTranscriptSourceCandidates,
  serializePreviewForTextColumn,
} from "./structured-preview.js";

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
    searchableText: string;
    length: number;
    timestamp?: number;
    toolCallsCount: number;
    tokensUsed?: number;
    explicitRunId?: string;
  };
  sessionIdFromFile?: string;
  queuedSourceMessageIds?: string[];
};

type LiveLlmStream = {
  startedAt: number;
  lastAt: number;
  chunkCount: number;
  lastEmitAt: number;
};

type FinalizeRunContext = {
  runId: string;
  sessionKey: string;
  startedAt: number;
  endedAt: number;
  runKind?: "heartbeat" | "chat";
  status: string;
  errorMessage?: string;
};

const RECOVERY_WINDOW_BEFORE_MS = 5_000;
const RECOVERY_WINDOW_AFTER_MS = 5_000;

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

export function classifyTranscriptTurnKind(normalized: {
  role: string;
  searchableText: string;
}): "heartbeat" | "chat" {
  const text = normalized.searchableText ?? "";
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
  private structuredPreviewsEnabled = false;
  private liveLlmByRunId = new Map<string, LiveLlmStream>();
  private pendingModelCallStarts = new Map<string, number>();
  private transcriptTurnCountByRunId = new Map<string, number>();
  private sessionFileBySessionKeyCache = new Map<string, string | null>();
  // ROLLBACK_INDEX: CLAWLENS_TRANSCRIPT_BINDING_STRATEGY -> docs/CLAWLENS_TRANSCRIPT_BINDING_ROLLBACK_PLAYBOOK.md
  // DOC_INDEX: CLAWLENS_TRANSCRIPT_BINDING_PLAYBOOK -> docs/CLAWLENS_TRANSCRIPT_BINDING_ROLLBACK_PLAYBOOK.md
  // Keep legacy as default. Switch explicitly via collector.transcriptBindingStrategy.
  private transcriptBindingStrategy: "legacy_recent_window" | "safe_message_anchor" = "legacy_recent_window";

  constructor(
    private store: Store,
    private sseManager: SSEManager,
  ) {}

  start(runtime: unknown, globalConfig: unknown, pluginConfig: ClawLensConfig): void {
    this.costMap = loadCostConfig(globalConfig);
    this.debugEnabled = isClawLensDebugEnabled(pluginConfig.collector?.debugLogs);
    this.structuredPreviewsEnabled = pluginConfig.collector?.structuredPreviews === true;
    this.transcriptBindingStrategy = resolveTranscriptBindingStrategy(
      pluginConfig.collector?.transcriptBindingStrategy,
    );

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
      const active = this.activeRuns.get(runId);
        this.enqueue(() => this.finalizeRun({
          runId,
          sessionKey: active?.sessionKey ?? "unknown",
          startedAt: active?.startedAt ?? pending.endedAt,
          endedAt: pending.endedAt,
          runKind: active?.runKind,
          status: pending.status,
          errorMessage: pending.errorMessage,
        }));
    }
    this.pendingCompletes.clear();
    this.llmStartQueueByRunId.clear();
    this.liveLlmByRunId.clear();
    this.sessionIdToRunId.clear();
    this.transcriptTurnCountByRunId.clear();
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
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;

      const active: ActiveRun = { runId, sessionKey, startedAt, llmCallIndex: 0 };
      this.activeRuns.set(runId, active);
      if (sessionId) {
        this.sessionIdToRunId.set(sessionId, runId);
      }
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
      const active = this.activeRuns.get(runId);
      this.activeRuns.delete(runId);
      this.enqueue(() => this.finalizeRun({
        runId,
        sessionKey: active?.sessionKey ?? "unknown",
        startedAt: active?.startedAt ?? endedAt,
        endedAt,
        runKind: active?.runKind,
        status,
        errorMessage,
      }));
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
      if (event.prompt) {
        active.lastUserPrompt = this.structuredPreviewsEnabled
          ? serializePreviewForTextColumn(event.prompt)
          : event.prompt.slice(0, 200);
      } else {
        // Channels like Discord pass full history as messages[] without a top-level prompt.
        const msgs = (event as any).messages;
        if (Array.isArray(msgs) && msgs.length > 0) {
          const lastUser = [...msgs].reverse().find((m: any) => m?.role === "user");
          if (lastUser) {
            const content = (lastUser as any).content;
            active.lastUserPrompt = this.structuredPreviewsEnabled
              ? serializePreviewForTextColumn(content ?? "")
              : (typeof content === "string" ? content : JSON.stringify(content ?? "")).slice(0, 200);
          }
        }
      }
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
      ? (this.structuredPreviewsEnabled
          ? serializePreviewForTextColumn(event.params)
          : JSON.stringify(event.params).slice(0, 200))
      : undefined;
    const resultSummary = event.result != null
      ? (this.structuredPreviewsEnabled
          ? serializePreviewForTextColumn(event.result)
          : JSON.stringify(event.result).slice(0, 200))
      : event.error
        ? (this.structuredPreviewsEnabled
            ? serializePreviewForTextColumn(event.error)
            : event.error.slice(0, 200))
        : undefined;

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
    let runId = ctx.sessionId ? this.sessionIdToRunId.get(ctx.sessionId) : undefined;

    // Fallback for channels (e.g. Discord) that don't provide sessionId in agent_end:
    // find the most recent active or just-completed run for this session key.
    if (!runId && ctx.sessionKey && ctx.sessionKey !== "unknown") {
      const byActive = this.findActiveRunIdForSessionKind(ctx.sessionKey, "chat");
      const byRecent = byActive ?? this.store.findRecentRunIdForSession(ctx.sessionKey, { windowMs: 120_000 });
      if (byRecent) runId = byRecent;
    }

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
        const preview = this.structuredPreviewsEnabled
          ? serializePreviewForTextColumn(msg.content ?? "")
          : raw.slice(0, 500);
        this.store.insertConversationTurn(
          runId, sessionKey, turnIndex++, role,
          preview, raw.length, now,
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

    const normalized = normalizeTranscriptMessage(update.message, {
      structuredPreviews: this.structuredPreviewsEnabled,
    });
    if (!normalized) return;
    const queuedTimestamp = extractQueuedConversationTimestampMs(update.message);
    const anchorTimestamp = normalized.timestamp ?? queuedTimestamp;
    const normalizedWithAnchorTs = anchorTimestamp == null
      ? normalized
      : { ...normalized, timestamp: anchorTimestamp };
    const turnKind = classifyTranscriptTurnKind(normalized);
    const sessionIdFromFile = extractSessionIdFromSessionFile(update.sessionFile);
    const queuedSourceMessageIds = extractQueuedSourceMessageIds(update.message);
    const runId = this.resolveTranscriptRunId(sessionKey, turnKind, normalizedWithAnchorTs, {
      messageId: update.messageId,
      sessionIdFromFile,
      queuedSourceMessageIds,
      anchorTimestamp,
    });
    this.debug("transcript_update", {
      sessionKey,
      messageId: update.messageId,
      explicitRunId: normalized.explicitRunId,
      strategy: this.transcriptBindingStrategy,
      resolvedRunId: runId,
      turnKind,
      role: normalized.role,
      timestamp: normalizedWithAnchorTs.timestamp,
      anchorTimestamp,
      sessionIdFromFile,
      queuedSourceMessageIds,
    });
    const pendingTurn: PendingTranscriptTurn = {
      sessionFile: update.sessionFile,
      sessionKey,
      messageId: update.messageId,
      kind: turnKind,
      normalized: normalizedWithAnchorTs,
      sessionIdFromFile,
      queuedSourceMessageIds,
    };

    this.enqueue(() => {
      if (!runId) {
        this.queuePendingTranscriptTurn(pendingTurn);
        return;
      }
      this.backfillRunSessionKeyIfNeeded(runId, sessionKey);
      if (this.transcriptBindingStrategy === "safe_message_anchor") {
        const drained = this.drainPendingTranscriptTurns(sessionKey, turnKind);
        for (const turn of drained) {
          this.persistTranscriptTurn(runId, turn);
        }
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
    opts: {
      messageId: string;
      sessionIdFromFile?: string;
      queuedSourceMessageIds?: string[];
      anchorTimestamp?: number;
    },
  ): string | null {
    const explicit = normalized.explicitRunId;
    if (explicit) return explicit;

    // 1) queued embedded source message IDs (if already mapped in this run graph)
    for (const sourceId of opts.queuedSourceMessageIds ?? []) {
      const mapped = this.store.findRunIdByMessageId(sourceId);
      if (mapped) return mapped;
      const mappedUnknown = this.store.findUnknownRunIdByPromptMessageId(sourceId, {
        timestamp: opts.anchorTimestamp,
      });
      if (mappedUnknown) return mappedUnknown;
    }
    // 2) wrapper message ID mapping
    const mappedByWrapper = this.store.findRunIdByMessageId(opts.messageId);
    if (mappedByWrapper) return mappedByWrapper;
    // 3) session-id inferred run (helps when lifecycle arrived with session_key=unknown)
    if (opts.sessionIdFromFile) {
      const mappedBySession = this.sessionIdToRunId.get(opts.sessionIdFromFile) ?? null;
      if (mappedBySession) return mappedBySession;
    }
    // 4) unknown active run fallback: when lifecycle start lacks session context,
    // bind transcript turns to the most recent unknown active run in a short window.
    if (sessionKey !== "unknown") {
      const mappedUnknownActive = this.findUnknownActiveRunIdForTurnKind(turnKind, {
        timestamp: opts.anchorTimestamp ?? normalized.timestamp,
      });
      if (mappedUnknownActive) return mappedUnknownActive;
    }
    if ((opts.queuedSourceMessageIds?.length ?? 0) > 0) {
      this.debug("transcript_binding: queued deferred", {
        sessionKey,
        messageId: opts.messageId,
        queuedSourceMessageIds: opts.queuedSourceMessageIds,
      });
      return null;
    }

    const active = this.findActiveRunIdForSessionKind(sessionKey, turnKind);
    if (active) return active;

    if (this.transcriptBindingStrategy === "safe_message_anchor") {
      // Stricter fallback: narrow window and only bind to running / just-ended runs.
      // This reduces cross-turn merge when queued messages arrive after completion.
      return this.store.findRecentRunIdForSession(sessionKey, {
        timestamp: opts.anchorTimestamp ?? normalized.timestamp,
        kind: turnKind,
        windowMs: 90 * 1000,
        bindGraceMs: 20 * 1000,
      });
    }

    // Legacy behavior (default): broader window, no ended-run guard.
    return this.store.findRecentRunIdForSession(sessionKey, {
      timestamp: opts.anchorTimestamp ?? normalized.timestamp,
      kind: turnKind,
    });
  }

  private findUnknownActiveRunIdForTurnKind(
    kind: "heartbeat" | "chat",
    opts?: { timestamp?: number },
  ): string | null {
    const anchorTs = typeof opts?.timestamp === "number" && Number.isFinite(opts.timestamp)
      ? opts.timestamp
      : Date.now();
    const candidates: ActiveRun[] = [];
    for (const active of this.activeRuns.values()) {
      if (active.sessionKey !== "unknown") continue;
      if (active.runKind && active.runKind !== kind) continue;
      // Keep the window tight to avoid cross-session misbinding.
      if (Math.abs(active.startedAt - anchorTs) > 120_000) continue;
      candidates.push(active);
    }
    if (candidates.length !== 1) return null;
    return candidates[0]?.runId ?? null;
  }

  private backfillRunSessionKeyIfNeeded(runId: string, sessionKey: string): void {
    if (!runId || !sessionKey || sessionKey === "unknown") return;
    try {
      this.store.updateRunSessionKeyIfUnknown(runId, sessionKey);
    } catch (err) {
      console.error("[clawlens] backfillRunSessionKeyIfNeeded: store write failed:", err);
    }
    const active = this.activeRuns.get(runId);
    if (active && active.sessionKey === "unknown") {
      active.sessionKey = sessionKey;
    }
  }

  private findActiveRunIdForSessionKind(sessionKey: string | undefined, kind: "heartbeat" | "chat"): string | null {
    if (!sessionKey) return null;
    let candidate: ActiveRun | null = null;
    for (const active of this.activeRuns.values()) {
      const sameSession =
        active.sessionKey === sessionKey
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

  recordModelCallStarted(
    event: { callId?: string; runId?: string },
    _ctx: unknown,
  ): void {
    const callId = event.callId;
    if (!callId) return;
    this.pendingModelCallStarts.set(callId, Date.now());
  }

  recordModelCallEnded(
    event: {
      callId?: string;
      runId?: string;
      provider?: string;
      model?: string;
      api?: string;
      transport?: string;
      durationMs?: number;
      outcome?: string;
      upstreamRequestIdHash?: string;
    },
    _ctx: unknown,
  ): void {
    const callId = event.callId;
    if (!callId) return;
    const startedAt = this.pendingModelCallStarts.get(callId);
    this.pendingModelCallStarts.delete(callId);
    const durationMs = event.durationMs ?? (startedAt ? Date.now() - startedAt : undefined);
    try {
      this.store.insertModelCallEvent({
        callId,
        runId: event.runId,
        provider: event.provider,
        model: event.model,
        api: event.api,
        transport: event.transport,
        durationMs,
        outcome: event.outcome,
        upstreamRequestIdHash: event.upstreamRequestIdHash,
      });
    } catch (err) {
      console.error("[clawlens] recordModelCallEnded: store write failed:", err);
    }
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
    this.transcriptTurnCountByRunId.set(runId, (this.transcriptTurnCountByRunId.get(runId) ?? 0) + 1);
    this.sseManager.broadcast({
      type: "transcript_turn",
      runId,
      sessionKey: turn.sessionKey,
      messageId: turn.messageId,
    });
  }

  private finalizeRun(ctx: FinalizeRunContext): void {
    this.recoverMissingTranscriptTurns(ctx);
    this.store.completeRun(ctx.runId, ctx.endedAt, ctx.status, ctx.errorMessage);
    this.sseManager.broadcast({
      type: "run_ended",
      runId: ctx.runId,
      endedAt: ctx.endedAt,
      status: ctx.status,
    });
  }

  private recoverMissingTranscriptTurns(ctx: FinalizeRunContext): void {
    try {
      const knownTurns = this.transcriptTurnCountByRunId.get(ctx.runId) ?? 0;
      if (knownTurns > 0) {
        return;
      }
      if (this.store.getConversationTurnCount(ctx.runId) > 0) {
        this.transcriptTurnCountByRunId.set(ctx.runId, 1);
        return;
      }
      if (!ctx.sessionKey || ctx.sessionKey === "unknown") {
        return;
      }

      const sessionFile = this.resolveSessionFileForSessionKey(ctx.sessionKey);
      if (!sessionFile) {
        return;
      }

      const recovered = recoverTranscriptMessagesFromSessionFile(sessionFile, {
        startedAt: ctx.startedAt,
        endedAt: ctx.endedAt,
        expectedKind: ctx.runKind ?? "chat",
        structuredPreviews: this.structuredPreviewsEnabled,
      });
      for (const turn of recovered) {
        this.store.upsertConversationTurnByMessageId(
          ctx.runId,
          ctx.sessionKey,
          turn.role,
          turn.preview,
          turn.length,
          turn.timestamp,
          {
            messageId: turn.messageId,
            sessionFile,
            sourceKind: "transcript_recovered",
            toolCallsCount: turn.toolCallsCount,
            tokensUsed: turn.tokensUsed,
          },
        );
        this.transcriptTurnCountByRunId.set(ctx.runId, (this.transcriptTurnCountByRunId.get(ctx.runId) ?? 0) + 1);
        this.sseManager.broadcast({
          type: "transcript_turn",
          runId: ctx.runId,
          sessionKey: ctx.sessionKey,
          messageId: turn.messageId,
        });
      }
      if (recovered.length > 0) {
        this.debug("transcript_recovered", {
          runId: ctx.runId,
          sessionKey: ctx.sessionKey,
          sessionFile,
          recoveredCount: recovered.length,
        });
      }
    } catch (err) {
      console.error("[clawlens] recoverMissingTranscriptTurns: failed:", err);
    }
  }

  private resolveSessionFileForSessionKey(sessionKey: string): string | null {
    if (this.sessionFileBySessionKeyCache.has(sessionKey)) {
      return this.sessionFileBySessionKeyCache.get(sessionKey) ?? null;
    }
    const resolved = resolveSessionFileForSessionKey(sessionKey);
    this.sessionFileBySessionKeyCache.set(sessionKey, resolved);
    return resolved;
  }
}

function resolveSessionFileForSessionKey(sessionKey: string): string | null {
  if (!sessionKey.startsWith("agent:")) {
    return null;
  }
  const agentId = sessionKey.split(":")[1];
  if (!agentId) {
    return null;
  }
  const stateRoot = path.join(os.homedir(), ".openclaw");
  const candidateStores = [
    path.join(stateRoot, "agents", agentId, "sessions", "sessions.json"),
  ];

  const agentsDir = path.join(stateRoot, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const storePath = path.join(agentsDir, entry.name, "sessions", "sessions.json");
      if (!candidateStores.includes(storePath)) {
        candidateStores.push(storePath);
      }
    }
  }

  for (const storePath of candidateStores) {
    try {
      if (!fs.existsSync(storePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
        string,
        { sessionId?: unknown }
      >;
      const entry = parsed?.[sessionKey];
      const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId : "";
      if (!sessionId) continue;
      const sessionFile = path.join(path.dirname(storePath), `${sessionId}.jsonl`);
      if (fs.existsSync(sessionFile)) {
        return sessionFile;
      }
    } catch {
      // Ignore bad session stores and continue scanning.
    }
  }

  return null;
}

function recoverTranscriptMessagesFromSessionFile(
  sessionFile: string,
  options: {
    startedAt: number;
    endedAt: number;
    expectedKind: "heartbeat" | "chat";
    structuredPreviews: boolean;
  },
): Array<{
  messageId: string;
  role: string;
  preview: string;
  length: number;
  timestamp: number;
  toolCallsCount: number;
  tokensUsed?: number;
}> {
  const startedAt = Math.max(0, options.startedAt - RECOVERY_WINDOW_BEFORE_MS);
  const endedAt = options.endedAt + RECOVERY_WINDOW_AFTER_MS;
  const raw = fs.readFileSync(sessionFile, "utf8");
  const recovered: Array<{
    messageId: string;
    role: string;
    preview: string;
    length: number;
    timestamp: number;
    toolCallsCount: number;
    tokensUsed?: number;
  }> = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = safeParseJsonRecord(line);
    if (!parsed) continue;
    const messageId = typeof parsed.id === "string" ? parsed.id : "";
    const message = parsed.message;
    if (!messageId || !message || typeof message !== "object") continue;

    const normalized = normalizeTranscriptMessage(message, {
      structuredPreviews: options.structuredPreviews,
    });
    if (!normalized) continue;
    if (normalized.role !== "user" && normalized.role !== "assistant") continue;
    if (classifyTranscriptTurnKind(normalized) !== options.expectedKind) continue;
    const timestamp = normalized.timestamp ?? parseTimestampMs(parsed.timestamp);
    if (timestamp == null) continue;
    if (timestamp < startedAt || timestamp > endedAt) continue;

    recovered.push({
      messageId,
      role: normalized.role,
      preview: normalized.preview,
      length: normalized.length,
      timestamp,
      toolCallsCount: normalized.toolCallsCount,
      ...(typeof normalized.tokensUsed === "number" ? { tokensUsed: normalized.tokensUsed } : {}),
    });
  }

  recovered.sort((a, b) => a.timestamp - b.timestamp);
  return recovered;
}

function safeParseJsonRecord(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
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

export function normalizeTranscriptMessage(message: unknown): {
  role: string;
  preview: string;
  searchableText: string;
  length: number;
  timestamp?: number;
  toolCallsCount: number;
  tokensUsed?: number;
  explicitRunId?: string;
} | null;
export function normalizeTranscriptMessage(
  message: unknown,
  options: { structuredPreviews: boolean },
): {
  role: string;
  preview: string;
  searchableText: string;
  length: number;
  timestamp?: number;
  toolCallsCount: number;
  tokensUsed?: number;
  explicitRunId?: string;
} | null;
export function normalizeTranscriptMessage(
  message: unknown,
  options?: { structuredPreviews: boolean },
): {
  role: string;
  preview: string;
  searchableText: string;
  length: number;
  timestamp?: number;
  toolCallsCount: number;
  tokensUsed?: number;
  explicitRunId?: string;
} | null {
  return normalizeTranscriptMessageInternal(message, {
    structuredPreviews: options?.structuredPreviews === true,
  });
}

function normalizeTranscriptMessageInternal(
  message: unknown,
  options: { structuredPreviews: boolean },
): {
  role: string;
  preview: string;
  searchableText: string;
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
  const explicitToolCalls = Array.isArray(msg.toolCalls)
    ? msg.toolCalls.length
    : Array.isArray(msg.tool_calls)
      ? msg.tool_calls.length
      : 0;
  // Some providers (including MiniMax chat payloads) emit tool calls inline
  // inside content[] items as { type: "toolCall", ... } instead of top-level
  // toolCalls/tool_calls arrays. Check both surfaces and take the higher count
  // to avoid under-reporting assistant turn tool-call density in Chat Audit.
  const contentToolCalls = Array.isArray(content)
    ? content.filter((item) => {
        if (!item || typeof item !== "object") return false;
        const typeValue = (item as Record<string, unknown>).type;
        return typeof typeValue === "string" && typeValue.toLowerCase() === "toolcall";
      }).length
    : 0;
  const toolCalls = Math.max(explicitToolCalls, contentToolCalls);
  const usage = (msg.usage && typeof msg.usage === "object") ? msg.usage as Record<string, unknown> : null;
  const tokensUsed = typeof usage?.totalTokens === "number"
    ? usage.totalTokens as number
    : typeof usage?.total_tokens === "number"
      ? usage.total_tokens as number
      : undefined;
  const explicitRunId = extractExplicitRunId(msg);
  return {
    role,
    preview: options.structuredPreviews
      ? serializePreviewForTextColumn(content ?? "")
      : raw.slice(0, 500),
    searchableText: raw,
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

function extractSessionIdFromSessionFile(sessionFile?: string): string | undefined {
  return resolveTranscriptSourceCandidates({ sessionFile }).sessionId ?? undefined;
}

function resolveTranscriptBindingStrategy(
  configured?: "legacy_recent_window" | "safe_message_anchor",
): "legacy_recent_window" | "safe_message_anchor" {
  const raw = (process.env.CLAWLENS_TRANSCRIPT_BINDING_STRATEGY ?? "").trim().toLowerCase();
  if (raw === "safe_message_anchor" || raw === "safe") return "safe_message_anchor";
  if (raw === "legacy_recent_window" || raw === "legacy") return "legacy_recent_window";
  return configured ?? "legacy_recent_window";
}

function extractQueuedSourceMessageIds(message: unknown): string[] {
  const raw = getTranscriptRawText(message);
  if (!raw.includes("[Queued messages while agent was busy]")) return [];
  const ids = new Set<string>();
  const regex = /"message_id"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) {
    const id = m[1]?.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

function extractQueuedConversationTimestampMs(message: unknown): number | undefined {
  const raw = getTranscriptRawText(message);
  if (!raw.includes("[Queued messages while agent was busy]")) return undefined;
  const m = raw.match(/"timestamp"\s*:\s*"([^"]+)"/);
  const tsText = m?.[1]?.trim();
  if (!tsText) return undefined;
  const ms = Date.parse(tsText);
  return Number.isFinite(ms) ? ms : undefined;
}

function getTranscriptRawText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as Record<string, unknown>;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as any).text === "string") {
          return (part as any).text as string;
        }
        try {
          return JSON.stringify(part);
        } catch {
          return "";
        }
      })
      .join("\n");
  }
  try {
    return JSON.stringify(content ?? "");
  } catch {
    return "";
  }
}
