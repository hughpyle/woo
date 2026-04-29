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
- failure model consolidation (`spec/semantics/failures.md`): one table covering recycled objects, in-flight calls, duplicate replies, hibernation resume, version skew, browser disconnect — partial coverage now in protocol/hosts.md §3.4 and space.md §S3
- ~~bootstrap world contract~~ — done (`spec/semantics/bootstrap.md`); concrete T0 bytecode fixtures in `spec/semantics/tiny-vm.md` "Concrete fixtures"
- ~~discovery / introspection surface~~ — done (`spec/semantics/introspection.md`)
- ~~observation schemas for the demos~~ — done (sections in dubspace-demo.md and taskspace-demo.md)
- ~~taskspace domain invariants~~ — done (Domain Invariants section in `spec/taskspace-demo.md`)
- ~~minimal authoring on-ramp~~ — first draft in `spec/authoring/minimal-ide.md`
- broader authoring system: schema editor, history/replay viewer, version/rollback UI, package import/export

## deferred specs (placeholder docs to write)

- audio / streamed media (`spec/deferred/audio.md`)
- capabilities (`spec/deferred/capabilities.md`)
- conformance suite (`spec/deferred/conformance.md`) — when there's a second implementation

## not in v1, deliberately

- **re-anchoring** (`reanchor(obj, new_anchor)`). Anchor is set at create time and immutable. Atomicity scope changes are deliberate and rare; if someone needs the effect, they can create-copy-recycle. Re-anchoring as a runtime operation would require recursive subtree migration with task drain and routing redirects — too much machinery for the value at v1.

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
