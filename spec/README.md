# Woo Specification

This directory holds the Woo specification. It is layered. Read [`../SPEC.md`](../SPEC.md) for the entry index and the recommended reading order.

The spec is intended to be detailed enough to guide implementation, testing, operations, and future compatibility decisions. The implementation tree at [`../impl/`](../impl/) translates these specs into agent-sized work packages tracking the same source-of-truth documents.

## Layout

| Path | Layer | Contents |
|---|---|---|
| `semantics/` | semantics | Language and object model, implementation-neutral |
| `protocol/` | protocol | Host classes, wire format, browser bootstrap |
| `reference/` | reference | Concrete Cloudflare mapping (v1) |
| `deferred/` | deferred | Designs not in v1 (federation, audio, capabilities, conformance) |
| `authoring/` | authoring | First authoring surface (minimal IDE) |

## Demo and working docs at this level

These cross all four layers and live at the spec root rather than under any one layer:

- [vision.md](vision.md) — what Woo is becoming and what it is not yet
- [dubspace-demo.md](dubspace-demo.md) — first sound-space demo
- [taskspace-demo.md](taskspace-demo.md) — async coordination demo

## Process

The spec comes first. Implementation work begins only after the relevant section of the spec is explicit enough to constrain what is being built.

For open items, deferred designs, and decisions still pending, see [`../LATER.md`](../LATER.md).
