# Quota accounting

> Part of the [woo specification](../../SPEC.md). Layer: **reference**. CF-specific implementation of the per-owner quotas defined abstractly in [../semantics/permissions.md §11.7](../semantics/permissions.md#117-storage-quotas-and-accounting).

---

## R5. The QuotaAccountant DO

A singleton DO that runs eventually-consistent accounting:

1. Wakes on alarm (default daily, configurable).
2. For each known owner:
   - Walks the owner's `created` list.
   - RPCs each owned DO for its current SQLite size.
   - Sums.
   - Writes the total back to a per-owner quota record.
3. Future `create()` and large `SET_PROP` calls consult the per-owner record; if over quota, raise `E_QUOTA`.

### R5.1 Eventual consistency

A burst write can briefly exceed quota before accounting catches up. The next pass detects it and blocks further growth. Strict real-time accounting would require a central allocator and contradict the decentralized minting story ([../semantics/objects.md §5.5](../semantics/objects.md#55-id-allocation)).

### R5.2 Schema

```sql
CREATE TABLE owner_quota (
  owner          TEXT PRIMARY KEY,    -- ULID of the owning object
  object_count   INTEGER NOT NULL,
  bytes_used     INTEGER NOT NULL,
  parked_tasks   INTEGER NOT NULL,
  last_accounted INTEGER NOT NULL,    -- ms timestamp of last full pass
  override_count INTEGER,             -- wizard override; NULL = use default
  override_bytes INTEGER,
  override_tasks INTEGER
);

CREATE TABLE known_owner (
  owner          TEXT PRIMARY KEY,    -- maintained at create() time
  added          INTEGER NOT NULL
);
```

### R5.3 Manual passes

Wizards may invoke `account_now()` to force an accounting pass; useful for debugging quota state or after bulk operations.

### R5.4 Real-time approximation (TODO)

The daily pass is a coarse mechanism. A better v2 design pushes per-DO bytes-changed deltas to QuotaAccountant on threshold cross, giving near-real-time accounting without a central allocator. Tracked in [LATER.md](../../LATER.md).
