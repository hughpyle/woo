// Worker entry — splits routing between the DO (API) and Workers Assets (SPA).
//
// /api/*, /healthz, /ws  → forwarded to the world DO.
// Everything else        → env.ASSETS.fetch (the bundled SPA from ./dist).
//
// v1 routes everything to a single DO via env.WOO.idFromName("world"). When
// the codebase grows cross-DO routing per cloudflare.md §R1.1, this module
// becomes the dispatch point that picks an anchor cluster's DO based on the
// path's object id.

import type { Env } from "./persistent-object-do";

export { PersistentObjectDO } from "./persistent-object-do";

function isApiPath(pathname: string): boolean {
  return (
    pathname === "/healthz" ||
    pathname === "/ws" ||
    pathname.startsWith("/api/")
  );
}

export default {
  async fetch(request: Request, env: Env, _ctx: unknown): Promise<Response> {
    const url = new URL(request.url);

    if (isApiPath(url.pathname)) {
      const id = env.WOO.idFromName("world");
      const stub = env.WOO.get(id);
      return stub.fetch(request);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // Static assets binding missing — operator hasn't built the SPA bundle.
    // Fail loud so it surfaces, rather than silently returning the API 404.
    return new Response(
      JSON.stringify({ error: { code: "E_NO_ASSETS", message: "no SPA bundle deployed; run `npm run build` before `wrangler deploy`" } }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
};
