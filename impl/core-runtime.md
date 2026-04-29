# Core Runtime Plan

## Types

Implement explicit TypeScript types for:

- `ObjRef`
- `Value`
- `WooObject`
- `PropertyDef`
- `VerbDef`
- `Message`
- `SequencedMessage`
- `Mutation`
- `Observation`
- `SpaceState`
- `Actor`
- `Session`
- `ObjectDescription`

Keep these types free of Cloudflare imports.

Values must follow `spec/semantics/values.md`: tagged runtime types, canonical
JSON boundary encoding, structural equality for lists/maps, and replay-canonical
encoding for hashes/snapshots.

## Bootstrap

Implement the boot sequence from `spec/semantics/bootstrap.md` before demo
runtime work:

- idempotent Directory/corename creation
- universal classes (`$system`, `$root`, `$actor`, `$player`, `$wiz`, `$space`,
  `$thing`)
- Dubspace classes and `the_dubspace` anchored control objects
- Taskspace classes and `the_taskspace`
- guest player pool

The seed step must be rerunnable without mutating existing seeded objects.

## T0 VM Model

For the first build, object behavior runs in the T0 VM profile described in
`spec/semantics/tiny-vm.md`.

```ts
type TinyVm = (ctx: ApplyContext, bytecode: TinyBytecode, message: SequencedMessage) => ApplyResult;
```

Seeded bytecode verbs may:

- read objects
- write object properties through the context
- emit observations
- return values or fail

VM bytecode may not mutate repository internals directly. All state changes go
through the apply context so they can commit or roll back as one sequenced call.

The first bytecode corpus is the concrete fixture set in
`spec/semantics/tiny-vm.md`: root value/property helpers, Dubspace
`set_control`, and Taskspace claim/status behavior. T0 source compilation is
implemented later by the authoring slice; core execution should not require it.

## Introspection

Implement `$root:describe()` and the underlying read-only operations from
`spec/semantics/introspection.md`:

- `properties(obj)`
- `verbs(obj)`
- `parents(obj)`
- `children(obj)`
- `verb_info(obj, name)`
- `property_info(obj, name)`
- `declared_schemas(obj)`
- `event_schema(obj, type)`

These are required for Taskspace agents and the minimal IDE. They are not a
global object registry; enumeration starts from known roots, children,
contents, presence, or owner-maintained `created` lists.

## `$space`

`$space` stores:

- `id`
- `nextSeq`
- accepted message records

`call(message)`:

1. validates actor and target refs
2. checks that the actor may call through the space
3. assigns `seq = nextSeq` and increments `nextSeq`
4. stores the sequenced message
5. resolves the target verb bytecode
6. runs T0 VM bytecode inside the call transaction
7. commits mutations and observations on success
8. rolls back mutations/observations on behavior failure
9. returns an `applied` result, or a pre-sequence `error`

Validation and authorization failures do not advance `seq`. Behavior failures
keep the accepted message and emit one `$error` observation at that `seq`.

## Direct Messages

Direct non-space messages are allowed only for internal/bootstrap operations in
the first build. User-visible coordinated behavior should go through a space.

Authoring operations (`compile_verb`, `set_verb_code`, property definition
changes) are direct administrative object operations with `expected_version`
checks, per `spec/authoring/minimal-ide.md`.

## Error Policy

If message validation fails before sequencing, return an error and do not
increment `seq`.

If applying a sequenced message fails, keep the message record and emit an
error observation. This preserves sequence continuity while keeping durable
state deterministic.
