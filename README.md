Woo
===

World of Objects.

Woo is a specification-first project for designing a programmable, shared,
persistent object world for networked social spaces.  Inspired by LambdaMOO
with an intention to be a suitable platform for broad coordination use cases.

This repository began as a spec container and now includes a small local
implementation slice. Implementation choices should continue to follow from
the design work rather than precede it.

## Current Status

Early implementation. The current runtime is a local TypeScript/Vite slice that
proves bootstrap objects, T0 bytecode dispatch, `$space:call`, Dubspace,
Taskspace, and a minimal IDE authoring loop.

## Specification

Start with [spec/README.md](spec/README.md).

## Implementation Plan

Implementation planning lives in [impl/README.md](impl/README.md). Runtime code
lives under [src/](src/), with focused tests under [tests/](tests/).

## Run Locally

```sh
npm install
npm test
npm run dev
```

Then open <http://localhost:5173>.

## Working Rule

Keep runtime changes aligned with the spec. When implementation pressure
reveals a semantic gap, update the relevant spec or `impl/` note alongside the
code.
