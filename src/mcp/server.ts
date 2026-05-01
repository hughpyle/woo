// MCP server — wires McpHost to the official SDK's low-level Server so we
// can drive dynamic tool lists. The high-level McpServer wraps a static tool
// manifest and isn't suitable here.
//
// Transports (stdio, HTTP) plug a transport into this server; src/mcp/stdio.ts
// is the canonical entry point.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ObjRef, WooValue } from "../core/types";
import type { WooWorld } from "../core/world";
import { McpHost, type McpTool } from "./host";

export type McpServerOptions = {
  world: WooWorld;
  host: McpHost;
  actor: ObjRef;
  sessionId: string;
  serverName?: string;
  serverVersion?: string;
};

export type McpServerInstance = {
  server: Server;
  host: McpHost;
};

export function createMcpServer(options: McpServerOptions): McpServerInstance {
  const { actor, sessionId, host } = options;
  host.bindSession(sessionId, actor);
  // Seed the snapshot so the first list_changed only fires after a real shift.
  // Fire-and-forget: we don't block server creation on the cross-host RPC.
  void host.refreshToolList(sessionId, actor).catch(() => {});

  const server = new Server(
    {
      name: options.serverName ?? "woo",
      version: options.serverVersion ?? "0.0.0"
    },
    {
      capabilities: {
        tools: { listChanged: true }
      }
    }
  );

  host.onToolListChanged(() => {
    void server.notification({ method: "notifications/tools/list_changed" }).catch(() => {});
  });

  const toolsByName = new Map<string, McpTool>();
  const refreshTools = async (): Promise<McpTool[]> => {
    const tools = await host.enumerateTools(actor);
    toolsByName.clear();
    for (const tool of tools) toolsByName.set(tool.name, tool);
    return tools;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await refreshTools();
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: "object"; [k: string]: unknown }
      }))
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (toolsByName.size === 0) await refreshTools();
    const tool = toolsByName.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `unknown tool: ${request.params.name}` }],
        isError: true
      };
    }
    const args = orderArgsForVerb(tool, request.params.arguments ?? {});
    try {
      const result = await host.invokeTool(actor, sessionId, tool, args);
      const summary = summarizeResult(result.result, result.observations);
      const structured: Record<string, unknown> = {
        result: result.result,
        observations: result.observations
      };
      if (result.applied) structured.applied = result.applied;
      await refreshTools();
      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: structured,
        isError: false
      };
    } catch (err) {
      const enriched = err as Error & { code?: string; value?: unknown; trace?: unknown };
      const code = enriched.code ?? "E_INTERNAL";
      const message = enriched.message ?? String(err);
      const errorPayload: Record<string, unknown> = { code, message };
      if (enriched.value !== undefined) errorPayload.value = enriched.value;
      if (enriched.trace !== undefined) errorPayload.trace = enriched.trace;
      return {
        content: [{ type: "text" as const, text: `${code}: ${message}` }],
        structuredContent: { error: errorPayload },
        isError: true
      };
    }
  });

  return { server, host };
}

function orderArgsForVerb(tool: McpTool, params: Record<string, unknown>): WooValue[] {
  const argNames = Array.isArray((tool as unknown as { inputSchemaArgs?: string[] }).inputSchemaArgs)
    ? (tool as unknown as { inputSchemaArgs: string[] }).inputSchemaArgs
    : Object.keys(((tool.inputSchema as Record<string, unknown>).properties ?? {}) as Record<string, unknown>);
  return argNames.map((name) => params[name] as WooValue);
}

function summarizeResult(result: WooValue, observations: import("../core/types").Observation[]): string {
  for (const observation of observations) {
    if (typeof observation.text === "string" && observation.text) return observation.text;
  }
  if (result === null || result === undefined) return "ok";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  try {
    return JSON.stringify(result);
  } catch {
    return "ok";
  }
}
