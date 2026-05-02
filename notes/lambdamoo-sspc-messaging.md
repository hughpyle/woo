# LambdaMOO messaging / following / notification / subscription
## as available to an SSPC-derived programmer (tty)

Built from live source reads on 2026-05-02, plus tty's runtime settings.
SSPC stacks ~10 layers above `$player` and many of these systems compound
across tiers. This note catalogs the *user-facing* surface; the internal
plumbing is lightly sketched.

The seven distinct systems below are independent — there is no central
"comms" abstraction. They each grew on a different tier and overlap in
how they interact with `tell()`/`notify()`/etc.

## 1. Inbound communication primitives

The actual bytes-to-screen layer. Lives mostly on `$player (#6)` with
overrides on the way up.

| Verb | Defined on | Role |
| --- | --- | --- |
| `tell(...)` | `$player`, overridden on `#33337` | Send args to *this* player's connections. The `#33337` override interposes `tell_filter_hook` (see §2). |
| `notify(line)` | `$player` | Direct line write to the connection. Used by everything that wants raw output. |
| `notify_lines(lines)` / `notify_lines_suspended(lines)` | `$player` | Multi-line output with `suspend_if_needed` for tick safety. |
| `tell(expensive)` | `#7069` | Alternate `tell` chosen at high cost; specialized formatting path. |
| `do_transmit` | `#40099` | SSPC-layer hook used to route certain messages. |
| `unfiltered_tell` | `#33337` | Bypass the tell_filter_hook explicitly — used by paranoid logging and similar. |

User-visible commands:

- `say <msg>`, `pose <msg>`, `'<msg>` (#5803 shortcut), `+<msg>` (#5803 shortcut)
- `whisper <player> <msg>` — direct to one recipient in the same room
- `page <player> [with <msg>]` — cross-room
- `@send`, `@reply`, `@quickreply`, etc. (mail; see §7)

## 2. Output filtering: `tell_filter_hook`

A per-player rewriter installed on tier `#33337` ("Politically Correct
Featureful PC"). Every `tell()` invocation runs through it.

```moo
// #33337:tell (paraphrased)
if ($recycler:valid(this.tell_filter_hook))
  filtered = this.tell_filter_hook:tell_filter(tostr(@args));
  if (typeof(filtered) == STR)
    return pass(filtered);   // pass to $player:tell with rewritten text
  else
    return;                   // hook returned non-string → suppress entirely
  endif
endif
return pass(@args);
```

Commands: `@tell-filter-hook`, `@set-tell-filter-hook`, `@unset-tell-filter-hook`,
`@clear-tell-filter-hook`. Property: `me.tell_filter_hook` (an object with a
`:tell_filter(text)` verb).

### Implications

- Returning non-string from the filter **silently swallows the line** — so
  this is the canonical place to ostracize specific phrases.
- `unfiltered_tell` exists explicitly because some output (paranoid logs,
  perms diagnostics) must *not* go through the filter.
- The mechanism is at the `tell` boundary, so a line written via raw
  `notify()` bypasses it. That distinction matters for things like
  password prompts, where `notify` is correctly used and the filter
  doesn't see the line.

## 3. Tracking and being tracked

Two unrelated systems despite the name overlap.

### `@watch <player>` (active surveillance, on `#33337`)

You decide to track *one* player at a time. Sets `me.idle_watched = target`
and forks a 30-second poll. While both you and target are connected, every
30s if `idle_seconds(target) < 30`, you get a `[targetname]` toast.

```
me.idle_watched      → who I'm watching (#-1 if nobody) — readable to me only
@watch <player>     → start
@watch off / none   → stop
@watch              → query
```

Stops automatically if either of you disconnects. Only one watchee at a time.

### `idle_watched` (passive — "X is watching me?")

Same property, read from outside reveals who you've targeted. **This is
permission-denied for non-owners**, so other people can't tell whether you
are watching them. A wizard could check — useful for harassment review.

There's no "I'm being watched" notification — passive surveillance is
effectively invisible to the watchee.

### `@spurn` / `spurned_objects` (Frand's #3133)

A separate "block this object" list. Distinct from gaglist (§9) and from
refusals (§5).

## 4. Pals & followers

### Pals (Slightly Sick #40099)

A flat list of "friends":

```
me.pals                 → list of player objects
@addpals <player(s)>   → adds via add_pal()
@rmpals <player(s)>    → removes via remove_pal()
@listpals / @pals      → list mine
@whopals / @whopals!   → list mine that are currently connected
@onlinepals            → same, terser
@mailpals / @sendpals  → mail to all of them
```

The verb `pals friends_of` (single defn, two names) is just `return this.pals`,
optionally cleaning out non-players. So "friends" is exactly "pals" — the
naming is for callers that want the relation read in one direction or the
other.

### Followers (Eval-hacked PC #8855)

Different concept: not who I like, but who is currently auto-tracking my
movement.

```
me.followable           → 1/0  ; opt-in receiver flag
me.followers            → list of players currently following me
me.follow_teleport      → 1/0  ; whether teleports drag followers

follow <player>         → I follow them (they consent via .followable)
unfollow <player>
@list-followers
```

The `follow` verb (paraphrased):

```moo
if (player in this.followers || player == this) "already";
elseif (!this.followable) "doesn't want to be followed";
else
  this.followers = listappend(this.followers, player);
  ...announce to room...
endif
```

Note the asymmetry: **the target's `.followable` gates entry**; you can
unilaterally `unfollow`. Movement-dragging is implemented in `:do_followers`
called from `:moveto` (and conditionally from teleport, gated by
`follow_teleport`).

So the semantics: pals are address-book; followers are a presence-tracking
relation.

## 5. Refusals (Frand's #3133)

The unified "refuse to be the recipient of this action" system. Replaces
ad-hoc `page_refused` / `mail_refused` flags from earlier tiers.

### API

```
me.refusable_actions()   → {"page", "whisper", "move", "join", "accept", "mail"}
me.refused_origins      → list of origins (player, $nothing, "all guests", ...)
me.refused_actions      → list-of-list, parallel to refused_origins
me.refused_until        → list of times, parallel
me.refused_extra        → per-action extra info
me.default_refusal_time → seconds; tty has 604800 (one week)
```

Origins can be:

- A specific player (e.g. `#49853`)
- An entire site (via `@gag-site` interaction)
- `$nothing` — *everyone*
- `"all guests"` — every player whose class isa `$guest`
- `:player_to_refusal_origin(x)` translates user input to one of these.

### Commands

- `@refuse <action>` (general)
- `@unrefuse <action>` (alias `@allow`)
- `@refusals` — list current
- `@refusal-reporting on|off` — whether you get notified that a refusal fired
- Thematic specializations:
  - `whisper_refused_msg`, `page_refused_msg`, `mail_refused_msg` — custom
    rejection text shown to the would-be sender
  - `report_refusal` — whether the *sender* learns you refused
  - `page_refusal_report` / `whisper_refusal_report` — per-action variants
  - `page_receipt_state` / `whisper_receipt_state` — controls "they got it"
    confirmation back to sender

### Runtime path

Senders call `recipient:refuses_action(origin, "page", ...)`. The check:

```moo
// #3133:refuses_action (paraphrased)
rorigin = this:player_to_refusal_origin(origin);
if (rorigin in this.refused_origins
    && action in this.refused_actions[which]
    && this:("refuses_action_" + action)(which, @extra_args)) return 1;
elseif (rorigin.owner in this.refused_origins ...) return 1;
elseif ($nothing in this.refused_origins ...) return 1;
elseif (origin isa $guest && "all guests" in this.refused_origins ...) return 1;
return 0;
```

Each refusable action has a hook verb `:refuses_action_<name>` for any
extra logic (e.g. `:refuses_action_flames` checks message content). The
action-specific check is what makes refusals *contextual* rather than blanket.

`add_refusal(origin, actions, duration, extra)` writes the structures.
Refusals expire automatically via `refused_until` and
`remove_expired_refusals`.

## 6. Spam refusal (Sick of Spam #59900)

A *more specific* mechanism than general refusals: refuse to receive output
from a particular **verb on a particular object**. Useful when one obnoxious
broadcaster is spamming; you don't want to refuse all communication from
its owner.

```
@refuse-spam from <verb>            → mute :<verb> on any object
@refuse-spam from <object>:<verb>  → mute :<verb> on <object> only
@unrefuse-spam from <verb>
@spam-refusals [for <player>]

me.spam_notify  → 1: print "[ Ignoring X's spam from object:verb ]" notice
me.spam_verbs   → list of verb names refused globally
me.spam_verbrefs → list of {object, verb} pairs refused
me.refusing_spam → 0/1 master switch
```

When a refused verb tries to `tell` you, the notice format is:

```
[ Ignoring <player>'s spam from <object>:<verb> (<command line>) ]
```

with `notify_spam_refusal` doing the formatting. tty has `spam_notify=1`,
so they see the notices.

## 7. Mail subscriptions (Mail Receiving Player #100068)

A separate inbox-and-bulletins system. Mail in LambdaMOO is *persistent*
and stored as message lists on player and on subject objects (mailing
lists are objects with `.messages`).

### Properties

```
me.mail_lists      → list of objects you're subscribed to
me.mail_notify     → either {users} or {{users}, {options}}
                    Returns the {users} list via :mail_notify().
                    "users" here = who else gets a copy when mail arrives.
me.mail_forward    → forward addresses (in-MOO)
me.current_message → bookmark in current folder
me.current_folder  → currently focused folder (player or list)
me.mail_options    → options like "nosubject"
me.message_keep_date → cutoff for auto-expiry
```

### Subscribe API

```
@subscribe <list>      → adds list to me.mail_lists
@subscribe-quick       → without confirmation
@unsubscribe <list>
@subscribed / @rn      → unread count per subscribed list
@nn                    → next-new across lists
```

Plus a mail-reader: `@mail`, `@read`, `@next`, `@prev`, `@send`, `@reply`,
`@forward`, `@rmm`, `@unrmm`, `@renumber`, `@refile`, `@keep-mail`,
`@expire_old_messages`, `@annotate-mail`, `@unsend`, `@quickreply`,
`@quicksend`, `@netforward`, `@@sendmail`.

The list of new-mail sources tty saw at login (the long
`*NewSocialIssues`, `*Public-ARB`, etc. block) is just the unread count
from each subscribed mailing-list object.

## 8. Morph notifications (Sick's Sick #49900)

The *only* "subscribe to events from a specific player" mechanism in this
stack — and it's narrowly scoped to morph changes (an SSPC alternate
identity).

```
me.notify_morph_these   → list of player objects you watch for morph changes
@add-notification <player>   → add via add_not()
@remove-notification <player>
@list-notifications

# When a watched player @morph's:
notify_morph(oldname, newname)   → invoked on watcher (also fires possessions move-out/in)
```

The `:notify_morph` verb fires on the watching player when the watched
player changes morph. It's wired into `@morph` itself.

## 9. Idle / presence

Composed across tiers:

| Property | From | Meaning |
| --- | --- | --- |
| `idle_msg`, `idle_messages` | `#7069` / `#40099` | Custom suffix when others see you idle |
| `twitch_delay`, `twitch_threshold`, `last_twitch` | `#7069` | "twitch" detection — short bursts of activity vs sustained idle |
| `boring` | `#5803` | Suppress some flavor output (couch-fall etc.) for the user |
| `paranoid`, `eval_paranoid_data` | `#6` (base) | Log every tell received — dump via `@paranoid` |
| `last_connect_time`, `last_disconnect_time`, `first_connect_time`, `last_password_time` | `#6` | Standard timestamps |
| `coma_msg`, `dozing_msg`, `daydreaming_msg`, `distracted_msg`, `alert_msg` | `#40099` | Per-idle-level descriptive verbs other players see ("X is dozing", etc.) |

## 10. Login/logout hooks

The `confunc` (connect) and `disfunc` (disconnect) verbs run automatically.
Each tier overrides and `pass()`es up. Slightly Sick's confunc:

```moo
pass(@args);   // run parent's confunc first
if (length(this.todo_list) && this:get_sspc_option("confunc_todo"))
  this:tell("You have N items waiting in your @todo list.");
endif
if (commands = this:get_sspc_option("confunc_cmds"))
  fork (0) this:do_confunc_cmds(@commands); endfork
endif
if (this:get_sspc_option("newbie"))
  fork (0) this:newbie_check(); endfork
endif
```

So the SSPC layer adds: post-login todo summary, an arbitrary command
script run on connect, and a newbie tutorial check.

`reconfunc` (also on `#6`) handles reconnect (taking over an existing
connection, e.g. via `@boot` from a duplicate session).

## 11. Tty's current settings snapshot

Read 2026-05-02 with everyone's progbit etc. permissions accounted for:

```
me.pals                 = {}
me.followable           = 0      # not accepting followers
me.followers            = {}
me.follow_teleport      = 0
me.notify_morph_these   = {}     # not watching anyone's morphs
me.refused_actions      = {}
me.refused_origins      = {}
me.tell_filter_hook     = #-1    # no output filter installed
me.mail_notify          = {{}, {}}   # empty users + empty options
me.spam_notify          = 1      # show "[ Ignoring X's spam ]" notices
me.page_notify          = 0
me.gaglist              = {#readacted}   # one player gagged
me.idle_watched         = (Permission denied)  # only owner/wizard reads

me.SSPC_options =
  ["verbose", "look_detect", "confunc_todo", "paste_notify",
   "paste_command", "movable", {"ask_verbs", {"ask"}},
   "page_idle", "page_alert"]
```

So tty has minimal active relationships: no pals, no follow, no morph
notifications, one gag, default refusals, no tell-filter. Mostly receiving
the world as-is.

## 12. Tier-by-tier provenance

For when you're trying to remember "where did that verb come from":

| Tier | What it adds |
| --- | --- |
| `$player #6` | tell, notify, page, whisper, gag, paranoid, mail-options shells, confunc/disfunc base |
| `Mail Recv #100068` | full mail system (§7), mail_notify event |
| `Frand's #3133` | refusals (§5), page/whisper extensions, web_info |
| `Citizen #322` | governance comms (petitions, ballots), @ban |
| `builder #630`, `programmer #217` | nothing comms-relevant in scope |
| `Additional Features #7069` | idle_msg, twitch detection, respond_to, sub_tell |
| `Experimental Guinea Pig #5803` | boring flag, paste_header/footer, idle_messages |
| `Eval-hacked #8855` | follow / unfollow (§4), paste |
| `"Politically Correct" #33337` | tell_filter_hook (§2), @watch (§3), refusals_action_flames |
| `Super_Huh #26026` | @remember/@forget known-objects, pets/puppets |
| `Sick of Spam #59900` | spam refusals (§6) |
| `Slightly Sick #40099` | pals (§4), confunc todo summary, custom idle messages, paste-command pipeline |
| `Sick's Sick #49900` | morph notifications (§8), morph itself |

## 13. Open questions

- **Does mail-notify actually fire to other users?** The property layout
  `{{users}, {options}}` suggests there's a notify-cc list when new mail
  arrives. The `mail_notify` *verb* just returns the list, but who calls
  it during mail receipt is unclear.
- **`refuses_action_flames` interception details** (#33337): refuses-flames
  hook examines content. What content patterns count as flames?
- **Can the tell_filter_hook see who originated the tell?** The hook
  receives `tostr(@args)` only — looks like the original caller is lost,
  so you can't filter "what X says" only "what is said". Wizards may have
  more context via `caller` chain.
- **What's `do_transmit` for?** Defined on `#40099`, sounds like an
  alternate output channel — maybe for the paste-pipeline?
- **`@spurn` / `spurned_objects` semantics**: I noted Frand's has it but
  didn't read the source. Likely a third axis of "block this thing"
  alongside gaglist and refusals.
