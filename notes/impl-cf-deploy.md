# Implementation: Cloudflare Deploy

## Purpose

Bridge the working in-process runtime to a deployable Cloudflare Workers + Durable Objects implementation. The semantic substrate is shipped; the CF-specific transport layer is not. This note tracks the gap between `spec/reference/cloudflare.md` (forward-looking spec) and `src/` (current code).

The goal of "live" is: a fork-and-deploy world per `cloudflare.md §R14`, with the bundled demos installable as local catalogs, instrumented enough to debug remotely, and operator-claimable via the wizard-token flow. Full v1-ops surface (worktrees, conformance, etc.) is post-deploy.

## Scope

Required for first deploy:
- §R1 host mapping (existing routing model is the deployment target).
- §R2 `Directory` singleton DO.
- §R3 `ObjectRepository` implementation against `state.storage.sql`.
- §R5/§R6.1 cross-DO RPC for inheritance lookups and verb dispatch (non-yielding shape only).
- §R7 alarm-based parked-task resume.
- §R8 WebSocket hibernation.
- §R9 first-request bootstrap.
- §R10.1–§R10.4 instrumentation (AE writes, structured logs, per-DO `:metrics()`, wizard audit).
- §R11 Worker entry routing.
- §R12 `wrangler.toml`.
- §R14 fork-and-deploy operator flow: required secrets, wizard claim, failure modes.

Deferred to v1.1+:
- §R6.2 mid-call SUSPEND across DOs (already explicitly deferred in spec).
- `QuotaAccountant` DO real-time accounting (table scaffolded; daily alarm pass skipped at first).
- §R10.5 distributed tracing.
- Multi-region tuning beyond CF defaults.
- Catalog tap install over GitHub fetch (local catalogs cover the demos).
- Snapshot policy automation (manual snapshot only).

## Phases

Suggested order. Each phase ends at a runnable checkpoint (typecheck + tests).

### Phase 1: CF backend `ObjectRepository`

Implement `src/worker/cf-repository.ts` against `state.storage.sql`. Mirror `src/server/sqlite-repository.ts` shape; the schema in `spec/reference/persistence.md §14.1` is identical. Includes `transaction()` (CF `state.storage.transactionSync`) and `savepoint()` (SQL SAVEPOINT).

Tests: extend `tests/conformance.test.ts` with a CF-storage backend variant if a test harness for CF storage is feasible (Cloudflare's Miniflare supports `state.storage.sql`). If not, leave as a future addition — the unit-level guarantees are covered by the spec.

### Phase 2: Worker entry + DO classes

`src/worker/index.ts`: route parsing per §R11.1, ID resolution per §R11.2, auth header per §R11.3, sessions placement per §R11.4. Current slice uses Directory's `session_id -> actor` index; embedded-player session ids remain a later optimization.

`src/worker/persistent-object-do.ts`: `PersistentObjectDO` class wrapping the existing `WooWorld` against `CFObjectRepository`. Hosts the world gateway and routed anchor-cluster DOs with the same class. Hosts WebSockets via `acceptWebSocket` (§R8).

`src/worker/directory-do.ts`: `DirectoryDO` singleton. Read-mostly routing table for seeded corenames/object refs, plus `session_id -> actor` routing for forwarded object calls.

### Phase 3: First-request bootstrap

`src/worker/bootstrap.ts`: §R9.1 first-request path. Worker checks `$system` DO's `bootstrapped` flag (via `loadMeta`); if false, runs the universal-class bootstrap and any `WOO_AUTO_INSTALL_CATALOGS` entries; sets `bootstrapped=true`. Idempotent.

Operator claim flow (§R14.4): `POST /api/auth` accepting `wizard:<token>` matches against `WOO_INITIAL_WIZARD_TOKEN` env var; first match consumes the token (sets `world_meta.bootstrap_token_used = true`); subsequent presentations return 401.

### Phase 4: Alarms + WS hibernation

§R7: replace the dev server's `setInterval(runDueTasks, 250)` with per-DO alarms. Each DO computes `min(resume_at)` after every parked-task mutation and calls `state.storage.setAlarm(t)`; the `alarm()` handler runs due tasks.

§R8: WebSocket hibernation. `state.acceptWebSocket(ws)` + `serializeAttachment({session_id, actor, socket_id})`. Survives DO hibernation. `webSocketMessage`/`webSocketClose`/`webSocketError` handlers.

### Phase 5: Instrumentation

`src/instrument.ts`: §R10. Three primitives wired:

- AE binding (`env.METRICS.writeDataPoint`) for `call`, `cross_do_rpc`, `alarm`, `session`, `wizard_action`, `error` events. Optional — degrades to no-op when binding is absent.
- Structured `console.log` lines: `{ts, level, event, do_id, request_id, fields}`. `request_id` propagated through the cross-DO RPC envelope.
- Per-DO `:metrics()` direct-callable verb returning rolling counters.

Wizard-action audit on `X-Woo-Force-Direct`, `X-Woo-Impersonate-Actor`, `wiz:force_recycle`, `wiz:force_set_status`, `$system:rebuild_seeds`, etc.

### Phase 6: Wrangler config + first deploy

`wrangler.toml` per §R12 skeleton. `[[migrations]]` tag `v1` creates `PersistentObjectDO`; `tag = "v2"` creates `DirectoryDO` (append-only migration history). AE dataset binding optional. `[observability]` enabled.

`DEPLOY.md` already exists; verify the operator path against the live deploy. End-to-end smoke: deploy → set secrets → first auth as wizard → install local catalogs → exercise dubspace/taskspace/chat from the bundled client.

### Phase 7 (partly landed locally): catalog tap install over GitHub

The local Node server now has `/api/tap/install` and `GET /api/taps`. The helper in `src/server/github-taps.ts` resolves GitHub refs, fetches `manifest.json` and `README.md`, computes SHA-256 hashes, and dispatches `$catalog_registry:install`. The Cloudflare Worker still needs to reuse or port this helper into its fetch handler, then layer in production observability and any private-repo token policy.

## Current Implementation Status

Substrate landed (works in-process):

- `ObjectRepository` interface in `src/core/repository.ts` with full method set + `transaction()` + `savepoint()`.
- In-memory and local SQLite repositories (`src/core/repository.ts` `InMemoryObjectRepository`, `src/server/sqlite-repository.ts`).
- Two-phase log writes (`appendLog` returns pending, `recordLogOutcome` updates), guarded against committed-pending rows.
- DSL compiler M1 (`src/core/dsl-compiler.ts`) — recompile-on-import works for catalogs.
- REST API with six endpoints (`src/server/dev-server.ts` for the local Node target).
- Wire ops `direct`/`result`/`event` over WebSocket.
- Identity three-layer model (actor/session/connection); session table is credential-only, connection state in-memory.
- Local + GitHub catalog install path; manifests for chat/dubspace/taskspace ship in `catalogs/`. GitHub tap helper lives in `src/server/github-taps.ts` and is wired through `POST /api/tap/install` and `GET /api/taps`. Wizard auth via `wizard:<WOO_INITIAL_WIZARD_TOKEN>`.
- 98/98 tests pass; typecheck clean (split: main + `tsconfig.worker.json`).

Phase 0 (toolchain smoke test) — landed:

- `wrangler.toml` skeleton proved the Worker toolchain before DO bindings landed.
- `src/worker/index.ts` stub Worker — JSON heartbeat for any path.
- `tsconfig.worker.json` scopes `@cloudflare/workers-types` to the worker tree only.
- Live at `https://woo.hughpyle.workers.dev/`. Token-mint flow proven (`woo` API token created with the six required permission groups; `wrangler whoami` succeeds).

Phase 1 (CF backend `ObjectRepository`) — landed:

- `src/worker/cf-repository.ts` (~700 lines). Mirrors `LocalSQLiteRepository`. Schema and SQL strings byte-identical (both target SQLite); the wrapping changes:
  - `state.storage.sql.exec(...)` cursor API instead of better-sqlite3 prepared statements.
  - `state.storage.transactionSync(fn)` for atomicity (raw `BEGIN`/`COMMIT`/`ROLLBACK` aren't allowed via `sql.exec` on CF).
  - **`savepoint(fn)` also uses `state.storage.transactionSync(fn)`** — when called inside an outer transaction it nests as an implicit savepoint. Raw SQL `SAVEPOINT`/`ROLLBACK TO`/`RELEASE` are forbidden through `sql.exec` per CF docs and have been removed.
- `CFObjectRepository implements ObjectRepository, WorldRepository`. `load()` walks per-object tables to reconstruct a `SerializedWorld` for cross-hibernation hydration. `save()` clears the tables and re-inserts via per-object methods inside one transaction, matching `LocalSQLiteRepository.save()` so `createWorld()`'s post-bootstrap whole-world flush works on CF.
- Pending-log-outcome assertion at outer-only commit boundary (matches local backend).
- No CF-storage variant in conformance harness yet (Miniflare integration is the gating piece).

Phase 2 (Worker entry + DO class) — landed:

- `src/worker/persistent-object-do.ts` (~750 lines). `PersistentObjectDO` wraps `WooWorld`+`CFObjectRepository` for both the `world` gateway and Directory-routed anchor-cluster hosts. The gateway runs bootstrap + catalog auto-install; cluster hosts load/prune host-scoped serialized slices exported by the gateway. REST routes include `/healthz`, `/api/auth` on the gateway (with `wizard:<WOO_INITIAL_WIZARD_TOKEN>` claim flow), authenticated `/api/state` aggregate, `/api/objects/{id}` describe, `/api/objects/{id}/properties/{name}`, `/api/objects/{id}/calls/{verb}` (sequenced + direct), `/api/objects/{id}/log`, `/api/taps`. Fail-loud 503 for missing `WOO_INITIAL_WIZARD_TOKEN` per §R14.7. SSE streams (`/stream`) and tap-install GitHub fetch still return 501 `E_NOT_IMPLEMENTED`.
- `src/worker/directory-do.ts`. `DirectoryDO` singleton with SQLite tables for `objref -> host` routes and `session_id -> actor` session routing. It starts empty and learns object placement from generic route tables exported by the world/hosts; chat stays on the gateway until player-DO fan-out/presence indexing exists.
- `src/worker/index.ts`. Worker entry now routes global API/WS traffic to `env.WOO.idFromName("world")`, object REST routes through Directory, and best-effort broadcasts routed applied frames back through the gateway so WebSocket clients see REST-agent mutations live.
- `wrangler.toml`. `[[durable_objects.bindings]] name = "WOO" class_name = "PersistentObjectDO"` and `name = "DIRECTORY" class_name = "DirectoryDO"`. `[[migrations]] tag = "v1" new_sqlite_classes = ["PersistentObjectDO"]`; `tag = "v2" new_sqlite_classes = ["DirectoryDO"]`. `compatibility_flags = ["nodejs_compat"]` (needed by `node:crypto` in `src/core/source-hash.ts`).
- `tsconfig.worker.json` adds `node` to `types` so the worker tsconfig sees `node:crypto` types.
- **Live deploy**: `https://woo.hughpyle.workers.dev/`. `WOO_INITIAL_WIZARD_TOKEN` set via `wrangler secret put`; `WOO_SEED_PHRASE` is no longer a runtime requirement until deterministic object-id allocation lands. Smoke-tested end to end: 50 objects bootstrapped (universal classes + chat/dubspace/taskspace local catalogs auto-installed), wizard claim returns `$wiz` session, second claim returns `E_TOKEN_CONSUMED`, describe + REST routing work, `the_chatroom` (parent `$chatroom`) has 17 verbs and 10 properties matching the local manifest. Permission gates (`E_DIRECT_DENIED` for non-`direct_callable` verbs) enforced.

Phase 2.1 (bundled SPA via Workers Assets) — landed:

- `wrangler.toml` `[assets] directory = "./dist", binding = "ASSETS", not_found_handling = "single-page-application"`. Deploy now requires `npm run build` first to populate `dist/` (Vite outputs ~50 KiB gzipped: index.html + assets/index-*.{js,css}).
- `src/worker/index.ts` routes global API/WS traffic to the gateway DO, object REST routes through Directory, and falls through to `env.ASSETS.fetch(request)` for everything else. 503 `E_NO_ASSETS` if the binding is missing (operator forgot to build).
- `Env` interface gains optional `ASSETS: Fetcher`.
- Live verification: `https://woo.hughpyle.workers.dev/` serves the SPA shell; navigating the four tabs (chat / dubspace / taskspace / IDE) renders against the live world.

Phase 2.2 (WebSocket upgrade with hibernation) — landed:

- Pulled forward from Phase 4 because the chat tab opened a WS to `/ws` and saw the connection refused on the Phase 2 deploy.
- `src/worker/persistent-object-do.ts` `fetch()` handles `GET /ws` with `Upgrade: websocket`: creates a `WebSocketPair`, accepts the server side via `state.acceptWebSocket()` (CF hibernation API), returns the client side in a 101.
- Per-socket state `{sessionId, actor, socketId}` lives in `ws.serializeAttachment()` so it survives DO hibernation.
- `webSocketMessage(ws, msg)`: ports the dev-server WS frame dispatch — handles `op: auth, ping, call, direct, input, replay`. Same shape as `dev-server.ts` lines 95–179.
- `webSocketClose` / `webSocketError`: cleanup detaches from the world's `attachedSockets` registry.
- Broadcast helpers (`broadcastApplied`, `broadcastTaskResult`, `broadcastLiveEvents`, `broadcastLiveEvent`) iterate `state.getWebSockets()` instead of the in-memory `Map` the local dev-server uses; presence-filtered fan-out for applied frames; directed-to/from filtering for live observations.
- Live verification: chat works end-to-end. Two browser tabs see each other's `enter`/`leave`/`said`/`emoted` events broadcast correctly.

Phase 2.3 (first multi-DO routing slice) — landed:

- `DirectoryDO` now exists as a separate SQLite-backed Durable Object. It learns object routes from the world/host route tables and tracks `session_id -> actor` for forwarded object calls.
- Worker object routes resolve through Directory. Sequenced REST calls route by `body.space` when present, so `/api/objects/the_taskspace/calls/create_task` with `space: "the_taskspace"` lands on the `the_taskspace` DO. Direct calls and object/property/log reads route by the object id in the URL.
- The `world` DO remains the gateway for `/api/auth`, `/ws`, `/healthz`, `/api/taps`, `/api/tap/install`, and bundled `/api/state` aggregation.
- WebSocket clients still connect to the gateway DO. The gateway forwards `op: call`, `op: direct`, and `op: replay` to the Directory-selected host when needed, using internal routes on `PersistentObjectDO`.
- Routed REST applied frames and direct-call live observations are best-effort broadcast back through the gateway so connected browser clients see REST-agent mutations live. Durability remains on the space host; clients can recover sequenced calls via replay/state aggregation if live fan-out fails.
- `/api/state` is now authenticated and aggregates dubspace/taskspace state from their routed hosts. Object descriptions inside the payload are actor-filtered; demo app state maps are raw convenience data for the bundled client, not the production REST surface.
- The gateway asks routed hosts for their route table after applied frames and registers any objects owned by that host. Runtime-created anchored tasks route back to the taskspace host without observation-type-specific routing code.
- Current routed hosts: dubspace and taskspace anchor clusters route to their own hosts; the standalone chat room stays on `world` until player-DO fan-out / cross-host presence indexing exists.
- Verification: `npm run typecheck`, `npm test` (98/98), `npm run build`, `npx wrangler deploy --dry-run`, and Playwright smoke against a fresh SQLite DB all pass.

Phase 2.4 (host-scoped cluster loader) — landed:

- Non-gateway `PersistentObjectDO` instances no longer run `createWorld({ catalogs })`. On first load, a cluster asks the gateway for `exportHostScopedWorld(host)` and persists that slice. On later loads, it prunes any existing stored world to the same host scope before enabling incremental persistence.
- Host slices contain hosted objects, parent/classes/features needed for local verb resolution, bytecode literal object references, subscriber actor objects for hosted spaces, and hosted logs/snapshots/tasks. They do not include unrelated bundled demo objects, `$catalog_registry` install history, or gateway sessions.
- Cluster `/api/auth` and `/ws` now fail loud; the gateway remains the only public auth and WebSocket host. Forwarded internal calls create a minimal local actor/session if the actor was not already in the host slice.
- Runtime-created object ids now include their anchor-derived scope (`obj_<scope>_<n>`) so independent hosts do not mint the same `obj_1` name.
- Verification in the current worktree: `npm run typecheck`, `npm test` (105/105 after host-scope tests), `npm run build`, Playwright smoke, `wrangler deploy --dry-run`, and `git diff --check` pass.

Verb-flag persistence fix (storage-layer bug, both backends) — landed:

- Both `LocalSQLiteRepository` and `CFObjectRepository` had a pre-existing schema bug: the `verb` table had no `flags` column, so `direct_callable` and `skip_presence_check` were silently dropped on save and reset to undefined on load. Locally invisible because the in-memory state from initial bootstrap survived in the same process; on CF every fresh DO instance re-hydrated from storage and lost the flags, so calls to chat verbs returned `E_DIRECT_DENIED`.
- Schema gains `flags TEXT NOT NULL DEFAULT '{}'`. `save()` and `saveVerb()` write `verbFlagsJson(verb)`; `verbFromRow` reads the JSON and sets the booleans on the reconstituted `VerbDef`.
- `ensureColumn` migration adds the column on existing local SQLite databases.
- CFObjectRepository.migrate() detects "verb table exists without flags column" and drops every table; the next `createWorld()` sees empty storage and runs fresh bootstrap + catalog auto-install. One-time wipe; operator re-claims wizard via the same `WOO_INITIAL_WIZARD_TOKEN` secret. (Local SQLite dev databases keep their data but with empty flags — operator can `rm .woo/dev.sqlite` and restart for a clean re-bootstrap if needed.)

## Still open

In dependency order:

- **Alarms** for parked tasks. Replaces the 250ms `setInterval` only on the CF target; local dev keeps the poll. (WS hibernation landed in Phase 2.2; alarms are the remaining piece of original Phase 4.)
- **SSE stream** (`/api/objects/{id}/stream`) on the Worker. Returns 501 placeholder; browser clients use the WebSocket path. SSE matters for HTTP-only agent integrations.
- **Authoring REST endpoints** in the Worker: `/api/compile`, `/api/install`, `/api/property`. The IDE tab can read object descriptions but cannot author verbs against the deployed world. dev-server has the Node implementations; needs Web-standard ports.
- **`wiz:rotate_bootstrap_token` verb** on `$system`. Spec'd in §R14.4; impl pending.
- **General cross-DO RPC layer**: `RemoteHost.rpc(target, method, args)` stub used by `world.dispatch` when target is on a different anchor cluster. The first routing slice forwards top-level REST/WS calls, but verb bodies still assume local dispatch inside a host.
- **Authenticated internal forwarding headers**: the public Worker strips inbound `x-woo-internal-*` headers before forwarding, but cluster DOs currently trust headers from any caller with the same DO binding. Add an HMAC over the forwarded tuple (`session, actor, expires_at, token_class`) with a `WOO_INTERNAL_SECRET` before treating cluster DOs as an independently callable surface.
- **General object-route registration**: Directory has `/register-objects`, and task creation is wired via `task_created` observations. General `createObject` paths still need a placement callback so new rooms/objects register their intended host at creation time.
- **Aggregate health**: `/healthz` is gateway-local. Add a Directory/host fan-out health endpoint when routed-host liveness needs to be operator-visible.
- **Verb-lookup cache** (`ancestor_verb_cache`, `ancestor_prop_cache`). Schema exists in `persistence.md §14.1`; population on cross-DO miss is unimplemented.
- **`src/instrument.ts`** with AE writes, structured logs, per-DO `:metrics()`.
- **CF storage variant in conformance harness** via Miniflare. Optional; the unit-level transaction/savepoint guarantees are covered by the SQLite + in-memory backends.
- **Worker-side catalog tap install**: port `src/server/github-taps.ts` helpers into the Worker fetch handler. Currently the Worker route returns 501 `E_NOT_IMPLEMENTED`; local catalogs cover the demos.

## Known acceptable shortcuts

- **Mid-call SUSPEND across DOs raises `E_CROSSDO_PARKING_UNSUPPORTED`** per §R6.2. v1.1 may relax.
- **No tap caching.** Every install/update fetches fresh from GitHub. §CT4.
- **Bundled local-catalog auto-install only on the Worker**; GitHub-tap install lands in Phase 7.
- **Quota accounting is hard-cap-on-write only.** Daily-alarm pass deferred. §R5.4.
- **No multi-region tuning.** CF picks the closest region per DO automatically.
- **No distributed tracing.** Structured logs + `request_id` propagation across cross-DO RPCs cover the audit trail.
- **No snapshot policy automation.** Operators trigger snapshots manually (or via a verb on `$space`); CF-side automation is post-v1.
- **No CF-storage variant in conformance harness** until Miniflare or equivalent is wired. The unit-level transaction/savepoint guarantees are covered by the SQLite + in-memory backends.
- **Worker-level rate limiting via Cloudflare's built-in protection.** No application-level rate-limit beyond `wire.md §17.5` outbound queue / inbound burst caps.

## Open questions

1. **Sessions placement.** Current slice uses Directory's `session_id -> actor` table. Lean from §R11.4 still points toward embedded player ids for long-term removal of a session lookup hop; decide before player-DO routing.
2. **`world.ts` decomposition.** The Worker can route top-level calls now, but `WooWorld` still assumes local class/verb availability and local dispatch within a host. Light refactor (cluster-aware dispatch + remote definition cache) vs. full decomposition along TECH_DEBT_AUDIT F001 lines remains open.
3. **Storage transaction boundaries** at CF: `state.storage.transactionSync` compiles and dry-runs; still needs a Miniflare/DO storage probe for nested savepoint behavior under real CF storage.
4. **Demo catalogs at boot**: should `WOO_AUTO_INSTALL_CATALOGS=chat,dubspace,taskspace` be the default for fresh dev deploys (current intent) or empty for CF deploys (clean world)? Probably default in dev, empty in production.

## Reference

- `spec/reference/cloudflare.md` is the forward-looking spec; sections R1–R15.
- `spec/reference/persistence.md §14.1` is the SQLite schema both backends target.
- `src/core/repository.ts` is the canonical TS source for `ObjectRepository`.
- `DEPLOY.md` documents the operator-facing flow.
- `notes/impl-v0.5-rich-vm-persistence-compiler.md` covered the predecessor milestone (in-process VM + persistence + DSL compiler); items there are landed.
