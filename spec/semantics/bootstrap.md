# Bootstrap

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**. Profile: **v1-core** (universal classes); demo apps (`chat`, `taskspace`, `dubspace`) are **first-light local catalogs**.

The seed object graph a world boots from. Lists every object that must exist before the first call lands: universal classes (anything that has objects needs them), catalog registry scaffolding for v1-ops worlds, and the first-light local-catalog objects used by the bundled demos.

This is the contract the implementation must produce on first start; without it, an implementer would invent structure.

---

## B1. Boot order

1. **Directory** is created first. Holds corename → ULID map and world metadata. Empty at boot until populated.
2. **`$system` (`#0`)** is created with the reserved ULID `00000000000000000000000000`. `parent = null`.
3. **Universal classes** are created in dependency order: `$root` → `$actor` → `$player` → `$wiz` / `$guest`, `$sequenced_log` → `$space` → `$thing`. v1-ops catalog-capable worlds also seed `$catalog` and `$catalog_registry` after `$space`. Corenames registered in Directory.
4. **Configured local catalogs** are installed depending on which demos are being booted: `@local:chat`, `@local:taskspace`, and `@local:dubspace`. Until the local catalog installer is wired, first-light builds may hard-seed the equivalent classes and instances from code; the normative source is the catalog manifests.
5. **Demo instances** (`$nowhere`, `the_dubspace`, `the_taskspace`, `the_chatroom`) are created with their internal anchored objects by those local catalogs. `$nowhere` is a seeded `$thing` used as the default `home` for guests being reset. `:add_feature` calls attach `$conversational` to `the_chatroom` and `the_taskspace` (running as wizard at boot, satisfying both attach-policy gates).
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
| `$guest` | `$player` | — | Reusable temporary player. Bound to a session at auth time; reset via `:on_disfunc` and returned to the free pool when its session is reaped. See [identity.md §I6.4](identity.md#i64-guest-reset-the-on_disfunc-convention). |
| `$sequenced_log` | `$root` | — | Append-only sequenced log primitive. Owns the runtime-blessed `:append`/`:read` verbs, atomic seq allocation, and durable log storage. Subclassed by `$space` and other coordination shapes. See [sequenced-log.md](sequenced-log.md). |
| `$space` | `$sequenced_log` | — | Coordination workhorse. Adds dispatch, subscribers, and applied-frame broadcast on top of the inherited log primitive. The v1 reference subclass for `:call`-shaped sequenced coordination. |
| `$thing` | `$root` | — | Simple non-actor base class for persistent objects that primarily hold state. Use it when an object should be addressable and programmable but should not itself originate calls. |
| `$catalog` | `$thing` | — | v1-ops class for installed catalog records. Instances record source provenance, version, alias, owner, and created objects for introspection and uninstall. See [catalogs.md](../discovery/catalogs.md). |
| `$catalog_registry` | `$space` | own host | v1-ops singleton space that sequences catalog install/update/uninstall operations. Its log is the catalog operations history. See [catalogs.md §CT5](../discovery/catalogs.md#ct5-install). |

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
| `features` | list<obj> | `[]` | Feature objects contributing verbs to this actor. See [features.md](features.md). |
| `features_version` | int | 0 | Monotonic counter incremented on feature-list changes; used for verb-lookup cache invalidation. |

### B2.3.1 `$actor` feature-management verbs

| Verb | Args | Purpose |
|---|---|---|
| `:add_feature(f)` | obj | Append to `features`; idempotent. See [features.md §FT5](features.md#ft5-adding-and-removing-features). |
| `:remove_feature(f)` | obj | Remove from `features`. |
| `:has_feature(f)` rxd | obj | Predicate. |

### B2.4 `$player` additional properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `session_id` | str \| null | null | Current session (see identity.md §I2). |
| `home` | obj \| null | null | Where this player returns on `:on_disfunc`. Defaults `$nowhere` when null at reap time. |

`attached_sockets` is **not** a persistent property. Connection state is in-memory on the player host (per [identity.md §I2](identity.md#i2-three-layers-actor-session-connection)); persisting socket ids causes orphaned attachments after restart.

### B2.4.1 `$player` verbs

| Verb | Args | Purpose |
|---|---|---|
| `:on_disfunc()` | — | Disfunc hook called at session reap. Default body is a no-op; `$guest` overrides. See [identity.md §I6.4](identity.md#i64-guest-reset-the-on_disfunc-convention). |
| `:moveto(target)` | obj | Move this player to `target.contents`. Used by disfunc bodies. |

### B2.4.2 `$guest` verbs

`$guest:on_disfunc()` overrides the default to reset state per [identity.md §I6.4](identity.md#i64-guest-reset-the-on_disfunc-convention): move to `home` (or `$nowhere`), clear `description`/`aliases`/`features`, drop inventory, return to the free pool via `$system:return_guest(this)`.

### B2.5 `$sequenced_log` additional properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `next_seq` | int | 1 | The next seq to assign. Reserved; written only by inherited `:append`. |
| `last_snapshot_seq` | int | 0 | Highest seq covered by a snapshot. Used for snapshot triggering and log truncation. |

### B2.6 `$sequenced_log` verbs

| Verb | Args | Purpose |
|---|---|---|
| `:append(message)` rxd | any | Native; atomically allocates a seq and persists `(seq, message)`. See [sequenced-log.md §SL2](sequenced-log.md#sl2-the-native-verbs). |
| `:read(from, limit)` rxd | int, int | Native; paged history read. |

### B2.7 `$space` additional properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `subscribers` | list<obj> | `[]` | Actors observing this space's applied frames. |
| `features` | list<obj> | `[]` | Feature objects contributing verbs to this space. See [features.md](features.md). |
| `features_version` | int | 0 | Monotonic counter; verb-lookup cache invalidation. |

### B2.8 `$space` verbs

| Verb | Args | Purpose |
|---|---|---|
| `:call(message)` | message | Sequenced dispatch (space.md §S2). |
| `:replay(from_seq, limit)` rxd | int, int | Subclass alias for inherited `:read`. |
| `:snapshot()` | — | Capture materialized state. Wizard or programmer-only. |
| `:subscribe(actor)` | obj | Add to subscribers. |
| `:unsubscribe(actor)` | obj | Remove from subscribers. |
| `:on_applied(_event)` | event | Snapshot-trigger hook (space.md §S7). |
| `:add_feature(f)` | obj | Append to `features`; idempotent. |
| `:remove_feature(f)` | obj | Remove from `features`. |
| `:has_feature(f)` rxd | obj | Predicate. |

### B2.9 v1-ops catalog registry

Catalog-capable worlds seed `$catalog` and `$catalog_registry` in addition to
the v1-core universal classes. `$catalog_registry` has the normal `$space`
properties (`next_seq`, `subscribers`, `last_snapshot_seq`, `features`,
`features_version`) plus registry state:

| Property | Type | Default | Notes |
|---|---|---|---|
| `installed_catalogs` | list<map> | `[]` | Installed catalogs with alias, version, provenance, owner, and created-object refs. |

Its native verbs are `:install(manifest, frontmatter, alias, provenance)`,
`:uninstall(tap, catalog)`, `:update(tap, catalog, ref?, accept_major?)`, and
`:list()` (`rxd`). All mutating verbs are wizard-only and are called through
`$catalog_registry:call(...)`; direct calls are denied except `:list()`.

---

## B3. Local catalog: Dubspace classes

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

## B4. Local catalog: Taskspace classes

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

## B5. Local catalog: Chat classes and scaffolding

| Corename | Parent | Anchor | Description |
|---|---|---|---|
| `$match` | `$thing` | n/a | Chat-shaped text-to-action scaffold. It tokenizes input, resolves visible objects, resolves verbs using runtime lookup, and returns structured command maps. Ordinary worlds can omit it if they do not expose text-command surfaces. |
| `$failed_match` | `$thing` | n/a | Stable sentinel returned by `$match:match_object` when no visible object matches. It is a value object, not an exception. |
| `$ambiguous_match` | `$thing` | n/a | Stable sentinel returned by `$match:match_object` when multiple visible objects match at the same priority tier. It lets callers ask users to disambiguate without exceptions. |
| `$conversational` | `$thing` | n/a | Feature object carrying chat verbs. Attached to `$actor`- or `$space`-descended consumers via `:add_feature($conversational)` per [features.md](features.md). Its verbs run with `this` = the consumer; observation routing emits to `this.subscribers`. |
| `$chatroom` | `$space` | own host | Standalone room. A trivial `$space` subclass whose only addition is `features: [$conversational]` at boot. |

### B5.1 `$match` verbs

All direct-callable (rxd). See [match.md](match.md) for exact matching rules.

| Verb | Args | Purpose |
|---|---|---|
| `:match_object(name, location?)` | str, obj? | Resolve visible objects; returns obj, `$failed_match`, or `$ambiguous_match`. |
| `:match_verb(name, target)` | str, obj | Resolve a verb using the same lookup rule as runtime dispatch. |
| `:parse_command(text, actor)` | str, obj | Parse free text into a structured command map for chat-shaped surfaces. |

### B5.2 `$conversational` verbs

All direct-callable (rxd). Observations are live-only by route per [chat DESIGN.md](../../catalogs/chat/DESIGN.md).

| Verb | Args | Purpose |
|---|---|---|
| `:say(text)` | str | Emits `said`. |
| `:emote(text)` | str | Emits `emoted`. |
| `:tell(recipient, text)` | obj, str | Emits `told` to `recipient`. |
| `:look()` | — | Returns `{description, contents, present_actors}`. |
| `:who()` | — | Returns the present-actor list. |
| `:enter(actor?)` | obj? | Adds presence; emits `entered`. |
| `:leave(actor?)` | obj? | Removes presence; emits `left`. |
| `:command(text)` | str | Free-text dispatcher. Calls `$match:parse_command`, lowers per-verb, emits `huh` on parse failure. |
| `:can_be_attached_by(actor)` | obj | Default policy: `actor == this.owner || is_wizard(actor)`. Override to widen. |

### B5.3 `$conversational` schemas

Declared at boot:

```woo
declare_event $conversational "said"    { source: obj, actor: obj, text: str };
declare_event $conversational "emoted"  { source: obj, actor: obj, text: str };
declare_event $conversational "told"    { source: obj, from:  obj, to:   obj, text: str };
declare_event $conversational "entered" { source: obj, actor: obj };
declare_event $conversational "left"    { source: obj, actor: obj };
declare_event $conversational "huh"     { source: obj, actor: obj, text: str, suggestion?: str };
```

Schemas describe shape only ([events.md §13](events.md#13-schemas)); durability is set by the route of the verb that emits each observation.

### B5.4 Feature attachment at boot

The bootstrap step that creates `the_chatroom` (B6) and `the_taskspace` (B6) ends with:

```woo
the_chatroom:add_feature($conversational);    // running as wizard at boot
the_taskspace:add_feature($conversational);
```

`the_dubspace` does *not* receive `$conversational` by default — its primary surface is sound coordination, and a feature catalog can be added per-deployment.

---

## B6. Demo instances

| Corename | Class | Anchor | Description |
|---|---|---|---|
| `$nowhere` | `$thing` | n/a | Seed default-home for players whose `home` is null. Holds disconnected guests after `:on_disfunc` and any object reparented to `null` location during recycle. Wizard-owned, no contents-emitted observations. |
| `the_dubspace` | `$dubspace` | n/a (own host root) | The first runnable sound-space instance. It owns the sequenced coordination surface for four loop slots, one channel, one filter, one delay, and one default scene. |
| `the_taskspace` | `$taskspace` | n/a (own host root) | The first runnable task coordination space. It owns the sequenced timeline and anchored task tree used by people or agents to create, claim, discuss, and complete work. Boots with `features: [$conversational]` so `:say`/`:emote`/`:enter`/`:leave` are available alongside task verbs. |
| `the_chatroom` | `$chatroom` | n/a (own host root) | The first runnable chat room. Standalone surface for testing the chat client and `$match` parser; carries `features: [$conversational]` set at boot. |

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

## B7. Guest player pool

A pre-seeded pool of `$guest` objects, e.g. `guest_1`..`guest_8`, exists at boot. Each has `home = $nowhere` and `parent = $guest`. When a client presents `auth { token: "guest:<random>" }`, `allocateGuest` assigns one of the unbound guest objects to the new session. The pool refills as sessions are reaped: `$guest:on_disfunc` resets the guest's state and returns it to the free pool via `$system:return_guest(this)` (identity.md §I6.4).

For the demo, 8 guests is enough for a small cohort. Real worlds would mint guests on demand or scale the pool to expected concurrent traffic. Each guest's description states that it is a pre-seeded temporary player and exists to give local users or agents a stable first-light actor.

Allocation uses an explicit free pool, **not** "any guest with no live session" — the latter is what the v0.5 impl does and what causes pool exhaustion across restarts (every guest looks bound because its session record persisted past the dead connection). The free pool is in-memory and rebuilt at boot from "guests with no session in the session table."

---

## B8. Verb bodies

The seeded verbs above are implemented as T0 bytecode. Concrete JSON bytecode for the load-bearing ones is in [tiny-vm.md "Concrete fixtures"](tiny-vm.md#concrete-fixtures). Verbs not in the fixture list have straightforward bodies that follow the same pattern: read args, read/write properties, emit observation, return.

---

## B9. Idempotent rebooting

Every step of the boot sequence checks the Directory's corename map first; if the corename already maps to a ULID, the seed is skipped. This means:

- A fresh world creates everything.
- A restarted world finds everything already present and changes nothing.
- A partial-boot failure (server crashed mid-seed) recovers by re-running boot — only the missing seeds are created.

Wizards can run boot manually via a `wiz:rebuild_seeds()` verb; this fills any missing corenames without disturbing existing objects.
