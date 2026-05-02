# LambdaMOO help system

Notes from a live exploration of LambdaMOO (lambda.moo.mud.org, server v1.8.3+47)
via `moo-mcp`, character `tty (#112104)`, on 2026-05-02. Read-only access plus
`;eval`. No wizard bit.

## Invocation

The `help` command is a single verb on `$player (#6)` with the multi-name
pattern:

```
?* help info*rmation @help        any any any
```

So `help`, `?`, `info`, `infor*mation`, and `@help` all dispatch to the same
verb. Arg-spec is `any any any` — it captures the whole command line.

Verb logic (paraphrased):

1. Parse the topic from `verb`/`argstr` — handles both `help foo` and `?foo`.
2. `dblist = $code_utils:help_db_list()` — ordered list of help-DB objects,
   filtered by caller permissions.
3. `result = $code_utils:help_db_search(what, dblist)` — searches all DBs in
   priority order; returns `{db, topic}` on hit, `{$ambiguous_match, [...]}`
   on multiple matches, or empty on miss.
4. **Miss**: `$wiz_utils:missed_help(what, result)` records the request to
   a wizard-reviewed log, then notifies "Sorry, but no help is available...".
5. **Ambiguous**: notify the user with a columnized list of matching topics
   via `$help:columnize` + `$help:sort_topics`.
6. **Hit**: call `db:get_topic(topic, remaining_dbs)`. The remaining-DBs
   argument lets `get_topic` defer to a downstream DB.
7. Output is iterated line-by-line with
   `$command_utils:suspend_if_needed(0)` so long help pages don't blow the
   tick budget.

A `get_topic` return of `1` is a special signal that `get_topic` already
emitted its own output (the verb just stops).

## DB inventory

`$code_utils:help_db_list()` returns 16 objects (15 visible to non-wizards
in this MOO; `$wiz_help #1130` is filtered out). Search priority is the
list order — narrower DBs first, the catchall `$help` last.

| Topic-prefix    | Object  | Name                                   |
| --------------- | ------- | -------------------------------------- |
| `ssspc-index`   | #49901  | ssspc-index (player class)             |
| `sspc-index`    | #49904  | SSSPC Help Topics                      |
| `pc-index`      | #55502  | PC Player Class Help Topics            |
| `pcs-index`    | #16122  | Mostly Weird Player Class Help Topics  |
| `5803-index`    | #11525  | #5803 Help                             |
| `prog-index`    | #22999  | Programmer Help Topics (`$prog_help`)  |
| `bb-index`      | #56204  | Blackbriar's Server Builtins Docs      |
| `builtin-index` | #6524   | Server Built-in Functions              |
| `core-index`    | #6800   | Core Utility Help Topics               |
| `builder-index` | #22977  | Builder Help Topics (`$builder_help`)  |
| `lmoo-index`    | #3223   | LambdaMOO-Specific Help Topics         |
| `Quota-index`   | #66616  | ARB and Quota Help Topics              |
| `frand-index`   | #89298  | Frand's Player Class Help Topics       |
| `mail-index`    | #6086   | Mail System Help Topics                |
| `gen-index`     | #145    | General Help Topics (`$help`)          |

`full-index` is not a DB; `$help:find_full_index_topic` aggregates from every
DB on demand. `$wiz_help (#1130)` is directly readable as a property of `#0`,
so a non-wizard can still see its topic count (52) and walk it explicitly —
it's just hidden from the default search.

All concrete DBs inherit from `Generic Help Database (#10002)`, which defines
the dispatch logic: `find_topics`, `get_topic`, `sort_topics`, `columnize`,
`forward pass`, `subst`, `index`, `verbdoc`, `objectdoc`, `find_index_topics`.

Topic counts on the main DBs:

- `$help (#145)` — 121
- `$prog_help (#22999)` — 74
- `$builder_help (#22977)` — 51
- `$wiz_help (#1130)` — 52

## Topic storage

A help topic is a **property** on a help-DB object. The property name *is*
the topic name (case-sensitive; `@`-prefixed for admin commands; can contain
dashes/underscores).

Property value has two shapes:

1. **Static text** — list of strings, one element per output line. E.g.
   `$help.help` is a 19-element list with the docs on the `help` command.
2. **Forwarder** — list whose first element matches `"*verbname*"`.
   `get_topic` strips the asterisks and calls `this:(verbname)(rest, dblist)`.
   This is how dynamic help works (verbdoc, generated indices, computed
   indexes etc.).

### Override slot convention

When a child DB needs to redefine a topic that already exists on its parent,
it stores the override at `" <topic>"` (space-prefixed). `get_topic`'s
algorithm:

```moo
if (`$object_utils:has_property(parent(this), topic) ! ANY')
  text = `this.(" " + topic) ! ANY';
else
  text = `this.(topic) || this.(" " + topic) ! ANY';
endif
if (typeof(text) == LIST && text[1] == "*<verb>*")
  text = `this:(verb)(rest, dblist) ! ANY';
endif
return text;
```

Example: `$help.index` is `{}` (vestigial), but `$help." index"` is the
real override that fires when the parent (#10002) defines `index`.

### Lookup matching

`find_topics`, beyond exact match, tolerates:

- `@`-prefix coming or going (`who` matches `@who`).
- Dash/underscore confusion (`add-ent` matches `@add-entrance`).
- Prefix matches on the topic-property names.

If the search string is empty or just `@`, it returns `{}` rather than
"everything", to avoid accidental floods.

## Indexes

Every DB has a `find_index_topics` verb returning a list of topic-property
names that act as section headers. `$help:index_list` walks every DB and
assembles the global table-of-contents that `help index` displays.

`$generic_help_db:verbdoc` and `:objectdoc` synthesize help text from a
verb's leading-string comments — i.e. lines like `"This verb does X."` at
the top of a verb body. So new programmer/builder verbs get help "for free"
without ever writing to a DB, as long as the source has doc-comments.

## Permissions and editing

- `$help` has flags `r` only — readable to all, writable only by the owner.
  Owner: **Rog (#4292)**, a wizard. Other DBs follow the same pattern with
  their own owners.
- Verbs on the help DBs are typically read-protected (`+x -r`); the leading
  string `"WIZARDLY";` in their bodies is the LambdaCore convention
  announcing they run with wizard perms.
- **There is no `@addhelp` admin verb.** Editing is direct:
  - `@notedit $help.<topic>` — generic note editor on `$player`, opens an
    in-band multi-line editor for any list-of-strings property the caller
    can write.
  - `;$help.(<topic>) = {<lines>}` — direct property assignment in eval.
  - `@property $help.<topic> {}` first, if the property doesn't yet exist.
  Authority requires either being the DB's owner or a wizard.

### Workflow

1. User types `help foo`, no match.
2. `$wiz_utils:missed_help(what, result)` records the miss to a wizard-side
   log.
3. A wizard or the DB owner periodically reviews and adds topics via
   `@notedit`.
4. For new verbs that ship code, the canonical pattern is to put help into
   leading-string comments and let `verbdoc`/`objectdoc` surface it
   dynamically — no DB write needed.

So practical edit authority sits with: each DB's owner (Rog for `$help`)
and any wizard (universal write). No regular player or programmer can edit
the curated help, even with the programmer bit. The only player-side help
authoring is the verb-comment route, surfaced on demand.

## Things still unknown

- The exact ordering rules in `$code_utils:help_db_search` when multiple
  DBs claim the same topic (we know narrow → broad, but the tie-breaker
  inside the same priority tier wasn't traced).
- The shape of the `$wiz_utils:missed_help` log — where it's stored, how
  often it's reviewed, retention.
- Whether DBs other than `$wiz_help` are filtered for non-wizards. The
  `help_db_list()` verb is wizardly, so it could in principle filter
  arbitrarily, but only `$wiz_help` was missing from the list we saw.
