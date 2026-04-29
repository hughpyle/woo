# Spec Review: Coherence, Tiny Demo, Onboarding Gaps

Date: 2026-04-29

Scope: `spec/` tree, with attention to whether the system is coherent,
implementable, runnable, and compelling; whether the Dubspace tiny demo can be
spun up; and what is missing after the tiny demo for real users, agents, and
developers.

## Verdict

The spec is coherent as a direction and compelling as a product idea. The
strongest move is the new core framing:

> persistent programmable objects plus locally sequenced messages

That gives Woo a cleaner center than "MOO with a modern UI." `$space` is the
right abstraction: a minimal coordination object that sequences messages
without becoming a room, mixer, scheduler, CRDT engine, or global clock.

The system is not yet implementable directly from `spec/` alone. It is
implementable if the first build deliberately targets a smaller "core runtime"
profile:

- one `$space`
- seeded VM bytecode behavior
- persistent object state
- sequenced message dispatch
- websocket clients
- structured observations
- no user-authored code
- no full VM beyond the T0 profile
- no browser-hosted transient VM
- no per-object host fanout for the tiny demo

In other words: yes, we can spin up a tiny Dubspace demo, but only if we avoid
accidentally making the first build prove the entire VM/task-migration system.

## What Works

### The Layering Is Mostly Right

The split between semantics, protocol, reference, and deferred material is
useful. `spec/semantics/core.md` now gives the spec a foundation that both
Dubspace and a MOO-style chat world can share.

### Dubspace Is A Better First Demo Than Chat

Dubspace tests the unique thesis:

- objects are not necessarily spatial things
- messages are causal inputs
- state is materialized from ordered submissions
- UI/sound is primary, not a terminal veneer
- ephemeral presence is distinct from durable coordinated change

The Dubspace demo in `spec/dubspace-demo.md` is compact enough to build and meaningful
enough to prove the architecture.

### LambdaCore Is In The Right Role

The spec correctly treats LambdaCore as reference material, not a compatibility
boundary. The useful inheritance is structural: root object, room, player,
thing, programmer/wizard authority, live editing. The mail/help/editor/builder
surface should not become Woo core.

## Main Blocking Issues

### 1. The First Runtime Profile Is Not Explicit Enough

The spec describes a full system with VM bytecode, task migration, persistent
hosts, transient browser hosts, hibernation, permissions, and federation
reservations. The tiny demo does not need most of that.

Add an explicit "first-light runtime profile" that says:

- behavior is implemented by the T0 VM profile in
  `spec/semantics/tiny-vm.md`
- all Dubspace coordinated objects live under one `$space` host or one storage
  transaction boundary
- clients use structured `call` protocol messages
- no full DSL, task migration, suspension, or transient-host execution is
  required
- no user-authored code is accepted

Without this profile, an implementation agent may try to build the hardest
part of the whole system before the smallest demo exists.

### 2. `$space` Sequencing And Per-Object Hosts Conflict For Shared Invariants

The reference architecture says one persistent host per object. The core model
says one `$space` sequences coordinated mutations. If a Dubspace message is
sequenced by `$mix` but mutates `#delay`, `#channel`, or `#scene` hosted
elsewhere, the sequence does not by itself make the mutation atomic.

For the tiny demo, pick one:

- `$space` owns the materialized state for its child/control objects, or
- all coordinated objects in one space are co-located on one persistent host, or
- `$space:call` uses a transaction protocol across targets.

The third option is too much for first light. The first two are runnable.

### 3. Wire Protocol Does Not Yet Match Woo-Core

`spec/protocol/wire.md` still centers `op: "call"` and `op: "event"`. The
core operation is simpler: dispatch a message through a space and learn the
canonical sequenced result. The tiny demo needs this capability:

```ts
{ op: "call", id, space, message }
{ op: "applied", id?, space, seq, message, observations }
{ op: "error", id?, code, message }
```

The word `call` is not misleading here: the message names a target object and
verb. `submit` overemphasizes the sequencing/log mechanism; `do` is too vague
for an inspectable API.

Snapshot, history, and sync frames are continuity mechanisms, not core
requirements. They become useful for reload, late join, reconnect, and gap
recovery, but they should not be presented as fundamental to sequenced message
dispatch.

### 4. Persistence Lacks A Minimal Space Sequence Record

`spec/reference/persistence.md` still mostly specifies per-object MOO-like
state: object rows, prop defs, prop values, verbs, tasks, sessions. The tiny
demo needs at least one durable sequence record:

- `space_message`

The current schema does not yet say where accepted sequenced messages live.
That is a direct blocker for `$space:call`.

Materialized state, snapshots, history pagination, and subscription indexes are
useful next layers, but the fundamental requirement is only that accepted
messages receive stable `seq` values and can drive deterministic application.

### 5. Message Application Semantics Need One Failure Rule

`core.md` says applying a message runs behavior and commits mutations.
`events.md` sketches `$space:call`. The spec still needs a precise rule for
failure:

- If validation fails before sequencing, does `seq` advance? Probably no.
- If behavior fails after sequencing, is the message kept? Probably yes.
- Are partial mutations rolled back? For first light, they should be.
- Does failure emit an `applied` observation, an `error` observation, or both?
- Can a failed message be replayed deterministically?

This rule is needed before agents implement storage and client reconciliation.

### 6. Value Model Is Still Missing

`language.md` gives a type list, but there is no complete value contract.
Before a runnable demo, we need at least:

- canonical JSON encoding
- equality
- object reference encoding
- map key rules
- number bounds
- null/boolean treatment
- error representation
- message serialization

This does not need the full DSL, but it does need a stable wire/storage value
format.

### 7. Identity, Session, And Actor Lifecycle Are Underspecified

Tiny demo can use anonymous guests, but even that needs:

- how an actor id is assigned
- whether reconnect restores the same actor
- whether two tabs can share one actor
- how sessions subscribe to a space
- how permissions work for "connected players can perform"

After tiny demo, this becomes a major onboarding issue for people and agents.

### 8. Events/Observations Are Conceptually Fixed But Operationally Mixed

The synonym note between event and observation is fine, but operationally the
spec still mixes several contracts under `emit`:

- durable sequenced `applied` observations
- persistent audit/log events
- ephemeral presence/cursor/gesture-progress events
- client transport events

This is workable, but the first implementation should use separate internal
types even if the public API uses `event`.

### 9. User-Authored Behavior Is Deferred But The On-Ramp Is Not Defined

The tiny demo explicitly excludes user-authored code. That is correct. But the
project goal requires a path after tiny demo:

- inspect objects
- create objects
- edit properties
- define behaviors
- test behaviors safely
- publish/reuse base objects
- recover from bad edits

Right now the spec has VM/DSL detail but not the developer product around it.
That product is what makes "programmable world" real.

## Can We Spin Up The Tiny Demo?

Yes, with a constrained implementation.

Minimum runnable architecture:

1. TypeScript server.
2. One durable world store.
3. One seeded `$dubspace`.
4. Objects represented as records with `id`, `parent`, `owner`, and `props`.
5. Seeded T0 VM bytecode verbs for generic message handling:
   - read arguments
   - set a property
   - emit an observation
   - return or fail
6. `$space:call` assigns `seq`, appends message, applies handler in one
   transaction, stores materialized state, emits observation.
7. Browser client connects, receives initial materialized state, renders four
   loop slots, filter, delay, one scene.
8. Web Audio renders simple local loops; server is authoritative only for
   shared control state.

This is enough to prove:

- mutable persistent world
- two connected actors
- ordered shared changes
- reconnect/reload recovery
- persistent vs ephemeral distinction

It does not prove:

- full MOO-style verb dispatch beyond T0
- task migration
- browser-hosted transient objects
- suspend/hibernate
- user-authored code
- federation

That is acceptable. The tiny demo should prove woo-core, not the entire future.

## Missing Framework After Tiny Demo

After Dubspace runs, the missing framework is not mainly audio or Cloudflare.
It is onboarding: how people, agents, and developers discover, modify, and
extend the world.

### For People

Needed:

- account or guest entry flow
- stable actor/player identity
- invitation or room/space link
- basic profile/presence
- "what can I do here?" affordance discovery
- safe reset/recovery when controls or objects get into a bad state
- permissions understandable in UI terms

### For Agents

Needed:

- structured API separate from human UI gestures
- auth token/scoped actor identity
- object/schema discovery endpoint
- list available spaces/objects/verbs/events
- call with idempotency key
- optionally sync snapshot/history for continuity
- observe event stream
- rate limits and attribution

Agents need affordances, not screen scraping. They should be able to ask:

```text
What spaces can I access?
What objects are in this space?
What calls can I make?
What schemas describe the expected args/events?
What happened since seq N?
```

### For Developers / Builders

Needed:

- object browser
- property inspector/editor
- behavior editor
- schema editor
- message console
- history/replay viewer
- permission editor
- version history and rollback
- package/import/export story for reusable object sets
- local test harness for a space
- deployment/migration path for world changes

LambdaCore had many of these as in-world text commands and editors. Woo needs
the equivalent, but UI/API-first.

### For Programmability

The VM/DSL spec is detailed, but the product path is missing:

- when does user-authored code become available?
- what is the first safe subset?
- how is code reviewed or sandboxed?
- how does a developer test a behavior against recorded messages?
- how does a bad behavior get disabled?
- how are object libraries shared?

This should become an "authoring framework" spec before the system claims to
support real builders.

## Recommended Next Spec Additions

1. `spec/semantics/values.md`
   Canonical value encoding, equality, references, errors, JSON/wire/storage
   form.

2. `spec/semantics/space.md`
   `$space` normative behavior: call, validate, sequence, apply, rollback.
   Keep history/snapshot/subscription as continuity extensions.

3. `spec/semantics/tiny-vm.md`
   T0 VM profile for first light: synchronous local bytecode, seeded verbs,
   local property reads/writes, observations, rollback-on-failure.

4. `spec/protocol/core-wire.md`
   First-light websocket frames: ready, call, applied, error. Add sync,
   snapshot, history, observation streams, and ephemeral events only when the UI
   needs continuity or presence.

5. `spec/reference/space-persistence.md`
   Minimal sequence record for accepted space messages. Add materialized state,
   snapshots, and subscriptions as separate layers.

6. `spec/semantics/identity.md`
   Actor/session/account lifecycle for guests, people, and agents.

7. `spec/semantics/bootstrap.md`
   Minimal base objects and handlers for `$space`, `$actor`, `$player`,
   `$dubspace`, and later `$room`.

8. `spec/authoring/README.md`
   Developer/builder onboarding model: inspect, create, edit, test, publish,
   rollback.

9. `spec/semantics/failures.md`
   Consolidated failure table: validation failure, handler failure, duplicate
   call, reconnect, gap recovery, recycled object, version skew, browser
   disconnect.

## Compelling System Assessment

The compelling version of Woo is not "a distributed MOO clone." It is a
programmable shared medium where abstract spaces can coordinate stateful
objects and expose live interfaces.

Dubspace demonstrates that better than chat. Chat should still be built soon
afterward because it validates the LambdaMOO lineage: players, rooms, speech,
presence, and live object behavior. But chat should be the second proof, not
the conceptual center.

The spec is close to an implementable plan if the next pass narrows the tiny
demo into a first-light profile and adds the missing core contracts above.
