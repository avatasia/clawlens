export function isClawLensDebugEnabled(configValue?: boolean): boolean {
  if (typeof configValue === "boolean") return configValue;
  const raw = process.env.CLAWLENS_DEBUG?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function logClawLensDebug(
  prefix: string,
  message: string,
  details: Record<string, unknown>,
  enabled?: boolean,
): void {
  if (!enabled) return;
  try {
    console.info(`[${prefix}] ${message} ${JSON.stringify(details)}`);
  } catch {
    console.info(`[${prefix}] ${message}`);
  }
}
