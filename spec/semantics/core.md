# Woo Core Model

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**. Profile: **v1-core**.

Woo-core is the smallest model needed for persistent, programmable, multi-user
worlds. It is inspired by LambdaMOO's object system, but it does not assume a
text interface, rooms as the only locality, or a single global execution queue.

The core claim:

> Woo is persistent programmable objects plus locally sequenced messages.

Everything else -- rooms, chat, dub spaces, editors, builders, workflows, games,
media renderers -- is built on that substrate.

---

## C1. Objects

An object is a persistent identity with state and behavior.

Minimum fields:

| Field | Meaning |
|---|---|
| `id` | Stable object reference. |
| `parent` | Optional single parent for inherited behavior and property definitions. |
| `owner` | Actor with administrative authority over the object. |
| `properties` | Named durable values. |
| `verbs` | Named behaviors that can be invoked by messages. |

Objects are not necessarily spatial things. A room, mixer, loop slot, player,
document, control, and renderer may all be objects.

---

## C2. Values

Core values must be serializable and comparable:

- scalar values: integers, floats, strings, booleans, null
- object references
- lists
- string-keyed maps
- errors

The detailed type rules live in [language.md](language.md). The canonical value
contract — equality, JSON encoding, error structure, message serialization — is
in [values.md](values.md). Woo-core only requires that messages, properties,
observations, and snapshots can all be encoded as values.

---

## C3. Messages And Calls

A message is the unit of requested action.

```js
{
  actor: ObjRef,
  target: ObjRef,
  verb: string,
  args: Value[],
  body?: Map
}
```

Actors make calls by sending messages to target objects. Applying a message
resolves the target behavior, runs it with the actor's authority, and may
produce mutations, observations, errors, and further messages.

The preferred API term is **call**. The message is the payload; the call is the
act of asking Woo to apply it. "Submit" may appear informally when discussing
queues or logs, but it is not the core operation name. "Do" is avoided because
it is too vague for an API that agents and developers must inspect.

Messages are distinct from observations:

- a **message** requests a change or action
- a **mutation** changes durable state
- an **observation** is emitted for clients, renderers, or other objects

---

## C4. Spaces and Sequences

`$space` is the minimal coordination primitive. It does one thing: assigns a
local order to calls/messages. The normative call lifecycle, failure rules, and
snapshot mechanics are in [space.md](space.md).

Minimum behavior:

```text
$space:call(message) -> sequenced_message
$space:history(after_seq, limit) -> list
```

A sequenced message adds:

```js
{
  space: ObjRef,
  seq: int,
  message: Map
}
```

Rules:

- `seq` is monotonically increasing within one `$space`.
- Messages called through one `$space` are applied in `seq` order.
- `$space` does not interpret domain-specific message bodies.
- `$space` does not impose ordering outside itself.
- No world-level clock is required for message ordering.

Objects that need coordinated mutation call through a `$space`. Objects that
do not need coordination can receive direct messages.

---

## C5. Actors

An actor is an object allowed to make calls. A human player, agent, server
process, scheduled task, or imported peer may all be actors.

Core actor requirements:

- identity for authorization and attribution
- ability to make calls
- ability to receive observations, directly or through a renderer

`$player` is a conventional actor used by interactive clients. It is not the
only actor kind.

---

## C6. Applying Messages

Applying a sequenced message follows this shape:

1. Check that the actor may call through the space.
2. Resolve `target`.
3. Resolve `verb` on the target using the standard lookup rule.
4. Check authority.
5. Run the behavior.
6. Commit resulting durable mutations.
7. Emit observations.

Within one `$space`, conflicting coordinated mutations are resolved by sequence
order. Across spaces, Woo-core promises no implicit total order.

---

## C7. State, History, and Snapshots

Woo-core supports both current-state and history-oriented implementations.

- **Durable state** is the current materialized state of objects.
- **History** is the ordered messages a space has accepted.
- **Snapshots** are cached materializations used for fast reload or recovery.
- **Transient state** is client-local or session-local and may be discarded.

The core does not require that every object be event-sourced forever. It does
require that a `$space` can expose enough recent history for synchronization,
debugging, and late join.

---

## C8. Observations

Observations are structured values emitted by applied behavior. The semantics layer's [events.md](events.md) calls these *events*; same concept, different name. The naming distinction matters in core.md because the message/mutation/observation triad is the conceptual frame; in the rest of the spec "event" is the established API and wire term.

Examples:

```js
{ type: "speech", actor: "#p1", body: "hello" }
{ type: "control_changed", target: "#delay", prop: "feedback", value: 0.72 }
{ type: "presence", actor: "#p2", status: "joined" }
```

Observations may be delivered to actors, renderers, objects, logs, or clients.
They are not the same thing as messages sent by calls, although a behavior may emit
an observation corresponding to a message it applied.

---

## C9. Minimal Chat World

A MOO-style chat world can be built from:

- `$space`
- `$object`
- `$actor`
- `$player < $actor`
- `$room < $space`

Basic flow:

```js
$lobby:call({
  actor: "#alice",
  target: "$lobby",
  verb: "say",
  args: ["hello"]
})
```

The room sequences the message, applies `:say`, and emits a speech observation
to current participants.

This is the **logged social interaction** variant: useful when utterances should
be durable/auditable. The default chat-demo surface uses direct `:say` calls
instead, so speech observations are live-only and do not advance the room's
sequence. See [chat DESIGN.md](../../catalogs/chat/DESIGN.md) and [§C13](#c13-call-discipline).

This captures LambdaMOO's useful room behavior without making "room" the
universal core primitive.

---

## C10. Minimal Dubspace

The tiny Dubspace demo can be built from:

- `$space`
- `$actor`
- `$dubspace < $space`
- `$loop_slot`
- `$channel`
- `$filter`
- `$delay`
- `$scene`

Basic flow:

```js
$mix:call({
  actor: "#alice",
  target: "#delay",
  verb: "set_feedback",
  args: [0.72]
})
```

The dubspace sequences the message, applies the delay update, materializes the
new control value, and emits an observation for connected renderers.

Gesture samples that affect the shared mix are messages. Pure UI presence hints
may remain transient observations.

---

## C11. LambdaCore As Reference, Not Boundary

LambdaCore's root, room, player, thing, container, note, programmer, and wizard
objects are useful design references:

- root object: common naming, description, matching, notification
- room: local coordination and audience
- player: interactive actor and presentation endpoint
- thing/container/note: persistent mutable object patterns
- programmer/wizard: authority and live editing

Woo-core should learn from these structures without inheriting LambdaCore's
full command set, mail system, help system, editor stack, or text-first
assumptions as core requirements.

---

## C12. Direct messages vs space-mediated messages

Two ways for a call to reach a target:

- **Direct dispatch.** Caller invokes `target:verb(args)`. The runtime resolves the verb using the standard lookup rule (parent chain, then feature lookup where applicable; see [objects.md §9.1](objects.md#91-lookup)), runs the behavior on the target, and emits any observations. No coordination point. Used when the target's state doesn't need ordering relative to other concurrent calls, or when the target *is* the coordination boundary (every persistent object is a single-threaded actor).
- **Space-mediated call.** Caller does `space:call({actor, target, verb, args})`. The space assigns a sequence, applies the message in `seq` order, emits an `applied` observation carrying the seq. Used when multiple actors mutate the same shared state and need a total order beyond the per-actor scheduler.

Both produce mutations and observations. The difference is whether a `$space` is in the path.

`OP_CALL_VERB` (see [vm.md §8.3.6](vm.md#836-verb-dispatch)) implements direct dispatch. `$space:call` is a verb whose body sequences and then performs direct dispatch on the target — there is no special runtime support for spaces beyond what verbs and properties already provide.

> **Being a `$space` does not mean every verb on the object is sequenced. Only calls made through `$space:call` enter the space sequence.** A `$space` may also have direct-callable verbs (`:look`, `:who`, `:say`); those bypass the log entirely. Conversely, calling a non-space object's verb through `$space:call({target, verb, args})` *does* sequence it. The space contract is per-call, not per-object.

### C12.1 Two orthogonal axes

Verb-call decisions break into two independent choices. Observation durability is *not* a third axis — it follows from the route, automatically.

| Axis | Choices | Question it answers |
|---|---|---|
| **Invocation route** | direct (`obj:verb`) vs `$space:call` | Does this allocate a space seq and enter the replay log? |
| **Mutation durability** | mutating vs read-only vs session/routing state | Does the verb change persistent world state? |

The axes are independent. A direct call may mutate persistent state (it just doesn't enter any space's log). A read-only verb usually emits nothing at all and mutates nothing.

> **Observation durability follows the invocation route.** Observations emitted while applying a sequenced `$space:call` are part of the resulting applied frame and replay-visible. Observations emitted from a direct call are live-only — pushed to subscribers, never stored. See [events.md §12.6](events.md#126-observation-durability-follows-invocation-route).

This collapses what looked like a third axis into a consequence. To make an observation durable, route the call that emits it through `$space:call`. To keep it live-only, call directly. There is no separate "ephemeral" flag to set.

The bad pattern this rules out: a sequenced state mutation that also emits transient side-chatter is mixing two routes in one body. Don't piggyback typing indicators on `:set_status`; emit them from a separate `:typing` direct call.

### C12.2 External direct-call gate

External clients and agents may not invoke arbitrary verbs directly just because direct dispatch exists. Verb metadata includes `direct_callable: bool`, default `false`. External ingress surfaces — WebSocket `op: "direct"`, REST calls with no `space`, and similar APIs — reject direct calls to verbs without this annotation with `E_DIRECT_DENIED`.

Spec tables use `rxd` as shorthand for "readable/executable and externally
direct-callable" — equivalent to `direct_callable: true` on the verb metadata.
`rx` means readable/executable but not externally direct-callable unless the
metadata says otherwise. Implementations normalize `rxd` at ingestion to stored
`perms: "rx"` plus `direct_callable: true`; the metadata field is authoritative
after install.

This gate applies to **external ingress**, not to VM-to-VM `CALL_VERB` inside an already-running task. A sequenced call handler may call helper verbs directly as part of its own transaction; normal verb permissions still apply. `$space:call` also bypasses the external direct gate because the caller chose the sequenced route.

Reads and live-only interaction verbs (`:describe`, `:look`, `:who`, `:say`, `:typing`, dubspace `:preview_control`) are typical `direct_callable: true` verbs. Mutating shared-state verbs default to `false` so clients and agents must route them through a space.

---

## C13. Call discipline

Five canonical patterns. New verbs should match one; if a verb resists classification, the design is probably mixing two.

| Pattern | Route | Logged? | Use For |
|---|---|---|---|
| **Sequenced shared mutation** | `$space:call(message)` | yes | task transitions, dubspace controls, workflow gates — anywhere multiple actors need totally-ordered changes to shared state. |
| **Direct read** | `obj:verb()` | no | `:describe`, `:look`, `:who`, `:has_feature` — pure introspection. |
| **Direct authoring/versioned mutation** | host-direct verb or REST authoring API | no (separate audit log) | IDE install, `compile_verb`, `define_property`. Versioned, but not a runtime sequence. |
| **Direct live interaction** | `obj:verb()` (observations live-only by route) | no | chat `:say`, `:tell`, `:emote`, presence `:enter`/`:leave`, typing indicators, hover. The interaction is real-time-only; replay would not reproduce it. |
| **Logged social interaction** | `$space:call(message)` or an explicit log-append wrapper | yes | moderated/auditable chat, compliance-mandated message archives. The author opts into durability. |

Most v1-core verbs land in the first two patterns. Live-only interaction and authoring need explicit design choices about delivery and audit; logged social is opt-in only.
