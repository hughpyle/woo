# Authoring Plan

Tracks [`spec/authoring/minimal-ide.md`](../spec/authoring/minimal-ide.md).

## Scope

The first authoring slice is the minimal IDE loop:

1. inspect an object
2. edit one verb
3. compile without installing
4. install atomically with `expected_version`
5. make a structured test call
6. inspect observations, errors, and changed state

This is not a full builder, package manager, debugger, collaborative editor, or
full DSL implementation.

## Runtime Surface

Implement the semantic operations needed by the IDE:

- `:describe()` and introspection builtins from `spec/semantics/introspection.md`
- `compile_verb(obj, name, source, options?)`
- `set_verb_code(obj, name, source, expected_version, options?)`
- `set_verb_info(obj, name, expected_version, info)`
- `define_property(obj, name, default, perms, expected_version, type_hint?)`
- `set_property_info(obj, name, expected_version, info)`
- property value operations

`compile_verb` must be read-only. `set_verb_code` must check authority and
`expected_version`, compile, and install source + bytecode + metadata in one
host transaction.

Property definition edits use the same `expected_version` discipline as verbs.
For new properties, `expected_version` is `null`.

## T0 Source

Implement only the T0 source profile from the spec:

- verb headers
- args, locals, literals, maps, lists
- `this`, `actor`, `space`, `seq`, `message`
- local property get/set
- `if` / `else`
- equality
- `observe(event)`
- `return`
- `raise`

Do not implement loops, `CALL_VERB`, `suspend`, `fork`, `read`, exception
handlers, imports, user functions, or the full language grammar in this slice.
T0 source cannot compose by calling other verbs; multi-step behavior composes as
multiple client-issued calls until the full VM profile exists.

## Bytecode Fallback

Support `t0-json-bytecode` as a raw developer fallback input format for
`compile_verb` / `set_verb_code`. It is not the primary IDE authoring mode. The
fallback must parse canonical JSON, validate the `TinyBytecode` object, and run
the same verifier as seeded fixtures before install.

## Diagnostics

Compiler diagnostics and runtime traces are structured values, not strings
written to console output. Preserve `line_map` on installed verbs so runtime
errors can point back to source when permissions allow.

Spans use 1-based lines and 0-based Unicode code-point columns.

## Client

The browser IDE can be plain:

- object browser
- object inspector
- verb editor
- call console
- observation/error panel

The client should call the same runtime operations an agent would call; do not
create a UI-only private authoring API.
