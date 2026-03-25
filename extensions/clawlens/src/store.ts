import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// node:sqlite is available in Node.js >= 22.5.0
// Lazy-load so the module can be imported without crashing on older runtimes.
const _require = createRequire(import.meta.url);
let DatabaseSync: (typeof import("node:sqlite"))["DatabaseSync"];
try {
  ({ DatabaseSync } = _require("node:sqlite") as typeof import("node:sqlite"));
} catch {
  // Will throw at Store construction time if Node < 22
  DatabaseSync = null as any;
}

type RunInsertOpts = {
  channel?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  compareGroupId?: string;
  isPrimary?: boolean;
};

type LlmCallOpts = {
  endedAt?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;           // kept for back-compat; maps to calculated_cost
  officialCost?: number;      // cost reported by provider (may be null)
  calculatedCost?: number;    // cost from our pricing config
  stopReason?: string;
  provider?: string;
  model?: string;
  systemPromptHash?: string;
  toolCallsInResponse?: number;
  userPromptPreview?: string;
};

type ToolExecOpts = {
  endedAt?: number;
  durationMs?: number;
  isError?: boolean;
  argsSummary?: string;
  resultSummary?: string;
};

type SnapshotData = {
  channel?: string;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
  compactionCount?: number;
};

type SessionFilters = {
  channel?: string;
  model?: string;
  provider?: string;
  limit?: number;
  offset?: number;
};

export class Store {
  private db: DatabaseSync;

  // Prepared statement caches
  private stmtInsertRun: ReturnType<DatabaseSync["prepare"]>;
  private stmtCompleteRun: ReturnType<DatabaseSync["prepare"]>;
  private stmtInsertLlmCall: ReturnType<DatabaseSync["prepare"]>;
  private stmtInsertToolExec: ReturnType<DatabaseSync["prepare"]>;
  private stmtInsertSnapshot: ReturnType<DatabaseSync["prepare"]>;
  private stmtCleanup: ReturnType<DatabaseSync["prepare"]>;
  private stmtAggregateRun: ReturnType<DatabaseSync["prepare"]>;
  private stmtInsertConvTurn: ReturnType<DatabaseSync["prepare"]>;

  private static computeCostMatch(
    official: number | null,
    calculated: number | null,
  ): { costMatch: boolean; costDiffReason?: string } {
    if (official == null && calculated == null) return { costMatch: true };
    if (official == null) return { costMatch: false, costDiffReason: "provider did not return cost, using fallback" };
    if (calculated == null) return { costMatch: false, costDiffReason: "no pricing config available" };
    const diff = Math.abs(official - calculated);
    const threshold = Math.max(official, calculated) * 0.001;
    if (diff <= threshold) return { costMatch: true };
    return { costMatch: false, costDiffReason: "pricing differs from config" };
  }

  constructor(stateDir: string) {
    const dbDir = path.join(stateDir, "clawlens");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "clawlens.db");
    this.db = new DatabaseSync(dbPath);

    this.db.exec("PRAGMA journal_mode=WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        channel TEXT,
        agent_id TEXT,
        provider TEXT,
        model TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        status TEXT DEFAULT 'running',
        error_message TEXT,
        total_llm_calls INTEGER DEFAULT 0,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        total_cache_read INTEGER DEFAULT 0,
        total_cache_write INTEGER DEFAULT 0,
        total_cost_usd REAL DEFAULT 0,
        total_tool_calls INTEGER DEFAULT 0,
        compare_group_id TEXT,
        is_primary INTEGER
      );

      CREATE TABLE IF NOT EXISTS llm_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        call_index INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read INTEGER,
        cache_write INTEGER,
        cost_usd REAL,
        stop_reason TEXT,
        provider TEXT,
        model TEXT,
        system_prompt_hash TEXT,
        tool_calls_in_response INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tool_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        is_error INTEGER DEFAULT 0,
        args_summary TEXT,
        result_summary TEXT
      );

      CREATE TABLE IF NOT EXISTS session_snapshots (
        session_key TEXT NOT NULL,
        snapshot_at INTEGER NOT NULL,
        channel TEXT,
        model TEXT,
        provider TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        estimated_cost REAL,
        compaction_count INTEGER,
        PRIMARY KEY (session_key, snapshot_at)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_key);
      CREATE INDEX IF NOT EXISTS idx_runs_channel ON runs(channel);
      CREATE INDEX IF NOT EXISTS idx_runs_compare ON runs(compare_group_id);
      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls(run_id);
      CREATE INDEX IF NOT EXISTS idx_tool_exec_run ON tool_executions(run_id);

      CREATE TABLE IF NOT EXISTS conversation_turns (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          TEXT NOT NULL,
        session_key     TEXT NOT NULL,
        turn_index      INTEGER NOT NULL,
        role            TEXT NOT NULL,
        content_preview TEXT,
        content_length  INTEGER,
        timestamp       INTEGER,
        tool_calls_count INTEGER DEFAULT 0,
        tokens_used     INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_conv_turns_run ON conversation_turns(run_id);
      CREATE INDEX IF NOT EXISTS idx_conv_turns_session ON conversation_turns(session_key);
    `);

    // Idempotent migrations
    for (const sql of [
      "ALTER TABLE llm_calls ADD COLUMN user_prompt_preview TEXT",
      "ALTER TABLE llm_calls ADD COLUMN official_cost REAL",
      "ALTER TABLE llm_calls ADD COLUMN calculated_cost REAL",
      "ALTER TABLE runs ADD COLUMN total_official_cost REAL",
      "ALTER TABLE runs ADD COLUMN total_calculated_cost REAL",
    ]) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }

    this.stmtInsertRun = this.db.prepare(`
      INSERT OR IGNORE INTO runs (run_id, session_key, channel, agent_id, provider, model, started_at, compare_group_id, is_primary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtAggregateRun = this.db.prepare(`
      SELECT
        COUNT(*) as llm_count,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read), 0) as cache_read,
        COALESCE(SUM(cache_write), 0) as cache_write,
        COALESCE(SUM(cost_usd), 0) as cost_usd,
        SUM(official_cost) as official_cost,
        SUM(calculated_cost) as calculated_cost
      FROM llm_calls WHERE run_id = ?
    `);

    this.stmtCompleteRun = this.db.prepare(`
      UPDATE runs SET
        ended_at = ?,
        duration_ms = ?,
        status = ?,
        error_message = ?,
        total_llm_calls = ?,
        total_input_tokens = ?,
        total_output_tokens = ?,
        total_cache_read = ?,
        total_cache_write = ?,
        total_cost_usd = ?,
        total_official_cost = ?,
        total_calculated_cost = ?,
        total_tool_calls = (SELECT COUNT(*) FROM tool_executions WHERE run_id = ?)
      WHERE run_id = ?
    `);

    this.stmtInsertLlmCall = this.db.prepare(`
      INSERT INTO llm_calls (run_id, call_index, started_at, ended_at, duration_ms, input_tokens, output_tokens, cache_read, cache_write, cost_usd, stop_reason, provider, model, system_prompt_hash, tool_calls_in_response, user_prompt_preview, official_cost, calculated_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertToolExec = this.db.prepare(`
      INSERT INTO tool_executions (run_id, tool_call_id, tool_name, started_at, ended_at, duration_ms, is_error, args_summary, result_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertSnapshot = this.db.prepare(`
      INSERT OR REPLACE INTO session_snapshots (session_key, snapshot_at, channel, model, provider, input_tokens, output_tokens, total_tokens, estimated_cost, compaction_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtCleanup = this.db.prepare(`
      DELETE FROM runs WHERE started_at < ?
    `);

    this.stmtInsertConvTurn = this.db.prepare(`
      INSERT INTO conversation_turns (run_id, session_key, turn_index, role, content_preview, content_length, timestamp, tool_calls_count, tokens_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  insertRun(runId: string, sessionKey: string, startedAt: number, opts?: RunInsertOpts): void {
    this.stmtInsertRun.run(
      runId,
      sessionKey,
      opts?.channel ?? null,
      opts?.agentId ?? null,
      opts?.provider ?? null,
      opts?.model ?? null,
      startedAt,
      opts?.compareGroupId ?? null,
      opts?.isPrimary != null ? (opts.isPrimary ? 1 : 0) : null,
    );
  }

  completeRun(runId: string, endedAt: number, status: string, errorMessage?: string): void {
    const runRow = this.db.prepare("SELECT started_at FROM runs WHERE run_id = ?").get(runId) as { started_at: number } | undefined;
    const startedAt = runRow?.started_at ?? endedAt;
    const durationMs = endedAt - startedAt;

    const agg = this.stmtAggregateRun.get(runId) as {
      llm_count: number;
      input_tokens: number;
      output_tokens: number;
      cache_read: number;
      cache_write: number;
      cost_usd: number;
      official_cost: number | null;
      calculated_cost: number | null;
    };

    this.stmtCompleteRun.run(
      endedAt,
      durationMs,
      status,
      errorMessage ?? null,
      agg.llm_count,
      agg.input_tokens,
      agg.output_tokens,
      agg.cache_read,
      agg.cache_write,
      agg.cost_usd,
      agg.official_cost ?? null,
      agg.calculated_cost ?? null,
      runId,
      runId,
    );
  }

  insertLlmCall(runId: string, callIndex: number, startedAt: number, opts: LlmCallOpts): void {
    const calculatedCost = opts.calculatedCost ?? opts.costUsd ?? null;
    this.stmtInsertLlmCall.run(
      runId,
      callIndex,
      startedAt,
      opts.endedAt ?? null,
      opts.durationMs ?? null,
      opts.inputTokens ?? null,
      opts.outputTokens ?? null,
      opts.cacheRead ?? null,
      opts.cacheWrite ?? null,
      calculatedCost,               // cost_usd (legacy, = calculated)
      opts.stopReason ?? null,
      opts.provider ?? null,
      opts.model ?? null,
      opts.systemPromptHash ?? null,
      opts.toolCallsInResponse ?? 0,
      opts.userPromptPreview ?? null,
      opts.officialCost ?? null,
      calculatedCost,               // calculated_cost
    );
  }

  insertToolExecution(runId: string, toolCallId: string, toolName: string, startedAt: number, opts: ToolExecOpts): void {
    this.stmtInsertToolExec.run(
      runId,
      toolCallId,
      toolName,
      startedAt,
      opts.endedAt ?? null,
      opts.durationMs ?? null,
      opts.isError ? 1 : 0,
      opts.argsSummary ?? null,
      opts.resultSummary ?? null,
    );
  }

  getOverview(): { activeRuns: number; totalRuns24h: number; totalTokens24h: number; totalCost24h: number } {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const active = this.db.prepare("SELECT COUNT(*) as cnt FROM runs WHERE status = 'running'").get() as { cnt: number };
    const stats24h = this.db.prepare(`
      SELECT COUNT(*) as total_runs, COALESCE(SUM(total_input_tokens + total_output_tokens), 0) as total_tokens, COALESCE(SUM(total_cost_usd), 0) as total_cost
      FROM runs WHERE started_at >= ?
    `).get(cutoff) as { total_runs: number; total_tokens: number; total_cost: number };

    return {
      activeRuns: active.cnt,
      totalRuns24h: stats24h.total_runs,
      totalTokens24h: stats24h.total_tokens,
      totalCost24h: stats24h.total_cost,
    };
  }

  getSessions(filters?: SessionFilters): unknown[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.channel) {
      conditions.push("r.channel = ?");
      params.push(filters.channel);
    }
    if (filters?.model) {
      conditions.push("r.model = ?");
      params.push(filters.model);
    }
    if (filters?.provider) {
      conditions.push("r.provider = ?");
      params.push(filters.provider);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;
    params.push(limit, offset);

    return this.db.prepare(`
      SELECT
        r.session_key,
        r.channel,
        r.model,
        r.provider,
        COUNT(*) as run_count,
        SUM(r.total_input_tokens + r.total_output_tokens) as total_tokens,
        SUM(r.total_cost_usd) as total_cost,
        MAX(r.started_at) as last_run_at
      FROM runs r
      ${where}
      GROUP BY r.session_key
      ORDER BY last_run_at DESC
      LIMIT ? OFFSET ?
    `).all(...params) as unknown[];
  }

  getRunDetail(runId: string): { run: unknown; llmCalls: unknown[]; toolExecutions: unknown[] } {
    const run = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
    const llmCalls = this.db.prepare("SELECT * FROM llm_calls WHERE run_id = ? ORDER BY call_index").all(runId) as unknown[];
    const toolExecutions = this.db.prepare("SELECT * FROM tool_executions WHERE run_id = ? ORDER BY started_at").all(runId) as unknown[];
    return { run, llmCalls, toolExecutions };
  }

  insertSessionSnapshot(sessionKey: string, snapshotAt: number, data: SnapshotData): void {
    this.stmtInsertSnapshot.run(
      sessionKey,
      snapshotAt,
      data.channel ?? null,
      data.model ?? null,
      data.provider ?? null,
      data.inputTokens ?? null,
      data.outputTokens ?? null,
      data.totalTokens ?? null,
      data.estimatedCost ?? null,
      data.compactionCount ?? null,
    );
  }

  // ── Audit API ────────────────────────────────────────────────────────────

  getAuditSessions(opts?: { channel?: string; days?: number; limit?: number; offset?: number }): unknown[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.channel) { conditions.push("channel = ?"); params.push(opts.channel); }
    if (opts?.days) { conditions.push("started_at >= ?"); params.push(Date.now() - opts.days * 86_400_000); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(opts?.limit ?? 100, opts?.offset ?? 0);
    return this.db.prepare(`
      SELECT
        session_key, channel, model, provider,
        COUNT(*) as run_count,
        COALESCE(SUM(total_input_tokens), 0)  as total_input_tokens,
        COALESCE(SUM(total_output_tokens), 0) as total_output_tokens,
        COALESCE(SUM(total_cache_read), 0)    as total_cache_read,
        COALESCE(SUM(total_cache_write), 0)   as total_cache_write,
        COALESCE(SUM(total_input_tokens + total_output_tokens), 0) as total_tokens,
        COALESCE(SUM(total_cost_usd), 0)      as total_cost,
        COALESCE(SUM(total_tool_calls), 0)    as total_tool_calls,
        COALESCE(SUM(total_llm_calls), 0)     as total_llm_calls,
        COALESCE(AVG(CASE WHEN duration_ms > 0 THEN duration_ms END), 0) as avg_duration_ms,
        MAX(started_at) as last_run_at,
        MIN(started_at) as first_run_at
      FROM runs ${where}
      GROUP BY session_key
      ORDER BY last_run_at DESC
      LIMIT ? OFFSET ?
    `).all(...params) as unknown[];
  }

  getSessionRuns(sessionKey: string, limit = 30): unknown[] {
    const runs = this.db.prepare(
      "SELECT * FROM runs WHERE session_key = ? ORDER BY started_at DESC LIMIT ?",
    ).all(sessionKey, limit) as any[];

    return runs.map((run) => {
      const llmCalls = this.db.prepare(`
        SELECT call_index, started_at, ended_at, duration_ms,
               input_tokens, output_tokens, cache_read, cache_write,
               cost_usd, provider, model, stop_reason, tool_calls_in_response
        FROM llm_calls WHERE run_id = ? ORDER BY call_index
      `).all(run.run_id) as unknown[];

      const toolSummary = this.db.prepare(`
        SELECT tool_name,
               COUNT(*)           as count,
               SUM(is_error)      as error_count,
               COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
               COALESCE(SUM(duration_ms), 0) as total_duration_ms
        FROM tool_executions WHERE run_id = ?
        GROUP BY tool_name ORDER BY count DESC
      `).all(run.run_id) as unknown[];

      return { run, llmCalls, toolSummary };
    });
  }

  insertConversationTurn(
    runId: string, sessionKey: string, turnIndex: number, role: string,
    contentPreview: string | null, contentLength: number, timestamp: number,
    opts?: { toolCallsCount?: number; tokensUsed?: number },
  ): void {
    this.stmtInsertConvTurn.run(
      runId, sessionKey, turnIndex, role,
      contentPreview, contentLength, timestamp,
      opts?.toolCallsCount ?? 0,
      opts?.tokensUsed ?? null,
    );
  }

  // ── Audit v2 API ─────────────────────────────────────────────────────────

  private buildRunAuditDetail(run: any): unknown {
    const llmCalls = this.db.prepare(
      "SELECT * FROM llm_calls WHERE run_id = ? ORDER BY started_at ASC",
    ).all(run.run_id) as any[];

    const toolExecs = this.db.prepare(
      "SELECT * FROM tool_executions WHERE run_id = ? ORDER BY started_at ASC",
    ).all(run.run_id) as any[];

    const turns = this.db.prepare(
      "SELECT * FROM conversation_turns WHERE run_id = ? ORDER BY turn_index ASC",
    ).all(run.run_id) as any[];

    const runStart = run.started_at;

    const timeline: unknown[] = [];
    for (const lc of llmCalls) {
      timeline.push({
        type: "llm_call",
        startedAt: lc.started_at - runStart,
        duration: lc.duration_ms ?? 0,
        inputTokens: lc.input_tokens,
        outputTokens: lc.output_tokens,
        cost: lc.cost_usd,
        model: lc.model,
      });
    }
    for (const te of toolExecs) {
      timeline.push({
        type: "tool_execution",
        toolName: te.tool_name,
        startedAt: te.started_at - runStart,
        duration: te.duration_ms ?? 0,
        isError: te.is_error === 1,
      });
    }
    (timeline as any[]).sort((a: any, b: any) => a.startedAt - b.startedAt);

    const officialCost: number | null = run.total_official_cost ?? null;
    const calculatedCost: number | null = run.total_calculated_cost ?? run.total_cost_usd ?? null;
    const { costMatch, costDiffReason } = Store.computeCostMatch(officialCost, calculatedCost);

    return {
      runId: run.run_id,
      startedAt: run.started_at,
      duration: (run.ended_at ?? run.started_at) - run.started_at,
      status: run.status,
      model: run.model ?? null,
      provider: run.provider ?? null,
      errorMessage: run.error_message ?? null,
      userPrompt: (llmCalls[0] as any)?.user_prompt_preview ?? "",
      summary: {
        llmCalls: run.total_llm_calls ?? llmCalls.length,
        toolCalls: run.total_tool_calls ?? toolExecs.length,
        totalInputTokens: run.total_input_tokens ?? 0,
        totalOutputTokens: run.total_output_tokens ?? 0,
        totalCacheRead: run.total_cache_read ?? 0,
        totalCacheWrite: run.total_cache_write ?? 0,
        totalCost: run.total_cost_usd ?? null,
        officialCost,
        calculatedCost,
        costMatch,
        costDiffReason,
      },
      timeline,
      turns: turns.map((t: any) => ({
        role: t.role,
        preview: t.content_preview ?? "",
        length: t.content_length ?? 0,
        toolCallsCount: t.tool_calls_count,
      })),
    };
  }

  getAuditSession(sessionKey: string): unknown {
    const runs = this.db.prepare(
      "SELECT * FROM runs WHERE session_key = ? ORDER BY started_at ASC",
    ).all(sessionKey) as any[];
    return { sessionKey, runs: runs.map((r) => this.buildRunAuditDetail(r)) };
  }

  getAuditRun(runId: string): unknown {
    const run = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as any;
    if (!run) return null;
    return this.buildRunAuditDetail(run);
  }

  cleanup(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const deletedRuns = this.db.prepare("SELECT run_id FROM runs WHERE started_at < ?").all(cutoff) as { run_id: string }[];
    for (const { run_id } of deletedRuns) {
      this.db.prepare("DELETE FROM llm_calls WHERE run_id = ?").run(run_id);
      this.db.prepare("DELETE FROM tool_executions WHERE run_id = ?").run(run_id);
    }
    this.stmtCleanup.run(cutoff);
    this.db.prepare("DELETE FROM session_snapshots WHERE snapshot_at < ?").run(cutoff);
  }

  close(): void {
    this.db.close();
  }
}
