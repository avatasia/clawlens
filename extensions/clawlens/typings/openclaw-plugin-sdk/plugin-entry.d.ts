/**
 * Minimal type stub for openclaw/plugin-sdk/plugin-entry.
 *
 * Vendored from the OpenClaw plugin SDK so that tsc --noEmit can type-check
 * ClawLens without requiring a full OpenClaw build.  Only the types that
 * ClawLens actually imports are declared here.
 *
 * This stub proves "local code is consistent with the declared surface",
 * NOT "ClawLens matches the live upstream SDK contract".  Import-path
 * existence against the reference source tree is separately checked by
 * scripts/verify-local-imports.mjs.
 *
 * Upstream source:  projects-ref/openclaw/src/plugin-sdk/plugin-entry.ts
 * Upstream commit:  61da711b1a (2026-04-11)
 * Upstream types:   projects-ref/openclaw/src/plugins/types.ts (OpenClawPluginApi et al.)
 */

/* ----- low-level building blocks ----- */

export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export type OpenClawPluginServiceContext = {
  config: unknown;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
};

export type OpenClawPluginService = {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
};

/* ----- PluginRuntime (minimal subset used by ClawLens index.ts) ----- */

export interface PluginRuntimeEvents {
  onAgentEvent(handler: (evt: unknown) => void): void;
  onSessionTranscriptUpdate(handler: (update: unknown) => void): void;
}

export interface PluginRuntimeState {
  resolveStateDir(): string;
}

export interface PluginRuntime {
  events: PluginRuntimeEvents;
  state: PluginRuntimeState;
  [key: string]: unknown;
}

/* ----- OpenClawPluginApi (subset used by ClawLens) ----- */

export type OpenClawPluginApi = {
  id: string;
  name: string;
  rootDir?: string;
  config: unknown;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  on(event: string, handler: (...args: unknown[]) => void): void;
  registerService(service: OpenClawPluginService): void;
  registerHttpRoute(params: {
    method?: string;
    path: string;
    match?: "prefix" | "exact";
    auth?: string;
    handler: (req: unknown, res: unknown) => void | Promise<void>;
  }): void;
  [key: string]: unknown;
};

/* ----- definePluginEntry ----- */

type DefinePluginEntryOptions = {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
};

export function definePluginEntry(opts: DefinePluginEntryOptions): {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
};
