// MCP server — wires McpHost to the official SDK's low-level Server so we
// can drive dynamic tool lists. The high-level McpServer wraps a static tool
// manifest and isn't suitable here.
//
// Transports (stdio, HTTP) plug a transport into this server; src/mcp/stdio.ts
// is the canonical entry point.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { wooError, type ObjRef, type Observation, type WooValue } from "../core/types";
import type { WooWorld } from "../core/world";
import { McpHost, type McpInvocationResult, type McpTool } from "./host";

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

type StableTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  invoke(params: Record<string, unknown>): Promise<McpInvocationResult>;
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

  const invokeDynamicToolWithArgs = async (tool: McpTool, args: WooValue[]): Promise<McpInvocationResult> => {
    const result = await host.invokeTool(actor, sessionId, tool, args);
    await refreshTools();
    return result;
  };

  const invokeDynamicTool = async (tool: McpTool, params: Record<string, unknown>): Promise<McpInvocationResult> => {
    return invokeDynamicToolWithArgs(tool, orderArgsForVerb(tool, params));
  };

  const findReachableTool = async (object: ObjRef, verb: string): Promise<McpTool> => {
    const tools = await refreshTools();
    const tool = tools.find((candidate) => candidate.object === object && candidate.verb === verb);
    if (!tool) throw wooError("E_VERBNF", `reachable MCP tool not found: ${object}:${verb}`);
    return tool;
  };

  const stableTools = new Map<string, StableTool>([
    ["woo_list_reachable_tools", {
      name: "woo_list_reachable_tools",
      description: "List the current dynamic woo object tools reachable by this actor.",
      inputSchema: { type: "object", properties: {} },
      invoke: async () => {
        const tools = await refreshTools();
        return {
          result: tools.map((tool) => toolSummary(tool)) as WooValue,
          observations: []
        };
      }
    }],
    ["woo_call", {
      name: "woo_call",
      description: "Call a currently reachable woo object verb by canonical object and verb name. This does not bypass reachability, tool_exposed, or permissions.",
      inputSchema: {
        type: "object",
        properties: {
          object: { type: "string", description: "woo object reference" },
          verb: { type: "string" },
          args: { type: "array", description: "positional woo arguments" }
        },
        required: ["object", "verb"]
      },
      invoke: async (params) => {
        const object = stringParam(params, "object");
        const verb = stringParam(params, "verb");
        const args = arrayParam(params, "args");
        const tool = await findReachableTool(object, verb);
        return invokeDynamicToolWithArgs(tool, args);
      }
    }],
    ["woo_focus", {
      name: "woo_focus",
      description: "Add a visible woo object to this actor's MCP working set.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "woo object reference" }
        },
        required: ["target"]
      },
      invoke: async (params) => {
        const tool = actorControlTool(actor, "focus");
        return invokeDynamicToolWithArgs(tool, [stringParam(params, "target")]);
      }
    }],
    ["woo_unfocus", {
      name: "woo_unfocus",
      description: "Remove a woo object from this actor's MCP working set.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "woo object reference" }
        },
        required: ["target"]
      },
      invoke: async (params) => {
        const tool = actorControlTool(actor, "unfocus");
        return invokeDynamicToolWithArgs(tool, [stringParam(params, "target")]);
      }
    }],
    ["woo_wait", {
      name: "woo_wait",
      description: "Drain this MCP session's queued external woo observations.",
      inputSchema: {
        type: "object",
        properties: {
          timeout_ms: { type: "integer" },
          limit: { type: "integer" }
        }
      },
      invoke: async (params) => {
        const tool = actorControlTool(actor, "wait");
        return invokeDynamicToolWithArgs(tool, [numberParam(params, "timeout_ms", 0), numberParam(params, "limit", 64)]);
      }
    }]
  ]);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await refreshTools();
    return {
      tools: [
        ...Array.from(stableTools.values(), (tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        })),
        ...tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as { type: "object"; [k: string]: unknown }
        }))
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = objectParams(request.params.arguments ?? {});
    const stableTool = stableTools.get(request.params.name);
    if (stableTool) return invokeForMcp(() => stableTool.invoke(params));

    if (toolsByName.size === 0) await refreshTools();
    let tool = toolsByName.get(request.params.name);
    if (!tool) {
      await refreshTools();
      tool = toolsByName.get(request.params.name);
    }
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `unknown tool: ${request.params.name}` }],
        isError: true
      };
    }
    return invokeForMcp(() => invokeDynamicTool(tool, params));
  });

  return { server, host };
}

async function invokeForMcp(invoke: () => Promise<McpInvocationResult>) {
  try {
    const result = await invoke();
    const summary = summarizeResult(result.result, result.observations);
    const structured: Record<string, unknown> = {
      result: result.result,
      observations: result.observations
    };
    if (result.applied) structured.applied = result.applied;
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
}

function orderArgsForVerb(tool: McpTool, params: Record<string, unknown>): WooValue[] {
  const argNames = Array.isArray((tool as unknown as { inputSchemaArgs?: string[] }).inputSchemaArgs)
    ? (tool as unknown as { inputSchemaArgs: string[] }).inputSchemaArgs
    : Object.keys(((tool.inputSchema as Record<string, unknown>).properties ?? {}) as Record<string, unknown>);
  return argNames.map((name) => params[name] as WooValue);
}

function summarizeResult(result: WooValue, observations: Observation[]): string {
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

function toolSummary(tool: McpTool): WooValue {
  const properties = ((tool.inputSchema as Record<string, unknown>).properties ?? {}) as Record<string, unknown>;
  return {
    name: tool.name,
    object: tool.object,
    verb: tool.verb,
    aliases: tool.aliases,
    direct: tool.direct,
    enclosing_space: tool.enclosingSpace,
    args: Object.keys(properties),
    description: tool.description
  } as WooValue;
}

function actorControlTool(actor: ObjRef, verb: string): McpTool {
  return {
    name: `woo_${verb}`,
    object: actor,
    verb,
    aliases: [],
    description: `MCP control wrapper for ${actor}:${verb}(...)`,
    inputSchema: { type: "object", properties: {} },
    direct: true,
    enclosingSpace: null
  };
}

function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) throw wooError("E_INVARG", `${name} must be a non-empty string`);
  return value;
}

function numberParam(params: Record<string, unknown>, name: string, fallback: number): number {
  const value = params[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function arrayParam(params: Record<string, unknown>, name: string): WooValue[] {
  const value = params[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw wooError("E_INVARG", `${name} must be an array`);
  return value as WooValue[];
}
