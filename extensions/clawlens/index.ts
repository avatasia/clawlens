import fs from "node:fs";
import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Collector } from "./src/collector.js";
import { Comparator } from "./src/comparator.js";
import { Store } from "./src/store.js";
import { SSEManager } from "./src/sse-manager.js";
import { registerApiRoutes } from "./src/api-routes.js";
import { registerStaticRoutes } from "./src/static-server.js";
import { importLoggerMappings } from "./src/logger-import.js";
import type { ClawLensConfig } from "./src/types.js";

const UI_ASSET_VERSION = "20260402-2";
const SCRIPT_TAG = `<script data-clawlens-ui="inject" src="/plugins/clawlens/ui/inject.js?v=${UI_ASSET_VERSION}"></script>`;
const STYLE_TAG  = `<link data-clawlens-ui="styles" rel="stylesheet" href="/plugins/clawlens/ui/styles.css?v=${UI_ASSET_VERSION}">`;

function assertSupportedNodeVersion(): void {
  const [majorRaw, minorRaw] = (process.versions.node ?? "0.0.0").split(".");
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const ok = Number.isFinite(major) && Number.isFinite(minor) &&
    (major > 22 || (major === 22 && minor >= 5));
  if (!ok) {
    throw new Error(`ClawLens requires Node.js 22.5.0+ (current: ${process.versions.node})`);
  }
}

function findControlUiIndexHtml(rootDir: string): string | null {
  const candidates = [
    // npm global install: argv[1] is the openclaw bin
    path.resolve(process.argv[1] ?? "", "../dist/control-ui/index.html"),
    path.resolve(process.argv[1] ?? "", "../../dist/control-ui/index.html"),
    // Relative from this file (monorepo dev)
    path.resolve(import.meta.dirname, "../../../../dist/control-ui/index.html"),
    path.resolve(import.meta.dirname, "../../../../../dist/control-ui/index.html"),
    // Installed as a dependency of the extension
    path.join(rootDir, "node_modules", "openclaw", "dist", "control-ui", "index.html"),
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

    const styleRe = /<link\b[^>]*\/plugins\/clawlens\/ui\/styles\.css(?:\?[^"]*)?[^>]*>\s*/g;
    const scriptRe = /<script\b[^>]*\/plugins\/clawlens\/ui\/inject\.js(?:\?[^"]*)?[^>]*><\/script>\s*/g;
    const hadStyle = styleRe.test(html);
    const hadScript = scriptRe.test(html);

    if (hadStyle) {
      html = html.replace(styleRe, "");
      patched = true;
    }
    if (hadScript) {
      html = html.replace(scriptRe, "");
      patched = true;
    }

    if (!hadStyle) {
      html = html.replace("</head>", `  ${STYLE_TAG}\n</head>`);
      patched = true;
    }
    if (!hadScript) {
      html = html.replace("</body>", `  ${SCRIPT_TAG}\n</body>`);
      patched = true;
    }

    if (hadStyle) {
      html = html.replace("</head>", `  ${STYLE_TAG}\n</head>`);
    }
    if (hadScript) {
      html = html.replace("</body>", `  ${SCRIPT_TAG}\n</body>`);
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
  collector: {
    enabled: true,
    snapshotIntervalMs: 60_000,
    retentionDays: 30,
    debugLogs: false,
    loggerImportMaxFileSizeMb: 100,
  },
  compare: { enabled: false, models: [], channels: [], timeoutMs: 300_000, maxConcurrent: 3 },
};

export default definePluginEntry({
  id: "clawlens",
  name: "ClawLens",
  description: "Session monitor + multi-model comparator",
  register(api: OpenClawPluginApi) {
    assertSupportedNodeVersion();
    const userConfig = (api.pluginConfig ?? {}) as Partial<ClawLensConfig>;
    const config: ClawLensConfig = {
      collector: { ...defaultConfig.collector, ...(userConfig.collector ?? {}) },
      compare:   { ...defaultConfig.compare,   ...(userConfig.compare   ?? {}) },
    };
    const stateDir = api.runtime.state.resolveStateDir();
    const store = new Store(stateDir);
    const sseManager = new SSEManager();
    const collector = new Collector(store, sseManager);
    const comparator = new Comparator(store, sseManager, api.runtime, stateDir);

    if (config.collector?.enabled !== false) {
      store.setDebugEnabled(config.collector?.debugLogs);
      api.runtime.events.onAgentEvent((evt: any) => collector.handleAgentEvent(evt));
      api.runtime.events.onSessionTranscriptUpdate((update: any) => collector.recordTranscriptUpdate(update));
      api.on("llm_output", (event: any, ctx: any) => collector.recordLlmOutput(event, ctx));
      api.on("llm_input", (event: any, ctx: any) => collector.recordLlmInput(event, ctx));
      api.on("after_tool_call", (event: any, ctx: any) => collector.recordToolCall(event, ctx));
      api.on("agent_end", (event: any, ctx: any) => collector.recordAgentEnd(event, ctx));
    }

    if (config.compare?.enabled) {
      api.on("before_agent_start", (event: any, ctx: any) =>
        comparator.maybeForCompare(event, ctx, config.compare!),
      );
    }

    registerApiRoutes(api as any, store, sseManager, config);
    registerStaticRoutes(api as any, path.join(api.rootDir!, "ui"));

    api.registerService({
      id: "clawlens-service",
      start: async () => {
        collector.start(api.runtime, api.config, config);
        if (config.collector?.loggerImportDir) {
          try {
            const result = await importLoggerMappings({
              store,
              config: config.collector,
            });
            if (result.wasSkipped) {
              api.logger.info(`ClawLens: skipped logger import (${result.skipReason}) for ${result.file}`);
            } else {
              api.logger.info(
                `ClawLens: logger import finished for ${result.file} ` +
                `(mappings=${result.totalMappings}, applied=${result.applied}, skipped=${result.skipped})`,
              );
            }
          } catch (err) {
            api.logger.warn(`ClawLens: logger import failed: ${String(err)}`);
          }
        }
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
