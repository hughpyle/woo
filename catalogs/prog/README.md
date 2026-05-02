# prog — programmer tooling catalog (draft)

This directory holds the design for the `prog` catalog: the developer-experience
surface for actors with the programmer flag. The manifest is a draft — see
`manifest.draft.json`. It is **not** picked up by the bundled-catalog index
(which scans for `manifest.json` only), so adding this directory does not
affect the deployed runtime.

## Promotion path

The catalog ships once these are in place:

1. **Engine builtins**, all gated on the calling actor's programmer/wizard flag
   and object ownership. Do not use the wrapper verb's `progr` as authority:
   when this catalog is installed by `$wiz`, `progr` is `$wiz` for every
   wrapper call, regardless of the actor using the tool.
   - `prog_create_object(parent, opts)`
   - `prog_chparent(id, parent)`
   - `prog_recycle(id)`
   - `prog_property_op(id, name, value, opts)` (see `mode` enum in the manifest)
   - `prog_install_verb(id, name, source, opts)`  — refuses `opts.perms`
   - `prog_compile(source)`
   - `prog_inspect(id, opts)` — bundled introspection with caps
   - `prog_resolve_verb(id, name)` — walk + source
   - `prog_search(query, opts)` — index-backed
   - `prog_trace(id, verb, opts)` — v1.1
2. **LambdaCore-aligned command semantics**:
   - public prog wrappers behave like LambdaCore's `set_task_perms(player)`:
     the invoking actor is the programmer authority, not the catalog installer
   - object resolution/search is actor-scoped, like `player:my_match_object`;
     room matching must not be allowed to redirect programming targets
   - verb authoring preserves the conceptual split between `@verb`
     (metadata/arg spec) and `@program` (source install), even when MCP offers a
     combined `install_verb` convenience
   - verbs are ordered slots, not a name-keyed map; duplicate names are legal,
     name descriptors resolve to the first matching slot, and integer
     descriptors address a 1-based slot directly
   - property authoring preserves the split between `@property`, `@setprop`,
     `@clearproperty`, and `@rmproperty` through explicit `mode`
   - inspection borrows from `@show`, `@display`, and `@prospectus`: own vs
     inherited members, ownership, flags, location, contents, children,
     instances, and impact hints
3. **Inverse indexes** in the repository / Directory layer:
   - parent → children (so `inspect.children` is not a local-world walk)
   - feature → attached_to (so `inspect.attached_to` works for features)
   - search-token tables (verb name, verb source, property name, property value)
4. Move `manifest.draft.json` → `manifest.json`. The bundled-catalog index
   will pick it up; the install path runs the seed hook to create
   `the_prog`.

## Surface (10 verbs, all `tool_exposed`)

| verb | role |
| --- | --- |
| `inspect(id, opts?)`                            | Live call-tree shape: parents, features, children, instances, own + inherited verbs/properties, attached_to (for features). Caps configurable. |
| `resolve_verb(id, name)`                        | Where the verb actually resolves and the walk that got there. |
| `search(query, opts?)`                          | Bounded grep across name/verb/source/property channels; scopes are `actor_context`, `here`, `owned`, and `all`; default is actor-context, not global. |
| `create(parent, opts?)`                         | New object. `opts: {name?, description?, location?, fertile?}`. |
| `chparent(id, parent)`                          | Re-parent. |
| `recycle(id)`                                   | Destroy (own objects; wizards anything). |
| `set_property(id, name, value, opts?)`          | Define-or-update with explicit `mode`; split `expected_def_version` and `expected_value_version`. |
| `install_verb(id, name, source, opts?)`         | Compile + install. Source header is canonical for perms. |
| `compile(source)`                               | Diagnostics-only. |
| `trace(id, verb_name, opts?)`                   | Next-N-invocations VM trace. v1.1. |

Every public verb gates on `programmer` or `wizard` via `_assert_progbit`.
Engine builtins enforce the same checks; the verb-level gate just gives a
uniform `E_PERM` at the boundary.

## LambdaCore reference points

LambdaCore splits this area across `$builder` (`@create`, `@recycle`,
`@chparent`, `@setprop`, `@audit`, `@prospectus`) and `$programmer`
(`@verb`, `@program`, `@property`, `@chmod`, `@args`, `@rmverb`,
`@rmproperty`, `@list`, `@show`, `@display`, `@grep`, `@forked`, `@kill`,
`eval`). `the_prog` intentionally merges these into one MCP-reachable object
only as a user-interface convenience.

The key LambdaCore rule to preserve is target resolution. Virtual-world verbs
use the room's matching policy; programming verbs use the player's own matching
policy (`player:my_match_object`) because the room owner must not decide what
object a programmer edits. Woo's MCP tools receive objrefs directly, but
`prog_search`, future text aliases, and any name-to-ref helper must follow the
actor-scoped rule.

LambdaCore also treats source install as a two-step workflow: define the verb's
metadata (`@verb`) and then install code (`@program`). Verbs are addressed by
name for convenience or by 1-based verb number when duplicate names/arg specs
make a name ambiguous. MCP can present a single `install_verb` tool for the
common case, but the engine builtin still needs separate modes for define-only,
set-code-only, and upsert so agents do not accidentally rewrite metadata when
they meant only to reprogram a body. `prog_inspect` and `prog_resolve_verb`
surface `slot` so agents can switch from name descriptors to explicit slot
descriptors when they need LambdaCore-style precision.

## Reachability

The seed hook places `the_prog` with no `location` and no auto-focus. Agents
opt in with `woo_focus(the_prog)`. A future hook could focus the singleton
automatically when the programmer flag is granted, but that's out of v1 of
this catalog.

## What's deliberately not here

- **`eval` in v1**. LambdaCore's `$no_one` proves that powerless eval is useful,
  but it is a separate safety story. First ship compile/install against real
  verbs; add read-only or `$no_one`-style eval later if agents need it.
- **`profile`**. The metric stream already covers it; promote when an agent
  explicitly asks.
- **Refactor primitives** (`rename_verb`, `rename_property`). Dynamic dispatch
  makes "find callers" lossy; `search` is the honest substitute.
- **Bytecode disassembly**. `prog_compile` returns diagnostics and bytecode
  metadata only, not raw ops/literals. Add `prog_disassemble` if agents need
  VM-level debugging beyond source spans and traces.
- **Wizard/programmer flag changes**. Ordinary authorable flags such as
  `fertile` belong in the object-authoring primitive; privilege flags remain a
  wizard surface.
- **A workshop room**. Convention layer above the tools — programmers will use
  whatever room they like. Tools work the same in `the_chatroom`.
