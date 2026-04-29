# Persistence Plan

## Required Stores

Minimum durable tables/collections:

- object metadata
- property definitions and values, scoped by `object_id`
- verbs, scoped by `object_id`
- children and contents indexes, scoped by `object_id`
- event schemas, scoped by `object_id`
- parent-chain and ancestor caches
- sequenced message history, scoped by `(space_id, seq)`
- sessions
- migrations

Optional continuity tables/collections:

- snapshots

## Object Record

```ts
{
  id: ObjRef,
  name: string,
  parent: ObjRef | null,
  owner: ObjRef,
  location: ObjRef | null,
  anchor: ObjRef | null,
  flags: number,
  created: number,
  modified: number
}
```

An implementation may expose this through a higher-level repository, but the
storage model must preserve the reference schema's distinction between object
metadata, property definitions, property values, verbs, children, contents, and
schemas.

## Anchor Clusters

A persistent host stores either one object or one anchor cluster. Any per-object
table must include `object_id` in its key. Do not use `(name)` alone for
properties or verbs; anchored objects can share a host and can define the same
property or verb names independently.

## Message History Record

```ts
{
  space_id: ObjRef,
  seq: number,
  ts: number,
  actor: ObjRef,
  message: Message,
  applied_ok: boolean,
  error?: ErrValue
}
```

`ts` is for diagnostics only. Ordering is `(space_id, seq)`.

## Optional Snapshot Record

```ts
{
  space_id: ObjRef,
  seq: number,
  state: Value,
  ts: number,
  hash: string
}
```

Snapshots are optional continuity records. Replay via `space:replay(from, limit)`
is the first-light recovery mechanism; dedicated `snapshot` / `history` /
`sync` wire frames are not first-light protocol.

## Session Records

Persist sessions and attached websocket metadata according to
`spec/semantics/identity.md`: a session binds a websocket connection to an
actor, supports multi-attach, and can be resumed with `session:<id>` while it is
alive.

## Idempotency Cache

The websocket `call.id` retry cache is short-lived host/session state with a
default TTL around five minutes. It maps `(session, id)` to the already-produced
`applied` frame. It does not replace durable message history.

## First Storage Strategy

Use the simplest durable storage that works in the deployment target. Wrap it
behind a repository interface so the core runtime can be tested in memory.

The repository interface should support both in-memory tests and the
Cloudflare/Durable Object schema in `spec/reference/persistence.md`.

## Migration Rule

Every stored database has a schema version. A missing or newer schema version
must fail loudly rather than silently corrupt state.
