# Builtins and errors

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**. Profile: **v1-core**.

Sketch of the v1 builtin function set (registered with stable indices for the `BUILTIN` opcode) and the canonical error catalogue.

---

## 19. Builtins (sketch — not exhaustive)

Builtins are functions, not verbs. They are registered with stable indices for the `BUILTIN` opcode. The list will grow; v1 minimum:

### 19.1 Core

`tostr(v)`, `toint(v)`, `tofloat(v)`, `toobj(v)`, `typeof(v)`, `length(v)`,  
`is_a(obj, parent_obj)`, `parents(obj)`, `children(obj)`,  
`now()` → ms epoch, `ftime()` → high-res wall time,  
`raise(err)`, `random(n)`.

### 19.2 String

`strsub(s, from, to)`, `index(s, sub)`, `rindex`, `match(s, pattern)`, `pcre`,  
`tolower`, `toupper`, `trim`, `split(s, sep)`, `join(list, sep)`,  
`encode_json(v)`, `decode_json(s)`.

### 19.3 List / map

`listappend`, `listinsert`, `listdelete`, `setadd`, `setremove`,  
`mapkeys`, `mapvalues`, `mapdelete`, `mapmerge`.

### 19.4 Object

`create(parent, owner)`, `recycle(obj)`, `chparent(obj, new_parent)`,  
`compile_verb(obj, name, source, options)`,  
`set_verb_code(obj, name, source, expected_version, options)`,  
`set_verb_info(obj, name, expected_version, info)`, `verb_info`, `verb_args`,  
`define_property(obj, name, default, perms, expected_version, type_hint)`,  
`set_property_info(obj, name, expected_version, info)`,  
`delete_property(obj, name, expected_version)`, `property_info`, `properties(obj)`, `verbs(obj)`,  
`move(obj, new_location)`.

The authoring-facing contract for compile/install, expected-version conflicts,
and diagnostics is in [../authoring/minimal-ide.md](../authoring/minimal-ide.md).

`create()` is subject to a per-task creation budget (default 100 per verb invocation, raises `E_QUOTA`) and the per-owner storage quotas in [permissions.md §11.7](permissions.md#117-storage-quotas-and-accounting). It costs 50 ticks per call (host instantiation is not free). The owner's `created` list (a property convention on `$root_object`) is appended automatically; ops can iterate it for per-owner inventory.

There is intentionally no "list all objects in the world" builtin. Instance enumeration is by class via recursive `children($class)`; per-owner enumeration is by convention (creator maintains a list). Ops-level host enumeration uses the runtime's management plane, not the runtime API.

### 19.5 Task / scheduling

`task_id()`, `task_perms()`, `kill_task(id)`, `tasks(player)`,  
`set_task_local(key, val)`, `get_task_local(key)`.

`tasks(player)` is local to that player's DO. There is no global `queued_tasks()` — by the same principle as object enumeration, tasks aren't enumerable at world scale.

### 19.6 Events / IO

`emit(target, event)`, `subscribe(self, source, type)`, `unsubscribe`,  
`event_schema(obj, type)`, `declare_event(obj, type, schema)`.

### 19.7 Sessions

`connected_players()`, `connection_name(player)`, `boot_player(player)`,  
`notify(player, event)` — equivalent to `emit(player, event)`.

### 19.8 Wizard-only

`shutdown(reason)`, `dump_database()`, `load_database()`,  
`set_verb_perms`, `set_property_perms`,  
`task_stack(task_id)`, `disassemble(obj, verb)`.

---

## 20. Errors

`err` values are atoms:

| Code | Meaning |
|---|---|
| `E_NONE` | No error. |
| `E_TYPE` | Wrong type. |
| `E_DIV` | Division by zero. |
| `E_PERM` | Permission denied. |
| `E_PROPNF` | Property not found. |
| `E_VERBNF` | Verb not found. |
| `E_OBJNF` | Object not found. |
| `E_VARNF` | Variable not found / not bound. |
| `E_INVIND` | Invalid indirection (e.g., `nil:verb()`). |
| `E_RECMOVE` | Recursive move (object would contain itself). |
| `E_MAXREC` | Maximum recursion depth exceeded. |
| `E_RANGE` | Index out of range. |
| `E_ARGS` | Wrong number of arguments. |
| `E_NACC` | Not accepted (e.g., `:accept(what)` returned false). |
| `E_INVARG` | Invalid argument. |
| `E_CONFLICT` | State conflict (e.g., already claimed by another actor). |
| `E_PRECONDITION` | Required condition was not met. |
| `E_QUOTA` | Resource quota exceeded. |
| `E_FLOAT` | Floating-point exception. |
| `E_TICKS` | Tick limit exceeded. |
| `E_MEM` | Memory limit exceeded. |
| `E_INTRPT` | Task killed. |
| `E_GONE` | Transient ref no longer valid (host disconnected). |
| `E_TIMEOUT` | Deadline exceeded (task wall-time budget, cross-host RPC). |
| `E_NOSESSION` | Session token is expired or unknown. |
| `E_VERSION` | Bytecode version mismatch (cache stale). |
| `E_FED_DISABLED` | Federation not enabled (v1 single-world). |
| `E_FED_TIMEOUT` | Cross-world RPC timed out. |
| `E_FED_UNREACHABLE` | Peer world unreachable. |
| `E_FED_PROTOCOL` | Cross-world wire protocol mismatch. |
| `E_RATE` | Connection inbound rate limit exceeded. |
| `E_OVERFLOW` | Outbound queue overflow; client must recover by replay. |

An `err` value is a tagged map:

```
{ code: str, message?: str, value?: any }
```

`raise()` accepts either a code string (`raise("E_PERM")`) or a fully-formed err map (`raise({code: "E_PERM", message: "no can do", value: target})`). Handlers receive the full err map. Matching against `try ... except err in (E_PERM, E_PROPNF)` is by `code` only — `message` and `value` don't affect dispatch.

The runtime emits `err` values with `code` populated and a default `message` for the standard codes; `value` is null unless attached by the raiser.
