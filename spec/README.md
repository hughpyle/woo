# Woo Specification

This directory holds the Woo specification. It is layered. Read [`../SPEC.md`](../SPEC.md) for the entry index and the recommended reading order.

The spec is intended to be detailed enough to guide implementation, testing, operations, and future compatibility decisions. The reference TypeScript implementation lives in [`../src/`](../src/); current debt and spec/impl drift is tracked in [`../TECH_DEBT_AUDIT.md`](../TECH_DEBT_AUDIT.md).

## Layout

| Path | Layer | Contents |
|---|---|---|
| `semantics/` | semantics | Language and object model, implementation-neutral |
| `protocol/` | protocol | Host classes, wire format, browser bootstrap |
| `reference/` | reference | Concrete Cloudflare mapping (v1) |
| `deferred/` | deferred | Designs not in v1 (federation, audio, capabilities, conformance) |
| `authoring/` | authoring | First authoring surface (minimal IDE) |

## Demo and working docs

The platform contracts live under `spec/`; bundled app designs live with their
local catalogs:

- [vision.md](vision.md) — what Woo is becoming and what it is not yet
- [../catalogs/chat/DESIGN.md](../catalogs/chat/DESIGN.md) — chat feature demo
- [../catalogs/dubspace/DESIGN.md](../catalogs/dubspace/DESIGN.md) — first sound-space demo
- [../catalogs/taskspace/DESIGN.md](../catalogs/taskspace/DESIGN.md) — async coordination demo

## Process

The spec comes first. Implementation work begins only after the relevant section of the spec is explicit enough to constrain what is being built.

For open items, deferred designs, and decisions still pending, see [`../LATER.md`](../LATER.md).
