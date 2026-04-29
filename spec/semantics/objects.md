# Objects, identity, verb dispatch, properties

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**. Profile: **v1-core**.

Covers the object model (§4), identity and addressing (§5), verb dispatch and inheritance (§9), and property definition/value/inheritance semantics (§10).

---

## 4. Object model

Every object has:

| Field | Type | Notes |
|---|---|---|
| `id` | objref | Stable, unique. Persistent: `#nnn`. Transient: `~nnn@host`. |
| `name` | str | Human-readable, not unique. |
| `parent` | objref \| `#-1` | Single inheritance. `#-1` = no parent. |
| `owner` | objref | The user object that controls this object. |
| `location` | objref \| `#-1` | The object's container. May be remote. May change at runtime (this is what "moving" means). |
| `anchor` | objref \| `null` | Host placement. `null` = own host (default). Set = share host with anchor object. **Immutable after creation.** See §4.1. |
| `flags` | bitset | `wizard`, `programmer`, `fertile`, `recyclable`. (See §11.) |
| `created`, `modified` | int (ms) | Audit. |

It additionally has tables of:

- **Verbs** defined locally (name, source, compiled bytecode, owner, perms, version).
- **Property values** locally (name, value, owner override, perms override).
- **Property definitions** locally (name, default value, type hint, owner, perms) — these introduce a new property visible to descendants.
- **Event schemas** declared locally (event-type → JSON-Schema-ish).
- **Children** (objects whose parent is this).
- **Contents** (objects whose location is this).

Inheritance is **single-parent**. There is no multiple inheritance and no mixin support in v1.

`location` is a separate axis from `parent`. A `#sword` object's *parent* is `#weapon`; its *location* is `#room5` (it's lying on the floor). LambdaMOO conflated these in early versions; we don't.

### 4.1 Anchor and atomicity scope

`anchor` is a structural placement decision: an object with `anchor = X` lives on the same host as `X`, and a verb body that mutates objects within one anchor cluster runs as a single atomic transaction. Cross-cluster mutations (a verb call from one cluster into another) are not atomic; partial failures are observable.

Constraints:

- `anchor` must be a persistent objref. Transients can't anchor anything; transients live on their player's host.
- Anchor relationships form a tree — no cycles. Anchoring places transitively: if `B.anchor = A` and `C.anchor = B`, then `C` lives on `A`'s host.
- **`anchor` is set at creation time and cannot be changed.** Re-anchoring would be a recursive host migration with task drain, routing redirects, and an atomicity-scope shift. v1 does not provide it. If an object truly needs to live in a different cluster, the answer is: create a new object in the target cluster, copy state, recycle the old. Routine "move this object to that container" is a `location` update — that's free and unrelated to anchor.
- `anchor` is independent of `parent` (inheritance) and `location` (containment). The three axes don't constrain each other.

Default: `anchor = null`. Use anchoring deliberately, when atomic coordination across a cluster is the design intent. The dubspace is the canonical example: `$mix`, `#delay`, `#channel`, `#scene` all anchor on `$mix`, share one host, and `$mix:call` mutates them atomically. Most objects in most worlds don't need an anchor.

---

## 5. Identity and addressing

### 5.1 Persistent refs

`#` followed by a 26-character Crockford base32 ULID, e.g. `#01HXYZAB12CDEFGH34JKMNPQRS`. ULIDs are time-ordered (sortable by creation time) and globally unique without central coordination.

Source code mostly refers to objects by corename (`$wiz`, `$room`); raw IDs appear at runtime and in serialized data.

Reserved:
- `#-1` — `NOTHING` / null reference.
- `#0` — `$system`, the bootstrap object. Renders as `#0` for ergonomics; internally a reserved ULID `#00000000000000000000000000`.

UUIDv7 is an acceptable alternative if RFC 9562 conformance matters more than ergonomics; the runtime treats both as opaque strings, picked per-world by configuration. Default: ULID.

### 5.2 Transient refs

`~nnn@#mmm` where `nnn` is unique within host `#mmm`'s session. Lifetime ends when host `#mmm`'s connection closes. Allocated by the host on instantiation; not coordinated globally.

Within source code on a host, the bare form `~nnn` resolves to the local host. Cross-host transient refs use the qualified form.

### 5.3 Corenames

`$foo` is shorthand for `#0.foo` (the `foo` property of `$system`). A typical bootstrap world has `$root_object`, `$player`, `$room`, `$thing`, `$wiz`, etc. Resolution is at compile time when possible (statically known property), falls back to runtime lookup otherwise.

### 5.4 Federated origins (reserved)

In federated contexts, refs are qualified by origin: `#42@world-a.example`. The unqualified form `#42` is shorthand for "the local world's origin." See [../deferred/federation.md §24.3](../deferred/federation.md#243-qualified-identity). v1 ships single-world; non-local origins raise `E_FED_DISABLED` at runtime, but the qualifier syntax is parsed and stored in the AST so v2 federation is a non-breaking change.

### 5.5 ID allocation

ULIDs are minted **locally** in the issuing host's process. There is no central allocator on the hot path:

1. A verb runs `create($room, $owner)` on some host H.
2. H mints a ULID locally (in-process, no RPC).
3. H references the new id; the persistence layer brings the new persistent host into existence on first access.
4. H updates its own `child` table if it is the parent, or notifies the parent.

This decouples object creation from any singleton bottleneck. Creation rate is bounded by the persistence layer's instantiation throughput.

Routing is implicit: the ULID *is* the persistent host's name. See [../reference/cloudflare.md §R1.1](../reference/cloudflare.md#r11-routing) for the v1 mapping.

### 5.6 The Directory

The Directory host is a singleton holding small, read-mostly tables:

- **Corename map**: `$system → ULID`, `$root_object → ULID`, `$wiz → ULID`, etc. Dozens of entries, edited only by wizards.
- **World metadata**: bootstrap state, schema version.

The Directory is **not** in the path of ID allocation, runtime routing, or dispatch. It is read-cacheable and rarely written.

There is no global object registry, by design. "All instances of `$room`" is answered by walking `children($room)` recursively. Operations requiring host enumeration (cleanup, stats, dump) go via the runtime's management plane (see [../reference/cloudflare.md §R2](../reference/cloudflare.md#r2-singleton-dos)), not the runtime API.

---

## 9. Verb dispatch and inheritance

### 9.1 Lookup

Given `obj:name(args)`:

1. Start at `obj`. If verb `name` is defined locally, use it.
2. Else recurse to `obj.parent`, repeat.
3. If no ancestor defines `name`, raise `E_VERBNF`.

Aliases: a verb's `aliases` field is a list of patterns (`look l@ examine`) where `@` matches any suffix. Patterns are compiled at `setVerb` time; lookup matches against the union of `name` and patterns.

### 9.2 Cache

The lookup result `(obj, name) → (definer, verb_version, bytecode)` is cached on the host running the call. Cache entry includes `definer`'s version counter; entries are invalidated by push from `definer` (see [../reference/persistence.md §15.3](../reference/persistence.md#153-invalidation)).

### 9.3 Pass

`pass(args)` resolves the next verb up the chain from the *current frame's* `definer`. It does *not* re-check from `this`. This makes overrides composable.

### 9.4 Permission check

A verb's `perms.x` must be set to be callable, OR the calling `progr` must own the verb, OR `progr` is a wizard.

### 9.5 No cross-world parents

A persistent object's parent must be in the same world. `chparent(obj, new_parent)` rejects qualified non-local parents with `E_FED_DISABLED`. Cross-world references remain valid for messaging (verb calls, events, property reads); only the inheritance edge is restricted. See [../deferred/federation.md §24.5](../deferred/federation.md#245-no-cross-world-inheritance).

---

## 10. Properties and inheritance

### 10.1 Lookup

Given `obj.name`:

1. If `obj` has a stored value for `name`, return it.
2. Else walk `obj.parent` chain. For each ancestor:
   - If the ancestor *defines* `name`, return its default value.
   - Else continue.
3. If no ancestor defines `name`, raise `E_PROPNF`.

Note the asymmetry: a property *definition* lives on one specific ancestor (with metadata: owner, perms, default). The *value* lives on any descendant that has set it. A descendant without an explicit value sees the default from the defining ancestor.

### 10.2 Setting

`obj.name = val`:

1. Find the defining ancestor (chain walk + cache).
2. Permission check: caller `progr` must have `w` on the prop, OR own the value owner, OR be a wizard.
3. Write the value into `obj`'s own `property_value` table. Does *not* propagate to descendants.

### 10.3 Defining

`define_prop(obj, name, default, perms)` (compiled to `DEFINE_PROP`):

1. `obj` must not have `name` defined or visible from its chain.
2. `progr` must be `obj.owner` or a wizard.
3. Adds row to `obj`'s `property_def` table.
4. Children of `obj` that try to set this prop will write to their own `property_value` (no migration of existing data needed).

### 10.4 Clearing

`clear_prop(obj, name)`:

1. Removes any stored value on `obj`. Subsequent reads see the default.

### 10.5 `chparent`

Re-parents an object. Constraints:

1. New parent must not be a descendant of `obj` (no cycles).
2. Properties defined on the *old* parent chain that aren't on the *new* chain are dropped from `obj` (or its descendants); properties newly visible in the new chain take their defaults.
3. Verb cache on `obj` and all descendants is invalidated.

This is rarely called in practice but must be sound.

> **Open question (LATER):** "drop orphaned property values" is the current draft. "Preserve as orphan values readable via `obj.orphans["prop_name"]`" is also defensible — preserves user data on a misclick. Defer until use-case clarifies. See [LATER.md](../../LATER.md).
