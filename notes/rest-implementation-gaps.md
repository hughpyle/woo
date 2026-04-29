# REST Implementation Gaps

Status: known follow-up items after the first runtime REST slice.

- Permission-filtered describe is not complete. `GET /api/objects/{id}` currently uses `world.describe()` and does not redact values based on caller permissions. The current demos are single-trust-domain, but multi-user worlds need the R4 filtering pass before exposing REST outside local/dev.
- SSE retention bounds are not enforced yet. `Last-Event-ID` replay works while logs are complete; once log truncation or snapshot-driven compaction lands, old cursors must return `410 E_SSE_TOO_OLD` and direct clients to `/log`.
- Transient refs (`~...`) are not resolved by REST yet. This can wait until browser-host transient objects participate in runtime calls.
- Static corename lookup is currently just object-id lookup for seeded `$...` names. Runtime-added corename maps need an explicit `$system` lookup mechanism.
