# LambdaMOO games (background)

A casual sweep on 2026-05-02 to see what game infrastructure exists.
Background only — not load-bearing for woo's design.

## Headline

**There is no `$game` class.** No corified ancestor, no help topic for
"games", no central registry. Games are entirely community-built bespoke
objects, each with its own custom verb surface. The closest thing to a
shared abstraction is the **Fun Activities Board** in the Living Room
(see `lambdamoo-mail-and-boards.md`), which is just a `$note` bulletin
board listing places to go and `@go #N` shortcuts.

Discovery happens through three channels:

1. The Fun Activities Board (#55518) — the canonical "where do I go"
   directory.
2. Per-area mailing lists (`*cowsino` for casino updates, etc.).
3. Word of mouth, room descriptions, the in-Living-Room `read map`.

## Two structural shapes

### Object-based games

A `$thing` (often `$note`-derived for text state) carrying its own
rules and verbs. Pickable, placeable, fungible. Found scattered in the
Dining Room (#?) which holds ~30:

| Game | Object | Class | Notable verbs |
| --- | --- | --- | --- |
| Mastermind Board | #774 | $note-derived | `randomise`, `code`, `peek`, `guess <XXXX> on board` |
| Frand's chessboard | #393 | bespoke | `place`, `white`/`black`/`either`, `move/play`, `clear`, `setup`, `undo`, `inform/call/send/speak` (for play-by-message) |
| Rubik's Cube | #30046 | "Frand's generic magnetic thing" | (movable-pieces puzzle generic) |
| Crazy 8-Ball | #32619 | $thing (touch-based) | `shake` → fortune from a table |
| zoologist | #15346 | bespoke | `tell <X> to it`, `reset`, `about`, `statistics` — interactive 20-questions learner |
| Wooden Chest of Games | #36153 | Generic Transparent Container | nests Marsh's Chessboard, Leap of the Locust Puzzle, Rubberband Box, Goggle Bag, Etch-a-Sketch, Paper Bag |

Plus: Acquire, Set Game, Quarto, Number puzzle, Twister, Iron Puzzle,
Moonopoly, Clue, UpWords, Ghost game, backgammon/reversi/gess/go boards,
Scrabble, PenteSet, Snap's connect-4, Solitaire, Scavenger Hunt List,
blackbox, Game of Hearts, word guessing game, Frand's mind bender (with
Rog's accompanying solver).

### Place-based games

A `$room` (often a small graph of rooms) where the room IS the game.
Examples I sampled:

| Place | Object | What |
| --- | --- | --- |
| Game Room | #70339 | "MOOsterMind" (modern Mastermind reimplementation) + "War" |
| Underground Cowsino | #1249 | Full casino: keno, slots, roulette, blackjack, baccarat, craps, video poker, "Cowsino War" video game; vending machine, cashier, NPC dealers (Leila/Bruno); buy-chips link to "First Lambda Bank"; `*cowsino` mailing list for updates |
| Catacombs | reached from LR via `nw s s sw se s sw d s` | Twisty-passages style puzzle; partially guest-completable; explicitly blocks beige/pink/ruddy/crimson/brown guest colors |

### Mixed / community-built

Sushi Paradise, Slak's "Island of the Gods", Yib's Guide, jlamothe-built
spaces — each is its own room-graph with whatever mechanics the author
chose.

## Patterns

### Reimplementation over reuse

Two independent Mastermind implementations exist (Gary_Severn's #774 in
the Dining Room and Phobos's #7011 in the Game Room), with subtly
different rules — the Dining Room one comments *"Some people think this
is wrong. --yduJ"* about its scoring of duplicate colors. **Nobody
factored a `$mastermind_generic`.** This is the LambdaMOO economy: each
game-author owns their game outright; sharing is by example, not by
parent class.

### "Make a player class to access a game" is rare

Games gate on object-presence (you need to be in the room with the
chess board) or on guest-color allowlists (the Catacombs blocks brown
guests). They don't gate on player class. So unlike `@morph` (SSPC-only)
or `@program` (programmer-only), gameplay is open to anyone who can
walk to the right place.

### Bulletin board → mailing list → physical room

The de-facto game-discovery protocol:

1. Build the room (`@create $room` or descendants).
2. Build the game objects, drop them in.
3. `@create $mail_recipient` for community updates; `@subscribe with
   notification` for early adopters.
4. `@notedit` a $note describing the activity, drop it on the Fun
   Activities Board with `post note on board`.

### Some games use the editor stack for setup

The Mastermind Board is a `$note` — its instructions are editable via
`@notedit`. Same for many puzzles where the rules text is part of the
object. So changing a game's rules doesn't require `@program` access if
the rules are text — the bulletin/note pattern carries through.

## Live demo

Cracked Gary_Severn's Mastermind in 5 guesses:

```
randomise mastermind board
guess GRYB on mastermind board   → 0 black, 3 white
guess YGBR on mastermind board   → 3 black, 0 white     (rotation)
guess PGBR on mastermind board   → 2 black, 1 white     (Y → P)
guess YGBO on mastermind board   → 2 black, 0 white     (R → O confirms R@4)
guess YGPR on mastermind board   → 4 black, 0 white     (B → P, won)
```

Five guesses for 6-color × 4-position mastermind is roughly average for
a careful player; the colors space is 1296.

Crazy 8-Ball asked about the future: *"I have no recollection of that
at this time, Senator."*

## Implications for woo (briefly)

The patterns aren't directly load-bearing — woo is building toward a
different shape — but a few takeaways:

- **Bespoke per-game verb surfaces are fine.** The cost of "no shared
  game framework" is low when each game's rules are simple and the
  per-game verb count is ≤20.
- **Discoverability sits outside the game** (FAB + mailing list).
  Worth thinking about whether woo wants centralised game discovery
  or per-instance promotion.
- **Containers as packaging** (Wooden Chest of Games) is a nice MOO
  convention — group related games into a transparent container, players
  see the contents at a glance.
- **Place-vs-object** is a real architectural choice. Single-object
  games are portable but limit interaction surface. Place-based games
  can use room verbs, multiple sub-rooms, NPCs, etc.

## Cross-references

- `lambdamoo-mail-and-boards.md` — the $note + bulletin-board substrate
  underneath the Fun Activities Board.
- `lambdamoo-living-room-map.md` — Living Room is the FAB's home and
  the entry to most game-spaces.
- `lambdamoo-editors.md` — `@notedit` edits the rule-text on note-based
  games like Mastermind.
