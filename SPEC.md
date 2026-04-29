# woo — specification

A globally distributed successor to LambdaMOO. Programmable persistent objects, single-parent inheritance, modernized types, structured event messaging. v1 runs on a single vendor's edge (Cloudflare); cross-operator federation is reserved for v2.

> Status: working draft. Section numbers in headers are stable references for conversation.

---

## 1. Vision

**woo** is a multi-user, persistent, programmable world. Every object is independently addressable and stateful. Users (human or agent) connect over websockets, inhabit a player object, and interact by emitting events and invoking verbs on other objects. Objects can be edited and reprogrammed at runtime by sufficiently privileged users; all code is sandboxed in a custom bytecode VM with tick metering and per-task memory caps.

The system is **globally distributed** — every object is its own actor, hosted at the edge, with no single process or node carrying the whole world. v1 runs within one vendor's namespace. Cross-operator federation (the broader sense of "decentralized") is designed but deferred to v2.

The system is **infrastructure, not UI**. The chat-text interface is one renderer. The wire protocol is structured events. Browser-hosted "transient" objects participate in the same execution model as server-hosted persistent ones.

---

## 2. Concepts and terminology

| Term | Meaning |
|---|---|
| **Object** | A persistent, individually addressable entity. Holds properties, verbs, location, parent, owner. |
| **Persistent object** | Server-hosted; one persistent host per woo object. Identifier prefix `#`. |
| **Transient object** | Client-hosted (typically browser); lifetime bounded by the connection. Identifier prefix `~`. |
| **Verb** | Callable code attached to an object. Dispatched by name, walks parent chain. |
| **Property** | Named slot on an object. *Defined* on an ancestor (with default + perms); *value* per object. |
| **Player** | An object that has an attached client connection. Just an object, not a separate type. |
| **Task** (VM) | A serializable activation stack; the unit of execution. Migrates between hosts on verb dispatch. Also called a *VM activation* when distinguishing from a taskspace's work-item "task" (see `spec/taskspace-demo.md`). |
| **Host** | Anything that can run a VM: an edge worker, a persistent host, or a transient host. |
| **Event** / **Observation** | A structured map (`{type, ...}`) emitted from one object to one or more listeners. The two terms are synonyms: `core.md` says "observation" to distinguish from messages and mutations; `events.md` and the wire/API say "event" by historical naming. |
| **Renderer** | Code that turns events into a presentation. Usually a transient object. |
| **Wizard** | A flag on an object granting elevated permissions. |

---

## Layers

The spec is split into four layers. Implementation references in semantics and protocol layers are explicit pointers to reference; you can read semantics + protocol without committing to Cloudflare.

| Path | Layer | Contents |
|---|---|---|
| [spec/semantics/](spec/semantics/) | **semantics** | Language and object model. Implementation-neutral. |
| [spec/protocol/](spec/protocol/) | **protocol** | Host classes, wire format, browser bootstrap. |
| [spec/reference/](spec/reference/) | **reference** | Concrete Cloudflare mapping. v1 only. |
| [spec/deferred/](spec/deferred/) | **deferred** | Not in v1. Federation, capabilities, audio. |

### Semantics
- [core.md](spec/semantics/core.md) — woo-core: objects, messages, spaces, actors, observations
- [values.md](spec/semantics/values.md) — value contract, equality, canonical serialization (V1–V11)
- [objects.md](spec/semantics/objects.md) — object model, identity, verb dispatch, properties (§4, §5, §9, §10)
- [space.md](spec/semantics/space.md) — `$space` normative behavior: call lifecycle, failure rules, snapshots (S1–S10)
- [identity.md](spec/semantics/identity.md) — actor, session, auth lifecycle (I1–I8)
- [bootstrap.md](spec/semantics/bootstrap.md) — seed object graph: universal classes, demo classes, instances (B1–B8)
- [introspection.md](spec/semantics/introspection.md) — `:describe()` convention and discovery surface (N1–N6)
- [language.md](spec/semantics/language.md) — types, DSL syntax (§6, §7)
- [vm.md](spec/semantics/vm.md) — bytecode, opcodes, scheduling, metering (§8)
- [tiny-vm.md](spec/semantics/tiny-vm.md) — T0 VM profile for the first demo, with concrete fixtures
- [permissions.md](spec/semantics/permissions.md) — perms, wizard, trust, quotas (§11)
- [events.md](spec/semantics/events.md) — emit, schemas (§12, §13)
- [tasks.md](spec/semantics/tasks.md) — lifecycle, suspend, fork, read (§16)
- [builtins.md](spec/semantics/builtins.md) — builtins, errors (§19, §20)

### Protocol
- [hosts.md](spec/protocol/hosts.md) — three host classes, task migration, trust boundaries (§3)
- [wire.md](spec/protocol/wire.md) — JSON message format (§17)
- [browser-host.md](spec/protocol/browser-host.md) — transient host bootstrap (§18)

### Reference (Cloudflare)
- [cloudflare.md](spec/reference/cloudflare.md) — host-class mapping, routing, hibernation (R1–R4)
- [persistence.md](spec/reference/persistence.md) — per-object SQLite schema, caching (§14, §15)
- [quotas.md](spec/reference/quotas.md) — QuotaAccountant DO (R5)

### Deferred
- [federation.md](spec/deferred/federation.md) — cross-world interop (§24)

### Authoring
- [minimal-ide.md](spec/authoring/minimal-ide.md) — first Web IDE and authoring primitives (A1–A11)

---

See [LATER.md](LATER.md) for the informal todo list — open items, sketches, gaps, decisions still pending. Not commitments.

Loose docs alongside the spec layers:
- [spec/vision.md](spec/vision.md), [spec/dubspace-demo.md](spec/dubspace-demo.md), [spec/taskspace-demo.md](spec/taskspace-demo.md), [spec/README.md](spec/README.md) — author's working docs.
