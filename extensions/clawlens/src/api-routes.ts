import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";
import type { SSEManager } from "./sse-manager.js";
import type { ClawLensConfig } from "./types.js";
import { importLoggerMappings } from "./logger-import.js";

type PluginApi = {
  registerHttpRoute(opts: {
    method?: string;
    path: string;
    match?: "prefix" | "exact";
    auth?: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): void;
  config?: unknown;
};

function parseIntParam(value: string | null, defaultValue: number): number {
  if (value === null) return defaultValue;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultValue;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function getToken(api: PluginApi): string | undefined {
  return (api.config as any)?.auth?.token as string | undefined;
}

function authOk(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true; // no token configured → open
  const header = req.headers["authorization"] ?? "";
  const bearer = Array.isArray(header) ? header[0] : header;
  return bearer === `Bearer ${token}`;
}

function authOkQuery(url: URL, token: string | undefined): boolean {
  if (!token) return true;
  return url.searchParams.get("token") === token;
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

export function registerApiRoutes(api: PluginApi, store: Store, sseManager: SSEManager, pluginConfig?: ClawLensConfig): void {
  api.registerHttpRoute({
    path: "/plugins/clawlens/api",
    match: "prefix",
    auth: "plugin",
    async handler(req: IncomingMessage, res: ServerResponse) {
      try {
      const url = parseUrl(req);
      const pathname = url.pathname;
      const token = getToken(api);

      // SSE uses query token
      if (pathname.endsWith("/events")) {
        if (!authOkQuery(url, token)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const clientId = sseManager.addClient(res as ServerResponse);
        if (!clientId) {
          sendJson(res, 503, { error: "too many SSE clients" });
          return;
        }
        req.on("close", () => sseManager.removeClient(clientId));
        return;
      }

      // All other routes use Bearer token
      if (!authOk(req, token)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (pathname.endsWith("/overview")) {
        sendJson(res, 200, store.getOverview());
        return;
      }

      if (pathname.endsWith("/sessions")) {
        const filters: Record<string, unknown> = {};
        if (url.searchParams.has("channel")) filters.channel = url.searchParams.get("channel");
        if (url.searchParams.has("model")) filters.model = url.searchParams.get("model");
        if (url.searchParams.has("provider")) filters.provider = url.searchParams.get("provider");
        if (url.searchParams.has("limit")) filters.limit = parseIntParam(url.searchParams.get("limit"), 50);
        if (url.searchParams.has("offset")) filters.offset = parseIntParam(url.searchParams.get("offset"), 0);
        sendJson(res, 200, store.getSessions(filters as any));
        return;
      }

      // /audit/run/<runId>  — must be checked before generic /run/<runId>
      const auditRunMatch = pathname.match(/\/audit\/run\/([^/]+)$/);
      if (auditRunMatch) {
        const runId = decodeURIComponent(auditRunMatch[1]);
        const detail = store.getAuditRun(runId);
        if (!detail) { sendJson(res, 404, { error: "run not found" }); return; }
        sendJson(res, 200, detail);
        return;
      }

      // /audit/message/<messageId>
      const auditMessageMatch = pathname.match(/\/audit\/message\/([^/]+)$/);
      if (auditMessageMatch) {
        const messageId = decodeURIComponent(auditMessageMatch[1]);
        const detail = store.getAuditMessage(messageId);
        if (!detail) { sendJson(res, 404, { error: "message not found" }); return; }
        sendJson(res, 200, detail);
        return;
      }

      // /run/<runId>
      const runMatch = pathname.match(/\/run\/([^/]+)$/);
      if (runMatch) {
        const runId = decodeURIComponent(runMatch[1]);
        const detail = store.getRunDetail(runId);
        if (!detail.run) {
          sendJson(res, 404, { error: "run not found" });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }

      // /audit/logger/import
      if (pathname.endsWith("/audit/logger/import")) {
        if ((req.method ?? "GET").toUpperCase() !== "POST") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        const collectorConfig = pluginConfig?.collector ?? {};
        try {
          const result = await importLoggerMappings({
            store,
            config: collectorConfig,
            requestedFile: url.searchParams.get("file"),
            force: url.searchParams.get("force") === "1",
          });
          sendJson(res, 200, {
            ok: true,
            ...result,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("too large")) {
            sendJson(res, 413, { error: message });
            return;
          }
          sendJson(res, 400, { error: message });
        }
        return;
      }

      // /audit/session/<sessionKey>/current-message-run
      const currentMessageRunMatch = pathname.match(/\/audit\/session\/(.+)\/current-message-run$/);
      if (currentMessageRunMatch) {
        const sessionKey = decodeURIComponent(currentMessageRunMatch[1]);
        sendJson(res, 200, store.getCurrentMessageRun(sessionKey));
        return;
      }

      // /audit/session/<sessionKey>  — must be checked before /audit
      const auditSessionMatch = pathname.match(/\/audit\/session\/(.+)$/);
      if (auditSessionMatch) {
        const sessionKey = decodeURIComponent(auditSessionMatch[1]);
        const limit = parseIntParam(url.searchParams.get("limit"), 20);
        const before = url.searchParams.has("before")
          ? parseIntParam(url.searchParams.get("before"), 0)
          : undefined;
        const since = url.searchParams.has("since")
          ? parseIntParam(url.searchParams.get("since"), 0)
          : undefined;
        const includeDetails = url.searchParams.get("compact") === "1" ? false : true;
        const excludeKinds = url.searchParams.getAll("excludeKinds").flatMap((value) =>
          value.split(",").map((item) => item.trim()).filter(Boolean),
        );
        const requireConversation = url.searchParams.get("requireConversation") === "1";
        sendJson(res, 200, store.getAuditSession(sessionKey, {
          limit,
          before,
          since,
          includeDetails,
          excludeKinds,
          requireConversation,
        }));
        return;
      }

      // /audit
      if (pathname.endsWith("/audit")) {
        const days = parseIntParam(url.searchParams.get("days"), 7);
        const channel = url.searchParams.get("channel") ?? undefined;
        const limit = parseIntParam(url.searchParams.get("limit"), 100);
        sendJson(res, 200, store.getAuditSessions({ channel, days, limit }));
        return;
      }

      sendJson(res, 404, { error: "not found" });
      } catch (err) {
        sendJson(res, 500, { error: "internal server error" });
      }
    },
  });
}
