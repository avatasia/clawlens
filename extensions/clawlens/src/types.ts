export type ClawLensConfig = {
  collector?: {
    enabled?: boolean;
    snapshotIntervalMs?: number;
    retentionDays?: number;
    debugLogs?: boolean;
    loggerImportDir?: string;
    loggerImportMaxFileSizeMb?: number;
    backfillRunKindsOnStart?: boolean;
    backfillRunKindsLimit?: number;
  };
  compare?: {
    enabled?: boolean;
    models?: Array<{ provider: string; model: string }>;
    channels?: string[];
    timeoutMs?: number;
    maxConcurrent?: number;
  };
};

export type ClawLensEvent = {
  type:
    | "run_started"
    | "run_ended"
    | "llm_call"
    | "llm_stream_progress"
    | "llm_stream_end"
    | "tool_executed"
    | "transcript_turn"
    | "compare_completed"
    | "connected";
  [key: string]: unknown;
};
