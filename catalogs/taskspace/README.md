---
name: taskspace
version: 0.1.0
spec_version: v1
license: MIT
description: Hierarchical task coordination demo.
depends:
  - @local:chat
keywords:
  - tasks
  - agents
  - demo
---

# Taskspace

Source catalog for the first-light task coordination demo.

Defines a taskspace class, task class, and seeded `the_taskspace` instance. The
catalog depends on `@local:chat` so the taskspace can attach the
`$conversational` feature and support embedded live chat.

See [DESIGN.md](DESIGN.md) for the app design and behavior contract.
