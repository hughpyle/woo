import {
  assertMap,
  assertObj,
  assertString,
  cloneValue,
  isErrorValue,
  type AppliedFrame,
  type ErrorFrame,
  type ErrorValue,
  type Message,
  type Observation,
  type ObjRef,
  type PropertyDef,
  type Session,
  type SpaceLogEntry,
  type VerbDef,
  type WooObject,
  type WooValue,
  wooError
} from "./types";
import { runTinyVm } from "./tiny-vm";

type NativeHandler = (ctx: CallContext, args: WooValue[]) => WooValue;
const DRUM_VOICES = ["kick", "snare", "hat", "tone"] as const;

export type CallContext = {
  world: WooWorld;
  space: ObjRef;
  seq: number;
  actor: ObjRef;
  thisObj: ObjRef;
  message: Message;
  observations: Observation[];
  observe(event: Observation): void;
};

export type WorldSnapshot = {
  server_time: number;
  actorCount: number;
  spaces: Record<string, { next_seq: number; log_count: number }>;
  dubspace: ReturnType<WooWorld["dubspaceState"]>;
  taskspace: ReturnType<WooWorld["taskspaceState"]>;
  objects: Record<string, unknown>;
};

export class WooWorld {
  objects = new Map<ObjRef, WooObject>();
  sessions = new Map<string, Session>();
  logs = new Map<ObjRef, SpaceLogEntry[]>();
  private nativeHandlers = new Map<string, NativeHandler>();
  private idempotency = new Map<string, { at: number; frame: AppliedFrame | ErrorFrame }>();
  private taskCounter = 1;
  private sessionCounter = 1;

  constructor() {
    this.registerNativeHandlers();
  }

  createObject(input: {
    id: ObjRef;
    name?: string;
    parent: ObjRef | null;
    owner?: ObjRef;
    location?: ObjRef | null;
    anchor?: ObjRef | null;
    flags?: WooObject["flags"];
  }): WooObject {
    const existing = this.objects.get(input.id);
    if (existing) return existing;
    const now = Date.now();
    const obj: WooObject = {
      id: input.id,
      name: input.name ?? input.id,
      parent: input.parent,
      owner: input.owner ?? "$wiz",
      location: input.location ?? null,
      anchor: input.anchor ?? null,
      flags: input.flags ?? {},
      created: now,
      modified: now,
      propertyDefs: new Map(),
      properties: new Map(),
      propertyVersions: new Map(),
      verbs: new Map(),
      children: new Set(),
      contents: new Set(),
      eventSchemas: new Map()
    };
    this.objects.set(obj.id, obj);
    if (obj.parent) this.objects.get(obj.parent)?.children.add(obj.id);
    if (obj.location) this.objects.get(obj.location)?.contents.add(obj.id);
    return obj;
  }

  object(id: ObjRef): WooObject {
    const obj = this.objects.get(id);
    if (!obj) throw wooError("E_OBJNF", `object not found: ${id}`, id);
    return obj;
  }

  defineProperty(obj: ObjRef, def: Omit<PropertyDef, "version"> & { version?: number }): PropertyDef {
    const target = this.object(obj);
    const property: PropertyDef = { ...def, version: def.version ?? 1 };
    target.propertyDefs.set(property.name, property);
    if (!target.properties.has(property.name)) {
      target.properties.set(property.name, cloneValue(property.defaultValue));
      target.propertyVersions.set(property.name, 1);
    }
    return property;
  }

  setProp(objRef: ObjRef, name: string, value: WooValue): void {
    const obj = this.object(objRef);
    obj.properties.set(name, cloneValue(value));
    obj.propertyVersions.set(name, (obj.propertyVersions.get(name) ?? 0) + 1);
    obj.modified = Date.now();
  }

  getProp(objRef: ObjRef, name: string): WooValue {
    const obj = this.object(objRef);
    if (obj.properties.has(name)) return cloneValue(obj.properties.get(name)!);
    let parent = obj.parent;
    while (parent) {
      const ancestor = this.object(parent);
      const def = ancestor.propertyDefs.get(name);
      if (def) return cloneValue(def.defaultValue);
      parent = ancestor.parent;
    }
    throw wooError("E_PROPNF", `property not found: ${name}`, name);
  }

  addVerb(objRef: ObjRef, verb: VerbDef): VerbDef {
    this.object(objRef).verbs.set(verb.name, verb);
    return verb;
  }

  resolveVerb(objRef: ObjRef, name: string): { definer: ObjRef; verb: VerbDef } {
    let current: ObjRef | null = objRef;
    while (current) {
      const obj = this.object(current);
      const verb = obj.verbs.get(name);
      if (verb) return { definer: current, verb };
      current = obj.parent;
    }
    throw wooError("E_VERBNF", `verb not found: ${objRef}:${name}`, { obj: objRef, name });
  }

  describe(objRef: ObjRef): Record<string, WooValue> {
    const obj = this.object(objRef);
    return {
      id: obj.id,
      name: obj.name,
      description: this.propOrNull(objRef, "description"),
      parent: obj.parent,
      owner: obj.owner,
      location: obj.location,
      anchor: obj.anchor,
      flags: {
        wizard: Boolean(obj.flags.wizard),
        programmer: Boolean(obj.flags.programmer),
        fertile: Boolean(obj.flags.fertile),
        recyclable: Boolean(obj.flags.recyclable)
      },
      modified: obj.modified,
      children_count: obj.children.size,
      contents_count: obj.contents.size,
      properties: this.properties(objRef),
      verbs: this.verbs(objRef),
      children: Array.from(obj.children),
      contents: Array.from(obj.contents)
    };
  }

  properties(objRef: ObjRef): WooValue[] {
    const names = new Set<string>();
    let current: ObjRef | null = objRef;
    while (current) {
      const obj = this.object(current);
      for (const name of obj.propertyDefs.keys()) names.add(name);
      for (const name of obj.properties.keys()) names.add(name);
      current = obj.parent;
    }
    return Array.from(names).sort();
  }

  propOrNull(objRef: ObjRef, name: string): WooValue {
    try {
      return this.getProp(objRef, name);
    } catch {
      return null;
    }
  }

  verbs(objRef: ObjRef): WooValue[] {
    const names = new Set<string>();
    let current: ObjRef | null = objRef;
    while (current) {
      const obj = this.object(current);
      for (const name of obj.verbs.keys()) names.add(name);
      current = obj.parent;
    }
    return Array.from(names).sort();
  }

  verbInfo(objRef: ObjRef, name: string): Record<string, WooValue> {
    const { definer, verb } = this.resolveVerb(objRef, name);
    const base: Record<string, WooValue> = {
      name: verb.name,
      aliases: verb.aliases,
      definer,
      owner: verb.owner,
      perms: verb.perms,
      arg_spec: verb.arg_spec,
      version: verb.version,
      readable: verb.perms.includes("r")
    };
    if (verb.perms.includes("r")) {
      base.source = verb.source;
      base.source_hash = verb.source_hash;
      base.line_map = verb.line_map;
      if (verb.kind === "bytecode") base.bytecode_version = verb.bytecode.version;
    }
    return base;
  }

  propertyInfo(objRef: ObjRef, name: string): Record<string, WooValue> {
    let current: ObjRef | null = objRef;
    while (current) {
      const obj = this.object(current);
      const def = obj.propertyDefs.get(name);
      if (def) {
        return {
          name,
          owner: def.owner,
          perms: def.perms,
          defined_on: current,
          type_hint: def.typeHint ?? null,
          version: def.version,
          has_value: this.object(objRef).properties.has(name)
        };
      }
      current = obj.parent;
    }
    throw wooError("E_PROPNF", `property not found: ${name}`, name);
  }

  auth(token: string): Session {
    if (token.startsWith("session:")) {
      const session = this.sessions.get(token.slice("session:".length));
      if (!session) throw wooError("E_NOSESSION", "session token is expired or unknown");
      return session;
    }
    const id = `session-${this.sessionCounter++}`;
    const actor = this.allocateGuest();
    const session: Session = { id, actor, started: Date.now(), attachedSockets: new Set() };
    this.sessions.set(id, session);
    this.ensurePresence(actor, "the_dubspace");
    this.ensurePresence(actor, "the_taskspace");
    return session;
  }

  attachSocket(sessionId: string, socketId: string): void {
    this.sessions.get(sessionId)?.attachedSockets.add(socketId);
  }

  detachSocket(sessionId: string, socketId: string): void {
    this.sessions.get(sessionId)?.attachedSockets.delete(socketId);
  }

  hasPresence(actor: ObjRef, space: ObjRef): boolean {
    const presence = this.getProp(actor, "presence_in");
    return Array.isArray(presence) && presence.includes(space);
  }

  call(frameId: string | undefined, sessionId: string, space: ObjRef, message: Message): AppliedFrame | ErrorFrame {
    this.sweepIdempotency();
    if (frameId) {
      const cached = this.idempotency.get(`${sessionId}:${frameId}`);
      if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.frame;
    }
    let frame: AppliedFrame | ErrorFrame;
    try {
      frame = this.applyCall(frameId, space, message);
    } catch (err) {
      const error = normalizeError(err);
      frame = { op: "error", id: frameId, error };
    }
    if (frameId) this.idempotency.set(`${sessionId}:${frameId}`, { at: Date.now(), frame });
    return frame;
  }

  replay(space: ObjRef, from: number, limit: number): SpaceLogEntry[] {
    return (this.logs.get(space) ?? []).filter((entry) => entry.seq >= from).slice(0, limit);
  }

  applyCall(id: string | undefined, spaceRef: ObjRef, message: Message): AppliedFrame {
    this.validateMessage(message);
    const space = this.object(spaceRef);
    this.authorizePresence(message.actor, spaceRef);
    const nextSeq = Number(this.getProp(spaceRef, "next_seq"));
    const seq = nextSeq;
    this.setProp(spaceRef, "next_seq", nextSeq + 1);

    const logEntry: SpaceLogEntry = {
      space: spaceRef,
      seq,
      ts: Date.now(),
      actor: message.actor,
      message: cloneValue(message) as Message,
      applied_ok: true
    };
    const log = this.logs.get(spaceRef) ?? [];
    log.push(logEntry);
    this.logs.set(spaceRef, log);

    const before = this.snapshotProps();
    const observations: Observation[] = [];
    const ctx: CallContext = {
      world: this,
      space: spaceRef,
      seq,
      actor: message.actor,
      thisObj: message.target,
      message,
      observations,
      observe: (event) => {
        observations.push({ ...event, source: event.source ?? space.id });
      }
    };

    try {
      this.dispatch(ctx, message.target, message.verb, message.args);
      logEntry.applied_ok = true;
    } catch (err) {
      this.restoreProps(before);
      const error = normalizeError(err);
      logEntry.applied_ok = false;
      logEntry.error = error;
      observations.length = 0;
      observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null });
    }

    return { op: "applied", id, space: spaceRef, seq, message, observations };
  }

  dispatch(ctx: CallContext, target: ObjRef, verbName: string, args: WooValue[]): WooValue {
    const { verb } = this.resolveVerb(target, verbName);
    ctx.thisObj = target;
    if (verb.kind === "native") {
      const handler = this.nativeHandlers.get(verb.native);
      if (!handler) throw wooError("E_VERBNF", `native handler not found: ${verb.native}`);
      return handler(ctx, args);
    }
    return runTinyVm(ctx, verb.bytecode, args);
  }

  state(): WorldSnapshot {
    const spaces: WorldSnapshot["spaces"] = {};
    for (const id of ["the_dubspace", "the_taskspace"]) {
      spaces[id] = { next_seq: Number(this.getProp(id, "next_seq")), log_count: this.logs.get(id)?.length ?? 0 };
    }
    return {
      server_time: Date.now(),
      actorCount: Array.from(this.objects.values()).filter((obj) => obj.parent === "$player").length,
      spaces,
      dubspace: this.dubspaceState(),
      taskspace: this.taskspaceState(),
      objects: Object.fromEntries(Array.from(this.objects.keys()).map((id) => [id, this.describe(id)]))
    };
  }

  dubspaceState() {
    const controls = ["slot_1", "slot_2", "slot_3", "slot_4", "channel_1", "filter_1", "delay_1", "drum_1", "default_scene"];
    return Object.fromEntries(
      controls.map((id) => [
        id,
        {
          id,
          name: this.object(id).name,
          props: Object.fromEntries(this.object(id).properties)
        }
      ])
    );
  }

  taskspaceState() {
    const taskIds = Array.from(this.objects.values())
      .filter((obj) => obj.parent === "$task")
      .map((obj) => obj.id);
    const tasks = Object.fromEntries(
      taskIds.map((id) => [
        id,
        {
          id,
          name: this.object(id).name,
          props: Object.fromEntries(this.object(id).properties)
        }
      ])
    );
    return { root_tasks: this.getProp("the_taskspace", "root_tasks"), tasks };
  }

  createTask(space: ObjRef, title: string, description: string, parentTask: ObjRef | null): ObjRef {
    const id = `task_${this.taskCounter++}`;
    this.createObject({ id, name: title, parent: "$task", owner: "$wiz", anchor: space });
    this.setProp(id, "title", title);
    this.setProp(id, "description", description);
    this.setProp(id, "parent_task", parentTask);
    this.setProp(id, "subtasks", []);
    this.setProp(id, "status", "open");
    this.setProp(id, "assignee", null);
    this.setProp(id, "requirements", []);
    this.setProp(id, "artifacts", []);
    this.setProp(id, "messages", []);
    this.setProp(id, "space", space);
    return id;
  }

  private validateMessage(message: Message): void {
    if (!message || typeof message !== "object") throw wooError("E_INVARG", "message must be a map");
    assertObj(message.actor);
    assertObj(message.target);
    assertString(message.verb);
    if (!Array.isArray(message.args)) throw wooError("E_INVARG", "message.args must be a list");
  }

  private authorizePresence(actor: ObjRef, space: ObjRef): void {
    if (!this.hasPresence(actor, space)) {
      throw wooError("E_PERM", `${actor} is not present in ${space}`);
    }
  }

  private ensurePresence(actor: ObjRef, space: ObjRef): void {
    const presence = this.getProp(actor, "presence_in");
    if (Array.isArray(presence) && !presence.includes(space)) {
      presence.push(space);
      this.setProp(actor, "presence_in", presence);
    }
    const subscribers = this.getProp(space, "subscribers");
    if (Array.isArray(subscribers) && !subscribers.includes(actor)) {
      subscribers.push(actor);
      this.setProp(space, "subscribers", subscribers);
    }
  }

  private allocateGuest(): ObjRef {
    for (const id of ["guest_1", "guest_2", "guest_3", "guest_4", "guest_5", "guest_6", "guest_7", "guest_8"]) {
      const used = Array.from(this.sessions.values()).some((session) => session.actor === id);
      if (!used) return id;
    }
    const id = `guest_${this.objects.size}`;
    this.createObject({ id, name: id, parent: "$player", owner: "$wiz" });
    this.setProp(id, "description", "Dynamically allocated guest player. It can be bound to a temporary session, gains presence in demo spaces on auth, and gives a local user or agent a stable actor for first-light testing.");
    this.setProp(id, "presence_in", []);
    this.setProp(id, "session_id", null);
    this.setProp(id, "attached_sockets", []);
    return id;
  }

  private snapshotProps(): Map<ObjRef, Map<string, WooValue>> {
    return new Map(Array.from(this.objects.entries()).map(([id, obj]) => [id, new Map(Array.from(obj.properties.entries()).map(([k, v]) => [k, cloneValue(v)]))]));
  }

  private restoreProps(snapshot: Map<ObjRef, Map<string, WooValue>>): void {
    for (const [id, props] of snapshot) {
      const obj = this.objects.get(id);
      if (obj) obj.properties = new Map(Array.from(props.entries()).map(([k, v]) => [k, cloneValue(v)]));
    }
  }

  private registerNativeHandlers(): void {
    this.nativeHandlers.set("describe", (ctx) => this.describe(ctx.thisObj));
    this.nativeHandlers.set("replay", (ctx, args) => {
      const from = Number(args[0] ?? 1);
      const limit = Number(args[1] ?? 100);
      return this.replay(ctx.thisObj, from, limit).map((entry) => ({
        seq: entry.seq,
        message: entry.message as unknown as WooValue,
        applied_ok: entry.applied_ok,
        error: entry.error as unknown as WooValue
      }));
    });
    this.nativeHandlers.set("start_loop", (ctx, args) => {
      const slot = assertObj(args[0]);
      this.setProp(slot, "playing", true);
      ctx.observe({ type: "loop_started", slot, loop_id: this.getProp(slot, "loop_id") });
      return true;
    });
    this.nativeHandlers.set("stop_loop", (ctx, args) => {
      const slot = assertObj(args[0]);
      this.setProp(slot, "playing", false);
      ctx.observe({ type: "loop_stopped", slot });
      return true;
    });
    this.nativeHandlers.set("save_scene", (ctx, args) => {
      const name = assertString(args[0] ?? "Scene");
      const controls: Record<string, WooValue> = {};
      for (const id of ["slot_1", "slot_2", "slot_3", "slot_4", "channel_1", "filter_1", "delay_1", "drum_1"]) {
        controls[id] = Object.fromEntries(this.object(id).properties) as WooValue;
      }
      this.setProp("default_scene", "name", name);
      this.setProp("default_scene", "controls", controls);
      ctx.observe({ type: "scene_saved", scene: "default_scene", name });
      return "default_scene";
    });
    this.nativeHandlers.set("recall_scene", (ctx) => {
      const controls = assertMap(this.getProp("default_scene", "controls"));
      for (const [id, props] of Object.entries(controls)) {
        const propMap = assertMap(props);
        for (const [name, value] of Object.entries(propMap)) this.setProp(id, name, value);
      }
      ctx.observe({ type: "scene_recalled", scene: "default_scene" });
      return true;
    });
    this.nativeHandlers.set("set_drum_step", (ctx, args) => {
      const voice = assertString(args[0]);
      if (!DRUM_VOICES.includes(voice as (typeof DRUM_VOICES)[number])) throw wooError("E_INVARG", "unknown drum voice", voice);
      const step = Number(args[1]);
      if (!Number.isInteger(step) || step < 0 || step >= 8) throw wooError("E_RANGE", "drum step out of range", step);
      if (typeof args[2] !== "boolean") throw wooError("E_TYPE", "enabled must be boolean", args[2]);
      const enabled = args[2];
      const pattern = this.drumPattern();
      pattern[voice][step] = enabled;
      this.setProp("drum_1", "pattern", pattern as unknown as WooValue);
      ctx.observe({ type: "drum_step_changed", source: ctx.space, target: "drum_1", voice, step, enabled });
      return enabled;
    });
    this.nativeHandlers.set("set_tempo", (ctx, args) => {
      const rawBpm = Number(args[0]);
      if (!Number.isFinite(rawBpm)) throw wooError("E_TYPE", "tempo must be numeric", args[0]);
      const bpm = Math.max(60, Math.min(200, Math.round(rawBpm)));
      this.setProp("drum_1", "bpm", bpm);
      ctx.observe({ type: "tempo_changed", source: ctx.space, target: "drum_1", bpm });
      return bpm;
    });
    this.nativeHandlers.set("start_transport", (ctx) => {
      const startedAt = Date.now();
      this.setProp("drum_1", "playing", true);
      this.setProp("drum_1", "started_at", startedAt);
      ctx.observe({ type: "transport_started", source: ctx.space, target: "drum_1", started_at: startedAt, bpm: this.getProp("drum_1", "bpm") });
      return startedAt;
    });
    this.nativeHandlers.set("stop_transport", (ctx) => {
      this.setProp("drum_1", "playing", false);
      ctx.observe({ type: "transport_stopped", source: ctx.space, target: "drum_1" });
      return true;
    });
    this.nativeHandlers.set("create_task", (ctx, args) => {
      const title = assertString(args[0]);
      const description = assertString(args[1] ?? "");
      const task = this.createTask(ctx.space, title, description, null);
      const roots = this.getProp(ctx.space, "root_tasks");
      if (Array.isArray(roots)) this.setProp(ctx.space, "root_tasks", [...roots, task]);
      ctx.observe({ type: "task_created", source: ctx.space, task, parent: null, title });
      return task;
    });
    this.nativeHandlers.set("add_subtask", (ctx, args) => {
      const title = assertString(args[0]);
      const description = assertString(args[1] ?? "");
      const task = this.createTask(ctx.space, title, description, ctx.thisObj);
      const subtasks = this.getProp(ctx.thisObj, "subtasks");
      const next = Array.isArray(subtasks) ? [...subtasks, task] : [task];
      this.setProp(ctx.thisObj, "subtasks", next);
      ctx.observe({ type: "task_created", source: ctx.space, task, parent: ctx.thisObj, title });
      ctx.observe({ type: "subtask_added", source: ctx.space, parent: ctx.thisObj, child: task, index: next.length - 1 });
      return task;
    });
    this.nativeHandlers.set("move_task", (ctx, args) => this.moveTask(ctx, args));
    this.nativeHandlers.set("claim_task", (ctx) => this.claimTask(ctx));
    this.nativeHandlers.set("release_task", (ctx) => {
      const assignee = this.getProp(ctx.thisObj, "assignee");
      if (assignee !== ctx.actor && !this.object(ctx.actor).flags.wizard) throw wooError("E_PERM", "only assignee or wizard can release");
      this.setProp(ctx.thisObj, "assignee", null);
      if (this.getProp(ctx.thisObj, "status") !== "done") this.setProp(ctx.thisObj, "status", "open");
      ctx.observe({ type: "task_released", source: ctx.space, task: ctx.thisObj });
      return ctx.thisObj;
    });
    this.nativeHandlers.set("set_status_task", (ctx, args) => {
      const status = assertString(args[0]);
      const allowed = new Set(["open", "claimed", "in_progress", "blocked", "done"]);
      if (!allowed.has(status)) throw wooError("E_INVARG", "invalid task status", status);
      const assignee = this.getProp(ctx.thisObj, "assignee");
      if (assignee !== null && assignee !== ctx.actor && !this.object(ctx.actor).flags.wizard) {
        throw wooError("E_PERM", "only assignee or wizard can set status");
      }
      const from = assertString(this.getProp(ctx.thisObj, "status"));
      this.setProp(ctx.thisObj, "status", status);
      ctx.observe({ type: "status_changed", source: ctx.space, task: ctx.thisObj, from, to: status });
      if (status === "done") {
        const requirements = this.getProp(ctx.thisObj, "requirements");
        const unchecked = Array.isArray(requirements)
          ? requirements
              .map((item) => assertMap(item))
              .filter((item) => item.checked !== true)
              .map((item) => item.text as WooValue)
          : [];
        if (unchecked.length > 0) ctx.observe({ type: "done_premature", source: ctx.space, task: ctx.thisObj, unchecked });
      }
      return status;
    });
    this.nativeHandlers.set("add_requirement", (ctx, args) => {
      const text = assertString(args[0]);
      const requirements = this.getProp(ctx.thisObj, "requirements");
      const next = Array.isArray(requirements) ? [...requirements, { text, checked: false }] : [{ text, checked: false }];
      this.setProp(ctx.thisObj, "requirements", next);
      ctx.observe({ type: "requirement_added", source: ctx.space, task: ctx.thisObj, index: next.length - 1, text });
      return next.length - 1;
    });
    this.nativeHandlers.set("check_requirement", (ctx, args) => {
      const index = Number(args[0]);
      const checked = Boolean(args[1]);
      const requirements = this.getProp(ctx.thisObj, "requirements");
      if (!Array.isArray(requirements) || index < 0 || index >= requirements.length) throw wooError("E_RANGE", "requirement index out of range", index);
      const next = requirements.map((item, i) => (i === index ? { ...assertMap(item), checked } : item));
      this.setProp(ctx.thisObj, "requirements", next);
      ctx.observe({ type: "requirement_checked", source: ctx.space, task: ctx.thisObj, index, checked });
      return checked;
    });
    this.nativeHandlers.set("add_message", (ctx, args) => {
      const body = assertString(args[0]);
      const messages = this.getProp(ctx.thisObj, "messages");
      const msg = { actor: ctx.actor, ts: Date.now(), body };
      this.setProp(ctx.thisObj, "messages", Array.isArray(messages) ? [...messages, msg] : [msg]);
      ctx.observe({ type: "message_added", source: ctx.space, task: ctx.thisObj, actor: ctx.actor, body, ts: msg.ts });
      return msg as WooValue;
    });
    this.nativeHandlers.set("add_artifact", (ctx, args) => {
      const ref = assertMap(args[0]);
      if (typeof ref.kind !== "string" || typeof ref.ref !== "string") throw wooError("E_INVARG", "artifact needs kind and ref");
      const artifact = { ...ref, added_by: ctx.actor, added_at: Date.now() };
      const artifacts = this.getProp(ctx.thisObj, "artifacts");
      this.setProp(ctx.thisObj, "artifacts", Array.isArray(artifacts) ? [...artifacts, artifact] : [artifact]);
      ctx.observe({ type: "artifact_attached", source: ctx.space, task: ctx.thisObj, ref: artifact as WooValue });
      return artifact as WooValue;
    });
  }

  private claimTask(ctx: CallContext): WooValue {
    const current = this.getProp(ctx.thisObj, "assignee");
    if (current === ctx.actor) return ctx.thisObj;
    if (current !== null) throw wooError("E_CONFLICT", "task already claimed", current);
    this.setProp(ctx.thisObj, "assignee", ctx.actor);
    this.setProp(ctx.thisObj, "status", "claimed");
    ctx.observe({ type: "task_claimed", source: ctx.space, task: ctx.thisObj, actor: ctx.actor });
    return ctx.thisObj;
  }

  private moveTask(ctx: CallContext, args: WooValue[]): WooValue {
    const parent = args[0] === null ? null : assertObj(args[0]);
    const index = Number(args[1]);
    if (parent === ctx.thisObj || (parent && this.descendants(ctx.thisObj).has(parent))) throw wooError("E_RECMOVE", "recursive task move");
    if (parent && this.getProp(parent, "space") !== ctx.space) throw wooError("E_INVARG", "cross-taskspace move is not supported");
    const fromParent = this.getProp(ctx.thisObj, "parent_task") as ObjRef | null;
    const sourceListRef = fromParent ?? ctx.space;
    const sourceProp = fromParent ? "subtasks" : "root_tasks";
    const targetListRef = parent ?? ctx.space;
    const targetProp = parent ? "subtasks" : "root_tasks";
    const sourceList = this.getProp(sourceListRef, sourceProp);
    const targetList = sourceListRef === targetListRef ? sourceList : this.getProp(targetListRef, targetProp);
    if (!Array.isArray(sourceList) || !Array.isArray(targetList)) throw wooError("E_INVARG", "invalid task hierarchy");
    const without = sourceList.filter((id) => id !== ctx.thisObj);
    const targetBase = sourceListRef === targetListRef ? without : targetList.filter((id) => id !== ctx.thisObj);
    if (index < 0 || index > targetBase.length) throw wooError("E_RANGE", "task move index out of range", index);
    const targetNext = [...targetBase.slice(0, index), ctx.thisObj, ...targetBase.slice(index)];
    this.setProp(sourceListRef, sourceProp, without);
    this.setProp(targetListRef, targetProp, targetNext);
    this.setProp(ctx.thisObj, "parent_task", parent);
    ctx.observe({ type: "task_moved", source: ctx.space, task: ctx.thisObj, from_parent: fromParent, to_parent: parent, index });
    return ctx.thisObj;
  }

  private descendants(task: ObjRef): Set<ObjRef> {
    const out = new Set<ObjRef>();
    const stack = [...((this.getProp(task, "subtasks") as WooValue[]) ?? [])] as ObjRef[];
    while (stack.length) {
      const id = stack.pop()!;
      out.add(id);
      const subtasks = this.getProp(id, "subtasks");
      if (Array.isArray(subtasks)) stack.push(...(subtasks as ObjRef[]));
    }
    return out;
  }

  private drumPattern(): Record<string, boolean[]> {
    const raw = this.propOrNull("drum_1", "pattern");
    const map = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const pattern: Record<string, boolean[]> = {};
    for (const voice of DRUM_VOICES) {
      const row = (map as Record<string, WooValue>)[voice];
      pattern[voice] = Array.from({ length: 8 }, (_, index) => (Array.isArray(row) ? Boolean(row[index]) : false));
    }
    return pattern;
  }

  private sweepIdempotency(): void {
    const now = Date.now();
    for (const [key, entry] of this.idempotency) {
      if (now - entry.at >= 5 * 60 * 1000) this.idempotency.delete(key);
    }
    if (this.idempotency.size <= 1000) return;
    const oldest = Array.from(this.idempotency.entries()).sort((a, b) => a[1].at - b[1].at);
    for (const [key] of oldest.slice(0, this.idempotency.size - 1000)) this.idempotency.delete(key);
  }
}

export function normalizeError(err: unknown): ErrorValue {
  if (isErrorValue(err)) return err;
  if (err instanceof SyntaxError) return wooError("E_INVARG", err.message);
  if (err instanceof Error) return wooError("E_INTERNAL", err.message);
  return wooError("E_INTERNAL", "unknown error", String(err));
}
