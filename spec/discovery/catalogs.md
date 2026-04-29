# Catalogs

> Part of the [woo specification](../../SPEC.md). Layer: **discovery**. Profile: **v1-ops**.

The contract for naming, sharing, and importing reusable object sets — the "publish a `$task` library, use it in your world" story. Beyond the wizard-curated `$system` corename map, multi-developer worlds need a way to introduce *named, versioned* sets of base classes that other worlds (or the same world's separate clusters) can adopt.

---

## CT1. Beyond corenames

`$system` corenames ([objects.md §5.3](../semantics/objects.md#53-corenames)) are flat, world-scoped, and curated by wizards. They work for the bootstrap graph (`$root`, `$space`, `$player`) but don't scale to:

- A team publishing their `$timer` and `$reminder` classes for other teams to use.
- A community library (`$markdown_renderer`, `$reaction_set`) that hundreds of worlds want.
- Versioned base classes that evolve (`v1.todo:$task`, `v2.todo:$task`).
- Cross-world reuse (federation v1) where a peer world's `$canvas` shows up in your world.

Catalogs are the answer.

---

## CT2. What is a catalog

A **catalog** is a named, versioned set of objects + verbs + schemas that can be imported into a world. Conceptually:

```
catalog: { id, name, version, objects: [{class, parent, verbs, props, schemas}, ...], metadata }
```

Catalogs are themselves first-class woo objects (descended from `$catalog`); a world's available catalogs live as objects under `$catalog_registry`.

A typical catalog:

```
{
  id:      "@dubspace_lib/v1",
  name:    "Dubspace Library",
  version: "v1.0.0",
  author:  "@hugh",
  classes: [
    { local_name: "$loop_slot",  parent: "@root_lib/v1:$control", ... },
    { local_name: "$delay",      parent: "@root_lib/v1:$control", ... },
    ...
  ],
  metadata: {
    description: "Sound-mixer building blocks.",
    license:     "MIT",
    spec_version: "v0.1.0"
  }
}
```

Class names within a catalog are scoped to the catalog (`$loop_slot` here means "this catalog's `$loop_slot`"). Cross-catalog references use qualified names (`@root_lib/v1:$control`).

---

## CT3. Naming convention

Three-part names: `@<author>/<catalog>/<version>:<class>`.

- `@<author>` — namespace owner, e.g., `@hugh`, `@team_xyz`, `@community`. Handle resolution is the discovery layer's responsibility (peer registries, well-known servers).
- `<catalog>` — the catalog name within the author's namespace.
- `<version>` — semantic-versioned (`v1.2.3`, or `latest`).
- `<class>` — the per-catalog corename for one of its classes.

Examples:

- `@hugh/dubspace/v1:$delay`
- `@community/markdown/v2.1:$renderer`
- `@local:$something` — short form for catalog `local` in the world (no remote import).

Within a single world, catalogs are imported with optional aliases:

```
import_catalog("@hugh/dubspace/v1", as = "dub")
// then `dub:$delay` resolves to the imported class
```

---

## CT4. Distribution

A catalog is published to a registry — an HTTP-accessible server holding catalog manifests. The reference shape:

- **Public registry.** A central or federated set of registries (the URL is well-known); supports listing, search, version lookup. Optional cryptographic signatures attest publication.
- **Private registry.** A team or org runs their own registry; their worlds are configured to look there first.
- **In-world registry.** A world can host its own catalogs locally without external publication; useful for project-internal libraries.

The fetch protocol is HTTPS. A registry exposes:

- `GET /<author>/<catalog>` → list of versions with metadata
- `GET /<author>/<catalog>/<version>` → catalog manifest (V2-canonical JSON)
- `GET /<author>/<catalog>/<version>.sig` → optional signature

Catalogs are content-addressable: the manifest's hash is the canonical id. Two installations of `@hugh/dubspace/v1.0.0` are bit-identical or one is wrong.

---

## CT5. Import

```
import_catalog(catalog_id: str, as?: str, into?: ObjRef) -> ImportResult
```

Imports a catalog into a world (or into a specific anchor cluster). The runtime:

1. Fetches the manifest from the registry.
2. Validates signature (if present) and integrity hash.
3. Resolves the catalog's dependencies (if it depends on other catalogs).
4. Creates the catalog's classes as objects in the importing world, parented appropriately.
5. Records the import in `$catalog_registry` for introspection.

After import, the catalog's classes are addressable as `<as>:<class>` (e.g., `dub:$delay`).

Import is wizard-only by default. The world's policy may delegate to programmer actors for catalogs from trusted authors.

---

## CT6. Versioning

Semantic versioning (`major.minor.patch`):

- **Patch** — bug fixes; same shape; auto-upgrade safe.
- **Minor** — additive (new classes, new verbs); existing imports keep working.
- **Major** — breaking; importing world must explicitly opt in via re-import.

A world may pin a specific version (`@hugh/dubspace/v1.0.3`) or accept a semver range (`@hugh/dubspace/^1.0.0`). The pinned form is canonical for reproducibility; ranges are a convenience.

Major-version upgrades involve migrations ([migrations.md](../operations/migrations.md)) since they may change shapes existing data has.

---

## CT7. Trust and signing

A catalog signature is a cryptographic attestation by the publisher (or registry) that the manifest is genuine. World policy decides what's accepted:

- **Open trust** — accept any manifest from any registry. Suitable for development.
- **Pinned trust** — only accept manifests signed by a known set of keys.
- **Per-author trust** — accept signed manifests from specific authors.

Trust failures (unsigned, wrong signature, untrusted author) result in the import being rejected with `E_TRUST`. Wizards can override on a one-shot basis with full audit.

---

## CT8. Naming collisions

Two catalogs can both define `$control`. Importing both with no aliases collides; the runtime rejects the second import with `E_NAME_COLLISION`. The fix: import one (or both) with an alias.

The world's `$catalog_registry` shows installed catalogs and their aliases for introspection.

---

## CT9. Catalog-bound objects vs world-local objects

Imported classes are *templates* — they exist as objects but aren't expected to be instantiated unless the importing world chooses. A `dub:$delay` is a class; `the_dubspace`'s actual delay is `#delay_42` parented from `dub:$delay`.

Modifications: the importing world *may* override an imported class's verbs and properties (subject to permission), but those overrides are *local*. They do not propagate back to the catalog, and they are lost if the catalog is re-imported (with confirmation prompt to wizard).

The override pattern: `chparent` an instance to a local subclass that wraps the imported class. This is woo's normal mechanism; nothing special for catalogs.

---

## CT10. What's deferred

- **Catalog dependency resolution at scale.** Currently dependencies are inline manifest references; a real-world dependency graph (transitive deps, version constraint solving) is a v2 concern.
- **Catalog removal** (uninstalling an imported catalog while preserving the instances). Tricky — instances of imported classes lose their parent. Out of v1.
- **Catalog forking** ("publish my modified version of yours"). Conventions for fork attribution and version namespacing exist in package ecosystems; not specced here yet.
- **Cross-spec-version catalogs.** A catalog published against spec v1.0 may not load on spec v0.x; the import should refuse rather than try. Semantics specced; tooling deferred.
- **Decentralized registries / DHT / IPFS.** All registries here are HTTPS centralized. Decentralized alternatives are interesting but not first-light.
