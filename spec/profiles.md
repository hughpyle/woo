# Profiles

> Part of the [woo specification](../SPEC.md). Meta.

The spec describes four progressive **profiles**. An implementation targets one and grows forward as scope increases. Each layer doc carries a `Profile:` label so readers can filter by what they're trying to build or implement.

---

## P1. The four profiles

| Profile | Scope | What it proves | Status |
|---|---|---|---|
| **first-light** | T0 VM, dubspace + taskspace demos, minimal IDE, in-memory state | The runtime model is real; the demos are alive | reference impl in `src/` |
| **v1-core** | Full normative semantics: values, objects, $space, identity (lite), VM (full), permissions, events, tasks, builtins, failures, plus protocol and Cloudflare reference | Durable, multi-actor, recoverable; passes the core conformance suite | spec ready; impl pending |
| **v1-ops** | Worktrees, migrations, backups, deployments, observability, debugging, teams, credentialed auth, catalogs, conformance suite | Multi-developer platform: ship changes, recover, audit, trust between authors | spec ready; impl pending |
| **v2-federation** | Cross-world calls (mTLS), peer trust, federated identity, cross-world catalogs | Worlds interoperate across operators | reserved; design in `spec/deferred/` |

Each profile is a superset of the one above: v1-ops requires v1-core; v1-core requires first-light.

---

## P2. Doc → profile map

Source of truth for which profile each spec doc belongs to. Per-doc `Profile:` frontmatter mirrors this table.

### first-light

- `spec/dubspace-demo.md`
- `spec/taskspace-demo.md`
- `spec/authoring/minimal-ide.md`
- (Reference implementation in `src/`; not a spec doc.)

### v1-core

- `spec/semantics/`: core, values, objects, space (§S1–§S7 with snapshots optional in this profile), identity (guest auth only), language, vm, tiny-vm, permissions, events, tasks, builtins, failures, bootstrap, introspection
- `spec/protocol/`: hosts, wire, browser-host
- `spec/reference/`: cloudflare, persistence, quotas

### v1-ops

- `spec/operations/`: worktrees, migrations, backups, deployments, observability
- `spec/identity/`: auth (credentialed; guest-only piece is in v1-core), teams
- `spec/discovery/`: catalogs
- `spec/tooling/`: debugging, conformance
- `spec/semantics/space.md §S7.1` raises snapshots from optional to required for this profile.

### v2-federation

- `spec/deferred/federation.md` (canonical v2 design)
- `spec/deferred/federation-early.md` (earliest-buildable v2 subset; mTLS + verb annotation gating)

---

## P3. Profile escalation in shared docs

Some docs carry rules that *escalate* between profiles:

- **`semantics/space.md §S7` snapshots** — optional in v1-core; required in v1-ops.
- **`semantics/identity.md` auth tokens** — guest-only in v1-core; credentialed (bearer/OAuth) added in v1-ops via `identity/auth.md`.
- **`semantics/bootstrap.md` seed graph** — universal classes in v1-core; demo classes (`$dubspace`, `$taskspace`) are first-light artifacts.
- **`semantics/failures.md` storage failure rows** — all profiles agree, but storage-failure modes are only fully exercised in v1-core+ (first-light is in-memory).

Where escalation happens, the section explicitly notes it with the higher profile's name.

---

## P4. Implementation declaration

An implementation declares the profile it claims via `$system.profile_target`. The conformance suite ([tooling/conformance.md](tooling/conformance.md)) filters by profile, so a first-light impl runs only first-light tests; a v1-core impl runs first-light + v1-core; etc.

A claim of "v1-ops" without v1-core is not coherent — the conformance filter will reject it.
