# Work Packages

Each package should be independently assignable to an agent. Agents must not
change files outside their package without coordinating.

## WP1: Core Types

Owns:

- `src/core/value.ts`
- `src/core/object.ts`
- `src/core/message.ts`

Tasks:

- define serializable value representation
- define object refs
- define object records and property maps
- define message and observation types
- define verb/property/schema metadata types
- define session/actor types

Acceptance:

- JSON round trip tests for all core value types
- equality tests for refs, lists, maps, and scalar values
- message and observation encoding matches `spec/semantics/values.md`

## WP1A: Bootstrap + Introspection

Owns:

- `src/runtime/seed.ts`
- `src/core/introspection.ts`
- seed fixture data

Tasks:

- implement idempotent bootstrap from `spec/semantics/bootstrap.md`
- seed universal classes, demo classes, demo instances, and guest player pool
- implement `$root:describe()` convention
- implement read-only introspection operations

Acceptance:

- boot is idempotent
- all required corenames resolve
- `:describe()` works for root, space, Dubspace, Taskspace, and task objects
- no global object enumeration API is introduced

## WP2: Space Sequencer

Owns:

- `src/core/space.ts`
- `src/core/dispatch.ts`
- `src/core/tiny-vm.ts`
- `src/core/t0-fixtures.ts`

Tasks:

- implement `$space:call`
- assign monotonic `seq`
- apply messages in order
- run target verb bytecode in the T0 VM
- preserve accepted failed messages while rolling back mutations
- emit `$error` observation for behavior failure

Acceptance:

- deterministic ordering tests
- bytecode mutation tests
- bytecode observation tests
- pre-sequence validation/authorization failures do not increment seq
- behavior failure increments seq and emits an error observation

## WP3: Storage

Owns:

- `src/storage/`

Tasks:

- persist object state
- persist message history
- persist per-object properties, verbs, children, contents, schemas with
  `object_id` scoping
- persist anchor-cluster state
- persist snapshots if continuity work is in scope
- expose repository interface for core runtime

Acceptance:

- migration marker test
- object/message reload tests
- replay pagination tests
- anchor cluster allows same property/verb names on different hosted objects
- optional snapshot tests if continuity work is in scope

## WP4: Protocol

Owns:

- `src/protocol/`
- websocket request/response types

Tasks:

- define client call frame
- define applied/error frame
- define auth/session/ping/pong frames
- implement first-light frame validation only
- implement idempotent call-id retry cache

Acceptance:

- schema/validator tests
- malformed input tests
- stable examples in docs
- duplicate call id returns same applied result
- snapshot/history/sync frames are rejected or ignored until spec adds them

## WP5: Server Runtime

Owns:

- `src/worker.ts`
- `src/runtime/`

Tasks:

- route websocket sessions
- bind session to actor
- implement guest/session token auth
- maintain presence-derived observation membership
- connect protocol to core runtime and storage
- broadcast observations to subscribed clients

Acceptance:

- two-client integration test
- reconnect test
- invalid actor/message rejection test
- multi-attach session fans out applied frames

## WP6: Dubspace Client

Owns:

- `src/client/dubspace/`

Tasks:

- build minimal control surface
- implement loop playback
- send sequenced control messages
- render observations

Acceptance:

- UI shows four loop slots, filter, delay, one scene
- two sessions converge visually
- reload restores state

## WP7: Taskspace Demo

Owns:

- taskspace handlers/fixtures
- `src/client/taskspace/`
- Taskspace tests

Tasks:

- implement `$taskspace` and `$task` seeded behavior
- implement hierarchical task create/add/move
- implement claim/release/status/requirements/messages/artifacts
- render task tree, inspector, checklist, artifact list, and timeline
- support a headless/scripted agent client

Acceptance:

- task hierarchy invariants from `spec/taskspace-demo.md` hold
- two actors see the same ordered timeline
- agent client can discover and operate the taskspace via introspection
- `done_premature` emits without blocking `done`

## WP8: Minimal IDE

Owns:

- `src/authoring/`
- `src/client/ide/`

Tasks:

- implement T0 source compiler subset
- implement raw `t0-json-bytecode` fallback and verifier
- implement `compile_verb` and versioned `set_verb_code`
- implement versioned property definition edits
- implement structured diagnostics and runtime trace mapping
- build object browser, inspector, verb editor, call console, observation panel

Acceptance:

- compile without install is read-only
- successful install bumps verb version
- stale `expected_version` raises `E_VERSION`
- stale property definition version raises `E_VERSION`
- edited behavior affects later calls
- denied source reads and tracebacks are permission-filtered

## WP9: LambdaCore Reference Extraction

Owns:

- `tools/lambdacore/`
- generated reference docs under `impl/reference/` or `notes/`

Tasks:

- parse LambdaMOO db enough to extract object names, parents, props, verbs
- emit JSON summary
- emit markdown summary of core objects

Acceptance:

- reports #1, #3, #5, #6, #7, #8, #9, #57, #58
- records parent, props, local verbs
- does not attempt full import

## WP10: Basic Chat Space (Deferred)

Owns:

- chat-space handlers and tests

Tasks:

- implement room-as-space
- implement player actor
- implement structured `say`
- emit speech observations

Acceptance:

- ordered two-player speech test
- shares core `$space` path with Dubspace
- no text parser is required
