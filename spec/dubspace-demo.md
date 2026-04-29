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
- One eight-step percussion loop.
- One saved scene.

## Persistent State

- Loaded loop per slot.
- Playing/stopped state per slot.
- Channel gain.
- Filter cutoff.
- Delay send, time, feedback, and wet level.
- Percussion transport (`playing`, `started_at`), tempo, and eight-step pattern.
- Scene name and saved control values.

## Live Slider Previews

Slider motion has two layers — two routes for the same control surface:

- **Preview** (direct call): while a player drags a slider, the client calls a direct verb, `the_dubspace:preview_control(target, name, value)`. The verb body emits a `gesture_progress` observation; per [events.md §12.6](semantics/events.md#126-observation-durability-follows-invocation-route), the observation is live-only because the call is direct. Not sequenced, not logged, not replayed.
- **Commit** (sequenced): when the drag ends, the client sends `$space:call({verb: "set_control", args: [target, name, value]})`. The value becomes materialized persistent state and is replayable.

The preview layer exists so continuous gestures feel live without filling the `$space` log with every pointer sample. It is the same control surface called via a different route, not a second source of truth.

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
| `drum_step_changed` | `{target: obj, voice: str, step: int, enabled: bool}` | `:set_drum_step` applied. |
| `tempo_changed` | `{target: obj, bpm: int}` | `:set_tempo` applied. |
| `transport_started` | `{target: obj, started_at: int, bpm: int}` | `:start_transport` applied. |
| `transport_stopped` | `{target: obj}` | `:stop_transport` applied. |
| `gesture_progress` | `{actor: obj, target: obj, name: str, value: any}` | Direct call: in-flight slider drag preview. Live-only. |
| `cursor` | `{actor: obj, x: float, y: float}` | Direct call: pointer position. Live-only. |

All observations include `type` (the table key) and `source` (the dubspace itself, unless noted otherwise). Observations from sequenced verbs (`:set_control`, `:start_loop`, etc.) become part of the resulting applied frame and are replayable. Observations from direct verbs (`:preview_control`, `:cursor`) are live-only — see [events.md §12.6](semantics/events.md#126-observation-durability-follows-invocation-route).

## Live Events

- Player joined or left.
- Loop started or stopped.
- Control changed.
- Percussion step, tempo, and transport changed.
- Gesture began, moved, ended.
- Scene saved or recalled.

Gesture previews go through direct calls (live-only); gesture commits that affect the shared mix go through `$space:call` (sequenced). Pure UI presence hints stay direct. The latest committed control values are persistent materialized state.

## Minimal Interactions

- Start or stop a loop.
- Drag a knob or fader and see/hear the shared change.
- Toggle an 8-step percussion pattern and start/stop the shared transport.
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
