// PersistentObjectDO — Cloudflare host for the world gateway or an anchor cluster.
//
// The "world" host remains the gateway for auth, WebSockets, global
// catalog/admin surfaces, and bundled state aggregation. Directory-routed
// anchor clusters use the same storage schema, but initialize from a
// host-scoped world slice exported by the gateway: hosted objects, their
// parent/feature/bytecode support objects, hosted logs, snapshots, and tasks.
// They do not auto-install the bundled catalogs or claim independent bootstrap
// authority.
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
// - Authoring REST endpoints (/api/compile, /api/install, /api/property,
//   /api/property/value, /api/authoring/objects/{create,move,chparent}) — the
//   IDE tab can read on CF but not author.
// - Worker-side GitHub tap install (/api/tap/install) — local catalogs
//   cover the demos; remote-tap install is local-Node only for now.

import { createWorld, createWorldFromSerialized, mergeHostScopedSeed, nonEmptyHostScopedWorld } from "../core/bootstrap";
import { parseAutoInstallCatalogs } from "../core/local-catalogs";
import {
  handleRestProtocolRequest,
  handleWsProtocolFrame,
  parseWsProtocolFrame,
  statusForError,
  type RestProtocolRequest
} from "../core/protocol";
import type { ObjRef, Observation, Session, WooValue } from "../core/types";
import { directedRecipients, wooError } from "../core/types";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, LiveEventFrame, Message } from "../core/types";
import type { SerializedWorld } from "../core/repository";
import { normalizeError, type ParkedTaskRun } from "../core/world";
import { CFObjectRepository } from "./cf-repository";
import { McpGateway } from "../mcp/gateway";
import { signInternalRequest, verifyInternalRequest } from "./internal-auth";

// Re-import WooWorld type. Note `import type` must reach the world module
// without dragging Node-only deps into the Worker bundle.
import type { CallContext, HostBridge, WooWorld } from "../core/world";

export interface Env {
  WOO: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  ASSETS?: Fetcher;
  WOO_INITIAL_WIZARD_TOKEN?: string;
  WOO_INTERNAL_SECRET?: string;
  WOO_AUTO_INSTALL_CATALOGS?: string;
}

const WORLD_HOST = "world";
const DIRECTORY_HOST = "directory";
const INTERNAL_ORIGIN = "https://woo.internal";
const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;

export class PersistentObjectDO {
  private state: DurableObjectState;
  private env: Env;
  private repo: CFObjectRepository;
  private world: WooWorld | null = null;
  private routeCache = new Map<ObjRef, string>();
  private routesRegistered = false;
  private mcpGateway: McpGateway | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.repo = new CFObjectRepository(state);
  }

  async fetch(request: Request): Promise<Response> {
    // Operator-bootstrap precondition check (cloudflare.md §R14.7).
    if (!this.env.WOO_INITIAL_WIZARD_TOKEN) {
      return jsonResponse(
        { error: { code: "E_BOOTSTRAP_TOKEN_MISSING", message: "set WOO_INITIAL_WIZARD_TOKEN via wrangler secret put" } },
        503
      );
    }
    if (!this.env.WOO_INTERNAL_SECRET) {
      return jsonResponse(
        { error: { code: "E_BOOTSTRAP_TOKEN_MISSING", message: "set WOO_INTERNAL_SECRET via wrangler secret put" } },
        503
      );
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const hostKey = request.headers.get("x-woo-host-key") || this.durableHostKey();
    const gatewayHost = hostKey === WORLD_HOST;
    const internalRequest = pathname.startsWith("/__internal/");

    if (internalRequest) await verifyInternalRequest(this.env, request);

    if (!gatewayHost && (pathname === "/api/auth" || pathname === "/ws")) {
      return jsonResponse({ error: { code: "E_NOTAPPLICABLE", message: `${pathname} is only available on the world gateway host` } }, 404);
    }

    try {
      const world = await this.getWorld(hostKey);

      if (internalRequest) {
        return await this.handleInternal(request, world, pathname);
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

      if (request.method === "GET" && pathname === "/healthz") {
        return jsonResponse({ ok: true, ts: Date.now(), objects: world.objects.size });
      }

      // MCP streamable-HTTP transport (spec/protocol/mcp.md). Only on the
      // gateway host: agent sessions live here alongside human WebSockets.
      if (gatewayHost && pathname === "/mcp") {
        const gateway = this.getMcpGateway(world);
        return await gateway.handle(request);
      }

      const protocol = await handleRestProtocolRequest(workerRestRequest(request, pathname), {
        world,
        authenticateToken: (token) => this.authenticateToken(world, token),
        requireSession: () => this.requireRestSession(world, request),
        state: (actor) => this.aggregateState(world, actor),
        installTap: async () => {
          throw wooError("E_NOT_IMPLEMENTED", "GitHub tap install on CF Worker is pending Phase 7; use @local catalogs for now");
        },
        resolveObject: (id, session) => this.resolveRestObject(world, id, session),
        resolveActor: (_protocolRequest, actorValue, session) => this.resolveRestActor(world, request, actorValue, session),
        broadcastApplied: (frame) => this.broadcastApplied(world, frame),
        broadcastLiveEvents: (result) => this.broadcastLiveEvents(world, result)
      });
      if (protocol.handled) {
        if ("raw" in protocol) {
          return jsonResponse({ error: { code: "E_NOT_IMPLEMENTED", message: "raw REST response not supported on CF Worker" } }, 501);
        }
        return jsonResponse(protocol.body, protocol.status);
      }

      return jsonResponse({ error: { code: "E_OBJNF", message: `no route for ${request.method} ${pathname}` } }, 404);
    } catch (err) {
      const error = normalizeError(err);
      return jsonResponse({ error }, statusForError(error));
    }
  }

  // ---- world lifecycle ----

  /**
   * Lazy-init the in-memory WooWorld. The gateway host runs normal bootstrap
   * and catalog auto-install; cluster hosts load/prune a host-scoped serialized
   * world and write that slice through the same repository path.
   *
   * The init is wrapped in blockConcurrencyWhile to ensure no fetch handler
   * interleaves with the bootstrap; once init completes, the same `world`
   * instance handles all subsequent requests until DO hibernation.
   */
  private durableHostKey(): string {
    return this.state.id.name ?? WORLD_HOST;
  }

  private getMcpGateway(world: WooWorld): McpGateway {
    if (!this.mcpGateway) this.mcpGateway = new McpGateway(world, { serverName: "woo" });
    return this.mcpGateway;
  }

  private async getWorld(hostKey = this.durableHostKey()): Promise<WooWorld> {
    if (this.world) {
      if (hostKey === WORLD_HOST) await this.registerObjectRoutes(this.world);
      return this.world;
    }
    let initialized: WooWorld | null = null;
    await this.state.blockConcurrencyWhile(async () => {
      if (this.world) {
        initialized = this.world;
        return;
      }
      const world = hostKey === WORLD_HOST
        ? createWorld({ repository: this.repo, catalogs: parseAutoInstallCatalogs(this.env.WOO_AUTO_INSTALL_CATALOGS) })
        : await this.createHostScopedWorld(hostKey as ObjRef);
      this.installHostBridge(world, hostKey);
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
    const world = initialized!;
    if (hostKey === WORLD_HOST) await this.registerObjectRoutes(world);
    return world;
  }

  private async createHostScopedWorld(hostKey: ObjRef): Promise<WooWorld> {
    const stored = this.repo.load();
    let scoped = stored ? nonEmptyHostScopedWorld(stored, hostKey) : null;
    if (stored && !scoped) {
      console.warn("woo.cluster_seed_fallback", {
        host: hostKey,
        reason: "stored_world_missing_host_slice",
        stored_objects: stored.objects.length,
        stored_logs: stored.logs.length,
        stored_tasks: stored.parkedTasks.length
      });
    }
    let freshSeed: SerializedWorld | null = null;
    try {
      freshSeed = nonEmptyHostScopedWorld(await this.fetchHostSeed(hostKey), hostKey);
    } catch (err) {
      if (!scoped) throw err;
      console.warn("woo.cluster_seed_refresh_failed", { host: hostKey, error: normalizeError(err) });
    }
    if (scoped && freshSeed) scoped = mergeHostScopedSeed(scoped, freshSeed);
    if (!scoped) scoped = freshSeed;
    if (!scoped) throw wooError("E_OBJNF", `no host-scoped seed for ${hostKey}`, hostKey);
    return createWorldFromSerialized(scoped, { repository: this.repo });
  }

  private async fetchHostSeed(hostKey: ObjRef): Promise<SerializedWorld> {
    const id = this.env.WOO.idFromName(WORLD_HOST);
    const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/__internal/host-seed`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-woo-host-key": WORLD_HOST
      },
      body: JSON.stringify({ host: hostKey })
    }));
    const response = await this.env.WOO.get(id).fetch(request);
    const body = await response.json();
    if (!response.ok) throw wooError("E_STORAGE", `failed to load host seed for ${hostKey}`, body as WooValue);
    return body as SerializedWorld;
  }

  private async registerObjectRoutes(world: WooWorld): Promise<void> {
    if (this.routesRegistered) return;
    await this.registerRoutes(world.objectRoutes());
    this.routesRegistered = true;
  }

  private async registerRoutes(routes: Array<{ id: ObjRef; host: string; anchor: ObjRef | null }>): Promise<void> {
    if (routes.length === 0) return;
    try {
      const id = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/register-objects`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ routes })
      }));
      await this.env.DIRECTORY.get(id).fetch(request);
      for (const route of routes) this.routeCache.set(route.id, route.host);
    } catch {
      // Directory acceleration is best-effort. Fallback routing still sends
      // unknown objects to the world host or the caller-provided space host.
    }
  }

  private installHostBridge(world: WooWorld, localHost: string): void {
    const hostForObject = async (id: ObjRef): Promise<string | null> => {
      const cached = this.routeCache.get(id);
      if (cached) return cached;
      const localRoute = world.objectRoutes().find((route) => route.id === id && route.host === localHost);
      if (localRoute || (localHost === WORLD_HOST && world.objects.has(id))) return localHost;
      return await this.resolveObjectHost(id, WORLD_HOST);
    };
    const bridge: HostBridge = {
      localHost,
      hostForObject,
      getPropChecked: async (progr, objRef, name) => {
        const host = await hostForObject(objRef);
        if (!host || host === localHost) return await world.getPropChecked(progr, objRef, name);
        const response = await this.forwardInternalChecked<{ value: WooValue }>(host, "/__internal/remote-get-prop", { progr, obj: objRef, name });
        return response.value;
      },
      dispatch: async (ctx, target, verbName, args, startAt) => {
        const host = await hostForObject(startAt ?? target);
        if (!host || host === localHost) return await world.hostDispatch(ctx, target, verbName, args, startAt);
        const response = await this.forwardInternalChecked<{ result: WooValue; observations?: Observation[] }>(host, "/__internal/remote-dispatch", {
          ctx: this.serializedCallContext(ctx),
          target,
          verb: verbName,
          args,
          start_at: startAt ?? null
        });
        if (Array.isArray(response.observations)) {
          for (const observation of response.observations) ctx.observations.push(observation);
        }
        return response.result;
      },
      moveObject: async (objRef, targetRef) => {
        const host = await hostForObject(objRef);
        if (!host || host === localHost) {
          await world.moveObjectChecked(objRef, targetRef);
          return;
        }
        await this.forwardInternalChecked(host, "/__internal/remote-move-object", { obj: objRef, target: targetRef });
      },
      mirrorContents: async (containerRef, objRef, present) => {
        const host = await hostForObject(containerRef);
        if (!host || host === localHost) {
          world.mirrorContents(containerRef, objRef, present);
          return;
        }
        await this.forwardInternalChecked(host, "/__internal/mirror-contents", { container: containerRef, obj: objRef, present });
      },
      setActorPresence: async (actor, space, present) => {
        const host = await hostForObject(actor);
        if (!host || host === localHost) {
          world.setActorPresence(actor, space, present);
          return;
        }
        await this.forwardInternalChecked(host, "/__internal/actor-presence", { actor, space, present });
      },
      setSpaceSubscriber: async (space, actor, present) => {
        const host = await hostForObject(space);
        if (!host || host === localHost) {
          world.setSpaceSubscriber(space, actor, present);
          return;
        }
        await this.forwardInternalChecked(host, "/__internal/space-subscriber", { space, actor, present });
      },
      contents: async (objRef) => {
        const host = await hostForObject(objRef);
        if (!host || host === localHost) return world.contentsOf(objRef);
        const response = await this.forwardInternalChecked<{ contents: ObjRef[] }>(host, "/__internal/contents", { obj: objRef });
        return response.contents;
      }
    };
    world.setHostBridge(bridge);
  }

  private serializedCallContext(ctx: CallContext): Record<string, unknown> {
    return {
      space: ctx.space,
      seq: ctx.seq,
      actor: ctx.actor,
      player: ctx.player,
      caller: ctx.caller,
      callerPerms: ctx.callerPerms,
      progr: ctx.progr,
      thisObj: ctx.thisObj,
      verbName: ctx.verbName,
      definer: ctx.definer,
      message: ctx.message
    };
  }

  private async registerRemoteObjectRoutes(host: string): Promise<void> {
    try {
      const routes = await this.forwardInternal<Array<{ id: ObjRef; host: string; anchor: ObjRef | null }>>(host, "/__internal/object-routes", {});
      await this.registerRoutes(routes.filter((route) => route.host === host));
    } catch {
      // The applied frame is already durable on the target host; route
      // registration can be retried by a later state read or call.
    }
  }

  private async aggregateState(world: WooWorld, actor: ObjRef): Promise<Record<string, unknown>> {
    const state = world.state(actor) as unknown as Record<string, unknown>;
    const routes = Array.isArray(state.object_routes)
      ? state.object_routes.filter((route): route is { id: string; host: string; anchor: string | null } => (
          route !== null &&
          typeof route === "object" &&
          !Array.isArray(route) &&
          typeof (route as Record<string, unknown>).id === "string" &&
          typeof (route as Record<string, unknown>).host === "string"
        ))
      : [];
    const remoteHosts = Array.from(new Set(routes.map((route) => route.host).filter((host) => host && host !== WORLD_HOST)));
    for (const host of remoteHosts) {
      const remote = await this.fetchHostState(host, actor);
      if (!remote) continue;
      const remoteRoutes = Array.isArray(remote.object_routes)
        ? remote.object_routes.filter((route): route is { id: string; host: string; anchor: string | null } => (
            route !== null &&
            typeof route === "object" &&
            !Array.isArray(route) &&
            typeof (route as Record<string, unknown>).id === "string" &&
            (route as Record<string, unknown>).host === host
          ))
        : [];
      const hostRoutes = [...routes.filter((route) => route.host === host), ...remoteRoutes];
      state.object_routes = uniqueRoutes([...(Array.isArray(state.object_routes) ? state.object_routes as Array<{ id: string; host: string; anchor: string | null }> : []), ...remoteRoutes]);
      const routeIds = new Set(hostRoutes.map((route) => route.id));
      const spaces = { ...readMap(state.spaces) };
      for (const id of routeIds) {
        const remoteSpace = readMap(remote.spaces)[id];
        if (remoteSpace) spaces[id] = remoteSpace;
      }
      state.spaces = spaces;
      const objects = { ...readMap(state.objects) };
      const remoteObjects = readMap(remote.objects);
      for (const id of routeIds) {
        if (remoteObjects[id]) objects[id] = remoteObjects[id];
      }
      state.objects = objects;
    }
    return state;
  }

  private async fetchHostState(host: string, actor: ObjRef): Promise<Record<string, unknown> | null> {
    try {
      const id = this.env.WOO.idFromName(host);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/__internal/state`, {
        headers: { "x-woo-host-key": host, "x-woo-internal-actor": actor }
      }));
      const response = await this.env.WOO.get(id).fetch(request);
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
      if (request.method === "POST" && pathname === "/__internal/object-routes") {
        return jsonResponse(world.objectRoutes());
      }

      if (request.method === "POST" && pathname === "/__internal/host-seed") {
        const host = String(body.host ?? "") as ObjRef;
        if (!host) throw wooError("E_INVARG", "host-seed requires host");
        return jsonResponse(world.exportHostScopedWorld(host));
      }

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
        const audienceActors = Array.isArray(body.audience_actors)
          ? body.audience_actors.filter((item): item is ObjRef => typeof item === "string")
          : undefined;
        const observationAudiences = Array.isArray(body.observation_audiences)
          ? body.observation_audiences.map((audience) => (
              Array.isArray(audience) ? audience.filter((item): item is ObjRef => typeof item === "string") : []
            ))
          : undefined;
        const observations = Array.isArray(body.observations)
          ? body.observations.filter((item): item is Record<string, WooValue> & { type: string } => (
              item !== null &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              typeof (item as Record<string, unknown>).type === "string"
            ))
          : [];
        if (!audience) throw wooError("E_INVARG", "broadcast-live-events requires audience");
        this.broadcastLiveEvents(world, { op: "result", result: null, observations, audience, audienceActors, observationAudiences });
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
        return jsonResponse(await world.call(typeof body.frame_id === "string" ? body.frame_id : undefined, session.id, String(body.space ?? "") as ObjRef, message));
      }

      if (request.method === "POST" && pathname === "/__internal/ws-direct") {
        const session = this.ensureInternalSession(
          world,
          String(body.session_id ?? ""),
          String(body.actor ?? "") as ObjRef,
          Number(body.expires_at ?? 0),
          body.token_class
        );
        const result = await world.directCall(
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

      if (request.method === "POST" && pathname === "/__internal/remote-get-prop") {
        const progr = String(body.progr ?? "") as ObjRef;
        const obj = String(body.obj ?? "") as ObjRef;
        const name = String(body.name ?? "");
        return jsonResponse({ value: await world.getPropChecked(progr, obj, name) });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-dispatch") {
        const rawCtx = body.ctx && typeof body.ctx === "object" && !Array.isArray(body.ctx)
          ? body.ctx as Record<string, unknown>
          : {};
        const target = String(body.target ?? "") as ObjRef;
        const verb = String(body.verb ?? "");
        const args = Array.isArray(body.args) ? body.args as WooValue[] : [];
        const startAt = typeof body.start_at === "string" ? body.start_at as ObjRef : null;
        const observations: Observation[] = [];
        const actor = String(rawCtx.actor ?? "") as ObjRef;
        const player = String(rawCtx.player ?? actor) as ObjRef;
        if (actor) this.ensureInternalActor(world, actor);
        if (player) this.ensureInternalActor(world, player);
        const message = rawCtx.message && typeof rawCtx.message === "object" && !Array.isArray(rawCtx.message)
          ? rawCtx.message as Message
          : { actor, target, verb, args };
        const ctx: CallContext = {
          world,
          space: String(rawCtx.space ?? "#-1") as ObjRef,
          seq: Number(rawCtx.seq ?? -1),
          actor,
          player,
          caller: String(rawCtx.caller ?? "#-1") as ObjRef,
          callerPerms: String(rawCtx.callerPerms ?? rawCtx.progr ?? actor) as ObjRef,
          progr: String(rawCtx.progr ?? actor) as ObjRef,
          thisObj: String(rawCtx.thisObj ?? target) as ObjRef,
          verbName: String(rawCtx.verbName ?? verb),
          definer: String(rawCtx.definer ?? target) as ObjRef,
          message,
          observations,
          observe: (event) => {
            observations.push({ ...event, source: event.source ?? String(rawCtx.space ?? "#-1") });
          }
        };
        const result = await world.hostDispatch(ctx, target, verb, args, startAt);
        return jsonResponse({ result, observations });
      }

      if (request.method === "POST" && pathname === "/__internal/remote-move-object") {
        await world.moveObjectChecked(String(body.obj ?? "") as ObjRef, String(body.target ?? "") as ObjRef);
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/mirror-contents") {
        world.mirrorContents(
          String(body.container ?? "") as ObjRef,
          String(body.obj ?? "") as ObjRef,
          body.present === true
        );
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/actor-presence") {
        world.setActorPresence(
          String(body.actor ?? "") as ObjRef,
          String(body.space ?? "") as ObjRef,
          body.present === true
        );
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/space-subscriber") {
        world.setSpaceSubscriber(
          String(body.space ?? "") as ObjRef,
          String(body.actor ?? "") as ObjRef,
          body.present === true
        );
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__internal/contents") {
        return jsonResponse({ contents: world.contentsOf(String(body.obj ?? "") as ObjRef) });
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
    this.ensureInternalActor(world, actor);
    const tokenClass: Session["tokenClass"] = rawTokenClass === "guest" || rawTokenClass === "apikey" ? rawTokenClass : "bearer";
    return world.ensureSessionForActor(sessionId, actor, tokenClass, Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined);
  }

  private ensureInternalActor(world: WooWorld, actor: ObjRef): void {
    if (world.objects.has(actor)) return;
    const parent = world.objects.has("$player") ? "$player" : world.objects.has("$actor") ? "$actor" : null;
    world.createObject({ id: actor, name: actor, parent, owner: actor });
    if (world.objects.has(actor)) {
      world.setProp(actor, "presence_in", []);
      world.setProp(actor, "session_id", null);
    }
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
      const id = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/register-session`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          session_id: session.id,
          actor: session.actor,
          expires_at: session.expiresAt,
          token_class: session.tokenClass
        })
      }));
      await this.env.DIRECTORY.get(id).fetch(request);
      await this.registerRoutes([{ id: session.actor, host: WORLD_HOST, anchor: null }]);
    } catch {
      // Directory registration accelerates cross-DO routing. The local auth
      // result remains authoritative for this host; routed object calls fail
      // closed if the Directory cannot resolve the session.
    }
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
      world.recordWizardAction(session.actor, "impersonate", {
        actor: requested,
        via: typeof impersonated === "string" ? "REST X-Woo-Impersonate-Actor" : "REST actor field"
      });
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
    const frame = parseWsProtocolFrame(message);
    if (frame.op === "error") {
      ws.send(JSON.stringify(frame));
      return;
    }
    await handleWsProtocolFrame(ws, frame, {
      authenticate: async (token) => {
        const session = this.authenticateToken(world, token);
        await this.registerSessionRoute(session);
        return session;
      },
      attach: (_connection, session) => {
        const previous = this.attachment(ws);
        if (previous) world.detachSocket(previous.sessionId, previous.socketId);
        const socketId = `ws-${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        world.attachSocket(session.id, socketId);
        ws.serializeAttachment({ sessionId: session.id, actor: session.actor, socketId });
      },
      session: () => this.liveAttachment(world, ws),
      send: (_connection, frameValue) => ws.send(JSON.stringify(frameValue)),
      call: async (frameId, session, space, messageValue) => {
        const host = await this.resolveObjectHost(space, WORLD_HOST);
        const result = host === WORLD_HOST
          ? await world.call(frameId, session.sessionId, space, messageValue)
          : await this.forwardWsCall(world, host, frameId, session, space, messageValue);
        if (result.op === "applied") {
          if (host !== WORLD_HOST) await this.registerRemoteObjectRoutes(host);
        }
        return result;
      },
      direct: async (frameId, session, target, verb, args) => {
        const host = await this.resolveObjectHost(target, WORLD_HOST);
        return host === WORLD_HOST
          ? await world.directCall(
              frameId,
              session.actor,
              target,
              verb,
              args
            )
          : await this.forwardWsDirect(world, host, frameId, session, target, verb, args);
      },
      replay: async (frameId, session, space, fromValue, limitValue) => {
        const host = await this.resolveObjectHost(space, WORLD_HOST);
        if (host !== WORLD_HOST) {
          return this.forwardWsReplay(world, host, frameId, session, space, fromValue, limitValue);
        }
        if (!world.hasPresence(session.actor, space)) throw wooError("E_PERM", `${session.actor} is not present in ${space}`);
        const from = Math.max(1, Number(fromValue ?? 1));
        const limit = Math.min(Math.max(1, Number(limitValue ?? 100)), 500);
        return { op: "replay", id: frameId, space, from, entries: world.replay(space, from, limit) };
      },
      deliverInput: (session, input) => world.deliverInput(session.actor, input),
      broadcastApplied: (frameValue, originator) => this.broadcastApplied(world, frameValue, originator),
      broadcastTaskResult: (result) => this.broadcastTaskResult(world, result),
      broadcastLiveEvents: (result) => this.broadcastLiveEvents(world, result)
    });
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

  private liveAttachment(world: WooWorld, ws: WebSocket): { sessionId: string; actor: ObjRef; socketId: string } | null {
    const att = this.attachment(ws);
    if (!att) return null;
    return world.sessionAlive(att.sessionId) ? att : null;
  }

  private async resolveObjectHost(id: ObjRef, fallbackHost: string): Promise<string> {
    const cached = this.routeCache.get(id);
    if (cached) return cached;
    try {
      const directoryId = this.env.DIRECTORY.idFromName(DIRECTORY_HOST);
      const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}/resolve-object`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ id, fallback_host: fallbackHost })
      }));
      const response = await this.env.DIRECTORY.get(directoryId).fetch(request);
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
    const request = await signInternalRequest(this.env, new Request(`${INTERNAL_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-woo-host-key": host
      },
      body: JSON.stringify(body)
    }));
    const response = await this.env.WOO.get(id).fetch(request);
    return await response.json() as T;
  }

  private async forwardInternalChecked<T>(host: string, path: string, body: Record<string, unknown>): Promise<T> {
    const parsed = await this.forwardInternal<T | { error?: unknown }>(host, path, body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed && (parsed as { error?: unknown }).error) {
      throw normalizeError((parsed as { error: unknown }).error);
    }
    return parsed as T;
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
    this.mcpGateway?.routeAppliedFrame(frame);
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
    result.observations.forEach((observation, index) => {
      const frame: LiveEventFrame = { op: "event", observation };
      this.broadcastLiveEvent(world, frame, result.audience!, result.observationAudiences?.[index] ?? result.audienceActors);
    });
    this.mcpGateway?.routeLiveEvents(result);
  }

  private broadcastLiveEvent(world: WooWorld, frame: LiveEventFrame, audience: ObjRef, audienceActors?: ObjRef[]): void {
    const data = JSON.stringify(frame);
    const { to: directedTo, from: directedFrom } = directedRecipients(frame.observation);
    const audienceSet = audienceActors ? new Set(audienceActors) : null;
    for (const ws of this.state.getWebSockets()) {
      const att = this.attachment(ws);
      if (!att) continue;
      if (directedTo || directedFrom) {
        if (att.actor !== directedTo && att.actor !== directedFrom) continue;
      } else if (audienceSet) {
        if (!audienceSet.has(att.actor)) continue;
      } else if (!world.hasPresence(att.actor, audience)) {
        continue;
      }
      try { ws.send(data); } catch { /* gone */ }
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

function workerRestRequest(request: Request, pathname: string): RestProtocolRequest {
  const url = new URL(request.url);
  return {
    method: request.method,
    pathname,
    query: (name) => url.searchParams.get(name),
    header: (name) => request.headers.get(name),
    readJson: () => readJsonBody(request)
  };
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
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) throw wooError("E_RATE", `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_JSON_BODY_BYTES) throw wooError("E_RATE", `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    const parsed = raw.byteLength === 0 ? {} : JSON.parse(new TextDecoder().decode(raw));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    return {};
  }
}

function readMap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function uniqueRoutes(routes: Array<{ id: string; host: string; anchor: string | null }>): Array<{ id: string; host: string; anchor: string | null }> {
  const byId = new Map<string, { id: string; host: string; anchor: string | null }>();
  for (const route of routes) {
    if (!route?.id || !route.host) continue;
    byId.set(route.id, route);
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}
