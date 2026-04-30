# Chat Demo

A canonical MOO surface — rooms, presence, talk, emote, tell — built as a feature-object composition rather than a `$space` subclass. Sits alongside dubspace/taskspace/IDE; can also embed inside them.

## Goal

Show that woo's MOO-shaped composition works in practice: chat behavior is a *feature*, not an inheritance, so any `$space` (a `$chatroom`, a `$taskspace`, a `$dubspace`) can opt into it by attaching `$conversational` to its `features` list.

This is the demo that retires the question "do feature objects pull their weight?" If the chat experiment composes cleanly with the other demos, the answer is yes.

## Surface

- Two or more actors connected to a shared room.
- Free-text input bar; output is a chronological text feed.
- Presence list visible.
- MOO-like text input parsed by the room: speech forms (`"hi`, `:waves`, `/tell`, backtick directed speech), room commands (`look`, `who`), and object commands (`look cockatoo`, `teach bird "hello"`).
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
| `:command_plan` | direct parser | none; returns the concrete route/target/verb/args |
| `:command` | direct dispatcher | compatibility wrapper for direct-only plans |

Because the chat verbs route directly, every observation they emit is live-only by [events.md §12.6](../../spec/semantics/events.md#126-observation-durability-follows-invocation-route): pushed to subscribers, never stored. A late-joining client sees no scrollback. This matches MOO's `notify()` semantics. Object commands that mutate state can still route through the room's sequenced log; for example `teach bird "hello"` plans as a `$space:call` against the cockatoo, so the mutation and observation are replay-visible.

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
| `:say_to(recipient, text)` | obj, str | Directed public utterance from backtick syntax. Emits `said_to`. |
| `:say_as(style, text)` | str, str | Styled public utterance from `[style] text`. Emits `said_as`. |
| `:emote(text)` | str | Third-person action. Emits `emoted {actor, text}`. |
| `:pose(text)` / `:quote(text)` / `:self(text)` | str | Small LambdaCore-flavored speech forms for `]`, `|`, and `<`. |
| `:tell(recipient, text)` | obj, str | Directed message; emits `told {from: actor, to: recipient, text}` to recipient only. |
| `:look()` rxd | — | Thin wrapper over `this:look_self()`. Room composition is generic `$space` behavior: it returns `{description, present_actors, contents}` and lists contained objects as `{id, title, description}` using each item's `:title()` and actor-readable description. |
| `:who()` rxd | — | Returns the present-actor list. |
| `:enter(actor?)` | obj? | Adds actor (defaults `actor`) to subscribers and to its `presence_in`. Emits `entered {actor}`. |
| `:leave(actor?)` | obj? | Removes presence. Emits `left {actor}`. |
| `:huh(text, reason?)` | str, str? | Emits a parse-failure observation. |
| `:command_plan(text)` | str | Parses text into `{route, space?, target, verb, args, cmd}`. |
| `:command(text)` | str | Compatibility wrapper for direct plans; richer clients should call `:command_plan` and then execute the plan. |

Most `$conversational` verbs remain portable source. `$match` and the command planner use trusted local native implementation hints until the DSL grows enough string/pattern primitives to express the parser cleanly as catalog code. Public tap installs ignore those hints and still compile the source fallback.

Inside each verb body: `this` = the consumer space (the room being talked in), `definer` = the `$conversational` feature, `progr` = the feature's owner. Observations are emitted to `this.subscribers`, not to the feature's own subscribers (which would be empty).

## Observation schemas

`$conversational` declares schemas for each observation type so consumers (UIs, agents, conformance tests) have a contract on payload shape. Schemas describe shape only ([events.md §13](../../spec/semantics/events.md#13-schemas)); durability follows the route of the verb that emits each observation. All chat verbs are direct, so all observations below reach subscribers as live `event` frames, never as `applied` frames.

```woo
declare_event $conversational "said"    { source: obj, actor: obj, text: str };
declare_event $conversational "said_to" { source: obj, actor: obj, to: obj, text: str };
declare_event $conversational "said_as" { source: obj, actor: obj, style: str, text: str };
declare_event $conversational "emoted"  { source: obj, actor: obj, text: str };
declare_event $conversational "posed"   { source: obj, actor: obj, text: str };
declare_event $conversational "quoted"  { source: obj, actor: obj, text: str };
declare_event $conversational "self_pointed" { source: obj, actor: obj, text: str };
declare_event $conversational "told"    { source: obj, from:  obj, to:   obj, text: str };
declare_event $conversational "entered" { source: obj, actor: obj };
declare_event $conversational "left"    { source: obj, actor: obj };
declare_event $conversational "huh"     { source: obj, actor: obj, text: str, reason?: str };
```

| Type | Payload | Notes |
|---|---|---|
| `said` | `{source, actor, text}` | Public utterance. |
| `said_to` / `said_as` | directed/styled speech payloads | Backtick and `[style]` forms. |
| `emoted` | `{source, actor, text}` | Third-person action. |
| `posed` / `quoted` / `self_pointed` | `{source, actor, text}` | Alternate speech forms. |
| `told` | `{source, from, to, text}` | Delivered only to `to`. |
| `entered` / `left` | `{source, actor}` | Presence transitions. |
| `huh` | `{source, actor, text, reason?}` | Unparseable input. |

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

## The cockatoo (cheap imitation of LambdaMOO #1479)

`$cockatoo` lives in `the_chatroom` as a small static-feeling resident. It has a `phrases` list and `:squawk()` picks one at random via the `random(n)` builtin; `:teach(phrase)` extends the list; `:gag()` / `:ungag()` toggle a muzzle that swaps squawks for `*muffled noises*` observations. `:pluck()`, `:shake()`, `:feed()` are flavor verbs.

What's intentionally not (yet) here: **self-driven timer chatter**. The canonical LambdaMOO cockatoo activated and squawked on a fork loop with a random delay. Woo's runtime supports parked/forked tasks, but the DSL does not yet expose `fork(seconds) { ... }` or a `schedule(seconds, target, verb, args)` builtin. Once it does, the cockatoo will become the first useful demo of woo's parked-task system: install a watchdog verb that schedules itself, with random interval and random phrase pick. Until then, squawking is actor-driven only.

**When the timer lands, gate it on presence.** A cockatoo that schedules a wakeup every N seconds against an empty room would keep the chatroom DO out of CF hibernation indefinitely — DO billing is by active wall time, so a continuously-self-squawking bird in an unattended room is a money-burning bird. Cheap mitigation, also true to the LambdaMOO `@activate` pattern: start the fork loop on `:enter` when subscribers transition from 0 → 1, cancel the next scheduled fork on `:leave` when subscribers go back to 0. That keeps DO wake-ups proportional to *actor presence* rather than wall clock; an empty chatroom hibernates as it would without the cockatoo.

**Determinism if the wake path is sequenced.** If the scheduled wake fires through `the_chatroom`'s sequenced log so other clients see the same squawk on replay, calling `random()` *inside* the resumed handler breaks replay determinism (per [space.md](../../spec/semantics/space.md)). Capture randomness at *schedule time* — the scheduler picks the next phrase and the next interval and passes both as args/body to the scheduled message — rather than re-rolling on the wake. That mirrors the LambdaMOO `fork` pattern, where the next-scheduled call is itself the value chosen at this tick.

**UI discovery still partial.** As of this build `$conversational:look()` delegates to the room's generic `:look_self()`, so any REST/WS caller doing `look` sees `the_cockatoo` in the composed contents list. The chat client doesn't yet *render* that contents list — verb-discovery via `:describe()` on a selected object is still tracked at [LATER.md](../../LATER.md). Wiring the data path was the precondition; the UI change is a follow-up.

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
5. Sends free-text input as `target_room:command_plan(text)`, then executes the returned route. Direct plans use `op:"direct"`; sequenced plans use `$space:call`.

Same client speaks against `$chatroom` and against `$taskspace` — the verb set is identical, the renderer doesn't care.

## $match interaction

Free-text input goes through the `$match`-shaped parser per [match.md §MA4](../../spec/semantics/match.md#ma4-command-parsing). `:command_plan` explicitly **lowers** the parsed `cmd` map into the right argument shape per verb — the parsed map is not the right call signature for `:say`, `:tell`, etc., so the dispatcher unpacks it:

```woo
verb $conversational:command_plan(text) {
  let cmd = $match:parse_command(text, actor);

  // Built-in chat verbs: explicit lowering per signature.
  if (cmd.verb == "say") {
    return {route: "direct", target: this, verb: "say", args: [cmd.argstr]};
  }
  if (cmd.verb == "emote") {
    return {route: "direct", target: this, verb: "emote", args: [cmd.argstr]};
  }
  if (cmd.verb == "look") {
    return {route: "direct", target: this, verb: "look", args: []};
  }
  if (cmd.verb == "who") {
    return {route: "direct", target: this, verb: "who", args: []};
  }
  if (cmd.verb == "tell") {
    // Grammar: tell <recipient> <message...>
    // dobj resolves the recipient; the message is argstr after the recipient.
    if (cmd.dobj == $failed_match || cmd.dobj == $ambiguous_match) {
      return {route: "huh", text};
    }
    let message = trim_prefix(cmd.argstr, cmd.dobjstr);
    return {route: "direct", target: this, verb: "tell", args: [cmd.dobj, message]};
  }

  // Fall through: try to dispatch on the direct object using runtime lookup
  // (parent chain + features, per $match:match_verb).
  if (cmd.dobj != $failed_match && cmd.dobj != $ambiguous_match) {
    let v = $match:match_verb(cmd.verb, cmd.dobj);
    if (v != null) {
      let route = v.direct_callable ? "direct" : "sequenced";
      return {route, space: this, target: cmd.dobj, verb: v.name, args: lower_args(cmd)};
    }
  }

  return {route: "huh", text};
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
