# Milestones

## M0: Spec Harness

Deliverables:

- project scaffold
- test runner
- formatter/linter
- local dev server
- empty websocket route

Checks:

- `npm test` or equivalent runs
- local browser can connect and receive a health message

## M1: Core + T0 VM In Memory

Deliverables:

- `Value`, `ObjRef`, `WooObject`, `Message`, `SequencedMessage`
- bootstrap seed graph in memory
- introspection operations (`:describe`, `verbs`, `properties`, etc.)
- in-memory object repository
- in-memory `$space` with monotonic sequence numbers
- T0 VM interpreter
- dispatch of messages to concrete seeded bytecode fixtures
- observations captured in tests

Checks:

- boot creates `$system`, `$root`, `$actor`, `$player`, `$wiz`, `$space`,
  `$thing`, demo classes, demo instances, and guest pool
- calling two messages through one space yields `seq = 1, 2`
- messages apply in sequence order
- bytecode verb can mutate target object state
- bytecode verb can emit observation
- `:describe()` exposes object metadata without global enumeration

## M2: Persistent Core

Deliverables:

- durable object/state storage
- message history table
- object metadata plus property/verb/schema tables scoped by `object_id`
- anchor-cluster storage support
- optional snapshot read/write
- migration/version marker

Checks:

- restart/reload recovers objects
- latest sequence number persists
- replay after sequence N can be fetched
- anchored Dubspace controls mutate atomically with the space
- optional snapshot can reconstruct Dubspace state if snapshot support is in scope

## M3: Websocket Actors

Deliverables:

- client session connects as actor/player
- client makes calls
- server returns applied results and observations
- reconnect uses `space:replay` for gap recovery
- retrying the same call id returns the same applied frame while in cache

Checks:

- two clients see the same ordered observations
- reconnect recovers current state without dedicated sync/history frames
- malformed messages fail without corrupting sequence
- duplicate call id does not allocate a second seq

## M4: Dubspace Demo

Deliverables:

- browser UI with four loop slots, filter, delay, one scene
- Web Audio playback using bundled or generated simple loops
- shared control changes via sequenced messages
- seeded T0 VM verbs for loop/control/scene behavior
- persisted committed mix state

Checks:

- two browsers share control changes
- reload restores loop/control/scene state
- gesture samples that affect sound are sequenced
- pure pointer/presence hints do not become durable state

## M5: Taskspace Demo

Deliverables:

- `$taskspace < $space`
- `$task` with status enum (`open`, `claimed`, `in_progress`, `blocked`, `done`),
  hierarchical parent/contents, requirement checklist, single `assignee`
- seeded T0 verbs for `task:create`, `task:add_subtask`, `task:claim`,
  `task:set_status`, `task:add_requirement`, `task:check_requirement`,
  `task:add_message`, `task:add_artifact`
- `done_premature` observation when status moves to `done` with unchecked requirements
- minimal browser UI: task tree, claim button, status select, requirement checklist,
  activity timeline
- persisted task hierarchy and message log

Checks:

- two actors (human or scripted) coordinate through one taskspace and see ordered timeline
- task tree creation, subtask add, and `task:move` produce deterministic structure
- reload restores the task tree and timeline
- agent client (no UI) can issue structured calls and consume `applied` observations
- soft-DoD: marking `done` with unchecked requirements emits `done_premature` and is
  visible in the timeline; the status change still applies

## M6: Minimal IDE Authoring Loop

Deliverables:

- object browser and inspector using introspection
- T0 source compiler for the minimal profile
- raw `t0-json-bytecode` fallback with verifier
- `compile_verb` without mutation
- `set_verb_code` with `expected_version`
- property definition edits with `expected_version`
- structured compile diagnostics and runtime traces
- call console for direct calls and `$space:call`

Checks:

- changing one behavior affects later calls without restart
- failed compile installs nothing
- version conflict raises `E_VERSION`
- stale property definition version raises `E_VERSION`
- old persisted objects still load
- authority checks prevent arbitrary mutation
- runtime error trace links to readable source lines

## M7: Basic Chat Space (deferred second-space demo)

Deliverables:

- `$room < $space`
- `$player`
- `say` message
- speech observations
- minimal transcript/history view

Checks:

- two players in one room see ordered speech
- room behavior uses same `$space` sequencing path as Dubspace
- no text-command parser required; tests may make structured calls

Chat is structurally similar to Dubspace (real-time, presence, low-latency) and
adds less platform-breadth than Taskspace, so it is sequenced after the taskspace
demo and the minimal IDE authoring loop.
