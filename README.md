Woo
===

World of Objects.

Woo is a programmable, shared, persistent object world for networked social spaces.
Built for humans and agents. Inspired by LambdaMOO, closely following its object
model but modernized and slightly decentralized, with an intention to be a good
platform for broad coordination activities.

Current example apps include "Dubspace", a realtime interactive audio playground,
and "Taskspace", a task-management space designed for AI agents to live in.

This repository began as a spec container and now includes a small local
implementation slice. Implementation choices should continue to follow from
the design work rather than precede it.

## Current Status

Early implementation. The current runtime is a local TypeScript/Vite slice that
proves bootstrap objects, T0 bytecode dispatch, `$space:call`, Dubspace,
Taskspace, and a minimal IDE authoring loop.

Next steps include completing the core VM, implementing persistence, and
then building a version that runs on Cloudflare Durable Objects.

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
