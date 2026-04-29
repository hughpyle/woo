# Woo Implementation Spec

This tree translates the semantic spec into implementation work. It is written
for coding agents: each document should identify scope, dependencies,
deliverables, and checks.

The implementation spec is subordinate to `spec/`. If `impl/` conflicts with
the semantic model, fix `impl/` unless the semantic spec has explicitly changed.

## Documents

- [principles.md](principles.md): implementation constraints and project rules.
- [architecture.md](architecture.md): reference architecture and package shape.
- [milestones.md](milestones.md): ordered delivery plan.
- [work-packages.md](work-packages.md): agent-sized implementation tasks.
- [core-runtime.md](core-runtime.md): values, objects, messages, `$space`, dispatch.
- [persistence.md](persistence.md): durable storage, anchor clusters, logs, snapshots, migrations.
- [protocol.md](protocol.md): websocket and RPC message contracts.
- [client.md](client.md): browser clients: Dubspace, Taskspace, and minimal IDE.
- [authoring.md](authoring.md): compile/install loop and IDE implementation constraints.
- [lambda-core-reference.md](lambda-core-reference.md): how to mine LambdaCore.
- [testing.md](testing.md): verification strategy and acceptance tests.

## First Build Target

The first build target is not the whole MOO successor. It is the smallest
vertical slice proving woo-core:

1. canonical values and persistent objects
2. bootstrap seed graph from `spec/semantics/bootstrap.md`
3. one `$space` sequencing calls/messages
4. T0 VM running seeded bytecode fixtures
5. actors connected over websocket via `auth` / `session`
6. observations delivered as `applied` frames
7. Dubspace demo with persisted mix state

The next planned vertical slices are Taskspace and then the minimal IDE
authoring loop. Do not begin federation, full LambdaCore import, audio
recording, full DSL/compiler work, browser-host VM execution, or broad admin
tooling until those smaller slices work.
