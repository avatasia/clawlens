import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Collector } from "./src/collector.js";
import { Comparator } from "./src/comparator.js";
import { Store } from "./src/store.js";
import { SSEManager } from "./src/sse-manager.js";
import { registerApiRoutes } from "./src/api-routes.js";
import { registerStaticRoutes } from "./src/static-server.js";
import type { ClawLensConfig } from "./src/types.js";

const defaultConfig: ClawLensConfig = {
  collector: { enabled: true, snapshotIntervalMs: 60_000, retentionDays: 30 },
  compare: { enabled: false, models: [], channels: [], timeoutMs: 300_000, maxConcurrent: 3 },
};

export default definePluginEntry({
  id: "clawlens",
  name: "ClawLens",
  description: "Session monitor + multi-model comparator",
  register(api: OpenClawPluginApi) {
    const config: ClawLensConfig = { ...defaultConfig, ...(api.pluginConfig as ClawLensConfig) };
    const stateDir = api.runtime.state.resolveStateDir();
    const store = new Store(stateDir);
    const sseManager = new SSEManager();
    const collector = new Collector(store, sseManager);
    const comparator = new Comparator(store, sseManager, api.runtime, stateDir);

    if (config.collector?.enabled !== false) {
      api.runtime.events.onAgentEvent((evt: any) => collector.handleAgentEvent(evt));
      api.on("llm_output", (event: any, ctx: any) => collector.recordLlmCall(event, ctx));
      api.on("llm_input", (event: any, ctx: any) => collector.recordLlmInput(event, ctx));
      api.on("after_tool_call", (event: any, ctx: any) => collector.recordToolCall(event, ctx));
      api.on("agent_end", (event: any, ctx: any) => collector.recordAgentEnd(event, ctx));
    }

    if (config.compare?.enabled) {
      api.on("before_agent_start", (event: any, ctx: any) =>
        comparator.maybeForCompare(event, ctx, config.compare!),
      );
    }

    registerApiRoutes(api as any, store, sseManager);
    registerStaticRoutes(api as any, path.join(api.rootDir!, "ui"));

    api.registerService({
      id: "clawlens-service",
      start: async () => {
        collector.start(api.runtime, api.config, config);
        api.logger.info("ClawLens plugin started");
      },
      stop: async () => {
        collector.stop();
        sseManager.closeAll();
        store.cleanup(config.collector?.retentionDays ?? 30);
        store.close();
      },
    });
  },
});
