# Spec / Implementation Alignment — 2026-04-29

Purpose: keep the spec honest about what is currently built while preserving the
v1 direction. This is not a reduction pass; it marks where the working
implementation is intentionally behind the spec.

## Current built shape

- Local dev server with runnable dubspace/taskspace UI and minimal IDE.
- Richer v0.5 VM slice with local `CALL_VERB`, `PASS`, exceptions, loops,
  metering, and serialized frame stacks.
- Repository boundary with in-memory, SQLite, and JSON-folder implementations.
- Durable parked-task table and local scheduler for `FORK`, `SUSPEND`, and
  `READ`; space-owned wakes resume through fresh sequenced frames.

The current implementation is **not** a v1-core claim. It is a local v0.5
reference implementation that exercises enough runtime pressure to guide the
spec.

## Askew or ahead of implementation

1. **Direct-call live observations.** The spec says route determines
   durability: emits inside `$space:call` appear in applied frames; emits inside
   direct calls are live-only `op: "event"` frames. This is now implemented for
   the local WebSocket path: `op: "direct"` dispatches verbs marked
   `direct_callable`, and dubspace slider previews use
   `the_dubspace:preview_control(...)` instead of a special side channel.

2. **Features and chat.** `features.md`, `chat-demo.md`, and bootstrap entries
   for `$conversational`/`$chatroom` are spec-only. Current verb lookup walks
   the parent chain only; feature-aware lookup and feature manager verbs are not
   built.

3. **Applied-frame replay.** The spec wants sequenced observations to be
   replay-visible as part of applied frames. The current replay path returns
   stored messages/log entries, not fully reconstructed applied frames with
   observations.

4. **REST.** `protocol/rest.md` is v1-core API design. The dev server still has
   local development HTTP endpoints plus WebSocket traffic, not the six-endpoint
   REST/SSE surface.

5. **`direct_callable`.** Core semantics owns the concept, and `VerbDef` plus
   the local WebSocket direct path now enforce it. REST still needs its own
   endpoint implementation of the same gate.

6. **Event schemas.** Persistence has room for event schemas, but authoring,
   introspection, and runtime helpers such as `declare_event`/`event_schema` are
   not wired through.

7. **Value model.** The spec's v1 value contract is stricter than the current
   TypeScript `WooValue` union. Full tagged int/float/object/error encoding,
   normalization, and size limits remain v1-core work.

## Line-up decisions

- Do not build features/chat yet.
- Do not extend the VM further yet.
- The local call surfaces are now aligned: dubspace preview uses generic direct
  calls; live observations are `op: "event"`; sequenced observations remain in
  applied frames.
- Replay/backfill semantics still need a concrete applied-frame story before
  clients depend on replayed observations.

## Natural next implementation step

Define and implement the applied-frame replay story: either persist applied
frames, reconstruct them deterministically during replay, or make the replay API
explicitly message-log-only and require clients to refresh materialized state.
