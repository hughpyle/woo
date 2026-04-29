# Protocol Plan

Tracks [`spec/protocol/wire.md`](../spec/protocol/wire.md). Names and shapes here must match the spec.

## Client To Server

```ts
{ op: "auth", token: string }

{
  op: "call",
  id: string,
  space: ObjRef,
  message: {
    actor: ObjRef,
    target: ObjRef,
    verb: string,
    args: Value[],
    body?: Record<string, Value>
  }
}

{ op: "ping" }
```

## Server To Client

```ts
{ op: "session", actor: ObjRef }

{
  op: "applied",
  id?: string,
  space: ObjRef,
  seq: number,
  message: Record<string, Value>,
  observations: Array<Record<string, Value>>
}

{ op: "error", id?: string, error: { code: string, message?: string, value?: any } }

{ op: "pong" }
```

## Frames Not In First-Light

Snapshot, history, sync, subscribe, unsubscribe, and text input frames are not
part of first-light. Reconnect uses `space:replay(from, limit)` through normal
calls and then resumes the live `applied` stream.

Do not implement private compatibility frames unless `spec/protocol/wire.md`
adds them.

## Protocol Rules

- Client ids are request ids, not sequence ids.
- Retrying the same `id` for the same live session returns the same `applied`
  frame from the idempotency cache and does not allocate a new `seq`.
- Server assigns `seq`.
- A rejected pre-sequence message returns `error` and no `applied`.
- A sequenced message that fails during apply still receives `applied`; the
  failure is represented as an error observation at that `seq`.
- There is no explicit subscribe/unsubscribe in first-light; observation
  membership is derived from actor presence or ownership.
- Implement inbound rate limiting and outbound overflow handling as specified in
  `wire.md`.

## Auth Tokens

First-light auth accepts:

- `guest:<random>` to bind a guest player from the pool
- `session:<session_id>` to resume a live session

`bearer:<...>` is reserved; do not implement credentialed accounts in the
first-light protocol.
