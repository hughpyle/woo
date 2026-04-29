# Task lifecycle

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**. Profile: **v1-core**.

Covers the task state machine, suspend across host eviction (the load-bearing test for the architecture), cross-host RPC continuations, fork, and read.

---

## 16. Task lifecycle and suspension

### 16.1 States

```
created → running → done
              ↓
          suspended (sleep timer)
              ↓
           running (alarm fires)

          awaiting_read (event from player)
              ↓
           running (input arrives)

          awaiting_call (cross-host RPC out)
              ↓
           running (RPC reply)
```

### 16.2 Suspend across host eviction

`SUSPEND seconds`:
1. Serialize `Task` to JSON (frames, locals, stacks, handlers, principal fields).
2. Insert/update row in `task` with `state='suspended'`, `resume_at = now + seconds*1000`, `serialized = blob`.
3. Set the host's scheduler alarm to `min(resume_at)` over all suspended tasks.
4. Yield from VM. The host may hibernate.

When the alarm fires:
1. Host wakes (persistent storage available, no in-memory state).
2. Read all tasks where `resume_at <= now`.
3. For each: deserialize, resume execution.

This is the load-bearing test for the architecture; it must work for `seconds = 86400 * 365`.

> **Open question:** the design here is straightforward but needs empirical validation against the runtime's alarm-after-hibernate behavior — particularly that alarms set across multi-day boundaries fire reliably and that hibernated state is fully reconstructible from persistent storage alone. First runtime task: write a test that suspends for 24h+ and verifies resume. See [LATER.md](../../LATER.md).

### 16.3 Suspend across cross-host RPC

`CALL_VERB` to remote obj:
1. Frame state serialized.
2. RPC sent to receiver host with `{frames: [...], args, target, name, correlation_id}`.
3. Receiver creates a new task with the migrated frame as bottom frame, runs to completion.
4. On return: receiver RPCs `{correlation_id, result}` back.
5. Originating host: deserialize task (it was stored with `state='awaiting_call'`), push result onto its top frame's stack, resume.

If the originating host is hibernated when the reply arrives, the reply is queued by the runtime; host wakes; resume. Idempotency on retry is per [protocol/hosts.md §3.4](../protocol/hosts.md#34-task-migration-invariants) — a duplicate reply with the same correlation id is dropped.

### 16.4 Killing tasks

`kill_task(task_id)` (a builtin, wizard or owner only) sets the task state to a terminal state and deletes the row. Any in-flight RPC reply is discarded on receipt.

### 16.5 Forked tasks

`FORK seconds verb_obj verb_name args` spawns a new task on the *same* host (the forking object's). The forked task gets:
- Fresh activation stack with one frame for the named verb call
- `progr` = forking verb's `progr`
- `player` = forking task's `player` (sticky)
- `caller` = `#-1`
- Fresh tick budget

If the forking object is recycled before the timer fires, forked tasks are killed.

### 16.6 Read tasks

`READ player`:
1. Task state → `awaiting_read`, `awaiting_player = player`.
2. When the next input event arrives for that player, the player host finds the task awaiting and resumes it with the input value on the operand stack.

Multiple tasks awaiting reads on the same player are queued; first-in-first-out.

### 16.7 Fork and suspend caps

Suspended-task hoarding is bounded at the task and object level here; per-owner caps are part of storage quota in [permissions.md §11.7](permissions.md#117-storage-quotas-and-accounting).

| Level | Default | Description |
|---|---|---|
| Per-task fork budget | 100 forks per parent task | A single verb invocation cannot fork more than this many child tasks. |
| Per-object live-fork cap | 1000 active parked tasks | A single object cannot host more parked forks than this. |

`FORK`/`SUSPEND` over any cap raises `E_QUOTA`. The currently running task is unaffected; only further parking operations fail. `SUSPEND` shares the per-object cap but has no per-task budget — a verb body can suspend itself once per call without restriction.

Caps are tunable per-world via `$server_options.fork_quota_*`.
