# Local Catalogs

Bundled first-party catalogs for the reference woo demos.

These files are the source/catalog data consumed by the local catalog installer.
`src/core/bootstrap.ts` seeds the universal model and then installs these
manifests through `@local:<catalog>`; demo classes and instances are not seeded
directly in bootstrap.

The manifests carry DSL source as the catalog contract. Some verbs also carry a
v0.5 `implementation` hint that points at a native handler or bytecode fixture
while the DSL/runtime grows enough to express the full behavior directly.

Each catalog owns its app-level design in `DESIGN.md`; platform-wide contracts
stay under `spec/`.

Install order for the full demo world:

1. `@local:chat`
2. `@local:taskspace`
3. `@local:dubspace`
