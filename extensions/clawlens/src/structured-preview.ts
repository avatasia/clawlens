const DEFAULT_MAX_STRING_CHARS = 1000;
const DEFAULT_MAX_ARRAY_ITEMS = 20;
const DEFAULT_MAX_OBJECT_ENTRIES = 50;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_SERIALIZED_BYTES = 32 * 1024;
const STRUCTURED_PREVIEW_VERSION = 1 as const;
const SENSITIVE_KEY_SUBSTRINGS = [
  "key",
  "token",
  "password",
  "secret",
  "authorization",
  "cookie",
  "set-cookie",
  "api-key",
  "x-api-key",
] as const;

export type PreviewFormat = "text-legacy" | "structured-json-v1";

export type StructuredPreviewNode =
  | { kind: "null" }
  | { kind: "undefined" }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number | string }
  | { kind: "string"; value: string; length?: number; truncated?: true }
  | { kind: "string"; preview: string; length: number; truncated: true }
  | { kind: "redacted"; reason: "sensitive-key" }
  | { kind: "array"; items: StructuredPreviewNode[]; omittedItems?: number }
  | { kind: "object"; entries: Array<{ key: string; value: StructuredPreviewNode }>; omittedEntries?: number }
  | { kind: "depth_truncated"; depth: number; maxDepth: number }
  | { kind: "circular_reference" }
  | { kind: "max_bytes_truncated"; maxBytes: number; originalBytes: number };

export type StructuredPreviewEnvelope = {
  __clawlensPreview: {
    version: 1;
    node: StructuredPreviewNode;
    meta: {
      source: "structured-preview";
    };
  };
};

export type PreviewBuildOptions = {
  maxStringChars?: number;
  maxArrayItems?: number;
  maxObjectEntries?: number;
  maxDepth?: number;
  maxSerializedBytes?: number;
};

export type ParsePreviewFormatResult = {
  previewFormat: PreviewFormat;
  previewVersion: 1 | null;
  previewNode?: StructuredPreviewNode;
};

export type ResolveTranscriptSourceCandidatesInput = {
  sessionFile?: string | null;
};

export type TranscriptSourceCandidate = {
  type: "exact" | "reset" | "deleted" | "compaction_successor" | "compaction_checkpoint";
  sessionId: string;
  basename: string;
};

export type TranscriptSourceCandidateMiss =
  | "session_file_missing"
  | "session_id_unparseable"
  | "source_root_unavailable";

export type ResolveTranscriptSourceCandidatesResult = {
  sessionId: string | null;
  candidates: TranscriptSourceCandidate[];
  misses: TranscriptSourceCandidateMiss[];
};

type BuildContext = {
  maxStringChars: number;
  maxArrayItems: number;
  maxObjectEntries: number;
  maxDepth: number;
  seen: WeakSet<object>;
};

type RedactedPreviewSentinel = {
  __clawlensRedacted: true;
};

export function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function isSensitivePreviewKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (!normalized) return false;
  return SENSITIVE_KEY_SUBSTRINGS.some((part) => normalized.includes(part));
}

export function redactPreviewValueForKey(key: string, value: unknown): unknown {
  if (!isSensitivePreviewKey(key)) return value;
  return { __clawlensRedacted: true } satisfies RedactedPreviewSentinel;
}

export function buildStructuredPreview(
  value: unknown,
  options?: PreviewBuildOptions,
): StructuredPreviewEnvelope {
  const node = buildStructuredPreviewNode(value, options);
  const envelope = makeEnvelope(node);
  const serialized = JSON.stringify(envelope);
  const maxSerializedBytes = options?.maxSerializedBytes ?? DEFAULT_MAX_SERIALIZED_BYTES;
  if (Buffer.byteLength(serialized, "utf8") <= maxSerializedBytes) {
    return envelope;
  }
  return makeEnvelope({
    kind: "max_bytes_truncated",
    maxBytes: maxSerializedBytes,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
  });
}

export function serializePreviewForTextColumn(value: unknown, options?: PreviewBuildOptions): string {
  return JSON.stringify(buildStructuredPreview(value, options));
}

export function parsePreviewFormat(value: unknown): ParsePreviewFormatResult {
  if (typeof value !== "string" && (!value || typeof value !== "object")) {
    return { previewFormat: "text-legacy", previewVersion: null };
  }

  try {
    const parsed = typeof value === "string"
      ? JSON.parse(value) as StructuredPreviewEnvelope
      : value as StructuredPreviewEnvelope;
    if (typeof value === "string" && !value.trim()) {
      return { previewFormat: "text-legacy", previewVersion: null };
    }
    if (
      parsed
      && typeof parsed === "object"
      && parsed.__clawlensPreview
      && typeof parsed.__clawlensPreview === "object"
      && parsed.__clawlensPreview.version === STRUCTURED_PREVIEW_VERSION
      && parsed.__clawlensPreview.node
    ) {
      return {
        previewFormat: "structured-json-v1",
        previewVersion: STRUCTURED_PREVIEW_VERSION,
        previewNode: parsed.__clawlensPreview.node,
      };
    }
  } catch {
    // fall through
  }

  return { previewFormat: "text-legacy", previewVersion: null };
}

export function extractSearchTextFromPreview(previewText: string | null | undefined): string {
  if (!previewText) return "";
  const parsed = parsePreviewFormat(previewText);
  if (parsed.previewFormat === "text-legacy") {
    return previewText;
  }
  return extractSearchTextFromNode(parsed.previewNode);
}

export function extractMessageIdsFromPreview(previewText: string | null | undefined): string[] {
  if (!previewText) return [];
  const ids = new Set<string>();
  const parsed = parsePreviewFormat(previewText);
  if (parsed.previewFormat === "text-legacy") {
    collectMessageIdsFromText(previewText, ids);
    return [...ids];
  }
  collectMessageIdsFromNode(parsed.previewNode, ids);
  return [...ids];
}

export function resolveTranscriptSourceCandidates(
  input: ResolveTranscriptSourceCandidatesInput,
): ResolveTranscriptSourceCandidatesResult {
  const basename = getBasename(input.sessionFile);
  if (!basename) return { sessionId: null, candidates: [], misses: ["session_file_missing"] };

  const exact = basename.match(/^([0-9a-f-]{36})\.jsonl$/i);
  if (exact) {
    const sessionId = exact[1];
    return {
      sessionId,
      candidates: [{ type: "exact", sessionId, basename }],
      misses: [],
    };
  }

  const archived = basename.match(/^([0-9a-f-]{36})\.jsonl\.(reset|deleted)\..+$/i);
  if (archived) {
    const sessionId = archived[1];
    const type = archived[2].toLowerCase() === "reset" ? "reset" : "deleted";
    return {
      sessionId,
      candidates: [{ type, sessionId, basename }],
      misses: [],
    };
  }

  const checkpoint = basename.match(
    /^([0-9a-f-]{36})\.checkpoint\.([0-9a-f-]{8}-[0-9a-f-]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f-]{12})\.jsonl$/i,
  );
  if (checkpoint) {
    const sessionId = checkpoint[1];
    return {
      sessionId,
      candidates: [{ type: "compaction_checkpoint", sessionId, basename }],
      misses: [],
    };
  }

  const successor = basename.match(/^(.+)_([0-9a-f-]{36})\.jsonl$/i);
  if (successor) {
    const sessionId = successor[2];
    return {
      sessionId,
      candidates: [{ type: "compaction_successor", sessionId, basename }],
      misses: [],
    };
  }

  return { sessionId: null, candidates: [], misses: ["session_id_unparseable"] };
}

function buildStructuredPreviewNode(value: unknown, options?: PreviewBuildOptions): StructuredPreviewNode {
  const ctx: BuildContext = {
    maxStringChars: options?.maxStringChars ?? DEFAULT_MAX_STRING_CHARS,
    maxArrayItems: options?.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS,
    maxObjectEntries: options?.maxObjectEntries ?? DEFAULT_MAX_OBJECT_ENTRIES,
    maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
    seen: new WeakSet<object>(),
  };
  return visitValue(value, 0, ctx);
}

function visitValue(value: unknown, depth: number, ctx: BuildContext): StructuredPreviewNode {
  if (depth >= ctx.maxDepth) {
    return { kind: "depth_truncated", depth, maxDepth: ctx.maxDepth };
  }
  if (value === null) return { kind: "null" };
  if (value === undefined) return { kind: "undefined" };
  if (isRedactedPreviewSentinel(value)) return { kind: "redacted", reason: "sensitive-key" };
  if (typeof value === "string") return buildStringNode(value, ctx.maxStringChars);
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "number") return Number.isFinite(value) ? { kind: "number", value } : { kind: "number", value: String(value) };
  if (typeof value === "bigint") return { kind: "number", value: value.toString() };
  if (typeof value !== "object") {
    return buildStringNode(String(value), ctx.maxStringChars);
  }
  if (ctx.seen.has(value)) {
    return { kind: "circular_reference" };
  }
  ctx.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, ctx.maxArrayItems).map((item) => visitValue(item, depth + 1, ctx));
      const omittedItems = Math.max(0, value.length - items.length) || undefined;
      return omittedItems ? { kind: "array", items, omittedItems } : { kind: "array", items };
    }
    const entriesRaw = Object.entries(value as Record<string, unknown>);
    const entries = entriesRaw.slice(0, ctx.maxObjectEntries).map(([key, entryValue]) => ({
      key,
      value: visitValue(redactPreviewValueForKey(key, entryValue), depth + 1, ctx),
    }));
    const omittedEntries = Math.max(0, entriesRaw.length - entries.length) || undefined;
    return omittedEntries ? { kind: "object", entries, omittedEntries } : { kind: "object", entries };
  } finally {
    ctx.seen.delete(value);
  }
}

function buildStringNode(value: string, maxChars: number): StructuredPreviewNode {
  if (value.length <= maxChars) return { kind: "string", value };
  return {
    kind: "string",
    preview: value.slice(0, maxChars),
    length: value.length,
    truncated: true,
  };
}

function makeEnvelope(node: StructuredPreviewNode): StructuredPreviewEnvelope {
  return {
    __clawlensPreview: {
      version: STRUCTURED_PREVIEW_VERSION,
      node,
      meta: {
        source: "structured-preview",
      },
    },
  };
}

function extractSearchTextFromNode(node: StructuredPreviewNode | undefined): string {
  if (!node) return "";
  switch (node.kind) {
    case "string":
      return "value" in node ? node.value : node.preview;
    case "number":
      return String(node.value);
    case "boolean":
      return String(node.value);
    case "redacted":
      return "[redacted]";
    case "array":
      return node.items.map((item) => extractSearchTextFromNode(item)).filter(Boolean).join(" ");
    case "object":
      return node.entries
        .flatMap((entry) => [entry.key, extractSearchTextFromNode(entry.value)])
        .filter(Boolean)
        .join(" ");
    default:
      return "";
  }
}

function collectMessageIdsFromNode(node: StructuredPreviewNode | undefined, ids: Set<string>): void {
  if (!node) return;
  switch (node.kind) {
    case "string":
      collectMessageIdsFromText("value" in node ? node.value : node.preview, ids);
      return;
    case "array":
      for (const item of node.items) collectMessageIdsFromNode(item, ids);
      return;
    case "object":
      for (const entry of node.entries) {
        if (entry.key === "message_id" || entry.key === "messageId" || entry.key === "id") {
          const value = extractLeafString(entry.value);
          if (value) ids.add(value);
        }
        collectMessageIdsFromNode(entry.value, ids);
      }
      return;
    default:
      return;
  }
}

function extractLeafString(node: StructuredPreviewNode): string | undefined {
  if (node.kind !== "string") return undefined;
  return "value" in node ? node.value : node.preview;
}

function collectMessageIdsFromText(value: string, ids: Set<string>): void {
  const patterns = [
    /"message_id"\s*:\s*"([^"]+)"/g,
    /"messageId"\s*:\s*"([^"]+)"/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      const id = match[1]?.trim();
      if (id) ids.add(id);
    }
  }
}

function getBasename(sessionFile?: string | null): string | undefined {
  if (!sessionFile) return undefined;
  const normalized = sessionFile.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || undefined;
}

function isRedactedPreviewSentinel(value: unknown): value is RedactedPreviewSentinel {
  return !!value
    && typeof value === "object"
    && (value as Record<string, unknown>).__clawlensRedacted === true;
}
