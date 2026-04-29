# Testing Plan

## Unit Tests

Core:

- value encoding/decoding
- object refs
- message validation
- bootstrap idempotency
- introspection and `:describe()`
- space sequencing
- T0 VM dispatch
- concrete T0 fixtures
- mutation application
- observation emission
- behavior failure rollback and `$error` observation

Storage:

- object save/load
- message history append/read
- anchor-cluster tables scoped by `object_id`
- schema version check
- snapshot save/load if continuity work is in scope

Protocol:

- valid frames parse
- invalid frames reject
- call/applied/error flows
- auth/session flows
- idempotent retry by call id
- snapshot/history/sync frames absent from first-light

## Integration Tests

- two actors call through one space and observe same sequence
- failed apply preserves sequence continuity
- reconnect gap recovery via `space:replay`
- multi-attach session receives fanout

## Demo Acceptance Tests

Dubspace:

- two clients see the same four loop slots
- loop start/stop is shared
- filter/delay control changes are shared
- scene save persists
- reload restores committed state

Taskspace:

- task tree create/add/move is deterministic
- claim/release/status transitions follow domain invariants
- requirements can be added/checked
- artifact refs validate and persist
- marking done with unchecked requirements emits `done_premature`
- browser actor and headless agent see the same ordered timeline

Minimal IDE:

- object browser can inspect seeded objects
- compile without install does not mutate
- raw `t0-json-bytecode` fallback verifies before install
- install with expected version succeeds and bumps version
- stale expected version raises `E_VERSION`
- stale property definition version raises `E_VERSION`
- runtime tracebacks map to source when readable

Deferred chat:

- two players in one room see ordered speech observations
- chat uses `$space:call`
- no text parser is required for the test

## Manual Checks

- run local server
- open two browser windows
- perform Dubspace controls in both directions
- reload one window and verify convergence
- inspect stored message history for monotonic seq values
