# LambdaMOO player classes

Notes from a live walk of the player-class inheritance graph on
lambda.moo.mud.org (server v1.8.3+47), via `moo-mcp`. Subject character:
`tty (#112104)`, an SSPC-derived programmer. Contrast targets: the bare
`$player (#6)` template and `Generic Guest (#5678)`. Date: 2026-05-02.

## The three chains

```
tty (#112104)                                           Generic Guest         generic player
  Sick's Sick PC                  #49900                  Generic Guest         generic player    #6
  Sick's Slightly Sick            #40099                    #5678                 Root Class      #1
  Sick of Spam                    #59900                  Citizen   #322
  Global Positioning              #6225                   Frand's   #3133
  Detailed PC                     #6669                   Mail Recv #100068
  Generic Super_Huh               #26026                  $player   #6
  "Politically Correct …8855…"    #33337                  Root      #1
  Eval-hacked PC                  #8855
  Experimental Guinea Pig         #5803
  Additional Features             #7069
  generic programmer              #217
  generic builder                 #630
  Generic LambdaMOO Citizen       #322   ← shared with guest
  Frand's player class            #3133  ← shared with guest
  Generic Mail Receiving Player   #100068
  generic player                  #6
  Root Class                      #1
```

The convergence point is **Citizen `#322`**. Above that, the chains diverge
hard — guests skip builder/programmer/feature-stacking entirely; SSPC stacks
13 additional layers of features.

## What each tier adds

Counts are **own** verbs/properties on that object, not cumulative. Every
descendant gets all of these by inheritance.

### Shared base (in everyone's chain)

| Object | Verbs | Props | Theme |
|---|---:|---:|---|
| `Root Class #1` | — | — | top of the hierarchy |
| `generic player #6` | 109 | 45 | base capability — move, talk, page, examine, gag, paranoia, mail-options, who, features, set name/gender, `@quit`, `?* help info*rmation @help`, `tell`, `notify`, `@describe`, `@notedit`, `@features`, `@addalias`, `@move`, `@eject`, `@sweep`, etc. |
| `Generic Mail Receiving Player #100068` | 64 | 10 | full mailbox — `@mail`, `@send`, `@read`, `@rmm`, `@reply`, `@forward`, `@subscribe`, `@nn`, folders, msg-seq parsers |
| `Frand's player class #3133` | 88 | 27 | room registry (`@rooms`, `@go`, `@addroom`, `teleport`); refusals system (`@refuse`, `@unrefuse`, refused_actions); dictionary/spell (`@addword`, `@spell`, `@cspell`); paging msgs; web_info; `findexits`; spurned_objects |
| `Generic LambdaMOO Citizen #322` | 55 | 4 | governance — `@petition`/`@petitions`, `@ballots`, `@arb-nominate`, `@arb-petitions`, `@arb-ballots`, `@arbitrators`, `@reapers`, `@registrars`, `@witness`, `@ban`/`@unban`, `@gag-site`, `@email`, `@will`, `@noreapwarn`, `@gms`, `@nominate` |

### Builder/programmer (tty has, guest doesn't)

| Object | Verbs | Props | Theme |
|---|---:|---:|---|
| `generic builder #630` | 33 | 1 | world-building — `@create`, `@recycle`, `@recreate`, `@dig`, `@audit`, `@count`/`@countDB`, `@kids`, `@contents`, `@parents`, `@locations`, `@classes`, `@chparent`, `@check-chparent`, `@setprop`, `@lock`/`@unlock`, `@quota`, `@measure`, `@listedit`/`@pedit`, `@add-owned` |
| `generic programmer #217` | 43 | 4 | code editing — `@program`, `@verb`, `@args`, `@chmod`, `@property`, `@rmprop`, `@rmverb`, `@list`, `@copy`/`@copy-x`/`@copy-move`, `@disown`, `@show`, `@d*isplay`, `@grepall`, `@gethelp`, `eval-d`, `@dump`, `@kill`, `@forked-verbose`, `@prospectus`, `@progoptions`, `set_eval_env`/`set_eval_subs` |

### "Feature stack" — only in tty's chain

In rough chronological order (oldest at the bottom of the local stack,
since each layer was created by extending the one below it):

| Object | Verbs | Props | Theme |
|---|---:|---:|---|
| `Additional Features #7069` | 40 | 13 | `seek`, `title`, `respond_to`, `@destroy`, `@rescue`, `@purge`, `@queued_tasks`, `@whomovedme`, `@relink`, `@fill`, `@dbsize`, idle msg, twitch detection, sub_tell |
| `Experimental Guinea Pig (#5803)` | 35 | 9 | `@ss*how`, `5803_options`, party, paste header/footer, idle messages, `eprint*`, `+*` say-shortcut, `!*`, `@nlist`/`@nproperty`/`@prettylist` |
| `Eval-hacked PC #8855` | 22 | 5 | `@define`/`@undefine`/`@listdefs` (eval substitutions); `fol*low`/`unfollow`/`@list-followers`; `@parent`; `@paste`; `'*` say-shortcut |
| `"Politically Correct Featureful PC Created Because Nobody Would @Copy Verbs To 8855" #33337` | 43 | 9 | `@watch`, `mu*rmur`, `@tell-filter-hook` (output rewriting), `@pc-news`/`@pc-options`, anonymous `@who-anon`, refusals for entry/flames, `unfiltered_tell`, `do_out_of_band_command` |
| `Generic Super_Huh #26026` | 13 | 3 | `@remember`/`@forget` known objects; `pets`/`puppets`; smarter `:huh` and `:my_match_object`; `feature` registry |
| `Detailed PC #6669` | 12 | 2 | `details` and `@detail` — sub-locations within a room or object that respond to `look at <detail>` |
| `Global Positioning PC #6225` | 7 | 3 | `latitude`/`longitude`; `@position`, `@distance`, `@nearby`, `@distwho`, `@map` (terraserver URL) |
| `Sick of Spam #59900` | 12 | 8 | `@refuse-spam from <verb>` / `@unrefuse-spam` — gag specific verbs across the MOO; `@spam-refusals`; `notify_spam_refusal`; targeted spam ignores |
| `Sick's Slightly Sick #40099` | 77 | 29 | pals (`@addpals`, `@listpals`, `@whopals`, `@onlinepals`, `@mailpals`); hometown/timezone (`@time`, `@date`, `@timezone`, `@hometown`); custom messages (asleep_msg, coma_msg, dozing_msg, distracted_msg, alert_msg…); `@todo`/`@thing-done`; `@paste-command`/`@cpaste`/`@cpaste-to`/`@pipe`; idle suffix system; SSPC_options; safe_eval |
| `Sick's Sick #49900` | 44 | 10 | morph system — `@morph`, `@create-morph`, `@list-morphs`, `@savemorph`, `@show-morph`, `@removemorph`, `@change-default-morph`, `@morph-options`, `@list-possessions`/`@add-possession`, `@list-notifications`/`@add-notification` |

### Guest-only

| Object | Verbs | Props | Theme |
|---|---:|---:|---|
| `Generic Guest #5678` | 22 | 6 | `boot`, `defer`, `log_disconnect`, `do_reset` (state wipe on disconnect), `@request` (apply for permanent char), `mail_catch_up`, `extra_confunc_msg`, `said_yes_to_tutorial`, `default_gender`, `default_description` |

## Cumulative reach

| Identity | own verb defs (sum across own + ancestors) | Notes |
|---|---:|---|
| `$player #6` | ~109 | bare template — no actual user runs as this |
| `Guest #5678` | ~338 | $player + Mail Recv + Frand's + Citizen + Guest |
| `tty #112104` | ~698 | full SSPC stack |

(Includes all ancestors. Does not deduplicate verbs that are overridden in
multiple layers — overrides are common, especially for `tell`, `notify`,
`my_huh`, `confunc`/`disfunc`.)

## Behavioral contrast

| Capability | `$player` | Guest | tty (SSPC) |
|---|:-:|:-:|:-:|
| say / pose / whisper / page / look / movement | ✓ | ✓ | ✓ |
| help system, @gag, @paranoid | ✓ | ✓ | ✓ |
| @mail (persistent inbox) | ✗ | ✓ (volatile) | ✓ |
| @petition / @ballots / @arb-* / @ban | ✗ | ✓ | ✓ |
| @rooms / @go room registry, @refuse actions | ✗ | ✓ | ✓ |
| @request (apply for permanent character) | ✗ | ✓ guest-only | ✗ |
| `do_reset` (state wipe on disconnect) | ✗ | ✓ guest-only | ✗ |
| @create / @dig / @recycle / @quota | ✗ | ✗ | ✓ |
| @program / @verb / @property / eval | ✗ | ✗ | ✓ |
| `;` shortcut, programmer bit | ✗ | ✗ | ✓ |
| @watch, @tell-filter-hook | ✗ | ✗ | ✓ |
| @position, @nearby (GPS) | ✗ | ✗ | ✓ |
| @morph, alternate identities | ✗ | ✗ | ✓ |
| @refuse-spam from verb | ✗ | ✗ | ✓ |
| pals, @todo, paste-command, hometown/timezone | ✗ | ✗ | ✓ |
| @details, @remember/@forget, pets/puppets | ✗ | ✗ | ✓ |

## Observations

### Class-locked features are an organic API

`@morph` is "an SSPC thing"; `@watch` is "a #33337 thing"; `@request` is "a
guest thing". A non-SSPC player can't `@morph` even if they want to — they'd
have to `@chparent` to an SSPC class first (which is wizardly). So the
inheritance graph effectively gates feature access. There is no central
"feature flag" registry — your class IS the feature flag.

### Guest is more powerful than `$player`

`$player #6` is a stripped reference template; nobody runs as a bare
`$player` in production. Guests get the Frand + Citizen + Mail layers by
inheritance, so they can vote on petitions, register rooms, set refusals
and read mail (volatile though it is). The "default user" doesn't really
exist as a runtime identity.

### `programmer ⊂ builder ⊂ Citizen`

Every programmer is automatically a builder. The two layers are stacked
by design: programmer extends builder extends citizen. There is no
separate "non-builder programmer" slot. tty inherits both.

### Class names encode community history

The literal class name **"Politically Correct Featureful Player Class
Created Because Nobody Would @Copy Verbs To 8855" (#33337)** records a
fork drama: the authors couldn't get their patches into `#8855` (the
Eval-hacked PC), so they made `#33337` to extend it. That history is now
permanently part of the inheritance graph and visible in `parent()` walks.

### Owners diverge per tier

Each tier in tty's chain was authored by a different player. Owners I saw:

- `#2` — `$player`, builder, programmer (likely an original wizard)
- `#15` — Additional Features (#7069)
- `#47` — Frand's PC
- `#2487` — Mail Recv, Citizen
- `#2612` — Super_Huh, Eval-hacked PC
- `#3920` — Politically Correct…
- `#4292` — Experimental Guinea Pig, also owns `$help`. This is **Rog**.
- `#6349` — generic builder
- `#33119` — Detailed PC
- `#54879` — GPS
- `#57140` — the three Sick PCs (all SSPC layers — single author)

So community-built classes accumulate, each owned by its author. Permission
to extend the inheritance graph is implicit (you can `@chparent` your own
fertile class) but writing into someone else's class requires being the
owner or wizard.

### `f` flag tells you it's a real class

Every player-class object has flag `f=1` (fertile — children allowed) and
`r=1` (readable). Guest is `f=0` — generic guest is not meant to be
inherited from; guests are direct children. Players themselves are `f=0`,
`r=0` typically.

### Verb counts under-state effective surface

The cumulative numbers above count distinct verb-definition objects, not
distinct verb names. Many tiers OVERRIDE a parent's verb (`tell`,
`notify`, `my_huh`, `confunc`, `disfunc`, `description`, `look_self`,
`receive_page`, `moveto`, `acceptable`). Each override changes behaviour
without adding to the user-visible command list. The actual command
surface is closer to "every verb name that resolves on `me`" — needs a
walk via `$object_utils:all_verbs(me)` to enumerate properly.

## Open questions

- Whether any tier's verbs are effectively dead code (overridden by every
  living descendant). Would need a tier-by-tier override-shadow analysis.
- The full guest lifecycle: who calls `do_reset`, when, and what state
  survives a disconnect (the `mail_catch_up` verb suggests mail is read
  but discarded; not verified).
- Whether `f=1` `r=1` on a class lets any player `@chparent` to it, or
  whether the class owner must opt in. There is probably a
  `:acceptable_chparent_request` hook somewhere.
- Where the per-character class assignment happens. Is `@chparent` a
  builder verb that any builder can run on themselves, or wizard-gated?
  (We saw `@chparent` is on generic builder, so any builder can probably
  use it on objects they own — but on `me`?)
