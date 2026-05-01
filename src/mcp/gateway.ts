// MCP gateway — per-session state manager and Web-Standard HTTP transport
// binding. One MCP session per woo actor connection; sessions live in memory
// for the lifetime of the process (worker DO or local dev server).
//
// First-request auth uses the `Mcp-Token` header (one of the woo token
// classes: guest:, bearer:, apikey:, wizard:). The server resolves it to a
// woo session, generates an Mcp-Session-Id, and binds a McpHost + low-level
// MCP Server + transport. Subsequent requests carry Mcp-Session-Id.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ObjRef, Session } from "../core/types";
import type { WooWorld } from "../core/world";
import { createMcpServer } from "./server";
import type { McpHost } from "./host";

const MCP_TOKEN_HEADER = "mcp-token";
const MCP_SESSION_HEADER = "mcp-session-id";

type SessionEntry = {
  woo: Session;
  host: McpHost;
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
};

export type McpGatewayOptions = {
  serverName?: string;
  serverVersion?: string;
};

export class McpGateway {
  private sessions = new Map<string, SessionEntry>();

  constructor(private world: WooWorld, private options: McpGatewayOptions = {}) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers = request.headers;

    // DELETE /mcp closes a session.
    if (request.method === "DELETE") {
      const id = headers.get(MCP_SESSION_HEADER);
      if (id) this.closeSession(id);
      return new Response(null, { status: 204 });
    }

    const sessionHeader = headers.get(MCP_SESSION_HEADER);
    let entry: SessionEntry | undefined = sessionHeader ? this.sessions.get(sessionHeader) : undefined;

    if (!entry) {
      // First-request auth path. POST is required for initialize.
      if (request.method !== "POST") {
        return jsonError(401, "E_NOSESSION", `mcp gateway requires Mcp-Session-Id (or POST + Mcp-Token to initialize): ${url.pathname}`);
      }
      const token = headers.get(MCP_TOKEN_HEADER);
      if (!token) {
        return jsonError(401, "E_NOSESSION", "first MCP request must include Mcp-Token header");
      }
      try {
        const woo = this.world.auth(token);
        entry = this.bind(woo);
      } catch (err) {
        const error = err as { code?: string; message?: string };
        return jsonError(401, error.code ?? "E_NOSESSION", error.message ?? "auth failed");
      }
    }

    const response = await entry.transport.handleRequest(request);
    // The transport's first-message handling assigns a sessionId; once it does,
    // re-key the entry so subsequent requests resolve via Mcp-Session-Id.
    const transportId = entry.transport.sessionId;
    if (transportId && !this.sessions.has(transportId)) {
      this.sessions.set(transportId, entry);
    }
    return response;
  }

  closeSession(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    void entry.transport.close().catch(() => {});
    this.sessions.delete(id);
  }

  // Visible for tests / dev introspection.
  sessionCount(): number {
    return this.sessions.size;
  }

  private bind(woo: Session): SessionEntry {
    const { server, host } = createMcpServer({
      world: this.world,
      actor: woo.actor,
      sessionId: woo.id,
      serverName: this.options.serverName ?? "woo",
      serverVersion: this.options.serverVersion ?? "0.0.0"
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomSessionId(),
      enableJsonResponse: true,
      onsessionclosed: (id) => { this.sessions.delete(id); }
    });

    void server.connect(transport).catch(() => {});

    return { woo, host, server, transport };
  }
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function randomSessionId(): string {
  // crypto.randomUUID is available in Workers, Node 19+, and modern Deno/Bun.
  // We rely on it via globalThis to avoid pulling node:crypto into the worker bundle.
  const crypto = (globalThis as unknown as { crypto: { randomUUID: () => string } }).crypto;
  return crypto.randomUUID();
}

// Re-export for callers that want to use ObjRef without dragging in core/types.
export type { ObjRef };
