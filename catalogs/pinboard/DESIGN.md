# Pinboard Demo

The v0.2 model lifts notes to first-class movable objects (`$pin < $note`)
and reduces the board to a $space-shaped directory with per-pin layout.

## Why redesign

LambdaMOO's bulletin-board pattern (notes as first-class `$thing`s, board
as a `$thing`-container with an acceptable filter and an audit-log)
generalizes cleanly. v0.1 had to reinvent every primitive — note ids,
take/move/edit semantics, permissions, observations — inside the board's
own verbs. v0.2 inherits all of that from `$portable`, `$note`, and
`$space`.

## Class graph

Two independent inheritance trees, each rooted under `$thing`:

```
$thing
  ├── $portable               (catalogs/chat)
  │     └── $note             (catalogs/note)
  │           └── $pin        (catalogs/pinboard, adds .color)
  └── $space                  (core)
        └── $pinboard         (catalogs/pinboard)
                              .contents holds $note descendants
                              .layout map keyed by pin obj id
                              .palette / .viewport
                              presence semantics from $space
```

`$pinboard` is not a subclass of any "physical board" abstraction — it
behaves like one because the chat surface (look/enter/leave/say/page)
applies wherever `$space` descendants live. The board reads as physical
because it shares those verbs, not because of cross-tree inheritance.

## Data shapes

| Property | On | Purpose |
| --- | --- | --- |
| `text` | `$note` (inherited) | The actual content. List of strings. |
| `writers` | `$note` (inherited) | Who else can edit besides owner. |
| `color` | `$pin` | `null` or a string. Frontend renders white when null. |
| `contents` | `$pinboard` (built-in) | Pins currently on the board. |
| `layout` | `$pinboard` | Map keyed by pin obj id → `{x, y, w, h, z}`. |
| `next_z` | `$pinboard` | Z-index counter for stacking. |
| `palette` | `$pinboard` | Allowed colors when `add_note` accepts a color. `white` is accepted as UI shorthand for `null`, not stored. |
| `viewport` | `$pinboard` | Default viewport dimensions for clients. |
| `mount_room` | `$pinboard` | Optional room that hosts this pinboard for room-level activity events. |

## Verbs

### Pin (`$pin`)

Inherits everything from `$note` (`read`, `write`, `set_text`, `erase`,
`is_readable_by`, `is_writable_by`, `look`). Adds:

- `set_color(color)` — write `.color`. `null` clears (frontend renders white);
  `"white"` is normalized to `null`.
  Permission: `:is_writable_by(actor)`.

### Pinboard (`$pinboard`)

| Verb | Purpose |
| --- | --- |
| `look` / `look_self` | Standard space look surface; returns the joined view (pins + layout + presence). |
| `enter` / `leave` | Subscribe/unsubscribe from incremental observations. |
| `viewport(x, y, w, h, scale)` | Frontend telemetry for client-side panning/zoom. |
| `list_notes` | Returns `[{ id, name, text, color, owner, writers, x, y, w, h, z }]` joining contents + layout. |
| `acceptable(object)` | Returns `isa(object, $note)`. Gates `:moveto` into the board. |
| `enterfunc(object)` | Called by core when a note arrives. Allocates default layout if missing; fires `pin_added`. |
| `exitfunc(object)` | Called when a note leaves. Removes its layout entry; fires `pin_removed`. |
| `post(pin)` | Convenience: `moveto(pin, this)` after the type check. Same effect as `pin:moveto(this)`. |
| `take(pin)` | Move pin to the actor's inventory. **Note-controller-only**: pin author or wizard. Board owners use `:eject` for curation; this verb does not grant board-owner authority. |
| `eject(pin)` | Move pin to the actor's inventory. **Curator path**: board owner or wizard only. Use this to remove someone else's pin from your board. |
| `move_pin(pin, x, y)` | Update layout. Brings the pin to top z. |
| `resize_pin(pin, w, h)` | Update layout. |
| `add_note(text, color?, x?, y?, w?, h?)` | Composite: `create($pin) + post + set_text + optional set_color + apply layout`. Backwards-compatible entry point. |

## Permissions story

Properties:

- `$note.text` is `perms: ""` — direct property reads denied. The public
  API is the `:text()` verb, which gates via `:is_readable_by(actor)`.
  Subclasses (e.g. `$encrypted_note`) override the gate. This is the
  LambdaCore convention: text moves through a permission-checked verb,
  never via property access.
- `$pin.color`, `$pinboard.layout`, `$pinboard.next_z` are `perms: "r"`
  — public read, owner+wizard write only. All mutations route through
  verbs (`:set_color`, `:move_pin`, `:resize_pin`, `:enterfunc`,
  `:exitfunc`); no direct-write footguns.
- `$note.writers`, `$pinboard.palette/viewport/mount_room` are `perms: "r"`.

Verbs:

- **Editing pin text**: `:is_writable_by(actor)` → owner / writers /
  wizard.
- **Recoloring a pin**: same as editing (writes via `:set_color`).
- **Posting a pin onto a board**: anyone present at the board. The
  `:acceptable` filter is type-only (`isa(obj, $note)`).
- **Taking your own pin off (`:take`)**: pin author or wizard. Board
  owner does NOT use `:take` for someone else's pin — they use `:eject`.
  This mirrors LambdaMOO's split: `take` is the controller-only path,
  `eject` is the curator path.
- **Ejecting someone else's pin (`:eject`)**: board owner or wizard.
- **Moving / resizing a pin's layout**: anyone present (it's spatial
  rearrangement, not content). Could tighten if needed.

## Lifecycle

```
create $pin
   ↓ board:post(pin)              moves pin into board.contents
        :acceptable(pin)         → isa $note? yes
        moveto via core
        board:enterfunc(pin)     → allocate layout, fire pin_added
   ↓ pin:set_text(["Buy groceries"])
   ↓ pin:set_color("yellow")
   ⋮
   board:move_pin(pin, 200, 150)  update layout, fire pin_moved
   ⋮
   board:take(pin)                check perms, moveto pin → actor
        board:exitfunc(pin)      → remove layout entry, fire pin_removed
   pin is now in actor.contents
   ⋮
   actor can:
     drop pin                     (in current room — needs $portable, which $note inherits)
     post pin on another_board    moveto pin → another_board
     @recycle pin                 if author or wizard
```

## Core dependencies

Pinboard v0.2 depends on three platform primitives that now exist in v0:

- `moveto(obj, target)` is the hook-respecting user move path. It runs the
  receiver's `:acceptable`, old container `:exitfunc`, and new container
  `:enterfunc`.
- `isa(obj, ancestor)` lets `:acceptable` filter by class without naming
  catalog internals in core.
- `create(parent, options)` accepts an options map with `owner`, `name`,
  `description`, `aliases`, `location`, `fertile`, and `recyclable`.

## Migration from v0.1

Bundled deployments run a one-time local boot migration:

1. Reconcile the pinboard catalog to install `$pin`, the new `$pinboard`
   properties, and the v0.2 verbs.
2. For each existing board, read legacy `.notes` records.
3. Create a `$pin` for each record, owned by the record author when that
   actor still exists and otherwise by the board owner.
4. Copy text, color, and layout into the new pin/layout shape.
5. Delete legacy `.notes` and `.next_note_id` instance overrides.

Remote tap installs should eventually express the same transformation as a
catalog migration step; the bundled catalog uses TS-side boot migration because
this is a one-time local state repair.

## Frontend implications

- `list_notes` shape is unchanged on the wire (still
  `[{ id, text, color, x, y, w, h, z, author? }]` — minor field renames),
  so existing pinboard SPA can stay close.
- `pin.color = null` displays white. Existing palette dropdown may send
  `"white"` for the white swatch; the verb stores it as `null`.
- New observations: `pin_added`, `pin_removed`, `pin_moved`, `pin_resized`,
  `pin_recolored`. The umbrella `pinboard_activity` is still emitted for
  room-level summaries.

## What's not in v0.2

- **Encryption** on pins. Comes with `$encrypted_note < $note` later.
- **`@notedit pin`** — needs the editor-rooms work.
- **Voting pins, ephemeral pins, timestamped pins** — these become trivial
  `$pin` subclasses once people want them. None are in v0.2.

## Open questions

- Multi-line pin text. v0.1's single-line model becomes a list-of-strings
  via `$note.text`. Frontend needs to render multi-line.
- Should `move_pin` and `resize_pin` require board-presence (`enter`)?
  v0.1 didn't. Probably fine.
- Auto-recycle on `:eject` instead of moving to actor inventory? The
  ejecting actor may not want a stranger's pin in their inventory.
  Possibly: eject moves to a "trash" container per-board with a TTL.
