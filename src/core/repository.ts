import type { ErrorValue, Message, ObjRef, PropertyDef, Session, SpaceLogEntry, VerbDef, WooObject, WooValue } from "./types";

export type SerializedObject = {
  id: ObjRef;
  name: string;
  parent: ObjRef | null;
  owner: ObjRef;
  location: ObjRef | null;
  anchor: ObjRef | null;
  flags: WooObject["flags"];
  created: number;
  modified: number;
  propertyDefs: PropertyDef[];
  properties: [string, WooValue][];
  propertyVersions: [string, number][];
  verbs: VerbDef[];
  children: ObjRef[];
  contents: ObjRef[];
  eventSchemas: [string, Record<string, WooValue>][];
};

export type SerializedSession = {
  id: string;
  actor: ObjRef;
  started: number;
  expiresAt?: number;
  lastDetachAt?: number | null;
  tokenClass?: "guest" | "bearer" | "apikey";
};

export type SpaceSnapshotRecord = {
  space_id: ObjRef;
  seq: number;
  ts: number;
  state: WooValue;
  hash: string;
};

export type ParkedTaskRecord = {
  id: string;
  parked_on: ObjRef;
  state: "suspended" | "awaiting_read" | "awaiting_call";
  resume_at: number | null;
  awaiting_player: ObjRef | null;
  correlation_id: string | null;
  serialized: WooValue;
  created: number;
  origin: ObjRef;
};

export type SerializedWorld = {
  version: 1;
  taskCounter: number;
  parkedTaskCounter: number;
  sessionCounter: number;
  objects: SerializedObject[];
  sessions: SerializedSession[];
  logs: [ObjRef, SpaceLogEntry[]][];
  snapshots: SpaceSnapshotRecord[];
  parkedTasks: ParkedTaskRecord[];
};

export interface WorldRepository {
  load(): SerializedWorld | null;
  save(world: SerializedWorld): void;
  saveSpaceSnapshot?(snapshot: SpaceSnapshotRecord): void;
  latestSpaceSnapshot?(space: ObjRef): SpaceSnapshotRecord | null;
}

// ---------------------------------------------------------------------------
// ObjectRepository: per-object persistence interface.
//
// Per spec/reference/cloudflare.md §R4. The runtime accesses storage exclusively
// through this interface; backends (in-memory, local SQLite, Cloudflare DO
// SQLite) implement it. This is the contract the world-decomposition refactor
// should converge on.
//
// Each implementation is scoped to a "host" — one DO in CF, one process in
// local dev. The host owns the rows for one or more objects (an anchor cluster
// or a single autonomous object). All operations target this host's hosted
// set; cross-host operations go through the RPC surface (cloudflare.md §R5),
// not through this interface.
//
// All methods are synchronous in shape. The CF backend wraps `state.storage.sql`
// (which is sync) with no extra ceremony. If a future backend needs async I/O,
// the methods can return Promises and the runtime can await them; for v1 the
// sync shape matches the storage primitives we have.
// ---------------------------------------------------------------------------

/** A single property's persisted form (split out of SerializedObject for per-property ops). */
export type SerializedProperty = {
  name: string;
  /** Definition (slot introduction). Null when the property is only valued, not defined here. */
  def: PropertyDef | null;
  /** Value stored on this object (overrides ancestor default). Undefined when unset. */
  value: WooValue | undefined;
  /** Per-property version counter for optimistic concurrency on definition edits. */
  version: number;
};

/** A single verb's persisted form (split out for per-verb ops). */
export type SerializedVerb = VerbDef;

/** A read of one slice of a $sequenced_log. */
export type LogReadResult = {
  messages: SpaceLogEntry[];
  next_seq: number;
  has_more: boolean;
};

/** A read of one parked task record (alias retained for clarity at call sites). */
export type SerializedTask = ParkedTaskRecord;

export interface ObjectRepository {
  // ----- Transactions / unit of work -----

  /**
   * Execute `fn` inside an atomic write boundary. All mutations made via
   * `save*`/`delete*`/`add*`/`remove*`/`recordLogOutcome` calls inside `fn` commit
   * together or roll back together if `fn` throws.
   *
   * Required for `$space:call`'s "behavior failure rolls back mutations" rule
   * (spec/semantics/space.md §S3.2). The CF backend uses
   * `state.storage.transactionSync`; the in-memory backend snapshot-and-restores;
   * the local SQLite backend uses BEGIN/COMMIT/ROLLBACK.
   *
   * Implementations may flatten nested calls (treat the inner `transaction` as a
   * no-op) since woo's runtime never legitimately needs nested rollback scopes.
   */
  transaction<T>(fn: () => T): T;

  // ----- Object identity & metadata -----

  /**
   * Load the object metadata + all per-object rows (properties, verbs, children,
   * contents, schemas) for `id`. Returns null if the object is not hosted here.
   *
   * The caller composes this with separately-loaded properties/verbs only if
   * they want a fully-materialized view; the runtime's hot path uses the
   * per-property and per-verb getters below to avoid loading whole objects.
   */
  loadObject(id: ObjRef): SerializedObject | null;

  /** Persist a fully-materialized object. Used during bootstrap and recycle precursors. */
  saveObject(obj: SerializedObject): void;

  /**
   * Delete every row scoped to `id` on this host: property_def, property_value,
   * verb, child, content, event_schema, ancestor_chain, and the object row
   * itself. Per spec/semantics/recycle.md §RC3 step 8. Does NOT cascade across
   * hosts.
   */
  deleteObject(id: ObjRef): void;

  /** Enumerate the object IDs hosted here. Used for bootstrap idempotency checks and `:metrics()` rollups. */
  listHostedObjects(): ObjRef[];

  // ----- Properties (per-name granularity) -----

  loadProperty(id: ObjRef, name: string): SerializedProperty | null;

  /**
   * Persist a property's def and/or value. Implementations should preserve the
   * version field; the runtime supplies the version from its in-memory state.
   */
  saveProperty(id: ObjRef, prop: SerializedProperty): void;

  deleteProperty(id: ObjRef, name: string): void;

  /** List all property names defined or valued on `id` (no values, just names). */
  listPropertyNames(id: ObjRef): string[];

  // ----- Verbs (per-name granularity) -----

  loadVerb(id: ObjRef, name: string): SerializedVerb | null;

  saveVerb(id: ObjRef, verb: SerializedVerb): void;

  deleteVerb(id: ObjRef, name: string): void;

  listVerbNames(id: ObjRef): string[];

  // ----- Inheritance / containment (denormalized per persistence.md §14.1) -----

  /** Children whose parent is `id` (objref of child; may live on a different host). */
  loadChildren(id: ObjRef): ObjRef[];
  addChild(id: ObjRef, child: ObjRef): void;
  removeChild(id: ObjRef, child: ObjRef): void;

  /** Contents whose location is `id`. */
  loadContents(id: ObjRef): ObjRef[];
  addContent(id: ObjRef, child: ObjRef): void;
  removeContent(id: ObjRef, child: ObjRef): void;

  // ----- Event schemas -----

  loadEventSchemas(id: ObjRef): [string, Record<string, WooValue>][];
  saveEventSchema(id: ObjRef, type: string, schema: Record<string, WooValue>): void;
  deleteEventSchema(id: ObjRef, type: string): void;

  // ----- $sequenced_log surface (per spec/semantics/sequenced-log.md) -----
  //
  // Two-phase write per spec/reference/cloudflare.md §R3.2:
  //   1. `appendLog` allocates the seq and persists the message. After it
  //      returns, the message is durably in the log; replay will see it.
  //      The row's outcome (applied_ok, error) is unset at this point —
  //      "in-flight."
  //   2. `recordLogOutcome` is called once after the behavior either commits
  //      successfully or fails. It updates the same row.
  //
  // Crash recovery: rows with no recorded outcome at boot are reconciled per
  // §R3.3 — replayed if safe, otherwise marked `applied_ok = false` with
  // `error = E_HOST_CRASH`.

  /**
   * Atomically: allocate `seq = next_seq`, increment `next_seq`, and persist
   * `(seq, ts, actor, message)` to the log. Returns the assigned seq + ts.
   * The row is in-flight (no outcome) until `recordLogOutcome` is called.
   *
   * Implementations guarantee the seq increment + append are one transaction;
   * partial state is impossible. `appendLog` is NOT wrapped in the caller's
   * `transaction()` scope — the message must commit independently of the
   * behavior's success/failure.
   */
  appendLog(space: ObjRef, actor: ObjRef, message: Message): { seq: number; ts: number };

  /**
   * Update the in-flight log row with the behavior outcome. Called from inside
   * the same `transaction()` as the behavior's mutations on the success path,
   * or from a fresh `transaction()` on the failure path (see §R3.4).
   *
   * Idempotent: calling twice with the same outcome is a no-op; calling with a
   * different outcome raises (an outcome should be immutable once set).
   */
  recordLogOutcome(space: ObjRef, seq: number, applied_ok: boolean, error?: ErrorValue): void;

  /** Read at most `limit` log entries with `seq >= from`. Caller checks for `has_more`. */
  readLog(space: ObjRef, from: number, limit: number): LogReadResult;

  /** Current next_seq (= 1 + highest assigned). For introspection and tests. */
  currentSeq(space: ObjRef): number;

  // ----- Snapshots -----

  saveSpaceSnapshot(snapshot: SpaceSnapshotRecord): void;
  loadLatestSnapshot(space: ObjRef): SpaceSnapshotRecord | null;
  /**
   * Truncate log entries with `seq <= covered_seq`. Returns the count truncated.
   * Implementations may opt to log-and-noop in v1 (truncation is an optimization,
   * not a correctness requirement; see spec/semantics/space.md §S5).
   */
  truncateLog(space: ObjRef, covered_seq: number): number;

  // ----- Sessions (credential metadata only — see identity.md §I2) -----

  loadSession(session_id: string): SerializedSession | null;
  saveSession(record: SerializedSession): void;
  deleteSession(session_id: string): void;

  /**
   * Sessions on this host that are eligible for reap: `last_detach_at + grace < now`
   * or `now > expires_at`. The runtime's reap loop calls this and processes results.
   * Implementations may return all sessions and let the caller filter; or filter
   * at the storage layer for efficiency.
   */
  loadExpiredSessions(now: number): SerializedSession[];

  // ----- Parked tasks (per spec/semantics/tasks.md §16) -----

  saveTask(task: ParkedTaskRecord): void;

  deleteTask(id: string): void;

  loadTask(id: string): ParkedTaskRecord | null;

  /**
   * Tasks with `state == 'suspended' AND resume_at <= now`, ordered by `resume_at`.
   * The runtime's alarm handler (cloudflare.md §R7) loads these on alarm fire.
   */
  loadDueTasks(now: number): ParkedTaskRecord[];

  /**
   * Tasks with `state == 'awaiting_read' AND awaiting_player == player`, in FIFO
   * order. The runtime's input-delivery path loads these on inbound input.
   */
  loadAwaitingReadTasks(player: ObjRef): ParkedTaskRecord[];

  /**
   * Earliest `resume_at` over all suspended tasks on this host, or null if none.
   * Drives `state.storage.setAlarm()` on CF; ignored by the local poller backend.
   */
  earliestResumeAt(): number | null;

  // ----- Host-scoped counters -----

  /**
   * Atomically read-and-increment a named counter. Used for ULID minting suffix,
   * task ids, session ids, etc. Counters persist across host restarts.
   */
  nextCounter(name: string): number;

  // ----- Bootstrap state -----

  /**
   * Read a host-scoped meta value. Used for the `bootstrapped` flag and similar
   * one-time state.
   */
  loadMeta(key: string): string | null;
  saveMeta(key: string, value: string): void;
}

export class InMemoryWorldRepository implements WorldRepository {
  private stored: SerializedWorld | null = null;

  load(): SerializedWorld | null {
    return this.stored ? structuredClone(this.stored) : null;
  }

  save(world: SerializedWorld): void {
    this.stored = structuredClone(world);
  }

  saveSpaceSnapshot(snapshot: SpaceSnapshotRecord): void {
    if (!this.stored) {
      this.stored = { version: 1, taskCounter: 1, parkedTaskCounter: 1, sessionCounter: 1, objects: [], sessions: [], logs: [], snapshots: [], parkedTasks: [] };
    }
    const snapshots = this.stored.snapshots.filter((item) => !(item.space_id === snapshot.space_id && item.seq === snapshot.seq));
    snapshots.push(structuredClone(snapshot));
    this.stored.snapshots = snapshots;
  }

  latestSpaceSnapshot(space: ObjRef): SpaceSnapshotRecord | null {
    const snapshots = this.stored?.snapshots.filter((snapshot) => snapshot.space_id === space).sort((a, b) => b.seq - a.seq) ?? [];
    return snapshots[0] ? structuredClone(snapshots[0]) : null;
  }
}
