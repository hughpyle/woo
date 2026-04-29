# Identity, sessions, and actors

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**. Profile: **v1-core** (guest auth only; credentialed auth lives in `identity/auth.md`, profile **v1-ops**).

The contract for who is connected, what an actor is, and how a session binds a client to an actor.

First-light scope: enough to support guest connections to a space; enough to specify reconnect, two-tab, and disconnect behavior. **Out of scope** for this version: account creation with credentials, multi-character users, recovery flows, federated identity. Those become part of the post-demo authoring surface — see [LATER.md](../../LATER.md).

---

## I1. Actor

An **actor** is an object that can make calls (per [core.md §C5](core.md#c5-actors)). The runtime treats an actor as a principal:

- has identity (an objref that persists across sessions)
- has authority used in `progr` checks (see [permissions.md §11](permissions.md#11-permissions-and-security))
- is the value of `message.actor` on calls it originates

`$actor` is the conventional base class. `$player` extends `$actor` for actors with attached client sessions.

Not every object is an actor. The runtime decides whether to permit a given object as `message.actor` based on its parent chain (must inherit from `$actor`) and any policy the world layers on top.

---

## I2. Session

A **session** is the binding between a client connection (a websocket) and an actor.

| Field | Meaning |
|---|---|
| `session_id` | opaque identifier (random 128-bit value); the client uses this to reconnect |
| `actor` | objref of the bound actor |
| `started` | ms timestamp |
| `attachment` | small JSON state for hibernation; see [reference/cloudflare.md §R1.4](../reference/cloudflare.md#r14-hibernation) |

A session is established by the `op: "auth"` frame and confirmed by the server's `op: "session"` frame ([wire.md §17](../protocol/wire.md#17-wire-protocol)). One session may have **multiple** attached websockets (I5).

---

## I3. Auth (first-light: guest)

First-light auth is intentionally minimal:

```
client → server: { op: "auth", token: string }
server → client: { op: "session", actor: ObjRef }
```

The token is a string; the server interprets it. First-light vocabulary:

- **`guest:<random>`** — server creates a fresh `$player` (or pulls one from a pre-seeded guest pool), binds it to a new session, and returns the actor's objref. Guest actors persist for the session and a configurable grace period (default 1 hour) after the last websocket detach.
- **`session:<session_id>`** — if the session is alive in the server's session table, auth resumes it. If expired, the server replies with `op: "error"` code `E_NOSESSION`; the client must establish a new session.
- **`bearer:<...>`** — reserved for credentialed auth, post-first-light.

The token vocabulary is server policy; the wire format is `string`. The contract is "the server tells the client what token to present next" — typically by surfacing a `session:<id>` token in the initial `op: "session"` frame's payload (when this is added) or via a side channel.

---

## I4. Reconnect

A client that loses its websocket reconnects with the same `session:<session_id>` token. If the session is alive:

- Actor binding is restored.
- Client receives a fresh `op: "session"`.
- Server resumes pushing `applied` frames for the spaces the actor is observing.
- Client uses gap recovery ([events.md §12.7](events.md#127-sequenced-calls-with-gap-recovery)) to backfill missed seqs per space.

If the session has expired or its guest actor has been recycled, reconnect produces a different actor identity. The client treats this as a fresh login.

---

## I5. Two tabs, one actor

A client may open multiple tabs and present the same `session:<id>` token from each. Default policy:

**Multi-attach.** Each tab gets its own websocket; all bound to the same session and actor. `applied` frames fan out to every attached websocket. Calls from any tab are equally authorized as the actor.

This matches the principle that an actor is an actor regardless of how many UIs render it. Boot-prior (LambdaMOO's `boot_player` model — second connection bumps the first) is a deferred policy choice.

---

## I6. Disconnect lifecycle

When a websocket closes:

1. The session's outbound queue stops draining for that websocket. Other attached websockets continue. If this was the last attached websocket, the session enters a *detached* state.
2. Any task waiting on `READ player` ([tasks.md §16.6](tasks.md#166-read-tasks)) for this session enters a grace period.
3. After the grace period (default 5 minutes), still-detached sessions: their `READ` tasks are killed; their in-memory state is released. The session record itself persists for the broader session timeout.
4. After the session timeout (default 1 hour), the session is reaped: its record is deleted, and a guest actor bound to it is recycled.
5. A non-guest actor (post-first-light) survives session reaping.

---

## I7. Permissions for first-light

For first-light demos, the default policy is "any authenticated guest with presence in the space can call." Concretely:

- `$space:call` accepts any actor whose objref is recorded in the space's presence set.
- A presence record is created on session establishment if the actor is to participate.
- No per-verb perm gating beyond presence.

This is the simplest possible policy. It works for the dubspace demo (every connected actor can wiggle every knob) and is *almost* enough for the taskspace demo, with one obvious refinement.

### I7.1 The per-claimer-update pattern

Taskspace surfaces the first natural sharpening of the open policy: once an actor has *claimed* a task, only that claimer (or a wizard) should be able to mark the task done. This is a five-line check inside the relevant verb:

```
verb #task:set_status(status) {
  if (this.assignee != null
      && progr != this.assignee
      && !is_wizard(progr)) {
    raise(E_PERM);
  }
  this.status = status;
  emit(this.space, { type: "status_changed", source: this, status: status });
}
```

This uses the existing [permissions.md §11.4](permissions.md#114-effective-permission) `progr` discipline — no new machinery. The pattern is "verb-body checks property-stored ownership against `progr`," and it generalizes to "only the assignee can…", "only members can…", "only the owner can…" without per-verb perm bits or capability tokens.

The first-light open policy and this per-claimer pattern between them cover the demo cases. Richer policies (role hierarchies, capability delegation, time-bound permissions) build on the same `progr` mechanism and are post-first-light.

**The pattern is the generic role mechanism.** A "role" in woo is just an actor-typed property on an object; enforcement is just a verb-body check that `progr` matches that property. It scales to N roles by adding more properties and more checks: `task.reviewer` gates `task:review`, `project.approvers` (a list) gates `project:promote`, `project.requestor` (set once, audit-only) is read but never enforced. The runtime prescribes no role taxonomy — pick whatever roles fit the work, and put the gating in the verbs.

---

## I8. What's deferred

- Account creation with passwords or external IdP (OAuth/OIDC).
- Multi-character users (one human, multiple actors, switchable per session).
- Recovery flows (lost token, lost session, account migration).
- Identity federation (cross-world actor refs; reserved at [federation.md §24.2](../deferred/federation.md#242-the-trust-model)).
- Per-verb perm gating beyond presence (hooks exist; policy isn't first-light).
- Audit / wizard view of session-actor history.

All deferred to LATER.
