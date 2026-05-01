import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createWorld } from "../../src/core/bootstrap";
import type { Message, ObjRef, TinyBytecode, VerbDef, WooValue } from "../../src/core/types";
import type { CallContext, HostBridge, MoveObjectResult, WooWorld } from "../../src/core/world";
import { CFObjectRepository } from "../../src/worker/cf-repository";

class FakeSqlCursor {
  constructor(private readonly rows: Record<string, unknown>[]) {}

  toArray(): Record<string, unknown>[] {
    return this.rows;
  }
}

class FakeSqlStorage {
  constructor(private readonly db: DatabaseSync) {}

  exec(query: string, ...params: unknown[]): FakeSqlCursor {
    const stmt = this.db.prepare(query);
    const head = query.trim().split(/\s+/, 1)[0]?.toUpperCase();
    if (head === "SELECT" || head === "PRAGMA") {
      return new FakeSqlCursor(stmt.all(...(params as any[])) as Record<string, unknown>[]);
    }
    stmt.run(...(params as any[]));
    return new FakeSqlCursor([]);
  }
}

class FakeDurableObjectState {
  private readonly db = new DatabaseSync(":memory:");
  private transactionDepth = 0;
  private savepointCounter = 0;

  readonly storage = {
    sql: new FakeSqlStorage(this.db),
    transactionSync: <T>(fn: () => T): T => this.transactionSync(fn)
  };

  close(): void {
    this.db.close();
  }

  private transactionSync<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      const name = `fake_cf_sp_${++this.savepointCounter}`;
      this.db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
        throw err;
      }
    }

    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.transactionDepth = 0;
    }
  }
}

type Harness = {
  world: WooWorld;
  restart: () => WooWorld;
  cleanup: () => void;
};

function makeCfHarness(): Harness {
  const state = new FakeDurableObjectState();
  let repo = new CFObjectRepository(state as unknown as DurableObjectState);
  let world = createWorld({ repository: repo });
  return {
    get world() {
      return world;
    },
    restart: () => {
      repo = new CFObjectRepository(state as unknown as DurableObjectState);
      world = createWorld({ repository: repo });
      return world;
    },
    cleanup: () => state.close()
  };
}

function message(actor: string, target: string, verb: string, args: WooValue[] = []): Message {
  return { actor, target, verb, args };
}

function bytecodeVerb(name: string, bytecode: TinyBytecode): VerbDef {
  return {
    kind: "bytecode",
    name,
    aliases: [],
    owner: "$wiz",
    perms: "rxd",
    arg_spec: {},
    source: `cf conformance ${name}`,
    source_hash: `cf-conformance-${name}`,
    version: 1,
    line_map: {},
    bytecode
  };
}

function installFailureFixture(world: WooWorld): void {
  world.addVerb(
    "delay_1",
    bytecodeVerb("cf_mutate_then_fail", {
      literals: ["cf_failed_value", "E_CF_FAIL"],
      num_locals: 0,
      max_stack: 3,
      version: 1,
      ops: [["PUSH_THIS"], ["PUSH_LIT", 0], ["PUSH_ARG", 0], ["SET_PROP"], ["PUSH_LIT", 1], ["RAISE"], ["PUSH_INT", 0], ["RETURN"]]
    })
  );
}

class FakeHostBridge implements HostBridge {
  constructor(
    readonly localHost: string,
    private readonly worlds: Map<string, WooWorld>,
    private readonly routes: Map<ObjRef, string>
  ) {}

  hostForObject(id: ObjRef): string | null {
    return this.routes.get(id) ?? null;
  }

  async getPropChecked(progr: ObjRef, objRef: ObjRef, name: string): Promise<WooValue> {
    return await this.worldFor(objRef).getPropChecked(progr, objRef, name);
  }

  async describeObject(_nameActor: ObjRef, readActor: ObjRef, objRef: ObjRef): Promise<{ name: WooValue | null; description: WooValue | null; aliases: WooValue | null }> {
    const world = this.worldFor(objRef);
    return {
      name: world.object(objRef).name,
      description: world.propOrNullForActor(readActor, objRef, "description"),
      aliases: world.propOrNullForActor(readActor, objRef, "aliases")
    };
  }

  async resolveVerb(target: ObjRef, verbName: string): Promise<{ name: string; direct_callable: boolean } | null> {
    const world = this.worldFor(target);
    try {
      const { verb } = world.resolveVerb(target, verbName);
      return { name: verb.name, direct_callable: verb.direct_callable === true };
    } catch {
      return null;
    }
  }

  async location(objRef: ObjRef): Promise<ObjRef | null> {
    return this.worldFor(objRef).object(objRef).location;
  }

  async dispatch(ctx: CallContext, target: ObjRef, verbName: string, args: WooValue[], startAt?: ObjRef | null): Promise<WooValue> {
    const remote = this.worldFor(startAt ?? target);
    return await remote.hostDispatch({ ...ctx, world: remote }, target, verbName, args, startAt);
  }

  async moveObject(objRef: ObjRef, targetRef: ObjRef): Promise<MoveObjectResult> {
    return await this.worldFor(objRef).moveObjectChecked(objRef, targetRef, { suppressMirrorHost: this.localHost });
  }

  async mirrorContents(containerRef: ObjRef, objRef: ObjRef, present: boolean): Promise<void> {
    this.worldFor(containerRef).mirrorContents(containerRef, objRef, present);
  }

  async setActorPresence(actor: ObjRef, space: ObjRef, present: boolean): Promise<void> {
    this.worldFor(actor).setActorPresence(actor, space, present);
  }

  async setSpaceSubscriber(space: ObjRef, actor: ObjRef, present: boolean): Promise<void> {
    this.worldFor(space).setSpaceSubscriber(space, actor, present);
  }

  async contents(objRef: ObjRef): Promise<ObjRef[]> {
    return this.worldFor(objRef).contentsOf(objRef);
  }

  private worldFor(id: ObjRef): WooWorld {
    const host = this.routes.get(id);
    if (!host) throw new Error(`no route for ${id}`);
    const world = this.worlds.get(host);
    if (!world) throw new Error(`no world for ${host}`);
    return world;
  }
}

describe("CFObjectRepository production-shape coverage", () => {
  it("boots, persists, and reloads through the CF storage API shape", async () => {
    const harness = makeCfHarness();
    try {
      let world = harness.world;
      const session = world.auth("guest:cf-repo-reload");
      const applied = await world.call("cf-set-control", session.id, "the_dubspace", message(session.actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.58]));
      expect(applied.op).toBe("applied");
      const snapshot = world.saveSnapshot("the_dubspace");

      world = harness.restart();
      expect(world.getProp("delay_1", "wet")).toBe(0.58);
      expect(world.getProp("the_dubspace", "next_seq")).toBe(2);
      expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["set_control"]);
      expect(world.latestSnapshot("the_dubspace")?.hash).toBe(snapshot.hash);
      expect(world.verbInfo("the_chatroom", "enter").direct_callable).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it("uses CF nested transaction savepoints for behavior rollback", async () => {
    const harness = makeCfHarness();
    try {
      const world = harness.world;
      installFailureFixture(world);
      const session = world.auth("guest:cf-savepoint");
      const applied = await world.call("cf-fail", session.id, "the_dubspace", message(session.actor, "delay_1", "cf_mutate_then_fail", ["discarded"]));

      expect(applied.op).toBe("applied");
      if (applied.op === "applied") {
        expect(applied.seq).toBe(1);
        expect(applied.observations[0]).toMatchObject({ type: "$error", code: "E_CF_FAIL" });
      }
      expect(world.propOrNull("delay_1", "cf_failed_value")).toBeNull();
      expect(world.replay("the_dubspace", 1, 10)).toMatchObject([{ seq: 1, applied_ok: false, error: { code: "E_CF_FAIL" } }]);
    } finally {
      harness.cleanup();
    }
  });

  it("resolves commands against a remote current room with CF-backed hosts", async () => {
    const homeHarness = makeCfHarness();
    const roomHarness = makeCfHarness();
    try {
      const home = homeHarness.world;
      const roomHost = roomHarness.world;
      const session = home.auth("guest:cf-remote-command-match");
      const actor = session.actor;
      const worlds = new Map<string, WooWorld>([
        ["home", home],
        ["room", roomHost]
      ]);
      const routes = new Map<ObjRef, string>([
        [actor, "home"],
        ["cf_remote_room", "room"],
        ["cf_home_widget", "home"]
      ]);
      home.setHostBridge(new FakeHostBridge("home", worlds, routes));
      roomHost.setHostBridge(new FakeHostBridge("room", worlds, routes));

      roomHost.createObject({ id: "cf_remote_room", name: "Remote Room", parent: "$chatroom", owner: "$wiz" });
      roomHost.setProp("cf_remote_room", "subscribers", [actor]);
      roomHost.setProp("cf_remote_room", "features", ["$conversational"]);
      roomHost.setProp("cf_remote_room", "aliases", ["remote room"]);
      if (!roomHost.objects.has(actor)) roomHost.createObject({ id: actor, name: actor, parent: "$guest", owner: "$wiz" });
      roomHost.setActorPresence(actor, "cf_remote_room", true);

      home.object(actor).location = "cf_remote_room";
      home.setActorPresence(actor, "cf_remote_room", true);
      home.createObject({ id: "cf_home_widget", name: "Home Widget", parent: "$thing", owner: "$wiz", location: "cf_remote_room" });
      home.setProp("cf_home_widget", "aliases", ["widget"]);
      home.addVerb("cf_home_widget", {
        kind: "native",
        name: "ping",
        aliases: ["p*ing"],
        owner: "$wiz",
        perms: "rxd",
        arg_spec: {},
        source: "verb :ping() rxd { return \"pong\"; }",
        source_hash: "cf-remote-command-ping",
        version: 1,
        line_map: {},
        native: "describe",
        direct_callable: true
      });
      roomHost.mirrorContents("cf_remote_room", actor, true);
      roomHost.mirrorContents("cf_remote_room", "cf_home_widget", true);

      const parsedHere = await home.directCall("cf-parse-remote-here", actor, "$match", "parse_command", ["look here", actor]);
      expect(parsedHere.op).toBe("result");
      if (parsedHere.op === "result") expect(parsedHere.result).toMatchObject({ dobj: "cf_remote_room", dobjstr: "here" });

      const parsedWidget = await home.directCall("cf-parse-remote-widget", actor, "$match", "parse_command", ["look widget", actor]);
      expect(parsedWidget.op).toBe("result");
      if (parsedWidget.op === "result") expect(parsedWidget.result).toMatchObject({ dobj: "cf_home_widget", dobjstr: "widget" });

      const plan = await roomHost.directCall("cf-plan-cross-host-widget", actor, "cf_remote_room", "command_plan", ["ping widget"]);
      expect(plan.op).toBe("result");
      if (plan.op === "result") expect(plan.result).toMatchObject({ ok: true, route: "direct", target: "cf_home_widget", verb: "ping", args: [] });
    } finally {
      roomHarness.cleanup();
      homeHarness.cleanup();
    }
  });
});
