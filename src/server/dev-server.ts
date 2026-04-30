import http from "node:http";
import { parse } from "node:url";
import { createServer as createViteServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";
import { compileVerb, definePropertyVersioned, installVerb } from "../core/authoring";
import { createWorld } from "../core/bootstrap";
import { parseAutoInstallCatalogs } from "../core/local-catalogs";
import { normalizeError, type ParkedTaskRun } from "../core/world";
import {
  wooError,
  type AppliedFrame,
  type DirectResultFrame,
  type ErrorValue,
  type LiveEventFrame,
  type Message,
  type ObjRef,
  type Observation,
  type Session,
  type SpaceLogEntry,
  type WooValue
} from "../core/types";
import { installGitHubTap } from "./github-taps";
import { LocalSQLiteRepository } from "./sqlite-repository";

// Local dev server only: HTTP authoring endpoints are intentionally
// unauthenticated for local poking. Do not deploy as-is.
const repository = new LocalSQLiteRepository(process.env.WOO_DB ?? ".woo/dev.sqlite");
const world = createWorld({ repository, catalogs: parseAutoInstallCatalogs(process.env.WOO_AUTO_INSTALL_CATALOGS) });
type AttachedSocket = { sessionId: string; actor: string; socketId: string };
const sockets = new Map<WebSocket, AttachedSocket>();
type RestStream = { id: string; res: http.ServerResponse; actor: ObjRef; target: ObjRef; scope: "space" | "actor" };
const restStreams = new Set<RestStream>();
let socketCounter = 1;
let streamCounter = 1;

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "spa"
});

const server = http.createServer(async (req, res) => {
  const url = parse(req.url ?? "", true);
  try {
    if (await handleRestApi(req, res, url.pathname ?? "")) return;
    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, world.state());
    }
    if (req.method === "GET" && url.pathname === "/api/object") {
      const id = String(url.query.id ?? "");
      return json(res, {
        description: world.describe(id),
        verbs: world.verbs(id).map((name) => world.verbInfo(id, String(name))),
        properties: world.properties(id).map((name) => world.propertyInfo(id, String(name)))
      });
    }
    if (req.method === "POST" && url.pathname === "/api/compile") {
      if (!authoringEnabled()) return json(res, { error: wooError("E_PERM", "authoring endpoints are disabled") }, 403);
      const body = await readJson(req);
      return json(res, compileVerb(String(body.source ?? ""), { format: body.format }));
    }
    if (req.method === "POST" && url.pathname === "/api/install") {
      if (!authoringEnabled()) return json(res, { error: wooError("E_PERM", "authoring endpoints are disabled") }, 403);
      const body = await readJson(req);
      const result = installVerb(
        world,
        String(body.object),
        String(body.name),
        String(body.source ?? ""),
        body.expected_version ?? null,
        { format: body.format }
      );
      return json(res, result);
    }
    if (req.method === "POST" && url.pathname === "/api/property") {
      if (!authoringEnabled()) return json(res, { error: wooError("E_PERM", "authoring endpoints are disabled") }, 403);
      const body = await readJson(req);
      const result = definePropertyVersioned(
        world,
        String(body.object),
        String(body.name),
        body.default ?? null,
        String(body.perms ?? "rw"),
        body.expected_version ?? null,
        body.type_hint
      );
      return json(res, result);
    }
  } catch (err) {
    return json(res, { error: normalizeError(err) }, 400);
  }

  vite.middlewares(req, res);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const socketId = `ws-${socketCounter++}`;
  ws.on("message", (raw) => {
    try {
      const frame = JSON.parse(String(raw));
      if (frame.op === "auth") {
        const session = authenticateToken(String(frame.token ?? "guest:dev"));
        const previous = sockets.get(ws);
        if (previous) world.detachSocket(previous.sessionId, previous.socketId);
        world.attachSocket(session.id, socketId);
        sockets.set(ws, { sessionId: session.id, actor: session.actor, socketId });
        ws.send(JSON.stringify({ op: "session", actor: session.actor, session: session.id }));
        return;
      }
      if (frame.op === "ping") {
        ws.send(JSON.stringify({ op: "pong" }));
        return;
      }
      if (frame.op === "call") {
        const session = requireAttached(ws, frame.id);
        if (!session) return;
        const message: Message = {
          actor: session.actor,
          target: frame.message?.target,
          verb: frame.message?.verb,
          args: Array.isArray(frame.message?.args) ? frame.message.args : [],
          body: frame.message?.body
        };
        const result = world.call(frame.id, session.sessionId, frame.space, message);
        if (result.op === "applied") broadcastApplied(result, ws);
        else ws.send(JSON.stringify(result));
        return;
      }
      if (frame.op === "direct") {
        const session = requireAttached(ws, frame.id);
        if (!session) return;
        const args = Array.isArray(frame.args) ? frame.args : [];
        const result = world.directCall(frame.id, session.actor, String(frame.target ?? "") as ObjRef, String(frame.verb ?? ""), args);
        if (result.op === "result") {
          ws.send(JSON.stringify({ op: "result", id: result.id, result: result.result }));
          broadcastLiveEvents(result);
        } else {
          ws.send(JSON.stringify(result));
        }
        return;
      }
      if (frame.op === "replay") {
        const session = requireAttached(ws, frame.id);
        if (!session) return;
        const space = String(frame.space ?? "") as ObjRef;
        if (!world.hasPresence(session.actor, space)) throw wooError("E_PERM", `${session.actor} is not present in ${space}`);
        const from = Math.max(1, Number(frame.from ?? 1));
        const limit = Math.min(Math.max(1, Number(frame.limit ?? 100)), 500);
        ws.send(JSON.stringify({ op: "replay", id: frame.id, space, from, entries: world.replay(space, from, limit) }));
        return;
      }
      if (frame.op === "input") {
        const session = requireAttached(ws, frame.id);
        if (!session) return;
        const input = Object.prototype.hasOwnProperty.call(frame, "value") ? frame.value : frame.text ?? "";
        const result = world.deliverInput(session.actor, input);
        if (!result) {
          ws.send(JSON.stringify({ op: "input", id: frame.id, accepted: false }));
          return;
        }
        if (result.frame?.op === "applied") broadcastApplied(result.frame, ws);
        else {
          ws.send(JSON.stringify({ op: "input", id: frame.id, accepted: true, task: result.task.id, observations: result.observations }));
          broadcastTaskResult(result);
        }
        return;
      }
      ws.send(JSON.stringify({ op: "error", error: { code: "E_INVARG", message: `unknown op ${frame.op}` } }));
    } catch (err) {
      ws.send(JSON.stringify({ op: "error", error: normalizeError(err) }));
    }
  });
  ws.on("close", () => {
    const session = sockets.get(ws);
    if (session) world.detachSocket(session.sessionId, session.socketId);
    sockets.delete(ws);
  });
});

const port = Number(process.env.PORT ?? 5173);
server.listen(port, () => {
  console.log(`woo dev server http://localhost:${port}`);
});

setInterval(() => {
  for (const result of world.runDueTasks()) broadcastTaskResult(result);
  expireAttachedSessions(world.reapExpiredSessions());
}, 250).unref();

function requireAttached(ws: WebSocket, frameId: string | undefined): AttachedSocket | null {
  const session = sockets.get(ws);
  if (!session) {
    sendNoSession(ws, frameId, "authenticate first");
    return null;
  }
  if (world.sessionAlive(session.sessionId)) return session;
  expireAttachedSessions([session.sessionId]);
  return null;
}

function expireAttachedSessions(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  const expired = new Set(sessionIds);
  for (const [ws, session] of Array.from(sockets.entries())) {
    if (!expired.has(session.sessionId)) continue;
    sockets.delete(ws);
    sendNoSession(ws, undefined, "session token is expired or unknown");
  }
}

function sendNoSession(ws: WebSocket, id: string | undefined, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ op: "error", id, error: { code: "E_NOSESSION", message } }));
}

function authoringEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.WOO_DEV === "1";
}

function broadcastApplied(frame: AppliedFrame, originator?: WebSocket): void {
  for (const [ws, session] of sockets) {
    if (ws.readyState !== ws.OPEN || !world.hasPresence(session.actor, frame.space)) continue;
    const visibleFrame = ws === originator ? frame : { ...frame, id: undefined };
    ws.send(JSON.stringify(visibleFrame));
  }
  broadcastAppliedSse(frame);
}

function broadcastTaskResult(result: ParkedTaskRun): void {
  if (result.frame?.op === "applied") {
    broadcastApplied(result.frame);
    return;
  }
  const space = taskResultSpace(result);
  const data = JSON.stringify({ op: "task", task: result.task.id, space, observations: result.observations });
  for (const [ws, session] of sockets) {
    if (ws.readyState !== ws.OPEN || !world.hasPresence(session.actor, space)) continue;
    ws.send(data);
  }
}

function broadcastLiveEvents(result: DirectResultFrame): void {
  if (!result.audience) return;
  for (const observation of result.observations) broadcastLiveEvent({ op: "event", observation }, result.audience);
}

function broadcastLiveEvent(frame: LiveEventFrame, audience: ObjRef): void {
  const data = JSON.stringify(frame);
  const directedTo = typeof frame.observation.to === "string" ? frame.observation.to : null;
  const directedFrom = typeof frame.observation.from === "string" ? frame.observation.from : null;
  for (const [ws, session] of sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    if (directedTo || directedFrom) {
      if (session.actor !== directedTo && session.actor !== directedFrom) continue;
    } else if (!world.hasPresence(session.actor, audience)) {
      continue;
    }
    ws.send(data);
  }
  broadcastLiveEventSse(frame, audience);
}

function broadcastAppliedSse(frame: AppliedFrame): void {
  for (const stream of Array.from(restStreams)) {
    if (stream.scope === "space") {
      if (stream.target !== frame.space || !world.hasPresence(stream.actor, frame.space)) continue;
    } else if (!world.hasPresence(stream.actor, frame.space)) {
      continue;
    }
    writeSse(stream, "applied", frame, `${frame.space}:${frame.seq}`);
  }
}

function broadcastLiveEventSse(frame: LiveEventFrame, audience: ObjRef): void {
  const directedTo = typeof frame.observation.to === "string" ? frame.observation.to : null;
  const directedFrom = typeof frame.observation.from === "string" ? frame.observation.from : null;
  for (const stream of Array.from(restStreams)) {
    if (directedTo || directedFrom) {
      if (stream.actor !== directedTo && stream.actor !== directedFrom) continue;
    } else if (stream.scope === "space") {
      if (stream.target !== audience || !world.hasPresence(stream.actor, audience)) continue;
    } else if (!world.hasPresence(stream.actor, audience)) {
      continue;
    }
    writeSse(stream, "event", frame);
  }
}

function taskResultSpace(result: ParkedTaskRun): ObjRef {
  const serialized = result.task.serialized;
  if (serialized && typeof serialized === "object" && !Array.isArray(serialized) && typeof serialized.space === "string") return serialized.space;
  return result.task.parked_on;
}

async function handleRestApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
  if (req.method === "POST" && pathname === "/api/auth") {
    try {
      const body = await readJson(req);
      const token = String(body.token ?? "");
      if (!token.startsWith("guest:") && !token.startsWith("session:")) {
        if (!token.startsWith("wizard:")) throw wooError("E_INVARG", "REST accepts guest:, session:, and wizard: tokens");
      }
      const session = authenticateToken(token);
      json(res, { actor: session.actor, session: session.id });
      return true;
    } catch (err) {
      return restError(res, err);
    }
  }

  if (req.method === "POST" && pathname === "/api/tap/install") {
    try {
      const session = requireRestSession(req);
      requireWizard(session.actor);
      const body = await readJson(req);
      const frame = await installGitHubTap(world, session.actor, {
        tap: String(body.tap ?? ""),
        catalog: String(body.catalog ?? ""),
        ref: typeof body.ref === "string" ? body.ref : undefined,
        as: typeof body.as === "string" ? body.as : undefined
      });
      broadcastApplied(frame);
      json(res, frame);
      return true;
    } catch (err) {
      return restError(res, err);
    }
  }

  if (req.method === "GET" && pathname === "/api/taps") {
    try {
      const session = requireRestSession(req);
      requireWizard(session.actor);
      json(res, { catalogs: world.getProp("$catalog_registry", "installed_catalogs") });
      return true;
    } catch (err) {
      return restError(res, err);
    }
  }

  const route = objectRoute(pathname);
  if (!route) return false;

  try {
    const session = requireRestSession(req);
    const target = resolveRestObject(route.id, session);

    if (req.method === "GET" && route.rest.length === 0) {
      json(res, world.describeForActor(target, session.actor));
      return true;
    }

    if (req.method === "GET" && route.rest.length === 2 && route.rest[0] === "properties") {
      const name = route.rest[1];
      const value = world.getPropForActor(session.actor, target, name);
      const info = restPropertyInfo(target, name);
      const ownVersion = world.object(target).propertyVersions.get(name);
      json(res, { ...info, value, version: ownVersion ?? info.version });
      return true;
    }

    if (req.method === "POST" && route.rest.length === 2 && route.rest[0] === "calls") {
      const body = await readJson(req);
      const verb = route.rest[1];
      const args = Array.isArray(body.args) ? (body.args as WooValue[]) : [];
      const actor = resolveRestActor(req, body.actor, session);
      const frameId = typeof body.id === "string" ? body.id : undefined;

      if (verb === "call" && !Object.prototype.hasOwnProperty.call(body, "space") && isSpaceLike(target)) {
        const inner = Array.isArray(body.args) ? body.args[0] : null;
        if (!inner || typeof inner !== "object" || Array.isArray(inner)) throw wooError("E_INVARG", "$space:call expects args[0] to be a message map");
        const message = messageFromRestMap(inner as Record<string, WooValue>, actor, session);
        const result = world.call(frameId, session.id, target, message);
        if (result.op === "error") return restError(res, result.error, statusForError(result.error));
        broadcastApplied(result);
        json(res, result);
        return true;
      }

      if (Object.prototype.hasOwnProperty.call(body, "space") && body.space !== null) {
        const space = resolveRestObject(String(body.space), session);
        const message: Message = {
          actor,
          target,
          verb,
          args,
          body: body.body && typeof body.body === "object" && !Array.isArray(body.body) ? body.body : undefined
        };
        const result = world.call(frameId, session.id, space, message);
        if (result.op === "error") return restError(res, result.error, statusForError(result.error));
        broadcastApplied(result);
        json(res, result);
        return true;
      }

      const forceDirect = req.headers["x-woo-force-direct"] === "1";
      const result = world.directCall(frameId, actor, target, verb, args, { forceDirect, forceReason: "REST X-Woo-Force-Direct" });
      if (result.op === "error") return restError(res, result.error, statusForError(result.error));
      broadcastLiveEvents(result);
      json(res, { result: result.result, observations: result.observations });
      return true;
    }

    if (req.method === "GET" && route.rest.length === 1 && route.rest[0] === "log") {
      if (!isSpaceLike(target)) throw wooError("E_NOTAPPLICABLE", `${target} does not have a sequenced log`, target);
      if (!world.hasPresence(session.actor, target)) throw wooError("E_PERM", `${session.actor} is not present in ${target}`);
      const url = parse(req.url ?? "", true);
      const from = Math.max(1, Number(url.query.from ?? 1));
      const limit = Math.min(Math.max(1, Number(url.query.limit ?? 100)), 1000);
      const entries = world.replay(target, from, limit + 1);
      const messages = entries.slice(0, limit);
      const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : from - 1;
      json(res, { messages, next_seq: lastSeq + 1, has_more: entries.length > limit });
      return true;
    }

    if (req.method === "GET" && route.rest.length === 1 && route.rest[0] === "stream") {
      return openRestStream(req, res, route.id, target, session);
    }
  } catch (err) {
    return restError(res, err);
  }

  return false;
}

function objectRoute(pathname: string): { id: string; rest: string[] } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "objects" || !parts[2]) return null;
  return {
    id: decodeURIComponent(parts[2]),
    rest: parts.slice(3).map((part) => decodeURIComponent(part))
  };
}

function authenticateToken(token: string): Session {
  if (token.startsWith("wizard:")) return claimWizardSession(token.slice("wizard:".length));
  return world.auth(token);
}

function claimWizardSession(token: string): Session {
  return world.claimWizardBootstrapSession(token, process.env.WOO_INITIAL_WIZARD_TOKEN);
}

function requireWizard(actor: ObjRef): void {
  if (!world.object(actor).flags.wizard) throw wooError("E_PERM", "wizard authority required", actor);
}

function requireRestSession(req: http.IncomingMessage): Session {
  const header = req.headers.authorization ?? "";
  const match = Array.isArray(header) ? null : /^Session\s+(.+)$/i.exec(header.trim());
  if (!match) throw wooError("E_NOSESSION", "Authorization: Session <id> required");
  return world.auth(`session:${match[1]}`);
}

function resolveRestObject(id: string, session: Session): ObjRef {
  if (id === "$me") return session.actor;
  world.object(id);
  return id;
}

function resolveRestActor(req: http.IncomingMessage, actorValue: unknown, session: Session): ObjRef {
  const impersonated = req.headers["x-woo-impersonate-actor"];
  const requested = typeof impersonated === "string" ? impersonated : actorValue === undefined || actorValue === null || actorValue === "$me" ? session.actor : String(actorValue);
  if (requested === session.actor) return requested;
  if (world.object(session.actor).flags.wizard) {
    world.object(requested);
    world.recordWizardAction(session.actor, "impersonate", { actor: requested, via: "REST X-Woo-Impersonate-Actor" });
    return requested;
  }
  throw wooError("E_PERM", "actor does not match session actor", { actor: requested, session_actor: session.actor });
}

function messageFromRestMap(value: Record<string, WooValue>, actor: ObjRef, session: Session): Message {
  if (typeof value.target !== "string" || typeof value.verb !== "string") {
    throw wooError("E_INVARG", "message map requires string target and verb");
  }
  return {
    actor,
    target: resolveRestObject(value.target, session),
    verb: value.verb,
    args: Array.isArray(value.args) ? value.args : [],
    body: value.body && typeof value.body === "object" && !Array.isArray(value.body) ? (value.body as Record<string, WooValue>) : undefined
  };
}

function isSpaceLike(obj: ObjRef): boolean {
  try {
    world.getProp(obj, "next_seq");
    return true;
  } catch {
    return false;
  }
}

function restPropertyInfo(obj: ObjRef, name: string): Record<string, WooValue> {
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

function openRestStream(req: http.IncomingMessage, res: http.ServerResponse, rawTarget: string, target: ObjRef, session: Session): boolean {
  const scope: RestStream["scope"] = rawTarget === "$me" || !isSpaceLike(target) ? "actor" : "space";
  if (scope === "space" && !world.hasPresence(session.actor, target)) throw wooError("E_PERM", `${session.actor} is not present in ${target}`);

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const stream: RestStream = { id: `sse-${streamCounter++}`, res, actor: session.actor, target, scope };
  restStreams.add(stream);
  res.write("retry: 1000\n\n");

  const lastEventId = req.headers["last-event-id"];
  if (scope === "space" && typeof lastEventId === "string") {
    const lastSeq = parseLastEventSeq(lastEventId, target);
    if (lastSeq !== null) {
      for (const entry of world.replay(target, lastSeq + 1, 1000)) {
        writeSse(stream, "applied", appliedFromLogEntry(entry), `${entry.space}:${entry.seq}`);
      }
    }
  }

  req.on("close", () => {
    restStreams.delete(stream);
  });
  return true;
}

function parseLastEventSeq(value: string, space: ObjRef): number | null {
  const prefix = `${space}:`;
  if (!value.startsWith(prefix)) return null;
  const seq = Number(value.slice(prefix.length));
  return Number.isFinite(seq) && seq >= 0 ? seq : null;
}

function appliedFromLogEntry(entry: SpaceLogEntry): AppliedFrame & { ts: number } {
  const observations: Observation[] = entry.observations?.length
    ? entry.observations
    : entry.applied_ok
      ? []
      : [{ type: "$error", code: entry.error?.code ?? "E_INTERNAL", message: entry.error?.message ?? entry.error?.code ?? "error", value: entry.error?.value ?? null }];
  return { op: "applied", space: entry.space, seq: entry.seq, message: entry.message, observations, ts: entry.ts };
}

function writeSse(stream: RestStream, event: "applied" | "event", data: unknown, id?: string): void {
  if (stream.res.writableEnded) {
    restStreams.delete(stream);
    return;
  }
  if (id) stream.res.write(`id: ${id}\n`);
  stream.res.write(`event: ${event}\n`);
  stream.res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function restError(res: http.ServerResponse, err: unknown, status?: number): boolean {
  const error = normalizeError(err);
  json(res, { error }, status ?? statusForError(error));
  return true;
}

function statusForError(error: ErrorValue): number {
  switch (error.code) {
    case "E_INVARG":
      return 400;
    case "E_NOSESSION":
    case "E_TOKEN_CONSUMED":
      return 401;
    case "E_BOOTSTRAP_TOKEN_MISSING":
      return 503;
    case "E_PERM":
    case "E_DIRECT_DENIED":
      return 403;
    case "E_OBJNF":
    case "E_VERBNF":
    case "E_PROPNF":
    case "E_NOTAPPLICABLE":
    case "E_NOTFOUND":
      return 404;
    case "E_CONFLICT":
      return 409;
    case "E_TRANSITION":
    case "E_TRANSITION_ROLE_UNSET":
    case "E_TRANSITION_REQUIRES":
      return 422;
    case "E_RATE":
      return 429;
    default:
      return 500;
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}
