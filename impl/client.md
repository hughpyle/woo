# Client Plan

## Client Order

The first client is the Dubspace UI. The second client is Taskspace. The minimal
IDE comes after those because it depends on introspection and authoring
operations.

## Dubspace

Surface:

- four loop slots
- one filter control
- one delay control group
- one scene save/recall control
- minimal presence display

## Audio

Use Web Audio in the browser. Start with bundled generated loops or oscillator
patterns; sample upload is out of scope.

The server is authoritative for shared control state. The browser is
authoritative for local audio rendering.

## Gesture Handling

Controls should distinguish:

- committed control messages that affect shared sound
- high-rate local UI hints that can remain ephemeral

For first light, it is acceptable to coalesce drag samples to a modest rate, as
long as emitted shared control changes still go through `$space`.

## Reload

On reload:

1. connect
2. receive actor id
3. receive or request current Dubspace state
4. resume audio from current control state

Snapshots are a storage-level continuity enhancement, not a prerequisite for the
first call-dispatch path. The client should not require dedicated snapshot,
history, or sync wire frames in first-light.

Reconnect should track last applied seq per observed space and recover gaps via
`space:replay(from, limit)`.

## Taskspace

Surface:

- task tree
- selected task inspector
- claim/release controls
- status selector
- requirement checklist
- artifact list
- activity timeline

Taskspace must be usable by both a browser actor and a headless/scripted agent
using the same `op: "call"` and `applied` stream.

## Minimal IDE

Surface:

- object browser
- object inspector
- verb editor
- call console
- observation/error panel

The IDE calls the authoring primitives in `impl/authoring.md`; it should not use
private client-only APIs.
