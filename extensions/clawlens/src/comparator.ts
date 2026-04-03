import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { SSEManager } from "./sse-manager.js";

type CompareConfig = {
  enabled?: boolean;
  models?: Array<{ provider: string; model: string }>;
  channels?: string[];
  timeoutMs?: number;
  maxConcurrent?: number;
};

type AgentEventCtx = {
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  channelId?: string;
};

export class Comparator {
  constructor(
    private store: Store,
    private sseManager: SSEManager,
    private runtime: any,
    private stateDir: string,
  ) {}

  async maybeForCompare(
    event: unknown,
    ctx: AgentEventCtx,
    config: CompareConfig,
  ): Promise<undefined> {
    if (!config.channels?.includes(ctx.channelId ?? "")) return undefined;

    // Read primary model from session store
    let primaryProvider: string | undefined;
    let primaryModel: string | undefined;
    try {
      const storePath = this.runtime.agent.session.resolveStorePath(ctx.agentId);
      const sessionStore = this.runtime.agent.session.loadSessionStore(storePath);
      const entry = sessionStore[ctx.sessionKey!];
      primaryModel = entry?.model;
      primaryProvider = entry?.modelProvider;
    } catch {
      // session store unavailable — proceed without filtering
    }

    const modelsToCompare = (config.models ?? []).filter(
      (m) => !(m.provider === primaryProvider && m.model === primaryModel),
    );

    if (modelsToCompare.length === 0) return undefined;

    const groupId = randomUUID();
    const maxConcurrent = config.maxConcurrent ?? 3;
    const timeoutMs = config.timeoutMs ?? 300_000;

    const chunks: Array<typeof modelsToCompare> = [];
    for (let i = 0; i < modelsToCompare.length; i += maxConcurrent) {
      chunks.push(modelsToCompare.slice(i, i + maxConcurrent));
    }

    for (const chunk of chunks) {
      await Promise.all(
        chunk.map(async ({ provider, model }) => {
          const compareSessionKey = `${ctx.sessionKey}:clawlens:${provider}:${model}`;
          const compareDir = path.join(this.stateDir, "clawlens", "compare", groupId);
          const sessionFile = path.join(compareDir, `${provider}_${model}.jsonl`);
          const workspaceDir = path.join(compareDir, `${provider}_${model}`);

          try {
            const compareRunId = randomUUID();
            const compareSessionId = ctx.sessionId ?? randomUUID();
            const originalPrompt = (event as any)?.prompt ?? "";
            await this.runtime.agent.runEmbeddedPiAgent({
              runId: compareRunId,
              sessionId: compareSessionId,
              prompt: originalPrompt,
              sessionKey: compareSessionKey,
              sessionFile,
              workspaceDir,
              lane: "compare",
              timeoutMs,
              provider,
              model,
              onAgentEvent: (evt: any) => {
                if (evt.stream === "lifecycle" && evt.data?.phase === "start") {
                  this.store.insertRun(evt.runId ?? randomUUID(), compareSessionKey, evt.ts ?? Date.now(), {
                    channel: ctx.channelId,
                    agentId: ctx.agentId,
                    provider,
                    model,
                    compareGroupId: groupId,
                    isPrimary: false,
                  });
                } else if (evt.stream === "lifecycle" && evt.data?.phase === "end") {
                  this.store.completeRun(evt.runId, evt.ts ?? Date.now(), "completed");
                } else if (evt.stream === "lifecycle" && evt.data?.phase === "error") {
                  this.store.completeRun(evt.runId, evt.ts ?? Date.now(), "error", String(evt.data?.error ?? ""));
                }
              },
            });
          } catch (err) {
            console.error(`[clawlens] compare run failed (${provider}/${model}):`, err);
          }
        }),
      );
    }

    this.sseManager.broadcast({ type: "compare_completed", groupId, sessionKey: ctx.sessionKey });
    return undefined;
  }
}
