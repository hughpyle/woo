# Tech Debt Audit — woo

Generated: 2026-04-30 · against commit `a5fe91c` (main)

Scope: `src/` (~12k LOC), `tests/`, `e2e/`, surrounding manifests and specs. Tests pass 98/98; both tsconfigs are clean; `npm audit` reports zero vulnerabilities.

## Executive summary

1. **Implementation code still hardcodes object names** (F050). `world.ts`, Worker routing, and the client still reference `the_dubspace` / `the_taskspace` / `the_chatroom` / `slot_1..4` / `channel_1` / `filter_1` / `delay_1` / `drum_1` / `default_scene` in many places. The catalog-specific native verb half of this problem is fixed in the current worktree: chat, taskspace, and dubspace verbs now install from catalog source alone. Per the project rule: **object-name literals in implementation code are a bad smell and must be prioritized for eradication.** If bundled core objects are required temporarily, their names must live in one core seed data source — not scattered through runtime logic. Bundled catalogs are loaded because of their location, not because the runtime recognizes their names or app roles. This is the single biggest architectural debt.
2. **Two parallel REST/WS implementations still create drift pressure** (F002). The first fix batch repaired `/api/state` auth parity (F005), Worker impersonation audit (F015), and the `/api/object` IDE alias (F009), but those fixes landed in separate code paths. The structural problem remains: every route still has to be kept aligned manually.
3. **`WOO_SEED_PHRASE` no longer pretends to be implemented** (F006 fixed in the current worktree). The Worker no longer fail-fasts on a seed phrase it does not read, and the Cloudflare/deploy specs now say seeded deterministic ID allocation is deferred until a real allocator exists.
4. **`world.ts` is a large god class**, owning bootstrap, persistence, sessions, presence, VM dispatch, parked tasks, snapshots, audit, schema, replay, and identity (F001). The catalog-specific native verbs have been removed, but the class remains the first place every backend bug ends up.
5. **Two parallel SQL repositories** (`sqlite-repository.ts` 773 LOC, `cf-repository.ts` 878 LOC) duplicate the schema and `verbFromRow` / `verbFlagsJson` byte-for-byte (F003). The verb-flags persistence bug fixed in `ed16b6d` had to be patched in both backends precisely because of this.
6. **`CFObjectRepository`, `PersistentObjectDO`, `DirectoryDO`, `index.ts` have zero unit-test coverage** (F004). The conformance harness only runs against in-memory + LocalSQLite. The CF backend is exercised only by manual `wrangler deploy` smoke tests.
7. **Cluster Durable Objects bootstrap a full shadow world** (F007). Each anchor cluster (`the_dubspace`, `the_taskspace`) re-runs `createWorld({ catalogs })`, replicating 50+ objects, its own `$wiz`, and its own (separately consumable) `WOO_INITIAL_WIZARD_TOKEN` ledger. Hidden cost: storage waste, divergent shadow state, dual-claim risk if a cluster DO becomes reachable.
8. **`as unknown as X` cast farm** in `world.ts` (35), `repository.ts` (22), `cf-repository.ts` (10), `tiny-vm.ts` (8). All routed through `cloneValue()` / `cloneRepoValue()`, which are typed `WooValue → WooValue`. A single `cloneTyped<T>(v: T): T` wrapper would erase ~80 casts (F012).
9. **`client/main.ts` is 1,289 lines, single-file SPA, with `: any` everywhere** for `world`, `dubspace`, `task`, `observation` (F008). Rendering is `innerHTML = template literal` driven by an untyped state tree.
10. **The bundled-catalog index is now location-driven, but generated** (F034). That is the right architecture for non-filesystem deployment targets, and standard npm scripts regenerate it, but it needs to stay a generated artifact rather than drift back into a hand-authored catalog list.

Open severity counts after current batch: 6 Critical, 7 High, 14 Medium, 14 Low (41 open) · fixed in current worktree: F005, F006, F009, F011, F015, F022, F027, F033, F039, F042.

## Architectural mental model

`woo` is a programmable LambdaMOO-successor. The runtime is one TypeScript object graph (`WooWorld` in `src/core/world.ts`) implementing the spec's value model, single-parent inheritance, sequenced/direct call dispatch, a custom bytecode VM, sessions, parked tasks, and audit. It's persistence-agnostic via two interfaces: `WorldRepository` (whole-world save/load, used pre-bootstrap) and `ObjectRepository` (per-object incremental writes, used after `enableIncrementalPersistence()`).

Three deployment surfaces wrap the same `WooWorld`:
- **`src/server/dev-server.ts`** — Node `http` + `ws`, SQLite via `node:sqlite`. The original local-dev path.
- **`src/worker/persistent-object-do.ts`** — Cloudflare Durable Object hosting the world via `state.storage.sql`. Now also forwards object routes to a `DirectoryDO`-resolved cluster host (`the_dubspace`, `the_taskspace`).
- **`src/client/main.ts`** — single-file vanilla-TS SPA, talks WS + REST.

The current cut is mid-refactor: a multi-DO routing layer (gateway + Directory + cluster hosts) shipped at commit `58d763a` and `a5fe91c`. The `WooWorld` runtime is **not yet host-scoped** — every cluster DO bootstraps the entire seed graph and runs verbs locally, so cross-host calls fall back on a shadow copy rather than a real RPC. The Cloudflare side is meaningfully ahead of the dev-server in security posture (auth-gated `/api/state`, sanitized internal headers, actor-permission filtering), and that asymmetry is itself the source of several findings.

This contradicts the README at `README.md:24` which claims the Cloudflare slice is "deployed" without flagging the divergence — but it's accurate to `notes/impl-cf-deploy.md` which explicitly calls out the cluster-bootstrap shadow as known debt (lines 149, 167–169).

## Findings

| ID | Category | File:Line | Severity | Effort | Description | Recommendation |
|----|----------|-----------|----------|--------|-------------|----------------|
| F001 | Architectural decay | `src/core/world.ts:1-2388` | High | L | God class. 2,388 LOC, 123 public methods, owns bootstrap / persistence / sessions / presence / VM dispatch / parked tasks / snapshots / audit / schema / replay / identity. Most-modified file in the repo (10 commits in 6 months). | Extract along seam lines that already exist — `Persistence` (lines ~1138–1260), `Sessions` (~408–520), `ParkedTasks` (~870–1006), `Snapshots` (~1097–1137). Don't rewrite — pull pure functions out one cluster at a time, leaving `WooWorld` as a façade. |
| F002 | Architectural decay / duplication | `src/server/dev-server.ts:43-617`, `src/worker/persistent-object-do.ts:79-380` | Critical | L | Two parallel REST + WS implementations. Same routes (`/api/auth`, `/api/state`, `/api/objects/{id}/...`, `/api/taps`), same WS ops (`auth/ping/call/direct/replay/input`), same broadcast helpers (`broadcastApplied`/`broadcastTaskResult`/`broadcastLiveEvents` — 33 occurrences across both). | Extract a `wireRoutes(adapter)` factory that takes a request/response adapter (Node `http` vs Web `Request`) and exposes one definition. Same for WS frame dispatch. |
| F003 | Architectural decay / duplication | `src/server/sqlite-repository.ts:486-593`, `src/worker/cf-repository.ts:637-744` | Critical | M | Two SQL repositories duplicate schema and helpers (`verbFromRow`, `verbFlagsJson` are byte-for-byte identical — `sqlite-repository.ts:666` and `cf-repository.ts:769`). The verb-flags persistence bug at `ed16b6d` had to be fixed in both. | Pull schema and row-mapping helpers into a shared `src/core/sql-shape.ts`; each backend keeps just the `exec`/`prepare` adapter. |
| F004 | Test debt | `tests/conformance.test.ts:24-37`, `tests/object-repository.test.ts:5-7`, `tests/persistence.test.ts:8-9` | Critical | M | `CFObjectRepository`, `PersistentObjectDO`, `DirectoryDO`, and `src/worker/index.ts` have zero unit/integration test coverage. Conformance only runs against `InMemoryObjectRepository` + `LocalSQLiteRepository`. CF backend is verified only via live deploy. | Add a Miniflare-driven test harness; run the existing conformance backends array against `CFObjectRepository`. The `notes/impl-cf-deploy.md:30` already lists this as planned but deferred. |
| F005 | Consistency rot / Security | `src/server/dev-server.ts:47`, `src/worker/persistent-object-do.ts:122` | Fixed | S | **Fixed in current worktree.** `/api/state` used to be unauthenticated on dev-server while Worker required a session + actor filtering. Dev now requires `Authorization: Session <id>` and calls `world.state(session.actor)`. | Keep the parity test pressure in e2e; the longer-term fix is still F002 (one REST implementation). |
| F006 | Doc drift / Security | `src/worker/persistent-object-do.ts`, `spec/reference/cloudflare.md §R14.5` | Fixed | S | **Fixed in current worktree by downgrading the contract.** The Worker no longer checks `WOO_SEED_PHRASE`, deploy docs no longer require it, and §R14.5 now states seeded deterministic object-id allocation is deferred. | When the allocator exists, add a new explicit deploy contract and tests before reintroducing a seed phrase. |
| F007 | Architectural decay | `src/worker/persistent-object-do.ts:246`, `src/worker/directory-do.ts:51-65`, `notes/impl-cf-deploy.md:149` | High | L | Cluster Durable Objects (`the_dubspace`, `the_taskspace`) each run `createWorld({ catalogs })` — full bootstrap, full seed graph, separate `$wiz`, separate consumable wizard-token ledger. Storage waste plus divergent shadow state plus dual-claim risk if a cluster DO is ever reachable from outside the gateway path. | Tracked as known debt. Until the runtime is host-scoped, at minimum: (a) refuse `/api/auth` on non-gateway hosts (cluster DOs should fail-loud on auth), (b) load host-owned object state from repository/directory data rather than re-auto-installing the bundled catalog set, (c) HMAC the internal-header tuple with `WOO_INTERNAL_SECRET` so a forged request to a cluster binding can't impersonate a session. |
| F008 | Type debt | `src/client/main.ts:8`, `:11`, `:23`, `:189`, `:230`, `:273`, `:418`, `:432`, `:798`, etc. | High | M | Client SPA uses `: any` for the entire runtime state tree (`world?: any`, `dubspace: any`, `task: any`, `observation: any`, function params). 1,289-line file with no contract surface. Bug class: shape changes on the server silently break the client. | Generate (or hand-write) types from the Worker's `state()` return shape and the WS frame union; thread them through `state.world`, `receiveLiveEvent`, render functions. |
| F009 | Consistency rot | `src/server/dev-server.ts:50`, `src/client/main.ts:1075`, `src/worker/persistent-object-do.ts` | Fixed | S | **Fixed in current worktree by compatibility alias.** `/api/object?id=...` existed in dev-server only; client IDE tab calls it. Worker now exposes the same inspected-object shape so the IDE no longer silently 404s before authoring. | Longer-term, port the IDE to the spec'd `/api/objects/{id}` plus proper authoring endpoints and retire the singular alias. |
| F010 | Type debt | `src/core/repository.ts:498-742` (22 sites), `src/core/world.ts:685-1097` (35 sites), `src/worker/cf-repository.ts:96-722` (10 sites), `src/core/tiny-vm.ts:273-857` (8 sites) | High | S | `as unknown as X` cast farm. Pattern: `cloneRepoValue(x as unknown as WooValue) as unknown as T`. ~80 sites. Casts hide real shape errors at trust boundaries. | Add `function cloneTyped<T extends Cloneable>(v: T): T { return cloneRepoValue(v as unknown as WooValue) as unknown as T }` and inline the existing double-casts. The two-cast-per-call cost goes to zero. |
| F011 | Architectural decay | `src/core/repository.ts` | Fixed | S | **Fixed in current worktree.** `InMemoryWorldRepository` was dead code. `InMemoryObjectRepository` already implements both `ObjectRepository` and `WorldRepository`, and no imports referenced the older class. | None. |
| F012 | Architectural decay | `src/core/world.ts → src/core/tiny-vm.ts → src/core/world.ts` | Medium | M | 3 circular dependencies (madge): `core/authoring.ts > core/world.ts > core/catalog-installer.ts`, `core/world.ts > core/catalog-installer.ts`, `core/world.ts > core/tiny-vm.ts`. Currently survive because of TS hoisting, but order-of-import bugs are guaranteed to bite once anything moves. | Break the cycle by moving the `world ↔ tiny-vm` shared types into `types.ts` (or a new `vm-types.ts`). Same for `catalog-installer` — pull the `world`-touching surface into a thin adapter. |
| F013 | Test debt | `playwright.config.ts:9-11` | Medium | S | `fullyParallel: false`, `workers: 1`. Single-test sequential. Run time scales linearly with feature count and is already noticeable on the 8-test smoke. | Increase workers; the SQLite db at `WOO_DB=.woo/e2e.sqlite` is the shared-state contention point — give each worker its own temp DB. |
| F014 | Test debt | `e2e/smoke.spec.ts:1-391` | Medium | M | E2E only runs Chromium (`playwright.config.ts:18`). No Firefox / WebKit. WebSocket and SSE behavior diverges across engines. | Add at minimum WebKit since CF clients hit it heavily; Firefox if cycles allow. |
| F015 | Security | `src/worker/persistent-object-do.ts:474`, `src/server/dev-server.ts:464` | Fixed | S | **Fixed in current worktree.** Wizard-impersonation via `X-Woo-Impersonate-Actor` header is now audited in the Worker as well as dev-server. | Keep this covered when F002 collapses REST handling into one route implementation. |
| F016 | Security / Architectural decay | `src/worker/persistent-object-do.ts:450-466`, `src/worker/index.ts:91-104`, `notes/impl-cf-deploy.md:169` | High | M | Cluster DOs trust `x-woo-internal-{session,actor,expires-at,token-class}` headers blindly. The gateway sanitizes inbound public copies (`index.ts:sanitizePublicHeaders`), but if any other Worker/code path in the CF account calls a cluster DO directly (`env.WOO.idFromName("the_dubspace")`), it impersonates any session at will. | HMAC the tuple with `WOO_INTERNAL_SECRET` (note already in the impl-cf-deploy debt list). Reject unsigned/forged tuples on the cluster side. |
| F017 | Architectural decay | `src/worker/index.ts:61-89` | Medium | S | Body-clone chain to peek at `body.space` before forwarding. `request.clone()` then `withDirectorySession(request)` then `forwardToHost(routed)` each construct `new Request(prev, { headers })`. Lazy stream chaining works in CF today but is fragile and not obvious — already commented as such at `:71`. | Buffer the body once into an `ArrayBuffer` at the entry point if `parseObjectRoute` matched; reuse that buffer for both the peek and the forward. |
| F018 | Performance | `src/worker/persistent-object-do.ts:61`, `:634-647` | Low | S | WS host resolution now has a per-DO `routeCache`, so the original "RPC on every frame" issue is partly fixed. Missing piece: invalidation. Directory route mutations (`/register-objects`) do not notify already-hibernated or active hosts, so stale host decisions can persist until hibernation/restart. | Add a small TTL or route-version check to `routeCache`, or have Directory mutation responses carry a version that hosts can compare before using cached entries. |
| F019 | Architectural decay | `src/worker/directory-do.ts:20-66`, `src/worker/index.ts:168-173` | High | M | `SEEDED_OBJECT_ROUTES` hardcodes object IDs from the chat / dubspace / taskspace catalogs *into the routing oracle*. This is a direct violation of the object-name rule at the transport layer. Runtime-created tasks are registered from `task_created` observations, but that is observation-type-specific and still catalog-aware. | Drive the routing table from catalog/world data: install records, seed hooks, and object creation events carry placement metadata. Directory should not know demo object IDs or observation type names. Drop `SEEDED_OBJECT_ROUTES` once placement is data-driven. |
| F020 | Performance / Architectural decay | `src/worker/persistent-object-do.ts:246` | Medium | M | Every cluster DO auto-installs the same bundled catalog set, creating shadow data it may never serve. This is downstream of F007/F050: the runtime lacks host-scoped object loading, so every host imports a whole local world for verb resolution. | Do **not** add source-level per-host catalog-name filters. The fix is host-scoped world loading driven by repository/directory/catalog install data. A catalog is installed because it is present in the bundled tap or explicitly requested; object placement is separate metadata. |
| F021 | Doc drift | `README.md:36` | Medium | S | README says "Current debt and spec/impl drift is in TECH_DEBT_AUDIT.md" — that file did not exist until now. | This audit fixes the link target. Keep the file living. |
| F022 | Doc drift | `spec/reference/cloudflare.md:641`, `src/worker/persistent-object-do.ts:84-89` | Fixed | S | **Fixed in current worktree.** The old spec line claiming a local-default seed emitted a periodic production warning was removed. F006 now removes the remaining seed-phrase startup check and deploy requirement. | None until deterministic ID allocation is deliberately reintroduced. |
| F023 | Architectural decay | `src/server/sqlite-repository.ts:653-660` | Medium | S | Raw `SAVEPOINT ${name}` interpolation. Internal-controlled name today, but the same pattern in `cf-repository.ts:savepoint()` was deliberately replaced with `transactionSync` because raw `SAVEPOINT` SQL is forbidden through `sql.exec` (per `notes/impl-cf-deploy.md`). The two backends now have different transaction semantics that aren't tested for parity. | Document the divergence at the call site, or add a parity test in conformance. |
| F024 | Performance | `src/core/world.ts:2374-2389` | Low | S | `hashCanonical` uses a 32-bit DJB-ish hash (`hash * 31 + char.charCodeAt(i)`) and `Math.abs().toString(16)`. Used at `world.ts:1105` for snapshot integrity. Sufficient for cache keys; weak for tamper detection. | Either rename + comment that this is a cache key (not integrity), or upgrade to a real `node:crypto` SHA — already imported in `source-hash.ts`. |
| F025 | Type debt | `src/server/sqlite-repository.ts:682` | Low | S | Single `as any` on `parseValue(row.bytecode) as any`. Not catastrophic but inconsistent with the rest of the file's typed parsing. | Type the `bytecode` field on `Row` instead. |
| F026 | Architectural decay | `src/core/world.ts:806`, `:825`, `:839`, `:857` | Critical | M | `state()`, `dubspaceState()`, `taskspaceState()`, `chatState()` are demo-specific aggregates baked into core. The "core" world knows about `the_dubspace` / `the_taskspace` / `the_chatroom` ID strings (`:808-810`). This is a first-order F050 violation, not harmless demo convenience. | Move demo aggregates onto catalog/UI adapters. Core should expose generic object/space descriptions and log/state primitives only. Catalog-specific projections become catalog verbs or catalog-provided UI state adapters. |
| F027 | Documentation drift | `src/worker/persistent-object-do.ts:13`, `tests/core.test.ts` | Fixed | S | **Fixed in current worktree.** `world.state(actor)` now has a unit assertion proving non-readable descriptions are filtered for that actor. | Keep `/api/state` marked as demo aggregate; it is not the production REST read surface. |
| F028 | Test debt | `tests/object-repository.test.ts:7-9` | Medium | S | Object-repository conformance tests both `InMemoryObjectRepository` and `LocalSQLiteRepository` but doesn't share the test body — it's two near-identical `describe` blocks. New invariants will need to be added in two places. | Refactor to a backends array like `tests/conformance.test.ts:24` already does. |
| F029 | Architectural decay | `src/core/fixtures.ts:1-134` | Low | S | Bytecode constants are hand-written op arrays. Knip flags `setControlBytecode`, `claimBytecode`, `setStatusBytecode` as unused (false positive — they're reached through the `fixtureByName` map at `:128`). The map indirection defeats dead-code analysis. | Either remove the indirection (export only the map) or add `// knip-keep` if the map shape is load-bearing. |
| F030 | Performance | `src/core/world.ts:1014-1016`, `:1051` | Medium | M | `exportWorld()` and `importWorld()` use `cloneValue(...)` (which is canonical-JSON round-trip) on every log entry, snapshot, and parked task on every full save. The dev-server path calls `repository.save(this.exportWorld())` whenever incremental persistence isn't active. For dev with 50+ objects and growing logs, every save is O(world). | This is the reason `enableIncrementalPersistence()` exists — but the fallback path is still allocating-heavy. Lazy-clone only when handing across a serialization boundary. |
| F031 | Error handling | `src/core/world.ts:758-770`, `src/core/dsl-compiler.ts`, `src/core/authoring.ts`, `src/core/tiny-vm.ts` | Low | S | `} catch (err) {}` patterns: 14 catch sites I sampled. Many genuinely re-throw or log into observations; some swallow. None obviously broken; all hard to audit later because catch shape isn't standardized. | Add a `silentCatch(err, ctx)` helper that records to a structured log (or no-op in prod). Move all bare `} catch {}` through it for grep-ability. |
| F032 | Error handling / Observability | `src/server/dev-server.ts:184` | Low | S | Only structured log in the entire server is `console.log("woo dev server http://localhost:" + port)`. No request log, no error log on the WS path, no per-DO metrics. Spec at `spec/operations/observability.md` describes 9 categories of observability. | Add at minimum: `wsConnect` / `wsClose` / `wsError` log, REST `request` log with status, slow-call (>50ms) flag. |
| F033 | Dependency hygiene | `package.json` | Fixed | S | **Fixed in current worktree.** `@vitejs/plugin-basic-ssl` was unused and has been removed from `package.json` / lockfile. | None. |
| F034 | Architectural decay | `src/core/local-catalogs.ts:1-30`, `src/generated/bundled-catalogs.ts` | Low | S | The hand-coded local catalog list has been replaced by a generated bundled catalog index derived from `catalogs/*/manifest.json`. Remaining debt: generated code can drift if someone runs non-npm tool commands directly, and the generated file necessarily contains catalog paths. | Keep `catalog:index` in predev/pretest/pretypecheck/prebuild. If this becomes brittle, move generated output to build artifacts or a virtual module. Do not reintroduce source-authored catalog-name lists. |
| F035 | Type debt | `src/core/types.ts:138`, `src/core/repository.ts:112`, `src/core/tiny-vm.ts:18,38,52,71`, `src/core/world.ts:55,72`, `src/server/github-taps.ts:14,21`, `src/server/json-folder-repository.ts:20`, `src/core/catalog-installer.ts:82`, `src/core/local-catalogs.ts:9` | Low | S | 13 unused exported types per knip. Some are referenced only internally and could be private; some are stale. | One pass with knip's `--include types`; drop the genuinely-unused, mark the rest `internal`. |
| F036 | Performance | `src/core/world.ts:262`, `:289` | Low | S | `describe(objRef)` walks the object's verbs and properties unsorted, allocating a fresh map per call. `/api/state` calls it on **every** object on every refresh — N×M allocations per request. The SPA polls via the WS-applied frame, which triggers a fresh `/api/state` (`client/main.ts:89`). | Memoize describe by `(objRef, version)` — invalidate on `persistObject`. |
| F037 | Test debt | `e2e/smoke.spec.ts:225-330`, `:335-390` | Medium | M | E2E covers REST runtime API and SSE on dev-server only. The Worker's `/api/objects/.../stream` returns 501 — there's no test covering the Worker REST path under load. | Add a Worker e2e suite (Miniflare or live-deploy gated by `WOO_E2E_BASE_URL`). |
| F038 | Documentation drift | `notes/impl-cf-deploy.md:115`, `:144` | Low | S | Notes say `~800 lines` for `persistent-object-do.ts`; current file is 880 LOC. Says SSE returns 501 (still true) and tap-install returns 501 (still true). Otherwise drifted slightly. | Notes are explicitly time-stamped impl snapshots; this is fine, but flag a "last-verified date" header on each. |
| F039 | Consistency rot | `src/worker/index.ts`, `src/worker/persistent-object-do.ts` | Fixed | S | **Fixed in current worktree.** Worker-internal DO requests now use one canonical pseudo-origin, `https://woo.internal`, for both Directory and WOO bindings. | If an internal-auth HMAC lands later, sign the canonical URL/path shape rather than reintroducing alternate pseudo-hosts. |
| F040 | Performance | `src/server/dev-server.ts:187` | Low | S | `setInterval(() => world.runDueTasks(...), 250)` — fixed 250ms tick regardless of next due time. In production CF this is replaced by alarms; dev-server still has fixed wakeups. Not a real cost (dev only) but pollutes CPU on idle. | Switch to `setTimeout(min(resume_at) - now)` reset on every parked-task mutation, mirroring the alarm pattern. |
| F041 | Architectural decay | `src/client/main.ts:332-1000+` | High | L | Single-file SPA with `app.innerHTML = template-literal` rendering. 1,289 lines. No componentization. Adding features means appending to `render()` and praying. | Either adopt a tiny VDOM (uhtml / lit-html), or split into clearly-bounded `render*()` units sharing a typed `state.world`. Don't pull in a framework — just structure. |
| F042 | Security | `src/client/main.ts:290` | Fixed | S | **Fixed in current worktree.** Live-control lookup no longer interpolates runtime target/name into a CSS selector. Controls carry separate `data-target` and `data-name` values, and lookup scans `[data-control]` nodes by dataset. | Keep any future catalog UI code on the same pattern. |
| F043 | Doc drift | `notes/impl-cf-deploy.md:192`, `notes/impl-cf-deploy.md:115` | Low | S | Notes reference "TECH_DEBT_AUDIT F001 lines" before this file existed. Pre-shipping forward references. | Was speculative; this audit's F001 is now the actual link target — accidental coherence. |
| F044 | Architectural decay | `src/core/catalog-installer.ts:289-309` | Medium | S | Several `world.setProp(id, "objects", record.objects as unknown as WooValue)` casts at the trust boundary. Property values are typed `WooValue`; the catalog records are typed differently — the cast erases the contract that the registry stores parseable shapes. | Define a stricter `CatalogRegistryRecord` type and a typed `setRegistryRecord(world, id, record)` helper that does the conversion once. |
| F045 | Test debt | `tests/persistence.test.ts`, `tests/conformance.test.ts` | Medium | S | Persistence tests cover SQLite + JSON folder repos. None cover the `enableIncrementalPersistence` switching mid-flight: the path that goes "load → bootstrap (whole-save) → enableIncremental → continue (per-object)". The verb-flags bug at `ed16b6d` lived precisely in that boundary. | Add a regression test that bootstraps, calls `world.persist()`, enables incremental, mutates, restarts, and asserts state shape. |
| F046 | Architectural decay | `src/worker/persistent-object-do.ts:312-403` | Medium | S | `/__internal/*` routes share a body-readable adapter with the public routes; `try/catch` returns `normalizeError`. But the `/__internal/state` GET route is the only one keyed on a single header (`x-woo-internal-actor`) without sharing the auth path. Cross-route auth state is split across two helpers. | Unify under one `internalSession(request)` helper that decides between header-driven and body-driven session resolution for both internal and public routes. |
| F047 | Documentation drift | `README.md:24-26` | Low | S | "The Cloudflare target now has a gateway DO, a Directory DO, and routed demo-space hosts" — accurate, but the next sentence "full host-scoped runtime decomposition is still in progress" buries the lede that cluster DOs are shadow-bootstrapping the whole world (F007). A user reading the README will reasonably assume routing is correct. | Add one sentence: "Cluster DOs currently bootstrap a full shadow world for verb resolution; per-host scoping is open work." |
| F048 | Performance | `src/core/world.ts:806`, `client/main.ts:89` | Medium | M | The SPA refreshes by calling `/api/state` after every WS `applied` frame — every chat message in a busy room triggers a full world snapshot fetch. `world.state()` walks every object and every property. Compound effect: every chatter pays O(world) on every chat line. | Move the SPA off `/api/state` polling and onto the existing per-frame `applied`/`event` deltas the WS already provides. The current approach was a v0 shortcut. |
| F049 | Documentation drift | `LATER.md:80` | Low | S | `LATER.md` lists "ollama serve (memory provider unavailable in current sessions)" — the `keep` MCP memory has been failing repeatedly during this audit's execution with the same error. Either the operator's `ollama` is down or this isn't actually a TODO. | Decide whether `keep` memory is in or out for this project; remove the dangling todo or fix the embedding provider. |
| F050 | Architectural decay | `src/core/world.ts:444-445`, `:473-474`, `:808-870`, `src/worker/persistent-object-do.ts:279-290`, `src/worker/directory-do.ts:20-65`, `src/client/main.ts` | Critical | L | **Implementation code depends on object-name literals.** References across runtime/transport/client code to catalog-installed instance IDs (`the_dubspace`, `slot_1`, `drum_1`, etc.) plus a hardcoded Directory seed table containing both universal and catalog object refs. The project rule is stronger than "do not reference demo instances": object names should live in data (core seed DB, catalog manifests, install records, Directory rows), not in imperative source. | Migrate each call site: catalog projections become catalog/UI adapters (F026), session presence becomes data-driven policy, routing becomes install/object-placement metadata (F019). Move any truly unavoidable core seed refs into a single seed manifest/imported core DB boundary. Add a CI grep with an allowlist for that one boundary, generated catalog index, tests, and catalog files. |
| F051 | Fixed in current worktree | `catalogs/chat/manifest.json`, `catalogs/taskspace/manifest.json`, `catalogs/dubspace/manifest.json`, `src/core/world.ts`, `src/core/local-catalogs.ts` | Resolved | S | **Catalog-specific native verb implementations have left core.** Chat, taskspace, and dubspace now install user-facing verbs from Woo source. `src/core/world.ts` retains universal native handlers (`describe`, feature management, replay, catalog registry, match scaffolding, player/guest hooks) but no demo-app behavior handlers. A first boot migration (`2026-04-30-source-catalog-verbs`) recompiles already-installed local catalogs from manifest source, repairing stale persisted native rows such as `chat_enter` and `add_subtask`. | Keep this fixed: do not add demo-app handlers back to `WooWorld`. If a future catalog needs a temporary native bridge, it should be explicitly catalog-owned and trusted-local only, with source as the portable contract. |

## Top 5 — if you fix nothing else

### 1. F050 — Get bundled-catalog references out of core

This is the bug class that just bit. The runtime ships bundled catalogs as a convenience, but bundling is a **location property** (`catalogs/*/manifest.json`), not a runtime-recognized application taxonomy. Every line of `src/core/`, `src/server/`, and `src/worker/` must work for an empty world or one with completely different catalogs installed. Today they don't.

Three concrete migrations, smallest first:

```ts
// world.ts:444-445 — kill the conditional ensurePresence
// before:
if (this.objects.has("the_dubspace")) this.ensurePresence(actor, "the_dubspace");
if (this.objects.has("the_taskspace")) this.ensurePresence(actor, "the_taskspace");
// after: presence is a verb on $space; sessions don't auto-attach to instances
//        catalogs that want auto-presence call $session:on_open from their seed
```

```ts
// world.ts:806-870 — drop dubspaceState/taskspaceState/chatState.
// /api/state returns generic object/space/log data only.
// Catalog projections move into catalog/UI adapter surfaces.
```

Then add a CI grep with a deliberately tiny allowlist:

```sh
! grep -rE "the_(dub|task|chat)|slot_[0-9]|channel_[0-9]|drum_[0-9]|default_scene" \
  src/core/ src/server/dev-server.ts src/worker/*.ts
```

This is large (L-effort) but has the highest payoff because it unblocks F007 (cluster shadow worlds), F019 (directory routing), F026 (demo aggregates), and **prevents every future variant of "I assumed `the_X` was always there"** from recurring.

### 2. F002 — Collapse the dual REST/WS implementation

`dev-server.ts` and `persistent-object-do.ts` are 33% duplicate by line count and 100% duplicate by responsibility. Every new endpoint costs two implementations and risks asymmetric gating like F005 / F015 / F009.

```ts
// src/core/wire/routes.ts
export type RestAdapter = {
  authHeader(): string | null;
  readJson(): Promise<any>;
  jsonResponse(body: unknown, status?: number): Response;
  // ...
};
export function wireRoutes(world: WooWorld, env: AdapterEnv) {
  return {
    handle(method: string, pathname: string, adapter: RestAdapter): Promise<Response> { /* one definition */ }
  };
}

// src/server/dev-server.ts now just maps node http → RestAdapter
// src/worker/persistent-object-do.ts now just maps Web Request → RestAdapter
```

Same for the WS frame dispatch. Pulling each route through one definition kills three findings (F005, F009, F015) directly and makes the next CF deploy phase materially cheaper.

### 3. F006 — Stop pretending WOO_SEED_PHRASE exists

Fixed in the current worktree by choosing the honest v1 contract: the Worker no longer requires `WOO_SEED_PHRASE`, the deploy docs no longer ask operators to set it, and `spec/reference/cloudflare.md §R14.5` says seeded deterministic object-id allocation is deferred.

Future allocator work should come back as a new explicit feature: define how runtime-created object IDs are minted, decide whether seeded allocation is still the right portability story, then add runtime tests before reintroducing an operator seed.

### 4. F003 — Share the SQL schema and row mapping

Two repositories with duplicated schemas mean every schema change is two PRs and every persistence bug is two patches. Already happened once (`ed16b6d`).

```ts
// src/core/sql-shape.ts
export const SCHEMA = `CREATE TABLE IF NOT EXISTS object (...) ...`;
export function verbFromRow(row: Row): VerbDef { /* one copy */ }
export function verbFlagsJson(verb: VerbDef): string { /* one copy */ }

// sqlite-repository imports SCHEMA, runs db.exec(SCHEMA)
// cf-repository imports SCHEMA, splits on `;` and execs each (CF requires)
```

Both repositories keep their `prepare`/`exec` adapter; everything above that is shared.

### 5. F004 — Test the CF backend

The CF backend is the only one with no test coverage and is the production target. Even a Miniflare-driven `tests/conformance.test.ts` backend stub would catch the next class of bug before it ships.

```ts
// tests/conformance.test.ts: add a third entry to backends[]
{
  name: "cf-storage",
  make: () => {
    const mf = new Miniflare({ /* SQLite-backed DO */ });
    const repo = new CFObjectRepository(mf.getDurableObjectState(...));
    /* same Harness shape */
  }
}
```

If Miniflare's `state.storage.sql` parity isn't sufficient yet, run the conformance suite against a live `wrangler dev` instance gated by env var.

### Honorable mentions (not in the Top 5 but close)

- **F007** — Stop cluster DOs from claiming the wizard token. Until the runtime is host-scoped (which F050/F051 are prerequisites for), a cluster DO that becomes reachable can claim `WOO_INITIAL_WIZARD_TOKEN` independently of the gateway. Both DOs see the same env. Today this is gated only by "no public route reaches a cluster DO" — true until a refactor breaks it. Two-line fix in `persistent-object-do.ts:fetch` to refuse `/api/auth` on non-gateway hosts (`isGateway = state.id === env.WOO.idFromName("world")`), plus the HMAC on internal headers (F016).

## Quick wins (Low effort × Medium+ severity)

- [x] **F033** — `npm uninstall @vitejs/plugin-basic-ssl` (unused).
- [x] **F011** — Delete `InMemoryWorldRepository`.
- [x] **F015** — Add `world.recordWizardAction(...)` to `persistent-object-do.ts:resolveRestActor` mirror.
- [x] **F009** — Pick: port IDE tab to `/api/objects/{id}` or add `/api/object` alias on Worker.
- [x] **F005** — Make dev-server `/api/state` gate match the Worker (or document the asymmetry).
- [x] **F006** — Stop pretending `WOO_SEED_PHRASE` salts IDs until an allocator exists.
- [ ] **F021** — This file now exists; keep it living.
- [x] **F022** — Strike the `WOO_SEED_PHRASE` warn-loop spec line, or add the timer.
- [x] **F027** — Add a unit test pinning `world.state(actor)` permission filtering.
- [ ] **F029 / F035** — Single knip-driven dead-export pass; keep F034 focused on generated bundled-catalog index drift.
- [x] **F042** — Replace string-concat CSS selector with attribute triple lookup.
- [x] **F039** — Normalize Worker-internal pseudo-hosts.
- [ ] **F049** — Decide if `keep` is in or out of project workflow.

## Things that look bad but are actually fine

- **`directory-do.ts` SQL string interpolation (`SELECT COUNT(*) AS count FROM ${table}`, `DELETE FROM ${table}`)**: the `${table}` value comes from a hardcoded constant list (`OBJECT_TABLES`, etc.), never user input. Same goes for the `ALTER TABLE ${table} ADD COLUMN ${column}` migration calls. Not SQL injection; flagging as a pattern to watch but not fixing.
- **`sqlite-repository.ts:653-660` raw `SAVEPOINT ${name}`**: same — `name` is generated internally by the repository itself. Reads scary, isn't exploitable.
- **The `cf-repository.ts:629` "DROP TABLE IF EXISTS" migration on detected old schema**: this looked like a destructive shortcut but is intentional for the v0.5-only verb-flags migration described in `notes/impl-cf-deploy.md`. The migration runs once on a freshly-deployed DO whose schema predates the verb-flags column. Documented; appropriate for pre-v1.
- **`crypto.randomUUID()` for client-generated frame IDs**: looks like over-strong randomness for what's just a correlation token, but it's the simplest unique-ID primitive in the browser and the entropy cost is negligible.
- **`Math.random()` for socket IDs in `persistent-object-do.ts:515`**: socket IDs are scoped per-DO and only need uniqueness across that DO's lifetime; `Math.random` is fine here. Would be a real finding only if these crossed a security boundary.
- **`@cloudflare/workers-types` listed under `devDependencies`**: types-only dep, nothing imported at runtime; worker-bundle excludes it correctly via `tsconfig.worker.json`. Right where it should be.
- **The 9 unused exports knip flags in `fixtures.ts`**: false positive — `fixtureByName` map at `fixtures.ts:128` references all of them; knip can't trace the map index. Confirmed live (F029 covers the indirection question, not the deletion question).
- **`tsconfig.json` excludes `src/worker`** and worker has its own tsconfig: this looked like a split-personality config but is correct — the worker bundle needs `@cloudflare/workers-types`, the rest of the codebase can't have those globals leaking into client/Node. Solving a real problem, not a smell.
- **`world.ts` having `dubspaceState() / taskspaceState() / chatState()` baked in**: this is not fine. It used to be defensible as first-light demo glue; under the current object-name rule it is priority architectural debt (F026/F050).
- **The `as ObjRef` casts on string IDs throughout**: `ObjRef` is a `string` brand and there's no constructor for it. Looks like type laundering but is the right shape for a brand type with external sources (REST inputs, persisted rows). Acceptable.

## Open questions for the maintainer

1. **When should seeded deterministic ID allocation return?** F006 is fixed by removing the false deploy contract. The real question is whether v1.1 needs a seeded allocator for runtime-created objects, or whether portability should rely on explicit persisted IDs and import/export discipline.
2. **Is the cluster-DO shadow-bootstrap (F007) a deliberate v1 staging ground for the host-scoped runtime, or was it expected to be a partial decomposition that got merged?** The notes at `impl-cf-deploy.md:149` read like the former; the comments inside `persistent-object-do.ts` read like the latter.
3. **Should `dev-server.ts` ever match the Worker's auth posture, or is dev intentionally a permissive sandbox?** Either is defensible; the silent asymmetry is the actual smell.
4. **`@local:chat` is on `WORLD_HOST` while `@local:dubspace` and `@local:taskspace` get cluster hosts (`directory-do.ts:51-65`).** Comment at `:63-64` says "until player-DO fan-out lands". Is there a target date or a triggering condition for that fan-out?
5. **`parkVmContinuation` / `parkReadContinuation` separation (`world.ts:919`, `:950`)** — are these legacy splits intended to converge, or are the read-vs-fork distinctions load-bearing?
6. **Is the e2e suite intended to run on the deployed Worker (production mode) eventually, or stay dev-server-only?** F037 hinges on this.
7. **`hashCanonical` (F024)** — used for snapshot integrity at `world.ts:1105`. Is integrity actually required, or is this a dedup key?
8. **The `keep` MCP memory failing throughout this session (F049)** — known? worth fixing? worth removing? It surfaces at every prompt boundary.
