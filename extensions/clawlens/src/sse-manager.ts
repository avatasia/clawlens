import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export class SSEManager {
  private clients = new Map<string, ServerResponse>();
  private maxClients = 10;

  addClient(res: ServerResponse): string | null {
    if (this.clients.size >= this.maxClients) return null;
    const id = randomUUID();
    this.clients.set(id, res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    this.sendTo(id, { type: "connected" });
    return id;
  }

  removeClient(id: string): void {
    this.clients.delete(id);
  }

  broadcast(payload: object): void {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const [id, res] of this.clients) {
      try {
        res.write(data);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  private sendTo(id: string, payload: object): void {
    const res = this.clients.get(id);
    if (res) {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  closeAll(): void {
    for (const [, res] of this.clients) {
      try {
        res.end();
      } catch {}
    }
    this.clients.clear();
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
