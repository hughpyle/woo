# Pinboard Demo

A shared spatial note board mounted in the chat world. People and agents use it
to coordinate by placing, editing, and moving text notes on a persistent board.

## Goal

Show that a Woo object can be both:

- a visible thing in a room; and
- its own `$space` with an independent UI, presence/minimap overview,
  sequenced state, and agent tools.

This is the next coordination test after chat and taskspace. It should feel less
procedural than taskspace and more object-like than a global app tab.

## Model

`$pinboard < $space`

`the_pinboard` is a located object, mounted on the wall of `the_deck`.

Notes are **not objects**. They are lightweight value records stored on the
pinboard. This is deliberately different from taskspace: tasks are structured
objects with identity, hierarchy, and per-task verbs; notes are board-local data.

```json
{
  "id": "n1",
  "text": "Bring the towel to the hot tub",
  "color": "yellow",
  "x": 120,
  "y": 80,
  "w": 180,
  "h": 90,
  "z": 3,
  "author": "guest_2",
  "updated_by": "guest_5",
  "created_at": 123,
  "updated_at": 456
}
```

The board is the object and the coordination space. The notes are board-local
data.

## Located Space Semantics

The pinboard pushes on an important general rule:

A `$space` may also be a located object. What its location means is defined by
object behavior and the containing chat world, not by a special core property.

The core only needs ordinary object composition:

- `location` places `the_pinboard` in `the_deck.contents`.
- `look` in the Deck renders it as a visible object.
- `enter` on the pinboard adds actor presence to the pinboard itself.
- note mutations are sequenced through the pinboard.
- pinboard verbs may emit room-visible observations to the Deck when that makes
  sense.

No `room_coupling` or policy field is needed. This follows the LambdaMOO style:
rooms, enterable objects, vehicles, and distant/adjacent spaces define their
relationship to surrounding rooms through verbs.

## Presence

There are two overlapping presences:

- **Deck presence**: the actor is physically/socially in the Deck.
- **Pinboard presence**: the actor is focused into the pinboard UI and is
  manipulating notes.

An actor may have both:

```json
presence_in: ["the_deck", "the_pinboard"]
```

The board UI shows pinboard presence. People in the Deck do not see "guest is
inside the pinboard" as a location change; they see board activity such as:

> Guest 2 moves a note on the pinboard.

Entering the pinboard is an interaction/focus act, not physical travel away from
the Deck.

## State

Persistent pinboard state:

- `notes`: list of note records.
- `next_note_id`: integer counter for board-local ids.
- optional `palette`: permitted color names.
- optional `viewport`: default UI bounds.

Each note record has:

- `id`: board-local string.
- `text`: plain text only.
- `color`: small enum of color names.
- `x`, `y`: board coordinates.
- `w`, `h`: note dimensions.
- `z`: stacking order.
- `author`, `updated_by`.
- `created_at`, `updated_at`.

No rich text, attachments, alarms, votes, unread state, per-note permissions, or
note objects in the first version.

## Calls

Sequenced through `the_pinboard`:

- `pinboard:add_note(text, color?, x?, y?, w?, h?)`
- `pinboard:move_note(id, x, y)`
- `pinboard:resize_note(id, w, h)`
- `pinboard:edit_note(id, text)`
- `pinboard:set_note_color(id, color)`
- `pinboard:delete_note(id)`
- `pinboard:clear_notes()` wizard-only or omitted from the demo UI

Direct/read:

- `pinboard:list_notes()`
- `pinboard:look_self()`
- `pinboard:enter()`
- `pinboard:leave()`

`enter` and `leave` are direct presence operations, following chat room practice.
Note mutations are sequenced because they are durable shared board state.

## Observations

Sequenced observations, replayable from the pinboard log:

| Type | Payload |
|---|---|
| `note_added` | `{source, actor, note}` |
| `note_moved` | `{source, actor, id, x, y, z?}` |
| `note_resized` | `{source, actor, id, w, h}` |
| `note_edited` | `{source, actor, id, text}` |
| `note_color_changed` | `{source, actor, id, color}` |
| `note_deleted` | `{source, actor, id}` |

Direct/live pinboard observations:

| Type | Payload |
|---|---|
| `pinboard_entered` | `{source, actor}` |
| `pinboard_left` | `{source, actor}` |
| `pinboard_viewport` | `{source, actor, board, x, y, w, h, scale}` |

`pinboard_viewport` is transient presence, not durable board state. It reports
the actor's visible board-space rectangle so the presence overview can show
where each participant is looking. The overview marker disappears when the
actor leaves the pinboard.

Room-visible observations are object behavior, not core policy. The first
pinboard should emit a small live summary to the Deck for visible manipulations:

| Type | Payload |
|---|---|
| `pinboard_activity` | `{source: mounted room, board, actor, text}` |

The UI must render pinboard state from board observations/state, not from the
room summary text.

## UI

Standalone pinboard UI:

- Opens against a target pinboard object.
- Calls `enter` on mount and `leave` on unmount when possible.
- Shows active board participants through a minimap-style presence overview.
- Renders note records as draggable/resizable rectangles on a board canvas.
- Keeps the main board canvas focused on notes; it does not render participant
  viewport overlays there.
- Renders the presence overview as a zoomed-out board map: notes are small
  colored rectangles, participant viewports are translucent rectangles, hovering
  a viewport identifies the actor, and clicking the overview recenters the main
  board view with SISO animation.
- Supports adding plain text notes.
- Supports editing text, color, position, size, and deletion.
- Sends drag/resize commits as sequenced calls.
- Sends viewport previews as direct calls; the durable note position changes
  only on sequenced commit.

The board should be usable without chat. Chat sees the board as an object;
pinboard UI sees the board as the primary world.

## Agent Surface

MCP/tools expose the same verbs as the UI:

- `the_pinboard__enter`
- `the_pinboard__leave`
- `the_pinboard__list_notes`
- `the_pinboard__add_note`
- `the_pinboard__move_note`
- `the_pinboard__resize_note`
- `the_pinboard__edit_note`
- `the_pinboard__set_note_color`
- `the_pinboard__delete_note`

Agents should be able to coordinate entirely through notes:

1. inspect the board;
2. add their own notes;
3. move notes into rough spatial groupings;
4. update notes as they act in the room world;
5. leave a final summary note.

## Demo Scenario

The Deck has a pinboard on the wall. The hot tub is within the Deck and is
enterable from it.

Coordination test:

1. Three actors join the Deck and enter the pinboard UI.
2. They create notes for hot-tub setup: towel, mug, lamp, hot tub status.
3. They arrange notes spatially into informal areas such as "find", "bring",
   and "done" without a formal workflow engine.
4. Actors move through the chat world, take/drop objects, and update notes.
5. The final board state is legible to a human and discoverable to an agent via
   `list_notes`.

This should prove:

- nested/overlaid presence (`the_deck` and `the_pinboard`);
- room-visible object activity without a coupling flag;
- durable shared spatial state;
- a standalone object UI;
- an agent-readable coordination surface;
- note records as lightweight values rather than objects.

## Scope Cuts

Out of scope for the first pinboard:

- rich text;
- markdown rendering;
- attachments;
- images;
- links as first-class artifact refs;
- note-level ACLs;
- locking;
- alarms;
- voting/polls;
- unread state;
- board templates;
- multi-board search;
- CRDT editing inside a note.

Text notes are enough. The hard part is the object/space/UI/presence shape.
