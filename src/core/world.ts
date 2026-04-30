import {
  assertMap,
  assertObj,
  assertString,
  cloneValue,
  isErrorValue,
  valuesEqual,
  type AppliedFrame,
  type DirectResultFrame,
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
import type { ObjectRepository, ParkedTaskRecord, SerializedObject, SerializedSession, SerializedWorld, SpaceSnapshotRecord, WorldRepository } from "./repository";
import { isVmReadSignal, isVmSuspendSignal, runSerializedTinyVmTask, runSerializedTinyVmTaskWithInput, runTinyVm, type SerializedVmTask } from "./tiny-vm";
import { installCatalogManifest, type CatalogManifest } from "./catalog-installer";

type NativeHandler = (ctx: CallContext, args: WooValue[]) => WooValue;
const GUEST_SESSION_GRACE_MS = 60_000;
const GUEST_SESSION_TTL_MS = 5 * 60_000;
const CREDENTIAL_SESSION_GRACE_MS = 5 * 60_000;
const CREDENTIAL_SESSION_TTL_MS = 24 * 60 * 60_000;

type ResolvedVerb = {
  definer: ObjRef;
  verb: VerbDef;
};

export type CallContext = {
  world: WooWorld;
  space: ObjRef;
  seq: number;
  actor: ObjRef;
  player: ObjRef;
  caller: ObjRef;
  progr: ObjRef;
  thisObj: ObjRef;
  verbName: string;
  definer: ObjRef;
  message: Message;
  observations: Observation[];
  observe(event: Observation): void;
};

export type WorldSnapshot = {
  server_time: number;
  actorCount: number;
  spaces: Record<string, { next_seq: number; log_count: number }>;
  catalogs: { installed: WooValue[] };
  object_routes: Array<{ id: ObjRef; host: string; anchor: ObjRef | null }>;
  objects: Record<string, unknown>;
};

export type ParkedTaskRun = {
  task: ParkedTaskRecord;
  frame?: AppliedFrame | ErrorFrame;
  observations: Observation[];
  error?: ErrorValue;
};

export type DirectCallOptions = {
  forceDirect?: boolean;
  forceReason?: string;
};

type WooRepository = WorldRepository & Partial<ObjectRepository>;

type BehaviorSavepoint = {
  objects: Map<ObjRef, WooObject>;
  sessions: Map<string, Session>;
  snapshots: SpaceSnapshotRecord[];
  parkedTasks: Map<string, ParkedTaskRecord>;
  objectCounter: number;
  parkedTaskCounter: number;
  sessionCounter: number;
  guestFreePool: Set<ObjRef>;
};

const MAX_CALL_DEPTH = 128;

// WooWorld still carries both persistence shapes during the v0.5 transition:
// exportWorld/importWorld support bootstrap migration and JSON-folder dumps,
// while ObjectRepository is the runtime hot path after bootstrap.
function isObjectRepository(repository: WooRepository | undefined): repository is WooRepository & ObjectRepository {
  return (
    repository !== undefined &&
    typeof repository.saveObject === "function" &&
    typeof repository.appendLog === "function" &&
    typeof repository.transaction === "function" &&
    typeof repository.savepoint === "function"
  );
}

export class WooWorld {
  objects = new Map<ObjRef, WooObject>();
  sessions = new Map<string, Session>();
  logs = new Map<ObjRef, SpaceLogEntry[]>();
  snapshots: SpaceSnapshotRecord[] = [];
  parkedTasks = new Map<string, ParkedTaskRecord>();
  private nativeHandlers = new Map<string, NativeHandler>();
  private idempotency = new Map<string, { at: number; frame: AppliedFrame | ErrorFrame }>();
  private objectCounter = 1;
  private parkedTaskCounter = 1;
  private sessionCounter = 1;
  private persistencePaused = 0;
  // Defers whole-world fallback saves while grouped in-memory mutations settle.
  // ObjectRepository-backed worlds persist each touched slice directly.
  private persistenceDeferred = 0;
  private persistenceDirty = false;
  private callDepth = 0;
  private guestFreePool = new Set<ObjRef>();
  private objectRepository: ObjectRepository | null;
  private incrementalPersistenceEnabled = false;

  constructor(private repository?: WooRepository) {
    this.objectRepository = isObjectRepository(repository) ? repository : null;
    this.registerNativeHandlers();
  }

  enableIncrementalPersistence(): void {
    if (this.objectRepository) this.incrementalPersistenceEnabled = true;
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
    this.persistObject(obj.id);
    if (obj.parent) this.persistObject(obj.parent);
    if (obj.location) this.persistObject(obj.location);
    this.persist();
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
    this.persistObject(obj);
    this.persist();
    return property;
  }

  setProp(objRef: ObjRef, name: string, value: WooValue): void {
    this.setPropLocal(objRef, name, value);
    this.persistObject(objRef);
    this.persist();
  }

  private setPropLocal(objRef: ObjRef, name: string, value: WooValue): void {
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
    this.persistObject(objRef);
    this.persist();
    return verb;
  }

  defineEventSchema(objRef: ObjRef, type: string, shape: Record<string, WooValue>): void {
    const obj = this.object(objRef);
    obj.eventSchemas.set(type, cloneValue(shape as WooValue) as Record<string, WooValue>);
    obj.modified = Date.now();
    this.persistObject(objRef);
    this.persist();
  }

  resolveVerb(objRef: ObjRef, name: string): ResolvedVerb {
    const parentMatch = this.resolveVerbFrom(objRef, name, false);
    if (parentMatch) return parentMatch;
    if (this.canCarryFeatures(objRef)) {
      const features = this.featureList(objRef);
      for (const feature of features) {
        const featureMatch = this.resolveVerbFrom(feature, name, false);
        if (featureMatch) return featureMatch;
      }
    }
    throw wooError("E_VERBNF", `verb not found: ${objRef}:${name}`, { obj: objRef, name });
  }

  resolveVerbFrom(startRef: ObjRef | null, name: string): ResolvedVerb;
  resolveVerbFrom(startRef: ObjRef | null, name: string, required: false): ResolvedVerb | null;
  resolveVerbFrom(startRef: ObjRef | null, name: string, required = true): ResolvedVerb | null {
    let current: ObjRef | null = startRef;
    while (current) {
      const obj = this.object(current);
      const verb = obj.verbs.get(name);
      if (verb) return { definer: current, verb };
      current = obj.parent;
    }
    if (!required) return null;
    throw wooError("E_VERBNF", `verb not found: ${startRef ?? "#-1"}:${name}`, { obj: startRef ?? "#-1", name });
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
      schemas: this.schemas(objRef),
      children: Array.from(obj.children),
      contents: Array.from(obj.contents)
    };
  }

  describeForActor(objRef: ObjRef, actor: ObjRef): Record<string, WooValue> {
    const description = this.propOrNullForActor(actor, objRef, "description");
    return {
      ...this.describe(objRef),
      description
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

  getPropForActor(actor: ObjRef, objRef: ObjRef, name: string): WooValue {
    if (!this.canReadProperty(actor, objRef, name)) throw wooError("E_PERM", `${actor} cannot read ${objRef}.${name}`, { actor, obj: objRef, property: name });
    return this.getProp(objRef, name);
  }

  canReadProperty(actor: ObjRef, objRef: ObjRef, name: string): boolean {
    const info = this.propertyInfo(objRef, name);
    return Boolean(this.object(actor).flags.wizard) || info.owner === actor || String(info.perms).includes("r");
  }

  propOrNullForActor(actor: ObjRef, objRef: ObjRef, name: string): WooValue {
    try {
      return this.getPropForActor(actor, objRef, name);
    } catch {
      return null;
    }
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
    this.collectVerbNames(objRef, names);
    if (this.canCarryFeatures(objRef)) {
      for (const feature of this.featureList(objRef)) this.collectVerbNames(feature, names);
    }
    return Array.from(names).sort();
  }

  schemas(objRef: ObjRef): WooValue[] {
    const names = new Set<string>();
    this.collectSchemaNames(objRef, names);
    if (this.canCarryFeatures(objRef)) {
      for (const feature of this.featureList(objRef)) this.collectSchemaNames(feature, names);
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
      direct_callable: verb.direct_callable === true,
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
    const target = this.object(objRef);
    if (target.properties.has(name)) {
      return {
        name,
        owner: target.owner,
        perms: "rw",
        defined_on: objRef,
        type_hint: null,
        version: target.propertyVersions.get(name) ?? 1,
        has_value: true
      };
    }
    throw wooError("E_PROPNF", `property not found: ${name}`, name);
  }

  auth(token: string): Session {
    this.reapExpiredSessions();
    if (token.startsWith("session:")) {
      const session = this.sessions.get(token.slice("session:".length));
      if (!session) throw wooError("E_NOSESSION", "session token is expired or unknown");
      if (this.sessionExpired(session, Date.now())) {
        this.reapSession(session.id);
        this.persist(true);
        throw wooError("E_NOSESSION", "session token is expired or unknown");
      }
      return session;
    }
    const tokenClass = this.tokenClassFor(token);
    const actor = this.allocateGuest();
    return this.createSessionForActor(actor, tokenClass);
  }

  createSessionForActor(actor: ObjRef, tokenClass: Session["tokenClass"] = "bearer"): Session {
    this.reapExpiredSessions();
    this.object(actor);
    const id = `session-${this.sessionCounter++}`;
    this.persistCounters();
    const now = Date.now();
    const session: Session = {
      id,
      actor,
      started: now,
      expiresAt: now + this.sessionTtl(tokenClass),
      lastDetachAt: null,
      tokenClass,
      attachedSockets: new Set()
    };
    this.withPersistenceDeferred(() => {
      this.sessions.set(id, session);
      this.persistSession(session);
      this.setProp(actor, "session_id", id);
      this.ensureAutoPresence(actor);
    });
    return session;
  }

  ensureSessionForActor(
    id: string,
    actor: ObjRef,
    tokenClass: Session["tokenClass"] = "bearer",
    expiresAt?: number
  ): Session {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    this.object(actor);
    const now = Date.now();
    const session: Session = {
      id,
      actor,
      started: now,
      expiresAt: expiresAt ?? now + this.sessionTtl(tokenClass),
      lastDetachAt: null,
      tokenClass,
      attachedSockets: new Set()
    };
    this.withPersistenceDeferred(() => {
      this.sessions.set(id, session);
      this.persistSession(session);
      this.setProp(actor, "session_id", id);
      this.ensureAutoPresence(actor);
    });
    return session;
  }

  claimWizardBootstrapSession(presentedToken: string, expectedToken: string | undefined): Session {
    if (!expectedToken) throw wooError("E_BOOTSTRAP_TOKEN_MISSING", "WOO_INITIAL_WIZARD_TOKEN is not set");
    const claim = () => {
      if (this.propOrNull("$system", "bootstrap_token_used") === true) throw wooError("E_TOKEN_CONSUMED", "wizard bootstrap token has already been consumed");
      if (presentedToken !== expectedToken) throw wooError("E_NOSESSION", "invalid wizard bootstrap token");
      this.setProp("$system", "bootstrap_token_used", true);
      return this.createSessionForActor("$wiz", "bearer");
    };
    const repo = this.activeObjectRepository();
    return repo ? repo.transaction(claim) : claim();
  }

  attachSocket(sessionId: string, socketId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.withPersistenceDeferred(() => {
      session.attachedSockets.add(socketId);
      session.lastDetachAt = null;
      session.expiresAt = Math.max(session.expiresAt, Date.now() + this.sessionTtl(session.tokenClass));
      this.persistSession(session);
      this.persist();
    });
  }

  detachSocket(sessionId: string, socketId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.withPersistenceDeferred(() => {
      session.attachedSockets.delete(socketId);
      if (session.attachedSockets.size === 0) {
        const now = Date.now();
        session.lastDetachAt = now;
        session.expiresAt = Math.max(session.expiresAt, now + this.sessionGrace(session.tokenClass));
      }
      this.persistSession(session);
      this.persist();
    });
  }

  sessionAlive(sessionId: string, now = Date.now()): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (!this.sessionExpired(session, now)) return true;
    this.reapSession(sessionId);
    this.persist(true);
    return false;
  }

  hasPresence(actor: ObjRef, space: ObjRef): boolean {
    const presence = this.getProp(actor, "presence_in");
    return Array.isArray(presence) && presence.includes(space);
  }

  call(frameId: string | undefined, sessionId: string, space: ObjRef, message: Message): AppliedFrame | ErrorFrame {
    const session = this.sessions.get(sessionId);
    if (!session || !this.sessionAlive(sessionId)) {
      return { op: "error", id: frameId, error: wooError("E_NOSESSION", "session token is expired or unknown") };
    }
    if (message.actor !== session.actor) {
      return { op: "error", id: frameId, error: wooError("E_PERM", "message actor does not match session actor", { actor: message.actor, session_actor: session.actor }) };
    }
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

  directCall(frameId: string | undefined, actor: ObjRef, target: ObjRef, verbName: string, args: WooValue[], options: DirectCallOptions = {}): DirectResultFrame | ErrorFrame {
    try {
      assertObj(actor);
      assertObj(target);
      assertString(verbName);
      if (!Array.isArray(args)) throw wooError("E_INVARG", "args must be a list");
      const { verb } = this.resolveVerb(target, verbName);
      const forceDirect = options.forceDirect === true && verb.direct_callable !== true;
      const wizard = this.isWizard(actor);
      if (verb.direct_callable !== true && !forceDirect) {
        throw wooError("E_DIRECT_DENIED", `direct call denied for ${target}:${verbName}`, { target, verb: verbName });
      }
      if (forceDirect && !wizard) throw wooError("E_PERM", "only wizards may force direct calls", { actor, target, verb: verbName });
      if (forceDirect) this.recordWizardAction(actor, "force_direct", { target, verb: verbName, reason: options.forceReason ?? null });
      const audience = this.directAudience(target);
      if (audience && verb.skip_presence_check !== true && !forceDirect) this.authorizePresence(actor, audience);
      const observations: Observation[] = [];
      if (forceDirect) observations.push({ type: "wizard_action", action: "force_direct", actor, target, verb: verbName, source: target });
      const message: Message = { actor, target, verb: verbName, args };
      let result: WooValue = null;
      let mutated = false;
      this.withPersistencePaused(() => {
        const before = this.snapshotProps();
        const beforeParkedTasks = new Map(this.parkedTasks);
        const beforeParkedTaskCounter = this.parkedTaskCounter;
        const beforeObjectCount = this.objects.size;
        const ctx: CallContext = {
          world: this,
          space: audience ?? "#-1",
          seq: -1,
          actor,
          player: actor,
          caller: "#-1",
          progr: actor,
          thisObj: target,
          verbName,
          definer: target,
          message,
          observations,
          observe: (event) => {
            observations.push({ ...event, source: event.source ?? target });
          }
        };
        try {
          result = this.dispatch(ctx, target, verbName, args);
          mutated =
            beforeObjectCount !== this.objects.size ||
            this.propsChanged(before) ||
            beforeParkedTasks.size !== this.parkedTasks.size ||
            beforeParkedTaskCounter !== this.parkedTaskCounter;
        } catch (err) {
          this.restoreProps(before);
          this.parkedTasks = new Map(beforeParkedTasks);
          this.parkedTaskCounter = beforeParkedTaskCounter;
          throw err;
        }
      });
      if (mutated) this.persist(true);
      return { op: "result", id: frameId, result, observations, audience };
    } catch (err) {
      return { op: "error", id: frameId, error: normalizeError(err) };
    }
  }

  replay(space: ObjRef, from: number, limit: number): SpaceLogEntry[] {
    return (this.logs.get(space) ?? []).filter((entry) => entry.seq >= from).slice(0, limit);
  }

  applyCall(id: string | undefined, spaceRef: ObjRef, message: Message): AppliedFrame {
    const repo = this.activeObjectRepository();
    if (repo) return this.applyCallRepository(repo, id, spaceRef, message);
    return this.withPersistencePaused(() => {
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
        observations: [],
        applied_ok: true
      };
      const log = this.logs.get(spaceRef) ?? [];
      log.push(logEntry);
      this.logs.set(spaceRef, log);

      const observations: Observation[] = [];
      const ctx: CallContext = {
        world: this,
        space: spaceRef,
        seq,
        actor: message.actor,
        player: message.actor,
        caller: "#-1",
        progr: message.actor,
        thisObj: message.target,
        verbName: message.verb,
        definer: message.target,
        message,
        observations,
        observe: (event) => {
          observations.push({ ...event, source: event.source ?? space.id });
        }
      };

      try {
        this.withBehaviorSavepoint(() => {
          this.dispatch(ctx, message.target, message.verb, message.args);
        });
        logEntry.applied_ok = true;
      } catch (err) {
        if (isVmSuspendSignal(err)) {
          const task = this.parkVmContinuation(ctx, err.seconds, err.task);
          logEntry.applied_ok = true;
          observations.push({ type: "task_suspended", source: spaceRef, task, resume_at: this.parkedTasks.get(task)?.resume_at ?? null });
        } else if (isVmReadSignal(err)) {
          const task = this.parkReadContinuation(ctx, err.player, err.task);
          logEntry.applied_ok = true;
          observations.push({ type: "task_awaiting_read", source: spaceRef, task, player: err.player });
        } else {
          const error = normalizeError(err);
          logEntry.applied_ok = false;
          logEntry.error = error;
          observations.length = 0;
          observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
        }
      }

      logEntry.observations = cloneValue(observations as unknown as WooValue) as unknown as Observation[];
      const frame = { op: "applied" as const, id, space: spaceRef, seq, ts: logEntry.ts, message, observations };
      this.persist(true);
      return frame;
    });
  }

  private applyCallRepository(repo: ObjectRepository, id: string | undefined, spaceRef: ObjRef, message: Message): AppliedFrame {
    const before = this.snapshotBehaviorState();
    const beforeLogs = this.snapshotLogs();
    try {
      let frame!: AppliedFrame;
      repo.transaction(() => {
        this.validateMessage(message);
        const space = this.object(spaceRef);
        this.authorizePresence(message.actor, spaceRef);
        const { seq, ts } = repo.appendLog(spaceRef, message.actor, message);
        this.setPropLocal(spaceRef, "next_seq", seq + 1);

        const logEntry: SpaceLogEntry = {
          space: spaceRef,
          seq,
          ts,
          actor: message.actor,
          message: cloneValue(message) as Message,
          observations: [],
          applied_ok: true
        };
        const log = this.logs.get(spaceRef) ?? [];
        log.push(logEntry);
        this.logs.set(spaceRef, log);

        const observations: Observation[] = [];
        const ctx: CallContext = {
          world: this,
          space: spaceRef,
          seq,
          actor: message.actor,
          player: message.actor,
          caller: "#-1",
          progr: message.actor,
          thisObj: message.target,
          verbName: message.verb,
          definer: message.target,
          message,
          observations,
          observe: (event) => {
            observations.push({ ...event, source: event.source ?? space.id });
          }
        };

        let parked: unknown;
        try {
          repo.savepoint(() => {
            try {
              this.withBehaviorSavepoint(() => {
                this.dispatch(ctx, message.target, message.verb, message.args);
              });
            } catch (err) {
              if (isVmSuspendSignal(err) || isVmReadSignal(err)) {
                parked = err;
                return;
              }
              throw err;
            }
          });
          if (isVmSuspendSignal(parked)) {
            const task = this.parkVmContinuation(ctx, parked.seconds, parked.task);
            observations.push({ type: "task_suspended", source: spaceRef, task, resume_at: this.parkedTasks.get(task)?.resume_at ?? null });
          } else if (isVmReadSignal(parked)) {
            const task = this.parkReadContinuation(ctx, parked.player, parked.task);
            observations.push({ type: "task_awaiting_read", source: spaceRef, task, player: parked.player });
          }
          logEntry.applied_ok = true;
          logEntry.observations = cloneValue(observations as unknown as WooValue) as unknown as Observation[];
          repo.recordLogOutcome(spaceRef, seq, true, observations);
        } catch (err) {
          const error = normalizeError(err);
          logEntry.applied_ok = false;
          logEntry.error = error;
          observations.length = 0;
          observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
          logEntry.observations = cloneValue(observations as unknown as WooValue) as unknown as Observation[];
          repo.recordLogOutcome(spaceRef, seq, false, observations, error);
        }

        frame = { op: "applied", id, space: spaceRef, seq, ts: logEntry.ts, message, observations };
      });
      return frame;
    } catch (err) {
      this.restoreBehaviorState(before);
      this.logs = beforeLogs;
      throw err;
    }
  }

  dispatch(ctx: CallContext, target: ObjRef, verbName: string, args: WooValue[], startAt?: ObjRef | null): WooValue {
    if (this.callDepth >= MAX_CALL_DEPTH) throw wooError("E_CALL_DEPTH", "maximum verb call depth exceeded");
    this.callDepth += 1;
    try {
      const { definer, verb } = startAt === undefined ? this.resolveVerb(target, verbName) : this.resolveVerbFrom(startAt, verbName);
      const runCtx: CallContext = {
        ...ctx,
        thisObj: target,
        verbName,
        definer,
        progr: verb.owner,
        player: ctx.player ?? ctx.actor,
        caller: ctx.caller ?? "#-1"
      };
      if (verb.kind === "native") {
        const handler = this.nativeHandlers.get(verb.native);
        if (!handler) throw wooError("E_VERBNF", `native handler not found: ${verb.native}`);
        return handler(runCtx, args);
      }
      return runTinyVm(runCtx, verb.bytecode, args);
    } finally {
      this.callDepth -= 1;
    }
  }

  state(actor?: ObjRef): WorldSnapshot {
    const spaces: WorldSnapshot["spaces"] = {};
    for (const id of Array.from(this.objects.keys()).sort()) {
      if (!this.inheritsFrom(id, "$space")) continue;
      const nextSeq = Number(this.propOrNull(id, "next_seq"));
      if (!Number.isFinite(nextSeq)) continue;
      spaces[id] = { next_seq: nextSeq, log_count: this.logs.get(id)?.length ?? 0 };
    }
    return {
      server_time: Date.now(),
      actorCount: Array.from(this.objects.values()).filter((obj) => this.inheritsFrom(obj.id, "$player")).length,
      spaces,
      catalogs: this.catalogState(),
      object_routes: this.objectRoutes(),
      objects: Object.fromEntries(Array.from(this.objects.keys()).sort().map((id) => [id, this.stateObject(id, actor)]))
    };
  }

  objectRoutes(): Array<{ id: ObjRef; host: string; anchor: ObjRef | null }> {
    const selfHosted = new Set<ObjRef>();
    for (const id of this.objects.keys()) {
      if (this.propOrNull(id, "host_placement") === "self") selfHosted.add(id);
    }
    const hostFor = (id: ObjRef): string | null => {
      if (selfHosted.has(id)) return id;
      const obj = this.object(id);
      if (obj.anchor && selfHosted.has(obj.anchor)) return obj.anchor;
      if (obj.location && selfHosted.has(obj.location)) return obj.location;
      return null;
    };
    return Array.from(this.objects.values())
      .map((obj) => {
        const host = hostFor(obj.id);
        return host ? { id: obj.id, host, anchor: obj.anchor } : null;
      })
      .filter((route): route is { id: ObjRef; host: string; anchor: ObjRef | null } => route !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private catalogState(): { installed: WooValue[] } {
    const installed = this.objects.has("$catalog_registry") ? this.propOrNull("$catalog_registry", "installed_catalogs") : [];
    return { installed: Array.isArray(installed) ? installed : [] };
  }

  private stateObject(id: ObjRef, actor?: ObjRef): Record<string, WooValue> {
    const described = actor ? this.describeForActor(id, actor) : this.describe(id);
    const props: Record<string, WooValue> = {};
    for (const name of this.properties(id)) {
      props[String(name)] = actor ? this.propOrNullForActor(actor, id, String(name)) : this.propOrNull(id, String(name));
    }
    return { ...described, props };
  }

  createRuntimeObject(parent: ObjRef, owner: ObjRef, anchor: ObjRef | null = null): ObjRef {
    this.object(parent);
    this.object(owner);
    if (anchor) this.object(anchor);
    const scope = runtimeObjectScope(anchor ?? parent);
    let id: ObjRef;
    do {
      id = `obj_${scope}_${this.objectCounter++}`;
    } while (this.objects.has(id));
    this.createObject({ id, parent, owner, anchor });
    this.persistCounters();
    return id;
  }

  scheduleFork(ctx: CallContext, seconds: number, target: ObjRef, verbName: string, args: WooValue[]): string {
    if (!Number.isFinite(seconds)) throw wooError("E_TYPE", "fork delay must be numeric", seconds);
    const id = `ptask_${this.parkedTaskCounter++}`;
    this.persistCounters();
    const now = Date.now();
    const task: ParkedTaskRecord = {
      id,
      parked_on: target,
      state: "suspended",
      resume_at: now + Math.max(0, seconds) * 1000,
      awaiting_player: null,
      correlation_id: null,
      created: now,
      origin: ctx.thisObj,
      serialized: {
        kind: "fork",
        space: ctx.space,
        actor: ctx.actor,
        player: ctx.player,
        progr: ctx.progr,
        target,
        verb: verbName,
        args: cloneValue(args as WooValue) as WooValue,
        message: cloneValue(ctx.message as unknown as WooValue)
      }
    };
    this.parkedTasks.set(id, task);
    this.persistTask(task);
    this.persist();
    return id;
  }

  parkVmContinuation(ctx: CallContext, seconds: number, task: SerializedVmTask): string {
    if (!Number.isFinite(seconds)) throw wooError("E_TYPE", "suspend delay must be numeric", seconds);
    const id = `ptask_${this.parkedTaskCounter++}`;
    this.persistCounters();
    const now = Date.now();
    const parked: ParkedTaskRecord = {
      id,
      parked_on: ctx.thisObj,
      state: "suspended",
      resume_at: now + Math.max(0, seconds) * 1000,
      awaiting_player: null,
      correlation_id: null,
      created: now,
      origin: ctx.thisObj,
      serialized: {
        kind: "vm_continuation",
        space: ctx.space,
        actor: ctx.actor,
        player: ctx.player,
        progr: ctx.progr,
        target: ctx.thisObj,
        verb: ctx.verbName,
        task: cloneValue(task as unknown as WooValue)
      }
    };
    this.parkedTasks.set(id, parked);
    this.persistTask(parked);
    this.persist();
    return id;
  }

  parkReadContinuation(ctx: CallContext, player: ObjRef, task: SerializedVmTask): string {
    const id = `ptask_${this.parkedTaskCounter++}`;
    this.persistCounters();
    const now = Date.now();
    const parked: ParkedTaskRecord = {
      id,
      parked_on: ctx.thisObj,
      state: "awaiting_read",
      resume_at: null,
      awaiting_player: player,
      correlation_id: null,
      created: now,
      origin: ctx.thisObj,
      serialized: {
        kind: "vm_continuation",
        space: ctx.space,
        actor: ctx.actor,
        player: ctx.player,
        progr: ctx.progr,
        target: ctx.thisObj,
        verb: ctx.verbName,
        task: cloneValue(task as unknown as WooValue)
      }
    };
    this.parkedTasks.set(id, parked);
    this.persistTask(parked);
    this.persist();
    return id;
  }

  deliverInput(player: ObjRef, input: WooValue): ParkedTaskRun | null {
    const task = Array.from(this.parkedTasks.values())
      .filter((item) => item.state === "awaiting_read" && item.awaiting_player === player)
      .sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))[0];
    if (!task) return null;
    this.parkedTasks.delete(task.id);
    this.deletePersistedTask(task.id);
    const result = this.runParkedTask(task, input);
    this.persist(true);
    return result;
  }

  runDueTasks(now = Date.now()): ParkedTaskRun[] {
    const due = Array.from(this.parkedTasks.values())
      .filter((task) => task.state === "suspended" && task.resume_at !== null && task.resume_at <= now)
      .sort((left, right) => (left.resume_at ?? 0) - (right.resume_at ?? 0) || left.created - right.created || left.id.localeCompare(right.id));
    const results: ParkedTaskRun[] = [];
    for (const task of due) {
      this.parkedTasks.delete(task.id);
      this.deletePersistedTask(task.id);
      results.push(this.runParkedTask(task));
    }
    if (due.length > 0) this.persist(true);
    return results;
  }

  exportWorld(): SerializedWorld {
    return {
      version: 1,
      objectCounter: this.objectCounter,
      parkedTaskCounter: this.parkedTaskCounter,
      sessionCounter: this.sessionCounter,
      objects: Array.from(this.objects.values()).map((obj) => this.serializeObject(obj)),
      sessions: Array.from(this.sessions.values()).map((session) => this.serializeSession(session)),
      logs: Array.from(this.logs.entries()).map(([space, entries]) => [space, cloneValue(entries as unknown as WooValue) as unknown as SpaceLogEntry[]]),
      snapshots: cloneValue(this.snapshots as unknown as WooValue) as unknown as SpaceSnapshotRecord[],
      parkedTasks: Array.from(this.parkedTasks.values()).map((task) => cloneValue(task as unknown as WooValue) as unknown as ParkedTaskRecord)
    };
  }

  exportHostScopedWorld(host: ObjRef): SerializedWorld {
    const scope = this.hostScope(host);
    return {
      version: 1,
      objectCounter: this.objectCounter,
      parkedTaskCounter: this.parkedTaskCounter,
      sessionCounter: this.sessionCounter,
      objects: Array.from(scope.objects)
        .sort()
        .map((id) => this.serializeScopedObject(this.object(id), scope.objects)),
      sessions: [],
      logs: Array.from(this.logs.entries())
        .filter(([space]) => scope.hostedSpaces.has(space))
        .map(([space, entries]) => [space, cloneValue(entries as unknown as WooValue) as unknown as SpaceLogEntry[]]),
      snapshots: (this.snapshots ?? [])
        .filter((snapshot) => scope.hostedSpaces.has(snapshot.space_id))
        .map((snapshot) => cloneValue(snapshot as unknown as WooValue) as unknown as SpaceSnapshotRecord),
      parkedTasks: Array.from(this.parkedTasks.values())
        .filter((task) => this.taskBelongsToHostScope(task, scope.hostedSpaces, scope.objects))
        .map((task) => cloneValue(task as unknown as WooValue) as unknown as ParkedTaskRecord)
    };
  }

  importWorld(serialized: SerializedWorld): void {
    this.withPersistencePaused(() => {
      this.objects.clear();
      this.sessions.clear();
      this.logs.clear();
      this.snapshots = [];
      this.parkedTasks.clear();
      for (const item of serialized.objects) {
        this.objects.set(item.id, {
          id: item.id,
          name: item.name,
          parent: item.parent,
          owner: item.owner,
          location: item.location,
          anchor: item.anchor,
          flags: item.flags ?? {},
          created: item.created,
          modified: item.modified,
          propertyDefs: new Map(item.propertyDefs.map((def) => [def.name, { ...def, defaultValue: cloneValue(def.defaultValue) }])),
          properties: new Map(item.properties.map(([name, value]) => [name, cloneValue(value)])),
          propertyVersions: new Map(item.propertyVersions),
          verbs: new Map(item.verbs.map((verb) => [verb.name, verb])),
          children: new Set(item.children),
          contents: new Set(item.contents),
          eventSchemas: new Map(item.eventSchemas)
        });
      }
      for (const session of serialized.sessions) {
        this.sessions.set(session.id, this.hydrateSession(session, Date.now()));
      }
      for (const [space, entries] of serialized.logs) {
        const hydrated = cloneValue(entries as unknown as WooValue) as unknown as SpaceLogEntry[];
        this.logs.set(space, hydrated.map((entry) => ({ ...entry, observations: entry.observations ?? [] })));
      }
      this.snapshots = serialized.snapshots ?? [];
      for (const task of serialized.parkedTasks ?? []) {
        this.parkedTasks.set(task.id, cloneValue(task as unknown as WooValue) as unknown as ParkedTaskRecord);
      }
      this.objectCounter = serialized.objectCounter ?? serialized.taskCounter ?? 1;
      this.parkedTaskCounter = serialized.parkedTaskCounter ?? 1;
      this.sessionCounter = serialized.sessionCounter;
      this.rebuildGuestPool();
    });
  }

  private serializeObject(obj: WooObject): SerializedObject {
    return {
      id: obj.id,
      name: obj.name,
      parent: obj.parent,
      owner: obj.owner,
      location: obj.location,
      anchor: obj.anchor,
      flags: obj.flags,
      created: obj.created,
      modified: obj.modified,
      propertyDefs: Array.from(obj.propertyDefs.values()).map((def) => ({ ...def, defaultValue: cloneValue(def.defaultValue) })),
      properties: Array.from(obj.properties.entries()).map(([name, value]) => [name, cloneValue(value)]),
      propertyVersions: Array.from(obj.propertyVersions.entries()),
      verbs: Array.from(obj.verbs.values()).map((verb) => cloneValue(verb as unknown as WooValue) as unknown as VerbDef),
      children: Array.from(obj.children),
      contents: Array.from(obj.contents),
      eventSchemas: Array.from(obj.eventSchemas.entries()).map(([type, schema]) => [type, cloneValue(schema as WooValue) as Record<string, WooValue>])
    };
  }

  private serializeScopedObject(obj: WooObject, scope: Set<ObjRef>): SerializedObject {
    const serialized = this.serializeObject(obj);
    serialized.children = serialized.children.filter((id) => scope.has(id));
    serialized.contents = serialized.contents.filter((id) => scope.has(id));
    return serialized;
  }

  private hostScope(host: ObjRef): { objects: Set<ObjRef>; hostedSpaces: Set<ObjRef> } {
    const routes = this.objectRoutes().filter((route) => route.host === host);
    const hosted = new Set(routes.map((route) => route.id));
    const hostedSpaces = new Set<ObjRef>();
    const objects = new Set<ObjRef>();
    const queue: Array<{ id: ObjRef; scanRefs: boolean }> = [];

    const add = (id: ObjRef | null | undefined, scanRefs = true): void => {
      if (!id || !this.objects.has(id) || objects.has(id)) return;
      objects.add(id);
      queue.push({ id, scanRefs });
    };

    const addCatalogSupportFor = (ids: Set<ObjRef>): void => {
      for (const record of this.installedCatalogRecords()) {
        const objectsMap = isPlainValueMap(record.objects) ? record.objects : {};
        const seedsMap = isPlainValueMap(record.seeds) ? record.seeds : {};
        const objectRefs = Object.values(objectsMap).filter((id): id is ObjRef => typeof id === "string");
        const seedRefs = Object.values(seedsMap).filter((id): id is ObjRef => typeof id === "string");
        if (![...objectRefs, ...seedRefs].some((id) => ids.has(id))) continue;
        for (const id of objectRefs) add(id);
      }
    };

    for (const id of hosted) {
      add(id);
      if (this.objects.has(id) && this.inheritsFrom(id, "$space")) hostedSpaces.add(id);
    }
    addCatalogSupportFor(hosted);

    for (let i = 0; i < queue.length; i++) {
      const { id, scanRefs } = queue[i];
      const obj = this.object(id);
      add(obj.parent);
      add(obj.owner, false);
      if (hosted.has(id)) {
        add(obj.anchor);
        add(obj.location);
      }
      if (this.canCarryFeaturesIfKnown(id)) {
        const rawFeatures = obj.properties.get("features");
        if (Array.isArray(rawFeatures)) {
          for (const feature of rawFeatures) if (typeof feature === "string") add(feature);
        }
      }
      if (hostedSpaces.has(id)) {
        const rawSubscribers = obj.properties.get("subscribers");
        if (Array.isArray(rawSubscribers)) {
          for (const actor of rawSubscribers) if (typeof actor === "string") add(actor, false);
        }
      }
      if (scanRefs) this.scanObjectRefs(obj, add);
    }

    return { objects, hostedSpaces };
  }

  private canCarryFeaturesIfKnown(objRef: ObjRef): boolean {
    try {
      return this.canCarryFeatures(objRef);
    } catch {
      return false;
    }
  }

  private scanObjectRefs(obj: WooObject, add: (id: ObjRef | null | undefined, scanRefs?: boolean) => void): void {
    for (const value of obj.properties.values()) this.scanValueRefs(value, add);
    for (const def of obj.propertyDefs.values()) this.scanValueRefs(def.defaultValue, add);
    for (const [, schema] of obj.eventSchemas) this.scanValueRefs(schema as WooValue, add);
    for (const verb of obj.verbs.values()) {
      this.scanValueRefs(verb.arg_spec as WooValue, add);
      if (verb.kind === "bytecode") this.scanValueRefs(verb.bytecode.literals as WooValue, add);
    }
  }

  private scanValueRefs(value: WooValue, add: (id: ObjRef | null | undefined, scanRefs?: boolean) => void): void {
    if (typeof value === "string") {
      if (this.objects.has(value)) add(value);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) this.scanValueRefs(item, add);
      return;
    }
    for (const item of Object.values(value)) this.scanValueRefs(item, add);
  }

  private installedCatalogRecords(): Array<Record<string, WooValue>> {
    if (!this.objects.has("$catalog_registry")) return [];
    const raw = this.propOrNull("$catalog_registry", "installed_catalogs");
    if (!Array.isArray(raw)) return [];
    return raw.filter(isPlainValueMap);
  }

  private taskBelongsToHostScope(task: ParkedTaskRecord, hostedSpaces: Set<ObjRef>, objects: Set<ObjRef>): boolean {
    if (objects.has(task.parked_on)) return true;
    const serialized = task.serialized;
    if (serialized && typeof serialized === "object" && !Array.isArray(serialized)) {
      const raw = serialized as Record<string, WooValue>;
      if (typeof raw.space === "string" && hostedSpaces.has(raw.space)) return true;
      if (typeof raw.target === "string" && objects.has(raw.target)) return true;
      if (typeof raw.origin === "string" && objects.has(raw.origin)) return true;
    }
    return false;
  }

  private serializeSession(session: Session): SerializedSession {
    return {
      id: session.id,
      actor: session.actor,
      started: session.started,
      expiresAt: session.expiresAt,
      lastDetachAt: session.lastDetachAt,
      tokenClass: session.tokenClass
    };
  }

  saveSnapshot(space: ObjRef): SpaceSnapshotRecord {
    const seq = Number(this.getProp(space, "next_seq")) - 1;
    const state = this.materializedSpaceState(space);
    const snapshot: SpaceSnapshotRecord = {
      space_id: space,
      seq,
      ts: Date.now(),
      state,
      hash: hashCanonical(state)
    };
    this.snapshots = this.snapshots.filter((item) => !(item.space_id === space && item.seq === seq));
    this.snapshots.push(snapshot);
    this.setProp(space, "last_snapshot_seq", seq);
    this.repository?.saveSpaceSnapshot?.(snapshot);
    this.persist();
    return snapshot;
  }

  latestSnapshot(space: ObjRef): SpaceSnapshotRecord | null {
    return this.repository?.latestSpaceSnapshot?.(space) ?? this.snapshots.filter((snapshot) => snapshot.space_id === space).sort((a, b) => b.seq - a.seq)[0] ?? null;
  }

  withPersistencePaused<T>(fn: () => T): T {
    this.persistencePaused += 1;
    try {
      return fn();
    } finally {
      this.persistencePaused -= 1;
    }
  }

  withPersistenceDeferred<T>(fn: () => T): T {
    this.persistenceDeferred += 1;
    try {
      return fn();
    } finally {
      this.persistenceDeferred -= 1;
      if (this.persistenceDeferred === 0 && this.persistencePaused === 0 && this.persistenceDirty) this.persist(true);
    }
  }

  persist(force = false): void {
    if (!this.repository) return;
    if (this.activeObjectRepository()) {
      if (!force && this.persistencePaused > 0) {
        this.persistenceDirty = true;
        return;
      }
      if (force) this.flushIncrementalState();
      this.persistenceDirty = false;
      return;
    }
    if (!force && (this.persistencePaused > 0 || this.persistenceDeferred > 0)) {
      this.persistenceDirty = true;
      return;
    }
    this.repository.save(this.exportWorld());
    this.persistenceDirty = false;
  }

  private activeObjectRepository(): ObjectRepository | null {
    return this.incrementalPersistenceEnabled ? this.objectRepository : null;
  }

  private persistObject(objRef: ObjRef): void {
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0) {
      this.persistenceDirty = true;
      return;
    }
    const obj = this.objects.get(objRef);
    if (obj) repo.saveObject(this.serializeObject(obj));
  }

  private persistSession(session: Session): void {
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0) {
      this.persistenceDirty = true;
      return;
    }
    repo.saveSession(this.serializeSession(session));
  }

  private deletePersistedSession(sessionId: string): void {
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0) {
      this.persistenceDirty = true;
      return;
    }
    repo.deleteSession(sessionId);
  }

  private persistTask(task: ParkedTaskRecord): void {
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0) {
      this.persistenceDirty = true;
      return;
    }
    repo.saveTask(task);
  }

  private persistCounters(): void {
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0) {
      this.persistenceDirty = true;
      return;
    }
    repo.saveMeta("objectCounter", String(this.objectCounter));
    repo.saveMeta("parkedTaskCounter", String(this.parkedTaskCounter));
    repo.saveMeta("sessionCounter", String(this.sessionCounter));
  }

  private deletePersistedTask(taskId: string): void {
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0) {
      this.persistenceDirty = true;
      return;
    }
    repo.deleteTask(taskId);
  }

  private flushIncrementalState(): void {
    const repo = this.activeObjectRepository();
    if (!repo) return;
    repo.transaction(() => {
      for (const obj of this.objects.values()) repo.saveObject(this.serializeObject(obj));
      for (const session of this.sessions.values()) repo.saveSession(this.serializeSession(session));
      for (const task of this.parkedTasks.values()) repo.saveTask(task);
      for (const snapshot of this.snapshots) repo.saveSpaceSnapshot(snapshot);
      repo.saveMeta("version", "1");
      repo.saveMeta("objectCounter", String(this.objectCounter));
      repo.saveMeta("parkedTaskCounter", String(this.parkedTaskCounter));
      repo.saveMeta("sessionCounter", String(this.sessionCounter));
    });
  }

  rebuildGuestPool(): void {
    this.guestFreePool.clear();
    const sessions = Array.from(this.sessions.values());
    for (const obj of this.objects.values()) {
      if (obj.id.startsWith("guest_") && obj.parent === "$player" && this.objects.has("$guest")) {
        this.object("$player").children.delete(obj.id);
        obj.parent = "$guest";
        this.object("$guest").children.add(obj.id);
        if (!obj.properties.has("home") && this.objects.has("$nowhere")) {
          obj.properties.set("home", "$nowhere");
          obj.propertyVersions.set("home", (obj.propertyVersions.get("home") ?? 0) + 1);
        }
      }
      if (!obj.id.startsWith("guest_")) continue;
      if (!this.inheritsFrom(obj.id, "$guest")) continue;
      const bound = sessions.some((session) => session.actor === obj.id);
      if (!bound) this.guestFreePool.add(obj.id);
    }
  }

  reapExpiredSessions(now = Date.now()): string[] {
    const reaped: string[] = [];
    if (this.activeObjectRepository()) {
      for (const session of Array.from(this.sessions.values())) {
        if (!this.sessionExpired(session, now)) continue;
        this.reapSession(session.id);
        reaped.push(session.id);
      }
      return reaped;
    }
    this.withPersistencePaused(() => {
      for (const session of Array.from(this.sessions.values())) {
        if (!this.sessionExpired(session, now)) continue;
        this.reapSession(session.id);
        reaped.push(session.id);
      }
    });
    if (reaped.length > 0) this.persist(true);
    return reaped;
  }

  private validateMessage(message: Message): void {
    if (!message || typeof message !== "object") throw wooError("E_INVARG", "message must be a map");
    assertObj(message.actor);
    assertObj(message.target);
    assertString(message.verb);
    if (!Array.isArray(message.args)) throw wooError("E_INVARG", "message.args must be a list");
  }

  private hydrateSession(
    session: { id: string; actor: ObjRef; started: number; expiresAt?: number; lastDetachAt?: number | null; tokenClass?: Session["tokenClass"] },
    now: number
  ): Session {
    const tokenClass = session.tokenClass ?? (this.inheritsFrom(session.actor, "$guest") ? "guest" : "bearer");
    const lastDetachAt = session.lastDetachAt ?? now;
    const expiresAt = Math.max(
      session.expiresAt ?? session.started + this.sessionTtl(tokenClass),
      lastDetachAt + this.sessionGrace(tokenClass)
    );
    return {
      id: session.id,
      actor: session.actor,
      started: session.started,
      expiresAt,
      lastDetachAt,
      tokenClass,
      attachedSockets: new Set()
    };
  }

  private tokenClassFor(token: string): Session["tokenClass"] {
    if (token.startsWith("bearer:")) return "bearer";
    if (token.startsWith("apikey:")) return "apikey";
    return "guest";
  }

  private sessionTtl(tokenClass: Session["tokenClass"]): number {
    return tokenClass === "guest" ? GUEST_SESSION_TTL_MS : CREDENTIAL_SESSION_TTL_MS;
  }

  private sessionGrace(tokenClass: Session["tokenClass"]): number {
    return tokenClass === "guest" ? GUEST_SESSION_GRACE_MS : CREDENTIAL_SESSION_GRACE_MS;
  }

  private sessionExpired(session: Session, now: number): boolean {
    if (session.attachedSockets.size > 0) return false;
    if (now >= session.expiresAt) return true;
    if (session.lastDetachAt === null) return false;
    return now >= session.lastDetachAt + this.sessionGrace(session.tokenClass);
  }

  private reapSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.attachedSockets.clear();
    this.killReadTasksFor(session.actor);
    this.removeActorPresence(session.actor);
    try {
      const observations: Observation[] = [];
      const message: Message = { actor: session.actor, target: session.actor, verb: "on_disfunc", args: [] };
      const ctx: CallContext = {
        world: this,
        space: "#-1",
        seq: -1,
        actor: session.actor,
        player: session.actor,
        caller: "#-1",
        progr: this.object(session.actor).owner,
        thisObj: session.actor,
        verbName: "on_disfunc",
        definer: session.actor,
        message,
        observations,
        observe: () => {
          // Session reap is host maintenance; disfunc observations are not broadcast.
        }
      };
      this.dispatch(ctx, session.actor, "on_disfunc", []);
    } catch {
      if (this.inheritsFrom(session.actor, "$guest")) this.returnGuest(session.actor);
    }
    this.setProp(session.actor, "session_id", null);
    this.sessions.delete(sessionId);
    this.deletePersistedSession(sessionId);
    if (this.inheritsFrom(session.actor, "$guest")) this.returnGuest(session.actor);
  }

  private killReadTasksFor(actor: ObjRef): void {
    for (const [id, task] of Array.from(this.parkedTasks.entries())) {
      if (task.state === "awaiting_read" && task.awaiting_player === actor) {
        this.parkedTasks.delete(id);
        this.deletePersistedTask(id);
      }
    }
  }

  private removeActorPresence(actor: ObjRef): void {
    const presence = this.propOrNull(actor, "presence_in");
    if (Array.isArray(presence)) {
      for (const space of presence) {
        if (typeof space === "string" && this.objects.has(space)) this.updatePresence(actor, space, false);
      }
    }
    const remaining = this.propOrNull(actor, "presence_in");
    if (this.objects.has(actor) && Array.isArray(remaining) && remaining.length > 0) this.setProp(actor, "presence_in", []);
  }

  private moveObject(objRef: ObjRef, targetRef: ObjRef): void {
    const obj = this.object(objRef);
    this.object(targetRef);
    const oldLocation = obj.location;
    if (oldLocation && this.objects.has(oldLocation)) this.object(oldLocation).contents.delete(objRef);
    obj.location = targetRef;
    this.object(targetRef).contents.add(objRef);
    obj.modified = Date.now();
    this.persistObject(objRef);
    if (oldLocation) this.persistObject(oldLocation);
    this.persistObject(targetRef);
  }

  private returnGuest(actor: ObjRef): void {
    if (!this.inheritsFrom(actor, "$guest")) return;
    if (Array.from(this.sessions.values()).some((session) => session.actor === actor)) return;
    this.guestFreePool.add(actor);
  }

  private collectVerbNames(startRef: ObjRef | null, names: Set<string>): void {
    let current: ObjRef | null = startRef;
    while (current) {
      const obj = this.object(current);
      for (const name of obj.verbs.keys()) names.add(name);
      current = obj.parent;
    }
  }

  private collectSchemaNames(startRef: ObjRef | null, names: Set<string>): void {
    let current: ObjRef | null = startRef;
    while (current) {
      const obj = this.object(current);
      for (const name of obj.eventSchemas.keys()) names.add(name);
      current = obj.parent;
    }
  }

  private authorizePresence(actor: ObjRef, space: ObjRef): void {
    if (this.isWizard(actor)) return;
    if (!this.hasPresence(actor, space)) {
      throw wooError("E_PERM", `${actor} is not present in ${space}`);
    }
  }

  private featureList(objRef: ObjRef): ObjRef[] {
    const value = this.getProp(objRef, "features");
    if (!Array.isArray(value)) throw wooError("E_TYPE", "features must be a list", value);
    return value.map((item) => assertObj(item));
  }

  private canCarryFeatures(objRef: ObjRef): boolean {
    return this.inheritsFrom(objRef, "$actor") || this.inheritsFrom(objRef, "$space");
  }

  private assertFeatureConsumer(objRef: ObjRef): void {
    if (!this.canCarryFeatures(objRef)) throw wooError("E_NOTAPPLICABLE", `${objRef} cannot carry features`, objRef);
  }

  private isWizard(actor: ObjRef): boolean {
    return Boolean(this.object(actor).flags.wizard);
  }

  recordWizardAction(actor: ObjRef, action: string, details: Record<string, WooValue>): void {
    const raw = this.propOrNull("$system", "wizard_actions");
    const actions = Array.isArray(raw) ? raw : [];
    this.setProp("$system", "wizard_actions", [...actions, { ts: Date.now(), actor, action, ...details }]);
  }

  private bumpFeaturesVersion(objRef: ObjRef): void {
    const current = Number(this.getProp(objRef, "features_version") ?? 0);
    this.setProp(objRef, "features_version", Number.isFinite(current) ? current + 1 : 1);
  }

  private canFeatureBeAttachedBy(feature: ObjRef, actor: ObjRef): boolean {
    const message: Message = { actor, target: feature, verb: "can_be_attached_by", args: [actor] };
    const observations: Observation[] = [];
    const ctx: CallContext = {
      world: this,
      space: "#-1",
      seq: -1,
      actor,
      player: actor,
      caller: "#-1",
      progr: actor,
      thisObj: feature,
      verbName: "can_be_attached_by",
      definer: feature,
      message,
      observations,
      observe: () => {
        // Attachment-policy checks are predicates; observations are ignored.
      }
    };
    try {
      return Boolean(this.dispatch(ctx, feature, "can_be_attached_by", [actor]));
    } catch (err) {
      const error = normalizeError(err);
      if (error.code === "E_VERBNF") return actor === this.object(feature).owner;
      throw err;
    }
  }

  private addFeature(consumer: ObjRef, feature: ObjRef, actor: ObjRef, observations?: Observation[]): boolean {
    this.assertFeatureConsumer(consumer);
    if (feature.startsWith("~")) throw wooError("E_INVARG", "transient objects cannot be features", feature);
    this.object(feature);
    if (consumer === feature) throw wooError("E_RECMOVE", "object cannot add itself as a feature", feature);
    const consumerOwner = this.object(consumer).owner;
    const wizard = this.isWizard(actor);
    if (!wizard && consumerOwner !== actor) throw wooError("E_PERM", `${actor} cannot add features to ${consumer}`);
    if (!wizard && !this.canFeatureBeAttachedBy(feature, actor)) throw wooError("E_PERM", `${feature} cannot be attached by ${actor}`);
    const features = this.featureList(consumer);
    if (features.includes(feature)) {
      observations?.push({ type: "feature_already_added", source: consumer, feature });
      return false;
    }
    this.setProp(consumer, "features", [...features, feature]);
    this.bumpFeaturesVersion(consumer);
    observations?.push({ type: "feature_added", source: consumer, feature });
    return true;
  }

  private removeFeature(consumer: ObjRef, feature: ObjRef, actor: ObjRef, observations?: Observation[]): boolean {
    this.assertFeatureConsumer(consumer);
    this.object(feature);
    const consumerOwner = this.object(consumer).owner;
    if (!this.isWizard(actor) && consumerOwner !== actor) throw wooError("E_PERM", `${actor} cannot remove features from ${consumer}`);
    const features = this.featureList(consumer);
    if (!features.includes(feature)) return false;
    this.setProp(consumer, "features", features.filter((item) => item !== feature));
    this.bumpFeaturesVersion(consumer);
    observations?.push({ type: "feature_removed", source: consumer, feature });
    return true;
  }

  private directAudience(target: ObjRef): ObjRef | null {
    const obj = this.object(target);
    if (this.inheritsFrom(target, "$space")) return target;
    if (obj.anchor && this.inheritsFrom(obj.anchor, "$space")) return obj.anchor;
    if (obj.location && this.inheritsFrom(obj.location, "$space")) return obj.location;
    return null;
  }

  private inheritsFrom(objRef: ObjRef, ancestorRef: ObjRef): boolean {
    let current: ObjRef | null = objRef;
    while (current) {
      if (current === ancestorRef) return true;
      current = this.object(current).parent;
    }
    return false;
  }

  private ensurePresence(actor: ObjRef, space: ObjRef): void {
    this.updatePresence(actor, space, true);
  }

  private ensureAutoPresence(actor: ObjRef): void {
    for (const obj of this.objects.values()) {
      if (!this.inheritsFrom(obj.id, "$space")) continue;
      if (this.propOrNull(obj.id, "auto_presence") === true) this.ensurePresence(actor, obj.id);
    }
  }

  private removePresence(actor: ObjRef, space: ObjRef): boolean {
    return this.updatePresence(actor, space, false);
  }

  private updatePresence(actor: ObjRef, space: ObjRef, present: boolean): boolean {
    this.object(actor);
    this.object(space);
    const rawPresence = this.getProp(actor, "presence_in");
    const rawSubscribers = this.getProp(space, "subscribers");
    if (!Array.isArray(rawPresence)) throw wooError("E_TYPE", `${actor}.presence_in must be a list`, rawPresence);
    if (!Array.isArray(rawSubscribers)) throw wooError("E_TYPE", `${space}.subscribers must be a list`, rawSubscribers);

    const presence = rawPresence.filter((item): item is ObjRef => typeof item === "string");
    const subscribers = rawSubscribers.filter((item): item is ObjRef => typeof item === "string");
    const nextPresence = present ? addUnique(presence, space) : presence.filter((item) => item !== space);
    const nextSubscribers = present ? addUnique(subscribers, actor) : subscribers.filter((item) => item !== actor);
    const changed = !valuesEqual(nextPresence, rawPresence) || !valuesEqual(nextSubscribers, rawSubscribers);
    if (!changed) return false;

    this.withPersistenceDeferred(() => {
      this.setProp(actor, "presence_in", nextPresence);
      this.setProp(space, "subscribers", nextSubscribers);
    });
    this.assertPresenceMirror(actor, space, present);
    return true;
  }

  private assertPresenceMirror(actor: ObjRef, space: ObjRef, expected: boolean): void {
    const presence = this.getProp(actor, "presence_in");
    const subscribers = this.getProp(space, "subscribers");
    const actorHasSpace = Array.isArray(presence) && presence.includes(space);
    const spaceHasActor = Array.isArray(subscribers) && subscribers.includes(actor);
    if (actorHasSpace !== spaceHasActor || actorHasSpace !== expected) {
      throw wooError("E_INTERNAL", "presence mirror invariant failed", { actor, space, actor_has_space: actorHasSpace, space_has_actor: spaceHasActor });
    }
  }

  private runParkedTask(task: ParkedTaskRecord, input?: WooValue): ParkedTaskRun {
    try {
      const serialized = assertMap(task.serialized);
      if (serialized.kind === "vm_continuation") return this.runParkedVmContinuation(task, serialized, input);
      if (serialized.kind !== "fork") throw wooError("E_INVARG", "unsupported parked task kind", serialized.kind);
      const actor = assertObj(serialized.actor);
      const player = assertObj(serialized.player);
      const progr = assertObj(serialized.progr);
      const target = assertObj(serialized.target);
      const verbName = assertString(serialized.verb);
      const args = Array.isArray(serialized.args) ? (cloneValue(serialized.args) as WooValue[]) : [];
      const rawSpace = serialized.space;
      if (typeof rawSpace === "string" && rawSpace !== "#-1") {
        const message: Message = { actor, target, verb: verbName, args };
        const frame = this.applyCall(undefined, rawSpace, message);
        return { task, frame, observations: frame.observations };
      }
      const message =
        serialized.message && typeof serialized.message === "object" && !Array.isArray(serialized.message)
          ? (cloneValue(serialized.message as WooValue) as unknown as Message)
          : { actor, target, verb: verbName, args };
      const observations: Observation[] = [];
      const hostSpace = "#-1";
      const ctx: CallContext = {
        world: this,
        space: hostSpace,
        seq: -1,
        actor,
        player,
        caller: "#-1",
        progr,
        thisObj: target,
        verbName,
        definer: target,
        message,
        observations,
        observe: (event) => {
          observations.push({ ...event, source: event.source ?? hostSpace });
        }
      };

      let error: ErrorValue | undefined;
      this.withPersistencePaused(() => {
        const before = this.snapshotProps();
        const beforeParkedTasks = new Map(this.parkedTasks);
        const beforeParkedTaskCounter = this.parkedTaskCounter;
        try {
          this.dispatch(ctx, target, verbName, args);
        } catch (err) {
          if (isVmSuspendSignal(err)) {
            const resumedTask = this.parkVmContinuation(ctx, err.seconds, err.task);
            observations.push({ type: "task_suspended", source: hostSpace, task: resumedTask, resume_at: this.parkedTasks.get(resumedTask)?.resume_at ?? null });
            return;
          }
          if (isVmReadSignal(err)) {
            const resumedTask = this.parkReadContinuation(ctx, err.player, err.task);
            observations.push({ type: "task_awaiting_read", source: hostSpace, task: resumedTask, player: err.player });
            return;
          }
          this.restoreProps(before);
          this.parkedTasks = new Map(beforeParkedTasks);
          this.parkedTaskCounter = beforeParkedTaskCounter;
          error = normalizeError(err);
          observations.length = 0;
          observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
        }
      });
      return { task, observations, error };
    } catch (err) {
      const error = normalizeError(err);
      return { task, observations: [{ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] }], error };
    }
  }

  private runParkedVmContinuation(task: ParkedTaskRecord, serialized: Record<string, WooValue>, input?: WooValue): ParkedTaskRun {
    const rawSpace = serialized.space;
    if (typeof rawSpace === "string" && rawSpace !== "#-1") {
      const frame = this.applyResumeFrame(task, serialized, rawSpace, input);
      return { task, frame, observations: frame.observations };
    }

    const observations: Observation[] = [];
    let error: ErrorValue | undefined;
    this.withPersistencePaused(() => {
      const before = this.snapshotProps();
      const beforeParkedTasks = new Map(this.parkedTasks);
      const beforeParkedTaskCounter = this.parkedTaskCounter;
      try {
        if (input === undefined) runSerializedTinyVmTask(this, serialized.task as unknown as SerializedVmTask, observations);
        else runSerializedTinyVmTaskWithInput(this, serialized.task as unknown as SerializedVmTask, input, observations);
      } catch (err) {
        if (isVmSuspendSignal(err)) {
          const resumedTask = this.parkVmContinuation(this.hostContinuationContext(serialized, observations), err.seconds, err.task);
          observations.push({ type: "task_suspended", source: "#-1", task: resumedTask, resume_at: this.parkedTasks.get(resumedTask)?.resume_at ?? null });
          return;
        }
        if (isVmReadSignal(err)) {
          const resumedTask = this.parkReadContinuation(this.hostContinuationContext(serialized, observations), err.player, err.task);
          observations.push({ type: "task_awaiting_read", source: "#-1", task: resumedTask, player: err.player });
          return;
        }
        this.restoreProps(before);
        this.parkedTasks = new Map(beforeParkedTasks);
        this.parkedTaskCounter = beforeParkedTaskCounter;
        error = normalizeError(err);
        observations.length = 0;
        observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
      }
    });
    return { task, observations, error };
  }

  private applyResumeFrame(task: ParkedTaskRecord, serialized: Record<string, WooValue>, spaceRef: ObjRef, input?: WooValue): AppliedFrame {
    const repo = this.activeObjectRepository();
    if (repo) return this.applyResumeFrameRepository(repo, task, serialized, spaceRef, input);
    return this.withPersistencePaused(() => {
      const actor = assertObj(serialized.actor);
      this.authorizePresence(actor, spaceRef);
      const space = this.object(spaceRef);
      const nextSeq = Number(this.getProp(spaceRef, "next_seq"));
      const seq = nextSeq;
      this.setProp(spaceRef, "next_seq", nextSeq + 1);

      const body: Record<string, WooValue> = {
        kind: input === undefined ? "vm_resume" : "vm_read",
        task: task.id,
        continuation: cloneValue(serialized.task as WooValue)
      };
      if (input !== undefined) body.input = cloneValue(input);
      const message: Message = {
        actor,
        target: spaceRef,
        verb: "$resume",
        args: [task.id],
        body
      };
      const logEntry: SpaceLogEntry = {
        space: spaceRef,
        seq,
        ts: Date.now(),
        actor,
        message: cloneValue(message) as Message,
        observations: [],
        applied_ok: true
      };
      const log = this.logs.get(spaceRef) ?? [];
      log.push(logEntry);
      this.logs.set(spaceRef, log);

      const observations: Observation[] = [{ type: "task_resumed", source: spaceRef, task: task.id }];
      try {
        this.withBehaviorSavepoint(() => {
          if (input === undefined) runSerializedTinyVmTask(this, serialized.task as unknown as SerializedVmTask, observations);
          else runSerializedTinyVmTaskWithInput(this, serialized.task as unknown as SerializedVmTask, input, observations);
        });
      } catch (err) {
        if (isVmSuspendSignal(err)) {
          const resumedTask = this.parkVmContinuation(this.resumeContext(serialized, message, observations, spaceRef, seq), err.seconds, err.task);
          observations.push({ type: "task_suspended", source: spaceRef, task: resumedTask, resume_at: this.parkedTasks.get(resumedTask)?.resume_at ?? null });
        } else if (isVmReadSignal(err)) {
          const resumedTask = this.parkReadContinuation(this.resumeContext(serialized, message, observations, spaceRef, seq), err.player, err.task);
          observations.push({ type: "task_awaiting_read", source: spaceRef, task: resumedTask, player: err.player });
        } else {
          const error = normalizeError(err);
          logEntry.applied_ok = false;
          logEntry.error = error;
          observations.length = 0;
          observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
        }
      }

      logEntry.observations = cloneValue(observations as unknown as WooValue) as unknown as Observation[];
      const frame = { op: "applied" as const, space: space.id, seq, ts: logEntry.ts, message, observations };
      this.persist(true);
      return frame;
    });
  }

  private applyResumeFrameRepository(repo: ObjectRepository, task: ParkedTaskRecord, serialized: Record<string, WooValue>, spaceRef: ObjRef, input?: WooValue): AppliedFrame {
    const before = this.snapshotBehaviorState();
    const beforeLogs = this.snapshotLogs();
    try {
      let frame!: AppliedFrame;
      repo.transaction(() => {
        const actor = assertObj(serialized.actor);
        this.authorizePresence(actor, spaceRef);
        const space = this.object(spaceRef);
        const body: Record<string, WooValue> = {
          kind: input === undefined ? "vm_resume" : "vm_read",
          task: task.id,
          continuation: cloneValue(serialized.task as WooValue)
        };
        if (input !== undefined) body.input = cloneValue(input);
        const message: Message = {
          actor,
          target: spaceRef,
          verb: "$resume",
          args: [task.id],
          body
        };
        const { seq, ts } = repo.appendLog(spaceRef, actor, message);
        this.setPropLocal(spaceRef, "next_seq", seq + 1);
        const logEntry: SpaceLogEntry = {
          space: spaceRef,
          seq,
          ts,
          actor,
          message: cloneValue(message) as Message,
          observations: [],
          applied_ok: true
        };
        const log = this.logs.get(spaceRef) ?? [];
        log.push(logEntry);
        this.logs.set(spaceRef, log);

        const observations: Observation[] = [{ type: "task_resumed", source: spaceRef, task: task.id }];
        let parked: unknown;
        try {
          repo.savepoint(() => {
            try {
              this.withBehaviorSavepoint(() => {
                if (input === undefined) runSerializedTinyVmTask(this, serialized.task as unknown as SerializedVmTask, observations);
                else runSerializedTinyVmTaskWithInput(this, serialized.task as unknown as SerializedVmTask, input, observations);
              });
            } catch (err) {
              if (isVmSuspendSignal(err) || isVmReadSignal(err)) {
                parked = err;
                return;
              }
              throw err;
            }
          });
          if (isVmSuspendSignal(parked)) {
            const resumedTask = this.parkVmContinuation(this.resumeContext(serialized, message, observations, spaceRef, seq), parked.seconds, parked.task);
            observations.push({ type: "task_suspended", source: spaceRef, task: resumedTask, resume_at: this.parkedTasks.get(resumedTask)?.resume_at ?? null });
          } else if (isVmReadSignal(parked)) {
            const resumedTask = this.parkReadContinuation(this.resumeContext(serialized, message, observations, spaceRef, seq), parked.player, parked.task);
            observations.push({ type: "task_awaiting_read", source: spaceRef, task: resumedTask, player: parked.player });
          }
          logEntry.applied_ok = true;
          logEntry.observations = cloneValue(observations as unknown as WooValue) as unknown as Observation[];
          repo.recordLogOutcome(spaceRef, seq, true, observations);
        } catch (err) {
          const error = normalizeError(err);
          logEntry.applied_ok = false;
          logEntry.error = error;
          observations.length = 0;
          observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
          logEntry.observations = cloneValue(observations as unknown as WooValue) as unknown as Observation[];
          repo.recordLogOutcome(spaceRef, seq, false, observations, error);
        }

        frame = { op: "applied", space: space.id, seq, ts: logEntry.ts, message, observations };
      });
      return frame;
    } catch (err) {
      this.restoreBehaviorState(before);
      this.logs = beforeLogs;
      throw err;
    }
  }

  private resumeContext(serialized: Record<string, WooValue>, message: Message, observations: Observation[], space: ObjRef, seq: number): CallContext {
    return {
      world: this,
      space,
      seq,
      actor: assertObj(serialized.actor),
      player: assertObj(serialized.player),
      caller: "#-1",
      progr: assertObj(serialized.progr),
      thisObj: typeof serialized.target === "string" ? serialized.target : space,
      verbName: typeof serialized.verb === "string" ? serialized.verb : "$resume",
      definer: typeof serialized.target === "string" ? serialized.target : space,
      message,
      observations,
      observe: (event) => {
        observations.push({ ...event, source: event.source ?? space });
      }
    };
  }

  private hostContinuationContext(serialized: Record<string, WooValue>, observations: Observation[]): CallContext {
    const target = typeof serialized.target === "string" ? serialized.target : "#-1";
    const message: Message = { actor: assertObj(serialized.actor), target, verb: typeof serialized.verb === "string" ? serialized.verb : "$resume", args: [] };
    return this.resumeContext(serialized, message, observations, "#-1", -1);
  }

  private allocateGuest(): ObjRef {
    if (this.guestFreePool.size === 0) this.rebuildGuestPool();
    const pooled = Array.from(this.guestFreePool).sort()[0];
    if (pooled) {
      this.guestFreePool.delete(pooled);
      return pooled;
    }
    const id = `guest_${this.objects.size}`;
    this.createObject({ id, name: id, parent: this.objects.has("$guest") ? "$guest" : "$player", owner: "$wiz", location: this.objects.has("$nowhere") ? "$nowhere" : null });
    this.setProp(id, "description", "Dynamically allocated guest player. It can be bound to a temporary session and gives a local user or agent a stable actor for first-light testing.");
    this.setProp(id, "presence_in", []);
    this.setProp(id, "session_id", null);
    if (this.objects.has("$nowhere")) this.setProp(id, "home", "$nowhere");
    return id;
  }

  private materializedSpaceState(space: ObjRef): WooValue {
    const ids = Array.from(this.objects.values())
      .filter((obj) => obj.id === space || obj.anchor === space || obj.location === space)
      .map((obj) => obj.id)
      .sort();
    return {
      space,
      seq: Number(this.getProp(space, "next_seq")) - 1,
      objects: Object.fromEntries(ids.map((id) => [id, Object.fromEntries(this.object(id).properties)]))
    };
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

  private propsChanged(snapshot: Map<ObjRef, Map<string, WooValue>>): boolean {
    for (const [id, props] of snapshot) {
      const obj = this.objects.get(id);
      if (!obj || obj.properties.size !== props.size) return true;
      for (const [name, value] of props) {
        if (!obj.properties.has(name) || !valuesEqual(obj.properties.get(name)!, value)) return true;
      }
    }
    return false;
  }

  private withBehaviorSavepoint<T>(fn: () => T): T {
    const savepoint = this.snapshotBehaviorState();
    try {
      return fn();
    } catch (err) {
      if (!isVmSuspendSignal(err) && !isVmReadSignal(err)) this.restoreBehaviorState(savepoint);
      throw err;
    }
  }

  private snapshotBehaviorState(): BehaviorSavepoint {
    return {
      objects: new Map(Array.from(this.objects.entries()).map(([id, obj]) => [id, this.cloneObject(obj)])),
      sessions: new Map(Array.from(this.sessions.entries()).map(([id, session]) => [id, this.cloneSession(session)])),
      snapshots: cloneValue(this.snapshots as unknown as WooValue) as unknown as SpaceSnapshotRecord[],
      parkedTasks: new Map(Array.from(this.parkedTasks.entries()).map(([id, task]) => [id, cloneValue(task as unknown as WooValue) as unknown as ParkedTaskRecord])),
      objectCounter: this.objectCounter,
      parkedTaskCounter: this.parkedTaskCounter,
      sessionCounter: this.sessionCounter,
      guestFreePool: new Set(this.guestFreePool)
    };
  }

  private restoreBehaviorState(savepoint: BehaviorSavepoint): void {
    this.objects = new Map(Array.from(savepoint.objects.entries()).map(([id, obj]) => [id, this.cloneObject(obj)]));
    this.sessions = new Map(Array.from(savepoint.sessions.entries()).map(([id, session]) => [id, this.cloneSession(session)]));
    this.snapshots = cloneValue(savepoint.snapshots as unknown as WooValue) as unknown as SpaceSnapshotRecord[];
    this.parkedTasks = new Map(Array.from(savepoint.parkedTasks.entries()).map(([id, task]) => [id, cloneValue(task as unknown as WooValue) as unknown as ParkedTaskRecord]));
    this.objectCounter = savepoint.objectCounter;
    this.parkedTaskCounter = savepoint.parkedTaskCounter;
    this.sessionCounter = savepoint.sessionCounter;
    this.guestFreePool = new Set(savepoint.guestFreePool);
  }

  private cloneObject(obj: WooObject): WooObject {
    return {
      ...obj,
      flags: { ...obj.flags },
      propertyDefs: new Map(Array.from(obj.propertyDefs.entries()).map(([name, def]) => [name, { ...def, defaultValue: cloneValue(def.defaultValue) }])),
      properties: new Map(Array.from(obj.properties.entries()).map(([name, value]) => [name, cloneValue(value)])),
      propertyVersions: new Map(obj.propertyVersions),
      verbs: new Map(Array.from(obj.verbs.entries()).map(([name, verb]) => [name, cloneValue(verb as unknown as WooValue) as unknown as VerbDef])),
      children: new Set(obj.children),
      contents: new Set(obj.contents),
      eventSchemas: new Map(Array.from(obj.eventSchemas.entries()).map(([type, schema]) => [type, cloneValue(schema as unknown as WooValue) as Record<string, WooValue>]))
    };
  }

  private snapshotLogs(): Map<ObjRef, SpaceLogEntry[]> {
    return new Map(Array.from(this.logs.entries()).map(([space, entries]) => [space, cloneValue(entries as unknown as WooValue) as unknown as SpaceLogEntry[]]));
  }

  private cloneSession(session: Session): Session {
    return {
      ...session,
      attachedSockets: new Set(session.attachedSockets)
    };
  }

  private registerNativeHandlers(): void {
    this.nativeHandlers.set("describe", (ctx) => this.describe(ctx.thisObj));
    this.nativeHandlers.set("player_on_disfunc", () => true);
    this.nativeHandlers.set("player_moveto", (ctx, args) => {
      const target = assertObj(args[0] ?? "$nowhere");
      this.moveObject(ctx.thisObj, target);
      return true;
    });
    this.nativeHandlers.set("guest_on_disfunc", (ctx) => {
      const homeValue = this.propOrNull(ctx.thisObj, "home");
      const home = typeof homeValue === "string" && this.objects.has(homeValue) ? homeValue : "$nowhere";
      this.moveObject(ctx.thisObj, home);
      this.setProp(ctx.thisObj, "description", "");
      this.setProp(ctx.thisObj, "aliases", []);
      this.setProp(ctx.thisObj, "features", []);
      this.setProp(ctx.thisObj, "features_version", Number(this.propOrNull(ctx.thisObj, "features_version") ?? 0) + 1);
      for (const item of Array.from(this.object(ctx.thisObj).contents)) this.moveObject(item, home);
      this.returnGuest(ctx.thisObj);
      return true;
    });
    this.nativeHandlers.set("return_guest", (_ctx, args) => {
      this.returnGuest(assertObj(args[0]));
      return true;
    });
    this.nativeHandlers.set("feature_can_be_attached_by", (ctx, args) => {
      const actor = assertObj(args[0] ?? ctx.actor);
      return actor === this.object(ctx.thisObj).owner;
    });
    this.nativeHandlers.set("add_feature", (ctx, args) => this.addFeature(ctx.thisObj, assertObj(args[0]), ctx.actor, ctx.observations));
    this.nativeHandlers.set("remove_feature", (ctx, args) => this.removeFeature(ctx.thisObj, assertObj(args[0]), ctx.actor, ctx.observations));
    this.nativeHandlers.set("has_feature", (ctx, args) => this.featureList(ctx.thisObj).includes(assertObj(args[0])));
    this.nativeHandlers.set("replay", (ctx, args) => {
      const from = Number(args[0] ?? 1);
      const limit = Number(args[1] ?? 100);
      return this.replay(ctx.thisObj, from, limit).map((entry) => ({
        seq: entry.seq,
        message: entry.message as unknown as WooValue,
        observations: entry.observations as unknown as WooValue,
        applied_ok: entry.applied_ok,
        error: entry.error as unknown as WooValue
      }));
    });
    this.nativeHandlers.set("catalog_registry_install", (ctx, args) => {
      if (!this.object(ctx.actor).flags.wizard) throw wooError("E_PERM", "only wizards may install catalogs", ctx.actor);
      const manifest = assertMap(args[0]) as unknown as CatalogManifest;
      const alias = typeof args[2] === "string" ? args[2] : manifest.name;
      const provenance = args[3] && typeof args[3] === "object" && !Array.isArray(args[3]) ? (args[3] as Record<string, WooValue>) : {};
      return installCatalogManifest(this, manifest, {
        actor: ctx.actor,
        tap: typeof provenance.tap === "string" ? provenance.tap : "@local",
        alias,
        provenance
      }) as unknown as WooValue;
    });
    this.nativeHandlers.set("catalog_registry_list", () => this.propOrNull("$catalog_registry", "installed_catalogs"));
    this.nativeHandlers.set("match_object", (_ctx, args) => {
      const wanted = assertString(args[0] ?? "").toLowerCase();
      const location = typeof args[1] === "string" && this.objects.has(args[1]) ? args[1] : null;
      const candidates = location ? Array.from(this.object(location).contents) : Array.from(this.objects.keys());
      const matches = candidates.filter((id) => {
        const obj = this.object(id);
        const aliases = this.propOrNull(id, "aliases");
        return obj.name.toLowerCase() === wanted || id.toLowerCase() === wanted || (Array.isArray(aliases) && aliases.some((alias) => String(alias).toLowerCase() === wanted));
      });
      if (matches.length === 0) return this.objects.has("$failed_match") ? "$failed_match" : null;
      if (matches.length > 1) return this.objects.has("$ambiguous_match") ? "$ambiguous_match" : matches[0];
      return matches[0];
    });
    this.nativeHandlers.set("match_verb", (_ctx, args) => {
      const name = assertString(args[0] ?? "");
      const target = assertObj(args[1]);
      try {
        this.resolveVerb(target, name);
        return name;
      } catch {
        return this.objects.has("$failed_match") ? "$failed_match" : null;
      }
    });
  }

  private chatPresent(room: ObjRef): WooValue[] {
    const present = this.getProp(room, "subscribers");
    return Array.isArray(present) ? [...present] : [];
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

function addUnique<T>(items: T[], item: T): T[] {
  return items.includes(item) ? items : [...items, item];
}

function runtimeObjectScope(value: ObjRef): string {
  const cleaned = value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "world";
}

function isPlainValueMap(value: WooValue | undefined): value is Record<string, WooValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function hashCanonical(value: WooValue): string {
  const text = canonicalJson(value);
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return `h${Math.abs(hash).toString(16)}`;
}

function canonicalJson(value: WooValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
