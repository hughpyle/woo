# MCP protocol

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**. Profile: **v1-ops**.

Model Context Protocol surface that lets an LLM agent inhabit a woo world. The agent connects, gets an actor, and from then on its tool list tracks its current location: in `the_chatroom` it sees `say`/`look`/`take`; if it walks to `the_dubspace` the toolset shifts to `set_control`/`save_scene`. The wire shape is standard MCP (tools, notifications); the woo-specific behavior is which tools materialize for which actor at which moment.

The two existing inbound surfaces — [wire.md](wire.md) (WebSocket) and [rest.md](rest.md) (HTTP+SSE) — target browser clients and HTTP integrations respectively. MCP is the third, oriented at LLM agents that need affordances they can introspect, dry-run, and call without prior knowledge of the world's object graph. All three protocols hit the same call/applied/observe semantics; they differ only in framing and discovery.

This spec assumes the MCP client supports dynamic tool lists (`notifications/tools/list_changed`). Clients that require a static manifest at connect time can still drive woo through whatever room verb the catalog provides as a parser entry point (e.g., `the_chatroom:command(text)`), but they lose the per-location structured-tool affordance and most of the value of this surface.

---

## M1. Connection model

```
agent ──(MCP)──► woo MCP gateway ──(internal)──► gateway DO / actor's host
```

One MCP connection binds to one woo session, which binds to one actor. The session is established the same way a REST or WS session is ([../identity/auth.md](../identity/auth.md)): the agent presents a token (`bearer:<...>`, `apikey:<...>`, or — for development — `wizard:<bootstrap-token>`), the gateway resolves it to a session and an actor, and that pair is the trust boundary for the duration of the connection.

- One actor per connection. Multi-actor multiplexing is not in v1-ops.
- The actor's `progr` is the permission identity for every tool call. MCP does not elevate authority; an agent connected as `$guest_42` can do exactly what a browser-attached `$guest_42` can do.
- Disconnect drops the connection. Whether the session survives follows the standard session-grace rule from [identity.md §I3](../semantics/identity.md#i3-session-lifecycle).

---

## M2. Tool surface

**There is no universal tool layer.** Every tool the agent sees is a verb on some object in its reachable scope. Common-feeling tools (`command`, `plan`, `look`, `wait`, `describe`) feel common because they come from common ancestors — `$space`, `$conversational`, `$actor` — and those ancestors are in scope from any catalog. New ancestors (a `$dubspace` the actor enters, a `$cockatoo` in the room) bring new verb-tools as their classes define them. The protocol does not curate a baseline; the world's class hierarchy does.

This means the MCP gateway is, mechanically, a thin shell around verb dispatch: enumerate reachable objects, filter their verbs, hand the list to the client.

### M2.1 Verb-to-tool mapping

For each object reachable from the actor (§M3), the gateway enumerates that object's verbs and exposes a tool for each verb satisfying **all** of:

- `direct_callable: true` ([../semantics/space.md](../semantics/space.md))
- `tool_exposed: true` (the per-verb opt-in flag — verbs without this are still callable via the room's parser if a parser verb routes there, but they don't get a dedicated tool)
- The actor passes `assertCanExecuteVerb` against the verb's perms ([../semantics/permissions.md](../semantics/permissions.md))

The tool's shape:

| MCP field | Source |
|---|---|
| `name` | `<object_handle>__<verb_name>` — see §M2.3 |
| `description` | The verb's docstring (first paragraph of `source` block comment, or empty). Followed by the canonical call form `<object>:<verb>(args)` and the alias list. |
| `inputSchema` | JSON Schema generated from the verb's `arg_spec`. Optional args become optional schema properties. Type hints from `arg_spec.types` map to JSON Schema types when available; otherwise `unknown`. |

The tool's behavior is: invoke the verb as a **direct call** with the actor's authority. Returns `{ result, observations }`. Errors map per §M6.

### M2.2 Common verbs ride on common ancestors

The "always-there" feeling of certain tools comes entirely from class inheritance:

| Tool the agent sees | Where it actually lives |
|---|---|
| `command(text)`, `command_plan(text)` | On the actor's current `$space` or attached `$conversational` feature. Every chatroom inherits these; agents in non-conversational spaces (e.g. dubspace) won't see `command` unless that space's catalog defines it. |
| `look()`, `who()`, `say(text)` | Same — `$conversational` feature verbs. They show up wherever that feature is attached. |
| `describe()` | On the actor itself (and on every reachable object) by virtue of `$root_object`. Always available because the actor is always in scope. |
| `wait(timeout_ms?, limit?)` | On `$actor` (§M4). Always available for the same reason. |
| `enter(target)`, `go(exit)`, `take(item)`, `drop(item)` | On `$chatroom` or whichever room class defines them. Available when the actor is *in* such a room. |
| `set_control`, `save_scene`, `recall_scene` | On `$dubspace`. Available when the actor has presence in a dubspace. |
| `create_task`, `claim`, `set_status` | On `$taskspace` or `$task`. Available when the actor has presence in a taskspace, plus per-task verbs become available as the agent reads them into scope (e.g., focuses on a specific task). |

The gateway does not construct any of these; it reads the verb tables.

### M2.3 Tool naming

Tool names use the form `<object_handle>__<verb_name>`:

- `object_handle` is the object's ULID for `#`-objects, or the corename without the `$` sigil for corename objects (`cockatoo__squawk`), or the local id for catalog-installed instances (`the_chatroom__say`, `the_lamp__take`).
- `verb_name` is the verb name verbatim (verbs cannot contain `__` by convention).

The canonical `<object>:<verb>` form (with sigils) is in the tool's `description`, so the agent always has the full handle for parser-mediated calls. Clients with stricter naming rules may sanitize further; the canonical handle in the description is authoritative.

### M2.4 Aliases

A verb's `aliases` list ([../semantics/space.md](../semantics/space.md)) is **not** rendered as separate tools — that would explode the tool list with duplicates. Aliases are documented in the tool description so agents that want to use them via the room's parser know what's available.

---

## M3. Reachability — what shows up where

The dynamic tool set at any moment is computed against the actor's **reachable scope**, the union of:

1. **Self.** The actor object — for actor-owned verbs (`@quit`, `@home`, `wait`, etc.).
2. **Current location.** `actor.location` and the verbs defined on it. In a chat room, this is where `:say`/`:look`/`:enter` come from.
3. **Location contents.** Objects in `actor.location.contents` for which the actor has read access. In `the_chatroom` this surfaces `the_cockatoo:squawk`, `the_lamp:take`, etc.
4. **Inventory.** Objects in `actor.contents`. After `take lamp`, the lamp's verbs follow the actor between rooms.
5. **Presence spaces.** Spaces the actor is subscribed to via `actor.presence_in`. This is how `the_dubspace` and `the_taskspace` show up in the tool list when the actor is "in" them — even when the actor is *physically* located in a chatroom that frames them. Presence is the woo notion of "I'm in this space" and it's what governs the tool list more than physical location does.
6. **Universal corenames.** A small fixed set: `$wiz` (read-only `:describe`), `$system` (read-only `:describe`). Excluded by default unless the actor is wizard.

The reachability set is recomputed after every tool call. If it differs from the previous set, the gateway sends `notifications/tools/list_changed`. Clients that tolerate stale tool lists for one turn can ignore the notification; clients that don't should re-list before their next decision.

Containment cycles and re-entrant rooms (a room as the contents of another room — see the chat catalog's hot tub) are walked once; the algorithm is a BFS bounded by the reachability set's natural boundary (objects not in any of the six categories above).

---

## M4. Observations: `$actor:wait`

External events (other actors moving, the cockatoo squawking on a fork, applied frames in subscribed spaces) reach the agent the same way they reach a browser — except agents act in turns, so push doesn't apply. The agent pulls.

`wait` is a verb on `$actor`. Because the actor is always in reachable scope (§M3.1), the tool is always available. Its shape:

```
$actor:wait(timeout_ms?: int, limit?: int)
  → { observations: [...], more: bool, queue_depth: int }
```

| Argument | Default | Notes |
|---|---|---|
| `timeout_ms` | `0` | Long-poll budget. If the queue is empty, blocks up to this many ms for the next observation. Returns immediately on first arrival. Capped at 30000. |
| `limit` | `64` | Maximum observations to return in one batch. Bounded by an implementation-defined hard ceiling (default 256). |

**Returns:**

- `observations`: up to `limit` queued observations, oldest first.
- `more`: `true` if the queue has additional observations waiting after this batch. The agent calls `wait` again (with `timeout_ms: 0`) to drain the next batch.
- `queue_depth`: number of observations remaining after this batch — informational, useful for the agent to size its next call.

### M4.1 The queue

The MCP gateway maintains a per-actor FIFO observation queue, populated by the same fan-out path that pushes `op:applied` and `op:event` to attached WebSockets ([wire.md §17.3](wire.md#173-server--client)).

- Bounded server-side at an implementation hard cap (default 4096). On overflow, the gateway inserts a single `{type: "observation_overflow", lost: N, since: <ts>}` marker in front of the queue and resumes appending. The agent treats this as a gap and may follow up with the appropriate space's `:replay(from, limit)` for true gap recovery on sequenced spaces.
- Persists for the connection lifetime. On reconnect, the agent resumes by calling `wait`.

### M4.2 What goes in the queue

The queue receives:

- **Applied frames** for spaces the actor has presence in — same fan-out as WS subscribers.
- **Direct events** addressed to the actor (`tell`, `told`, etc.).
- **Self-observations** the actor's own calls emit are returned in the **call's own response**, not queued. (The verb's body emits to `ctx.observations`; that array travels with the result.)

This means the agent never sees its own actions twice (once in the call result, again in `wait`). It only sees external events via `wait`.

### M4.3 Drain discipline

The agent decides when to drain:

- After each turn-shaping action, if it cares what others did meanwhile.
- Whenever it has nothing to do and wants to listen passively (`wait` with a non-zero `timeout_ms`).
- In batches when catching up after a long pause: repeated `wait(0, limit)` calls until `more: false`.

There is no implicit drain on other tool calls. Every observation the agent sees from someone else's action came from a `wait` call.

---

## M5. Trust and permissions

The MCP gateway is part of the woo deployment. Same-deployment trust ([../protocol/hosts.md §3.3](hosts.md#33-trust-model-across-hosts)) applies: the gateway has been authenticated to the cluster and forwards calls under the actor's `progr`.

- **Authentication.** Token-based, identical to wire and REST. v1-ops typically uses `apikey:<...>` for long-lived agents and `bearer:<...>` for short-lived OAuth flows.
- **Authorization.** Per-tool: `assertCanExecuteVerb(actor.progr, target, verb)` runs on every tool invocation. Failure is `E_PERM` per §M6.
- **`tool_exposed` is an opt-in, not authority.** A verb with `tool_exposed: true` is *advertised* to MCP; the actual call still goes through verb-x perms. A verb with `tool_exposed: false` is hidden from the tool list but reachable via the room's parser if a parser verb (e.g. `:command_plan`) routes there — same as a human typing the command. The flag is a discoverability filter, not a permission.

Wizard-only tools (e.g., `set_verb_code`) are exposed to MCP only when the actor is wizard. There is no separate "wizard MCP namespace"; wizard verbs simply pass the same perm check that runs everywhere else.

---

## M6. Errors

woo's failure model ([../semantics/failures.md](../semantics/failures.md)) is preserved on the MCP wire:

- A tool that raises a woo error returns an MCP `isError: true` content block whose JSON body is `{ code, message, value, trace }` — the same shape as the WS `op:error` frame.
- Common codes the agent should expect: `E_PERM` (verb-x denied), `E_INVARG` (bad args), `E_VERBNF` (verb gone — the world changed mid-turn), `E_OBJNF` (object recycled), `E_QUOTA`, `E_TIMEOUT`.
- Routing/transport errors (gateway unreachable, session expired) use MCP's standard error envelope with woo codes in `data` (`E_NOSESSION`, `E_GATEWAY`).

The agent's robustness contract: any tool may fail, including tools the agent saw seconds ago. The world is live; objects can be recycled and verbs rewritten between turns. The `tools/list_changed` notification is best-effort; the agent should treat `E_VERBNF` from a tool call as "re-list and try again" rather than as a fatal error.

---

## M7. Lifecycle

```
client → server: initialize { ... }
client ← server: initialize result, advertising tools
client → server: notifications/initialized

(later, repeated)
client → server: tools/list
client ← server: tools/list result (verbs reachable from current location)
client → server: tools/call { name: "the_chatroom__say", arguments: { text: "hi" } }
client ← server: tools/call result { content: [...] }

(when actor moves)
client ← server: notifications/tools/list_changed
client → server: tools/list (refresh)

(idle listening)
client → server: tools/call { name: "actor__wait", arguments: { timeout_ms: 10000 } }
client ← server: tools/call result { observations: [...], more: false, queue_depth: 0 }
```

Disconnect: the MCP transport closes; the woo session may persist per session-grace rules. Reconnect re-authenticates and re-reads tool list, then drains `wait` to resync.

---

## M8. Profile boundary

This is **v1-ops**: agents are an operational addition on top of v1-core's human-in-browser baseline. The MCP gateway is a separate deployment surface from the worker that serves the SPA — they may co-locate, but the SPA must function without the MCP gateway running. v1-core conformance does not require an MCP implementation.

A second-implementation conformance suite for MCP follows the broader conformance plan ([tooling/conformance.md](../tooling/conformance.md)) and is deferred until at least one alternative MCP gateway exists.

---

## Open questions

- **Resources surface.** Skipped in v1-ops because MCP resource support across clients is uneven. The verb-tool surface plus `:describe` (a tool-exposed verb on every object) covers the main browse cases. If clients converge on resources later, add `woo://here`, `woo://me`, `woo://object/{id}` as a layered addition without changing the tool surface.
- **Multi-actor agents.** A single LLM driving multiple characters (a "puppeteer" pattern) wants several MCP sessions multiplexed over one transport. v1-ops keeps this 1:1; revisit when there's a workload that demands it.
- **Streaming verbs.** Some verbs (a long compile, a multi-step task creation) emit progress observations. Today these flow through the per-actor queue alongside everything else, drained by `wait`. A future MCP profile could attach them to the originating tool call as a streamed result, matching MCP's `progressNotification` shape; v1-ops keeps it flat.
- **Coalescing dense streams.** Dubspace gesture progress at 60 Hz floods the observation queue if the agent isn't draining. v1-ops emits raw; v1.x could offer a per-actor coalescing rule (e.g., "keep only latest of `gesture_progress` per `(actor, target, name)` triple").
