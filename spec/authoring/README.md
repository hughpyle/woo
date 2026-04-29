# Authoring

Authoring specs describe the tools and object behaviors needed to make Woo
programmable by people and agents.

The authoring layer is not the runtime core. It is a forcing surface over the
core: if a developer cannot inspect an object, edit a verb, install it safely,
call it, and understand the result, then the programmable-world claim is not
yet real.

Discovery begins with the semantic introspection surface in
[../semantics/introspection.md](../semantics/introspection.md). Authoring adds
source editing, compile/install, diagnostics, and versioned mutation.

## Documents

- [minimal-ide.md](minimal-ide.md): the first Web IDE design and the object
  behavior primitives it pulls forward.
