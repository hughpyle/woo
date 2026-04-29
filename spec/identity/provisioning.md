# Actor Provisioning

> Part of the [woo specification](../../SPEC.md). Layer: **identity**. Profile: **v1-ops**. **Status: placeholder.**

How actors come into existence and how their capabilities are granted, revoked, and audited. v1-core covers only the trivial cases (guest pool, wizard-created players); a multi-developer or multi-tenant deployment needs more — class-based provisioning, directory sync, group-derived capabilities, deactivation. This document is a placeholder marking the open design space; concrete normative content lands once the v1-ops use cases harden.

---

## AP1. Scope (eventual)

Things this document will eventually specify:

- **Class assignment.** Every actor has a *player class* (`$player`, `$guest`, `$human`, `$agent`, `$service_account`, …) that determines default capabilities and the disfunc/lifecycle behaviour. How that class is chosen at creation.
- **Capability model.** How verbs, spaces, and resources are gated by class + group + per-actor flags. Likely a composition of: parent-class defaults, attached features ([features.md](../semantics/features.md)), team memberships ([teams.md](teams.md)), and per-actor flags (`wizard`, `programmer`).
- **Sources of provisioning.** Manual (wizard `create($player, owner=...)`), self-service signup, directory sync (SCIM/SAML/OIDC group claims), and programmatic (deployment-time scripts, IaC).
- **Lifecycle states.** Active, suspended, deactivated, deleted. State transitions and their audit trail.
- **Bulk operations.** Group provisioning, directory-sync reconciliation, mass-deactivation on directory drift.

---

## AP2. What v1-core already covers

- **Guest pool** ([identity.md §I3](../semantics/identity.md#i3-auth-first-light-guest), [bootstrap.md §B7](../semantics/bootstrap.md#b7-guest-player-pool)). Pre-seeded `$guest` instances allocated on auth, reset on reap.
- **Wizard creation.** `wiz:create($player, owner=$wiz)` (or any builtin per [recycle.md](../semantics/recycle.md) and [permissions.md](../semantics/permissions.md)) is sufficient for ad-hoc cases — useful in development, insufficient for managed deployments.
- **Class-based capability defaults via parent chain + features.** The mechanism exists; v1-ops needs to specify the conventions.

These cover first-light demos and "single operator, manual provisioning" worlds. Anything multi-developer needs AP3.

---

## AP3. The v1-ops gap

The concrete shortfall:

- No way to express "everyone in `engineering@example.com` gets a `$human` player with `programmer: true` and team membership in `$eng_team`" without writing custom wizard scripts per deployment.
- No directory-sync semantics: when an upstream identity provider removes a user, what happens to their actor? Their owned objects? Their open sessions?
- No standard "promote a guest to a credentialed user" flow.
- No standard "deactivate without deleting" — leaves audit trail and ownership intact while denying new sessions.

LambdaMOO had none of this; admins ran `@make-player` and `@toad` by hand. That model doesn't scale past a small operator-manager-user hierarchy. v1-ops is where it has to.

---

## AP4. Rough shape (non-normative)

A plausible v1-ops shape, to be refined:

**Player classes** as `$player` subclasses with explicit capability defaults:

| Class | Typical capabilities | Lifecycle |
|---|---|---|
| `$guest` | Read-only on shared spaces; no authoring | Pool-allocated, disfunc on reap |
| `$human` | Standard credentialed user; presence in self-joined spaces | Created via signup or directory sync |
| `$programmer` | `$human` + verb authoring on owned objects | Class promotion or directory-group-derived |
| `$agent` | Programmatic actor; API-key auth; capability-class metadata per [workflows.md §WF11](../operations/workflows.md#wf11-capability-gating-for-agent-claims) | Created by operator, not signup |
| `$service_account` | Long-lived programmatic identity; bound to a deployment, not a human | Created by infrastructure tooling |

Defaults are conferred by: parent class, attached features ("composable capabilities"), and team memberships. Per-actor wizard/programmer flags remain as the runtime-blessed escape hatch.

**Provisioning verbs** (sketch only):

```
$system:provision_actor(class, owner, attrs?) -> obj
$system:deactivate_actor(actor, reason)
$system:reactivate_actor(actor)
$system:reconcile_directory(provider, snapshot)   // bulk sync
```

These would live on `$system` (wizard-only) and be the audit-logged surface for any provisioning path. UI flows (signup pages, admin consoles) call them.

---

## AP5. Sources of provisioning (non-normative)

- **Manual.** Wizard runs `$system:provision_actor`. Audited; useful for one-offs.
- **Self-service signup.** A signup endpoint creates a `$human` after credential verification. Probably layered on [auth.md](auth.md) account-creation flow.
- **Directory sync.** SCIM or SAML/OIDC group claims drive bulk provisioning. The runtime needs: a snapshot import format, a reconcile algorithm (add/update/deactivate), and a way to express directory-group → class/team mappings.
- **Programmatic.** Operator scripts (e.g., infrastructure-as-code) call provisioning verbs at deploy time.

Each source converges on the same `$system:provision_actor` underneath. Source-specific glue lives at the edge.

---

## AP6. Open questions

1. **Class vs. flags vs. features — which carries which capability?** Some capabilities are clearly class-shaped (a `$service_account` is fundamentally different from a `$human`); others are clearly features (an `$editor` capability). The boundary is unclear.
2. **Class change over time.** Can a `$guest` be promoted to `$human` (preserving objref + history)? `chparent` exists ([objects.md §9.5](../semantics/objects.md#95-no-cross-world-parents)) but isn't currently audit-shaped.
3. **Deactivation vs. recycle.** Deactivated actors should keep their owned objects and audit history; recycled actors don't. Two distinct lifecycle states.
4. **Directory sync as v1-ops vs. v2.** A real SCIM endpoint is significant work and not strictly needed for the first multi-developer deployments. Start with a JSON snapshot importer; defer streaming SCIM.
5. **Service accounts and key rotation.** Credentialed long-lived actors need a key-rotation discipline that doesn't break in-flight calls.
6. **Cross-world identity (federation).** Reserved for v2; mentioned here so the v1-ops design doesn't paint federation into a corner.

---

## AP7. Until this is filled in

- **Worlds operating today** use the wizard-creation path (`$system:create($player, ...)` or its equivalent) for non-guest actors. Capability decisions are by ad-hoc convention.
- **The shape of the problem is acknowledged** so authoring tooling, IDE flows, and team UIs don't ship assumptions that the placeholder design has to break.

When the first multi-developer deployment reaches "we need to provision 50 users from our IdP," that's the trigger to convert this placeholder into normative content.
