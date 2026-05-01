---
name: pinboard
version: 0.1.0
spec_version: v1
license: MIT
description: Shared spatial text-note coordination board demo.
depends:
  - @local:chat
keywords:
  - notes
  - coordination
  - demo
---

# Pinboard

Source catalog for the first-light spatial note coordination demo.

Defines a pinboard class and seeded `the_pinboard` instance mounted in the chat
world. The pinboard is a located object and its own `$space`; note records are
plain value data stored on the board.

See [DESIGN.md](DESIGN.md) for the app design and behavior contract.
