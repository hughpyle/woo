# Events and schemas

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**. Profile: **v1-core**.
>
> **Terminology note.** `core.md` calls these *observations* (to distinguish from messages and mutations). This document calls them *events* — same concept, different name. The distinction `core.md` draws (message → mutation → observation) is real and useful; we use "event" here because the API and wire surface (`emit`, `op: "event"`, `event_schema`) named it that way first. Treat the terms as synonyms.

Covers `emit` semantics, event reception via `:on_<type>`, and per-object event-type schema declaration.

---

## 12. Events and messaging

### 12.1 Primitive

```
emit(target, event)
```

- `target`: an `obj`, a `list` of objs, or the result of an audience builder (`$audience.in(room)`, etc.).
- `event`: a `map` with at least a `type: str` field. Other fields per-schema.

Delivery is fire-and-forget. `emit` does not return a value; failures (target not reachable) become events on a dead-letter object owned by the emitter, so wizards can audit.

### 12.2 Reception

An object receives events via verbs whose names match `:on_<type>` or generic `:on_event`. Dispatch:

1. Look up `:on_<type>` on the target. If found, call with `(event)`.
2. Else look up `:on_event`. Call with `(event)`.
3. Else silently drop.

Receiver verbs are dispatched as forked tasks (not joined to the emitter's task) so emit is asynchronous from the emitter's view.

### 12.3 Sticky vs transient targets

`emit` to a persistent obj routes to that DO. To a transient ref, routes through the host player DO over the websocket. Cross-host event delivery is just a verb call across hosts.

### 12.4 Strings as degenerate events

`player:tell(s)` is a builtin shorthand for:

```
emit(player, { type: "text", body: s, source: caller });
```

LambdaCore-style `:announce_all`, `:announce_all_but` are not built in. Authors of base classes can implement them in terms of `emit` if they want.

### 12.5 Ordering

Events emitted by a single task are delivered in emit order to each target. Events from different tasks have no guaranteed ordering relative to each other.

### 12.6 Persistent vs ephemeral events

Two delivery contracts share the `emit` primitive:

- **Persistent events** (the default) are durable. Emitters and receivers may rely on a log/sequence record — typical in event-sourced patterns like the dubspace's `$space:call` flow. Eligible for replay, gap recovery, and audit.
- **Ephemeral events** carry transient state that does not need to survive disconnect or be replayable. Cursor positions, "I'm hovering this knob", typing indicators, gesture-in-progress samples.

Same `EMIT` opcode and same wire envelope; the difference is a runtime policy hint, declared either on the event's schema (§13) or by type-name convention.

**Runtime policy for ephemeral events:**

- Best-effort delivery; no retry, no replay, no gap recovery.
- Never persisted: not stored, not logged, not visible to audit queries.
- Per-source rate limit (default 60 events/sec per `(source, type)`); excess dropped at the emitter's host before fanout.
- Receiver-side coalescing by `(source, type)`: queued events of the same key may be collapsed to the latest before delivery.
- TTL: events older than ~1 second on receipt are dropped.
- Drop-oldest under backpressure; persistent events queue, ephemeral events are silently dropped (no `system_overflow` notification).

**Shape constraints for ephemeral events:**

- Required: `type: str`.
- Required: `source: obj`. Receivers index per-source for coalescing; without it, dedupe is undefined.
- Forbidden: a `seq` field. Sequencing is the persistent contract; an ephemeral event carrying `seq` is a category error and is rejected at emit time with `E_INVARG`.
- Recommended: payload < 1 KiB. Hard cap 4 KiB.
- Optional: a sender-supplied `id` for double-send dedupe over flaky networks.

**Discipline (not runtime-enforced):**

- Handlers for ephemeral events should be side-effect-free: no `SET_PROP` on persistent state, no `EMIT` of persistent events, no `FORK`/`SUSPEND`. Violating this leaks non-replayable mutations into nominally-persistent state — the same anti-pattern as a log-handler that mutates state behind the log's back.
- Receivers should not persist ephemeral events. Doing so makes a non-replayable observation durable; reload will not reproduce it.

**How a type is marked ephemeral:**

1. **Schema flag** (preferred). `declare_event` sets `ephemeral: true`; the runtime then treats matching events under ephemeral policy. See §13.
2. **Type-name convention** (for ad-hoc cases without a declared schema). Types beginning `presence:`, `cursor:`, or `gesture-progress:` are ephemeral by default. A declared schema overrides convention.
3. **Per-emit override**. `emit(target, event)` accepts an `ephemeral: true` field at the top level of `event`, but this is discouraged — mixing the durability contract into the data is awkward. Prefer the schema declaration.

### 12.7 Sequenced calls with gap recovery

The pattern an event-sourced object uses to give subscribers a totally-ordered stream they can replay over. See [space.md](space.md) for the full normative behavior of `$space:call`; this section is the *consumer-facing* sequencing pattern.

**Producer side** (the object that owns the log):

```
verb $space:call(message) {
  this.next_seq = this.next_seq + 1;
  let seq = this.next_seq;
  // append to log + apply to materialized state (omitted)
  emit($space.subscribers, { type: "applied", source: this, seq: seq, message: message });
  return seq;
}

verb $space:replay(from_seq, limit) rxd {
  // returns up to `limit` messages with seq >= from_seq, paged
  let upper = min(this.next_seq, from_seq + limit - 1);
  return {
    messages: list_slice(this.log, from_seq, upper),
    next_seq: upper + 1,
    has_more: upper < this.next_seq
  };
}
```

**Consumer side** (each subscriber):

```
// kept on the subscriber: last_seq starts at 0
verb player:on_applied(event) {
  if (event.seq == this.last_seq + 1) {
    this.last_seq = event.seq;
    this:render(event);
  } else if (event.seq > this.last_seq + 1) {
    // gap detected; page through replay
    let from = this.last_seq + 1;
    while (true) {
      let r = event.source:replay(from, 100);
      for m in r.messages { this:render(m); }
      if (!r.has_more) break;
      from = r.next_seq;
    }
    this.last_seq = event.seq;
  }
  // event.seq <= last_seq is a stale duplicate; ignore.
}
```

This composes existing `emit`, properties, and verbs — no new primitive. Named here because every event-sourced object in woo will use this shape, and tooling can recognize the convention.

Snapshots compose with replay: a periodic `$space:snapshot()` writes the materialized state plus the seq it represents; reload is `load_snapshot() + replay(from: snapshot_seq + 1, limit)`.

If a subscriber's gap is unbounded (its `last_seq` is older than the oldest snapshot, or paging would take longer than reloading), it should drop its materialized state, fetch the latest snapshot, and resume tail replay from the snapshot's seq. Reasonable threshold: if the gap exceeds twice the snapshot interval, reload.

Ephemeral events (§12.6) are explicitly *not* sequenced — they carry no `seq` field and have no replay path.

---

## 13. Schemas

Objects may declare event schemas:

```
declare_event #room "say" {
  source: obj,
  body: str,
  body_to_self?: str
};

declare_event $space "cursor" {
  source: obj,
  x: float,
  y: float,
  ephemeral: true
};
```

This is sugar for storing a JSON-Schema-shaped map under the `event_schema` table on the declaring object.

Schemas are **advisory in v1** for field types and required fields: they're introspectable (`event_schema(obj, type)` builtin) but not enforced at `emit` time. Tooling and agents can use them to construct valid events. Phase-2 may add enforcement as an opt-in flag.

The `ephemeral: true` flag, however, *is* enforced from day one — it picks runtime delivery policy (§12.6) and rejects mismatched `seq`-bearing events at emit.

Inheritance: schemas declared on an ancestor are visible to descendants (chain walk). Descendants may *extend* (add optional fields) but not *redefine* (change required field types). The `ephemeral` flag, once declared on an ancestor, cannot be flipped by a descendant.

Base objects ship a small core schema set: `text`, `say`, `emote`, `enter`, `leave`, `look`, `take`, `drop` (persistent), plus `presence:hover`, `presence:idle`, `cursor` (ephemeral). New event types are open-world; objects don't have to declare a schema to emit one, but undeclared types follow the type-name convention for durability (see §12.6).
