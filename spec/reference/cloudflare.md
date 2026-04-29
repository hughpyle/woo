# Reference architecture: Cloudflare

> Part of the [woo specification](../../SPEC.md). Layer: **reference**. Profile: **v1-core**. Concrete mapping of woo's abstract host model and persistence onto Cloudflare's primitives. Other implementations are possible; this document is the reference plan.

---

## R1. Host mapping

| Abstract host (semantics) | Concrete (Cloudflare) |
|---|---|
| Edge | Worker isolate, per-request |
| Persistent | Durable Object — one DO per woo object |
| Transient | Browser tab JavaScript runtime |

### R1.1 Routing

A persistent ULID is also a Durable Object name. `env.MOO.idFromName("#01HXYZ...")` deterministically routes to the same DO globally. There is no intermediate lookup; the ID *is* the address.

For anchored objects ([semantics/objects.md §4.1](../semantics/objects.md#41-anchor-and-atomicity-scope)), the routing key is the anchor's id (followed transitively to the root of the anchor tree). `idFromName(root_anchor_ulid)` resolves to the same DO that hosts the entire anchor cluster. Multiple object rows then coexist in that DO's `object` table.

Cross-DO RPC uses the DO stub returned from `idFromName`. The stub's methods are the inter-host RPC surface (verb dispatch migration, property read/write, version-checked artifact fetch).

### R1.2 ID allocation

ULIDs are minted in-process by whichever DO is creating a child object. No central allocator on the hot path. See [../semantics/objects.md §5.5](../semantics/objects.md#55-id-allocation) for the abstract algorithm.

### R1.3 Edge worker entry

A single Cloudflare Worker handles inbound HTTP/WebSocket and dispatches:
- `wss://world.example/connect` → routed to the connecting player's DO via session token.
- HTTP API endpoints (admin, world boot, etc.) routed to the appropriate singleton DO.

### R1.4 Hibernation

DOs hibernate after periods of inactivity. WebSocket connections survive hibernation via Cloudflare's hibernating WebSocket API; per-connection state up to 2 KiB serializes via `serializeAttachment()`.

### R1.5 Alarm-based scheduling

Suspended tasks (`SUSPEND`, `FORK`, `READ`-with-timeout) are durable on the parking DO via SQLite + a DO alarm set at the earliest resume time. On alarm fire, the DO wakes and resumes all due tasks. See [../semantics/tasks.md §16](../semantics/tasks.md#16-task-lifecycle-and-suspension).

### R1.6 Connection routing

Each WebSocket connects to its player's DO directly (singleton-per-player). The Worker performs auth then forwards the upgraded WebSocket to the appropriate DO via `fetch` with the WebSocket attached.

---

## R2. Singleton DOs

| DO | Purpose |
|---|---|
| `Directory` | Holds the corename map and world metadata. Read-mostly, off the hot path. Does **not** mint IDs. |
| `QuotaAccountant` | Periodic eventually-consistent accounting. See [quotas.md](quotas.md). |
| `$system` (`#0`) | Bootstrap object. Holds corename properties. |

Wizard ops requiring DO enumeration (cleanup, stats, dump) go via the CF management plane, not the runtime API.

---

## R3. Per-object persistence

Schema and write patterns are in [persistence.md](persistence.md).

---

## R4. Cost notes (TBD)

- Every persistent object is a DO with its own SQLite footprint. Idle DOs hibernate to ~zero idle cost.
- Per-DO 1k req/sec soft cap means a single hot object naturally rate-limits incoming traffic. Adversarial saturation against one object cannot bring down the world.
- Real cost numbers go here once the implementation exists; tracked in [LATER.md](../../LATER.md).
