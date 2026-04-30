// PersistentObjectDO — Cloudflare host for the world gateway or an anchor cluster.
//
// The "world" instance is still the gateway for auth, WebSockets, global
// catalog/admin surfaces, and bundled state aggregation. Directory-routed
// anchor clusters (currently dubspace and taskspace) use the same class and
// storage schema, but receive forwarded calls through the internal routes
// below. The runtime is not fully host-scoped yet: cluster DOs still bootstrap
// the seed graph locally for class/verb availability, so they contain shadow
// copies of classes/global objects until remote definition lookup replaces that
// compatibility path.
//
// What's wired through fetch() / the WS handlers:
// - REST routing ported from src/server/dev-server.ts: auth, describe (with
//   actor-permission filtering), property reads (filtered), sequenced and
//   direct verb calls (with broadcast to connected WS clients), log paging,
//   /api/state (authenticated demo aggregate).
// - WebSocket upgrade with the CF hibernation API: state.acceptWebSocket,
//   serializeAttachment for per-socket {sessionId, actor, socketId}, and
//   webSocketMessage/Close/Error handlers. After DO wake-from-hibernation
//   getWorld() rehydrates session.attachedSockets from state.getWebSockets()
//   so reap doesn't expire active clients.
//
// What's still deferred to later phases:
// - Alarms for parked tasks (Phase 4): state.storage.setAlarm + alarm()
//   handler. Needed for FORK/SUSPEND wakeups on CF.
// - SSE streams (/api/objects/{id}/stream) — return 501. Browser uses WS;
//   SSE matters for HTTP-only agent integrations.
// - Authoring REST endpoints (/api/compile, /api/install, /api/property) —
//   the IDE tab can read on CF but not author.
// - Worker-side GitHub tap install (/api/tap/install) — local catalogs
//   cover the demos; remote-tap install is local-Node only for now.

import type { CatalogManifest } from "../core/catalog-installer";
import { createWorld } from "../core/bootstrap";
import type { ObjRef, Session, WooValue } from "../core/types";
import { wooError } from "../core/types";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, ErrorValue, LiveEventFrame, Message } from "../core/types";
import { normalizeError, type ParkedTaskRun } from "../core/world";
import { CFObjectRepository } from "./cf-repository";

import chatManifest from "../../catalogs/chat/manifest.json";
import dubspaceManifest from "../../catalogs/dubspace/manifest.json";
import taskspaceManifest from "../../catalogs/taskspace/manifest.json";

// Re-import WooWorld type. Note `import type` must reach the world module
// without dragging Node-only deps into the Worker bundle.
import type { WooWorld } from "../core/world";

export interface Env {
  WOO: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  ASSETS?: Fetcher;
  WOO_INITIAL_WIZARD_TOKEN?: string;
  WOO_SEED_PHRASE?: string;
  WOO_AUTO_INSTALL_CATALOGS?: string;
}

const LOCAL_CATALOGS: Record<string, CatalogManifest> = {
  chat: chatManifest as unknown as CatalogManifest,
  taskspace: taskspaceManifest as unknown as CatalogManifest,
  dubspace: dubspaceManifest as unknown as CatalogManifest
};

const WORLD_HOST = "world";

export class PersistentObjectDO {
  private state: DurableObjectState;
  private env: Env;
  private repo: CFObjectRepository;
  private world: WooWorld | null = null;
  private routeCache = new Map<ObjRef, string>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.repo = new CFObjectRepository(state);
  }

  async fetch(request: Request): Promise<Response> {
    // Operator-bootstrap precondition checks (cloudflare.md §R14.7).
    if (!this.env.WOO_INITIAL_WIZARD_TOKEN) {
      return jsonResponse(
        { error: { code: "E_BOOTSTRAP_TOKEN_MISSING", message: "set WOO_INITIAL_WIZARD_TOKEN via wrangler secret put" } },
        503
      );
    }
    if (!this.env.WOO_SEED_PHRASE) {
      return jsonResponse(
        { error: { code: "E_SEED_PHRASE_MISSING", message: "set WOO_SEED_PHRASE via wrangler secret put; once chosen, do not rotate" } },
        503
      );
    }

    const world = await this.getWorld();
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname.startsWith("/__internal/")) {
      return this.handleInternal(request, world, pathname);
    }

    // WebSocket upgrade — accept via hibernation API. The connection survives
    // DO hibernation; per-socket state is in serializeAttachment(). Per
    // cloudflare.md §R8.
    if (pathname === "/ws") {
      const upgrade = request.headers.get("upgrade");
      if (upgrade?.toLowerCase() !== "websocket") {
        return jsonResponse({ error: { code: "E_INVARG", message: "expected Upgrade: websocket" } }, 400);
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    try {
      if (request.method === "GET" && pathname === "/healthz") {
        return jsonResponse({ ok: true, ts: Date.now(), objects: world.objects.size });
      }

      if (request.method === "GET" && pathname === "/api/state") {
        // Demo aggregate state. Object descriptions are actor-filtered, but
        // the app payloads include raw demo state; production REST clients
        // should use describe/property/log rather than this bundled-client API.
        const session = this.requireRestSession(world, request);
        return jsonResponse(await this.aggregateState(world, session.actor));
      }

      if (request.method === "POST" && pathname === "/api/auth") {
        const body = await readJsonBody(request);
        const token = String(body.token ?? "");
        if (!token.startsWith("guest:") && !token.startsWith("session:") && !token.startsWith("wizard:")) {
          throw wooError("E_INVARG", "REST accepts guest:, session:, and wizard: tokens");
        }
        const session = this.authenticateToken(world, token);
        return jsonResponse({ actor: session.actor, session: session.id, expires_at: session.expiresAt, token_class: session.tokenClass });
      }

      if (request.method === "POST" && pathname === "/api/tap/install") {
        const session = this.requireRestSession(world, request);
        this.requireWizard(world, session.actor);
        // GitHub fetch is deferred to a later phase on CF (the helper in
        // src/server/github-taps.ts uses node:fetch + GitHub API, all of
        // which work on Workers — but it imports node-specific bits in
        // dev-server. Phase 7 ports those into the worker).
        return jsonResponse(
          { error: { code: "E_NOT_IMPLEMENTED", message: "GitHub tap install on CF Worker is pending Phase 7; use @local catalogs for now" } },
          501
        );
      }

      if (request.method === "GET" && pathname === "/api/taps") {
        const session = this.requireRestSession(world, request);
        this.requireWizard(world, session.actor);
        return jsonResponse({ catalogs: world.getProp("$catalog_registry", "installed_catalogs") });
      }

      const route = parseObjectRoute(pathname);
      if (route) {
        const session = this.requireRestSession(world, request);
        const target = this.resolveRestObject(world, route.id, session);

        if (request.method === "GET" && route.rest.length === 0) {
          // Permission-filtered: a non-readable property's name is visible
          // but its value isn't (per rest.md §R4 / world.describeForActor).
          return jsonResponse(world.describeForActor(target, session.actor));
        }

        if (request.method === "GET" && route.rest.length === 2 && route.rest[0] === "properties") {
          const name = route.rest[1];
          const value = world.getPropForActor(session.actor, target, name);
          const info = this.restPropertyInfo(world, target, name);
          const ownVersion = world.object(target).propertyVersions.get(name);
          return jsonResponse({ ...info, value, version: ownVersion ?? info.version });
        }

        if (request.method === "POST" && route.rest.length === 2 && route.rest[0] === "calls") {
          const body = await readJsonBody(request);
          const verb = route.rest[1];
          const args = Array.isArray(body.args) ? (body.args as WooValue[]) : [];
          const actor = this.resolveRestActor(world, request, body.actor, session);
          const frameId = typeof body.id === "string" ? body.id : undefined;

          if (Object.prototype.hasOwnProperty.call(body, "space") && body.space !== null) {
            const space = this.resolveRestObject(world, String(body.space), session);
            const message: Message = {
              actor,
              target,
              verb,
              args,
              body: body.body && typeof body.body === "object" && !Array.isArray(body.body) ? (body.body as Record<string, WooValue>) : undefined
            };
            const result = world.call(frameId, session.id, space, message);
            if (result.op === "error") return jsonResponse({ error: result.error }, statusForError(result.error));
            // REST callers don't have a WS, but other connected clients do
            // — fan out the applied frame so a chat browser sees a REST
            // agent's actions in real time.
            this.broadcastApplied(world, result);
            return jsonResponse(result);
          }

          const forceDirect = request.headers.get("x-woo-force-direct") === "1";
          const result = world.directCall(frameId, actor, target, verb, args, { forceDirect, forceReason: "REST X-Woo-Force-Direct" });
          if (result.op === "error") return jsonResponse({ error: result.error }, statusForError(result.error));
          this.broadcastLiveEvents(world, result);
          return jsonResponse({ result: result.result, observations: result.observations });
        }

        if (request.method === "GET" && route.rest.length === 1 && route.rest[0] === "log") {
          if (!isSpaceLike(world, target)) throw wooError("E_NOTAPPLICABLE", `${target} does not have a sequenced log`, target);
          if (!world.hasPresence(session.actor, target)) throw wooError("E_PERM", `${session.actor} is not present in ${target}`);
          const from = Math.max(1, Number(url.searchParams.get("from") ?? 1));
          const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 100)), 1000);
          const entries = world.replay(target, from, limit + 1);
          const messages = entries.slice(0, limit);
          const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : from - 1;
          return jsonResponse({ messages, next_seq: lastSeq + 1, has_more: entries.length > limit });
        }

        if (request.method === "GET" && route.rest.length === 1 && route.rest[0] === "stream") {
          // SSE streams deferred — Worker needs Web ReadableStream wiring + presence-driven event routing.
          return jsonResponse({ error: { code: "E_NOT_IMPLEMENTED", message: "SSE streams pending on CF Worker" } }, 501);
        }
      }

      return jsonResponse({ error: { code: "E_OBJNF", message: `no route for ${request.method} ${pathname}` } }, 404);
    } catch (err) {
      const error = normalizeError(err);
      return jsonResponse({ error }, statusForError(error));
    }
  }

  // ---- world lifecycle ----

  /**
   * Lazy-init the in-memory WooWorld. Storage is hydrated via repo.load() if
   * objects exist; otherwise bootstrap + auto-install runs and writes through
   * the per-object incremental persistence path.
   *
   * The init is wrapped in blockConcurrencyWhile to ensure no fetch handler
   * interleaves with the bootstrap; once init completes, the same `world`
   * instance handles all subsequent requests until DO hibernation.
   */
  private async getWorld(): Promise<WooWorld> {
    if (this.world) return this.world;
    let initialized: WooWorld | null = null;
    await this.state.blockConcurrencyWhile(async () => {
      if (this.world) {
        initialized = this.world;
        return;
      }
      // createWorld:
      // - load() on a fresh DO returns null → bootstrap + auto-install.
      // - load() on a hydrated DO returns the SerializedWorld → importWorld → re-run bootstrap idempotently.
      const catalogs = parseAutoInstallCatalogs(this.env.WOO_AUTO_INSTALL_CATALOGS);
      const world = createWorld({ repository: this.repo, catalogs });
      // Rehydrate live WebSocket attachments. After DO wake-from-hibernation,
      // state.getWebSockets() returns sockets whose serializeAttachment
      // payload survived hibernation; the in-memory world.sessions, however,
      // is freshly hydrated from storage with empty attachedSockets sets
      // (hydrateSession in world.ts:1256). Re-attach each surviving socket
      // so presence-filtered broadcasts reach those clients again and the
      // session reap path doesn't expire actively-connected sessions.
      for (const ws of this.state.getWebSockets()) {
        const att = this.attachment(ws);
        if (att && world.sessions?.has(att.sessionId)) {
          world.attachSocket(att.sessionId, att.socketId);
        }
      }
      this.world = world;
      initialized = world;
    });
    return initialized!;
  }

  private async aggregateState(world: WooWorld, actor: ObjRef): Promise<Record<string, unknown>> {
    const state = world.state(actor) as unknown as Record<string, unknown>;
    for (const space of ["the_dubspace", "the_taskspace"] as const) {
      const host = await this.resolveObjectHost(space, WORLD_HOST);
      if (host === WORLD_HOST) continue;
      const remote = await this.fetchHostState(host, actor);
      if (!remote) continue;
      const remoteSpaces = readMap(remote.spaces);
      if (remoteSpaces[space]) {
        const spaces = { ...readMap(state.spaces), [space]: remoteSpaces[space] };
        state.spaces = spaces;
      }
      if (space === "the_dubspace" && remote.dubspace) state.dubspace = remote.dubspace;
      if (space === "the_taskspace" && remote.taskspace) state.taskspace = remote.taskspace;
      state.objects = { ...readMap(state.objects), ...readMap(remote.objects) };
    }
    return state;
  }

  private async fetchHostState(host: string, actor: ObjRef): Promise<Record<string, unknown> | null> {
    try {
      const id = this.env.WOO.idFromName(host);
      const response = await this.env.WOO.get(id).fetch(new Request("https://woo.internal/__internal/state", {
        headers: { "x-woo-host-key": host, "x-woo-internal-actor": actor }
      }));
      if (!response.ok) return null;
      const body = await response.json();
      return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private async handleInternal(request: Request, world: WooWorld, pathname: string): Promise<Response> {
    try {
      if (request.method === "GET" && pathname === "/__internal/state") {
        const actor = request.headers.get("x-woo-internal-actor");
        return jsonResponse(actor ? world.state(actor as ObjRef) : world.state());
      }

      const body = await readJsonBody(request);
      if (request.method === "POST" && pathname === "/__internal/broadcast-applied") {
        const frame = body.frame && typeof body.frame === "object" && !Array.isArray(body.frame)
          ? body.frame as AppliedFrame
          : null;
        if (!frame || frame.op !== "applied") throw wooError("E_INVARG", "broadcast-applied requires an applied frame");
        this.broadcastApplied(world, frame);
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/broadcast-live-events") {
        const audience = String(body.audience ?? "") as ObjRef;
        const observations = Array.isArray(body.observations)
          ? body.observations.filter((item): item is Record<string, WooValue> & { type: string } => (
              item !== null &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              typeof (item as Record<string, unknown>).type === "string"
            ))
          : [];
        if (!audience) throw wooError("E_INVARG", "broadcast-live-events requires audience");
        this.broadcastLiveEvents(world, { op: "result", result: null, observations, audience });
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/ws-call") {
        const session = this.ensureInternalSession(
          world,
          String(body.session_id ?? ""),
          String(body.actor ?? "") as ObjRef,
          Number(body.expires_at ?? 0),
          body.token_class
        );
        const raw = body.message && typeof body.message === "object" && !Array.isArray(body.message)
          ? body.message as Record<string, unknown>
          : {};
        const message: Message = {
          actor: session.actor,
          target: String(raw.target ?? "") as ObjRef,
          verb: String(raw.verb ?? ""),
          args: Array.isArray(raw.args) ? raw.args as WooValue[] : [],
          body: raw.body && typeof raw.body === "object" && !Array.isArray(raw.body)
            ? raw.body as Record<string, WooValue>
            : undefined
        };
        return jsonResponse(world.call(typeof body.frame_id === "string" ? body.frame_id : undefined, session.id, String(body.space ?? "") as ObjRef, message));
      }

      if (request.method === "POST" && pathname === "/__internal/ws-direct") {
        const session = this.ensureInternalSession(
          world,
          String(body.session_id ?? ""),
          String(body.actor ?? "") as ObjRef,
          Number(body.expires_at ?? 0),
          body.token_class
        );
        const result = world.directCall(
          typeof body.frame_id === "string" ? body.frame_id : undefined,
          session.actor,
          String(body.target ?? "") as ObjRef,
          String(body.verb ?? ""),
          Array.isArray(body.args) ? body.args as WooValue[] : []
        );
        return jsonResponse(result);
      }

      if (request.method === "POST" && pathname === "/__internal/replay") {
        const session = this.ensureInternalSession(
          world,
          String(body.session_id ?? ""),
          String(body.actor ?? "") as ObjRef,
          Number(body.expires_at ?? 0),
          body.token_class
        );
        const space = String(body.space ?? "") as ObjRef;
        if (!world.hasPresence(session.actor, space)) throw wooError("E_PERM", `${session.actor} is not present in ${space}`);
        const from = Math.max(1, Number(body.from ?? 1));
        const limit = Math.min(Math.max(1, Number(body.limit ?? 100)), 500);
        return jsonResponse({ op: "replay", id: body.frame_id, space, from, entries: world.replay(space, from, limit) });
      }

      return jsonResponse({ error: { code: "E_OBJNF", message: `no internal route for ${request.method} ${pathname}` } }, 404);
    } catch (err) {
      const error = normalizeError(err);
      return jsonResponse({ error }, statusForError(error));
    }
  }

  private ensureInternalSession(
    world: WooWorld,
    sessionId: string,
    actor: ObjRef,
    expiresAt: number,
    rawTokenClass: unknown
  ): Session {
    if (!sessionId || !actor) throw wooError("E_NOSESSION", "internal forwarded call requires session and actor");
    const tokenClass: Session["tokenClass"] = rawTokenClass === "guest" || rawTokenClass === "apikey" ? rawTokenClass : "bearer";
    return world.ensureSessionForActor(sessionId, actor, tokenClass, Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined);
  }

  // ---- auth helpers (port from dev-server.ts) ----

  private authenticateToken(world: WooWorld, token: string): Session {
    if (token.startsWith("wizard:")) {
      return world.claimWizardBootstrapSession(token.slice("wizard:".length), this.env.WOO_INITIAL_WIZARD_TOKEN);
    }
    return world.auth(token);
  }

  private async registerSessionRoute(session: Session): Promise<void> {
    try {
      const id = this.env.DIRECTORY.idFromName("directory");
      await this.env.DIRECTORY.get(id).fetch(new Request("https://directory.local/register-session", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          session_id: session.id,
          actor: session.actor,
          expires_at: session.expiresAt,
          token_class: session.tokenClass
        })
      }));
    } catch {
      // Directory registration accelerates cross-DO routing. The local auth
      // result remains authoritative for this host; routed object calls fail
      // closed if the Directory cannot resolve the session.
    }
  }

  private requireWizard(world: WooWorld, actor: ObjRef): void {
    if (!world.object(actor).flags.wizard) throw wooError("E_PERM", "wizard authority required", actor);
  }

  private requireRestSession(world: WooWorld, request: Request): Session {
    const internalSession = request.headers.get("x-woo-internal-session");
    const internalActor = request.headers.get("x-woo-internal-actor");
    if (internalSession && internalActor) {
      return this.ensureInternalSession(
        world,
        internalSession,
        internalActor as ObjRef,
        Number(request.headers.get("x-woo-internal-expires-at") ?? 0),
        request.headers.get("x-woo-internal-token-class")
      );
    }
    const header = request.headers.get("authorization") ?? "";
    const match = /^Session\s+(.+)$/i.exec(header.trim());
    if (!match) throw wooError("E_NOSESSION", "Authorization: Session <id> required");
    return world.auth(`session:${match[1]}`);
  }

  private resolveRestObject(world: WooWorld, id: string, session: Session): ObjRef {
    if (id === "$me") return session.actor;
    world.object(id);
    return id;
  }

  private resolveRestActor(world: WooWorld, request: Request, actorValue: unknown, session: Session): ObjRef {
    const impersonated = request.headers.get("x-woo-impersonate-actor");
    const requested = typeof impersonated === "string"
      ? impersonated
      : actorValue === undefined || actorValue === null || actorValue === "$me"
        ? session.actor
        : String(actorValue);
    if (requested === session.actor) return requested;
    if (world.object(session.actor).flags.wizard) {
      world.object(requested);
      return requested;
    }
    throw wooError("E_PERM", "actor does not match session actor", { actor: requested, session_actor: session.actor });
  }

  // ---- WebSocket lifecycle (CF hibernation API) ----
  //
  // Each accepted ws carries a serialized attachment {sessionId, actor, socketId}
  // that survives DO hibernation. webSocketMessage() ports the WS frame
  // dispatch from src/server/dev-server.ts; broadcast helpers iterate
  // state.getWebSockets() for fan-out instead of an in-memory Map.

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const world = await this.getWorld();
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text);
    } catch {
      ws.send(JSON.stringify({ op: "error", error: { code: "E_INVARG", message: "invalid JSON frame" } }));
      return;
    }

    try {
      const op = String(frame.op ?? "");

      if (op === "auth") {
        const session = this.authenticateToken(world, String(frame.token ?? ""));
        await this.registerSessionRoute(session);
        const previous = this.attachment(ws);
        if (previous) world.detachSocket(previous.sessionId, previous.socketId);
        const socketId = `ws-${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        world.attachSocket(session.id, socketId);
        ws.serializeAttachment({ sessionId: session.id, actor: session.actor, socketId });
        ws.send(JSON.stringify({ op: "session", actor: session.actor, session: session.id }));
        return;
      }

      if (op === "ping") {
        ws.send(JSON.stringify({ op: "pong" }));
        return;
      }

      const session = this.requireWsSession(ws, frame.id);
      if (!session) return;

      if (op === "call") {
        const m = (frame.message ?? {}) as Record<string, unknown>;
        const message: Message = {
          actor: session.actor,
          target: String(m.target ?? "") as ObjRef,
          verb: String(m.verb ?? ""),
          args: Array.isArray(m.args) ? (m.args as WooValue[]) : [],
          body: m.body && typeof m.body === "object" && !Array.isArray(m.body)
            ? (m.body as Record<string, WooValue>)
            : undefined
        };
        const space = String(frame.space ?? "") as ObjRef;
        const host = await this.resolveObjectHost(space, WORLD_HOST);
        const result = host === WORLD_HOST
          ? world.call(typeof frame.id === "string" ? frame.id : undefined, session.sessionId, space, message)
          : await this.forwardWsCall(world, host, typeof frame.id === "string" ? frame.id : undefined, session, space, message);
        if (result.op === "applied") this.broadcastApplied(world, result, ws);
        else ws.send(JSON.stringify(result));
        return;
      }

      if (op === "direct") {
        const args = Array.isArray(frame.args) ? (frame.args as WooValue[]) : [];
        const target = String(frame.target ?? "") as ObjRef;
        const host = await this.resolveObjectHost(target, WORLD_HOST);
        const result = host === WORLD_HOST
          ? world.directCall(
              typeof frame.id === "string" ? frame.id : undefined,
              session.actor,
              target,
              String(frame.verb ?? ""),
              args
            )
          : await this.forwardWsDirect(world, host, typeof frame.id === "string" ? frame.id : undefined, session, target, String(frame.verb ?? ""), args);
        if (result.op === "result") {
          ws.send(JSON.stringify({ op: "result", id: result.id, result: result.result }));
          this.broadcastLiveEvents(world, result);
        } else {
          ws.send(JSON.stringify(result));
        }
        return;
      }

      if (op === "input") {
        const input = Object.prototype.hasOwnProperty.call(frame, "value") ? frame.value : (frame.text ?? "");
        const result = world.deliverInput(session.actor, input as WooValue);
        if (!result) {
          ws.send(JSON.stringify({ op: "input", id: frame.id, accepted: false }));
          return;
        }
        if (result.frame?.op === "applied") this.broadcastApplied(world, result.frame, ws);
        else {
          ws.send(JSON.stringify({ op: "input", id: frame.id, accepted: true, task: result.task.id, observations: result.observations }));
          this.broadcastTaskResult(world, result);
        }
        return;
      }

      if (op === "replay") {
        const space = String(frame.space ?? "") as ObjRef;
        const host = await this.resolveObjectHost(space, WORLD_HOST);
        if (host !== WORLD_HOST) {
          ws.send(JSON.stringify(await this.forwardWsReplay(world, host, typeof frame.id === "string" ? frame.id : undefined, session, space, frame.from, frame.limit)));
          return;
        }
        if (!world.hasPresence(session.actor, space)) throw wooError("E_PERM", `${session.actor} is not present in ${space}`);
        const from = Math.max(1, Number(frame.from ?? 1));
        const limit = Math.min(Math.max(1, Number(frame.limit ?? 100)), 500);
        ws.send(JSON.stringify({ op: "replay", id: frame.id, space, from, entries: world.replay(space, from, limit) }));
        return;
      }

      ws.send(JSON.stringify({ op: "error", error: { code: "E_INVARG", message: `unknown op ${op}` } }));
    } catch (err) {
      ws.send(JSON.stringify({ op: "error", error: normalizeError(err) }));
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const world = await this.getWorld();
    const att = this.attachment(ws);
    if (att) world.detachSocket(att.sessionId, att.socketId);
    try {
      ws.close();
    } catch {
      // ignore — already closed
    }
  }

  async webSocketError(ws: WebSocket, _err: unknown): Promise<void> {
    const world = await this.getWorld();
    const att = this.attachment(ws);
    if (att) world.detachSocket(att.sessionId, att.socketId);
  }

  // ---- WS helpers ----

  private attachment(ws: WebSocket): { sessionId: string; actor: ObjRef; socketId: string } | null {
    const raw = ws.deserializeAttachment();
    if (!raw || typeof raw !== "object") return null;
    const a = raw as Record<string, unknown>;
    if (typeof a.sessionId !== "string" || typeof a.actor !== "string" || typeof a.socketId !== "string") return null;
    return { sessionId: a.sessionId, actor: a.actor as ObjRef, socketId: a.socketId };
  }

  private requireWsSession(ws: WebSocket, frameId: unknown): { sessionId: string; actor: ObjRef; socketId: string } | null {
    const att = this.attachment(ws);
    if (!att) {
      ws.send(JSON.stringify({ op: "error", id: frameId, error: { code: "E_NOSESSION", message: "auth required before this op" } }));
      return null;
    }
    return att;
  }

  private async resolveObjectHost(id: ObjRef, fallbackHost: string): Promise<string> {
    const cached = this.routeCache.get(id);
    if (cached) return cached;
    try {
      const directoryId = this.env.DIRECTORY.idFromName("directory");
      const response = await this.env.DIRECTORY.get(directoryId).fetch(new Request("https://directory.local/resolve-object", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ id, fallback_host: fallbackHost })
      }));
      const body = await response.json() as Record<string, unknown>;
      const host = typeof body.host === "string" ? body.host : fallbackHost;
      this.routeCache.set(id, host);
      return host;
    } catch {
      return fallbackHost;
    }
  }

  private async forwardWsCall(
    world: WooWorld,
    host: string,
    frameId: string | undefined,
    session: { sessionId: string; actor: ObjRef },
    space: ObjRef,
    message: Message
  ): Promise<AppliedFrame | ErrorFrame> {
    const body = this.forwardBody(world, session, { frame_id: frameId, space, message });
    return this.forwardInternal<AppliedFrame | ErrorFrame>(host, "/__internal/ws-call", body);
  }

  private async forwardWsDirect(
    world: WooWorld,
    host: string,
    frameId: string | undefined,
    session: { sessionId: string; actor: ObjRef },
    target: ObjRef,
    verb: string,
    args: WooValue[]
  ): Promise<DirectResultFrame | ErrorFrame> {
    const body = this.forwardBody(world, session, { frame_id: frameId, target, verb, args });
    return this.forwardInternal<DirectResultFrame | ErrorFrame>(host, "/__internal/ws-direct", body);
  }

  private async forwardWsReplay(
    world: WooWorld,
    host: string,
    frameId: string | undefined,
    session: { sessionId: string; actor: ObjRef },
    space: ObjRef,
    from: unknown,
    limit: unknown
  ): Promise<unknown> {
    const body = this.forwardBody(world, session, { frame_id: frameId, space, from, limit });
    return this.forwardInternal(host, "/__internal/replay", body);
  }

  private async forwardInternal<T>(host: string, path: string, body: Record<string, unknown>): Promise<T> {
    const id = this.env.WOO.idFromName(host);
    const response = await this.env.WOO.get(id).fetch(new Request(`https://woo.internal${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-woo-host-key": host
      },
      body: JSON.stringify(body)
    }));
    return await response.json() as T;
  }

  private forwardBody(
    world: WooWorld,
    session: { sessionId: string; actor: ObjRef },
    extra: Record<string, unknown>
  ): Record<string, unknown> {
    const local = world.sessions.get(session.sessionId);
    return {
      session_id: session.sessionId,
      actor: session.actor,
      expires_at: local?.expiresAt ?? Date.now() + 5 * 60_000,
      token_class: local?.tokenClass ?? "bearer",
      ...extra
    };
  }

  private broadcastApplied(world: WooWorld, frame: AppliedFrame, originator?: WebSocket): void {
    const data = JSON.stringify(frame);
    const dataNoId = JSON.stringify({ ...frame, id: undefined });
    for (const ws of this.state.getWebSockets()) {
      const att = this.attachment(ws);
      if (!att || !world.hasPresence(att.actor, frame.space)) continue;
      try {
        ws.send(ws === originator ? data : dataNoId);
      } catch {
        // socket gone; webSocketClose will clean up
      }
    }
  }

  private broadcastTaskResult(world: WooWorld, result: ParkedTaskRun): void {
    if (result.frame?.op === "applied") {
      this.broadcastApplied(world, result.frame);
      return;
    }
    const space = taskResultSpace(result);
    const data = JSON.stringify({ op: "task", task: result.task.id, space, observations: result.observations });
    for (const ws of this.state.getWebSockets()) {
      const att = this.attachment(ws);
      if (!att || !world.hasPresence(att.actor, space)) continue;
      try { ws.send(data); } catch { /* gone */ }
    }
  }

  private broadcastLiveEvents(world: WooWorld, result: DirectResultFrame): void {
    if (!result.audience) return;
    for (const observation of result.observations) {
      const frame: LiveEventFrame = { op: "event", observation };
      this.broadcastLiveEvent(world, frame, result.audience);
    }
  }

  private broadcastLiveEvent(world: WooWorld, frame: LiveEventFrame, audience: ObjRef): void {
    const data = JSON.stringify(frame);
    const directedTo = typeof frame.observation.to === "string" ? frame.observation.to : null;
    const directedFrom = typeof frame.observation.from === "string" ? frame.observation.from : null;
    for (const ws of this.state.getWebSockets()) {
      const att = this.attachment(ws);
      if (!att) continue;
      if (directedTo || directedFrom) {
        if (att.actor !== directedTo && att.actor !== directedFrom) continue;
      } else if (!world.hasPresence(att.actor, audience)) {
        continue;
      }
      try { ws.send(data); } catch { /* gone */ }
    }
  }

  private restPropertyInfo(world: WooWorld, obj: ObjRef, name: string): Record<string, WooValue> {
    try {
      return world.propertyInfo(obj, name);
    } catch (err) {
      const error = normalizeError(err);
      const target = world.object(obj);
      if (error.code !== "E_PROPNF" || !target.properties.has(name)) throw err;
      return {
        name,
        owner: target.owner,
        perms: "rw",
        defined_on: obj,
        type_hint: null,
        version: target.propertyVersions.get(name) ?? 1,
        has_value: true
      };
    }
  }
}

// ---- module-scoped helpers ----

function taskResultSpace(result: ParkedTaskRun): ObjRef {
  const serialized = result.task.serialized as unknown;
  if (serialized && typeof serialized === "object" && !Array.isArray(serialized)) {
    const space = (serialized as Record<string, unknown>).space;
    if (typeof space === "string") return space as ObjRef;
  }
  return result.task.parked_on;
}

function parseObjectRoute(pathname: string): { id: string; rest: string[] } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "objects" || !parts[2]) return null;
  return {
    id: decodeURIComponent(parts[2]),
    rest: parts.slice(3).map((part) => decodeURIComponent(part))
  };
}

function isSpaceLike(world: WooWorld, obj: ObjRef): boolean {
  try {
    world.getProp(obj, "next_seq");
    return true;
  } catch {
    return false;
  }
}

function statusForError(error: ErrorValue): number {
  switch (error.code) {
    case "E_INVARG": return 400;
    case "E_NOSESSION": return 401;
    case "E_TOKEN_CONSUMED": return 401;
    case "E_PERM": return 403;
    case "E_DIRECT_DENIED": return 403;
    case "E_OBJNF":
    case "E_VERBNF":
    case "E_PROPNF":
    case "E_NOTAPPLICABLE":
      return 404;
    case "E_CONFLICT": return 409;
    case "E_TRANSITION":
    case "E_TRANSITION_ROLE_UNSET":
    case "E_TRANSITION_REQUIRES":
      return 422;
    case "E_RATE": return 429;
    case "E_NOT_IMPLEMENTED": return 501;
    case "E_NOT_SUPPORTED": return 501;
    default: return 500;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-length") === "0") return {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function parseAutoInstallCatalogs(value: string | undefined): string[] {
  if (value === undefined) return ["chat", "taskspace", "dubspace"];
  if (value.trim() === "") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function readMap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
