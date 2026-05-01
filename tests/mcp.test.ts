import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { McpHost } from "../src/mcp/host";
import { McpGateway } from "../src/mcp/gateway";
import type { Observation, WooValue } from "../src/core/types";

function bootstrapWorld() {
  return createWorld();
}

describe("McpHost", () => {
  it("enumerates tools reachable from the actor with route classification", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-list");
    const host = new McpHost(world);
    host.registerActor(session.actor);

    // Walk into the chatroom so its verbs and contents are in scope.
    const entered = await world.directCall(undefined, session.actor, "the_chatroom", "enter", []);
    expect(entered.op).toBe("result");

    const tools = host.enumerateTools(session.actor);
    const byObjVerb = new Map(tools.map((t) => [`${t.object}:${t.verb}`, t]));

    // $actor host primitives are seeded as tool_exposed verbs and reachable via "self".
    expect(byObjVerb.has(`${session.actor}:wait`)).toBe(true);
    expect(byObjVerb.has(`${session.actor}:focus`)).toBe(true);
    expect(byObjVerb.has(`${session.actor}:focus_list`)).toBe(true);

    // After entering, $conversational verbs on the chatroom are direct-callable.
    const sayTool = byObjVerb.get("the_chatroom:say");
    expect(sayTool).toBeDefined();
    expect(sayTool?.direct).toBe(true);

    // Cockatoo lives in the room's contents so its tool-exposed verbs are in scope.
    expect(byObjVerb.has("the_cockatoo:squawk")).toBe(true);

    // Taskspace mutators are sequenced (tool_exposed, not direct_callable);
    // the actor has presence in the_taskspace via auto_presence on auth.
    const createTask = byObjVerb.get("the_taskspace:create_task");
    expect(createTask).toBeDefined();
    expect(createTask?.direct).toBe(false);
    expect(createTask?.enclosingSpace).toBe("the_taskspace");

    // Tool names are unique.
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it("routes a direct verb call's observations into the actor queue and drains via wait", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-direct");
    const host = new McpHost(world);
    host.registerActor(session.actor);

    // Walk into the chatroom first so its verbs become reachable.
    const entered = await world.directCall(undefined, session.actor, "the_chatroom", "enter", []);
    expect(entered.op).toBe("result");
    if (entered.op === "result") host.routeDirectResult(entered);

    const sayTool = host.enumerateTools(session.actor).find((t) => t.object === "the_chatroom" && t.verb === "say")!;
    expect(sayTool).toBeDefined();
    const sayResult = await host.invokeTool(session.actor, session.id, sayTool, ["hello, world"]);
    expect(sayResult.observations.some((o) => o.type === "said")).toBe(true);

    const waitTool = host.enumerateTools(session.actor).find((t) => t.object === session.actor && t.verb === "wait")!;
    const waited = await host.invokeTool(session.actor, session.id, waitTool, [0, 64]);
    const drained = (waited.result as { observations: Observation[]; more: boolean; queue_depth: number });
    expect(drained.more).toBe(false);
    expect(Array.isArray(drained.observations)).toBe(true);
  });

  it("invokes a sequenced tool through the enclosing space and returns applied", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-seq");
    const host = new McpHost(world);
    host.registerActor(session.actor);

    const create = host.enumerateTools(session.actor).find((t) => t.object === "the_taskspace" && t.verb === "create_task")!;
    expect(create).toBeDefined();
    expect(create.direct).toBe(false);
    const result = await host.invokeTool(session.actor, session.id, create, ["MCP task", "from the host"]);
    expect(result.applied).toBeDefined();
    expect(result.applied?.space).toBe("the_taskspace");
    expect(typeof result.applied?.seq).toBe("number");
    expect(result.observations.some((o) => o.type === "task_created")).toBe(true);
  });

  it("focus and unfocus extend reachability and toggle list_changed", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-focus");
    const host = new McpHost(world);
    host.registerActor(session.actor);
    host.refreshToolList(session.actor); // seed snapshot

    const create = host.enumerateTools(session.actor).find((t) => t.object === "the_taskspace" && t.verb === "create_task")!;
    const created = await host.invokeTool(session.actor, session.id, create, ["Focus me", "test"]);
    const taskRef = (created.observations.find((o) => o.type === "task_created")?.task as string | undefined) ?? "";
    expect(typeof taskRef).toBe("string");
    expect(taskRef.length).toBeGreaterThan(0);

    // Before focus, the task's per-instance verbs aren't reachable.
    expect(host.enumerateTools(session.actor).some((t) => t.object === taskRef)).toBe(false);

    let listChanged = 0;
    host.onToolListChanged(() => { listChanged += 1; });

    const focus = host.enumerateTools(session.actor).find((t) => t.object === session.actor && t.verb === "focus")!;
    await host.invokeTool(session.actor, session.id, focus, [taskRef]);

    // After focus, task's verbs (claim, set_status, add_subtask) are reachable.
    const taskTools = host.enumerateTools(session.actor).filter((t) => t.object === taskRef);
    expect(taskTools.length).toBeGreaterThan(0);
    expect(taskTools.some((t) => t.verb === "claim")).toBe(true);
    expect(listChanged).toBeGreaterThan(0);

    const unfocus = host.enumerateTools(session.actor).find((t) => t.object === session.actor && t.verb === "unfocus")!;
    await host.invokeTool(session.actor, session.id, unfocus, [taskRef]);
    expect(host.enumerateTools(session.actor).some((t) => t.object === taskRef)).toBe(false);
  });

  it("waits with timeout and returns more=true when queue overflows the limit", async () => {
    const world = bootstrapWorld();
    const session = world.auth("guest:mcp-batch");
    const host = new McpHost(world);
    host.registerActor(session.actor);

    // Synthesize observations destined for this actor by routing a fake direct
    // result whose audience targets only this actor.
    const synthetic = (n: number): Observation => ({ type: "ping", source: session.actor, n: n as unknown as WooValue, ts: Date.now() } as Observation);
    const observations = Array.from({ length: 80 }, (_, i) => synthetic(i));
    host.routeDirectResult({
      op: "result",
      result: null,
      observations,
      audience: "the_chatroom",
      audienceActors: [session.actor],
      observationAudiences: observations.map(() => [session.actor])
    });

    const waitTool = host.enumerateTools(session.actor).find((t) => t.object === session.actor && t.verb === "wait")!;
    const first = await host.invokeTool(session.actor, session.id, waitTool, [0, 50]);
    const drainedFirst = first.result as { observations: Observation[]; more: boolean; queue_depth: number };
    expect(drainedFirst.observations.length).toBe(50);
    expect(drainedFirst.more).toBe(true);
    expect(drainedFirst.queue_depth).toBe(30);

    const second = await host.invokeTool(session.actor, session.id, waitTool, [0, 50]);
    const drainedSecond = second.result as { observations: Observation[]; more: boolean; queue_depth: number };
    expect(drainedSecond.observations.length).toBe(30);
    expect(drainedSecond.more).toBe(false);
  });
});

describe("McpGateway", () => {
  it("initializes a session via Mcp-Token, lists tools, and calls a verb", async () => {
    const world = bootstrapWorld();
    const gateway = new McpGateway(world);

    // 1) initialize
    const init = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0.0.0" }
      }
    }, { "mcp-token": "guest:mcp-gateway" }));
    expect(init.ok).toBe(true);
    const sessionId = init.headers.get("mcp-session-id");
    expect(typeof sessionId).toBe("string");
    expect((sessionId ?? "").length).toBeGreaterThan(0);

    // initialized notification (required by MCP handshake)
    const notified = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }, { "mcp-session-id": sessionId! }));
    expect(notified.status).toBe(202);

    // 2) tools/list
    const list = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    }, { "mcp-session-id": sessionId! }));
    expect(list.ok).toBe(true);
    const listBody = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    expect(Array.isArray(listBody.result.tools)).toBe(true);
    expect(listBody.result.tools.some((t) => t.name.includes("wait"))).toBe(true);
    expect(listBody.result.tools.some((t) => t.name.includes("create_task"))).toBe(true);

    // 3) tools/call — invoke create_task as a sequenced tool
    const createName = listBody.result.tools.find((t) => t.name.endsWith("__create_task"))!.name;
    const call = await gateway.handle(jsonRpcRequest("http://t/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: createName, arguments: { title: "via gateway", description: "from MCP" } }
    }, { "mcp-session-id": sessionId! }));
    expect(call.ok).toBe(true);
    const callBody = (await call.json()) as { result: { isError?: boolean; structuredContent?: { applied?: { space: string; seq: number } } } };
    expect(callBody.result.isError).not.toBe(true);
    expect(callBody.result.structuredContent?.applied?.space).toBe("the_taskspace");

    // 4) DELETE closes the session
    const closed = await gateway.handle(new Request("http://t/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! }
    }));
    expect(closed.status).toBe(204);
  });

  it("rejects requests without a session and without Mcp-Token", async () => {
    const world = bootstrapWorld();
    const gateway = new McpGateway(world);
    const response = await gateway.handle(new Request("http://t/mcp", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("E_NOSESSION");
  });
});

function jsonRpcRequest(url: string, body: unknown, headers: Record<string, string>): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      ...headers
    },
    body: JSON.stringify(body)
  });
}
