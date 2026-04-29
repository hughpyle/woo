import type { ObjRef, PropertyDef, Session, SpaceLogEntry, VerbDef, WooObject, WooValue } from "./types";

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
