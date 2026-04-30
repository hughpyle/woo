import type { ObjRef, Session } from "../core/types";

type ObjectRoute = {
  id: ObjRef;
  host: string;
  anchor: ObjRef | null;
  updated_at: number;
};

type SessionRoute = {
  session_id: string;
  actor: ObjRef;
  expires_at: number;
  token_class: Session["tokenClass"];
  updated_at: number;
};

const WORLD_HOST = "world";

export class DirectoryDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true, routes: this.countRows("object_route"), sessions: this.countRows("session_route") });
      }

      if (request.method === "POST" && url.pathname === "/resolve-object") {
        const body = await readJson(request);
        const id = String(body.id ?? "");
        const fallbackHost = typeof body.fallback_host === "string" ? body.fallback_host : WORLD_HOST;
        return json(this.resolveObject(id, fallbackHost));
      }

      if (request.method === "POST" && url.pathname === "/register-objects") {
        const body = await readJson(request);
        const routes = Array.isArray(body.routes) ? body.routes : [];
        this.state.storage.transactionSync(() => {
          for (const route of routes) {
            if (!route || typeof route !== "object") continue;
            const record = route as Record<string, unknown>;
            const id = typeof record.id === "string" ? record.id : "";
            const host = typeof record.host === "string" ? record.host : "";
            if (!id || !host) continue;
            this.registerObject(id, host, typeof record.anchor === "string" ? record.anchor : null);
          }
        });
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/register-session") {
        const body = await readJson(request);
        this.registerSession({
          session_id: String(body.session_id ?? ""),
          actor: String(body.actor ?? "") as ObjRef,
          expires_at: Number(body.expires_at ?? 0),
          token_class: body.token_class === "guest" || body.token_class === "apikey" ? body.token_class : "bearer",
          updated_at: Date.now()
        });
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/resolve-session") {
        const body = await readJson(request);
        return json({ session: this.resolveSession(String(body.session_id ?? "")) });
      }

      return json({ error: { code: "E_OBJNF", message: `no Directory route for ${request.method} ${url.pathname}` } }, 404);
    } catch (err) {
      const error = err && typeof err === "object" && "code" in err
        ? err
        : { code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) };
      return json({ error }, 500);
    }
  }

  private ensureSchema(): void {
    for (const stmt of [
      `CREATE TABLE IF NOT EXISTS object_route (
        id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        anchor TEXT,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS session_route (
        session_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        token_class TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS directory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`
    ]) {
      this.state.storage.sql.exec(stmt);
    }
  }

  private registerObject(id: ObjRef, host: string, anchor: ObjRef | null): void {
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO object_route(id, host, anchor, updated_at) VALUES (?, ?, ?, ?)",
      id,
      host,
      anchor,
      Date.now()
    );
  }

  private resolveObject(id: string, fallbackHost: string): ObjectRoute {
    if (!id) return { id, host: fallbackHost, anchor: null, updated_at: Date.now() };
    const row = firstRow(this.state.storage.sql.exec("SELECT id, host, anchor, updated_at FROM object_route WHERE id = ?", id));
    if (row) {
      return {
        id: String(row.id),
        host: String(row.host),
        anchor: row.anchor === null ? null : String(row.anchor),
        updated_at: Number(row.updated_at)
      };
    }
    const host = id.startsWith("$") ? WORLD_HOST : fallbackHost;
    return { id, host, anchor: null, updated_at: Date.now() };
  }

  private registerSession(session: SessionRoute): void {
    if (!session.session_id || !session.actor || !Number.isFinite(session.expires_at)) return;
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO session_route(session_id, actor, expires_at, token_class, updated_at) VALUES (?, ?, ?, ?, ?)",
      session.session_id,
      session.actor,
      session.expires_at,
      session.token_class,
      Date.now()
    );
  }

  private resolveSession(sessionId: string): SessionRoute | null {
    if (!sessionId) return null;
    const row = firstRow(this.state.storage.sql.exec(
      "SELECT session_id, actor, expires_at, token_class, updated_at FROM session_route WHERE session_id = ?",
      sessionId
    ));
    if (!row) return null;
    const expiresAt = Number(row.expires_at);
    if (expiresAt <= Date.now()) {
      this.state.storage.sql.exec("DELETE FROM session_route WHERE session_id = ?", sessionId);
      return null;
    }
    return {
      session_id: String(row.session_id),
      actor: String(row.actor),
      expires_at: expiresAt,
      token_class: row.token_class === "guest" || row.token_class === "apikey" ? row.token_class : "bearer",
      updated_at: Number(row.updated_at)
    };
  }

  private countRows(table: string): number {
    return Number(firstValue(this.state.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`)) ?? 0);
  }
}

function firstRow(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): Record<string, unknown> | null {
  const rows = [...cursor] as Record<string, unknown>[];
  return rows[0] ?? null;
}

function firstValue(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): unknown {
  const row = firstRow(cursor);
  if (!row) return null;
  return Object.values(row)[0] ?? null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
