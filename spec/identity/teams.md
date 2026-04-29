# Teams

> Part of the [woo specification](../../SPEC.md). Layer: **identity**. Profile: **v1-ops**.

The contract for multi-actor coordination at the account/organization level: shared ownership, team-scoped quotas, role-based access. Builds on [auth.md](auth.md) and [identity.md](../semantics/identity.md).

---

## TM1. Beyond per-actor

Per-owner quotas and the per-claimer pattern ([identity.md §I7.1](../semantics/identity.md#i71-the-per-claimer-update-pattern)) handle the single-developer case. They don't handle:

- A team of developers all able to edit the same set of objects.
- A storage budget shared across team members.
- Audit trails answering "who on the team did this?" rather than "this account did it."
- Team-level deployment approvals ("two reviewers from team X must approve").

Teams are the first-class organizational primitive. Like accounts, teams are *not* actors — they're identity-and-membership records that scope permissions and quotas.

---

## TM2. The `$team` class

```
$team < $root

properties:
  name:        str
  members:     list<obj>          // list of $account refs
  roles:       map<obj, str>      // account ref → role name (e.g., "owner", "maintainer", "member")
  quotas:      map                // team-scoped quotas; see TM4
  active:      bool
  created:     int
```

A team has a small, fixed role vocabulary by default — `owner`, `maintainer`, `member` — but the world may extend. Roles map to permission patterns (TM5).

`$team` is wizard-creatable; member management may be delegated to team owners.

---

## TM3. Membership

An account is a member of zero or more teams. The account's identity is independent; team membership is a pointer-based relationship, not an inheritance chain.

```
team:add_member(account, role) -> bool
team:remove_member(account) -> bool
team:set_role(account, role) -> bool
team:list_members() -> list<{account, role}>
```

These verbs gate on the calling actor's role in the team:
- `member` can list, but not modify.
- `maintainer` can add/remove/set-role for `member`s.
- `owner` can do all of the above plus modify other owners and maintainers.

Removed members lose access to team-scoped resources but retain their account and existing actors; they may have created objects whose ownership transitions are TM6.

---

## TM4. Team quotas

Per-team caps that aggregate across team members:

| Quota | Default | Notes |
|---|---|---|
| Total objects owned by team members | 10000 | Beyond per-account quotas. |
| Total storage bytes for team-owned data | 10 GiB | |
| Concurrent worktrees across team | 25 | |
| Concurrent sandbox storage | 25 GiB | |
| API keys issued to team service accounts | 100 | |

Team quotas are *upper bounds*; per-member quotas remain in effect. A member at their personal cap doesn't get more capacity from team budget; the team cap doesn't override per-member quotas downward.

Wizards override team quotas with `set_team_quota(team, kind, value)`.

---

## TM5. Permission propagation

Team membership is read by verbs that gate on team identity. The pattern:

```
verb $team_resource:do_thing() {
  let actor_account = account_of(actor);
  let team = this.team;
  if (!team:is_member(actor_account)) raise(E_PERM);
  // proceed
}
```

This is the per-claimer pattern from [identity.md §I7.1](../semantics/identity.md#i71-the-per-claimer-update-pattern) generalized: an actor-typed property (`team`) is checked against an actor's account membership. No new perm system; existing `progr` discipline carries the load.

Role-based gating composes:

```
if (team:role_of(actor_account) != "owner") raise(E_PERM);
```

The `team:role_of()` verb returns the role string or null; verb bodies make the policy decision.

---

## TM6. Ownership transition

When a member leaves a team, the team's policy decides what happens to their team-relevant objects:

- **Transfer to team owner** — most common; default.
- **Reassign to another member** — explicit choice at removal.
- **Mark unowned** — for tool-created objects with no human owner.
- **Recycle** — for transient member-created data.

`team:remove_member(account, on_leave_objects: "transfer" | "reassign" | "unown" | "recycle")` parameterizes this. Wizard-only.

The default (transfer to owner) preserves audit trails; the alternatives are for special cases.

---

## TM7. Team service accounts

A team may own its own service accounts (`$bot` actors with API keys). These are:

- Created by team maintainers/owners.
- Counted against the team's API key quota.
- Logged with both the bot actor's id *and* the team id for audit.
- Suspended if the team is suspended.

This makes team-owned automation (CI bots, integration agents) auditable as the team's, not as some individual member's.

---

## TM8. Audit at team level

Audit events ([observability.md §O5](../operations/observability.md#o5-audit-log)) carry both actor and team context where applicable. Team-level audit views are:

- "What did anyone in team X do this week?"
- "Which teams had quota events this month?"
- "Who promoted what to prod, by team?"

These are per-deployment views over the audit log; no new audit machinery required, just an indexing convention.

---

## TM9. Cross-team patterns

Teams don't directly own each other; cross-team relationships are by convention:

- An object's `team` property points to the team that owns it.
- An object can have multiple team-affiliations via `affiliated_teams: list<obj>` if multiple teams need access.
- Inter-team permissions are application code: a verb checks "is the actor in any of `affiliated_teams`?" rather than the runtime imposing a team hierarchy.

Org / parent-team relationships ("teamX is part of orgY") are out of v1 scope; teams are flat. Worlds with org structure can build it on top using the same membership pattern.

---

## TM10. What's deferred

- **Org / parent-team relationships.** Hierarchical teams.
- **Federated teams.** A team that spans worlds (federation v2).
- **Programmatic team creation by non-wizards.** Currently teams are wizard-creatable; self-service team creation with quota enforcement is a v2.
- **Cross-team workflows** ("team A's review approves team B's promote"). Possible via inter-team verb gating; not specced here.
- **Team-scoped private spaces.** A `$space` whose subscribers are exactly a team's members. Possible as application code; not a runtime primitive.
