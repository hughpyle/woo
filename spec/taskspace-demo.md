# Taskspace Demo

Taskspace is the smallest useful async coordination app: a shared space where
people and agents coordinate work through hierarchical projects/tasks,
requirements, statuses, messages, and references to artifacts.

## Goal

Show that Woo can host a durable, asynchronous coordination world with a UI that
is completely unlike Dubspace.

Taskspace should prove that `$space:call` is not a music-specific sequencer. It
is a general coordination primitive for ordered message passing.

## Core Requirement

The demo runs inside one minimal `$space`. The `$space` accepts calls/messages
and assigns monotonically increasing sequence numbers.

All task lifecycle changes are caused by sequenced calls. Current task state is
the materialized result of applying those calls. No global clock is required for
ordering.

## Surface

- One shared taskspace.
- Two actors: person, agent, or two guests.
- One project root.
- Three tasks in a hierarchy.
- Subtasks nested under at least one task.
- Requirement checklist per task.
- Status per task.
- Assignee per task.
- Message/activity timeline.
- Artifact reference list.

## Persistent State

- Task title and description.
- Parent task/project ref.
- Ordered child task refs.
- Task status: `open`, `claimed`, `in_progress`, `blocked`, `done`.
- Current assignee.
- Requirement items and checked state.
- Artifact refs: file path, URL, commit, note id, or external id.
- Task messages/comments.

## Calls

- `task:create(title, description)`
- `task:add_subtask(title, description)`
- `task:move(parent, index)`
- `task:claim()`
- `task:release()`
- `task:set_status(status)`
- `task:add_requirement(text)`
- `task:check_requirement(index, checked)`
- `task:add_message(body)`
- `task:add_artifact(ref)`

The exact verb names may change. The important requirements are:

- task/project structure is hierarchical
- breakdown into subtasks is a first-class operation
- each structural or status change is represented as a sequenced call through
  the taskspace

## Observations

- Task created.
- Subtask added.
- Task moved/reordered.
- Task claimed or released.
- Status changed.
- Requirement added or checked.
- Message added.
- Artifact attached.

## Observation Schemas

Each observation the taskspace emits has a defined payload shape:

| Observation | Payload | When emitted |
|---|---|---|
| `task_created` | `{task: obj, parent: obj \| null, title: str}` | After `:create_task` or `:add_subtask`. |
| `subtask_added` | `{parent: obj, child: obj, index: int}` | When a subtask is added to a parent task. |
| `task_moved` | `{task: obj, from_parent: obj \| null, to_parent: obj \| null, index: int}` | After `:move`. |
| `task_claimed` | `{task: obj, actor: obj}` | After `:claim`. |
| `task_released` | `{task: obj}` | After `:release`. |
| `status_changed` | `{task: obj, from: str, to: str}` | After `:set_status`. |
| `done_premature` | `{task: obj, unchecked: list<str>}` | Emitted alongside `status_changed` when a task transitions to `done` with unchecked requirements (soft-DoD). |
| `requirement_added` | `{task: obj, index: int, text: str}` | After `:add_requirement`. |
| `requirement_checked` | `{task: obj, index: int, checked: bool}` | After `:check_requirement`. |
| `message_added` | `{task: obj, actor: obj, body: str, ts: int}` | After `:add_message`. |
| `artifact_attached` | `{task: obj, ref: map}` | After `:add_artifact`. |

All observations include `type` and `source` (the taskspace itself). All are persistent (sequenced via the taskspace).

## Minimal Interactions

- Create three tasks.
- Add two subtasks under one task.
- Claim one task as an actor.
- Mark it in progress.
- Add a requirement.
- Attach one artifact reference.
- Add a message.
- Mark it done.
- See the ordered activity timeline update for all connected actors.
- Expand/collapse the task hierarchy in the UI.

## Not In This Demo

- Calendar scheduling.
- Priorities beyond status.
- Task dependencies.
- Cross-project linking.
- Search.
- Notifications.
- Rich permissions.
- External integrations.
- Configurable workflows.
- Full project-management UI.

## Hierarchy Rule

Every task belongs to exactly one parent: either the taskspace root or another
task. The hierarchy is a tree, not a DAG.

Completing a parent does not automatically complete children in the tiny demo.
Instead, parent status is explicit actor intent. UI may show derived rollups
such as "2/3 subtasks done," but rollups are observations/materialized views,
not hidden mutations.

## Domain Invariants

Concrete rules the implementation must enforce. Anything not listed here is
deliberately unconstrained.

### Move

`task:move(parent, index)`:

- `parent` may be `null` (move to taskspace root) or an `$task` in the same
  taskspace. Cross-taskspace move is not supported in the demo; raises `E_INVARG`.
- **No cycles.** `parent` must not be `task` itself nor any descendant of `task`.
  Walks the descendant set of `task`; on collision raises `E_RECMOVE`.
- `index` must be in `[0, len(target_subtasks)]` inclusive at the upper bound
  (so `index == len` appends). Out of range raises `E_RANGE`.
- The source location's subtask list (or root list) is updated atomically with
  the destination's. Because all tasks anchor on the taskspace, this is one
  host-local transaction.
- Move emits `task_moved {task, from_parent, to_parent, index}`.

### Claim

`task:claim()`:

- If `assignee == null`: succeeds, sets `assignee = actor`, sets `status = "claimed"`,
  emits `task_claimed`.
- If `assignee == actor`: idempotent no-op (no observation emitted; returns
  current task ref).
- If `assignee != null && assignee != actor`: raises `E_CONFLICT`.

There is no soft "request to claim" or "queue of claimants" in the demo —
claiming is first-come, first-served.

### Release

`task:release()`:

- Calling actor must be the current `assignee`, or have the wizard flag.
  Otherwise raises `E_PERM`.
- Clears `assignee` to `null`. Sets `status` to `"open"` *unless* status was
  `done` — a done-but-released task remains done; only the assignee role is
  cleared.
- Emits `task_released`.
- Reassignment to a different actor is not via `:release` + `:claim` (that
  has a race). Use `wiz:set_assignee(task, actor)` (wizard-only) for
  hand-offs that must be atomic.

### Status

`task:set_status(status)`:

- `status` must be one of the enum values: `open`, `claimed`, `in_progress`,
  `blocked`, `done`. Other strings raise `E_INVARG`.
- The runtime does not forbid any transition. Any-to-any is permitted.
  `claimed` is normally set by `:claim`; setting it explicitly via
  `:set_status` is permitted but unusual.
- Soft-DoD: on transition to `done` with unchecked requirements, emits
  `done_premature` *in addition to* `status_changed`. The status change still
  applies. (See "Definition of Done" above.)

### Requirements

`task:add_requirement(text)`:

- Appends `{text, checked: false}` to `requirements`. No length limit on `text`
  beyond the value-model max ([values.md §V9](semantics/values.md#v9-size-limits)).
- Emits `requirement_added {task, index, text}`.

`task:check_requirement(index, checked)`:

- `index` must be in `[0, len(requirements))` (exclusive upper bound here, since
  this references an existing item, not an insert position). Out of range raises
  `E_RANGE`.
- Sets `requirements[index].checked = checked`. Idempotent if already at that value.
- Emits `requirement_checked`.

Removing requirements is not in the demo. Mark with a checked-strikethrough in
the UI if needed.

### Comments

`task:add_message(body)`:

- Open to any actor with presence in the taskspace. Comments are social
  commentary; gating them defeats the timeline as a coordination tool.
- Stored as `{actor, ts, body}`; `actor` is the calling actor, `ts` is the
  ms epoch at apply time.
- `body` is plain text in first-light. Markdown/rich-text deferred.
- Emits `message_added`.

Comments are not editable or deletable in the demo. The audit trail is the value.

### Artifacts

`task:add_artifact(ref)`:

- Open to any actor with presence in the taskspace. Reviewers and observers
  routinely attach artifacts.
- `ref` must be a map matching the artifact-ref shape below; otherwise
  `E_INVARG`.
- Emits `artifact_attached`.

Removing artifacts is not in the demo.

### Artifact reference shape

```
{
  kind:       str,        // one of the kinds below
  ref:        str,        // kind-specific identifier
  label?:     str,        // optional human-readable label
  added_by?:  obj,        // filled by the runtime on add (calling actor)
  added_at?:  int         // filled by the runtime on add (ms epoch)
}
```

Recognized kinds for first-light:

| `kind`     | `ref` format                          | Example                     |
|---|---|---|
| `file`     | path or relative URI                  | `"/spec/values.md"`         |
| `url`      | absolute URL                          | `"https://example.com/x"`   |
| `commit`   | `repo@hash`                           | `"woo@01a2b3c"`             |
| `note`     | internal note objref                  | `"#01HXYZ..."`              |
| `task`     | objref of another task (cross-link)   | `"#01HXYZ..."`              |
| `external` | opaque external identifier            | `"linear:WOO-42"`           |

Implementations may add custom kinds; an unrecognized kind is preserved as-is
and the UI falls back to displaying `ref` literally.

### Permissions summary

| Verb                      | Who can call                         |
|---|---|
| `:create_task`, `:add_subtask` | Any actor with presence.        |
| `:move`                   | Current assignee, or wizard.         |
| `:claim`                  | Any actor with presence (success depends on current assignee). |
| `:release`                | Current assignee, or wizard.         |
| `:set_assignee`           | Wizard-only.                         |
| `:set_status`             | Any actor with presence. Soft-DoD provides social pressure, not enforcement. |
| `:add_requirement`, `:check_requirement` | Any actor with presence. |
| `:add_message`            | Any actor with presence.             |
| `:add_artifact`           | Any actor with presence.             |

This is the demo's open default. Projects that want stricter rules apply the
per-claimer-update pattern from
[identity.md §I7.1](semantics/identity.md#i71-the-per-claimer-update-pattern)
with whichever fields fit.

## Definition of Done

The requirements list is the task's definition of done. The runtime does not
gate `set_status("done")` on requirements being met; the actor's intent to mark
complete is honored. But if any requirements are unchecked when `done` is set,
the runtime emits a `done_premature` observation alongside the status change,
listing the unchecked items.

This is **soft enforcement**: the activity timeline shows "marked done with N
unchecked requirements," and the UI can warn or display this prominently. Hard
enforcement (raise `E_PRECONDITION` instead of emitting a warning) is an opt-in
flag per task or per project, not built into the tiny demo.

The reasoning: aspirational requirements are normal early in a task's life;
rigid gates would force premature checklist construction. The soft form
records intent without blocking it.

## Roles and Authority

The tiny demo has one role: `assignee` (set by `claim`, cleared by `release`).
Real-world taskspaces add whatever roles the project needs by setting
actor-typed properties on the task and checking them in verb bodies. There is
no built-in role taxonomy.

Three concrete patterns:

- **Reviewer.** Set a `reviewer: obj` property and write a `task:review(verdict)`
  verb that checks `progr == this.reviewer`. Flips the task to a project-defined
  status (`reviewed`, `accepted`, whatever); emits a review observation.
- **Watchers.** A `watchers: list<obj>` property; an `:on_status_changed`
  handler iterates and emits a notification observation to each. No permission
  gating — watchers receive but don't act.
- **Requestor.** A `requestor: obj` property set once at creation, never gated
  for permission. Surfaced in the UI for context; doesn't constrain behavior.

The pattern is the per-claimer check from
[identity.md §I7.1](semantics/identity.md#i71-the-per-claimer-update-pattern)
generalized: any actor-typed property can become a role, and any verb can gate
itself on `progr` matching that property. The platform permits; it does not
prescribe.

This is what lets the skeleton stay skeletal while still being usable for real
work — a project that needs verifier-gated done adds a `verifier` property and
a `task:verify` verb. A project that needs requestor-tracking-without-gating
adds a `requestor` property and reads it in the UI. None of these add runtime
machinery; they are all just object data and verb code.

## Why This Demo Exists

Dubspace proves live shared control. Taskspace proves durable async
coordination.

Together they show the platform breadth:

- Dubspace: low-latency, sensory, shared UI state.
- Taskspace: long-lived, inspectable, agent-friendly coordination state.

The two demos should share the same core mechanism: actors make `$space:call`
requests, T0 VM bytecode applies them, and observations explain what changed.
