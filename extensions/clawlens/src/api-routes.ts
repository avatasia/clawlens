import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";
import type { SSEManager } from "./sse-manager.js";

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

export function registerApiRoutes(api: PluginApi, store: Store, sseManager: SSEManager): void {
  api.registerHttpRoute({
    path: "/plugins/clawlens/api",
    match: "prefix",
    auth: "plugin",
    handler(req: IncomingMessage, res: ServerResponse) {
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
        if (url.searchParams.has("limit")) filters.limit = Number(url.searchParams.get("limit"));
        if (url.searchParams.has("offset")) filters.offset = Number(url.searchParams.get("offset"));
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

      // /audit/session/<sessionKey>  — must be checked before /audit
      const auditSessionMatch = pathname.match(/\/audit\/session\/(.+)$/);
      if (auditSessionMatch) {
        const sessionKey = decodeURIComponent(auditSessionMatch[1]);
        sendJson(res, 200, store.getAuditSession(sessionKey));
        return;
      }

      // /audit
      if (pathname.endsWith("/audit")) {
        const days = url.searchParams.has("days") ? Number(url.searchParams.get("days")) : 7;
        const channel = url.searchParams.get("channel") ?? undefined;
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100;
        sendJson(res, 200, store.getAuditSessions({ channel, days, limit }));
        return;
      }

      sendJson(res, 404, { error: "not found" });
    },
  });
}
