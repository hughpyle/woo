# Reference Architecture

## Runtime Shape

The reference implementation is TypeScript.

Planned source layout:

```text
src/
  core/
    value.ts
    object.ts
    message.ts
    space.ts
    dispatch.ts
    observation.ts
    introspection.ts
    tiny-vm.ts
    t0-fixtures.ts
  runtime/
    world.ts
    seed.ts
    auth.ts
    sessions.ts
  storage/
    schema.ts
    repository.ts
    migrations.ts
  protocol/
    wire.ts
    rpc.ts
  authoring/
    compiler-t0.ts
    diagnostics.ts
    install.ts
  client/
    app.ts
    dubspace/
      model.ts
      audio.ts
      view.ts
      controls.ts
    taskspace/
      model.ts
      view.ts
    ide/
      object-browser.ts
      verb-editor.ts
      call-console.ts
  worker.ts
test/
```

This layout is provisional. Preserve the module boundaries even if filenames
change.

## Deployment Shape

The reference deployment targets Cloudflare Workers and Durable Objects, but
core modules should not depend directly on Cloudflare APIs.

Layering:

```text
client UI
  -> websocket protocol
worker/router
  -> persistent hosts
storage repositories
  -> core runtime
```

## Persistent Hosts

The reference shape follows `spec/reference/cloudflare.md`: a persistent host
owns either one object or one anchor cluster. A local/dev implementation may use
one process or one test repository behind the scenes, but the runtime boundary
should still be "host for object or anchor root" so anchoring, routing, and
rollback semantics do not need to be redesigned later.

## First Runtime Objects

Seed these objects:

- `$system`
- `$root`
- `$actor`
- `$player`
- `$wiz`
- `$space`
- `$thing`
- `$dubspace`
- `$control`
- `$loop_slot`
- `$channel`
- `$filter`
- `$delay`
- `$scene`
- `$taskspace`
- `$task`
- guest player pool
- `the_dubspace`
- `the_taskspace`

The seed graph is specified in `spec/semantics/bootstrap.md`. Load-bearing
behavior should use the concrete T0 fixtures in `spec/semantics/tiny-vm.md`.
The minimal IDE later adds T0 source authoring, but the first demo should not
depend on user-authored source.
