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
  const { world, actor, sessionId } = options;
  const host = new McpHost(world);
  host.registerActor(actor);
  // Seed the snapshot so the first list_changed only fires after a real shift.
  host.refreshToolList(actor);

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
  const refreshTools = (): McpTool[] => {
    const tools = host.enumerateTools(actor);
    toolsByName.clear();
    for (const tool of tools) toolsByName.set(tool.name, tool);
    return tools;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = refreshTools();
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: "object"; [k: string]: unknown }
      }))
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (toolsByName.size === 0) refreshTools();
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
      // Refresh tool list snapshot in case the call moved the actor / focused something.
      refreshTools();
      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: structured,
        isError: false
      };
    } catch (err) {
      const code = (err as Error & { code?: string }).code ?? "E_INTERNAL";
      const message = (err as Error).message ?? String(err);
      return {
        content: [{ type: "text" as const, text: `${code}: ${message}` }],
        structuredContent: { error: { code, message } },
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
