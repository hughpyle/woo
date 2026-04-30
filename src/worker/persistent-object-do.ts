// PersistentObjectDO — the v1 single-DO host for the entire world.
//
// Per cloudflare.md §R5/§R11, the eventual model is one DO per anchor cluster.
// For v1 we collapse this to a single DO that hosts the whole world (the
// existing single-process model the runtime was built around). Cross-DO
// routing becomes a v1.1 refactor; until then everything in the world lives
// in this DO's storage.
//
// What's wired through fetch() / the WS handlers:
// - REST routing ported from src/server/dev-server.ts: auth, describe (with
//   actor-permission filtering), property reads (filtered), sequenced and
//   direct verb calls (with broadcast to connected WS clients), log paging,
//   /api/state (wizard-only).
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
import type { AppliedFrame, DirectResultFrame, ErrorValue, LiveEventFrame, Message } from "../core/types";
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

export class PersistentObjectDO {
  private state: DurableObjectState;
  private env: Env;
  private repo: CFObjectRepository;
  private world: WooWorld | null = null;

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
        // Wizard-only: world.state() returns the full object graph including
        // properties on every object. Public exposure leaks anything in the
        // world (sessions, in-progress task data, internal state). Wizards
        // see everything anyway; non-wizards must use the per-object
        // describe/property routes which are actor-permission-filtered.
        const session = this.requireRestSession(world, request);
        this.requireWizard(world, session.actor);
        return jsonResponse(world.state());
      }

      if (request.method === "POST" && pathname === "/api/auth") {
        const body = await readJsonBody(request);
        const token = String(body.token ?? "");
        if (!token.startsWith("guest:") && !token.startsWith("session:") && !token.startsWith("wizard:")) {
          throw wooError("E_INVARG", "REST accepts guest:, session:, and wizard: tokens");
        }
        const session = this.authenticateToken(world, token);
        return jsonResponse({ actor: session.actor, session: session.id });
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

  // ---- auth helpers (port from dev-server.ts) ----

  private authenticateToken(world: WooWorld, token: string): Session {
    if (token.startsWith("wizard:")) {
      return world.claimWizardBootstrapSession(token.slice("wizard:".length), this.env.WOO_INITIAL_WIZARD_TOKEN);
    }
    return world.auth(token);
  }

  private requireWizard(world: WooWorld, actor: ObjRef): void {
    if (!world.object(actor).flags.wizard) throw wooError("E_PERM", "wizard authority required", actor);
  }

  private requireRestSession(world: WooWorld, request: Request): Session {
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
        const result = world.call(typeof frame.id === "string" ? frame.id : undefined, session.sessionId, String(frame.space ?? "") as ObjRef, message);
        if (result.op === "applied") this.broadcastApplied(world, result, ws);
        else ws.send(JSON.stringify(result));
        return;
      }

      if (op === "direct") {
        const args = Array.isArray(frame.args) ? (frame.args as WooValue[]) : [];
        const result = world.directCall(
          typeof frame.id === "string" ? frame.id : undefined,
          session.actor,
          String(frame.target ?? "") as ObjRef,
          String(frame.verb ?? ""),
          args
        );
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
