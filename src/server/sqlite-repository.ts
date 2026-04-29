import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ParkedTaskRecord, SerializedObject, SerializedWorld, SpaceSnapshotRecord, WorldRepository } from "../core/repository";
import type { ObjRef, SpaceLogEntry, VerbDef, WooValue } from "../core/types";

type Row = Record<string, any>;

export class SQLiteWorldRepository implements WorldRepository {
  private db: DatabaseSync;

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
      started: Number(row.started)
    }));

    const logRows = this.db.prepare("SELECT * FROM space_message ORDER BY space_id, seq").all() as Row[];
    const logs = Array.from(groupBy(logRows, "space_id").entries()).map(([space, entries]) => [
      space,
      entries.map((row) => ({
        space: row.space_id,
        seq: Number(row.seq),
        ts: Number(row.ts),
        actor: row.actor,
        message: parseValue(row.message),
        applied_ok: Boolean(row.applied_ok),
        error: row.error ? parseValue(row.error) : undefined
      })) as SpaceLogEntry[]
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
        "session_socket",
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
      const insertVerb = this.db.prepare("INSERT INTO verb(object_id, name, kind, aliases, owner, perms, arg_spec, source, source_hash, version, line_map, native, bytecode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const insertChild = this.db.prepare("INSERT INTO child(object_id, child_ref) VALUES (?, ?)");
      const insertContent = this.db.prepare("INSERT INTO content(object_id, content_ref) VALUES (?, ?)");
      const insertSchema = this.db.prepare("INSERT INTO event_schema(object_id, type, schema) VALUES (?, ?, ?)");

      for (const obj of world.objects) {
        insertObject.run(obj.id, obj.name, obj.parent, obj.owner, obj.location, obj.anchor, flagsToInt(obj.flags), obj.created, obj.modified);
        for (const def of obj.propertyDefs) insertDef.run(obj.id, def.name, stringifyValue(def.defaultValue), def.typeHint ?? null, def.owner, def.perms, def.version);
        for (const [name, value] of obj.properties) insertValue.run(obj.id, name, stringifyValue(value));
        for (const [name, version] of obj.propertyVersions) insertVersion.run(obj.id, name, version);
        for (const verb of obj.verbs) insertVerb.run(obj.id, verb.name, verb.kind, stringifyValue(verb.aliases), verb.owner, verb.perms, stringifyValue(verb.arg_spec), verb.source, verb.source_hash, verb.version, stringifyValue(verb.line_map), verb.kind === "native" ? verb.native : null, verb.kind === "bytecode" ? stringifyValue(verb.bytecode as unknown as WooValue) : null);
        for (const child of obj.children) insertChild.run(obj.id, child);
        for (const content of obj.contents) insertContent.run(obj.id, content);
        for (const [type, schema] of obj.eventSchemas) insertSchema.run(obj.id, type, stringifyValue(schema as WooValue));
      }

      const insertSession = this.db.prepare("INSERT INTO session(id, actor, started, attachment) VALUES (?, ?, ?, ?)");
      for (const session of world.sessions) insertSession.run(session.id, session.actor, session.started, "{}");

      const insertLog = this.db.prepare("INSERT INTO space_message(space_id, seq, ts, actor, message, applied_ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const [space, entries] of world.logs) {
        for (const entry of entries) insertLog.run(space, entry.seq, entry.ts, entry.actor, stringifyValue(entry.message as unknown as WooValue), entry.applied_ok ? 1 : 0, entry.error ? stringifyValue(entry.error as unknown as WooValue) : null);
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
        applied_ok INTEGER NOT NULL,
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
        attachment TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_socket (
        ws_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        attached_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS world_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

function verbFromRow(row: Row): VerbDef {
  const base = {
    name: row.name,
    aliases: parseValue(row.aliases) as string[],
    owner: row.owner,
    perms: row.perms,
    arg_spec: parseValue(row.arg_spec) as Record<string, WooValue>,
    source: row.source,
    source_hash: row.source_hash,
    version: Number(row.version),
    line_map: parseValue(row.line_map) as Record<string, WooValue>
  };
  if (row.kind === "native") return { ...base, kind: "native", native: row.native };
  return { ...base, kind: "bytecode", bytecode: parseValue(row.bytecode) as any };
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
  return JSON.parse(value);
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
