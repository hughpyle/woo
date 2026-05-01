// MCP gateway — per-process state manager for the streamable-HTTP transport.
// Owns ONE McpHost per WooWorld so the $actor:wait/focus/etc. native handlers
// only register once. Each MCP session binds a queue inside that host and
// gets its own server + transport.
//
// First-request auth uses either the `Mcp-Token` header or, for MCP clients
// that only expose bearer-token configuration, `Authorization: Bearer <token>`.
// The token value is one of the woo token classes: guest:, bearer:, apikey:,
// wizard:. The server resolves it to a woo session, generates an
// Mcp-Session-Id, and binds a McpHost queue to it. Subsequent requests carry
// Mcp-Session-Id.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AppliedFrame, DirectResultFrame, ObjRef, Session } from "../core/types";
import type { WooWorld } from "../core/world";
import { createMcpServer } from "./server";
import { McpHost, type McpBroadcastHooks } from "./host";

const MCP_TOKEN_HEADER = "mcp-token";
const MCP_SESSION_HEADER = "mcp-session-id";
const AUTHORIZATION_HEADER = "authorization";

type SessionEntry = {
  woo: Session;
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
};

export type McpGatewayOptions = {
  serverName?: string;
  serverVersion?: string;
  broadcasts?: McpBroadcastHooks;
};

export class McpGateway {
  readonly host: McpHost;
  private sessions = new Map<string, SessionEntry>();

  constructor(private world: WooWorld, private options: McpGatewayOptions = {}) {
    this.host = new McpHost(world);
    if (options.broadcasts) this.host.setBroadcastHooks(options.broadcasts);
  }

  setBroadcastHooks(hooks: McpBroadcastHooks): void {
    this.host.setBroadcastHooks(hooks);
  }

  async handle(request: Request): Promise<Response> {
    const headers = request.headers;

    if (request.method === "DELETE") {
      const id = headers.get(MCP_SESSION_HEADER);
      if (id) this.closeSession(id);
      return new Response(null, { status: 204 });
    }

    const sessionHeader = headers.get(MCP_SESSION_HEADER);
    let entry: SessionEntry | undefined = sessionHeader ? this.sessions.get(sessionHeader) : undefined;

    if (!entry) {
      if (request.method !== "POST") {
        return jsonError(401, "E_NOSESSION", "mcp gateway requires Mcp-Session-Id (or POST + auth token to initialize)");
      }
      const token = authTokenFromHeaders(headers);
      if (!token) {
        return jsonError(401, "E_NOSESSION", "first MCP request must include Mcp-Token or Authorization: Bearer <token>");
      }
      try {
        const woo = this.world.auth(token);
        entry = this.bind(woo);
      } catch (err) {
        const error = err as { code?: string; message?: string };
        return jsonError(401, error.code ?? "E_NOSESSION", error.message ?? "auth failed");
      }
    }

    const response = await entry.transport.handleRequest(withRequiredMcpAccept(request));
    const transportId = entry.transport.sessionId;
    if (transportId && !this.sessions.has(transportId)) {
      this.sessions.set(transportId, entry);
      this.host.bindSession(transportId, entry.woo.actor);
    }
    return response;
  }

  // ----- broadcast routing — called by the host runtime so external
  // observations reach MCP-attached agents the same way they reach WS clients.

  routeAppliedFrame(frame: AppliedFrame): void {
    this.host.routeAppliedFrame(frame, null);
  }

  routeLiveEvents(result: DirectResultFrame): void {
    this.host.routeLiveEvents(result, null);
  }

  closeSession(id: string): void {
    const entry = this.sessions.get(id);
    if (entry) {
      void entry.transport.close().catch(() => {});
      this.sessions.delete(id);
    }
    this.host.unbindSession(id);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  // Visible for tests / dev introspection: bind a session id directly without
  // going through the HTTP transport. Used by tests that drive the host API
  // without an MCP client.
  bindActorSession(sessionId: string, actor: ObjRef): void {
    this.host.bindSession(sessionId, actor);
  }

  private bind(woo: Session): SessionEntry {
    const { server } = createMcpServer({
      world: this.world,
      host: this.host,
      actor: woo.actor,
      sessionId: woo.id,
      serverName: this.options.serverName ?? "woo",
      serverVersion: this.options.serverVersion ?? "0.0.0"
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomSessionId(),
      enableJsonResponse: true,
      onsessionclosed: (id) => { this.closeSession(id); }
    });

    void server.connect(transport).catch(() => {});

    return { woo, server, transport };
  }
}

function authTokenFromHeaders(headers: Headers): string | null {
  const explicit = headers.get(MCP_TOKEN_HEADER)?.trim();
  if (explicit) return explicit;
  const authorization = headers.get(AUTHORIZATION_HEADER)?.trim();
  if (!authorization) return null;
  const match = /^bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function withRequiredMcpAccept(request: Request): Request {
  const headers = new Headers(request.headers);
  const accept = headers.get("accept") ?? "";
  const needed = ["application/json", "text/event-stream"].filter((type) => !accept.toLowerCase().includes(type));
  if (needed.length === 0) return request;
  headers.set("accept", [accept.trim(), ...needed].filter(Boolean).join(", "));
  return new Request(request, { headers });
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function randomSessionId(): string {
  const crypto = (globalThis as unknown as { crypto: { randomUUID: () => string } }).crypto;
  return crypto.randomUUID();
}

export type { ObjRef };
