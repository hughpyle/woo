# Chat Demo

A canonical MOO surface — rooms, presence, talk, emote, tell — built as a feature-object composition rather than a `$space` subclass. Sits alongside dubspace/taskspace/IDE; can also embed inside them.

## Goal

Show that woo's MOO-shaped composition works in practice: chat behavior is a *feature*, not an inheritance, so any `$space` (a `$chatroom`, a `$taskspace`, a `$dubspace`) can opt into it by attaching `$conversational` to its `features` list.

This is the demo that retires the question "do feature objects pull their weight?" If the chat experiment composes cleanly with the other demos, the answer is yes.

## Surface

- Two or more actors connected to a shared room.
- Free-text input bar; output is a chronological text feed.
- Presence list visible.
- `:say`, `:emote`, `:tell` (directed), `:look`, `:who` callable from the input. The first installable slice lowers slash commands client-side; the full `$match:parse_command` pipeline remains the text-command target.
- Enter/exit notifications when actors join or leave.
- A "join taskspace as room" mode where the same chat client renders against `the_taskspace` instead of a standalone `$chatroom`. Same verbs, same observations.

## Call discipline

The chat verbs use the **direct live interaction** pattern from [core.md §C13](../../spec/semantics/core.md#c13-call-discipline). Each row classifies one verb across the two axes from [core.md §C12.1](../../spec/semantics/core.md#c121-two-orthogonal-axes); observation durability follows from the route automatically.

| Verb | Route | Mutation |
|---|---|---|
| `:say` / `:emote` | direct | none |
| `:tell` | direct | none — delivered only to recipient |
| `:look` / `:who` | direct (read) | none |
| `:enter` / `:leave` | direct | session/presence (persistent state on `$actor.presence_in` and `$space.subscribers`) |
| `:command` | direct dispatcher | currently lowers to `:say`; full `$match` dispatch is deferred |

Because every row routes directly, every observation these verbs emit is live-only by [events.md §12.6](../../spec/semantics/events.md#126-observation-durability-follows-invocation-route): pushed to subscribers, never stored. A late-joining client sees no scrollback. This matches MOO's `notify()` semantics.

**Why direct, not sequenced.** Real-time chat is fire-and-forget; replaying the log to reconstruct utterances would impose a coordinated-write cost on every message. The space's sequenced log remains for state mutations that *do* need replay (a taskspace's `:claim`, `:transition`); chat traffic flows past it.

> Being a `$space` does not mean every verb on the object is sequenced ([core.md §C12](../../spec/semantics/core.md#c12-direct-messages-vs-space-mediated-messages)). A `$chatroom` is a `$space` and a feature consumer; chat verbs run as direct calls and never enter the room's sequence log. Saying something does not advance `next_seq`.

**Logged variant (opt-in).** A world that wants auditable chat picks one of:

- **Sequenced via `$space:call`.** Authors call `$chatroom:call({verb: "say", args: ["hi"]})` instead of `$chatroom:say("hi")`. The call is now sequenced; the verb body's `emit` lands in the resulting `applied` frame's observations and is replay-visible per [events.md §12.6](../../spec/semantics/events.md#126-observation-durability-follows-invocation-route).
- **Sequenced via subclass override.** A `$chatroom_logged < $chatroom` overrides `:say` to call `this:append({type: "said", actor, text})` first, making utterances entries on the space's log even when the verb itself is invoked directly.

Either way is **application-level opt-in**, per the "logged social interaction" pattern. The default chat surface stays direct.

## The `$conversational` feature

A feature object (per [features.md](../../spec/semantics/features.md)) carrying the chat verbs. Attached to any `$space` that wants to act as a room.

| Verb | Args | Purpose |
|---|---|---|
| `:say(text)` | str | Public utterance. Emits `said {actor, text}` to subscribers (live; not stored). |
| `:emote(text)` | str | Third-person action. Emits `emoted {actor, text}`. |
| `:tell(recipient, text)` | obj, str | Directed message; emits `told {from: actor, to: recipient, text}` to recipient only. |
| `:look()` rxd | — | Returns `{description, present_actors}`. |
| `:who()` rxd | — | Returns the present-actor list. |
| `:enter(actor?)` | obj? | Adds actor (defaults `actor`) to subscribers and to its `presence_in`. Emits `entered {actor}`. |
| `:leave(actor?)` | obj? | Removes presence. Emits `left {actor}`. |
| `:command(text)` | str | Installable-source fallback: calls `this:say(text)`. The full free-text dispatcher remains the next `$match` milestone. |

The current manifest intentionally keeps `$conversational` source-only: these verbs compile during catalog install without trusted native implementation hints. That is the first platform proof. `$match` is still present as a scaffold, but full command parsing and feature-aware verb matching are deferred until the DSL/runtime exposes the necessary matching primitives.

Inside each verb body: `this` = the consumer space (the room being talked in), `definer` = the `$conversational` feature, `progr` = the feature's owner. Observations are emitted to `this.subscribers`, not to the feature's own subscribers (which would be empty).

## Observation schemas

`$conversational` declares schemas for each observation type so consumers (UIs, agents, conformance tests) have a contract on payload shape. Schemas describe shape only ([events.md §13](../../spec/semantics/events.md#13-schemas)); durability follows the route of the verb that emits each observation. All chat verbs are direct, so all observations below reach subscribers as live `event` frames, never as `applied` frames.

```woo
declare_event $conversational "said"    { source: obj, actor: obj, text: str };
declare_event $conversational "emoted"  { source: obj, actor: obj, text: str };
declare_event $conversational "told"    { source: obj, from:  obj, to:   obj, text: str };
declare_event $conversational "entered" { source: obj, actor: obj };
declare_event $conversational "left"    { source: obj, actor: obj };
declare_event $conversational "huh"     { source: obj, actor: obj, text: str, suggestion?: str };
```

| Type | Payload | Notes |
|---|---|---|
| `said` | `{source, actor, text}` | Public utterance. |
| `emoted` | `{source, actor, text}` | Third-person action. |
| `told` | `{source, from, to, text}` | Delivered only to `to`. |
| `entered` / `left` | `{source, actor}` | Presence transitions. |
| `huh` | `{source, actor, text, suggestion?}` | Unparseable input. |

Live observations flow over the wire as `op: "event"` frames ([wire.md §17.2](../../spec/protocol/wire.md#172-server--client)) or as SSE `event: event` entries; clients render them in the same chronological feed as applied frames but they are not part of `:replay` history.

## The chatroom class

A trivially small subclass of `$space`:

```
$chatroom < $space
  description: "A room for conversation."
  features: [$conversational]            // attached at boot
```

That's it. No new properties, no new verbs. The room's chat behavior comes entirely from the feature.

For embedded mode, `the_taskspace` (a `$taskspace`) gets the same feature attached at boot:

```
the_taskspace.features = [$conversational]
```

Now `the_taskspace:say("starting standup")` works. The utterance is a direct call, so the `said` observation is live-only — pushed to taskspace subscribers, separate from the taskspace's own sequenced log of task mutations.

## Renderer

A transient browser host that:

1. Authenticates as a `$player` (existing flow, [identity.md](../../spec/semantics/identity.md)).
2. Calls `target_room:enter()` to join.
3. Subscribes to the room's stream (`/api/objects/{room}/stream`).
4. Renders observations as text lines:
   - `said {actor, text}` → `actor.name says, "text"`
   - `emoted {actor, text}` → `actor.name text`
   - `told {from, text}` → `from.name tells you, "text"` (only delivered to recipient)
   - `entered/left` → `actor.name has entered/left.`
   - `huh {text}` → `I don't understand "text".`
5. Sends free-text input as `target_room:command(text)` calls.

Same client speaks against `$chatroom` and against `$taskspace` — the verb set is identical, the renderer doesn't care.

## $match interaction

Free-text input goes through `$match:parse_command(text, actor)` per [match.md §MA4](../../spec/semantics/match.md#ma4-command-parsing). `:command` then explicitly **lowers** the parsed `cmd` map into the right argument shape per verb — the parsed map is not the right call signature for `:say`, `:tell`, etc., so the dispatcher unpacks it:

```woo
verb $conversational:command(text) {
  let cmd = $match:parse_command(text, actor);

  // Built-in chat verbs: explicit lowering per signature.
  if (cmd.verb == "say") {
    return this:say(cmd.argstr);
  }
  if (cmd.verb == "emote") {
    return this:emote(cmd.argstr);
  }
  if (cmd.verb == "look") {
    return this:look();
  }
  if (cmd.verb == "who") {
    return this:who();
  }
  if (cmd.verb == "tell") {
    // Grammar: tell <recipient> <message...>
    // dobj resolves the recipient; the message is argstr after the recipient.
    if (cmd.dobj == $failed_match || cmd.dobj == $ambiguous_match) {
      return emit(actor, {type: "huh", source: this, actor, text});
    }
    let message = trim_prefix(cmd.argstr, cmd.dobjstr);
    return this:tell(cmd.dobj, message);
  }

  // Fall through: try to dispatch on the direct object using runtime lookup
  // (parent chain + features, per $match:match_verb).
  if (cmd.dobj != $failed_match && cmd.dobj != $ambiguous_match) {
    let v = $match:match_verb(cmd.verb, cmd.dobj);
    if (v != null) {
      // Pass cmd as the verb's single argument; verbs that take cmd-shaped
      // input opt into the parser convention by accepting it.
      return cmd.dobj:(cmd.verb)(cmd);
    }
  }

  emit(actor, {type: "huh", source: this, actor, text});
}
```

The explicit lowering matters because `:say(text: str)` and `:tell(recipient: obj, message: str)` are *typed* verb signatures, not parser-shaped. Verbs that *do* want the full parser map declare themselves accepting one (the `cmd.dobj:(cmd.verb)(cmd)` fallback path).

This is what stress-tests `$match`: a real chat surface using the parser end-to-end. Bugs in pattern matching, preposition handling, or feature-aware verb lookup surface as misrouted commands, observable in the demo.

## Embedded mode

The same chat client connecting to `the_taskspace` shows:
- The taskspace's chat (`said`, `emoted`, `entered`, `left` live observations).
- The taskspace's task-state changes (`task_created`, `status_changed`, etc.) as applied frames in the *same* feed.

Two streams, one timeline. The renderer distinguishes by observation type but renders both as text lines. This is what makes "chat embedded inside a workspace" not a separate UI mode — it's the same UI, with one extra feature attached.

## Scope cuts

Out of scope for this demo:

- Channels, multi-room navigation, exits, world geography.
- IRC-style modes/ops, kick/ban.
- Threading, replies, edits, reactions, typing indicators.
- Logged chat history, search, scrollback beyond the live session.
- Direct messages outside a room (DMs as a separate space).
- Spell correction, fuzzy matching beyond `$match`'s prefix rule.
- Voice or media. Text only.

Reserved as natural follow-ons:

- A logged `$chatroom_logged` variant that overrides `:say` to sequence through the log.
- `$exit` and room navigation (the canonical MOO geography pattern).
- A `$mail_recipient` feature for asynchronous messages between disconnected actors.

## Why this demo exists

Three reasons:

1. **Stress-test composition.** Feature objects are a load-bearing piece of MOO that woo just inherited. The chat demo proves they work, with concrete consumer classes (`$chatroom`, `$taskspace`) sharing one feature implementation.
2. **Brings `$match` into use.** The text-to-action pipeline scaffolded in [match.md](../../spec/semantics/match.md) gets exercised end-to-end. Bugs surface as misparsed commands.
3. **Agents talk to each other.** The motivation: agents coordinating via verbal exchanges in a room, possibly attached to their workflow's taskspace. Chat is the protocol; presence is the rendezvous.

Together with dubspace and taskspace, chat completes a triangle:
- Dubspace: low-latency, sensory, shared UI state.
- Taskspace: long-lived, inspectable, agent-friendly coordination state.
- Chat: live, social, presence-anchored conversation — the canonical MOO surface, working the same primitives.
