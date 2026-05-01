# Hosts and execution model

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**. Profile: **v1-core**. Implementation specifics (Durable Objects, alarms, persistent storage schema) are in the [reference layer](../reference/cloudflare.md).

The abstract model of hosts: where verb code can run, how tasks move between hosts, the trust boundary classes.

---

## 3. Hosts and execution model

There are exactly three host classes. The VM bytecode and semantics are identical across all of them; only routing differs.

| Host | Lifetime | Hosts | Identifier sigil |
|---|---|---|---|
| **Edge** | Per-request worker isolate | Compiler, router, no objects | n/a |
| **Persistent** | Long-lived, hibernating actor | Persistent objects | `#` |
| **Transient** | Bounded by a client connection | Transient objects | `~` |

### 3.1 Async host RPC

Execution is task-oriented. A **task** is an activation stack owned by one host at a time. The two operations that cross host boundaries are:

- **Property reads on a remote object** (`OP_GET_PROP`): the task yields, an RPC fetches the value, the task resumes with the result on its operand stack. The task does *not* migrate. Raw remote property writes are rejected with `E_CROSS_HOST_WRITE`; cross-host mutation is expressed as verb dispatch so the receiving host owns its own permission checks, transaction boundary, and audit trail.
- **Verb dispatch onto a remote object** (`OP_CALL_VERB`): the caller awaits a routed dispatch RPC. The origin host keeps the caller's continuation; the receiver runs the callee frame under the caller's authority and returns `{result, observations}`. The origin resumes its own frame at the call site.

The opcode shape is symmetric across all three host classes. A verb call from a persistent host onto a transient-hosted object goes through the player's persistent host over the existing client connection; from the program's perspective it is the same `CALL_VERB` yield point.

### 3.2 Routing

- Persistent objects are addressed by `#id`. The id is also the persistent host's name; resolution is direct, no intermediate lookup. (See [../reference/cloudflare.md §R1.1](../reference/cloudflare.md#r11-routing) for the v1 mapping.)
- Transient objects are addressed by `~id` *qualified by* a host ref, e.g. `~3@#42` (transient #3 hosted on persistent #42's session). The `@` qualifier is implicit when the ref is constructed via the host's own client; written form uses the qualified syntax.
- A transient ref is invalidated when its host's connection closes. Calls to invalidated refs raise `E_GONE`.

### 3.3 Trust model across hosts

- Persistent hosts within the same deployment trust one another only after the transport adapter authenticates the internal envelope. The Cloudflare reference signs gateway/Directory/cluster-host requests with `WOO_INTERNAL_SECRET`; other deployments need an equivalent same-deployment authentication layer before accepting forwarded `actor`, `session`, `progr`, or mutation data. v1 uses timestamp freshness for this envelope, not nonce replay protection; the threat model assumes same-deployment internal traffic is not observable. If that assumption changes, reuse the `correlation_id`/recent-replies cache pattern from §3.4.
- Persistent hosts do **not** trust transient hosts. Any call into a transient host must have its return value validated at the trust boundary. State stored in transient objects is not authoritative.
- A task's effective permission is the verb owner's permission (`progr`), set at compile time and carried in every frame. A transient host cannot elevate `progr`; the originating persistent host retains the canonical task identity and treats browser output as untrusted return data.

When a persistent host receives a same-deployment call envelope for an actor it
has not materialized locally, it may create a minimal **actor stub** for that
objref. The stub exists only so local permission checks, presence filters, and
object references can name the actor while the call runs on this host. It must
not grant new flags, session credentials, inventory authority, or ownership
claims; those remain authoritative on the actor's home host.

### 3.4 Host RPC invariants

The protocol-level invariants that make cross-host execution sound:

**1. Origin owns the continuation.** A task's caller continuation stays on the origin host while a remote dispatch is in flight. The receiver owns only the callee frame it was asked to run and returns a value plus observations.

**2. Idempotency via correlation id.** Every cross-host RPC carries a `correlation_id`. Receivers maintain a recent-replies cache (TTL ~5 minutes) keyed by correlation id. A duplicate request returns the cached reply rather than re-executing. Transient network failures with retries are therefore safe.

**3. Originator authoritative for transient-host returns.** A task that called into a transient host has its identity fields (`progr`, `player`, `caller`, `task_id`) retained by the originator. Returned values are inputs to the originator, not authoritative state.

**4. Bytecode versioning on serialized tasks.** Every serialized task carries `vm_version`, and each frame carries the `(definer, verb, version)` triple of its running bytecode. On resume, if the running VM rejects the version, the task raises `E_VERSION` and aborts cleanly — never silently runs against incompatible code.

**5. Mid-task host crash.** A task whose host crashes mid-execution is lost if not yet checkpointed. Tasks in the host's persistent task table (`suspended`, `awaiting_read`) survive the crash; tasks running in memory or awaiting an in-flight RPC do not. Authors of long-running mutations should checkpoint via `suspend(0)` periodically.

**6. Failure-mode summary.**

| Mode | Behavior |
|---|---|
| Originator crashes or hibernates mid-RPC | The uncheckpointed in-memory task is lost; the caller retries if needed. |
| Receiver crashes before replying | Originator times out (`E_TIMEOUT`). Work on receiver was either uncommitted (lost cleanly) or partially committed (next access sees torn state — author's responsibility to bound). |
| Network partition | Same as receiver crash from originator's view. |
| Duplicate reply | Originator drops the duplicate (correlation id seen). |
| Version skew | `E_VERSION` raised; task aborts cleanly. |
