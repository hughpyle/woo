# Bootstrap

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

The seed object graph a world boots from. Lists every object that must exist before the first call lands: universal classes (anything that has objects needs them), demo classes (dubspace, taskspace), and the demo instances those classes are instantiated into.

This is the contract the implementation must produce on first start; without it, an implementer would invent structure.

---

## B1. Boot order

1. **Directory** is created first. Holds corename → ULID map and world metadata. Empty at boot until populated.
2. **`$system` (`#0`)** is created with the reserved ULID `00000000000000000000000000`. `parent = null`.
3. **Universal classes** are created in dependency order: `$root` → `$actor` → `$player` → `$wiz`, `$space` → `$thing`. Corenames registered in Directory.
4. **Demo classes** are created depending on which demo is being booted: dubspace classes (`$dubspace`, `$loop_slot`, `$channel`, `$filter`, `$delay`, `$scene`) or taskspace classes (`$taskspace`, `$task`).
5. **Demo instances** (`the_dubspace`, `the_taskspace`) are created with their internal anchored objects.
6. **Guest player pool** is pre-seeded so first connections don't need to mint identities.

Boot is idempotent: running it twice should be a no-op (each seed is created only if its corename isn't already mapped). This makes test setup and dev-restart trivial.

---

## B2. Universal classes

| Corename | ULID alias | Parent | Flags | Purpose |
|---|---|---|---|---|
| `$system` | `#0` | none | wizard | Bootstrap object; holds corenames as properties. |
| `$root` | `#1` | `#0` | — | Universal base. Every object's parent chain ends here. |
| `$actor` | `#2` | `$root` | — | Anything that can call (`message.actor` must inherit from this). |
| `$player` | `$actor` | — | An actor with an attached client session. |
| `$wiz` | `$player` | wizard, programmer | Admin actor. |
| `$space` | `$root` | — | Coordination primitive (see [space.md](space.md)). |
| `$thing` | `$root` | — | Non-actor base for objects that just hold state. |

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

| Corename | Parent | Anchor | Notes |
|---|---|---|---|
| `$dubspace` | `$space` | n/a (own host) | Dubspace base class. |
| `$control` | `$root` | n/a | Base for any controllable surface element. |
| `$loop_slot` | `$control` | n/a | Holds a loaded loop and play state. |
| `$channel` | `$control` | n/a | Mixer channel (gain). |
| `$filter` | `$control` | n/a | Filter (cutoff). |
| `$delay` | `$control` | n/a | Delay (send, time, feedback, wet). |
| `$scene` | `$root` | n/a | A snapshot of control values. |

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

### B3.4 `$scene` properties

| Property | Type | Default |
|---|---|---|
| `name` | str | `""` |
| `controls` | map | `{}` |  Snapshot of all control values, keyed by control objref string. |

### B3.5 `$dubspace` verbs

| Verb | Args | Purpose |
|---|---|---|
| `:set_control(target, name, value)` | obj, str, any | Sequenced; sets `target.<name> = value`, emits `control_changed`. |
| `:save_scene(name)` | str | Captures current controls into a `$scene`. Emits `scene_saved`. |
| `:recall_scene(scene)` | obj | Applies a scene's controls. Emits `scene_recalled`. |
| `:start_loop(slot)` | obj | Sets `slot.playing = true`. Emits `loop_started`. |
| `:stop_loop(slot)` | obj | Sets `slot.playing = false`. Emits `loop_stopped`. |

(All these are wrappers over `$space:call`; their bodies are seeded T0 verbs.)

---

## B4. Taskspace classes

| Corename | Parent | Anchor | Notes |
|---|---|---|---|
| `$taskspace` | `$space` | n/a (own host) | Taskspace base class. |
| `$task` | `$root` | n/a | Work-item base class. |

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
| `the_dubspace` | `$dubspace` | n/a (own host root) | The single demo dubspace. |
| `the_taskspace` | `$taskspace` | n/a (own host root) | The single demo taskspace. |

For the dubspace, the demo creates the four loop slots, one channel, one filter, one delay, one scene as anchored children:

```
the_dubspace                          (own host; root of anchor cluster)
├── slot_1, slot_2, slot_3, slot_4    (anchor = the_dubspace)
├── channel_1                         (anchor = the_dubspace)
├── filter_1                          (anchor = the_dubspace)
├── delay_1                           (anchor = the_dubspace)
└── default_scene                     (anchor = the_dubspace)
```

All seven control objects share `the_dubspace`'s host, so a `set_control` call mutating any of them runs in one transaction.

For the taskspace, no instances exist at boot — tasks are created at runtime by actor calls. All tasks anchor on `the_taskspace`, so the entire project lives on one host.

---

## B6. Guest player pool

A pre-seeded pool of `$player` objects, e.g. `guest_1`..`guest_8`, exists at boot. When a client presents `auth { token: "guest:<random>" }`, the server assigns one of the unbound guest players to the new session. The pool refills as guests disconnect and their sessions reap (identity.md §I6).

For the demo, 8 guests is enough for a small cohort. Real worlds would mint guests on demand.

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
