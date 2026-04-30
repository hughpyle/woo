import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  LogReadResult,
  ObjectRepository,
  ParkedTaskRecord,
  SerializedObject,
  SerializedProperty,
  SerializedSession,
  SerializedVerb,
  SerializedWorld,
  SpaceSnapshotRecord,
  WorldRepository
} from "../core/repository";
import { wooError, type ErrorValue, type Message, type ObjRef, type Observation, type SpaceLogEntry, type VerbDef, type WooValue } from "../core/types";

type Row = Record<string, any>;

export class LocalSQLiteRepository implements WorldRepository, ObjectRepository {
  private db: DatabaseSync;
  private transactionDepth = 0;
  private savepointCounter = 0;

  constructor(private filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  load(): SerializedWorld | null {
    const objectRows = this.db.prepare("SELECT * FROM object ORDER BY id").all() as Row[];
    if (objectRows.length === 0) return null;

    const propertyDefs = groupBy(this.db.prepare("SELECT * FROM property_def ORDER BY object_id, name").all() as Row[], "object_id");
    const propertyValues = groupBy(this.db.prepare("SELECT * FROM property_value ORDER BY object_id, name").all() as Row[], "object_id");
    const propertyVersions = groupBy(this.db.prepare("SELECT * FROM property_version ORDER BY object_id, name").all() as Row[], "object_id");
    const verbs = groupBy(this.db.prepare("SELECT * FROM verb ORDER BY object_id, name").all() as Row[], "object_id");
    const children = groupBy(this.db.prepare("SELECT * FROM child ORDER BY object_id, child_ref").all() as Row[], "object_id");
    const contents = groupBy(this.db.prepare("SELECT * FROM content ORDER BY object_id, content_ref").all() as Row[], "object_id");
    const eventSchemas = groupBy(this.db.prepare("SELECT * FROM event_schema ORDER BY object_id, type").all() as Row[], "object_id");

    const objects: SerializedObject[] = objectRows.map((row) => ({
      id: row.id,
      name: row.name,
      parent: row.parent,
      owner: row.owner,
      location: row.location,
      anchor: row.anchor,
      flags: flagsFromInt(Number(row.flags)),
      created: Number(row.created),
      modified: Number(row.modified),
      propertyDefs: (propertyDefs.get(row.id) ?? []).map((def) => ({
        name: def.name,
        defaultValue: parseValue(def.default_val),
        typeHint: def.type_hint ?? undefined,
        owner: def.owner,
        perms: def.perms,
        version: Number(def.version)
      })),
      properties: (propertyValues.get(row.id) ?? []).map((value) => [value.name, parseValue(value.value)]),
      propertyVersions: (propertyVersions.get(row.id) ?? []).map((version) => [version.name, Number(version.version)]),
      verbs: (verbs.get(row.id) ?? []).map(verbFromRow),
      children: (children.get(row.id) ?? []).map((child) => child.child_ref),
      contents: (contents.get(row.id) ?? []).map((content) => content.content_ref),
      eventSchemas: (eventSchemas.get(row.id) ?? []).map((schema) => [schema.type, parseValue(schema.schema) as Record<string, WooValue>])
    }));

    const sessions = (this.db.prepare("SELECT * FROM session ORDER BY id").all() as Row[]).map((row) => ({
      id: row.id,
      actor: row.actor,
      started: Number(row.started),
      expiresAt: row.expires_at === null || row.expires_at === undefined ? undefined : Number(row.expires_at),
      lastDetachAt: row.last_detach_at === null || row.last_detach_at === undefined ? null : Number(row.last_detach_at),
      tokenClass: row.token_class as "guest" | "bearer" | "apikey" | undefined
    }));

    const logRows = this.db.prepare("SELECT * FROM space_message ORDER BY space_id, seq").all() as Row[];
    const logs = Array.from(groupBy(logRows, "space_id").entries()).map(([space, entries]) => [
      space,
      entries.map(logEntryFromRow) as SpaceLogEntry[]
    ]) as [ObjRef, SpaceLogEntry[]][];

    const snapshots = (this.db.prepare("SELECT * FROM space_snapshot ORDER BY space_id, seq").all() as Row[]).map(snapshotFromRow);
    const parkedTasks = (this.db.prepare("SELECT * FROM task ORDER BY id").all() as Row[]).map(taskFromRow);
    const meta = Object.fromEntries((this.db.prepare("SELECT key, value FROM world_meta").all() as Row[]).map((row) => [row.key, row.value]));

    return {
      version: 1,
      taskCounter: Number(meta.taskCounter ?? 1),
      parkedTaskCounter: Number(meta.parkedTaskCounter ?? 1),
      sessionCounter: Number(meta.sessionCounter ?? 1),
      objects,
      sessions,
      logs,
      snapshots,
      parkedTasks
    };
  }

  save(world: SerializedWorld): void {
    this.transaction(() => {
      for (const table of [
        "world_meta",
        "task",
        "space_snapshot",
        "space_message",
        "session",
        "event_schema",
        "content",
        "child",
        "verb",
        "property_version",
        "property_value",
        "property_def",
        "object"
      ]) {
        this.db.exec(`DELETE FROM ${table}`);
      }

      const insertMeta = this.db.prepare("INSERT INTO world_meta(key, value) VALUES (?, ?)");
      insertMeta.run("version", String(world.version));
      insertMeta.run("taskCounter", String(world.taskCounter));
      insertMeta.run("parkedTaskCounter", String(world.parkedTaskCounter));
      insertMeta.run("sessionCounter", String(world.sessionCounter));

      const insertObject = this.db.prepare("INSERT INTO object(id, name, parent, owner, location, anchor, flags, created, modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const insertDef = this.db.prepare("INSERT INTO property_def(object_id, name, default_val, type_hint, owner, perms, version) VALUES (?, ?, ?, ?, ?, ?, ?)");
      const insertValue = this.db.prepare("INSERT INTO property_value(object_id, name, value) VALUES (?, ?, ?)");
      const insertVersion = this.db.prepare("INSERT INTO property_version(object_id, name, version) VALUES (?, ?, ?)");
      const insertVerb = this.db.prepare("INSERT INTO verb(object_id, name, kind, aliases, owner, perms, arg_spec, source, source_hash, version, line_map, native, bytecode, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const insertChild = this.db.prepare("INSERT INTO child(object_id, child_ref) VALUES (?, ?)");
      const insertContent = this.db.prepare("INSERT INTO content(object_id, content_ref) VALUES (?, ?)");
      const insertSchema = this.db.prepare("INSERT INTO event_schema(object_id, type, schema) VALUES (?, ?, ?)");

      for (const obj of world.objects) {
        insertObject.run(obj.id, obj.name, obj.parent, obj.owner, obj.location, obj.anchor, flagsToInt(obj.flags), obj.created, obj.modified);
        for (const def of obj.propertyDefs) insertDef.run(obj.id, def.name, stringifyValue(def.defaultValue), def.typeHint ?? null, def.owner, def.perms, def.version);
        for (const [name, value] of obj.properties) insertValue.run(obj.id, name, stringifyValue(value));
        for (const [name, version] of obj.propertyVersions) insertVersion.run(obj.id, name, version);
        for (const verb of obj.verbs) insertVerb.run(obj.id, verb.name, verb.kind, stringifyValue(verb.aliases), verb.owner, verb.perms, stringifyValue(verb.arg_spec), verb.source, verb.source_hash, verb.version, stringifyValue(verb.line_map), verb.kind === "native" ? verb.native : null, verb.kind === "bytecode" ? stringifyValue(verb.bytecode as unknown as WooValue) : null, verbFlagsJson(verb));
        for (const child of obj.children) insertChild.run(obj.id, child);
        for (const content of obj.contents) insertContent.run(obj.id, content);
        for (const [type, schema] of obj.eventSchemas) insertSchema.run(obj.id, type, stringifyValue(schema as WooValue));
      }

      const hasAttachmentColumn = this.tableColumns("session").has("attachment");
      const insertSession = this.db.prepare(
        hasAttachmentColumn
          ? "INSERT INTO session(id, actor, started, expires_at, last_detach_at, token_class, attachment) VALUES (?, ?, ?, ?, ?, ?, ?)"
          : "INSERT INTO session(id, actor, started, expires_at, last_detach_at, token_class) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const session of world.sessions) {
        const values = [session.id, session.actor, session.started, session.expiresAt ?? null, session.lastDetachAt ?? null, session.tokenClass ?? "guest"];
        insertSession.run(...(hasAttachmentColumn ? [...values, "{}"] : values));
      }

      const insertLog = this.db.prepare("INSERT INTO space_message(space_id, seq, ts, actor, message, observations, applied_ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const [space, entries] of world.logs) {
        for (const entry of entries) insertLog.run(space, entry.seq, entry.ts, entry.actor, stringifyValue(entry.message as unknown as WooValue), stringifyValue((entry.observations ?? []) as unknown as WooValue), entry.applied_ok ? 1 : 0, entry.error ? stringifyValue(entry.error as unknown as WooValue) : null);
      }

      const insertSnapshot = this.db.prepare("INSERT INTO space_snapshot(space_id, seq, ts, state, hash) VALUES (?, ?, ?, ?, ?)");
      for (const snapshot of world.snapshots) {
        insertSnapshot.run(snapshot.space_id, snapshot.seq, snapshot.ts, stringifyValue(snapshot.state), snapshot.hash);
      }

      const insertTask = this.db.prepare("INSERT INTO task(id, parked_on, state, resume_at, awaiting_player, correlation_id, serialized, created, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const task of world.parkedTasks) {
        insertTask.run(task.id, task.parked_on, task.state, task.resume_at, task.awaiting_player, task.correlation_id, stringifyValue(task.serialized), task.created, task.origin);
      }
    });
  }

  saveSpaceSnapshot(snapshot: SpaceSnapshotRecord): void {
    this.db
      .prepare("INSERT OR REPLACE INTO space_snapshot(space_id, seq, ts, state, hash) VALUES (?, ?, ?, ?, ?)")
      .run(snapshot.space_id, snapshot.seq, snapshot.ts, stringifyValue(snapshot.state), snapshot.hash);
  }

  latestSpaceSnapshot(space: ObjRef): SpaceSnapshotRecord | null {
    const row = this.db.prepare("SELECT * FROM space_snapshot WHERE space_id = ? ORDER BY seq DESC LIMIT 1").get(space) as Row | undefined;
    return row ? snapshotFromRow(row) : null;
  }

  loadObject(id: ObjRef): SerializedObject | null {
    const row = this.db.prepare("SELECT * FROM object WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      parent: row.parent,
      owner: row.owner,
      location: row.location,
      anchor: row.anchor,
      flags: flagsFromInt(Number(row.flags)),
      created: Number(row.created),
      modified: Number(row.modified),
      propertyDefs: (this.db.prepare("SELECT * FROM property_def WHERE object_id = ? ORDER BY name").all(id) as Row[]).map((def) => ({
        name: def.name,
        defaultValue: parseValue(def.default_val),
        typeHint: def.type_hint ?? undefined,
        owner: def.owner,
        perms: def.perms,
        version: Number(def.version)
      })),
      properties: (this.db.prepare("SELECT * FROM property_value WHERE object_id = ? ORDER BY name").all(id) as Row[]).map((value) => [value.name, parseValue(value.value)]),
      propertyVersions: (this.db.prepare("SELECT * FROM property_version WHERE object_id = ? ORDER BY name").all(id) as Row[]).map((version) => [version.name, Number(version.version)]),
      verbs: (this.db.prepare("SELECT * FROM verb WHERE object_id = ? ORDER BY name").all(id) as Row[]).map(verbFromRow),
      children: (this.db.prepare("SELECT child_ref FROM child WHERE object_id = ? ORDER BY child_ref").all(id) as Row[]).map((child) => child.child_ref),
      contents: (this.db.prepare("SELECT content_ref FROM content WHERE object_id = ? ORDER BY content_ref").all(id) as Row[]).map((content) => content.content_ref),
      eventSchemas: (this.db.prepare("SELECT * FROM event_schema WHERE object_id = ? ORDER BY type").all(id) as Row[]).map((schema) => [schema.type, parseValue(schema.schema) as Record<string, WooValue>])
    };
  }

  saveObject(obj: SerializedObject): void {
    this.transaction(() => {
      this.deleteObjectRows(obj.id);
      this.db
        .prepare("INSERT INTO object(id, name, parent, owner, location, anchor, flags, created, modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(obj.id, obj.name, obj.parent, obj.owner, obj.location, obj.anchor, flagsToInt(obj.flags), obj.created, obj.modified);
      for (const def of obj.propertyDefs) {
        this.db
          .prepare("INSERT INTO property_def(object_id, name, default_val, type_hint, owner, perms, version) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(obj.id, def.name, stringifyValue(def.defaultValue), def.typeHint ?? null, def.owner, def.perms, def.version);
      }
      for (const [name, value] of obj.properties) this.db.prepare("INSERT INTO property_value(object_id, name, value) VALUES (?, ?, ?)").run(obj.id, name, stringifyValue(value));
      for (const [name, version] of obj.propertyVersions) this.db.prepare("INSERT INTO property_version(object_id, name, version) VALUES (?, ?, ?)").run(obj.id, name, version);
      for (const verb of obj.verbs) this.saveVerb(obj.id, verb);
      for (const child of obj.children) this.addChild(obj.id, child);
      for (const content of obj.contents) this.addContent(obj.id, content);
      for (const [type, schema] of obj.eventSchemas) this.saveEventSchema(obj.id, type, schema);
    });
  }

  deleteObject(id: ObjRef): void {
    this.transaction(() => this.deleteObjectRows(id));
  }

  listHostedObjects(): ObjRef[] {
    return (this.db.prepare("SELECT id FROM object ORDER BY id").all() as Row[]).map((row) => row.id);
  }

  loadProperty(id: ObjRef, name: string): SerializedProperty | null {
    const def = this.db.prepare("SELECT * FROM property_def WHERE object_id = ? AND name = ?").get(id, name) as Row | undefined;
    const value = this.db.prepare("SELECT value FROM property_value WHERE object_id = ? AND name = ?").get(id, name) as Row | undefined;
    const version = this.db.prepare("SELECT version FROM property_version WHERE object_id = ? AND name = ?").get(id, name) as Row | undefined;
    if (!def && !value && !version) return null;
    return {
      name,
      def: def
        ? {
            name,
            defaultValue: parseValue(def.default_val),
            typeHint: def.type_hint ?? undefined,
            owner: def.owner,
            perms: def.perms,
            version: Number(def.version)
          }
        : null,
      value: value ? parseValue(value.value) : undefined,
      version: version ? Number(version.version) : def ? Number(def.version) : 0
    };
  }

  saveProperty(id: ObjRef, prop: SerializedProperty): void {
    this.ensureHostedObject(id);
    if (prop.def) {
      this.db
        .prepare("INSERT OR REPLACE INTO property_def(object_id, name, default_val, type_hint, owner, perms, version) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, prop.name, stringifyValue(prop.def.defaultValue), prop.def.typeHint ?? null, prop.def.owner, prop.def.perms, prop.def.version);
    } else {
      this.db.prepare("DELETE FROM property_def WHERE object_id = ? AND name = ?").run(id, prop.name);
    }
    if (prop.value !== undefined) this.db.prepare("INSERT OR REPLACE INTO property_value(object_id, name, value) VALUES (?, ?, ?)").run(id, prop.name, stringifyValue(prop.value));
    else this.db.prepare("DELETE FROM property_value WHERE object_id = ? AND name = ?").run(id, prop.name);
    this.db.prepare("INSERT OR REPLACE INTO property_version(object_id, name, version) VALUES (?, ?, ?)").run(id, prop.name, prop.version);
  }

  deleteProperty(id: ObjRef, name: string): void {
    this.db.prepare("DELETE FROM property_def WHERE object_id = ? AND name = ?").run(id, name);
    this.db.prepare("DELETE FROM property_value WHERE object_id = ? AND name = ?").run(id, name);
    this.db.prepare("DELETE FROM property_version WHERE object_id = ? AND name = ?").run(id, name);
  }

  listPropertyNames(id: ObjRef): string[] {
    return (
      this.db
        .prepare("SELECT name FROM property_def WHERE object_id = ? UNION SELECT name FROM property_value WHERE object_id = ? ORDER BY name")
        .all(id, id) as Row[]
    ).map((row) => row.name);
  }

  loadVerb(id: ObjRef, name: string): SerializedVerb | null {
    const row = this.db.prepare("SELECT * FROM verb WHERE object_id = ? AND name = ?").get(id, name) as Row | undefined;
    return row ? verbFromRow(row) : null;
  }

  saveVerb(id: ObjRef, verb: SerializedVerb): void {
    this.ensureHostedObject(id);
    this.db
      .prepare("INSERT OR REPLACE INTO verb(object_id, name, kind, aliases, owner, perms, arg_spec, source, source_hash, version, line_map, native, bytecode, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, verb.name, verb.kind, stringifyValue(verb.aliases), verb.owner, verb.perms, stringifyValue(verb.arg_spec), verb.source, verb.source_hash, verb.version, stringifyValue(verb.line_map), verb.kind === "native" ? verb.native : null, verb.kind === "bytecode" ? stringifyValue(verb.bytecode as unknown as WooValue) : null, verbFlagsJson(verb));
  }

  deleteVerb(id: ObjRef, name: string): void {
    this.db.prepare("DELETE FROM verb WHERE object_id = ? AND name = ?").run(id, name);
  }

  listVerbNames(id: ObjRef): string[] {
    return (this.db.prepare("SELECT name FROM verb WHERE object_id = ? ORDER BY name").all(id) as Row[]).map((row) => row.name);
  }

  loadChildren(id: ObjRef): ObjRef[] {
    return (this.db.prepare("SELECT child_ref FROM child WHERE object_id = ? ORDER BY child_ref").all(id) as Row[]).map((row) => row.child_ref);
  }

  addChild(id: ObjRef, child: ObjRef): void {
    this.ensureHostedObject(id);
    this.db.prepare("INSERT OR IGNORE INTO child(object_id, child_ref) VALUES (?, ?)").run(id, child);
  }

  removeChild(id: ObjRef, child: ObjRef): void {
    this.db.prepare("DELETE FROM child WHERE object_id = ? AND child_ref = ?").run(id, child);
  }

  loadContents(id: ObjRef): ObjRef[] {
    return (this.db.prepare("SELECT content_ref FROM content WHERE object_id = ? ORDER BY content_ref").all(id) as Row[]).map((row) => row.content_ref);
  }

  addContent(id: ObjRef, child: ObjRef): void {
    this.ensureHostedObject(id);
    this.db.prepare("INSERT OR IGNORE INTO content(object_id, content_ref) VALUES (?, ?)").run(id, child);
  }

  removeContent(id: ObjRef, child: ObjRef): void {
    this.db.prepare("DELETE FROM content WHERE object_id = ? AND content_ref = ?").run(id, child);
  }

  loadEventSchemas(id: ObjRef): [string, Record<string, WooValue>][] {
    return (this.db.prepare("SELECT type, schema FROM event_schema WHERE object_id = ? ORDER BY type").all(id) as Row[]).map((row) => [row.type, parseValue(row.schema) as Record<string, WooValue>]);
  }

  saveEventSchema(id: ObjRef, type: string, schema: Record<string, WooValue>): void {
    this.ensureHostedObject(id);
    this.db.prepare("INSERT OR REPLACE INTO event_schema(object_id, type, schema) VALUES (?, ?, ?)").run(id, type, stringifyValue(schema as WooValue));
  }

  deleteEventSchema(id: ObjRef, type: string): void {
    this.db.prepare("DELETE FROM event_schema WHERE object_id = ? AND type = ?").run(id, type);
  }

  appendLog(space: ObjRef, actor: ObjRef, message: Message): { seq: number; ts: number } {
    this.ensureHostedObject(space);
    const seq = this.currentSeq(space);
    const nextSeq = this.loadProperty(space, "next_seq");
    this.saveProperty(space, { name: "next_seq", def: nextSeq?.def ?? null, value: seq + 1, version: (nextSeq?.version ?? 0) + 1 });
    const ts = Date.now();
    this.db
      .prepare("INSERT INTO space_message(space_id, seq, ts, actor, message, observations, applied_ok, error) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)")
      .run(space, seq, ts, actor, stringifyValue(message as unknown as WooValue), stringifyValue([]));
    return { seq, ts };
  }

  recordLogOutcome(space: ObjRef, seq: number, applied_ok: boolean, observations: Observation[] = [], error?: ErrorValue): void {
    const row = this.db.prepare("SELECT applied_ok, observations, error FROM space_message WHERE space_id = ? AND seq = ?").get(space, seq) as Row | undefined;
    if (!row) throw wooError("E_STORAGE", `log entry not found: ${space}:${seq}`);
    if (row.applied_ok !== null && row.applied_ok !== undefined) {
      const existing = Boolean(row.applied_ok);
      const existingError = row.error ? parseValue(row.error) : undefined;
      const existingObservations = row.observations ? parseValue(row.observations) : [];
      if (existing === applied_ok && JSON.stringify(existingError ?? null) === JSON.stringify(error ?? null) && JSON.stringify(existingObservations) === JSON.stringify(observations)) return;
      throw wooError("E_STORAGE", `log outcome already recorded: ${space}:${seq}`);
    }
    this.db
      .prepare("UPDATE space_message SET observations = ?, applied_ok = ?, error = ? WHERE space_id = ? AND seq = ?")
      .run(stringifyValue(observations as unknown as WooValue), applied_ok ? 1 : 0, error ? stringifyValue(error as unknown as WooValue) : null, space, seq);
  }

  readLog(space: ObjRef, from: number, limit: number): LogReadResult {
    const rows = this.db.prepare("SELECT * FROM space_message WHERE space_id = ? AND seq >= ? ORDER BY seq LIMIT ?").all(space, from, limit + 1) as Row[];
    const page = rows.slice(0, limit);
    return {
      messages: page.map(logEntryFromRow),
      next_seq: this.currentSeq(space),
      has_more: rows.length > limit
    };
  }

  currentSeq(space: ObjRef): number {
    const prop = this.loadProperty(space, "next_seq");
    if (typeof prop?.value === "number") return prop.value;
    const row = this.db.prepare("SELECT MAX(seq) AS max_seq FROM space_message WHERE space_id = ?").get(space) as Row | undefined;
    return Number(row?.max_seq ?? 0) + 1;
  }

  loadLatestSnapshot(space: ObjRef): SpaceSnapshotRecord | null {
    const row = this.db.prepare("SELECT * FROM space_snapshot WHERE space_id = ? ORDER BY seq DESC LIMIT 1").get(space) as Row | undefined;
    return row ? snapshotFromRow(row) : null;
  }

  truncateLog(space: ObjRef, covered_seq: number): number {
    const result = this.db.prepare("DELETE FROM space_message WHERE space_id = ? AND seq <= ?").run(space, covered_seq);
    return Number(result.changes ?? 0);
  }

  loadSession(session_id: string): SerializedSession | null {
    const row = this.db.prepare("SELECT * FROM session WHERE id = ?").get(session_id) as Row | undefined;
    return row ? sessionFromRow(row) : null;
  }

  saveSession(record: SerializedSession): void {
    const hasAttachmentColumn = this.tableColumns("session").has("attachment");
    const stmt = this.db.prepare(
      hasAttachmentColumn
        ? "INSERT OR REPLACE INTO session(id, actor, started, expires_at, last_detach_at, token_class, attachment) VALUES (?, ?, ?, ?, ?, ?, ?)"
        : "INSERT OR REPLACE INTO session(id, actor, started, expires_at, last_detach_at, token_class) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const values = [record.id, record.actor, record.started, record.expiresAt ?? null, record.lastDetachAt ?? null, record.tokenClass ?? "guest"];
    stmt.run(...(hasAttachmentColumn ? [...values, "{}"] : values));
  }

  deleteSession(session_id: string): void {
    this.db.prepare("DELETE FROM session WHERE id = ?").run(session_id);
  }

  loadExpiredSessions(now: number): SerializedSession[] {
    return (this.db.prepare("SELECT * FROM session ORDER BY id").all() as Row[]).map(sessionFromRow).filter((session) => (session.expiresAt !== undefined && session.expiresAt <= now) || (session.lastDetachAt !== undefined && session.lastDetachAt !== null && session.lastDetachAt <= now));
  }

  saveTask(task: ParkedTaskRecord): void {
    this.db
      .prepare("INSERT OR REPLACE INTO task(id, parked_on, state, resume_at, awaiting_player, correlation_id, serialized, created, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(task.id, task.parked_on, task.state, task.resume_at, task.awaiting_player, task.correlation_id, stringifyValue(task.serialized), task.created, task.origin);
  }

  deleteTask(id: string): void {
    this.db.prepare("DELETE FROM task WHERE id = ?").run(id);
  }

  loadTask(id: string): ParkedTaskRecord | null {
    const row = this.db.prepare("SELECT * FROM task WHERE id = ?").get(id) as Row | undefined;
    return row ? taskFromRow(row) : null;
  }

  loadDueTasks(now: number): ParkedTaskRecord[] {
    return (this.db.prepare("SELECT * FROM task WHERE state = 'suspended' AND resume_at <= ? ORDER BY resume_at, created, id").all(now) as Row[]).map(taskFromRow);
  }

  loadAwaitingReadTasks(player: ObjRef): ParkedTaskRecord[] {
    return (this.db.prepare("SELECT * FROM task WHERE state = 'awaiting_read' AND awaiting_player = ? ORDER BY created, id").all(player) as Row[]).map(taskFromRow);
  }

  earliestResumeAt(): number | null {
    const row = this.db.prepare("SELECT MIN(resume_at) AS resume_at FROM task WHERE state = 'suspended' AND resume_at IS NOT NULL").get() as Row | undefined;
    return row?.resume_at === null || row?.resume_at === undefined ? null : Number(row.resume_at);
  }

  nextCounter(name: string): number {
    let next = 1;
    this.transaction(() => {
      const key = `counter:${name}`;
      next = Number(this.loadMeta(key) ?? 1);
      this.saveMeta(key, String(next + 1));
    });
    return next;
  }

  loadMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM world_meta WHERE key = ?").get(key) as Row | undefined;
    return row?.value ?? null;
  }

  saveMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO world_meta(key, value) VALUES (?, ?)").run(key, value);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS object (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent TEXT,
        owner TEXT NOT NULL,
        location TEXT,
        anchor TEXT,
        flags INTEGER NOT NULL,
        created INTEGER NOT NULL,
        modified INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_def (
        object_id TEXT NOT NULL,
        name TEXT NOT NULL,
        default_val TEXT NOT NULL,
        type_hint TEXT,
        owner TEXT NOT NULL,
        perms TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (object_id, name)
      );
      CREATE TABLE IF NOT EXISTS property_value (
        object_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (object_id, name)
      );
      CREATE TABLE IF NOT EXISTS property_version (
        object_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (object_id, name)
      );
      CREATE TABLE IF NOT EXISTS verb (
        object_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        aliases TEXT NOT NULL,
        owner TEXT NOT NULL,
        perms TEXT NOT NULL,
        arg_spec TEXT NOT NULL,
        source TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        line_map TEXT NOT NULL,
        native TEXT,
        bytecode TEXT,
        flags TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (object_id, name)
      );
      CREATE TABLE IF NOT EXISTS child (
        object_id TEXT NOT NULL,
        child_ref TEXT NOT NULL,
        PRIMARY KEY (object_id, child_ref)
      );
      CREATE TABLE IF NOT EXISTS content (
        object_id TEXT NOT NULL,
        content_ref TEXT NOT NULL,
        PRIMARY KEY (object_id, content_ref)
      );
      CREATE TABLE IF NOT EXISTS event_schema (
        object_id TEXT NOT NULL,
        type TEXT NOT NULL,
        schema TEXT NOT NULL,
        PRIMARY KEY (object_id, type)
      );
      CREATE TABLE IF NOT EXISTS space_message (
        space_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        message TEXT NOT NULL,
        observations TEXT NOT NULL DEFAULT '[]',
        applied_ok INTEGER,
        error TEXT,
        PRIMARY KEY (space_id, seq)
      );
      CREATE INDEX IF NOT EXISTS space_message_ts ON space_message(space_id, ts);
      CREATE TABLE IF NOT EXISTS space_snapshot (
        space_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        state TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (space_id, seq)
      );
      CREATE TABLE IF NOT EXISTS task (
        id TEXT PRIMARY KEY,
        parked_on TEXT NOT NULL,
        state TEXT NOT NULL,
        resume_at INTEGER,
        awaiting_player TEXT,
        correlation_id TEXT,
        serialized TEXT NOT NULL,
        created INTEGER NOT NULL,
        origin TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_parked_on ON task(parked_on);
      CREATE INDEX IF NOT EXISTS task_resume_at ON task(resume_at) WHERE state = 'suspended';
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        started INTEGER NOT NULL,
        expires_at INTEGER,
        last_detach_at INTEGER,
        token_class TEXT NOT NULL DEFAULT 'guest'
      );
      CREATE TABLE IF NOT EXISTS world_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.ensureColumn("session", "expires_at", "INTEGER");
    this.ensureColumn("session", "last_detach_at", "INTEGER");
    this.ensureColumn("session", "token_class", "TEXT NOT NULL DEFAULT 'guest'");
    this.ensureColumn("space_message", "observations", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("verb", "flags", "TEXT NOT NULL DEFAULT '{}'");
    this.db.exec("DROP TABLE IF EXISTS session_socket");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    if (this.tableColumns(table).has(column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private tableColumns(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    return new Set(rows.map((row) => String(row.name)));
  }

  private ensureHostedObject(id: ObjRef): void {
    if (!this.db.prepare("SELECT 1 FROM object WHERE id = ?").get(id)) throw wooError("E_OBJNF", `object not hosted here: ${id}`, id);
  }

  private deleteObjectRows(id: ObjRef): void {
    for (const table of ["event_schema", "content", "child", "verb", "property_version", "property_value", "property_def"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE object_id = ?`).run(id);
    }
    this.db.prepare("DELETE FROM object WHERE id = ?").run(id);
  }

  private assertNoPendingLogOutcomes(): void {
    const row = this.db.prepare("SELECT space_id, seq FROM space_message WHERE applied_ok IS NULL LIMIT 1").get() as Row | undefined;
    if (row) throw wooError("E_STORAGE", `pending log outcome at transaction commit: ${row.space_id}:${row.seq}`);
  }

  transaction<T>(fn: () => T): T {
    // Nested transaction() calls intentionally flatten. Use savepoint() when
    // the inner scope needs rollback isolation without aborting the outer unit.
    if (this.transactionDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.assertNoPendingLogOutcomes();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.transactionDepth = 0;
    }
  }

  savepoint<T>(fn: () => T): T {
    const name = `woo_sp_${++this.savepointCounter}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      throw err;
    }
  }
}

function verbFromRow(row: Row): VerbDef {
  const flags = row.flags ? (parseValue(row.flags) as Record<string, unknown>) : {};
  const base = {
    name: row.name,
    aliases: parseValue(row.aliases) as string[],
    owner: row.owner,
    perms: row.perms,
    arg_spec: parseValue(row.arg_spec) as Record<string, WooValue>,
    source: row.source,
    source_hash: row.source_hash,
    version: Number(row.version),
    line_map: parseValue(row.line_map) as Record<string, WooValue>,
    direct_callable: flags.direct_callable === true ? true : undefined,
    skip_presence_check: flags.skip_presence_check === true ? true : undefined
  };
  if (row.kind === "native") return { ...base, kind: "native", native: row.native };
  return { ...base, kind: "bytecode", bytecode: parseValue(row.bytecode) as any };
}

function verbFlagsJson(verb: VerbDef): string {
  const flags: Record<string, true> = {};
  if (verb.direct_callable === true) flags.direct_callable = true;
  if (verb.skip_presence_check === true) flags.skip_presence_check = true;
  return JSON.stringify(flags);
}

function snapshotFromRow(row: Row): SpaceSnapshotRecord {
  return {
    space_id: row.space_id,
    seq: Number(row.seq),
    ts: Number(row.ts),
    state: parseValue(row.state),
    hash: row.hash
  };
}

function taskFromRow(row: Row): ParkedTaskRecord {
  return {
    id: row.id,
    parked_on: row.parked_on,
    state: row.state,
    resume_at: row.resume_at === null || row.resume_at === undefined ? null : Number(row.resume_at),
    awaiting_player: row.awaiting_player ?? null,
    correlation_id: row.correlation_id ?? null,
    serialized: parseValue(row.serialized),
    created: Number(row.created),
    origin: row.origin
  };
}

function sessionFromRow(row: Row): SerializedSession {
  return {
    id: row.id,
    actor: row.actor,
    started: Number(row.started),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? undefined : Number(row.expires_at),
    lastDetachAt: row.last_detach_at === null || row.last_detach_at === undefined ? null : Number(row.last_detach_at),
    tokenClass: row.token_class as "guest" | "bearer" | "apikey" | undefined
  };
}

function logEntryFromRow(row: Row): SpaceLogEntry {
  if (row.applied_ok === null || row.applied_ok === undefined) throw wooError("E_STORAGE", `log entry has no committed outcome: ${row.space_id}:${row.seq}`);
  return {
    space: row.space_id,
    seq: Number(row.seq),
    ts: Number(row.ts),
    actor: row.actor,
    message: parseValue(row.message) as unknown as Message,
    observations: row.observations ? (parseValue(row.observations) as unknown as Observation[]) : [],
    applied_ok: Boolean(row.applied_ok),
    error: row.error ? (parseValue(row.error) as unknown as ErrorValue) : undefined
  };
}

function groupBy(rows: Row[], key: string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const value = String(row[key]);
    groups.set(value, [...(groups.get(value) ?? []), row]);
  }
  return groups;
}

function stringifyValue(value: WooValue): string {
  return JSON.stringify(value);
}

function parseValue(value: string): WooValue {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw wooError("E_STORAGE", "invalid JSON value in SQLite repository", err instanceof Error ? err.message : String(err));
  }
}

function flagsToInt(flags: SerializedObject["flags"]): number {
  return (flags.wizard ? 1 : 0) | (flags.programmer ? 2 : 0) | (flags.fertile ? 4 : 0) | (flags.recyclable ? 8 : 0);
}

function flagsFromInt(flags: number): SerializedObject["flags"] {
  return {
    wizard: Boolean(flags & 1),
    programmer: Boolean(flags & 2),
    fertile: Boolean(flags & 4),
    recyclable: Boolean(flags & 8)
  };
}
