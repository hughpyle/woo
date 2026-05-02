# Pinboard v0.2 — redesign onto $note

> Draft. Replaces the v0.1 model where notes were inline records inside
> `pinboard.notes`. The v0.2 model lifts notes to first-class movable
> objects (`$pin < $note`) and reduces the board to a $space-shaped
> directory with per-pin layout.

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
| `palette` | `$pinboard` | Allowed colors when `add_note` accepts a color. |
| `viewport` | `$pinboard` | Default viewport dimensions for clients. |
| `mount_room` | `$pinboard` | Optional room that hosts this pinboard for room-level activity events. |

## Verbs

### Pin (`$pin`)

Inherits everything from `$note` (`read`, `write`, `set_text`, `erase`,
`is_readable_by`, `is_writable_by`, `look`). Adds:

- `set_color(color)` — write `.color`. `null` clears (frontend renders white).
  Permission: `:is_writable_by(actor)`.

### Pinboard (`$pinboard`)

| Verb | Purpose |
| --- | --- |
| `look` / `look_self` | Standard space look surface; returns the joined view (pins + layout + presence). |
| `enter` / `leave` | Subscribe/unsubscribe from incremental observations. |
| `viewport(x, y, w, h, scale)` | Frontend telemetry for client-side panning/zoom. |
| `list_notes` | Returns `[{ id, name, text, color, owner, x, y, w, h, z }]` joining contents + layout. |
| `acceptable(object)` | Returns `isa(object, $note)`. Gates `:moveto` into the board. |
| `enterfunc(object)` | Called by core when a note arrives. Allocates default layout if missing; fires `pin_added`. |
| `exitfunc(object)` | Called when a note leaves. Removes its layout entry; fires `pin_removed`. |
| `post(pin)` | Convenience: `move(pin, this)` after the type check. Same effect as `pin:moveto(this)`. |
| `take(pin)` | Move pin to the actor's inventory. **Note-controller-only**: pin author or wizard. Board owners use `:eject` for curation; this verb does not grant board-owner authority. |
| `eject(pin)` | Move pin to the actor's inventory. **Curator path**: board owner or wizard only. Use this to remove someone else's pin from your board. |
| `move_pin(pin, x, y)` | Update layout. Brings the pin to top z. |
| `resize_pin(pin, w, h)` | Update layout. |
| `add_note(text, color?, x?, y?, w?, h?)` | Composite: `create($pin) + set_text + post + apply layout`. Backwards-compatible entry point. |

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
   ↓ pin:set_text(["Buy groceries"])
   ↓ pin:set_color("yellow")
   ↓ board:post(pin)              moves pin into board.contents
        :acceptable(pin)         → isa $note? yes
        moveto via core
        board:enterfunc(pin)     → allocate layout, fire pin_added
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

## Required core changes (must land before pinboard v0.2)

### 1. The `moveto` hook pipeline

The biggest dependency. Today's `move(obj, target)` is the authoring
primitive: it routes through `moveAuthoredObjectChecked` and requires
programmer ownership or wizard authority. That's wrong for the
LambdaMOO board pattern, where `note:moveto(board)` triggers the
*receiver-driven* hook chain regardless of who owns the note.

Proposed shape:

```
moveto(obj, target)               new VM builtin (user-level move path)
  ↓
obj:moveto(target)                virtual; default impl on $thing/$portable
  ↓
target:acceptable(obj)            gate (must return truthy or E_PERM)
  ↓
obj.location:exitfunc(obj)        prior container's hook (if defined)
  ↓
core: actually move (cross-host check, no programmer/wizard required)
  ↓
target:enterfunc(obj)             new container's hook (if defined)
```

`move()` stays as the trusted-authoring forced-move primitive; `moveto()`
is the hook-respecting user-level path. They have distinct authority
models — analogous to `move_object` vs `room_take`/`room_drop` in chat.

Authority on `moveto`: the caller must control `obj` (owner/wizard) **or**
the move is initiated by a verb running with appropriate perms (e.g. the
board's `:post` calling `move(pin, this)` from a wizard-owned verb). The
`:acceptable` check on the receiver is the policy point.

Roughly ~150 lines in `world.ts` plus the builtin wiring plus tests for
accept/reject/enter/exit. This is the next standalone deliverable.

### 2. The `isa(obj, ancestor)` builtin

For `:acceptable`'s type filter:

```ts
// tiny-vm.ts builtins:
case "isa": {
  if (builtinArgs.length !== 2) throw wooError("E_INVARG", "isa expects object and ancestor");
  return frame.ctx.world.isDescendantOf(assertObj(builtinArgs[0]), assertObj(builtinArgs[1]));
}
```

Plus `"isa"` in `BUILTIN_NAMES` in tiny-vm.ts, dsl-compiler.ts, and
authoring.ts. ~5 lines total. Generally useful — any future `:acceptable`
verb wants it.

### 3. `create()` accepting options (or routing through builder)

`add_note` wants `create($pin, { name, description, location })`, but the
current VM `create` builtin only accepts `(parent, owner?)`. Either
extend `create` to accept an options map (mirroring `builder_create_object`),
or route `add_note` through the builder surface (which constrains it to
actors inheriting `$builder`). The latter is the cheaper path; the
former is more LambdaMOO-shaped.

## Migration from v0.1

Per existing `$pinboard` instance:

1. Read `.notes` (the v0.1 list-of-maps).
2. For each entry:
   - `create($pin)` with `owner = entry.author`, `name = "sticky note"`.
   - `pin.text = [entry.text]` (split on `\n` if multi-line is needed).
   - `pin.color = entry.color`.
   - `pin.created_at = entry.created_at` (or skip; less critical).
   - `move(pin, board)` — this triggers `:enterfunc` which allocates default layout.
   - Override the layout entry with `{ x: entry.x, y: entry.y, w: entry.w, h: entry.h, z: entry.z }`.
3. Clear `.notes`, `.next_note_id` (now unused).

The catalog-update-lifecycle infrastructure (`spec/discovery/catalogs.md
§CT4`) already handles version-bump migrations. Concrete steps:

```json
"migrations": [
  {
    "from": "0.1.0",
    "to": "0.2.0",
    "steps": [
      { "kind": "rewrite_property", "class": "$pinboard", "from": "notes", "to_pins": true },
      { "kind": "remove_property", "class": "$pinboard", "name": "notes" },
      { "kind": "remove_property", "class": "$pinboard", "name": "next_note_id" }
    ]
  }
]
```

The `rewrite_property` step kind is new; needs an installer extension. If
that's too much for one bump, a TS-side one-time migration script in
`scripts/` would also work and is simpler for v0.2.

## Frontend implications

- `list_notes` shape is unchanged on the wire (still
  `[{ id, text, color, x, y, w, h, z, author? }]` — minor field renames),
  so existing pinboard SPA can stay close.
- `pin.color = null` displays white. Existing palette dropdown sends
  `null` for "no color" or the chosen string.
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
