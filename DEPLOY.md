# Deploying your own woo world

woo is built to be **fork-and-deploy**. This document walks through publishing your own world to your own Cloudflare account.

The full normative deployment contract is in [spec/reference/cloudflare.md §R14](spec/reference/cloudflare.md#r14-deploying-your-own-world). This file is the operator's quick reference.

---

## Quick start

```sh
# 1. Clone and install
git clone https://github.com/<your-fork>/woo.git
cd woo
npm install

# 2. Authenticate with Cloudflare
npx wrangler login

# 3. Set the two required secrets (see "Required configuration" below)
npx wrangler secret put WOO_INITIAL_WIZARD_TOKEN
npx wrangler secret put WOO_SEED_PHRASE

# 4. Deploy
npx wrangler deploy

# 5. Claim wizard authority
#    Connect to the deployed world's URL and present:
#      auth { token: "wizard:<the-token-you-set-in-step-3>" }
#    The token is single-use; store it somewhere safe in case you need to recover.
```

After step 5, you have a running world with you bound to `$wiz`. From there you can inspect the bundled chat, dubspace, taskspace, and IDE surfaces. Runtime authoring endpoints and GitHub tap install are still local-server-only on the Cloudflare target.

---

## Prerequisites

| Requirement | Why |
|---|---|
| **Cloudflare account on the Workers Paid plan** ($5/month minimum) | Durable Objects, the runtime's persistence primitive, are not available on the free tier. |
| **`wrangler` CLI** | `npm install` brings it in as a dev dependency; use `npx wrangler ...` from the repo root. |
| **A name for your worker** | Defaults to `woo`; change it in `wrangler.toml` if you want a different subdomain. |

If you skip Workers Paid, the deploy succeeds but every request returns `503 E_DO_UNAVAILABLE`. Fail-loud is intentional.

---

## Required configuration

Two secrets, both via `wrangler secret put` (never the `[vars]` block in `wrangler.toml`):

### `WOO_INITIAL_WIZARD_TOKEN`

A random string the operator presents at first auth to claim the `$wiz` binding. Generate something with high entropy:

```sh
openssl rand -hex 32
```

Set it:

```sh
npx wrangler secret put WOO_INITIAL_WIZARD_TOKEN
# paste the value when prompted
```

The token is **single-use**. Once consumed, subsequent presentations return `401 E_TOKEN_CONSUMED`. To rotate the bootstrap token after first use (e.g., for disaster recovery), call `wiz:rotate_bootstrap_token(new_token)` once you have wizard authority.

### `WOO_SEED_PHRASE`

A per-world entropy seed mixed into ULID minting so independent deployments produce non-colliding object identifiers. Pick something durable:

```sh
openssl rand -hex 16   # or a memorable phrase, e.g., "my-world-2026-launch"
```

Set it:

```sh
npx wrangler secret put WOO_SEED_PHRASE
```

**Once chosen, do not rotate it.** Rotating re-randomizes the entire seed graph and is operationally equivalent to creating a new world. The runtime warns at boot if it detects the local-dev default `"dev-seed"` running in production.

---

## Local development

For local dev, secrets live in `.dev.vars` (gitignored) instead of CF secret storage. Copy the example:

```sh
cp .dev.vars.example .dev.vars
# edit .dev.vars to set values
npm run dev
```

The local dev server reads `.dev.vars` automatically via `tsx`/`vite`. Defaults in the example are safe for local-only experimentation.

---

## Optional bindings

Each is **opt-in**: the runtime degrades gracefully when absent.

### Workers Analytics Engine (metrics)

For per-call metrics dashboards, create an AE dataset and bind it:

```toml
# wrangler.toml
[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "woo_v1"
```

If `env.METRICS` is undefined at runtime, all metric writes no-op. Structured logs continue.

### R2 + Logpush (log retention)

`console.log` lines reach `wrangler tail` by default. For durable retention:

1. Create an R2 bucket: `npx wrangler r2 bucket create woo-logs`
2. Configure Logpush via the Cloudflare dashboard or `wrangler logpush create` to push to the R2 bucket.

Without Logpush, logs are visible only via `wrangler tail` while you're connected.

### Custom domain

Default deploy serves at `<worker-name>.<account-subdomain>.workers.dev`. To use a domain you own:

1. Add the zone to your Cloudflare account.
2. Add a route in `wrangler.toml`:

   ```toml
   route = { pattern = "world.example.com/*", custom_domain = true }
   ```

3. Redeploy.

---

## First auth (claiming `$wiz`)

After deploy, connect to your world (e.g., `https://woo.<your-subdomain>.workers.dev/`) and authenticate as wizard:

**Via REST**:

```sh
curl -X POST https://your-world.example.com/api/auth \
  -H 'content-type: application/json' \
  -d '{"token": "wizard:YOUR_INITIAL_WIZARD_TOKEN"}'
```

Response: `{ "actor": "$wiz", "session": "<session-id>" }`. Use `Authorization: Session <session-id>` for subsequent requests.

**Via WebSocket**: connect, then send `{ "op": "auth", "token": "wizard:YOUR_INITIAL_WIZARD_TOKEN" }`. Receive `{ "op": "session", "actor": "$wiz" }`.

Either path consumes the token. The world records `bootstrap_token_used = true` in `$system` metadata on the gateway host; presenting the token again fails.

The deployed Worker currently auto-installs the bundled local catalogs. Public GitHub tap install is available on the local Node dev server but not yet on the Cloudflare Worker; the Worker route returns `501 E_NOT_IMPLEMENTED` until the GitHub helper is ported.

When Worker-side tap install lands, it will use the same shape as local dev:

```sh
curl -X POST https://your-world.example.com/api/tap/install \
  -H 'content-type: application/json' \
  -H 'Authorization: Session YOUR_SESSION_ID' \
  -d '{"tap":"hugh/woo-libs","catalog":"dubspace","ref":"dubspace-v1.0.0","as":"dubspace"}'
```

The response is the applied frame from `$catalog_registry`. `GET /api/taps` with the same session returns the installed catalog registry.

---

## Upgrades (pulling upstream changes)

When you pull updates from upstream and redeploy, the DO migration tags must remain consistent:

- **Never edit existing `[[migrations]]` blocks** in `wrangler.toml`.
- **Append new tags** for new generations (`v1` → `v2` → `v3`).
- The runtime emits `event: "migration_applied"` log lines on each tag application; tail for them after `wrangler deploy` to confirm.

If your fork diverges from upstream's migration history, you cannot cleanly merge. Keep your migration tags identical to upstream until a generation lands; then append your own.

---

## Failure modes & troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `503 E_BOOTSTRAP_TOKEN_MISSING` | `WOO_INITIAL_WIZARD_TOKEN` not set | `wrangler secret put WOO_INITIAL_WIZARD_TOKEN` |
| `503 E_SEED_PHRASE_MISSING` | `WOO_SEED_PHRASE` not set | `wrangler secret put WOO_SEED_PHRASE` |
| `503 E_DO_UNAVAILABLE` | Account on Workers Free | Upgrade to Workers Paid |
| `401 E_TOKEN_CONSUMED` on first auth | The bootstrap token was already used | Use the `Authorization: Session <id>` from the original response, or call `wiz:rotate_bootstrap_token` if you have wizard via another path |
| Repeated startup warning `seed_phrase: dev-seed in production` | Production deploy still using the local-dev default | `wrangler secret put WOO_SEED_PHRASE` with a real value (note: rotating later is equivalent to a new world) |
| Worker deploys but requests time out | DO migration mismatch with prior deploy | Check `wrangler tail` for migration errors; reconcile with the upstream migration history |

---

## Cost expectations

woo runs on:

- **Workers Paid** ($5/mo) — covers Workers and Durable Objects
- DO storage costs scale with the number of objects and their size; small worlds (~hundreds of objects, KB each) are nearly free
- Per-DO 1k req/sec soft limit means a single hot object naturally rate-limits — adversarial saturation against one object cannot bring down your world
- Analytics Engine writes are cheap; one per call is well under cost concern at v1 traffic
- Logpush to R2 has small per-GB charges; budget by retention policy

Concrete production cost numbers depend on your traffic; the CF dashboard is authoritative.

---

## What's not in v1 fork support

- **Multiple worlds in one deploy.** One deploy = one world. Run multiple deploys for multiple worlds.
- **World handoff between accounts.** Possible via the JSON-folder dump format, but not yet a documented flow.
- **Auto-scaling tuning.** CF picks the closest region per DO; there are no knobs to expose yet.
- **Federated worlds.** v2.

---

## Going further

Once your world is running:

- Read [spec/dubspace-demo.md](spec/dubspace-demo.md), [spec/taskspace-demo.md](spec/taskspace-demo.md), and [spec/chat-demo.md](spec/chat-demo.md) to understand the seeded demos.
- Use the IDE tab in the bundled client to author verbs.
- See [spec/authoring/minimal-ide.md](spec/authoring/minimal-ide.md) for the authoring loop.
- File issues against your fork or upstream as you find them.

The runtime is world-visible by design — `wiz:world_metrics()` is always a fan-out call away if you want to know what's happening.
