# later

Open items, sketches, gaps. Not commitments. Reorder freely. Style: keep / todo.txt — vibes, not roadmap.

The sections below distinguish three flavors of pending item:

- **Spec gaps** / **structure** / **ops/infra**: work that should happen when someone has cycles. Strike-throughs (`~~done~~`) mark closed items.
- **Not in v1, deliberately**: design choices the spec consciously declines, recorded so future readers see why the absence is intentional.
- **Decisions still open**: judgments deferred pending more information; the current leaning is documented but not locked.

## structure

- spec/README.md, spec/vision.md, spec/dubspace-demo.md, spec/taskspace-demo.md exist alongside the layered spec — decide whether they roll into the spec layers or stay as author working docs.
- residual "DO" / "SQLite" mentions in some semantic sections (mostly in code-snippet context) still drift toward implementation; ok for now.
- maybe full event→observation rename (file, API names, wire op) — currently only a synonym note bridges core.md and events.md.

## spec gaps

- ~~value model~~ — done (`spec/semantics/values.md`)
- ~~$space normative behavior~~ — done (`spec/semantics/space.md`)
- ~~identity / session (lite)~~ — done (`spec/semantics/identity.md`); full account/credential/recovery flows still deferred
- ~~failure model consolidation~~ — done (`spec/semantics/failures.md`)
- ~~worktrees / sandbox / promote~~ — done (`spec/operations/worktrees.md`)
- ~~migrations (bytecode, schema, data)~~ — done (`spec/operations/migrations.md`)
- ~~credentialed auth (account vs actor, OAuth, multi-character)~~ — done (`spec/identity/auth.md`)
- ~~debugging (step / breakpoint / replay)~~ — done (`spec/tooling/debugging.md`)
- ~~backups + restore + cross-environment migration~~ — done (`spec/operations/backups.md`)
- ~~deployments (dev/staging/prod, spec versions, blue-green)~~ — done (`spec/operations/deployments.md`)
- ~~observability (logs, metrics, traces, audit)~~ — done (`spec/operations/observability.md`)
- ~~conformance suite (behavioral test corpus)~~ — done (`spec/tooling/conformance.md`)
- ~~catalogs (named reusable object sets)~~ — done (`spec/discovery/catalogs.md`)
- ~~teams (team membership, role-based gating, team quotas)~~ — done (`spec/identity/teams.md`)
- ~~federation v1 (minimum cross-world surface)~~ — done (`spec/discovery/federation-v1.md`)
- ~~bootstrap world contract~~ — done (`spec/semantics/bootstrap.md`); concrete T0 bytecode fixtures in `spec/semantics/tiny-vm.md` "Concrete fixtures"
- ~~discovery / introspection surface~~ — done (`spec/semantics/introspection.md`)
- ~~observation schemas for the demos~~ — done (sections in dubspace-demo.md and taskspace-demo.md)
- ~~taskspace domain invariants~~ — done (Domain Invariants section in `spec/taskspace-demo.md`)
- ~~minimal authoring on-ramp~~ — first draft in `spec/authoring/minimal-ide.md`
- broader authoring system: schema editor, history/replay viewer, version/rollback UI, package import/export
- woo-flavoured rewrite of [yduj's duck tutorial](https://www.hayseed.net/MOO/yduj-duck-tutorial.text) — the canonical "build your first verb on a duck" walkthrough, ported to woo's DSL, dispatch model, and authoring surface. Aimed at first-time programmers (the original audience), not engineers porting from MOO.

## deferred specs (placeholder docs to write)

- audio / streamed media (`spec/deferred/audio.md`)
- capabilities (`spec/deferred/capabilities.md`)
- conformance suite (`spec/deferred/conformance.md`) — when there's a second implementation

## not in v1, deliberately

- **re-anchoring** (`reanchor(obj, new_anchor)`). Anchor is set at create time and immutable. Atomicity scope changes are deliberate and rare; if someone needs the effect, they can create-copy-recycle. Re-anchoring as a runtime operation would require recursive subtree migration with task drain and routing redirects — too much machinery for the value at v1.
- **object-defined UI components** (e.g., a `$ui_renderable` feature class with a `:ui_hint()` verb returning A2UI-shaped payloads). The object model can absorb this whenever it earns its keep — `:describe()`, declared event schemas, and verb metadata already give an agent ~70% of what it needs to generate a useful UI. The missing piece is layout/archetype intent ("control surface" vs. "feed" vs. "form"), which is one optional verb on one feature class away. Not building yet because (a) the chat surface hasn't yet proven what hint shape carries weight, and (b) A2UI itself isn't a stable target. Worth keeping the option open and revisiting when either of those unblocks.

## decisions still open

- cross-host reentrancy: reentrant lock by task-id vs explicit `with_lock` (currently leaning explicit; revisit after measurements)
- multi-session per player: fan-out vs first-wins (currently leaning fan-out)
- `chparent` orphan property values: drop vs preserve (currently dropping)
- per-value size cap: 256 KiB (proposal)
- strict vs dynamic verb compile: dynamic for v1; opt-in strict later

## ops / infra

- empirical validation that suspend-across-hibernate actually works for 24h+ on CF
- wizard audit log (`WizAudit` DO): bypass events, set_verb_code on others' objects, set_quota overrides
- DSL grammar (EBNF) — once parser is stable
- real cost numbers in `spec/reference/cloudflare.md` once the implementation exists
- real-time approximation for quota accounting via per-DO delta pushes

## first demo

The current direction is the dubspace sketch in [spec/dubspace-demo.md](spec/dubspace-demo.md): a shared persistent control surface for live sound gestures. It exercises the actor + log + emit/subscribe core without taking on cross-host migration depth, long-suspend tasks, or streamed media. A taskspace demo in [spec/taskspace-demo.md](spec/taskspace-demo.md) exercises async coordination for people and agents. A chat-shaped follow-up demo would later exercise the cross-host verb-dispatch and inheritance machinery the dubspace deliberately avoids.

## tools

- ollama serve (memory provider unavailable in current sessions)
