# LambdaMOO editors: notes, verbs, mail, lists

Source: live source reads on 2026-05-02. Five editor objects rooted at
`$generic_editor (#5400)`.

## Class graph

```
generic room
  └── $generic_editor #5400  "Generic Editor"
        ├── $note_editor #5599  "Note Editor"
        ├── $verb_editor #5443  "Verb Editor"
        ├── $mail_editor #5746  "Mail Room"          ← legacy "Mail Room"
        └── $list_editor #11466 "List Editor"
```

The headline observation: **editors are rooms**. `$generic_editor` extends
`generic room`, so an "editor session" is literally being inside the editor
as a $room. No modal UI framework — the regular MOO dispatcher (`look`,
verb resolution by location, `moveto`) carries all of it.

## The conceit: editor as room

When you run `@notedit foo`:

```moo
// $player:@notedit
$note_editor:invoke(dobjstr, verb);
```

`$generic_editor:invoke` (paraphrased):

1. Permission check (only the editor itself, the player, or someone who
   `$perm_utils:controls(caller_perms(), player)` can send a player in).
2. If the player already has a session in progress AND it's been changed,
   prompt: *"You are working on X. Do you wish to delete that session?"*
3. `:parse_invoke(args)` validates and translates the request to a
   *spec* (per-editor — what to load).
4. If `me:edit_option("local")` is set and the editor supports local
   editing, call `:invoke_local_editor(...)` (MCP escape, see §6).
5. Otherwise `:suck_in(player)` → `player:moveto(this)`.
6. `:init_session(who, @spec)` initialises per-session state.

You are now in the editor-room. All editor commands are verbs on the
editor object, which match because you're located there.

`pause` / `quit` runs `:exitfunc` which sends you back to your previous
location *without* killing the session. `done` / `compile` / `send` /
`save` finalises (per editor) and exits. `abort` kills and exits.

## The session table

The editor stores sessions in **parallel-indexed lists**:

```
this.active     = {player1, player2, ...}   // who has a session, in order
this.original   = {obj1, obj2, ...}         // what each player started from
this.times      = {t1, t2, ...}             // when they started
this.texts      = {lines1, lines2, ...}     // working text per session
this.changes    = {flag1, flag2, ...}       // dirty flag per session
this.inserting  = {mode1, mode2, ...}       // insert-mode flag
this.stateprops = {...}                      // names of additional per-session props
```

`who = player in this.active` is the index. Each per-editor specialization
appends its own state-properties to `.stateprops`, and they're parallel
arrays too.

`:new_session(who_obj, from)` extends every parallel list by one. `:kill_session(who)`
removes index `who` from each. `:reset_session(who)` clears text/changes
back to "fresh" without losing the slot.

Two-session-per-player is *not allowed*. Re-invoking with an unsaved
session prompts to discard.

## Editor commands (base)

From `$generic_editor:commands`:

| Command | Effect |
| --- | --- |
| `say` / `"` | Say a line to the room (editor-as-room, others editing get to chat) |
| `emote` / `:` | Emote |
| `enter` / `view` | Show the buffer |
| `lis*t` | List with line numbers and ranges |
| `ins*ert` / `n*ext` / `p*revious` / `.` | Move insertion point; `.` is shortcut for "append" |
| `del*ete` | Delete a range |
| `f*ind` | Search |
| `m*ove` / `c*opy` | Move/copy ranges |
| `join` | Join lines |
| `fill` | Reflow |
| `subst` | Substitute (regexp variant available) |
| `y*ank` | Yank (paste from kill ring) |
| `w*hat` | What am I editing? |
| `done` / `q*uit` / `pause` | Finish or leave |
| `abort` | Discard and leave |

`@flush`, `@stateprop`, `@rmstateprop` are wizard maintenance for the
session table.

## Per-editor specializations

### Note Editor (`$note_editor`)

Adds `save` (writes back to wherever the text came from) and parses two
input shapes in `:invoke`:

- `@notedit <note>` — edits `<note>.text` (the $note's text property).
- `@notedit <obj>.<prop>` — edits any list-of-strings property on any
  object you have write access to.

This is why the same editor handles room descriptions, sign text, mail
list `.description`s, and player `description` properties — they're all
list-of-strings, addressable as `obj.prop`. The editor abstracts over
"thing with text".

### Verb Editor (`$verb_editor`)

Adds `compile` (the actual MOO compile + verb-source replace) and `edit`.
Parses `@edit obj:verb`. On `compile`, validates the source, calls
`set_verb_code(obj, verb-name, lines)`, reports compile errors back into
the editor session.

### Mail Editor (`$mail_editor` aka **"Mail Room"**)

The biggest specialization. Adds 32 verbs covering full mail-composition:

| Command | Effect |
| --- | --- |
| `to:` `<recipients>` | Set To header |
| `also-to:` / `cc:` `<more>` | Add CCs |
| `not-to:` / `uncc:` | Remove |
| `reply-to:` / `replyto:` | Set Reply-To |
| `subj:` / `subject:` | Set Subject |
| `send` | Send and exit |
| `who` | Who's currently in the Mail Room |
| `showlists` | Show available mailing lists |
| `subsc*ribe` | **The legacy "Mail Room subscribe"** — adds you to a list's `.mail_forward`, so each new arrival is *copied into your personal inbox*. |
| `unsubsc*ribe` | Reverse |

So "Mail Room" *is* this editor. The legacy `subscribe` command requires
you to be inside a mail-composition session. Modern `@subscribe` from
anywhere only adds to `.mail_notify` (heads-up only). The functional
difference is forwarding-vs-notification.

### List Editor (`$list_editor`)

Generic list-of-anything editor. Used for editing properties whose value
is a list, where the list elements are not strings. Less commonly invoked.

## Lifecycle, end-to-end

```
@notedit poster
        ↓
$note_editor:invoke("poster", "@notedit")
        ↓
:parse_invoke matches "poster" → finds $welcome_poster, validates write access
        ↓
edit_option("local") set?  ─yes─→  invoke_local_editor (MCP, §6)
        ↓ no
:suck_in(player)
   → player:moveto($note_editor)
        ↓
:enterfunc
   → "You are working on the text of poster (#2645)."
:init_session
   → loads poster.text into texts[who], inserting=1, changes=0
        ↓
< player runs editor commands: insert, delete, fill, subst, etc. >
< say/emote works too — it really is a room with other editors >
        ↓
done
   → :save (note-editor specialisation)
   → poster:set_text(texts[who])     // write back
   → "Saved."
   → :kill_session(who)
   → :exitfunc
   → player:moveto(player.previous_location)
        ↓
back in your previous room
```

## Local-editor escape (MCP-other)

```moo
// $generic_editor:invoke, line ~39
if (player:edit_option("local")
    && $object_utils:has_verb(this, "local_editing_info")
    && (info = this:local_editing_info(@spec)))
  this:invoke_local_editor(@info);
```

If the player's `.edit_options` includes `"local"` and the editor has a
`:local_editing_info` verb, the editor doesn't teleport you in. Instead
it ships the buffer to the player's actual client (Emacs/mooedit/mooreed)
via the **MOO Client Protocol** — the in-band `#$#`-prefixed out-of-band
mechanism. When the client saves, the buffer comes back over MCP and is
compiled / saved as if the editor commands had been used.

This is the same MCP we explicitly chose **not** to use for moo-mcp's
framing in the very first session. Worth noting: a smart MOO client
already speaks MCP for editor handoff; if we ever want a richer integration
(real-time room-event subscription, edit-in-place, etc.) the protocol is
already there waiting.

So the same authoring path works for telnet users (in-MOO editor) and
full GUI clients (their own editor). The decision is per-player, made at
`:invoke` time.

## Two consequences worth filing

1. **Anyone can chat with their editor neighbours.** Several people may
   simultaneously be in `$verb_editor` working on different verbs;
   `say "hi"` actually says it in the editor-room and they hear it. The
   "Verb Editor" is a real shared space. (`who` lists the other people
   in their own sessions, "what are you working on" doesn't exist —
   sessions are private at the data level, but co-presence is open.)

2. **Editor sessions survive disconnects.** `pause` and `quit` only
   `:exitfunc` you out of the room; they don't kill the session. The
   editor flushes old sessions periodically (`@flush`), but for a long
   chunk of time after disconnect you can reconnect and resume mid-edit.
   So crash-during-edit is recoverable for short durations.

## Open questions

- The exact `@flush` policy: how long do sessions persist?
- `$list_editor` use cases — what kind of property is a list-of-non-strings
  that needs interactive editing? Mail-list option lists?
- The local-editor MCP handshake details: what verbs does the client
  need to implement? `:invoke_local_editor` would tell us.
- How does the verb editor handle compile errors that affect later
  lines? Re-prompt with the cursor at the error?

## Cross-references

- `lambdamoo-mail-and-boards.md` — the mail substrate this editor writes into.
- `lambdamoo-help-system.md` — `editors` topic in the help DB; how the help itself is edited (via `@notedit $help.<topic>`).
- `lambdamoo-living-room-map.md` — editors as rooms is the same dispatch
  pattern that powers e.g. the Hot Tub's button-pushing or the Coat
  Closet's `open door`.
