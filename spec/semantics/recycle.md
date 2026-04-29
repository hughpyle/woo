# Recycle

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**. Profile: **v1-core**.

The normative semantics for destroying an object via the `recycle(obj)` builtin. LambdaMOO's `recycle()` had subtle load-bearing behavior — child tasks killed, parent bookkeeping cleared, ULID retired — that needs to be specified explicitly so implementations don't diverge.

---

## RC1. Contract

`recycle(obj)` is a builtin that destroys a persistent object. It is irreversible. After `recycle` returns successfully, `obj`:

- Is removed from the Directory (corename → ULID map, if registered).
- No longer accepts verb calls or property reads/writes.
- Has its parent and location chains broken (cleared as described in §RC3).
- Its ULID is tombstoned: not reused, not reassigned. Lookups return `E_INVOBJ`.
- Its anchor cluster's storage rows for the object are deleted.

`recycle` runs as part of a sequenced call (typically a wizard or programmer verb body); the destruction is part of the call's atomic transaction.

---

## RC2. Permissions

`recycle(obj)` succeeds iff the calling `progr` is one of:

- A wizard.
- The owner of `obj` (per [permissions.md §11.1](permissions.md#111-ownership)).

Otherwise raises `E_PERM`.

`obj` itself is not consulted for opt-out — there is no "this object refuses to be recycled" mechanism. `:on_recycle` (§RC4) is a notification, not a veto. Wizards may need to remove load-bearing seed objects; the operation must be available.

---

## RC3. Bookkeeping

`recycle(obj)` performs these cleanup steps in order, all within the same transaction:

1. **Fire `:on_recycle`** on `obj` if defined (see §RC4). Failures are caught and logged; they do not abort the recycle.
2. **Kill parked tasks anchored to `obj`.** Any task in the `task` table with `target == obj`, `parked_on == obj`, or where the suspended frame's `this_ == obj` is removed and abandoned. The task is marked `state: 'killed'` if any consumer is watching for completion.
3. **Walk `children`.** For each child `c` whose `parent == obj`, set `c.parent = obj.parent` (graft up). If `obj` had no parent (only `$system` qualifies), children are reparented to `$root`.
4. **Walk `contents`.** For each contained `c` whose `location == obj`, set `c.location = null` (move to nowhere).
5. **Walk parent-side bookkeeping.** Remove `obj` from `obj.parent.children`.
6. **Walk container-side bookkeeping.** Remove `obj` from `obj.location.contents` if applicable.
7. **Invalidate verb-lookup caches.** Hosts holding cache entries with `definer == obj` invalidate them ([persistence.md §15.3](../reference/persistence.md#153-invalidation)).
8. **Delete storage.** All `object_id == obj` rows in the persistence schema (objects, properties, verbs, sessions if any, etc.) are deleted.
9. **Tombstone the ULID.** Mark in the Directory (or anchor cluster's metadata) that this ULID was recycled. Lookups thereafter return `E_INVOBJ`.

If any step fails (storage error, cross-host RPC failure during cache invalidation), the transaction rolls back and the object is not recycled. `recycle` raises the underlying error.

---

## RC4. The `:on_recycle` handler

If `obj` defines `:on_recycle()`, it is called before any of the destruction steps (§RC3 step 1). The handler runs with:

- `this = obj`
- `progr = obj.owner` (the handler runs with the object's own authority, not the caller's)
- A small tick budget (default 1000 ticks; configurable via `$system.recycle_tick_budget`).

The handler may:

- Emit observations (e.g., `{type: "recycled", source: this}` to its space's subscribers, so UIs can refresh).
- Clean up external state (notify peers, close sockets on transient hosts).

The handler may **not**:

- Veto the recycle. Any return value or raise is logged; the recycle proceeds.
- Mutate state in objects outside its anchor cluster. Cross-cluster mutations are not in the rollback scope and may leak if recycle later fails.

If `:on_recycle` raises, the error is caught and recorded as a recycle observation (`{type: "$recycle_handler_error", code: ..., obj}`); recycle continues.

---

## RC5. Dangling references

After `recycle(obj)`:

- Other objects holding `obj` as a property value retain the ULID. The objref is now a *dangling reference*: it points to a tombstoned ULID.
- Verb calls on a dangling reference raise `E_INVOBJ`.
- Property reads on a dangling reference raise `E_INVOBJ`.
- Equality comparison still works: two dangling refs to the same ULID are still equal per [values.md §V3](values.md#v3-equality). This is required for replay determinism.

Cleanup of dangling references is **not** automatic. Authors who care write `:on_recycle` handlers in containing objects (e.g., a `$task` whose `assignee` was recycled clears the field) or sweep periodically with a wizard verb. The runtime does not GC for you.

---

## RC6. Forbidden recycles

The following objects must not be recycled:

- `$system` (`#0`).
- The universal classes `$root`, `$actor`, `$player`, `$wiz`, `$sequenced_log`, `$space`, `$thing`.
- An object that is the `parent` of a non-empty descendant chain *and* is a universal class. (Demo classes can be recycled if their instances are recycled first or grafted up.)
- The current actor's own player object (would orphan the session). The session-binding layer enforces this.

Attempts raise `E_INVARG` ("cannot recycle reserved object") or `E_PERM` (for the player-self case).

The wizard may force-recycle reserved objects via `wiz:force_recycle(obj)`, which logs a wizard action and proceeds. This is for irreversible world-teardown only and should not appear in normal operation.

---

## RC7. Recycle vs. unanchor

Recycle destroys the object. **Unanchoring** (changing an object's anchor cluster) is a separate operation and is not in v1 — anchors are immutable per [objects.md §4.1](objects.md#41-anchor-and-atomicity-scope). To "move" an object, recycle and recreate it under the new anchor, which is a deliberate operation an author chooses, not an implicit migration.

---

## RC8. Errors

| Code | Meaning |
|---|---|
| `E_PERM` | Caller lacks wizard or ownership. |
| `E_INVARG` | Object is reserved (§RC6). |
| `E_INVOBJ` | Object already recycled or never existed. |
| `E_STORAGE` | Storage layer failed during the destruction transaction. The object is not recycled. |

---

## RC9. Conformance

The conformance suite ([conformance.md §CF3](../tooling/conformance.md#cf3-required-categories)) covers:

- Recycle of a leaf object (no children, no contents, no parked tasks).
- Recycle that triggers child reparenting.
- Recycle that kills parked tasks.
- Recycle of a forbidden object (must raise `E_INVARG`).
- `:on_recycle` handler observation emission.
- Dangling reference behavior (`E_INVOBJ` on call/read).
