# Dubspace Demo

The first working Woo demo is a tiny collaborative dub mix space: a shared,
persistent control surface for live sound gestures.

## Goal

Show that Woo can host a mutable, multi-user world whose primary interface is
UI and sound, not chat.

## Core Requirement

The demo runs inside one minimal `$space`. The `$space` does only one thing:
accept calls/messages and assign them monotonically increasing sequence
numbers.

All coordinated mutations in the demo are caused by sequenced messages. Current
mix state is the materialized result of applying those messages, plus snapshots
for fast reload. No world-level clock is required for ordering.

## Surface

- One shared space.
- Two connected players.
- Four loop slots.
- One filter.
- One delay.
- One saved scene.

## Persistent State

- Loaded loop per slot.
- Playing/stopped state per slot.
- Channel gain.
- Filter cutoff.
- Delay send, time, feedback, and wet level.
- Scene name and saved control values.

## Observation Schemas

Each observation the dubspace emits has a defined payload shape. UI and agents consume these as the canonical contract.

| Observation | Payload | When emitted |
|---|---|---|
| `player_joined` | `{actor: obj}` | Actor binds presence to the dubspace. |
| `player_left` | `{actor: obj}` | Actor disconnects past the grace period or explicitly leaves. |
| `loop_started` | `{slot: obj, loop_id: str}` | `:start_loop` applied. |
| `loop_stopped` | `{slot: obj}` | `:stop_loop` applied. |
| `control_changed` | `{target: obj, name: str, value: any}` | `:set_control` applied. |
| `scene_saved` | `{scene: obj, name: str}` | `:save_scene` applied. |
| `scene_recalled` | `{scene: obj}` | `:recall_scene` applied. |
| `gesture_progress` | `{actor: obj, target: obj, value: any}` | **Ephemeral**: in-flight knob drag. |
| `cursor` | `{actor: obj, x: float, y: float}` | **Ephemeral**: pointer position. |

All observations include `type` (the table key) and `source` (the dubspace itself, unless noted otherwise). Persistent observations are sequenced; ephemeral observations follow [events.md §12.6](semantics/events.md#126-persistent-vs-ephemeral-events) and don't sequence.

## Live Events

- Player joined or left.
- Loop started or stopped.
- Control changed.
- Gesture began, moved, ended.
- Scene saved or recalled.

Gesture samples that affect the shared mix are sequenced messages. Pure UI
presence hints may stay ephemeral. The latest committed control values are
persistent materialized state.

## Minimal Interactions

- Start or stop a loop.
- Drag a knob or fader and see/hear the shared change.
- Save the current controls as one scene.
- Reload and recover the persisted mix state.

## Not In This Demo

- Chat interface.
- Rooms, inventory, or spatial navigation.
- User-authored code.
- Sample upload.
- Audio recording.
- Federation.
- Permissions beyond "connected players can perform."
