# Federation: early profile

> Part of the [woo specification](../../SPEC.md). Layer: **deferred**. Profile: **v2-federation**.

The earliest-buildable subset of cross-world federation. The full v2 design is in [federation.md](federation.md); this document specifies the minimum cross-world surface that activates first.

**This is not part of v1.** v1 worlds are single-operator; cross-operator capability begins here. The doc lives in `spec/deferred/` to make that explicit. Earlier drafts of this material were placed under `spec/discovery/` and labeled "v1"; that placement was a profile-bleed and has been corrected.

---

## FE1. Scope

| Concern | Status in early profile | Reference |
|---|---|---|
| Cross-world objref qualifier (`#42@world.example`) | active | federation.md §24.3 |
| Per-world peer trust list (mTLS-pinned) | active | this doc |
| Cross-world `:call` (HTTPS POST over mTLS) | active | this doc + §FE4 |
| Cross-world property reads (mediated through verbs) | active | this doc + §FE5 |
| Cross-world property writes (direct) | rejected (`E_FED_DENIED`) | full v2 |
| Cross-world events | rejected (`E_FED_DENIED`) | full v2 |
| Cross-world inheritance | forbidden (always) | federation.md §24.5 |
| Cross-world task migration | forbidden (always) | federation.md §24.4 |
| Verbs callable across worlds | annotated, gated | §FE3 |
| Cross-world `:describe()` | active when verb is annotated | §FE5 |
| Mutual-TLS for peer authentication | required | §FE2 |
| Per-call cryptographic signature | optional (layered) | §FE6 |
| World-to-world rate limiting | active | §FE9 |

---

## FE2. Trust: mutual TLS

A peer authenticates the calling world via **mutual TLS (mTLS)**. The receiving world is configured with a set of trusted client certificates (one per peer); incoming HTTPS requests must present a client cert matching one of them.

This is the load-bearing fix relative to plain TLS. Standard HTTPS server-cert authenticates the *receiver* to the caller, not vice versa. Without mTLS or request signing, a peer cannot verify which world is calling — so the early-profile draft that said "TLS-confirmed origin" without specifying mTLS was not implementable as written.

**Operator setup (per peer pair):**

1. World A's operator generates a client keypair; submits the certificate to World B's operator.
2. World B's operator adds World A's cert to its `$peer_registry` entry for World A.
3. World A configures its outbound HTTPS client to present the cert when calling World B.

Both sides exchange certs symmetrically — a peer relationship is two-directional.

mTLS revocation is operational: peers replace each other's cert entries when needed; old certs are no longer accepted on the next request.

**Optional layered defense:** per-call signatures (§FE6) cryptographically attest the call payload, narrowing the trust surface from "the operator's TLS material" to "this specific call signed by this key."

---

## FE3. Verb annotation: cross-world callability

A cross-world `:call` can run any verb on the peer object. Without explicit gating, any mutating verb is reachable from peers — which contradicts the read-mostly intent of the early profile. The fix:

**Verbs declare cross-world callability via metadata.** A verb's metadata gains a `cross_world_callable: bool` field (default `false`). The runtime rejects cross-world dispatch to verbs where this is `false` with `E_FED_DENIED`.

Verb authors opt in explicitly:

```
verb $catalog:list_public() rxd cross_world_callable {
  return this:public_entries();
}
```

Recommended convention:

- Read-shaped verbs (`:list_*`, `:describe`, `:get_*`) may be `cross_world_callable: true` if they don't expose private state.
- Mutating verbs are `cross_world_callable: false` even if they look harmless. Opt-in is per-verb deliberate.
- Default is `false` everywhere, including for verbs inherited from common ancestors. A descendant must opt in for itself.

Verb introspection (`:describe()`) surfaces the flag; agents inspecting a peer can see what is reachable and what is not.

**Why annotation rather than read-prefix convention.** Naming conventions are easy to violate by accident; explicit metadata is auditable and refuses to default into unsafe behavior. The cost — one bool per verb — is trivial.

---

## FE4. Cross-world calls

A call to a remote world is a verb call with a qualified target:

```
target = "#42@peer.example";
result = peer:describe();   // resolves the qualifier, dispatches cross-world
```

The runtime:

1. Sees the non-local origin.
2. Looks up the peer in the local `$peer_registry`. If absent or inactive, raises `E_FED_DISABLED`.
3. Issues an HTTPS POST (with mTLS) to the peer's `/.woo/api/call` endpoint:

```json
{
  "id":          "client-correlation-id",
  "from":        "https://my-world.example",
  "actor":       "#5@my-world.example",
  "target":      "#42",
  "verb":        "describe",
  "args":        [],
  "ts":          "2026-04-29T12:00:00Z",
  "nonce":       "...",
  "signature":   null
}
```

4. The peer validates: TLS client-cert (mTLS), peer is in *its* `$peer_registry` and active, nonce-not-replayed within the replay window (default 5 minutes), `signature` if required by peer policy (§FE6).
5. The peer maps the calling actor to a local actor representation (FE7).
6. The peer checks the target verb's `cross_world_callable` flag. If false, raises `E_FED_DENIED`.
7. The peer dispatches the call. Cross-world calls **are not migrated as tasks** — the peer creates a fresh task on its side; the originating world awaits the result.
8. The peer responds with the same shape as a local applied frame plus the originating call id.

The HTTPS endpoint is rate-limited per peer per minute. Default 60 calls/min; configurable per peer.

---

## FE5. Cross-world property reads (via verbs)

There is **no** `/.woo/api/read` endpoint that bypasses verb dispatch. Every cross-world property access goes through a verb that:

- Has `cross_world_callable: true`.
- Returns the value the calling world is allowed to see.
- Applies whatever permission filtering the peer's verb body chooses.

This is more constrained than the earlier draft's direct cross-world property reads — but it's safer: every cross-world value crossing the boundary went through verb code that the peer can audit and filter.

`:describe()` (the canonical one defined on `$root` in [introspection.md](../semantics/introspection.md)) is `cross_world_callable: true` by default for `$root:describe()`. Worlds may override on specific objects with stricter filtering (a private `$account` may override `:describe` to redact).

---

## FE6. Per-call signatures (optional layered defense)

In addition to mTLS, peers may require **per-call signatures**. The originating world signs `(call_payload, ts, nonce)` with the calling actor's key (or the world's signing key); the receiving world verifies against a published key set.

This narrows the trust surface from "the operator's TLS material" to "this specific call signed by this key." Useful when:

- The TLS keys are held by infrastructure operators, not application administrators.
- The actor's identity beyond "from this peer" matters.

Signatures are optional in the early profile; the `signature` field is null when not used. Peers configure whether they require signatures via per-peer policy in `$peer_registry`.

---

## FE7. Caller mapping

When a peer receives a call from another world for actor `#5@world-a.example`, the peer must decide how to represent that actor locally:

- **`caller_mapping: "guest"`** — every cross-world call from this peer is treated as a fresh `$peer_visitor` (a special-purpose `$actor` subclass) with no presence and minimum privileges.
- **`caller_mapping: "trusted_proxy"`** — the peer trusts the calling world's claim about its actor. The receiving world records `(calling_world, calling_actor)` as a stable local identity for repeat calls. Only enabled for peers where mTLS *and* per-call signatures are required.

The runtime never *automatically* trusts a remote actor's claimed identity beyond the mTLS+signature chain.

---

## FE8. Routing observations

Federation early does not propagate observations across worlds. A `$space:call` to a remote world produces an applied frame on the *peer's* side (sequenced in the peer's space), and the originating world receives only the synchronous reply. Subscribers in the originating world don't see the peer's observation stream.

Cross-world observation propagation requires significant additional machinery (vector clocks, message dedup, federated subscriber lists) and is deferred to full v2 federation.

---

## FE9. Security

Threats and mitigations:

- **Spoofed origin.** mTLS client cert is the gate; certificate validation handles this.
- **Replay.** Each call carries a nonce; peers track recent nonces to reject replays. Replay window default 5 minutes.
- **Rate exhaustion.** Per-peer rate limit applied at the receiver.
- **Bad data.** Peers validate incoming payloads against the value model; ill-formed data rejected with `E_INVARG`.
- **Unannotated mutation.** Verbs without `cross_world_callable: true` cannot be invoked from peers; mutation surface is opt-in only.
- **Stolen mTLS cert.** Operational concern; mitigation is cert revocation + replacement. Per-call signatures (§FE6) provide a second layer when keys are held differently.
- **Privacy.** Peers see what verbs you call; they don't see your local operations.

---

## FE10. Limits of the early profile

- **No cross-world atomic operations.** Each call is a discrete RPC; no transaction across worlds.
- **No cross-world events.**
- **No federated identity.** A user logged in to World A is *not* automatically anyone in World B unless World B explicitly maps them.
- **No federated catalogs.** A world can pull catalogs from a peer's catalog endpoint, but each is its own import.
- **No federated tasks.** Long-running tasks stay in their world; no cross-world fork/suspend.

These are all full-v2 features. The early profile is the read-mostly cross-world surface with concrete trust.

---

## FE11. Migration to full federation

When v2 federation lands ([federation.md §24](federation.md#24-federation)), early-profile deployments upgrade by:

1. Adding cross-world events (with vector-clock or causal-token machinery).
2. Allowing direct cross-world property writes (with stricter trust gating).
3. Enabling federated identity (via the trust-source story, when defined).
4. Optionally relaxing the verb annotation requirement once a richer permission model exists.

Early-profile peers continue to work; v2 peers can opt into the richer surface.
