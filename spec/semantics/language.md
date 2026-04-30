# Type system and DSL

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**. Profile: **v1-core**.

Covers the runtime type system and the surface syntax of the verb language. The bytecode it lowers to is in [vm.md §8](vm.md).

---

## 6. Type system

Values are tagged. The runtime knows the following types:

| Type | Tag | Notes |
|---|---|---|
| `int` | `i` | 53-bit safe signed integer (v1; `bigint` later if needed). |
| `float` | `f` | IEEE 754 double. |
| `str` | `s` | UTF-8. |
| `obj` | `o` | Persistent objref. |
| `tref` | `t` | Transient objref. |
| `list` | `l` | Heterogeneous, 1-indexed (MOO convention). |
| `map` | `m` | String-keyed. JSON-shaped. |
| `err` | `e` | Tagged error value (see [builtins §20](builtins.md#20-errors)). |

Coercions are explicit (`tostr`, `toint`, `tofloat`, `toobj`). The arithmetic and comparison operators are type-polymorphic at runtime; mismatches raise `E_TYPE`.

`map` keys are strings only in v1. (MOO had no map; people abused alists. We do this right.)

Object refs compare by identity (`==` does pointer equality on the id). Lists and maps compare structurally.

---

## 7. DSL syntax

MOO-flavored, with curly braces and modern niceties. Async is implicit; there is no `await` keyword. Every `.` and `:` is a potential yield point — the compiler emits opcodes that the VM yields on if the target is remote.

### 7.1 Verb declaration

```
verb #room:look (this none none) rxd {
  player:tell(this.description);
  for thing in this.contents {
    if (thing != player && thing.visible) {
      player:tell("  " + thing.name);
    }
  }
}
```

The header is `verb` `<obj>` `:` `<name>` `(` `<arg-spec>` `)` `<perms>` `{` ... `}`.

- `<arg-spec>` is the MOO `(dobj prep iobj)` triple for command-line dispatch. Use `(this none none)` for verbs called only by program.
- `<perms>` is a subset of `r` (readable source), `w` (writable by non-owner), `x` (executable as a command), `d` (debug — errors abort task with traceback rather than returning `err`).

### 7.2 Statements

```
let x = 5;
const name = "alice";
x = x + 1;
this.foo = bar;

if (cond) { ... } else if (cond2) { ... } else { ... }

for x in list { ... }
for k, v in map { ... }
for i in [1..10] { ... }     // inclusive int range
while (cond) { ... }
break; continue;

return value;

try { ... } except err in (E_PERM, E_PROPNF) { ... } finally { ... }

fork(60) { player:tell("a minute later"); }
suspend(seconds);
let input = read(player);

observe(event);
emit(target, event);
```

`observe(event)` records an observation on the current invocation route. Inside a
sequenced call it lands in the applied frame; inside a direct call it is live
only. `emit(target, event)` records the same event with an explicit delivery
target.

### 7.3 Expressions

```
this.location.name           // chained property access; each `.` may yield
this:verb(arg1, arg2)        // verb call; may migrate task
$wiz:announce("hello")       // corename; resolves through $system
pass(arg1, arg2)             // call this verb's parent-chain version
[1, 2, 3]                    // list literal
{ "type": "say", "body": s } // map literal
@args                        // splat (in call args or list construction)
"hello, ${name}"             // string interpolation
typeof(x), tostr(x), toint(x)
```

Operators (precedence high to low):
```
.  :  [ ]   (member, verb, index)
- !          (unary)
* / %
+ -
< <= > >= == != in
&&
||
=            (assignment, only at statement level)
```

`.` and `:` are syntactically distinct: `.` is property access (data), `:` is verb call (dispatch). Both may yield.

`a[i]` indexes lists (1-based) and maps (by key). It is sugar for `index(a, i)`.

### 7.4 Comments

```
// line comment
/* block comment */
```

### 7.5 What is *not* here

- No `class` / `extends` (objects exist at runtime, no class system).
- No `function` declarations (the unit is a verb).
- No `async`/`await` (everything is implicitly suspendable).
- No `import` (verbs cannot pull in other modules in v1).
- No prototype manipulation.
- No `eval` (compilation is explicit via `setVerb`).
