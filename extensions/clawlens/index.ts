import fs from "node:fs";
import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Collector } from "./src/collector.js";
import { Comparator } from "./src/comparator.js";
import { Store } from "./src/store.js";
import { SSEManager } from "./src/sse-manager.js";
import { registerApiRoutes } from "./src/api-routes.js";
import { registerStaticRoutes } from "./src/static-server.js";
import type { ClawLensConfig } from "./src/types.js";

const SCRIPT_TAG = '<script src="/plugins/clawlens/ui/inject.js"></script>';
const STYLE_TAG  = '<link rel="stylesheet" href="/plugins/clawlens/ui/styles.css">';

function findControlUiIndexHtml(rootDir: string): string | null {
  const candidates = [
    // Installed as a dependency of the extension (most common)
    path.join(rootDir, "node_modules", "openclaw", "dist", "control-ui", "index.html"),
    // npm global install: argv[1] is the openclaw bin
    path.resolve(process.argv[1] ?? "", "../dist/control-ui/index.html"),
    path.resolve(process.argv[1] ?? "", "../../dist/control-ui/index.html"),
    // Relative from this file (monorepo dev)
    path.resolve(import.meta.dirname, "../../../../dist/control-ui/index.html"),
    path.resolve(import.meta.dirname, "../../../../../dist/control-ui/index.html"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.realpathSync(p);
    } catch { /* continue */ }
  }
  return null;
}

function patchControlUiIndexHtml(api: OpenClawPluginApi): void {
  try {
    const indexPath = findControlUiIndexHtml(api.rootDir!);
    if (!indexPath) {
      api.logger.warn("ClawLens: could not find Control UI index.html — inject.js will not load");
      return;
    }
    let html = fs.readFileSync(indexPath, "utf8");
    let patched = false;

    if (!html.includes("/plugins/clawlens/ui/styles.css")) {
      html = html.replace("</head>", `  ${STYLE_TAG}\n</head>`);
      patched = true;
    }
    if (!html.includes("/plugins/clawlens/ui/inject.js")) {
      html = html.replace("</body>", `  ${SCRIPT_TAG}\n</body>`);
      patched = true;
    }

    if (patched) {
      fs.writeFileSync(indexPath, html, "utf8");
      api.logger.info(`ClawLens: patched Control UI index.html at ${indexPath}`);
    } else {
      api.logger.info("ClawLens: Control UI index.html already patched");
    }
  } catch (err) {
    api.logger.warn("ClawLens: failed to patch index.html: " + String(err));
  }
}

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
        patchControlUiIndexHtml(api);
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
