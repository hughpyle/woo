# Wire protocol

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**. Profile: **v1-core**.

The JSON message format on the WebSocket between client and player host. First-light scope: just enough frames to drive a sequenced message dispatch loop and surface its observations.

Browser bootstrap details (transient host installation, host-to-host RPC) are in [browser-host.md](browser-host.md). Cross-world federation frames are in [../deferred/federation.md §24](../deferred/federation.md#24-federation).

---

## 17. Wire protocol

WebSockets between client and player host. JSON frames. UTF-8. Values are encoded per [../semantics/values.md §V2](../semantics/values.md#v2-canonical-json-encoding).

### 17.1 Client → server

```ts
// Establish session.
{ op: "auth", token: string }

// Make a sequenced call through a space.
//   id        — client-chosen correlation token; echoed in the reply
//   space     — the $space whose seq this call advances
//   message   — message map: { actor, target, verb, args, body? }
{ op: "call", id: string, space: ObjRef, message: Map }

// Heartbeat.
{ op: "ping" }
```

That is the entire first-light client→server surface.

Reserved for transient hosts (see [browser-host.md](browser-host.md)):

```ts
{ op: "host_return", correlation_id: string, result: Value }
{ op: "host_raise",  correlation_id: string, error: ErrValue }
```

### 17.2 Server → client

```ts
// Session established; the client is bound to this actor.
{ op: "session", actor: ObjRef }

// A sequenced call has been applied. Carries the canonical seq and any
// observations emitted during apply.
//   id            — present iff this client originated the call
//   space         — the $space that sequenced
//   seq           — assigned sequence number
//   message       — the message that was applied
//   observations  — list of observation maps emitted during apply
{ op: "applied", id?: string, space: ObjRef, seq: int, message: Map, observations: Map[] }

// A call could not be applied, or a system error occurred.
//   id    — present iff associated with a specific call
//   error — err value per V7
{ op: "error", id?: string, error: ErrValue }

// Heartbeat.
{ op: "pong" }
```

That is the entire first-light server→client surface.

Reserved for transient hosts:

```ts
{ op: "host_install",   id: TRef, parent: ObjRef, bytecode: Bytecode, props: Map }
{ op: "host_uninstall", id: TRef }
{ op: "host_call",      correlation_id: string, target: TRef, verb: string, args: Value[], frame: Frame }
```

### 17.3 Framing

One JSON object per WebSocket message. No binary frames in v1.

### 17.4 The `applied` push model

When an actor is connected, the player host sends `applied` frames for every sequenced call applied to spaces the actor is observing — including calls the actor itself originated.

- For the originator, `id` matches the `op: "call"` they sent. They use this to pair the reply with their pending call, run any reconcile logic (§17.6), and discard the optimistic prediction.
- For other observers, `id` is absent. They consume the applied frame as a state-update event.

There is no separate subscribe/unsubscribe frame in first-light. Membership in a space (which determines whether the host pushes its `applied` stream to a given client) is a server-side decision driven by the actor's relationship to the space — typically presence-based (the actor is in the space) or explicit ownership.

If a client's connection is interrupted and reconnects, gap recovery follows the pattern in [../semantics/events.md §12.7](../semantics/events.md#127-sequenced-calls-with-gap-recovery): the client tracks the highest `seq` per space it has applied, calls `space:replay(from, limit)` to backfill, then resumes the live stream.

**Idempotent retry.** The `id` field on `op: "call"` is a client-chosen correlation token. If a client retries a call with the same `id` (e.g., after a transient network failure or reconnect), the host returns the **same** `applied` frame — same `seq`, same `message`, same `observations`. No new sequence number is allocated; the call is not re-executed. This piggybacks on the host's correlation-id idempotency cache (see [hosts.md §3.4](hosts.md#34-task-migration-invariants)), default TTL ~5 minutes. Beyond the TTL, the host has no memory of the original call and a retry would create a duplicate; clients should treat the cache as best-effort and rely on gap recovery (above) as the durable continuity mechanism.

### 17.5 Backpressure and rate limiting

**Outbound**: each player host maintains a bounded outbound queue (default 1024 frames). On overflow, the oldest applied frames are dropped and the player receives an `error` frame with code `E_OVERFLOW` and a count of dropped frames. The client should treat `E_OVERFLOW` like a gap and use replay to recover.

**Inbound**: each WebSocket has a per-connection rate limit (default 50 ops/sec sustained, burst 100). Excess input frames are dropped with `error` (no `id`), code `E_RATE`. This protects the player host from a misbehaving or malicious client saturating its host's request budget.

Both limits are configurable per-world via `$server_options.connection_*`.

### 17.6 Optimistic local update + reconcile

Recommended UI pattern for low-latency interactive state (e.g., dragging a knob in the dubspace).

A client predicting the outcome of a sequenced call may apply the change locally *before* receiving the canonical `applied`:

1. User drags a knob to value V.
2. Client UI applies V locally and renders immediately.
3. Client sends `{op: "call", id, space, message}`.
4. When the corresponding `applied` arrives:
   - If the materialized value matches the optimistic prediction, do nothing (the prediction was right).
   - If it differs (a concurrent call won the race), snap the UI to the canonical value.

Pattern is purely client-side; the protocol does not need a special opcode for it. Mentioned here because it is the recommended way to keep gesture latency invisible without adding latency-hiding primitives to the wire format.

Optimistic prediction must be paired with sequenced calls and gap recovery — otherwise a missed `applied` frame leaves the UI showing a stale prediction indefinitely.

### 17.7 World-to-world variant (reserved)

Cross-world calls use a separate wire variant — HTTPS POST origin-to-origin, not WebSocket — specified in [../deferred/federation.md §24](../deferred/federation.md#24-federation). v1 implements neither an inbound peer endpoint nor an outbound peer client; the `origin` and `signature` reservations on the message and applied envelopes are documented in federation.md so the wire is forward-compatible.

### 17.8 Frames not in first-light

The following frames may exist in later iterations but are deliberately not part of the first-light wire:

- `op: "input"` — text-input parsing handled by a player's `:on_input` verb. Belongs to the chat-shaped second demo, not dubspace.
- `op: "subscribe"` / `"unsubscribe"` — explicit subscription management. First-light derives subscription from actor-space presence; explicit subscribe is only needed when actors observe many spaces selectively.
- `op: "snapshot"` / `"history"` / `"sync"` — continuity mechanisms for fast reconnect. Replay via `space:replay` (§17.4) covers gap recovery without dedicated frames.

These are noted here so first-light implementations don't accidentally re-derive them and so future-light implementations have a clean place to add them back.
