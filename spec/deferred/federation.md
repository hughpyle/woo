# Federation

> Part of the [woo specification](../../SPEC.md). Layer: **deferred**. Profile: **v2-federation**.

Cross-world interoperation. A "world" is a single deployment with its own object graph, base classes, and policy. Federation is **deferred to v2**; this document specifies the design, reserved syntax, and trust model so that v1 leaves the right hooks in place.

---

## 24. Federation

### 24.1 Scope

A world is a self-contained instance: one Cloudflare Worker namespace, its own `Directory` DO, its own bootstrap object graph, its own user accounts. v1 ships single-world only. Federation is the v2 work of letting independent worlds reference, message, and call each other.

The design here is what v1 must not preclude. Where v1 has a behavior at all, it should default to "this is the local world; federation pieces are reserved-but-noop."

### 24.2 The trust model

There is no global trust root. Trust is operator-to-operator (world-to-world), not user-to-user. The model:

- Each world has an **origin** (a hostname, e.g. `world-a.example`). The TLS certificate for that hostname is the world's authentication.
- World-to-world requests flow over TLS between origins. The receiving world identifies the caller by the TLS hostname.
- Within those requests, the calling world **vouches** for its users: "this action is on behalf of my `#5`." The receiver can trust that vouch or not, on a per-peer basis.
- Per-world policy decides which peers to accept vouches from: open, allowlist, or blocklist.

Granularity: **the trust unit is the world, not the user.** If a peer world is compromised, every user from that peer is effectively compromised in your world. This is the well-known property of SMTP, ActivityPub, Matrix.

A user wanting protection against home-world compromise can opt into cryptographic identity (§24.9); v1 reserves the field.

### 24.3 Qualified identity

Object refs are qualified by origin in federated contexts:

```
#42@world-a.example
~3@#5@world-a.example
```

Within a world, the qualifier is omitted; written ids are unqualified `#42`. The wire protocol carries the qualifier in a separate `origin` field so that string-form identity remains compact in the common case.

In v1, every ref's implicit origin is the local world. The qualifier syntax is parsed and accepted by the lexer; non-self origins raise `E_FED_DISABLED` at runtime.

### 24.4 Cross-world calls are RPC, not task migration

Within a world, verb dispatch migrates the task to the receiver's host (see [../semantics/vm.md §8.3.6](../semantics/vm.md#836-verb-dispatch)). Across worlds, **the task does not migrate.** Cross-world dispatch is pure RPC:

1. Originating world's task hits `CALL_VERB` with a remote-origin target.
2. Originating world serializes the *call* (target, verb, args) — not the frame stack.
3. Originating world's task enters `awaiting_call` on its home DO.
4. Receiving world creates a new task in *its* world, runs the verb to completion (or fault), serializes the *result*, returns it.
5. Originating world's task resumes with result on stack.

Why not migration:
- VM/bytecode versions can diverge between worlds; a migrated frame would require a shared opcode set forever.
- Trust: a migrated frame carries `progr` and identity fields the remote world cannot verify. RPC keeps the trust boundary at the call site, not midway through a task.
- Failure: if the remote world goes offline mid-task, RPC times out cleanly with `E_FED_TIMEOUT`. Migration would strand the task.

Trade-off: chatty cross-world programs (a verb that calls many remote verbs in sequence) pay one round-trip per call. Acceptable: chatty cross-world code is rare, and when it exists it should be visible in the source.

### 24.5 No cross-world inheritance

A persistent object's `parent` must be in the same world. Cross-world references are first-class for messaging (verb calls, events, property reads) but not for inheritance.

Reasons:
- Verb dispatch up the parent chain would require fetching, caching, versioning, and running another world's bytecode locally. Multi-world bytecode = security and continuity nightmare.
- A class hierarchy that spans worlds is operationally fragile: peer goes offline, descendants stop working.
- The use case (reuse base classes) is better served by *copying* source between worlds, with attribution. Worlds publish their core source as text; other worlds compile and own their copies.

Enforcement: `chparent(obj, new_parent)` raises `E_FED_DISABLED` if `new_parent` is qualified with a non-self origin.

### 24.6 Cross-world property reads and writes

`obj@peer.world.example.foo` is allowed. The receiving world applies its own permission checks against the incoming caller (see §24.8). Default visitor permission sees properties with the `r` bit set.

Property writes across worlds are allowed but rare. Same permission model applies. The receiving world's `w` perm and value-owner discipline are authoritative.

### 24.7 Cross-world events

`emit(target@peer, event)` is allowed. Delivery is best-effort:

- Events to a reachable peer are delivered with the same per-emitter, per-target ordering guarantees as in-world.
- Events to an unreachable peer queue in the originating world's outbound buffer for that peer (bounded; default 1024 events). On overflow, oldest dropped, dead-letter event emitted to the originator's audit object.
- No global ordering across worlds.

Schemas (see [../semantics/events.md §13](../semantics/events.md#13-schemas)) are world-local. Cross-world events are open maps; the receiver applies its own schema or none.

### 24.8 Caller mapping at the receiving world

When World B receives a call from World A on behalf of `#5@world-a.example`, World B must decide what `progr` and `player` look like in the verb body it dispatches.

Default policy: a synthetic `$peer_visitor` stub with `progr = $peer_visitor` and a `from_origin` property naming the peer + remote id. World B's verbs see the call as coming from a low-privilege known stranger.

Worlds may install richer policy: a peer-to-local mapping (`#5@world-a` → local `#guest_5_from_world_a` after a registration handshake), giving repeat visitors a stable local identity.

The receiving world's permission model applies unchanged. The peer's vouch tells the receiver *who's calling*; what they can *do* is purely the receiver's policy.

### 24.9 Optional cryptographic identity (deferred)

Users wanting guarantees that don't depend on home-world honesty can layer a keypair per player:

- Each player has a long-lived keypair stored in a self-hosted client or wallet.
- Cross-world calls carry a signature over `(call, target, args, timestamp, nonce)` made by the player's key.
- Receiving worlds verify against a public key advertised either via the home world or a separate identity fabric.

The wire protocol reserves a `signature` field on cross-world calls. v1: always null. v2 base behavior unchanged (vouching only). v3 may make signing opt-in or required per peer policy.

### 24.10 Hazards and mitigations

| Hazard | Mitigation |
|---|---|
| Compromised peer world impersonates its users | Accepted at the trust-unit-is-world layer. Per-peer allowlist for high-trust calls. |
| Replay / forged requests | TLS, request nonce + timestamp, optional cryptographic signature (§24.9). |
| Resource flooding from a peer | Per-peer rate limits inbound, per-peer outbound queue with backpressure. |
| Cross-world deadlock | RPC timeout (`E_FED_TIMEOUT`); RPC mode rather than migration prevents stranded tasks. |
| Reference drift (peer recycles target) | `E_OBJNF` on call, same as within-world. |
| Peer world disappears | `E_FED_TIMEOUT`; refs can be marked stale; dead-letter inbox for emits. |
| Schema drift between worlds | Events are open maps; receiver applies own schema or none. |
| Property reads leak data | Receiving world applies own perms with caller mapped to "guest from peer." Default visitor sees `r`-public properties only. |
| Versioning skew (peer's wire protocol drifts) | Wire protocol carries a version field; receivers reject calls with unsupported versions and reply with the supported set. |
| Chatty cross-world verb chains | Visible in code (every cross-world `:` is qualified); programs can batch calls explicitly. |

### 24.11 v1 reservations

v1 work is restricted to *reservations* — leaving syntax, fields, and error codes in place so v2 federation work doesn't require a breaking change:

- Lexer accepts `@origin` qualifiers on object refs.
- Parser stores qualifier in AST; unqualified means local.
- Codegen: `CALL_VERB`, `GET_PROP`, `SET_PROP`, `EMIT` carry a qualified target; if non-local origin, raises `E_FED_DISABLED` at runtime.
- Wire protocol reserves `origin` and `signature` fields; v1 always null/self.
- Error codes `E_FED_DISABLED`, `E_FED_TIMEOUT`, `E_FED_UNREACHABLE`, `E_FED_PROTOCOL` reserved (see [../semantics/builtins.md §20](../semantics/builtins.md#20-errors)).
- `chparent` rejects non-local parents with `E_FED_DISABLED`.

No outbound HTTP to peers, no inbound peer endpoint, no peer policy table. All v2.
