Woo
===

World of Objects.

Woo is a programmable, shared, persistent object world for networked social spaces.
Built for humans and agents. Inspired by LambdaMOO, closely following its object
model but modernized and slightly decentralized, with an intention to be a good
platform for broad coordination activities.

Current example apps include a small chat-room; "Dubspace", a realtime interactive
audio playground; "Taskspace", a task-management workspace (e.g. for AI agents),
and a very minimal IDE.

This repository began as a spec container and now includes a small local
implementation slice. Implementation choices should continue to follow from
the design work rather than precede it.

## Current Status

Early implementation.  Run locally, backed by in-memory or SQLite persistence.
Next steps include finishing the core VM and DSL compiler, then backing with
Cloudflare Durable Objects.

## Specification

Start with [spec/README.md](spec/README.md).

## Implementation Plan

Runtime code lives under [src/](src/), with focused tests under [tests/](tests/).
Current debt and spec/impl drift is in [TECH_DEBT_AUDIT.md](TECH_DEBT_AUDIT.md).
Historical milestone notes are in [notes/](notes/).

## Run Locally

```sh
npm install
npm test
npm run dev
```

Then open <http://localhost:5173>.

## Working Rule

Keep runtime changes aligned with the spec. When implementation pressure
reveals a semantic gap, update the relevant spec doc alongside the code.
