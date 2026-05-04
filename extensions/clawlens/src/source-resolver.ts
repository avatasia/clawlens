import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  buildStructuredPreview,
  isSensitivePreviewKey,
  resolveTranscriptSourceCandidates,
} from "./structured-preview.js";

const DEFAULT_MAX_CANDIDATE_FILES = 64;
const DEFAULT_MAX_PARENT_HOPS = 8;
const DEFAULT_MAX_SCAN_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export type SourceLookupMiss =
  | "session_file_missing"
  | "session_id_unparseable"
  | "source_root_unavailable"
  | "scan_timeout"
  | "scan_limit_exceeded"
  | "message_not_found"
  | "tool_call_not_found";

export type SourceResolverOptions = {
  sourceLookupDirs?: string[];
  maxParentHops?: number;
  maxCandidateFiles?: number;
  maxScanBytes?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
};

export type MessageSourceLookupInput = {
  messageId: string;
  sessionFile?: string | null;
  sourceKind?: string | null;
};

export type ToolSourceLookupInput = {
  runId: string;
  toolCallId: string;
  sessionFiles?: Array<string | null | undefined>;
};

export type SourceLookupSuccess = {
  ok: true;
  bytes: number;
  truncated: boolean;
};

export type MessageSourceLookupResult =
  | ({
      ok: false;
      miss: SourceLookupMiss;
      candidatesTried?: string[];
    })
  | (SourceLookupSuccess & {
      sourceKind?: string | null;
      sessionFile: string | null;
      messageId: string;
      payload: unknown;
      candidatesTried: string[];
    });

export type ToolSourceLookupResult =
  | ({
      ok: false;
      miss: SourceLookupMiss;
      candidatesTried?: string[];
    })
  | (SourceLookupSuccess & {
      toolCallId: string;
      toolCall: unknown | null;
      toolResult: unknown | null;
      missing: string[];
      candidatesTried: string[];
    });

let sourceLookupQueue = Promise.resolve();

export class SourceResolver {
  constructor(private options: SourceResolverOptions = {}) {}

  async resolveMessageSource(input: MessageSourceLookupInput): Promise<MessageSourceLookupResult> {
    return this.withSerializedScan(async () => {
      const deadline = Date.now() + (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const candidatesInfo = await this.collectCandidateFiles(input.sessionFile, deadline);
      if (candidatesInfo.miss) return { ok: false, miss: candidatesInfo.miss, candidatesTried: [] };

      let scannedBytes = 0;

      for (const candidate of candidatesInfo.candidates) {
        const result = await this.scanJsonlFile(candidate, deadline, (line) => {
          const parsed = safeParseJson(line);
          if (!parsed || parsed.id !== input.messageId) return null;
          return parsed;
        }, (bytes) => {
          scannedBytes += bytes;
          return scannedBytes <= (this.options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES);
        });

        if (result?.payload) {
          const capped = capPayloadForResponse(result.payload, this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
          return {
            ok: true,
            sourceKind: input.sourceKind ?? null,
            sessionFile: candidate,
            messageId: input.messageId,
            payload: capped.payload,
            bytes: capped.bytes,
            truncated: capped.truncated,
            candidatesTried: candidatesInfo.candidates,
          };
        }
        if (result?.miss) {
          return { ok: false, miss: result.miss, candidatesTried: candidatesInfo.candidates };
        }
      }

      return { ok: false, miss: "message_not_found", candidatesTried: candidatesInfo.candidates };
    });
  }

  async resolveToolSource(input: ToolSourceLookupInput): Promise<ToolSourceLookupResult> {
    return this.withSerializedScan(async () => {
      const candidateSet = new Set<string>();
      let missingHint = true;
      const deadline = Date.now() + (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      for (const sessionFile of input.sessionFiles ?? []) {
        const info = await this.collectCandidateFiles(sessionFile, deadline);
        if (!info.miss) {
          missingHint = false;
          for (const candidate of info.candidates) candidateSet.add(candidate);
        }
      }
      const candidates = [...candidateSet].slice(0, this.options.maxCandidateFiles ?? DEFAULT_MAX_CANDIDATE_FILES);
      if (missingHint || candidates.length === 0) {
        return { ok: false, miss: "source_root_unavailable", candidatesTried: [] };
      }

      let scannedBytes = 0;
      let toolCall: unknown | null = null;
      let toolResult: unknown | null = null;

      for (const candidate of candidates) {
        const result = await this.scanJsonlFile(candidate, deadline, (line) => {
          const parsed = safeParseJson(line);
          if (!parsed) return null;
          if (!toolCall && looksLikeToolCallPayload(parsed, input.toolCallId)) {
            toolCall = parsed;
          }
          if (!toolResult && looksLikeToolResultPayload(parsed, input.toolCallId)) {
            toolResult = parsed;
          }
          if (toolCall && toolResult) {
            return { toolCall, toolResult };
          }
          return null;
        }, (bytes) => {
          scannedBytes += bytes;
          return scannedBytes <= (this.options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES);
        });

        if (result?.miss) {
          return { ok: false, miss: result.miss, candidatesTried: candidates };
        }
        if (toolCall && toolResult) break;
      }

      if (!toolCall && !toolResult) {
        return { ok: false, miss: "tool_call_not_found", candidatesTried: candidates };
      }

      const payload = {
        toolCall: toolCall ? deepRedactValue(toolCall) : null,
        toolResult: toolResult ? deepRedactValue(toolResult) : null,
      };
      const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      return {
        ok: true,
        toolCallId: input.toolCallId,
        toolCall: payload.toolCall,
        toolResult: payload.toolResult,
        missing: [
          ...(payload.toolCall ? [] : ["toolCall"]),
          ...(payload.toolResult ? [] : ["toolResult"]),
        ],
        bytes,
        truncated: bytes > (this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES),
        candidatesTried: candidates,
      };
    });
  }

  private async collectCandidateFiles(sessionFile: string | null | undefined, deadline: number): Promise<{
    miss?: SourceLookupMiss;
    candidates: string[];
  }> {
    if (!sessionFile) return { miss: "session_file_missing", candidates: [] };

    const roots = collectTrustedRoots(sessionFile, this.options.sourceLookupDirs);
    if (!roots.length) return { miss: "source_root_unavailable", candidates: [] };

    const parsed = resolveTranscriptSourceCandidates({ sessionFile });
    if (!parsed.sessionId) return { miss: "session_id_unparseable", candidates: [] };

    const candidateBasenames = new Set<string>();
    for (const candidate of parsed.candidates) {
      if (candidate?.basename) {
        candidateBasenames.add(candidate.basename);
      }
    }
    candidateBasenames.add(path.basename(sessionFile));

    const result = await this.expandCandidatesForSessionId(parsed.sessionId, roots, deadline, new Set<string>(), 0, candidateBasenames);
    if (isTrustedPath(sessionFile, roots)) {
      result.unshift(sessionFile);
    }

    return {
      candidates: dedupe(result).slice(0, this.options.maxCandidateFiles ?? DEFAULT_MAX_CANDIDATE_FILES),
    };
  }

  private async scanJsonlFile(
    filePath: string,
    deadline: number,
    matcher: (line: string) => unknown | null,
    onBytes: (bytes: number) => boolean,
  ): Promise<{ payload?: unknown; miss?: SourceLookupMiss } | null> {
    if (!fs.existsSync(filePath)) return null;
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (Date.now() > deadline) return { miss: "scan_timeout" };
        const bytes = Buffer.byteLength(line, "utf8") + 1;
        if (!onBytes(bytes)) return { miss: "scan_limit_exceeded" };
        const matched = matcher(line);
        if (matched != null) {
          return { payload: deepRedactValue(matched) };
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    return null;
  }

  private async withSerializedScan<T>(fn: () => Promise<T>): Promise<T> {
    const current = sourceLookupQueue.then(fn, fn);
    sourceLookupQueue = current.then(() => undefined, () => undefined);
    return current;
  }

  private async expandCandidatesForSessionId(
    sessionId: string,
    roots: string[],
    deadline: number,
    visitedSessionIds: Set<string>,
    hops: number,
    extraBasenames?: Set<string>,
  ): Promise<string[]> {
    if (Date.now() > deadline) return [];
    if (visitedSessionIds.has(sessionId)) return [];
    if (hops > (this.options.maxParentHops ?? DEFAULT_MAX_PARENT_HOPS)) return [];
    visitedSessionIds.add(sessionId);

    const matches: string[] = [];
    for (const root of roots) {
      const dirEntries = safeReadDir(root);
      for (const basename of dirEntries) {
        if (matchesTranscriptCandidateForSession(sessionId, basename, extraBasenames)) {
          const fullPath = path.join(root, basename);
          if (isTrustedPath(fullPath, roots)) {
            matches.push(fullPath);
          }
        }
      }
    }

    const deduped = dedupe(matches);
    const parents: string[] = [];
    for (const candidate of deduped) {
      const parsed = resolveTranscriptSourceCandidates({ sessionFile: candidate });
      if (!parsed.candidates.some((entry) => entry.type === "compaction_successor")) continue;
      const parentSession = await inspectParentSession(candidate, deadline);
      if (parentSession && !visitedSessionIds.has(parentSession)) {
        parents.push(...await this.expandCandidatesForSessionId(parentSession, roots, deadline, visitedSessionIds, hops + 1));
      }
    }
    return dedupe([...deduped, ...parents]);
  }
}

export function isSourceLookupEnabled(config?: {
  sourceLookupEnabled?: boolean;
  sourceLookupDirs?: string[];
}): boolean {
  return config?.sourceLookupEnabled === true;
}

export function hasTrustedSourceRoots(sessionFile?: string | null, sourceLookupDirs?: string[]): boolean {
  return collectTrustedRoots(sessionFile, sourceLookupDirs).length > 0;
}

function capPayloadForResponse(payload: unknown, maxBytes: number): {
  payload: unknown;
  bytes: number;
  truncated: boolean;
} {
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes <= maxBytes) {
    return { payload, bytes, truncated: false };
  }
  // Oversized source payloads are normalized into the same structured-preview
  // envelope used elsewhere so API consumers still receive valid JSON plus an
  // explicit truncated marker instead of a broken partial object/string.
  return {
    payload: buildStructuredPreview(payload, { maxSerializedBytes: maxBytes }),
    bytes,
    truncated: true,
  };
}

function safeParseJson(line: string): any {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function safeReadDir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

async function inspectParentSession(filePath: string, deadline: number): Promise<string | null> {
  if (!fs.existsSync(filePath)) return null;
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let linesRead = 0;
  try {
    for await (const line of rl) {
      if (Date.now() > deadline) return null;
      const parsed = safeParseJson(line);
      if (parsed && typeof parsed.parentSession === "string" && parsed.parentSession.trim()) {
        return parsed.parentSession.trim();
      }
      linesRead += 1;
      if (linesRead >= 20) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

function collectTrustedRoots(sessionFile?: string | null, sourceLookupDirs?: string[]): string[] {
  const roots = new Set<string>();
  if (sessionFile) {
    roots.add(path.dirname(path.resolve(sessionFile)));
  }
  for (const root of sourceLookupDirs ?? []) {
    if (root?.trim()) roots.add(path.resolve(root));
  }
  return [...roots].filter((root) => {
    try {
      return fs.existsSync(root) && fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

function isTrustedPath(candidatePath: string, roots: string[]): boolean {
  const resolvedCandidate = safeRealPath(candidatePath);
  return roots.some((root) => {
    const resolvedRoot = safeRealPath(root);
    return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
  });
}

function safeRealPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function deepRedactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => deepRedactValue(item));
  }
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitivePreviewKey(key) ? "[redacted]" : deepRedactValue(entry);
  }
  return result;
}

function looksLikeToolCallPayload(value: unknown, toolCallId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.role === "assistant" && containsToolCallId(record, toolCallId)) return true;
  if (matchesToolCallRecord(record, toolCallId)) return true;
  return false;
}

function looksLikeToolResultPayload(value: unknown, toolCallId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.role === "tool" && containsToolCallId(record, toolCallId)) return true;
  if (matchesToolResultRecord(record, toolCallId)) return true;
  return false;
}

function matchesToolCallRecord(record: Record<string, unknown>, toolCallId: string): boolean {
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if ((type === "toolcall" || type === "tool_call") && (record.id === toolCallId || record.toolCallId === toolCallId || record.tool_call_id === toolCallId)) {
    return true;
  }
  return false;
}

function matchesToolResultRecord(record: Record<string, unknown>, toolCallId: string): boolean {
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if ((type === "toolresult" || type === "tool_result") && (record.toolCallId === toolCallId || record.tool_call_id === toolCallId)) {
    return true;
  }
  return false;
}

function containsToolCallId(value: unknown, toolCallId: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsToolCallId(item, toolCallId));
  }
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.toolCallId === toolCallId || record.tool_call_id === toolCallId) return true;
  if (record.id === toolCallId) {
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (type.includes("tool")) return true;
  }
  return Object.values(record).some((entry) => containsToolCallId(entry, toolCallId));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function matchesTranscriptCandidateForSession(
  sessionId: string,
  basename: string,
  extraBasenames?: Set<string>,
): boolean {
  if (extraBasenames?.has(basename)) return true;
  const parsed = resolveTranscriptSourceCandidates({ sessionFile: basename });
  return parsed.sessionId === sessionId && parsed.candidates.some((candidate) => candidate.basename === basename);
}
