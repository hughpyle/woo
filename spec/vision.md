# Vision

Woo is a modern successor to LambdaMOO: a programmable, persistent world made
of objects, verbs, rooms, players, and shared state.

The goal is not merely to clone the old server. The goal is to preserve the
parts that made MOO worlds powerful while reconsidering the architecture,
interfaces, safety model, and social expectations for a contemporary networked
environment.

## Core Intent

Woo should support:

- A persistent shared world composed of inspectable and programmable objects.
- Live interaction between connected participants.
- User-extensible behavior within boundaries that protect the world and other
  users.
- A specification clear enough that multiple implementations could be tested
  against it.

## Non-Goals For Now

- No production implementation.
- No framework, hosting, or runtime commitment.
- No dependency selection.
- No assumption that early architecture sketches are settled decisions.

## Design Tension

Woo should stay close enough to LambdaMOO to inherit its expressive social and
programming model, while becoming clear enough, safe enough, and modular enough
to support modern clients and deployment environments.
