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

`src/worker/index.ts`: route parsing per §R11.1, ID resolution per §R11.2, auth header per §R11.3, sessions placement per §R11.4 (lean Option A: embedded player ULID in session id).

`src/worker/persistent-object-do.ts`: `PersistentObjectDO` class wrapping the existing `WooWorld` against `CFObjectRepository`. Implements the cross-DO RPC surface from §R5. Hosts WebSockets via `acceptWebSocket` (§R8).

`src/worker/directory-do.ts`: `DirectoryDO` singleton. Read-mostly corename map. ~80 lines.

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

`wrangler.toml` per §R12 skeleton. `[[migrations]]` tag `v1` with `new_sqlite_classes = ["PersistentObjectDO", "DirectoryDO"]`. AE dataset binding optional. `[observability]` enabled.

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
- 94/94 tests pass; typecheck clean (split: main + `tsconfig.worker.json`).

Phase 0 (toolchain smoke test) — landed:

- `wrangler.toml` skeleton (no DO bindings yet; reserved for `tag = "v1"` later).
- `src/worker/index.ts` stub Worker — JSON heartbeat for any path.
- `tsconfig.worker.json` scopes `@cloudflare/workers-types` to the worker tree only.
- Live at `https://woo.hughpyle.workers.dev/`. Token-mint flow proven (`woo` API token created with the six required permission groups; `wrangler whoami` succeeds).

Phase 1 (CF backend `ObjectRepository`) — landed:

- `src/worker/cf-repository.ts` (~620 lines). Mirrors `LocalSQLiteRepository`. Schema and SQL strings byte-identical (both target SQLite); the wrapping changes:
  - `state.storage.sql.exec(...)` cursor API instead of better-sqlite3 prepared statements.
  - `state.storage.transactionSync(fn)` for atomicity (raw `BEGIN`/`COMMIT`/`ROLLBACK` aren't allowed via `sql.exec` on CF).
  - **`savepoint(fn)` also uses `state.storage.transactionSync(fn)`** — when called inside an outer transaction it nests as an implicit savepoint. Raw SQL `SAVEPOINT`/`ROLLBACK TO`/`RELEASE` are forbidden through `sql.exec` per CF docs and have been removed.
- `CFObjectRepository implements ObjectRepository, WorldRepository` — adds stub `load(): null`, `save(): throw E_NOT_SUPPORTED`, `latestSpaceSnapshot` so it plugs into `WooWorld`'s constructor without a type refactor.
- Pending-log-outcome assertion at outer-only commit boundary (matches local backend).
- No CF-storage variant in conformance harness yet (Miniflare integration is the gating piece).

## Still open

In dependency order:

- **`PersistentObjectDO`** class wrapping `WooWorld`. Delegates RPC methods to `world.directCall` / `world.applyCall` / equivalents. Replaces the stub `src/worker/index.ts` once it exists.
- **`DirectoryDO`** singleton. Trivial; ~80 lines.
- **Worker entry** (full): route parsing, ID resolution, sessions, DO stub fetch. ~150 lines. Adds DO bindings + `[[migrations]] tag = "v1"` to `wrangler.toml`.
- **First-request bootstrap** with `WOO_INITIAL_WIZARD_TOKEN` consumption and `WOO_AUTO_INSTALL_CATALOGS` auto-install.
- **`wiz:rotate_bootstrap_token` verb** on `$system`. Spec'd in §R14.4; impl pending.
- **Alarms** for parked tasks. Replaces the 250ms `setInterval` only on the CF target; local dev keeps the poll.
- **WS hibernation** with attachment shape `{session_id, actor, socket_id}`.
- **Cross-DO RPC layer**: `RemoteHost.rpc(target, method, args)` stub used by `world.dispatch` when target is on a different anchor cluster. Currently `world.ts` assumes single-process; needs an "is target hosted here?" check before dispatch.
- **Verb-lookup cache** (`ancestor_verb_cache`, `ancestor_prop_cache`). Schema exists in `persistence.md §14.1`; population on cross-DO miss is unimplemented.
- **`src/instrument.ts`** with AE writes, structured logs, per-DO `:metrics()`.
- **CF storage variant in conformance harness** via Miniflare. Optional; the unit-level transaction/savepoint guarantees are covered by the SQLite + in-memory backends.
- **Worker-side catalog tap install**: import `src/server/github-taps.ts` helpers into the Worker fetch handler. Local Node already has `POST /api/tap/install` and `GET /api/taps`.

## Known acceptable shortcuts

- **Mid-call SUSPEND across DOs raises `E_CROSSDO_PARKING_UNSUPPORTED`** per §R6.2. v1.1 may relax.
- **No tap caching.** Every install/update fetches fresh from GitHub. §CT4.
- **Local-catalog install only** at first; GitHub-tap install lands in Phase 7.
- **Quota accounting is hard-cap-on-write only.** Daily-alarm pass deferred. §R5.4.
- **No multi-region tuning.** CF picks the closest region per DO automatically.
- **No distributed tracing.** Structured logs + `request_id` propagation across cross-DO RPCs cover the audit trail.
- **No snapshot policy automation.** Operators trigger snapshots manually (or via a verb on `$space`); CF-side automation is post-v1.
- **No CF-storage variant in conformance harness** until Miniflare or equivalent is wired. The unit-level transaction/savepoint guarantees are covered by the SQLite + in-memory backends.
- **Worker-level rate limiting via Cloudflare's built-in protection.** No application-level rate-limit beyond `wire.md §17.5` outbound queue / inbound burst caps.

## Open questions

1. **Sessions placement.** Lean from §R11.4: Option A with `session_id = <player_ulid>:<random>` so the Worker decodes routing without a singleton SessionsDO. Confirm before implementing.
2. **`world.ts` decomposition.** 2200-line god-file. Not strictly required for CF (the DO wraps it), but the dispatch logic needs an "is target on this DO?" check. Light refactor (extract `dispatch()` cluster awareness) vs. full decomposition along TECH_DEBT_AUDIT F001 lines — pick when starting Phase 2.
3. **Storage transaction boundaries** at CF: confirm `state.storage.transactionSync` semantics match local SQLite `BEGIN IMMEDIATE`. Likely yes, but worth a one-shot probe before Phase 1 lands.
4. **Bundle size of the bundled client** under `wrangler deploy`. The hand-rolled SPA (`src/client/main.ts` ~950 lines) plus CSS plus catalogs fit easily under Workers limits but worth checking.
5. **Demo catalogs at boot**: should `WOO_AUTO_INSTALL_CATALOGS=chat,dubspace,taskspace` be the default for fresh dev deploys (current intent) or empty for CF deploys (clean world per §R14.5 note about `dev-seed` warning)? Probably default in dev, empty in production.

## Reference

- `spec/reference/cloudflare.md` is the forward-looking spec; sections R1–R15.
- `spec/reference/persistence.md §14.1` is the SQLite schema both backends target.
- `src/core/repository.ts` is the canonical TS source for `ObjectRepository`.
- `DEPLOY.md` documents the operator-facing flow.
- `notes/impl-v0.5-rich-vm-persistence-compiler.md` covered the predecessor milestone (in-process VM + persistence + DSL compiler); items there are landed.
