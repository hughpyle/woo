import http from "node:http";
import { parse } from "node:url";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import { compileVerb, definePropertyVersioned, installVerb } from "../core/authoring";
import { createWorld } from "../core/bootstrap";
import { normalizeError } from "../core/world";
import { wooError, type AppliedFrame, type Message, type ObjRef } from "../core/types";

// Local dev server only: world state is in memory, and HTTP authoring endpoints
// are intentionally unauthenticated for local poking. Do not deploy as-is.
const world = createWorld();
const sockets = new Map<WebSocket, { sessionId: string; actor: string; socketId: string }>();
let socketCounter = 1;

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "spa"
});

const server = http.createServer(async (req, res) => {
  const url = parse(req.url ?? "", true);
  try {
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
      const body = await readJson(req);
      return json(res, compileVerb(String(body.source ?? ""), { format: body.format }));
    }
    if (req.method === "POST" && url.pathname === "/api/install") {
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
        const session = world.auth(String(frame.token ?? "guest:dev"));
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
        const session = sockets.get(ws);
        if (!session) {
          ws.send(JSON.stringify({ op: "error", id: frame.id, error: { code: "E_NOSESSION", message: "authenticate first" } }));
          return;
        }
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
      if (frame.op === "replay") {
        const session = sockets.get(ws);
        if (!session) {
          ws.send(JSON.stringify({ op: "error", id: frame.id, error: { code: "E_NOSESSION", message: "authenticate first" } }));
          return;
        }
        const space = String(frame.space ?? "") as ObjRef;
        if (!world.hasPresence(session.actor, space)) throw wooError("E_PERM", `${session.actor} is not present in ${space}`);
        const from = Math.max(1, Number(frame.from ?? 1));
        const limit = Math.min(Math.max(1, Number(frame.limit ?? 100)), 500);
        ws.send(JSON.stringify({ op: "replay", id: frame.id, space, from, entries: world.replay(space, from, limit) }));
        return;
      }
      if (frame.op === "ephemeral" && frame.kind === "property") {
        const session = sockets.get(ws);
        if (!session) {
          ws.send(JSON.stringify({ op: "error", id: frame.id, error: { code: "E_NOSESSION", message: "authenticate first" } }));
          return;
        }
        const space = String(frame.space ?? "") as ObjRef;
        if (!world.hasPresence(session.actor, space)) throw wooError("E_PERM", `${session.actor} is not present in ${space}`);
        broadcastEphemeral({
          op: "ephemeral",
          kind: "property",
          space,
          actor: session.actor,
          target: String(frame.target ?? ""),
          name: String(frame.name ?? ""),
          value: frame.value,
          sent_at: Date.now()
        });
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

function broadcastApplied(frame: AppliedFrame, originator: WebSocket): void {
  for (const [ws, session] of sockets) {
    if (ws.readyState !== ws.OPEN || !world.hasPresence(session.actor, frame.space)) continue;
    const visibleFrame = ws === originator ? frame : { ...frame, id: undefined };
    ws.send(JSON.stringify(visibleFrame));
  }
}

function broadcastEphemeral(frame: { op: "ephemeral"; kind: "property"; space: ObjRef; actor: string; target: string; name: string; value: unknown; sent_at: number }): void {
  const data = JSON.stringify(frame);
  for (const [ws, session] of sockets) {
    if (ws.readyState !== ws.OPEN || !world.hasPresence(session.actor, frame.space)) continue;
    ws.send(data);
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
