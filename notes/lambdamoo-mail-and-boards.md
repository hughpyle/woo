# LambdaMOO mail, mailing lists, news, notes, bulletin boards

Source: live read on 2026-05-02 from `tty (#112104)` plus the in-MOO
help system. Programmer access, no wizard.

There are **three structurally distinct surfaces** for asynchronous /
multi-recipient communication in LambdaMOO; only the mail substrate
unifies under a single abstraction.

| Surface | Root class | Storage | Examples |
| --- | --- | --- | --- |
| **Mail substrate** | `$mail_recipient (#6419)` | `.messages` (list of structured msgs) | Player inboxes, mailing lists, archive lists, the News, gripe/bug/suggest channels |
| **Notes** | `$note (#9)` | `.text` (list of strings) | Welcome Poster, MOTD signs, signs in rooms |
| **Bulletin boards** | `#49 generic bulletin board` | `.contents` (list of `$note` objects) | Fun Activities Board, any "post a note" wall |

These do not share a common ancestor (each lives under `$thing` directly
or via a sibling line) and don't interoperate automatically — though a
bulletin board *can* mirror posts to a paired `$mail_recipient` via its
`.mail_recipient` property.

## 1. The mail substrate (`$mail_recipient`)

> *"One source of confusion is that the terms 'mail recipient', 'mail
> folder', 'mailing list', and 'mail collection' really all refer to
> the same kind of object. … it's a 'mailing list' if we're playing
> with its `.mail_forward` property but it's also a 'mail folder' if
> we're examining the messages saved in it."*  — `help $mail_recipient`

So one class, used four ways:

- **Player inbox**: every player IS a mail recipient (via inheritance
  on `Generic Mail Receiving Player #100068`). `me.messages` is the
  inbox.
- **Mailing list**: a freestanding `$mail_recipient` whose
  `.mail_forward` points at a list of subscribed players. New mail
  fans out to those subscribers' inboxes.
- **Mail folder**: a freestanding `$mail_recipient` that someone
  uses purely as a personal archive. Same code, different intent.
- **News**: a customised `$mail_recipient` (`$news (#123)`) with an
  editorial layer (current / archive issues, see §4).

### Configuration knobs

| Property | Effect |
| --- | --- |
| `.readers` | `1` for public-readable. Otherwise readable only by owner & wizards. |
| `.writers` | Object or list of who can `@send` to it. |
| `.mail_forward` | List of recipients each new arrival is fanned out to (the actual subscriber list). |
| `.mail_notify` | List of players to *immediately notify* on arrival (no copy). The `{users}` half of the player property `me.mail_notify`. |
| `.rmm_own_msgs` | `1` lets senders `@rmm` their own messages without owner intervention. |
| `.expire_period` | Auto-expire seconds (e.g. `15552000` = 180 days for Bug-Reports). |
| `.current_message` | Per-reader bookmark (kept on the *reader*, not the list). |

### Verbs (selected)

`receive_message`, `display_message`, `parse_message_seq`,
`from_msg_seq`/`%from_msg_seq`/`to_msg_seq`/`subject_msg_seq`/`body_msg_seq`/`kept_msg_seq`,
`rm_message_seq`, `undo_rmm`, `expunge_rmm`, `renumber`, `keep_message_seq`,
`msg_summary_line`, `msg_text`, `notify_mail`, plus all the `@`-commands.

### Two-step delivery

Sending mail to a list:

1. `$mail_agent` calls `recipient:receive_message(msg)`.
2. The recipient appends to `.messages`, then **fans out**: for each
   addr in `.mail_forward`, recursively `:receive_message` is called.
   Players in `.mail_forward` get the message in their personal inbox.
3. Players in `.mail_notify` receive only a *new mail* heads-up, no
   copy. The list of notified-users is `.mail_notify[1]` (the
   property is `{{users}, {options}}`).

So a mailing list is just a recursive fan-out point. Forwarding is
opt-in per recipient.

## 2. The reader UI

Each player has their inbox PLUS a configured set of *external*
mail collections they can browse. Two read modalities:

### Direct browse

`@mail`, `@read`, `@next`, `@prev`, `@peek` work on **any** mail
collection the caller has read access to:

```
@read 5 on *Bug-Reports
@mail last:10 on *Server-Hackers
```

This doesn't subscribe — it just reads in place.

### Subscription (lightweight)

`@subscribe *<list>` records a `current_message` bookmark on YOUR
player so the system knows where you've read up to. `@rn` then shows
unread counts across your subscribed lists; `@nn` jumps to the next
new across all of them.

Adding `with notification` to `@subscribe` ALSO adds you to the
list's `.mail_notify`, so new arrivals notify you in real time.
`without notification` removes you. Bookmark and notification are
independent.

### Subscription (heavy / forwarding) — the Mail Room

There's a *separate* `subscribe` command available in a place called
the Mail Room which adds you to the list's `.mail_forward` instead —
i.e. each new arrival is **delivered into your personal inbox as a
copy**. This is the legacy mechanism. Per `help @subscribe`:

> *"Note that this is entirely different from the Mail Room
> `subscribe' command which actually adds you to the .mail_forward
> list … We're probably going to phase out the Mail Room `subscribe'
> command…"*

I couldn't locate a "Mail Room" by name match in this MOO — `$mail_agent`
itself lives in `Sleeper (#98232)`, which has 94 contents (probably
the actual mail-list objects sitting in a holding room owned by a
wizard). The Mail Room is presumably a wrapper interface around
`$mail_agent` that's no longer maintained.

### Compose

`@send`, `@reply`/`@answer`, `@forward`, `@quicksend`/`@qsend`,
`@quickreply`/`@qreply`, `@resend`, `@netforward`, `@@sendmail`,
`@unsend` (best-effort retraction).

### Manage

`@rmm` (delete) doesn't actually delete — messages become **zombies**,
recoverable via `@unrmmail` until the next `@rmm` or `@renumber`
(which calls `@unrmmail expunge` implicitly). One-undo redo buffer.
Also: `@keep-mail` exempts messages from auto-expiry, `@refile`
copies between collections, `@annotate-mail` adds margin notes.

### Bulk

`@mail-all-new-mail` / `@read-all-new-mail` / `@ranm` walk every
subscribed list at once.

## 3. Channel-style use of mailing lists

Several "global feedback channels" are just well-known mailing lists
pre-wired to commands on `Generic Mail Receiving Player`:

```
@gripe ...        → mail to the gripe list
@bug ...          → mail to the bug list
@typo ...         → mail to the typo list
@suggest*ion ...  → mail to the suggestion list
@idea ...         → mail to the idea list
@comment ...      → mail to the comment list
```

Players are subscribed to these with their `@addalias`-equivalent
preferences. Discussion happens via `@reply`. Effectively a mailing-list
CMS with custom "post" verbs.

## 4. News (`$news (#123)`)

The "LambdaMOO Newspaper" — descended from `$mail_recipient` and adding
editorial layer:

```
Verbs: description, is_writable_by, rm_message_seq, undo_rmm, expunge_rmm,
       set_current_news, add_current_news, rm_current_news,
       news_display_seq_full, to_text, check, touch,
       @addnews, @rmnews, @setnews, _parse,
       init_for_core, add_news, rm_news, @listnews, @clearnews
Props: current_news, last_news_time, current_news_going, archive_news
```

So news has two tiers:

- `current_news` — articles in the active issue. `news new` shows
  what's been added since your last view; `news all` dumps all current.
- `archive_news` — back issues, kept around because deemed worth
  reading by every citizen. `news archive` displays them.

Reader command: `news` (verb on `$player`, configurable default
behaviour via `@mail-option news=all|new|contents`).

Editor commands: `@addnews`, `@rmnews`, `@setnews`, `@listnews`,
`@clearnews` — all wizard-gated via `is_writable_by`.

## 5. Notes (`$note (#9)`)

A `$thing` with text — walk-up-and-read.

```
Parent: generic thing ($thing)
Verbs:  r*ead, er*ase, wr*ite, del*ete/rem*ove, encrypt, decrypt,
        text, is_readable_by, set_text, is_writable_by, mailme/@mailme
Props:  writers, encryption_key, text
```

Highlights:

- `.text` is a list of strings (one per line). Direct property read may
  be permission-denied; the `:text()` verb wraps it with permission
  checks and is the public API.
- **Encryption**: `encrypt <note> with <key>` blanks out the visible
  text unless the reader has the key. Per-note opaque blob.
- **`mailme`** / **`@mailme`**: emit the note's contents as mail to
  the caller. Bridges note → mail.
- **Welcome Poster (#2645)** is a `$note` whose `.text` is *exactly*
  the LambdaMOO welcome banner (28 lines). Same source as login. No
  duplication; the welcome banner pipeline reads from this object.

Notes are mostly walk-up artifacts — signage. The MOO equivalent of
a sign hanging on the wall.

## 6. Bulletin boards (`#49 generic bulletin board`)

A `$thing` (parent: `generic thing`, NOT `$mail_recipient`) that acts
as a container for `$note` children.

```
Verbs: post stick, add attach, add_note, remove take, read,
       acceptable, look_self, list_notes, alias, enterfunc, exitfunc
Props: mail_recipient, dates
```

`:post` ↔ `:add_note` is a one-liner: it moves a `$note`-descendant
into the board's `.contents`, with permission gating (`acceptable`).
`:remove`/`:take` lifts a note off. `:read` and `:list_notes` browse.

The `dates` property is a list of `{poster_obj, timestamp}` parallel
to the contents. The Fun Activities Board (#55518) has 9 posts dated
2022 → 2026. Posters tracked by object (not name), so
`@rename`-survival is automatic.

The `.mail_recipient` property is intriguing: optionally points at a
paired `$mail_recipient`, presumably so each post is *also* mirrored
as mail to a subscribers' list. Fun Activities Board has it set to
`#-1` (unset), so its posts are board-only.

### Board ≠ list

Bulletin boards are physical (you walk to them, pick up notes, post
notes). Mailing lists are logical (you `@subscribe`, `@send`,
`@read` from anywhere). A board can *opt in* to mirror as mail; a
list cannot opt in to be a board. The asymmetry is structural.

## 7. tty's current subscriptions

From `me.current_message` and the login `*X (#Y)  N new messages`
block:

| List | Object | New |
| --- | ---: | ---: |
| *NewSocialIssues | #17671 | 79 |
| *books | #77448 | 71 |
| *Public-ARB | #3093 | 575 |
| *lego-issues | #66298 | 19 |
| *Server-Hackers | #24451 | 373 |
| *Bug-Reports | #22307 | 10 |
| *Documentation | #33586 | 40 |
| *Core-DB-Issues | #8175 | 611 |

Plus 5 personal inbox messages.

`#22307 *Bug-Reports` parameters: `readers=1` (public),
`rmm_own_msgs=1` (senders can clean up their own posts),
`expire_period=15552000` (180 days). So bug reports auto-decay to
keep the list size manageable.

## 8. Cross-references

- The unified `$mail_recipient` substrate is the single biggest
  structural simplification in the MOO — one mailbox class, four uses.
- Notes and bulletin boards live under `$thing` and are walk-up only.
  They're "place-based" communication; mail is "address-based".
- Gripes/bugs/typos use mail (place-independent), and the `@`-commands
  are syntactic sugar for `@send` to specific lists.
- News is mail with editorial workflow.
- Welcome Poster is a note whose contents are the shared banner —
  i.e. there's one source for "what new players see on connect"
  and it's ergonomically editable as a regular note.

## 9. Open questions

- Where exactly is the mail-fanout implemented? `:receive_message`
  presumably walks `.mail_forward` but I didn't read the source.
- Is the "Mail Room" still reachable, just renamed? It's referenced
  by name in `help @subscribe` but doesn't resolve via match. Maybe
  removed since the help was last updated.
- The bulletin board's `.mail_recipient` pairing: any current example
  in the MOO? Would be a nice unified-comm pattern (post on a wall
  AND it goes to a list).
- Notes can be encrypted. Can mail messages be? `help mail` doesn't
  mention encryption — possibly an opportunity LambdaMOO never took.
