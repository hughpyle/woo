# Debugging

> Part of the [woo specification](../../SPEC.md). Layer: **tooling**. Profile: **v1-ops**.

The contract for inspecting a verb's execution beyond `:on_$error` observations: stepping through bytecode, examining frames, comparing pre/post state, replaying sequenced calls with breakpoints.

This is what makes the minimal-IDE useful for non-trivial debugging once worktrees give developers a sandbox to fail safely in.

---

## D1. The minimum useful debugger

Three capabilities:

- **Stepping.** Pause inside a verb, advance one bytecode op (or one source line) at a time, see state change between each.
- **Breakpoints.** Pause execution at a chosen line or opcode; resume on demand.
- **Replay.** Re-run a sequenced call from the live log against current code, with stepping/breakpoints, *without affecting live state*.

The first two are useful while writing code. The third is what makes "I shipped a bug, why does seq 12345 produce wrong state?" tractable.

---

## D2. Where debugging happens

Debugging runs against a **sandbox** ([worktrees.md](../operations/worktrees.md)). Live spaces are not paused; live actors are not affected. A debugging session attaches to a sandbox-bound runtime, takes a sequenced call (newly issued or replayed from the log), and steps through it in isolation.

This is why worktrees are a prerequisite. Without sandboxes, debugging would either pause live (unacceptable) or run against a copy of state that isn't reproducible (useless for reproducing bugs).

---

## D3. Wire surface

Debugging extends the wire protocol with frames that are not part of first-light. These are part of the developer wire (post-first-light, alongside the credentialed auth flows in [auth.md](../identity/auth.md)).

```ts
// Client → server (against an attached sandbox).
{ op: "debug_attach",          sandbox: ObjRef }
{ op: "debug_set_breakpoint",  verb: ObjRef, name: str, line?: int, op_index?: int }
{ op: "debug_clear_breakpoint",verb: ObjRef, name: str, line?: int, op_index?: int }
{ op: "debug_run",             id: str, target_call: { space, message } }
{ op: "debug_step",            id: str, kind: "op" | "line" | "verb_in" | "verb_out" }
{ op: "debug_continue",        id: str }
{ op: "debug_pause",           id: str }
{ op: "debug_replay",          id: str, space: ObjRef, seq: int }
{ op: "debug_inspect",         id: str, what: "frame" | "stack" | "locals" | "this" | "diff" }
{ op: "debug_eval",            id: str, source: str }   // expression eval against current frame
{ op: "debug_detach",          id: str }

// Server → client.
{ op: "debug_paused",          id: str, state: DebugState }
{ op: "debug_resumed",         id: str }
{ op: "debug_completed",       id: str, result: ApplyResult }
{ op: "debug_breakpoint_hit",  id: str, breakpoint, state: DebugState }
{ op: "debug_inspection",      id: str, what, value: Value }
{ op: "debug_error",           id: str, error: ErrValue }
```

`DebugState` captures the current paused state:

```ts
{
  call:        { space, message, seq },
  frame: {
    obj:       ObjRef,
    verb:      str,
    definer:   ObjRef,
    pc:        int,
    line?:     int,
    locals:    Map,
    stack:     Value[]
  },
  call_stack:  Frame[],            // bottom = entry; top = current
  observed:    Observation[]       // observations emitted before the pause point
}
```

Breakpoints are scoped to the debug session. They do not affect other sessions on the same sandbox. Breakpoint state is ephemeral — reattaching means re-setting breakpoints.

---

## D4. Stepping

Step kinds:

- **`op`** — execute the next bytecode op; pause again.
- **`line`** — execute until the next source line (when source is available); pause.
- **`verb_in`** — execute until the next verb call; pause inside the called verb.
- **`verb_out`** — execute until the current frame returns; pause in the caller frame.

Stepping is single-task, single-frame. Other tasks on the sandbox proceed normally.

---

## D5. Inspection

`debug_inspect` returns structured values, not console text:

- **`frame`** — the current frame's full state (locals, stack, this, actor, message, seq).
- **`stack`** — the call stack root-ward (each frame's verb identity + line).
- **`locals`** — just the local variable map.
- **`this`** — the receiver's properties as of the current debug pause.
- **`diff`** — the structured difference between pre-call snapshot and current state.

`debug_eval` runs a small expression in the context of the current frame: variable references, property reads, simple arithmetic. Side-effecting expressions are rejected unless the session is in writable-eval mode (wizard-only). Read-only by default.

---

## D6. Replay debugging

Replay reconstructs an old sequenced call's execution:

1. Client issues `debug_replay { id, space, seq }`.
2. Sandbox loads the message at `(space, seq)` from the live log.
3. Sandbox restores its state to seq-1 (using the most recent snapshot ≤ seq-1, then replaying messages up to seq-1).
4. Sandbox runs the message under debugger control (paused at start, stepable).
5. The client steps/inspects normally.

This requires the sandbox to be *seeded against live's history*, not just live's current state. The worktree primitive supports this: a "replay sandbox" is a worktree of scope=live with `base_seq=N-1`.

For very-old seqs, the sandbox must reconstruct from the latest snapshot ≤ N-1, then forward-replay up to N-1, then step through N. This is computationally expensive; the platform may rate-limit replay debugging.

---

## D7. Permissions

| Operation | Who |
|---|---|
| Attach to a sandbox | Worktree owner or wizard. |
| Attach to a live space | Not supported. Debugging is sandbox-only. |
| Inspect verbs the debugger can read (`r` perm or owned) | Full source / locals / stack / line numbers. |
| Inspect verbs the debugger cannot read | Source and line numbers omitted; opcode-level stepping only; local *names* redacted (`local_0`, `local_1`, …); local *values* shown only if they're not opaque (e.g., refs and primitives shown; raw bytecode-internal values redacted). |
| Eval mode | Read-only by default; writable only for wizards. |

---

## D8. Audit

Every debug session is logged: who attached, to what sandbox/worktree, when, with what breakpoints. Eval expressions and inspection results are not stored (they're ephemeral); the fact-of-debugging is. This is the same audit shape as wizard actions (logged separately for review).

---

## D9. UI surface

The minimal IDE ([authoring/minimal-ide.md](../authoring/minimal-ide.md)) gains a debugging pane:

- Paused state shown structurally — frame, stack, locals, this.
- Breakpoint controls (set / clear at line or op).
- Step controls (op / line / verb_in / verb_out).
- Replay control (paste seq, hit replay).
- Eval input field.

The pane uses the same wire frames as a programmatic debugger; an agent-developer can drive the same protocol headlessly.

---

## D10. What's deferred

- **Concurrent multi-actor debugging.** Two developers debugging interleaved tasks on one sandbox. Out of v1; the protocol allows but the model isn't specced.
- **Time-travel debugging.** Step *backward* through ops. Heavy implementation; defer until step-forward is solid.
- **Watchpoints on properties.** "Pause when `this.foo` changes." Easy via property-value diff at op boundaries; not first-cut.
- **Conditional breakpoints.** "Break if `x > 5`." Possible via eval-on-pause-then-resume; defer.
- **Profiling.** Bytecode-op counts, time-in-verb. Different feature — lives in [observability.md](../operations/observability.md) when written.
