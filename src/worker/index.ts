// Worker entry — receives all inbound requests and forwards to the world DO.
//
// v1 routes everything to a single DO via env.WOO.idFromName("world"). When
// the codebase grows cross-DO routing per cloudflare.md §R1.1, this module
// becomes the dispatch point that picks an anchor cluster's DO based on the
// path's object id. For now it's a one-line forwarder.

import type { Env } from "./persistent-object-do";

export { PersistentObjectDO } from "./persistent-object-do";

export default {
  async fetch(request: Request, env: Env, _ctx: unknown): Promise<Response> {
    const id = env.WOO.idFromName("world");
    const stub = env.WOO.get(id);
    return stub.fetch(request);
  }
};
