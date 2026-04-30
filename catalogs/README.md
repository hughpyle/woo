# Local Catalogs

Bundled first-party catalogs for the reference woo demos.

These files are source/catalog data. The v0.5 runtime still bootstraps the demo
objects directly from `src/core/bootstrap.ts`; the catalog installer will later
consume these manifests through `@local:<catalog>` and replace the hard-coded
demo bootstrap path.

Each catalog owns its app-level design in `DESIGN.md`; platform-wide contracts
stay under `spec/`.

Install order for the full demo world:

1. `@local:chat`
2. `@local:taskspace`
3. `@local:dubspace`
