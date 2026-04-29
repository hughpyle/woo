# Hosts and execution model

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**. Implementation specifics (Durable Objects, alarms, persistent storage schema) are in the [reference layer](../reference/cloudflare.md).

The abstract model of hosts: where verb code can run, how tasks move between hosts, the trust boundary classes.

---

## 3. Hosts and execution model

There are exactly three host classes. The VM bytecode and semantics are identical across all of them; only routing differs.

| Host | Lifetime | Hosts | Identifier sigil |
|---|---|---|---|
| **Edge** | Per-request worker isolate | Compiler, router, no objects | n/a |
| **Persistent** | Long-lived, hibernating actor | Persistent objects | `#` |
| **Transient** | Bounded by a client connection | Transient objects | `~` |

### 3.1 Task migration as universal RPC

Execution is task-oriented. A **task** is a serialized activation stack. The two operations that cross host boundaries are:

- **Property access on a remote object** (`OP_GET_PROP`, `OP_SET_PROP`): the task yields, an RPC fetches/writes the value, the task resumes with the result on its operand stack. The task does *not* migrate.
- **Verb dispatch onto a remote object** (`OP_CALL_VERB`): the task migrates. The current host serializes the active frame's continuation, ships it to the receiver's host, the receiver pushes a new frame for the verb body and runs. On `OP_RETURN`, the receiver ships the return value back to the originating host, which deserializes and resumes the caller's frame.

Migration is symmetric across all three host classes. A verb call from a persistent host onto a transient-hosted object goes through the player's persistent host over the existing client connection; from the program's perspective it is the same opcode.

### 3.2 Routing

- Persistent objects are addressed by `#id`. The id is also the persistent host's name; resolution is direct, no intermediate lookup. (See [../reference/cloudflare.md §R1.1](../reference/cloudflare.md#r11-routing) for the v1 mapping.)
- Transient objects are addressed by `~id` *qualified by* a host ref, e.g. `~3@#42` (transient #3 hosted on persistent #42's session). The `@` qualifier is implicit when the ref is constructed via the host's own client; written form uses the qualified syntax.
- A transient ref is invalidated when its host's connection closes. Calls to invalidated refs raise `E_GONE`.

### 3.3 Trust model across hosts

- Persistent hosts within the same deployment trust one another at the protocol layer. RPC payloads are not cryptographically signed; deployment-internal trust is sufficient.
- Persistent hosts do **not** trust transient hosts. Any task that has migrated into a transient host and returned must have its return value validated at the trust boundary. State stored in transient objects is not authoritative.
- A task's effective permission is the verb owner's permission (`progr`), set at compile time and carried in every frame. A transient host cannot elevate `progr` by tampering with the migrated frame; the originating persistent host retains the canonical task identity and re-stamps it on return.

### 3.4 Task migration invariants

The protocol-level invariants that make task migration sound:

**1. One-task-one-host.** A task is owned by exactly one host at a time. Migration is ownership transfer, not duplication. The originating host serializes the task and ceases to own it; the receiving host materializes it and is the sole executor until the next migration or task completion.

**2. Idempotency via correlation id.** Every cross-host RPC carries a `correlation_id`. Receivers maintain a recent-replies cache (TTL ~5 minutes) keyed by correlation id. A duplicate request returns the cached reply rather than re-executing. Transient network failures with retries are therefore safe.

**3. Originator authoritative for transient-host returns.** A task that migrated into a transient host and returned has its identity fields (`progr`, `player`, `caller`, `task_id`) re-stamped from the originator's stored copy on receipt. Returned values are inputs to the originator, not authoritative state.

**4. Bytecode versioning on serialized tasks.** Every serialized task carries `vm_version`, and each frame carries the `(definer, verb, version)` triple of its running bytecode. On resume, if the running VM rejects the version, the task raises `E_VERSION` and aborts cleanly — never silently runs against incompatible code.

**5. Mid-task host crash.** A task whose host crashes mid-execution is lost if not yet checkpointed. Tasks in the host's persistent task table (`suspended`, `awaiting_read`, `awaiting_call`) survive the crash; tasks running in memory do not. Authors of long-running mutations should checkpoint via `suspend(0)` periodically.

**6. Failure-mode summary.**

| Mode | Behavior |
|---|---|
| Originator hibernates mid-RPC | Reply is queued by the platform; on wake, originator resumes from `awaiting_call`. |
| Receiver crashes before replying | Originator times out (`E_TIMEOUT`). Work on receiver was either uncommitted (lost cleanly) or partially committed (next access sees torn state — author's responsibility to bound). |
| Network partition | Same as receiver crash from originator's view. |
| Duplicate reply | Originator drops the duplicate (correlation id seen). |
| Version skew | `E_VERSION` raised; task aborts cleanly. |
