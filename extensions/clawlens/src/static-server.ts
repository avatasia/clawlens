import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const ALLOWED_EXTENSIONS = new Set([".js", ".css", ".html", ".svg", ".png"]);

const MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

type PluginApi = {
  registerHttpRoute(opts: {
    method?: string;
    path: string;
    match?: "prefix" | "exact";
    auth?: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): void;
};

export function registerStaticRoutes(api: PluginApi, rootDir: string): void {
  api.registerHttpRoute({
    path: "/plugins/clawlens/ui",
    match: "prefix",
    auth: "plugin",
    handler(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const suffix = url.pathname.replace(/^\/plugins\/clawlens\/ui/, "") || "/index.html";

      const ext = path.extname(suffix);
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }

      const resolved = path.resolve(rootDir, suffix.replace(/^\//, ""));
      if (!resolved.startsWith(rootDir)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }

      let content: Buffer;
      try {
        content = fs.readFileSync(resolved);
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(content);
    },
  });
}
