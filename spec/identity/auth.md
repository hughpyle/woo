# Auth

> Part of the [woo specification](../../SPEC.md). Layer: **identity**. Profile: **v1-ops**.

The contract for actor identity beyond first-light guest tokens. Covers credentialed authentication, account-vs-actor separation, multi-character users, service/agent accounts, and recovery. Builds on [identity.md](../semantics/identity.md) — the actor and session model is unchanged; this document specifies how credentials bind to actors.

---

## A1. Beyond guest

First-light identity ([identity.md §I3](../semantics/identity.md#i3-auth-first-light-guest)) supports `guest:<random>` and `session:<id>` tokens. That's enough for a demo where every actor is anonymous and short-lived. It's not enough for:

- A developer who wants to log in as themselves across sessions, days, devices.
- A team where each member's actions are attributable.
- An agent connecting programmatically with a service credential.
- Any flow that requires "I am the same person who was here yesterday."

This document specifies the credentialed-token vocabulary that extends `op: "auth"` to support real identity.

---

## A2. Account vs actor

A clean separation:

- **Account.** A credential-bearing identity. Has a username (or email or external IdP id), credentials, recovery info, profile metadata.
- **Actor.** The runtime principal — an `$actor`-descended object with `progr` authority. Lives in the world graph.

One account → one or more actors. A human with one account may have multiple `$player`-typed actors (multi-character). A team account may have many actors representing automated personas.

This separation lets credential management live alongside the runtime (where it doesn't need to be a programmable woo object) while actors stay first-class woo objects. `$account` is the conventional class (parent: `$root`); it is *not* an actor. It carries `account.{username, contact, recovery_*}` plus a list of bound actors.

---

## A3. Token vocabulary (extended)

Extending [identity.md §I3](../semantics/identity.md#i3-auth-first-light-guest):

- **`bearer:<jwt>`** — a signed JWT issued by a known issuer (the world's auth service or a delegated IdP). Required claims: `iss`, `sub`, `exp`, `aud`, `actor` (objref), `scope`. The runtime verifies signature against a published JWK set and rejects tokens with unknown `iss`, expired `exp`, wrong `aud`, or invalid signature.

- **`oauth_code:<provider>:<code>`** — a single-use OAuth/OIDC authorization code from a known external provider. The runtime exchanges with the provider's token endpoint, validates the resulting id_token, looks up the bound account by `(iss, sub)`, creates a session.

- **Password authentication is *not* a wire token.** Passwords never cross the WebSocket wire. A world that hosts its own credential store exposes a separate HTTPS endpoint (e.g., `POST /auth/password`) that accepts `{username, password}` over TLS, validates with argon2id (per-account salt + pepper, rate-limited per username), and returns a `bearer:<jwt>` plus a refresh token. The client then connects with `auth { token: "bearer:<jwt>" }` over the WebSocket. This keeps password material out of the wire-level protocol and the observability log/trace payloads.

- **`session:<session_id>`** — unchanged from identity.md. A live-session resume token.

- **`apikey:<id>:<secret>`** — long-lived programmatic credential for service/agent accounts. See A8.

- **`recovery:<token>`** — single-use, narrow-scope token from a recovery flow. Lands the user in a session that can change credentials and nothing else.

The token format is server policy; clients receive their next-presentable token in the `op: "session"` response when a credentialed flow lands.

---

## A4. Bearer flow

```
1. Client authenticates via the credentialed exchange (password POST or OAuth code).
2. Server issues a JWT (bearer) and a session.
3. Client persists the bearer (and refresh token) per its threat model.
4. On WebSocket connect, client sends `auth { token: "bearer:<jwt>" }`.
5. Server validates: signature, claims, expiry. If valid, binds session to actor.
```

**Client-side persistence is a threat-model decision, not a normative recommendation.** Browsers offer no fully-secure option for storing bearers in-process: `localStorage` is XSS-exfiltratable; HTTP-only cookies are XSS-resistant but require CSRF mitigations and don't compose cleanly with WebSocket auth flows; in-memory only is XSS-safe but loses on refresh. Worlds choose based on their actor population (web, native, agent) and their tolerance for re-authentication. Tokens crossing the wire (via `auth { token }`) are subject to the observability redaction rules ([observability.md §O8](../operations/observability.md#o8-privacy--pii)) — bearer values must not appear verbatim in logs, traces, or audit records.

**Bearer lifetime.** Default 1 hour. A separate **refresh token** (JWT with `purpose: refresh`, longer lifetime — default 30 days) can mint new bearers without re-credentialing via `op: "refresh", token: "refresh:<jwt>"`. This frame is part of the credentialed wire (post-first-light).

**Per-claim scopes.** A bearer's `scope` claim lists what the actor may do. First-light scopes: `read`, `write`, `admin`. Worlds may add their own. Scope is **advisory in v1**; the runtime trusts the actor's `progr` discipline as the enforcement primitive. Future versions may pre-filter calls by scope.

---

## A5. OAuth / OIDC

The world acts as an OAuth client of a known provider (Google, GitHub, an enterprise IdP, etc.).

Setup:
- Operator registers the world with the provider; receives client_id and client_secret.
- World stores trusted issuer config (jwks_uri, scopes, account-claim mapping).
- World seeds an `$account` for each user on first login (or matches by `(iss, sub)`).

Flow:
- Client redirects to provider for code (browser-mediated).
- Client receives code, sends `auth { token: "oauth_code:<provider>:<code>" }`.
- Server exchanges code with provider, validates id_token.
- Server looks up account; creates if first-time. Selects a default actor.
- Server returns `op: "session", actor: <objref>` plus a fresh bearer token.

**Identity unification.** A user authenticated via two providers (Google + GitHub) can bind both to the same `$account`. The runtime stores `account.identities = [{provider, sub}, ...]`; matching any of them resolves to the same account. Binding additional identities requires re-authenticating both.

---

## A6. Multi-character

One account, multiple actors. The account's `actors` property is a list of `$player`-descended objects. The session presents a token that selects one of them.

Bearer's `actor` claim names the chosen character. Switching characters means re-authenticating with a different bearer (one per character) or a `op: "switch_actor", target: <objref>` frame after auth.

For first-light v1: one bearer = one bound actor. Switching means new bearer issuance. `$account:list_actors()` returns the bound actors; UI exposes a character-select menu.

---

## A7. Recovery

Standard flows:

- **Forgotten password.** `account.recovery_email` receives an emailed token enabling a one-time `auth { token: "recovery:<token>" }`. The session is narrow-scope: change password and nothing else.
- **Lost device.** Refresh tokens are revocable; the account's session list (visible to the owner) shows live sessions; the owner may `revoke_session(id)` from a known-good device.
- **Compromised credentials.** Password change automatically revokes all live sessions and bearers. OAuth identity unbind requires re-authenticating both the OAuth identity and the account password (or another OAuth identity).
- **Account deletion.** Soft-deletes the account (marks inactive); actors stay alive but are no longer bound to a credentialed login. Wizards may rebind.

Recovery flows are the auth service's responsibility; verbs see the result as `op: "session", actor: ...`.

---

## A8. Service / agent accounts

Long-lived programmatic credentials for non-interactive actors:

- **`apikey:<id>:<secret>`** — equivalent to a refresh token but indefinite. Tied to one `$account`, typically one actor.
- API keys are scoped (`read-only`, `bot:<purpose>`, etc.).
- Revocable independently of bearer tokens.
- May have IP / origin restrictions.

A service account's bound actor is typically a `$bot` (descended from `$player`) with no human-attached UI. The actor's verbs run as the bot.

Audit: API key issuance is logged; usage is logged at session-start (not per-call, to keep the volume bounded).

---

## A9. Lifecycle

Account creation:
- **Self-service** (open registration): user provides email + password (or OAuth identity); world creates `$account` and a default `$player` actor.
- **Invite-only**: existing wizard issues an invite token; redeemer creates account.
- **SSO-only**: organization-bound; new accounts auto-create on first SSO landing.

Account suspension:
- Wizard sets `account.active = false`; live sessions are reaped; bearer tokens are rejected.
- Actor objects remain in the world (preserving audit trails) but no one can bind to them.

Account deletion:
- Wizard sets `account.deleted = true`; actor unbinding follows.
- Operationally soft — actor history remains; account record is hidden but auditable for retention.

---

## A10. Permissions

Account-level operations (create, suspend, delete, recover) are wizard-only by default. Per-account self-service ops (change password, list sessions, revoke session, list bound actors) work only on the calling account.

Bearer token issuance is internal to the auth service; user code does not mint bearers directly. (A future capability-token scheme may delegate parts of this; v1 keeps it server-only.)

---

## A11. What's deferred

- **WebAuthn / passkey** support.
- **Hardware-key 2FA.**
- **Federated accounts across worlds** (different from federated objrefs; concerns *who you are* across deployments).
- **Account-to-account trust delegation.**
- **Fine-grained capability tokens** (currently scope is advisory).
- **Account audit log** (separate from wizard-action audit).
