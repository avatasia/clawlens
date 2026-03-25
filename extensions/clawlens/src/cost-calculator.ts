type ModelCostConfig = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function calculateCost(
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  costConfig: ModelCostConfig | undefined,
): number | null {
  if (!costConfig) return null;
  return (
    (usage.input ?? 0) * costConfig.input +
    (usage.output ?? 0) * costConfig.output +
    (usage.cacheRead ?? 0) * costConfig.cacheRead +
    (usage.cacheWrite ?? 0) * costConfig.cacheWrite
  );
}

export function loadCostConfig(config: unknown): Map<string, ModelCostConfig> {
  const map = new Map<string, ModelCostConfig>();
  const providers = (config as any)?.models?.providers;
  if (!providers || typeof providers !== "object") return map;
  for (const [pName, pConfig] of Object.entries(providers)) {
    const models = (pConfig as any)?.models;
    if (!models || typeof models !== "object") continue;
    for (const [mName, mConfig] of Object.entries(models)) {
      const cost = (mConfig as any)?.cost;
      if (cost && typeof cost.input === "number") map.set(`${pName}:${mName}`, cost as ModelCostConfig);
    }
  }
  return map;
}
