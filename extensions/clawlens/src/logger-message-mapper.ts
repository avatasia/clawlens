import fs from "node:fs";
import readline from "node:readline";

export type LoggerPromptKind =
  | "user-entry"
  | "subagent-task"
  | "subagent-announce"
  | "startup"
  | "cron"
  | "slug"
  | "other";

export type LoggerRecordHeader = {
  timestamp: string;
  provider?: string;
  model?: string;
  runId: string;
  sessionId?: string;
  durationMs?: number;
  status?: string;
};

export type LoggerRecord = {
  header: LoggerRecordHeader;
  request: string;
  response: string;
};

export type ParsedLoggerMessageMapping = {
  runId: string;
  sessionId?: string;
  loggerTimestamp: string;
  promptKind: LoggerPromptKind;
  messageId: string;
  userTextPreview: string;
};

export function classifyPrompt(prompt: string): LoggerPromptKind {
  if (prompt.startsWith("Conversation info (untrusted metadata):")) return "user-entry";
  if (prompt.includes("[Subagent Task]:")) return "subagent-task";
  if (prompt.includes("[Internal task completion event]")) return "subagent-announce";
  if (prompt.startsWith("A new session was started via /new or /reset.")) return "startup";
  if (prompt.startsWith("[cron:")) return "cron";
  if (prompt.startsWith("Based on this conversation, generate a short 1-2 word filename slug")) return "slug";
  return "other";
}

export function shouldExtractMessageId(prompt: string): boolean {
  return classifyPrompt(prompt) === "user-entry";
}

export async function parseLoggerRecords(filePath: string): Promise<LoggerRecord[]> {
  const records: LoggerRecord[] = [];
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let header: LoggerRecordHeader | null = null;
  let state: "seek-header" | "expect-separator-1" | "request" | "response" = "seek-header";
  let requestLines: string[] = [];
  let responseLines: string[] = [];

  const commit = () => {
    if (!header) return;
    records.push({
      header,
      request: requestLines.join("\n"),
      response: responseLines.join("\n"),
    });
    header = null;
    requestLines = [];
    responseLines = [];
    state = "seek-header";
  };

  for await (const line of rl) {
    if (state === "seek-header") {
      if (!line.startsWith("{\"timestamp\"")) continue;
      try {
        header = JSON.parse(line) as LoggerRecordHeader;
        state = "expect-separator-1";
      } catch {
        header = null;
        state = "seek-header";
      }
      continue;
    }

    if (state === "expect-separator-1") {
      if (line === "------") {
        state = "request";
      } else {
        header = null;
        state = "seek-header";
      }
      continue;
    }

    if (state === "request") {
      if (line === "------") {
        state = "response";
      } else {
        requestLines.push(line);
      }
      continue;
    }

    if (state === "response") {
      if (line.startsWith("{\"timestamp\"")) {
        commit();
        try {
          header = JSON.parse(line) as LoggerRecordHeader;
          state = "expect-separator-1";
        } catch {
          header = null;
          state = "seek-header";
        }
      } else {
        responseLines.push(line);
      }
      continue;
    }
  }

  if (state === "response") commit();
  return records;
}

export function extractPrompt(request: string): string | null {
  const match = request.match(/"prompt":"([\s\S]*?)","historyMessages":/);
  return match ? match[1] : null;
}

export function extractPromptMessageId(prompt: string): string | null {
  if (!shouldExtractMessageId(prompt)) return null;
  const match = prompt.match(/\\"message_id\\"\s*:\s*\\"([^\\"]+)/);
  return match ? match[1] : null;
}

export function extractPromptUserText(prompt: string): string {
  if (!shouldExtractMessageId(prompt)) return "";
  const split = prompt.split("```\n\n");
  if (split.length >= 2) return split.slice(1).join("```\n\n").trim();
  const match = prompt.match(/```\n\n([\s\S]+)/);
  return match ? match[1].trim() : "";
}

export async function parseLoggerMessageMappings(filePath: string): Promise<ParsedLoggerMessageMapping[]> {
  const records = await parseLoggerRecords(filePath);
  const parsed: ParsedLoggerMessageMapping[] = [];
  for (const record of records) {
    const prompt = extractPrompt(record.request);
    if (!prompt) continue;
    const promptKind = classifyPrompt(prompt);
    if (promptKind !== "user-entry") continue;
    const messageId = extractPromptMessageId(prompt);
    if (!messageId) continue;
    parsed.push({
      runId: record.header.runId,
      sessionId: record.header.sessionId,
      loggerTimestamp: record.header.timestamp,
      promptKind,
      messageId,
      userTextPreview: extractPromptUserText(prompt).slice(0, 200),
    });
  }
  return parsed;
}
