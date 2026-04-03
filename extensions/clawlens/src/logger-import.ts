import fs from "node:fs";
import path from "node:path";
import type { Store } from "./store.js";
import type { ClawLensConfig } from "./types.js";
import { parseLoggerMessageMappings } from "./logger-message-mapper.js";

type LoggerImportConfig = NonNullable<ClawLensConfig["collector"]>;

export function resolveLoggerImportFile(
  config: LoggerImportConfig,
  requestedFile?: string | null,
): string {
  const importDir = config.loggerImportDir?.trim();
  if (!importDir) throw new Error("collector.loggerImportDir is not configured");
  const dirPath = path.resolve(importDir);
  if (!fs.existsSync(dirPath)) throw new Error(`logger import dir not found: ${dirPath}`);
  if (!fs.statSync(dirPath).isDirectory()) throw new Error(`logger import dir is not a directory: ${dirPath}`);

  if (requestedFile && requestedFile.trim()) {
    const basename = path.basename(requestedFile.trim());
    const candidate = path.resolve(dirPath, basename);
    if (!candidate.startsWith(dirPath + path.sep) && candidate !== path.join(dirPath, basename)) {
      throw new Error("invalid logger file path");
    }
    if (!fs.existsSync(candidate)) throw new Error(`logger file not found: ${basename}`);
    return candidate;
  }

  const entries = fs.readdirSync(dirPath)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .reverse();
  if (entries.length === 0) throw new Error(`no .jsonl files found in ${dirPath}`);
  return path.join(dirPath, entries[0]);
}

export async function importLoggerMappings(params: {
  store: Store;
  config: LoggerImportConfig;
  requestedFile?: string | null;
  force?: boolean;
}): Promise<{
  file: string;
  totalMappings: number;
  applied: number;
  skipped: number;
  wasSkipped: boolean;
  skipReason?: string;
  sizeBytes: number;
}> {
  const filePath = resolveLoggerImportFile(params.config, params.requestedFile);
  const stat = fs.statSync(filePath);
  const maxSizeMb = params.config.loggerImportMaxFileSizeMb ?? 100;
  if (stat.size > maxSizeMb * 1024 * 1024) {
    throw new Error(`logger file too large: ${filePath} (${stat.size} bytes > ${maxSizeMb}MB)`);
  }

  const previous = params.store.getLoggerImportState(filePath);
  const fileMtimeMs = Math.floor(stat.mtimeMs);
  if (!params.force && previous &&
      previous.fileMtimeMs === fileMtimeMs &&
      previous.fileSizeBytes === stat.size) {
    return {
      file: filePath,
      totalMappings: previous.totalMappings,
      applied: previous.appliedCount,
      skipped: previous.skippedCount,
      wasSkipped: true,
      skipReason: "unchanged file already imported",
      sizeBytes: stat.size,
    };
  }

  const mappings = await parseLoggerMessageMappings(filePath);
  let applied = 0;
  let skipped = 0;
  for (const mapping of mappings) {
    const ok = params.store.applyLoggerMessageMapping({
      messageId: mapping.messageId,
      runId: mapping.runId,
      userTextPreview: mapping.userTextPreview,
      loggerTimestamp: mapping.loggerTimestamp,
      sourceSessionId: mapping.sessionId,
    });
    if (ok) applied++;
    else skipped++;
  }

  params.store.recordLoggerImportState({
    filePath,
    fileMtimeMs,
    fileSizeBytes: stat.size,
    totalMappings: mappings.length,
    appliedCount: applied,
    skippedCount: skipped,
  });

  return {
    file: filePath,
    totalMappings: mappings.length,
    applied,
    skipped,
    wasSkipped: false,
    sizeBytes: stat.size,
  };
}
