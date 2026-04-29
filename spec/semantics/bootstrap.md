# Bootstrap

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**. Profile: **v1-core** (universal classes); demo classes (`$dubspace`, `$taskspace`) are **first-light**.

The seed object graph a world boots from. Lists every object that must exist before the first call lands: universal classes (anything that has objects needs them), demo classes (dubspace, taskspace), and the demo instances those classes are instantiated into.

This is the contract the implementation must produce on first start; without it, an implementer would invent structure.

---

## B1. Boot order

1. **Directory** is created first. Holds corename → ULID map and world metadata. Empty at boot until populated.
2. **`$system` (`#0`)** is created with the reserved ULID `00000000000000000000000000`. `parent = null`.
3. **Universal classes** are created in dependency order: `$root` → `$actor` → `$player` → `$wiz`, `$space` → `$thing`. Corenames registered in Directory.
4. **Demo classes** are created depending on which demo is being booted: dubspace classes (`$dubspace`, `$loop_slot`, `$channel`, `$filter`, `$delay`, `$drum_loop`, `$scene`) or taskspace classes (`$taskspace`, `$task`).
5. **Demo instances** (`the_dubspace`, `the_taskspace`) are created with their internal anchored objects.
6. **Guest player pool** is pre-seeded so first connections don't need to mint identities.

Boot is idempotent: running it twice should be a no-op (each seed is created only if its corename isn't already mapped). This makes test setup and dev-restart trivial.

Every object created by bootstrap has a non-empty `description` value. The description is not marketing copy; it is operational context for readers, agents, and IDEs: what the object is for, what it composes, and how it fits into the seed graph. `$system` has its own local `description` because it is outside the `$root` inheritance chain; all ordinary seed objects inherit the slot from `$root` and override the value.

---

## B2. Universal classes

| Corename | ULID alias | Parent | Flags | Description |
|---|---|---|---|---|
| `$system` | `#0` | none | wizard | Bootstrap object and world registry root. It has no parent, owns the reserved `#0` identity, carries wizard authority, and anchors corenames and world-level metadata. |
| `$root` | `#1` | `$system` | — | Universal base class for ordinary persistent objects. It defines common descriptive slots and inherited utility verbs, so most object parent chains terminate here before reaching `$system`. |
| `$actor` | `#2` | `$root` | — | Base class for principals that can originate messages. Actors participate in spaces through presence, appear as `message.actor`, and represent the authority behind user-facing calls. |
| `$player` | `$actor` | — | Session-capable actor class for humans, agents, or tools connected over the wire. A player composes actor identity with session bookkeeping and attached websocket state. |
| `$wiz` | `$player` | wizard, programmer | Seed administrator player. It carries wizard and programmer flags so the initial world can bootstrap, inspect, and repair code, schema, and seeded objects. |
| `$space` | `$root` | — | Coordination base class. A space owns a local message sequence, accepts calls, applies them one at a time, stores replayable history, and pushes observations to present subscribers. |
| `$thing` | `$root` | — | Simple non-actor base class for persistent objects that primarily hold state. Use it when an object should be addressable and programmable but should not itself originate calls. |

(The "ULID alias" column shows the conventional short form. Real ULIDs are deterministic from a seed phrase per world, so the same seed graph is reproducible.)

### B2.1 `$root` properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `name` | str | `""` | Human-readable. Not unique. |
| `description` | str | `""` | Long-form description. Surfaced by `:look`-like verbs. |
| `aliases` | list<str> | `[]` | Alternate names for command/match. |

### B2.2 `$root` verbs

| Verb | Returns | Purpose |
|---|---|---|
| `:describe()` rxd | map | Introspection (see [introspection.md](introspection.md)). |
| `:on_event(event)` | — | Default observation handler; no-op. |

### B2.3 `$actor` additional properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `presence_in` | list<obj> | `[]` | Spaces the actor is currently in. |

### B2.4 `$player` additional properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `session_id` | str \| null | null | Current session (see identity.md §I2). |
| `attached_sockets` | list<str> | `[]` | Per the multi-attach model in identity.md §I5. |

### B2.5 `$space` additional properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `next_seq` | int | 1 | The next seq to assign. |
| `subscribers` | list<obj> | `[]` | Actors observing this space. |
| `last_snapshot_seq` | int | 0 | Used for snapshot triggering. |

### B2.6 `$space` verbs

| Verb | Args | Purpose |
|---|---|---|
| `:call(message)` | message | Sequenced dispatch (space.md §S2). |
| `:replay(from_seq, limit)` rxd | int, int | Paged history. |
| `:snapshot()` | — | Capture materialized state. Wizard or programmer-only. |
| `:subscribe(actor)` | obj | Add to subscribers. |
| `:unsubscribe(actor)` | obj | Remove from subscribers. |
| `:on_applied(_event)` | event | Snapshot-trigger hook (space.md §S7). |

---

## B3. Dubspace classes

| Corename | Parent | Anchor | Description |
|---|---|---|---|
| `$dubspace` | `$space` | n/a (own host) | Base class for shared dub-mix spaces. It composes `$space` sequencing with sound-control verbs for loop slots, mixer channels, filters, delay, and scene recall. |
| `$control` | `$root` | n/a | Base class for addressable controls in a sound surface. Controls are anchored into a containing space so sequenced messages can mutate the whole control cluster atomically. |
| `$loop_slot` | `$control` | n/a | Control class for a loaded loop slot. A loop slot stores the selected loop id, whether it is playing, and gain, and is driven by start/stop and control-change messages. |
| `$channel` | `$control` | n/a | Control class for mixer-channel state. The first demo keeps this intentionally small, with gain as the primary channel property. |
| `$filter` | `$control` | n/a | Control class for filter state. It currently models cutoff as a shared sequenced parameter in the dubspace control cluster. |
| `$delay` | `$control` | n/a | Control class for delay-effect state. It groups send, time, feedback, and wet mix so actors can shape echo gestures through ordinary sequenced messages. |
| `$drum_loop` | `$control` | n/a | Control class for a small step-sequenced percussion loop. It stores transport state, tempo, and an eight-step pattern for simple shared rhythmic play. |
| `$scene` | `$root` | n/a | Class for saved control snapshots. A scene records a named map of control object refs to property values so a dubspace can restore a known mix state. |

### B3.1 `$control` properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `value` | float \| map | 0.0 or `{}` | Current control state. Type per subclass. |

### B3.2 `$loop_slot` properties

| Property | Type | Default |
|---|---|---|
| `loop_id` | str \| null | null |
| `playing` | bool | false |
| `gain` | float | 1.0 |

### B3.3 `$channel` / `$filter` / `$delay` properties

`$channel`: `gain` (float, 1.0).
`$filter`: `cutoff` (float, 1000.0).
`$delay`: `send` (float, 0.0), `time` (float, 0.25), `feedback` (float, 0.3), `wet` (float, 0.5).

### B3.4 `$drum_loop` properties

| Property | Type | Default |
|---|---|---|
| `bpm` | int | 118 |
| `playing` | bool | false |
| `started_at` | int | 0 |
| `step_count` | int | 8 |
| `pattern` | map<str, list<bool>> | `{kick, snare, hat, tone}` rows, each 8 booleans |

### B3.5 `$scene` properties

| Property | Type | Default |
|---|---|---|
| `name` | str | `""` |
| `controls` | map | `{}` |  Snapshot of all control values, keyed by control objref string. |

### B3.6 `$dubspace` verbs

| Verb | Args | Purpose |
|---|---|---|
| `:set_control(target, name, value)` | obj, str, any | Sequenced; sets `target.<name> = value`, emits `control_changed`. |
| `:save_scene(name)` | str | Captures current controls into a `$scene`. Emits `scene_saved`. |
| `:recall_scene(scene)` | obj | Applies a scene's controls. Emits `scene_recalled`. |
| `:start_loop(slot)` | obj | Sets `slot.playing = true`. Emits `loop_started`. |
| `:stop_loop(slot)` | obj | Sets `slot.playing = false`. Emits `loop_stopped`. |
| `:set_drum_step(voice, step, enabled)` | str, int, bool | Updates one row/step in the shared percussion pattern. Emits `drum_step_changed`. |
| `:set_tempo(bpm)` | int | Sets the shared percussion tempo. Emits `tempo_changed`. |
| `:start_transport()` | — | Starts the shared percussion transport by storing a space-owned `started_at` timestamp. Emits `transport_started`. |
| `:stop_transport()` | — | Stops the shared percussion transport. Emits `transport_stopped`. |

All these behaviors are reached through `$space:call`. First-light may seed the
simple property-update behaviors as T0 bytecode and the list/timer-heavy
behaviors as native bootstrap handlers until the VM profile can express them
directly.

---

## B4. Taskspace classes

| Corename | Parent | Anchor | Description |
|---|---|---|---|
| `$taskspace` | `$space` | n/a (own host) | Base class for spaces that coordinate hierarchical work. It extends `$space` with root task ordering and task-creation behavior for asynchronous human and agent collaboration. |
| `$task` | `$root` | n/a | Base class for taskspace work items. A task stores title, description, status, assignee, requirements, artifacts, messages, parent linkage, and ordered subtasks. |

### B4.1 `$taskspace` additional properties

| Property | Type | Default |
|---|---|---|
| `root_tasks` | list<obj> | `[]` | Top-level tasks ordered. |

### B4.2 `$task` properties

| Property | Type | Default |
|---|---|---|
| `title` | str | `""` |
| `description` | str | `""` |
| `parent_task` | obj \| null | null | null = directly under taskspace root |
| `subtasks` | list<obj> | `[]` | Ordered. |
| `status` | str | `"open"` | One of: `open`, `claimed`, `in_progress`, `blocked`, `done`. |
| `assignee` | obj \| null | null | The claimer. |
| `requirements` | list<map> | `[]` | `[{text: str, checked: bool}, ...]`. |
| `artifacts` | list<map> | `[]` | `[{kind: str, ref: str, label?: str}, ...]`. |
| `messages` | list<map> | `[]` | `[{actor: obj, ts: int, body: str}, ...]`. |
| `space` | obj | (set at create) | The taskspace this task belongs to (for emit routing). |

### B4.3 `$taskspace` verbs

`:create_task(title, description)` returning the new task ref. Body wraps `create($task, owner=actor)` and appends to `root_tasks`. Emits `task_created`.

### B4.4 `$task` verbs

| Verb | Args | Purpose |
|---|---|---|
| `:add_subtask(title, description)` | str, str | Creates a child task. Emits `subtask_added`. |
| `:move(parent, index)` | obj \| null, int | Re-parent or reorder; emits `task_moved`. |
| `:claim()` | — | Sets `assignee = actor`, status `claimed`. Emits `task_claimed`. |
| `:release()` | — | Clears assignee, status `open`. Emits `task_released`. |
| `:set_status(status)` | str | Sets status; on `done` with unchecked requirements, also emits `done_premature`. Emits `status_changed`. |
| `:add_requirement(text)` | str | Appends to requirements. Emits `requirement_added`. |
| `:check_requirement(index, checked)` | int, bool | Updates checked. Emits `requirement_checked`. |
| `:add_message(body)` | str | Appends to messages. Emits `message_added`. |
| `:add_artifact(ref)` | map | Appends to artifacts. Emits `artifact_attached`. |

---

## B5. Demo instances

| Corename | Class | Anchor | Description |
|---|---|---|---|
| `the_dubspace` | `$dubspace` | n/a (own host root) | The first runnable sound-space instance. It owns the sequenced coordination surface for four loop slots, one channel, one filter, one delay, and one default scene. |
| `the_taskspace` | `$taskspace` | n/a (own host root) | The first runnable task coordination space. It owns the sequenced timeline and anchored task tree used by people or agents to create, claim, discuss, and complete work. |

For the dubspace, the demo creates the four loop slots, one channel, one filter, one delay, one percussion loop, and one scene as anchored children:

```
the_dubspace                          (own host; root of anchor cluster)
├── slot_1, slot_2, slot_3, slot_4    (anchor = the_dubspace)
├── channel_1                         (anchor = the_dubspace)
├── filter_1                          (anchor = the_dubspace)
├── delay_1                           (anchor = the_dubspace)
├── drum_1                            (anchor = the_dubspace)
└── default_scene                     (anchor = the_dubspace)
```

All control objects share `the_dubspace`'s host, so a `set_control` or sequencer call mutating any of them runs in one transaction.

The anchored dubspace objects also carry descriptions:

| Object | Class | Description |
|---|---|---|
| `slot_1`..`slot_4` | `$loop_slot` | A loop slot in the demo dubspace. It is anchored to `the_dubspace` and stores its loop id, playing state, and gain as part of the shared sequenced mix. |
| `channel_1` | `$channel` | Mixer channel for the demo dubspace. It is anchored to `the_dubspace` and contributes shared gain state to the current mix. |
| `filter_1` | `$filter` | Shared filter control for the demo dubspace. It is anchored to `the_dubspace` and exposes cutoff as a sequenced parameter. |
| `delay_1` | `$delay` | Shared delay control for the demo dubspace. It is anchored to `the_dubspace` and stores send, time, feedback, and wet mix values for collaborative echo gestures. |
| `drum_1` | `$drum_loop` | Eight-step percussion loop for the demo dubspace. It is anchored to `the_dubspace` and stores tempo, transport state, and a shared kick/snare/hat/tone pattern. |
| `default_scene` | `$scene` | Initial saved scene for the demo dubspace. It records a named control snapshot and gives scene recall a concrete object to read and rewrite. |

For the taskspace, no instances exist at boot — tasks are created at runtime by actor calls. All tasks anchor on `the_taskspace`, so the entire project lives on one host.

---

## B6. Guest player pool

A pre-seeded pool of `$player` objects, e.g. `guest_1`..`guest_8`, exists at boot. When a client presents `auth { token: "guest:<random>" }`, the server assigns one of the unbound guest players to the new session. The pool refills as guests disconnect and their sessions reap (identity.md §I6).

For the demo, 8 guests is enough for a small cohort. Real worlds would mint guests on demand. Each guest's description states that it is a pre-seeded temporary player, can be bound to a session, gains demo-space presence on auth, and exists to give local users or agents a stable first-light actor.

---

## B7. Verb bodies

The seeded verbs above are implemented as T0 bytecode. Concrete JSON bytecode for the load-bearing ones is in [tiny-vm.md "Concrete fixtures"](tiny-vm.md#concrete-fixtures). Verbs not in the fixture list have straightforward bodies that follow the same pattern: read args, read/write properties, emit observation, return.

---

## B8. Idempotent rebooting

Every step of the boot sequence checks the Directory's corename map first; if the corename already maps to a ULID, the seed is skipped. This means:

- A fresh world creates everything.
- A restarted world finds everything already present and changes nothing.
- A partial-boot failure (server crashed mid-seed) recovers by re-running boot — only the missing seeds are created.

Wizards can run boot manually via a `wiz:rebuild_seeds()` verb; this fills any missing corenames without disturbing existing objects.
