// Stub Cloudflare Worker entry. Confirms toolchain end-to-end:
// wrangler -> token -> account -> deploy -> live URL.
//
// The real Worker entry lands per notes/impl-cf-deploy.md Phase 2:
// route parsing, ID resolution, DO routing, WS upgrade. Until then this
// stub returns a stable JSON heartbeat for any request so we can hit it
// from curl / the deployed dashboard / monitoring.

interface Env {
  // Empty for now. Phase 2 adds DO bindings (WOO, DIRECTORY) and optional
  // bindings (METRICS, etc.) per spec/reference/cloudflare.md §R12.
}

export default {
  async fetch(request: Request, _env: Env, _ctx: unknown): Promise<Response> {
    const url = new URL(request.url);
    return Response.json({
      ok: true,
      version: "stub",
      ts: Date.now(),
      path: url.pathname,
      note: "woo stub Worker; real entry pending notes/impl-cf-deploy.md Phase 2"
    });
  }
};
