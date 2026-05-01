// MCP host — per-actor observation queue, working set (focus list), and
// reachable-scope/tool-list computation against a WooWorld.
//
// Implements the runtime side of spec/protocol/mcp.md §M3 (reachability),
// §M4 (wait queue), and §M2 (verb-to-tool mapping with route classification).
// The transport (stdio/HTTP) lives in src/mcp/server.ts; this module is
// transport-agnostic.

import type { CallContext, NativeHandler, WooWorld } from "../core/world";
import type { AppliedFrame, DirectResultFrame, ObjRef, Observation, WooValue } from "../core/types";
import { directedRecipients, wooError } from "../core/types";

const QUEUE_HARD_CAP = 4096;
const DEFAULT_LIMIT = 64;
const MAX_LIMIT = 256;
const FOCUS_LIST_CAP = 32;
const MAX_TIMEOUT_MS = 30_000;

type ActorQueue = {
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

export class McpHost {
  private queues = new Map<ObjRef, ActorQueue>();
  private listChangedListeners = new Set<(actor: ObjRef) => void>();
  private toolListSnapshot = new Map<ObjRef, string>();

  constructor(private world: WooWorld) {
    this.installNativeHandlers();
  }

  // ----- session lifecycle -----

  registerActor(actor: ObjRef): void {
    if (!this.queues.has(actor)) this.queues.set(actor, makeQueue());
  }

  unregisterActor(actor: ObjRef): void {
    const queue = this.queues.get(actor);
    if (!queue) return;
    for (const waiter of queue.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve();
    }
    queue.waiters.clear();
    this.queues.delete(actor);
    this.toolListSnapshot.delete(actor);
  }

  onToolListChanged(listener: (actor: ObjRef) => void): () => void {
    this.listChangedListeners.add(listener);
    return () => { this.listChangedListeners.delete(listener); };
  }

  // ----- observation routing -----

  // Push observations from a direct-call result into the per-actor queues
  // selected by the call's audience (spec/semantics/events.md §12.7).
  routeDirectResult(result: DirectResultFrame): void {
    const observations = result.observations ?? [];
    for (let i = 0; i < observations.length; i++) {
      const observation = observations[i];
      const audience = result.observationAudiences?.[i] ?? result.audienceActors ?? this.implicitAudience(observation, result.audience ?? null);
      if (!audience) continue;
      for (const actor of audience) this.enqueueFor(actor, observation);
    }
  }

  // Push applied-frame observations to subscribers of the frame's space.
  routeAppliedFrame(frame: AppliedFrame): void {
    const subscribers = this.subscriberList(frame.space);
    if (!subscribers.length) return;
    for (const observation of frame.observations) {
      for (const actor of subscribers) {
        if (!this.queues.has(actor)) continue;
        this.enqueueFor(actor, observation);
      }
    }
  }

  private implicitAudience(observation: Observation, fallback: ObjRef | null): ObjRef[] | null {
    const directed = directedRecipients(observation);
    if (directed.to) {
      return directed.from ? [directed.to, directed.from] : [directed.to];
    }
    if (typeof observation.to === "string") return [observation.to];
    if (!fallback) return null;
    return this.subscriberList(fallback);
  }

  private subscriberList(space: ObjRef): ObjRef[] {
    if (!this.world.objects.has(space)) return [];
    const raw = this.world.propOrNull(space, "subscribers");
    return Array.isArray(raw) ? raw.filter((item): item is ObjRef => typeof item === "string") : [];
  }

  private enqueueFor(actor: ObjRef, observation: Observation): void {
    const queue = this.queues.get(actor);
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
      for (const id of this.world.object(actorObj.location).contents) add(id, "contents");
    }
    if (actorObj) for (const id of actorObj.contents) add(id, "inventory");
    const presence = actorObj ? this.world.propOrNull(actor, "presence_in") : null;
    if (Array.isArray(presence)) for (const id of presence) {
      if (typeof id === "string") add(id, "presence");
    }
    const focusList = this.focusListOf(actor);
    for (const id of focusList) add(id, "focus");
    return Array.from(seen, ([id, origin]) => ({ id, origin }));
  }

  enumerateTools(actor: ObjRef): McpTool[] {
    const tools: McpTool[] = [];
    const usedNames = new Set<string>();
    for (const { id } of this.reachable(actor)) {
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

  // Compute a stable digest of the current tool list for change detection.
  private toolListDigest(actor: ObjRef): string {
    const tools = this.enumerateTools(actor);
    return tools.map((tool) => `${tool.name}@${tool.object}:${tool.verb}:${tool.direct ? "d" : "s"}`).sort().join("|");
  }

  refreshToolList(actor: ObjRef): boolean {
    const digest = this.toolListDigest(actor);
    const previous = this.toolListSnapshot.get(actor);
    if (digest === previous) return false;
    this.toolListSnapshot.set(actor, digest);
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
    // Walk the parent chain first, then merge attached feature verbs (per
    // semantics/features.md): features supply additional verbs the consumer
    // may not define itself. Conversational chat verbs ride on $conversational.
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
      const result = await this.world.directCall(undefined, actor, tool.object, tool.verb, args);
      if (result.op === "error") throw fromError(result.error);
      this.routeDirectResult(result);
      this.refreshToolList(actor);
      return { result: result.result, observations: result.observations };
    }
    const space = tool.enclosingSpace ?? this.enclosingSpaceFor(tool.object);
    if (!space) throw wooError("E_INVARG", `verb ${tool.object}:${tool.verb} has no enclosing space for sequenced dispatch`);
    const message = { actor, target: tool.object, verb: tool.verb, args };
    const frame = await this.world.call(undefined, sessionId, space, message);
    if (frame.op === "error") throw fromError(frame.error);
    this.routeAppliedFrame(frame);
    this.refreshToolList(actor);
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
    const actor = ctx.thisObj;
    this.registerActor(actor);
    const queue = this.queues.get(actor)!;
    if (queue.observations.length === 0 && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const waiter: ActorQueue["waiters"] extends Set<infer T> ? T : never = {
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
    const list = this.focusListOf(actor);
    if (!list.includes(target)) {
      list.push(target);
      while (list.length > FOCUS_LIST_CAP) list.shift();
      this.world.setProp(actor, "focus_list", list);
      this.refreshToolList(actor);
    }
    return list as unknown as WooValue;
  }

  private handleUnfocus(ctx: CallContext, args: WooValue[]): WooValue {
    const target = String(args[0] ?? "");
    const actor = ctx.thisObj;
    const list = this.focusListOf(actor).filter((id) => id !== target);
    this.world.setProp(actor, "focus_list", list);
    this.refreshToolList(actor);
    return list as unknown as WooValue;
  }

  private handleFocusList(ctx: CallContext): WooValue {
    return this.focusListOf(ctx.thisObj) as unknown as WooValue;
  }

  private focusListOf(actor: ObjRef): ObjRef[] {
    const raw = this.world.propOrNull(actor, "focus_list");
    return Array.isArray(raw) ? raw.filter((item): item is ObjRef => typeof item === "string") : [];
  }
}

function makeQueue(): ActorQueue {
  return { observations: [], lostSinceMark: 0, firstLostTs: null, waiters: new Set() };
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
  (err as Error & { code?: string }).code = error.code;
  return err;
}
