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

### 4.2 Host placement

Where an object physically lives — which host owns its persistent storage — is determined at **creation time** by the object's class metadata, not by per-instance configuration. Two cases:

1. **Self-hosted instances.** A class that declares `instances_self_host: true` (inherited through the parent chain) produces instances that each run as their own host. Every instance of such a class gets a dedicated persistent host (in the Cloudflare reference, a Durable Object) at creation, with its own storage, scheduling alarm, and hibernation lifecycle. The `instances_self_host` property is **monotone for the class's lifetime** — it must not be flipped while extant instances exist, because that would split the population across two policies. Catalog-update migrations fail loud on such a flip.

2. **Co-resident instances.** A class without `instances_self_host` produces instances that live on the host of their creator (`progr` of the verb that called `create`). Carryable objects — books, hats, notes — fall here. The instance's `location` may change freely at runtime as it is carried between containers (§10.2 location and contents); host placement does not move with location. A book created on a player's host stays on that host even after it has been put on a table in another room. Lookups of the book through its container are resolved via Directory routing and per-host RPC (see [reference/cloudflare.md §R1](../reference/cloudflare.md#r1-host-mapping)).

Subclass semantics: `instances_self_host` is inherited as a logical OR through the parent chain. A subclass of a self-hosting class is itself self-hosting; a subclass of a co-resident class can opt in by declaring its own flag.

The classes that declare `instances_self_host: true` in v1-core and the bundled first-light catalogs:

- `$room` (and subclasses) — every room has its own log, subscribers, and fixtures, scaling independently of other rooms.
- `$player` (and subclasses including `$wiz`, `$guest`) — every player owns a host for sessions, attached connections, and inventory.
- Anchor spaces declared by demo catalogs: `$dubspace`, `$taskspace`. The `$catalog_registry` and similar v1-ops singletons.

Authority to instantiate self-hosting classes is narrower than ordinary `create()`. Because each instance reserves a real host resource, the `assertCanCreateObject` check requires wizard authority (or an explicit programmer capability grant under v1-ops); ordinary programmer-creates-own-fertile-parent authority is not sufficient. See [permissions.md §11.4](permissions.md#114-progr-and-actor) and [reference/cloudflare.md §R1.1](../reference/cloudflare.md#r11-routing).

The relationship between `host_placement` and `anchor`:

- `host_placement = "self"` is the runtime materialization of `instances_self_host`. The runtime stamps it on the new instance during `create`.
- `anchor` is independent and continues to govern atomicity scope (§4.1). A non-self-hosted object may still anchor to a self-hosted ancestor for atomicity; in practice, most objects do not anchor at all (default `null`).
- The implementation routes a request for an object in this order: if `host_placement = "self"`, the object is its own host; else if its `anchor` resolves to a self-hosted host, route there; else if its `location` resolves to a self-hosted host, route there; else fall back to the gateway/owner host. The catalog-installed pattern of `host_placement: "self"` on `the_dubspace` and anchored controls under it is the canonical example.

### 4.3 Containment and cross-host invariants

`obj.location = container` and `container.contents includes obj` are bidirectional: every move updates both sides. In a single-host world this is one in-memory operation, persisted in a single transaction. Across hosts, the invariant becomes a distributed responsibility:

- The object's `location` field is the **source of truth**. It lives with the object on its own host; the move primitive writes it transactionally on the host that owns the object.
- Each container's `contents` is a **cache** maintained by push-mirror RPC from the host that owns the moving object. When an object's `location` changes, the moving host RPCs the source container's host (`contents.delete(obj)`) and the target container's host (`contents.add(obj, {title})`).
- The cache may drift if a push fails. A reconcile sweep — triggered on `:look` or by periodic policy — verifies each `contents` entry by querying the member's actual `location` via Directory and prunes ghosts. Ghost entries do not affect routing or correctness; they affect rendering until reconciled.

The Directory does not track `location`. It routes `id → host` only. Containment lives with the container; the Directory's job stays scoped to host lookup. See [reference/cloudflare.md §R1.1](../reference/cloudflare.md#r11-routing) for the wire-level mechanics.

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

### 5.3.1 Dynamic corenames

Most corenames are *static*: `$wiz`, `$root`, `$dubspace` are defined at boot and resolve to a fixed ULID via `$system.<name>` lookup. The resolver looks up the corename in a flat map and returns the same answer regardless of context.

A small reserved set of corenames are *dynamic*: their resolution depends on the calling context.

- **`$me`** — the actor making the current call. Resolves to the bearer's actor in REST requests ([rest.md §R9](../protocol/rest.md#r9-me-resolution)), to the frame's `actor` field in verb bodies, and is unset (raises `E_VARNF`) outside any call context. Equivalent to writing `actor` in a verb body; the dynamic corename gives the same identity a name in REST and tooling contexts.
- **`$peer`** — reserved for the calling peer in cross-world contexts ([federation-early.md](../deferred/federation-early.md)). Not active in v1-core.

Dynamic corenames may not be assigned via `set_corename`; the runtime owns their resolution. A wizard with the `impersonate` capability may override `$me` for a single call (REST: `X-Woo-Impersonate-Actor: <ref>` header; verb code: `wiz:as_actor(...)`); the impersonation is logged as a wizard action.

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
3. If no ancestor defines `name` and `obj` is `$actor`- or `$space`-descended, search `obj.features` per [features.md §FT2](features.md#ft2-verb-lookup-with-features).
4. If still no match, raise `E_VERBNF`.

Aliases: a verb's `aliases` field is a list of patterns. Lookup matches the invocation name against the union of the verb's canonical `name` and its alias patterns. Patterns are compiled at `setVerb` time and cached.

**Pattern grammar:**

```
pattern  := segment ( '|' segment )*
segment  := literal | literal '*' | literal '@'
literal  := one or more characters from [a-zA-Z0-9_-], min length 1
```

- A bare `literal` matches the literal exactly: `look` matches only `"look"`.
- `literal*` matches `literal` followed by zero or more characters from `[a-zA-Z0-9_-]`: `ex*` matches `ex`, `exa`, `examine`, `extra`. Useful for "abbreviation acceptable past this prefix."
- `literal@` matches the literal exactly *or* any prefix of it down to the literal's first character: `l@ook` matches `l`, `lo`, `loo`, `look` — i.e., `l@ook` is shorthand for "any prefix of `look` of length ≥ 1." (Same as `l@ook` in LambdaCore convention.) The `@` must immediately follow a literal segment.
- `|` is segment union within one pattern: `look|l@ook` permits both `look` and any prefix.
- Patterns are case-sensitive. A space-separated string of patterns (`"look l@ examine"`) is parsed as a list of three patterns; do not confuse this with a single pattern containing spaces (which is invalid).

**Resolution order.** When multiple patterns from different ancestors match the invocation name:

1. Walk ancestor chain from `this` upward (per §9.1 step 1–2).
2. The first ancestor with *any* matching pattern (canonical `name` or alias) wins.
3. Within that ancestor, ties between `name` and an alias prefer `name`.

**Forbidden.** Patterns with no literal characters (e.g., `*` alone, `@` alone), patterns containing whitespace or special shell characters, and patterns longer than 64 characters all raise `E_INVARG` at `setVerb` time.

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

An implementation may carry ad hoc local property values that do not yet have a
formal property definition, usually from bootstrap or migration. These values are
readable but not public-writable by default; only the object's owner or a wizard
may create or update them through checked VM property operations. Publicly
writable extension points should be explicit property definitions with `w`.

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
