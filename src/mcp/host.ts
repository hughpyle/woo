// MCP host — singleton per WooWorld. Registers $actor:wait/focus/etc. native
// handlers ONCE at construction; per-MCP-session state (observation queue,
// pending waiters) lives in a Map keyed by Mcp-Session-Id.
//
// Implements spec/protocol/mcp.md §M3 (reachability), §M4 (wait queue),
// and §M2 (verb-to-tool mapping with route classification). Transport
// (stdio/HTTP) lives in src/mcp/server.ts; this module is transport-agnostic.

import type { CallContext, NativeHandler, WooWorld } from "../core/world";
import type { AppliedFrame, DirectResultFrame, ObjRef, Observation, WooValue } from "../core/types";
import { directedRecipients, wooError } from "../core/types";

// Broadcast hooks the runtime wires into the MCP host so that MCP-initiated
// direct and sequenced calls fan out to attached WebSocket / SSE clients the
// same way REST-initiated calls do. Without these, an MCP agent's chat would
// be invisible to humans on the gateway's WS.
export type McpBroadcastHooks = {
  broadcastApplied?: (frame: AppliedFrame) => void | Promise<void>;
  broadcastLiveEvents?: (result: DirectResultFrame) => void | Promise<void>;
};

const QUEUE_HARD_CAP = 4096;
const DEFAULT_LIMIT = 64;
const MAX_LIMIT = 256;
const FOCUS_LIST_CAP = 32;
const MAX_TIMEOUT_MS = 30_000;

type SessionQueue = {
  actor: ObjRef;
  observations: Observation[];
  lostSinceMark: number;
  firstLostTs: number | null;
  waiters: Set<{ resolve: () => void; timer: ReturnType<typeof setTimeout> | null }>;
};

export type McpReachable = {
  id: ObjRef;
  origin: "self" | "location" | "contents" | "inventory" | "presence" | "focus";
};

export type McpTool = {
  name: string;
  object: ObjRef;
  verb: string;
  aliases: string[];
  description: string;
  inputSchema: Record<string, unknown>;
  direct: boolean;
  enclosingSpace: ObjRef | null;
};

export type McpInvocationResult = {
  result: WooValue;
  observations: Observation[];
  applied?: { space: ObjRef; seq: number; ts: number };
};

// `actor_wait` runs through the standard verb-dispatch path, which doesn't
// thread the MCP session id through CallContext. McpHost.invokeTool sets this
// before dispatching the wait verb so the native handler can find the right
// per-session queue. Single-threaded JS makes this safe.
let CURRENT_WAIT_SESSION_ID: string | null = null;

export class McpHost {
  private queues = new Map<string, SessionQueue>();
  private listChangedListeners = new Set<(actor: ObjRef) => void>();
  private toolListSnapshot = new Map<string, string>();

  private broadcasts: McpBroadcastHooks = {};

  constructor(private world: WooWorld) {
    // Native handlers register ONCE per world. Subsequent McpHost instances on
    // the same world would clobber per-session queues — McpGateway owns one
    // singleton McpHost per world to avoid that footgun.
    this.installNativeHandlers();
  }

  setBroadcastHooks(hooks: McpBroadcastHooks): void {
    this.broadcasts = hooks;
  }

  // ----- session lifecycle -----

  bindSession(sessionId: string, actor: ObjRef): void {
    if (!this.queues.has(sessionId)) this.queues.set(sessionId, makeQueue(actor));
  }

  unbindSession(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (!queue) return;
    for (const waiter of queue.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve();
    }
    queue.waiters.clear();
    this.queues.delete(sessionId);
    this.toolListSnapshot.delete(sessionId);
  }

  onToolListChanged(listener: (actor: ObjRef) => void): () => void {
    this.listChangedListeners.add(listener);
    return () => { this.listChangedListeners.delete(listener); };
  }

  // ----- external observation routing (broadcast-side fan-out) -----

  // Called by the runtime's broadcastApplied path (dev-server / worker DO).
  // For each MCP session whose actor has presence in the frame's space — and
  // who isn't the originator — enqueue the applied frame's observations.
  routeAppliedFrame(frame: AppliedFrame, originSessionId?: string | null): void {
    if (!frame.observations.length) return;
    for (const [sessionId, queue] of this.queues) {
      if (originSessionId && sessionId === originSessionId) continue;
      if (!this.actorSubscribes(queue.actor, frame.space)) continue;
      for (const observation of frame.observations) this.enqueueFor(sessionId, observation);
    }
  }

  // Called by the runtime's broadcastLiveEvents path. For each observation,
  // enqueue to every session whose actor is in the audience (per-observation
  // audience hint, with a presence fallback). Skip the originating session;
  // its own observations travel back via the call result.
  routeLiveEvents(result: DirectResultFrame, originSessionId?: string | null): void {
    const observations = result.observations ?? [];
    for (let i = 0; i < observations.length; i++) {
      const observation = observations[i];
      const audience = result.observationAudiences?.[i] ?? result.audienceActors ?? this.implicitAudience(observation, result.audience ?? null);
      if (!audience) continue;
      const audienceSet = new Set(audience);
      for (const [sessionId, queue] of this.queues) {
        if (originSessionId && sessionId === originSessionId) continue;
        if (!audienceSet.has(queue.actor)) continue;
        this.enqueueFor(sessionId, observation);
      }
    }
  }

  private implicitAudience(observation: Observation, fallback: ObjRef | null): ObjRef[] | null {
    const directed = directedRecipients(observation);
    if (directed.to) return directed.from ? [directed.to, directed.from] : [directed.to];
    if (typeof observation.to === "string") return [observation.to];
    if (!fallback) return null;
    return this.subscriberList(fallback);
  }

  private actorSubscribes(actor: ObjRef, space: ObjRef): boolean {
    if (!this.world.objects.has(space)) return false;
    const subs = this.subscriberList(space);
    return subs.includes(actor);
  }

  private subscriberList(space: ObjRef): ObjRef[] {
    if (!this.world.objects.has(space)) return [];
    const raw = this.world.propOrNull(space, "subscribers");
    return Array.isArray(raw) ? raw.filter((item): item is ObjRef => typeof item === "string") : [];
  }

  private enqueueFor(sessionId: string, observation: Observation): void {
    const queue = this.queues.get(sessionId);
    if (!queue) return;
    if (queue.observations.length >= QUEUE_HARD_CAP) {
      queue.lostSinceMark += 1;
      if (queue.firstLostTs === null) queue.firstLostTs = Date.now();
      return;
    }
    queue.observations.push(observation);
    if (queue.waiters.size > 0) {
      for (const waiter of Array.from(queue.waiters)) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve();
        queue.waiters.delete(waiter);
      }
    }
  }

  // ----- reachability / tool list -----

  reachable(actor: ObjRef): McpReachable[] {
    const seen = new Map<ObjRef, McpReachable["origin"]>();
    const add = (id: ObjRef, origin: McpReachable["origin"]): void => {
      if (!this.world.objects.has(id)) return;
      if (!seen.has(id)) seen.set(id, origin);
    };
    add(actor, "self");
    const actorObj = this.world.objects.has(actor) ? this.world.object(actor) : null;
    if (actorObj?.location && this.world.objects.has(actorObj.location)) add(actorObj.location, "location");
    if (actorObj?.location && this.world.objects.has(actorObj.location)) {
      for (const id of this.world.object(actorObj.location).contents) {
        if (this.isOtherActor(actor, id)) continue;
        if (this.actorCanSee(actor, id)) add(id, "contents");
      }
    }
    if (actorObj) for (const id of actorObj.contents) {
      if (this.isOtherActor(actor, id)) continue;
      if (this.actorCanSee(actor, id)) add(id, "inventory");
    }
    const presence = actorObj ? this.world.propOrNull(actor, "presence_in") : null;
    if (Array.isArray(presence)) for (const id of presence) {
      if (typeof id === "string") add(id, "presence");
    }
    const focusList = this.focusListOf(actor);
    for (const id of focusList) {
      if (this.isOtherActor(actor, id)) continue;
      if (this.actorCanSee(actor, id)) add(id, "focus");
    }
    return Array.from(seen, ([id, origin]) => ({ id, origin }));
  }

  // Visibility check used by reachability and focus. The actor must be able to
  // see the object at all — minimum bar is being able to read its name (the
  // standard `:describe` surface does this). canReadProperty already short-
  // circuits for wizards via its internal canBypassPerms call.
  private actorCanSee(actor: ObjRef, target: ObjRef): boolean {
    if (!this.world.objects.has(target)) return false;
    return this.world.canReadProperty(actor, target, "name");
  }

  private isOtherActor(actor: ObjRef, target: ObjRef): boolean {
    return target !== actor && this.isActorObject(target);
  }

  private isActorObject(target: ObjRef): boolean {
    if (!this.world.objects.has(target)) return false;
    let cursor: ObjRef | null = target;
    while (cursor && this.world.objects.has(cursor)) {
      if (cursor === "$actor") return true;
      cursor = this.world.object(cursor).parent;
    }
    return false;
  }

  enumerateTools(actor: ObjRef): McpTool[] {
    const tools: McpTool[] = [];
    const usedNames = new Set<string>();
    for (const { id } of this.reachable(actor)) {
      if (this.isOtherActor(actor, id)) continue;
      for (const verb of this.tooledVerbsFor(actor, id)) {
        const baseName = sanitizeId(id) + "__" + verb.name;
        let name = baseName;
        let suffix = 2;
        while (usedNames.has(name)) {
          name = baseName + "_" + suffix++;
        }
        usedNames.add(name);
        tools.push({
          name,
          object: id,
          verb: verb.name,
          aliases: verb.aliases,
          description: this.toolDescription(id, verb),
          inputSchema: argSpecToJsonSchema(verb.arg_spec),
          direct: verb.direct_callable === true,
          enclosingSpace: this.enclosingSpaceFor(id)
        });
      }
    }
    return tools;
  }

  private toolListDigest(actor: ObjRef): string {
    const tools = this.enumerateTools(actor);
    return tools.map((tool) => `${tool.name}@${tool.object}:${tool.verb}:${tool.direct ? "d" : "s"}`).sort().join("|");
  }

  refreshToolList(sessionId: string, actor: ObjRef): boolean {
    const digest = this.toolListDigest(actor);
    const previous = this.toolListSnapshot.get(sessionId);
    if (digest === previous) return false;
    this.toolListSnapshot.set(sessionId, digest);
    if (previous !== undefined) {
      for (const listener of this.listChangedListeners) listener(actor);
    }
    return true;
  }

  private tooledVerbsFor(actor: ObjRef, id: ObjRef): Array<{ name: string; aliases: string[]; arg_spec: Record<string, WooValue>; direct_callable?: boolean; perms: string; tool_exposed?: boolean; source?: string }> {
    const seen = new Set<string>();
    const out: Array<{ name: string; aliases: string[]; arg_spec: Record<string, WooValue>; direct_callable?: boolean; perms: string; tool_exposed?: boolean; source?: string }> = [];
    const collect = (start: ObjRef): void => {
      let cursor: ObjRef | null = start;
      while (cursor && this.world.objects.has(cursor)) {
        const obj = this.world.object(cursor);
        for (const verb of obj.verbs.values()) {
          if (seen.has(verb.name)) continue;
          seen.add(verb.name);
          if (verb.tool_exposed !== true) continue;
          if (!this.world.canExecuteVerb(actor, verb)) continue;
          out.push(verb as unknown as typeof out[number]);
        }
        cursor = obj.parent;
      }
    };
    collect(id);
    const features = this.featureListOf(id);
    for (const feature of features) collect(feature);
    return out;
  }

  private featureListOf(id: ObjRef): ObjRef[] {
    if (!this.world.objects.has(id)) return [];
    const seen = new Set<ObjRef>();
    let cursor: ObjRef | null = id;
    while (cursor && this.world.objects.has(cursor)) {
      const raw = this.world.propOrNull(cursor, "features");
      if (Array.isArray(raw)) {
        for (const f of raw) if (typeof f === "string") seen.add(f);
      }
      cursor = this.world.object(cursor).parent;
    }
    return Array.from(seen);
  }

  private toolDescription(id: ObjRef, verb: { name: string; aliases: string[]; source?: string }): string {
    const lines: string[] = [];
    const doc = extractFirstParagraph(verb.source ?? "");
    if (doc) lines.push(doc);
    lines.push(`call: ${id}:${verb.name}(...)`);
    if (verb.aliases.length > 0) lines.push(`aliases: ${verb.aliases.join(", ")}`);
    return lines.join("\n");
  }

  private enclosingSpaceFor(target: ObjRef): ObjRef | null {
    let cursor: ObjRef | null = target;
    while (cursor && this.world.objects.has(cursor)) {
      if (this.descendsFrom(cursor, "$space")) return cursor;
      const obj = this.world.object(cursor);
      cursor = obj.anchor ?? obj.location ?? null;
    }
    return null;
  }

  private descendsFrom(objRef: ObjRef, ancestorRef: ObjRef): boolean {
    let cursor: ObjRef | null = objRef;
    while (cursor && this.world.objects.has(cursor)) {
      if (cursor === ancestorRef) return true;
      cursor = this.world.object(cursor).parent;
    }
    return false;
  }

  // ----- tool invocation -----

  async invokeTool(actor: ObjRef, sessionId: string, tool: McpTool, args: WooValue[]): Promise<McpInvocationResult> {
    if (tool.direct) {
      // For wait we need session-scoped queue access. Thread the sessionId
      // through a module-scoped slot; the registered native handler reads it.
      const previous = CURRENT_WAIT_SESSION_ID;
      CURRENT_WAIT_SESSION_ID = sessionId;
      try {
        const result = await this.world.directCall(undefined, actor, tool.object, tool.verb, args);
        if (result.op === "error") throw fromError(result.error);
        // Self observations are returned in the call result; do NOT route them
        // back into this session's queue — that would deliver them twice.
        // Other sessions' queues do see them via the normal broadcast path
        // (dev-server / DO call McpHost.routeLiveEvents with originSessionId).
        if (this.broadcasts.broadcastLiveEvents && result.audience) {
          // Tag the originating MCP session so the broadcast path can skip
          // re-enqueueing the caller's own observations (already returned in
          // the tool result). Other sessions still receive them.
          (result as { originMcpSessionId?: string }).originMcpSessionId = sessionId;
          try {
            await this.broadcasts.broadcastLiveEvents(result);
          } finally {
            delete (result as { originMcpSessionId?: string }).originMcpSessionId;
          }
        }
        this.refreshToolList(sessionId, actor);
        return { result: result.result, observations: result.observations };
      } finally {
        CURRENT_WAIT_SESSION_ID = previous;
      }
    }
    const space = tool.enclosingSpace ?? this.enclosingSpaceFor(tool.object);
    if (!space) throw wooError("E_INVARG", `verb ${tool.object}:${tool.verb} has no enclosing space for sequenced dispatch`);
    const message = { actor, target: tool.object, verb: tool.verb, args };
    const frame = await this.world.call(undefined, sessionId, space, message);
    if (frame.op === "error") throw fromError(frame.error);
    if (this.broadcasts.broadcastApplied) {
      (frame as { originMcpSessionId?: string }).originMcpSessionId = sessionId;
      try {
        await this.broadcasts.broadcastApplied(frame);
      } finally {
        delete (frame as { originMcpSessionId?: string }).originMcpSessionId;
      }
    }
    this.refreshToolList(sessionId, actor);
    const errObs = frame.observations.find((o) => o.type === "$error");
    return {
      result: errObs ? null : true,
      observations: frame.observations,
      applied: { space: frame.space, seq: frame.seq, ts: frame.ts }
    };
  }

  // ----- $actor:wait / focus / unfocus / focus_list handlers -----

  private installNativeHandlers(): void {
    this.world.registerNativeHandler("actor_wait", (ctx, args) => this.handleWait(ctx, args));
    this.world.registerNativeHandler("actor_focus", (ctx, args) => this.handleFocus(ctx, args));
    this.world.registerNativeHandler("actor_unfocus", (ctx, args) => this.handleUnfocus(ctx, args));
    this.world.registerNativeHandler("actor_focus_list", (ctx) => this.handleFocusList(ctx));
  }

  private async handleWait(ctx: CallContext, args: WooValue[]): Promise<WooValue> {
    const timeoutMs = Math.max(0, Math.min(MAX_TIMEOUT_MS, toInt(args[0], 0)));
    const limit = Math.max(1, Math.min(MAX_LIMIT, toInt(args[1], DEFAULT_LIMIT)));
    const sessionId = CURRENT_WAIT_SESSION_ID;
    if (!sessionId) {
      // Outside MCP context (e.g., REST directCall hits the verb). Return an
      // empty drain rather than throwing — the verb is still well-formed,
      // there's just no MCP session to source observations from.
      return emptyDrain();
    }
    const queue = this.queues.get(sessionId);
    if (!queue) return emptyDrain();
    if (queue.observations.length === 0 && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const waiter: SessionQueue["waiters"] extends Set<infer T> ? T : never = {
          resolve,
          timer: setTimeout(() => {
            queue.waiters.delete(waiter);
            resolve();
          }, timeoutMs)
        };
        queue.waiters.add(waiter);
      });
    }
    const drained = queue.observations.splice(0, limit);
    if (queue.lostSinceMark > 0 && drained.length === 0) {
      drained.unshift({
        type: "observation_overflow",
        lost: queue.lostSinceMark,
        since: queue.firstLostTs ?? Date.now()
      } as Observation);
      queue.lostSinceMark = 0;
      queue.firstLostTs = null;
    }
    return {
      observations: drained as unknown as WooValue,
      more: queue.observations.length > 0,
      queue_depth: queue.observations.length
    } as unknown as WooValue;
  }

  private handleFocus(ctx: CallContext, args: WooValue[]): WooValue {
    const target = String(args[0] ?? "");
    if (!target || !this.world.objects.has(target)) throw wooError("E_INVARG", `focus target not found: ${target}`);
    const actor = ctx.thisObj;
    if (this.isOtherActor(actor, target)) throw wooError("E_PERM", `cannot focus another actor: ${target}`);
    if (!this.actorCanSee(actor, target)) throw wooError("E_PERM", `focus target not visible: ${target}`);
    const list = this.focusListOf(actor);
    if (!list.includes(target)) {
      list.push(target);
      while (list.length > FOCUS_LIST_CAP) list.shift();
      this.world.setProp(actor, "focus_list", list);
    }
    return list as unknown as WooValue;
  }

  private handleUnfocus(ctx: CallContext, args: WooValue[]): WooValue {
    const target = String(args[0] ?? "");
    const actor = ctx.thisObj;
    const list = this.focusListOf(actor).filter((id) => id !== target);
    this.world.setProp(actor, "focus_list", list);
    return list as unknown as WooValue;
  }

  private handleFocusList(ctx: CallContext): WooValue {
    return this.focusListOf(ctx.thisObj) as unknown as WooValue;
  }

  private focusListOf(actor: ObjRef): ObjRef[] {
    if (!this.world.objects.has(actor)) return [];
    const raw = this.world.propOrNull(actor, "focus_list");
    return Array.isArray(raw) ? raw.filter((item): item is ObjRef => typeof item === "string") : [];
  }
}

function makeQueue(actor: ObjRef): SessionQueue {
  return { actor, observations: [], lostSinceMark: 0, firstLostTs: null, waiters: new Set() };
}

function emptyDrain(): WooValue {
  return { observations: [] as unknown as WooValue, more: false, queue_depth: 0 } as unknown as WooValue;
}

function toInt(value: WooValue | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  return fallback;
}

function sanitizeId(id: ObjRef): string {
  return id.replace(/^\$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
}

function extractFirstParagraph(source: string): string {
  if (!source) return "";
  const blockMatch = /\/\*([\s\S]*?)\*\//.exec(source);
  if (blockMatch) {
    const text = blockMatch[1].split(/\n\s*\n/)[0].replace(/^\s*\*?\s?/gm, "").trim();
    if (text) return text;
  }
  const lineMatch = /^\s*\/\/\s?(.*)$/m.exec(source);
  if (lineMatch) return lineMatch[1].trim();
  return "";
}

function argSpecToJsonSchema(spec: Record<string, WooValue>): Record<string, unknown> {
  const args = Array.isArray(spec.args) ? spec.args.filter((item): item is string => typeof item === "string") : [];
  const types = (spec.types && typeof spec.types === "object" && !Array.isArray(spec.types)) ? spec.types as Record<string, WooValue> : {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of args) {
    const optional = arg.endsWith("?");
    const name = optional ? arg.slice(0, -1) : arg;
    const hint = typeof types[name] === "string" ? String(types[name]) : "";
    properties[name] = jsonSchemaForHint(hint);
    if (!optional) required.push(name);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function jsonSchemaForHint(hint: string): Record<string, unknown> {
  if (!hint) return {};
  const trimmed = hint.trim();
  if (trimmed === "str") return { type: "string" };
  if (trimmed === "int") return { type: "integer" };
  if (trimmed === "float" || trimmed === "num") return { type: "number" };
  if (trimmed === "bool") return { type: "boolean" };
  if (trimmed === "obj") return { type: "string", description: "object reference (woo objref)" };
  if (trimmed.startsWith("list<")) return { type: "array" };
  if (trimmed.startsWith("map")) return { type: "object" };
  return {};
}

function fromError(error: { code: string; message?: string; value?: unknown; trace?: unknown }): Error {
  const err = new Error(`${error.code}: ${error.message ?? ""}`);
  const enriched = err as Error & { code?: string; value?: unknown; trace?: unknown };
  enriched.code = error.code;
  if (error.value !== undefined) enriched.value = error.value;
  if (error.trace !== undefined) enriched.trace = error.trace;
  return err;
}
