import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileVerb, installVerb } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import { InMemoryObjectRepository } from "../src/core/repository";
import type { Message, TinyBytecode, VerbDef, WooValue } from "../src/core/types";
import type { WooWorld } from "../src/core/world";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";

type Harness = {
  world: WooWorld;
  restart: () => WooWorld;
  cleanup: () => void;
};

type Backend = {
  name: string;
  make: () => Harness;
};

const backends: Backend[] = [
  {
    name: "memory",
    make: () => {
      const repo = new InMemoryObjectRepository();
      let world = createWorld({ repository: repo });
      return {
        get world() {
          return world;
        },
        restart: () => {
          world = createWorld({ repository: repo });
          return world;
        },
        cleanup: () => undefined
      };
    }
  },
  {
    name: "sqlite",
    make: () => {
      const dir = mkdtempSync(join(tmpdir(), "woo-conformance-"));
      const path = join(dir, "world.sqlite");
      let repo = new LocalSQLiteRepository(path);
      let world = createWorld({ repository: repo });
      return {
        get world() {
          return world;
        },
        restart: () => {
          repo.close();
          repo = new LocalSQLiteRepository(path);
          world = createWorld({ repository: repo });
          return world;
        },
        cleanup: () => {
          repo.close();
          rmSync(dir, { recursive: true, force: true });
        }
      };
    }
  }
];

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
    source: `conformance ${name}`,
    source_hash: `conformance-${name}`,
    version: 1,
    line_map: {},
    bytecode
  };
}

function installForkFixture(world: WooWorld): void {
  world.addVerb(
    "delay_1",
    bytecodeVerb("conf_mark", {
      literals: ["conf_forked", "type", "conf_fork_ran", "value", null],
      num_locals: 0,
      max_stack: 6,
      version: 1,
      ops: [
        ["PUSH_THIS"],
        ["PUSH_LIT", 0],
        ["PUSH_ARG", 0],
        ["SET_PROP"],
        ["PUSH_LIT", 1],
        ["PUSH_LIT", 2],
        ["PUSH_LIT", 3],
        ["PUSH_ARG", 0],
        ["MAKE_MAP", 2],
        ["OBSERVE"],
        ["PUSH_LIT", 4],
        ["RETURN"]
      ]
    })
  );
  world.addVerb(
    "delay_1",
    bytecodeVerb("conf_schedule_mark", {
      literals: ["conf_mark"],
      num_locals: 0,
      max_stack: 5,
      version: 1,
      ops: [["PUSH_INT", 0], ["PUSH_THIS"], ["PUSH_LIT", 0], ["PUSH_ARG", 0], ["FORK", 1], ["RETURN"]]
    })
  );
}

function installReadFixture(world: WooWorld): void {
  world.addVerb(
    "delay_1",
    bytecodeVerb("conf_read_then_mark", {
      literals: ["conf_read_value", "type", "conf_read_resumed", "value", null],
      num_locals: 1,
      max_stack: 6,
      version: 1,
      ops: [
        ["PUSH_ACTOR"],
        ["READ"],
        ["POP_LOCAL", 0],
        ["PUSH_THIS"],
        ["PUSH_LIT", 0],
        ["PUSH_LOCAL", 0],
        ["SET_PROP"],
        ["PUSH_LIT", 1],
        ["PUSH_LIT", 2],
        ["PUSH_LIT", 3],
        ["PUSH_LOCAL", 0],
        ["MAKE_MAP", 2],
        ["OBSERVE"],
        ["PUSH_LIT", 4],
        ["RETURN"]
      ]
    })
  );
}

function installFailureFixture(world: WooWorld): void {
  world.addVerb(
    "delay_1",
    bytecodeVerb("conf_mutate_then_fail", {
      literals: ["conf_failed_value", "E_CONF_FAIL"],
      num_locals: 0,
      max_stack: 3,
      version: 1,
      ops: [["PUSH_THIS"], ["PUSH_LIT", 0], ["PUSH_ARG", 0], ["SET_PROP"], ["PUSH_LIT", 1], ["RAISE"], ["PUSH_INT", 0], ["RETURN"]]
    })
  );
}

describe.each(backends)("world conformance: $name", ({ make }) => {
  it("sequences calls, supports idempotent retry, replay paging, and behavior rollback", () => {
    const harness = make();
    try {
      const world = harness.world;
      const session = world.auth("guest:conf-sequence");
      const firstMessage = message(session.actor, "the_dubspace", "set_control", ["delay_1", "feedback", 0.71]);
      const first = world.call("same-frame", session.id, "the_dubspace", firstMessage);
      const retry = world.call("same-frame", session.id, "the_dubspace", firstMessage);
      expect(retry).toEqual(first);
      expect(world.replay("the_dubspace", 1, 10)).toHaveLength(1);

      const failed = world.call("missing", session.id, "the_dubspace", message(session.actor, "delay_1", "missing_verb", []));
      expect(failed.op).toBe("applied");
      if (failed.op === "applied") {
        expect(failed.seq).toBe(2);
        expect(failed.observations[0]).toMatchObject({ type: "$error", code: "E_VERBNF" });
      }
      expect(world.getProp("delay_1", "feedback")).toBe(0.71);
      expect(world.getProp("the_dubspace", "next_seq")).toBe(3);
      expect(world.replay("the_dubspace", 1, 1).map((entry) => entry.seq)).toEqual([1]);
      expect(world.replay("the_dubspace", 2, 10).map((entry) => [entry.seq, entry.applied_ok])).toEqual([
        [2, false]
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it("records behavior failures while rolling back behavior mutations", () => {
    const harness = make();
    try {
      const world = harness.world;
      installFailureFixture(world);
      const session = world.auth("guest:conf-fail");
      const applied = world.call("mutate-fail", session.id, "the_dubspace", message(session.actor, "delay_1", "conf_mutate_then_fail", ["discarded"]));

      expect(applied.op).toBe("applied");
      if (applied.op === "applied") {
        expect(applied.seq).toBe(1);
        expect(applied.observations).toHaveLength(1);
        expect(applied.observations[0]).toMatchObject({ type: "$error", code: "E_CONF_FAIL" });
      }
      expect(world.propOrNull("delay_1", "conf_failed_value")).toBeNull();
      expect(world.getProp("the_dubspace", "next_seq")).toBe(2);
      expect(world.replay("the_dubspace", 1, 10)).toMatchObject([{ seq: 1, applied_ok: false, error: { code: "E_CONF_FAIL" } }]);
    } finally {
      harness.cleanup();
    }
  });

  it("keeps direct observations live-only while sequenced observations are replayable", () => {
    const harness = make();
    try {
      const world = harness.world;
      const session = world.auth("guest:conf-direct");
      const preview = world.directCall("preview", session.actor, "the_dubspace", "preview_control", ["delay_1", "feedback", 0.42]);
      expect(preview.op).toBe("result");
      if (preview.op === "result") expect(preview.observations[0].type).toBe("gesture_progress");
      expect(world.getProp("delay_1", "feedback")).toBe(0.35);
      expect(world.replay("the_dubspace", 1, 10)).toEqual([]);

      const sequenced = world.call("apply", session.id, "the_dubspace", message(session.actor, "the_dubspace", "set_control", ["delay_1", "feedback", 0.42]));
      expect(sequenced.op).toBe("applied");
      expect(world.getProp("delay_1", "feedback")).toBe(0.42);
      expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["set_control"]);
    } finally {
      harness.cleanup();
    }
  });

  it("persists world state, sessions, logs, snapshots, and counters across restart", () => {
    const harness = make();
    try {
      let world = harness.world;
      const session = world.auth("guest:conf-restart");
      world.call("persisted-call", session.id, "the_dubspace", message(session.actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.64]));
      const snapshot = world.saveSnapshot("the_dubspace");

      world = harness.restart();
      expect(world.getProp("delay_1", "wet")).toBe(0.64);
      expect(world.getProp("the_dubspace", "next_seq")).toBe(2);
      expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["set_control"]);
      expect(world.latestSnapshot("the_dubspace")?.hash).toBe(snapshot.hash);
      expect(world.auth(`session:${session.id}`).actor).toBe(session.actor);

      const nextSession = world.auth("guest:conf-restart-next");
      expect(nextSession.id).not.toBe(session.id);
    } finally {
      harness.cleanup();
    }
  });

  it("reaps detached guest sessions and returns guest actors to the pool", () => {
    const harness = make();
    try {
      const world = harness.world;
      const session = world.auth("guest:conf-reap");
      const actor = session.actor;
      world.directCall("enter-chat", actor, "the_chatroom", "enter", []);
      world.setProp(actor, "description", "temporary");
      world.setProp(actor, "aliases", ["temp"]);
      world.attachSocket(session.id, "ws-1");
      world.detachSocket(session.id, "ws-1");
      const detachedAt = world.sessions.get(session.id)?.lastDetachAt ?? Date.now();

      expect(world.reapExpiredSessions(detachedAt + 60_001)).toEqual([session.id]);
      expect(world.sessions.has(session.id)).toBe(false);
      expect(world.hasPresence(actor, "the_dubspace")).toBe(false);
      expect(world.hasPresence(actor, "the_taskspace")).toBe(false);
      expect(world.hasPresence(actor, "the_chatroom")).toBe(false);
      expect(world.getProp(actor, "session_id")).toBeNull();
      expect(world.getProp(actor, "description")).toBe("");
      expect(world.getProp(actor, "aliases")).toEqual([]);
      expect(world.object(actor).location).toBe("$nowhere");
      expect(world.auth("guest:conf-reuse").actor).toBe(actor);
    } finally {
      harness.cleanup();
    }
  });

  it("resumes delayed FORK work through a new sequenced frame", () => {
    const harness = make();
    try {
      const world = harness.world;
      installForkFixture(world);
      const session = world.auth("guest:conf-fork");
      const scheduled = world.call("fork", session.id, "the_dubspace", message(session.actor, "delay_1", "conf_schedule_mark", ["later"]));
      expect(scheduled.op).toBe("applied");
      expect(world.parkedTasks.size).toBe(1);
      expect(world.propOrNull("delay_1", "conf_forked")).toBeNull();

      const ran = world.runDueTasks(Date.now() + 1);
      expect(ran).toHaveLength(1);
      expect(ran[0].frame?.op).toBe("applied");
      if (ran[0].frame?.op === "applied") {
        expect(ran[0].frame.seq).toBe(2);
        expect(ran[0].frame.message.verb).toBe("conf_mark");
        expect(ran[0].frame.observations[0].type).toBe("conf_fork_ran");
      }
      expect(world.getProp("delay_1", "conf_forked")).toBe("later");
      expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["conf_schedule_mark", "conf_mark"]);
    } finally {
      harness.cleanup();
    }
  });

  it("persists READ parking across restart and resumes through a sequenced input frame", () => {
    const harness = make();
    try {
      let world = harness.world;
      installReadFixture(world);
      const session = world.auth("guest:conf-read");
      const waiting = world.call("read", session.id, "the_dubspace", message(session.actor, "delay_1", "conf_read_then_mark", []));
      expect(waiting.op).toBe("applied");
      expect(world.parkedTasks.size).toBe(1);

      world = harness.restart();
      expect(world.parkedTasks.size).toBe(1);
      const ran = world.deliverInput(session.actor, "typed text");
      expect(ran?.frame?.op).toBe("applied");
      if (ran?.frame?.op === "applied") {
        expect(ran.frame.seq).toBe(2);
        expect(ran.frame.message.verb).toBe("$resume");
        expect(ran.frame.message.body?.kind).toBe("vm_read");
        expect(ran.frame.message.body?.input).toBe("typed text");
        expect(ran.frame.observations.map((obs) => obs.type)).toContain("conf_read_resumed");
      }
      expect(world.getProp("delay_1", "conf_read_value")).toBe("typed text");
      expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["conf_read_then_mark", "$resume"]);
      expect(world.parkedTasks.size).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  it("runs taskspace hierarchy and relaxed done transition", () => {
    const harness = make();
    try {
      const world = harness.world;
      const owner = world.auth("guest:conf-task-owner");
      const other = world.auth("guest:conf-task-other");
      const created = world.call("create", owner.id, "the_taskspace", message(owner.actor, "the_taskspace", "create_task", ["Conform", "Test the world"]));
      expect(created.op).toBe("applied");
      const task = created.op === "applied" ? (created.observations[0].task as string) : "";
      const sub = world.call("subtask", owner.id, "the_taskspace", message(owner.actor, task, "add_subtask", ["Sub", "Child"]));
      expect(sub.op).toBe("applied");
      expect(world.getProp(task, "subtasks")).toHaveLength(1);
      world.call("claim", owner.id, "the_taskspace", message(owner.actor, task, "claim", []));
      const blocked = world.call("blocked-by-other", other.id, "the_taskspace", message(other.actor, task, "set_status", ["blocked"]));
      if (blocked.op === "applied") expect(blocked.observations[0].code).toBe("E_PERM");
      const done = world.call("done-by-other", other.id, "the_taskspace", message(other.actor, task, "set_status", ["done"]));
      expect(done.op).toBe("applied");
      expect(world.getProp(task, "status")).toBe("done");
    } finally {
      harness.cleanup();
    }
  });

  it("compiles and installs source with optimistic version checks", () => {
    const harness = make();
    try {
      const world = harness.world;
      const session = world.auth("guest:conf-authoring");
      const source = `verb :conf_set_feedback(value) rx {
  this.feedback = value;
  observe({ type: "conf_feedback", value: value, actor: actor });
  return value;
}`;
      const compiled = compileVerb(source);
      expect(compiled.ok).toBe(true);
      expect(installVerb(world, "delay_1", "conf_set_feedback", source, null).ok).toBe(true);
      const applied = world.call("authored", session.id, "the_dubspace", message(session.actor, "delay_1", "conf_set_feedback", [0.83]));
      expect(applied.op).toBe("applied");
      if (applied.op === "applied") expect(applied.observations[0]).toMatchObject({ type: "conf_feedback", value: 0.83, actor: session.actor });
      expect(world.getProp("delay_1", "feedback")).toBe(0.83);
      expect(() => installVerb(world, "delay_1", "conf_set_feedback", source, null)).toThrow();
      expect(installVerb(world, "delay_1", "conf_set_feedback", source, 1).version).toBe(2);
    } finally {
      harness.cleanup();
    }
  });
});
