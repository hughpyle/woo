import { describe, expect, it } from "vitest";
import { compileVerb, definePropertyVersioned, installVerb } from "../src/core/authoring";
import { bootstrap, createWorld, createWorldFromSerialized, nonEmptyHostScopedWorld, scopeSerializedWorldToHost } from "../src/core/bootstrap";
import { bundledCatalogAliases, installLocalCatalogs } from "../src/core/local-catalogs";
import type { Message, VerbDef } from "../src/core/types";

function message(actor: string, target: string, verb: string, args: unknown[] = []): Message {
  return { actor, target, verb, args: args as any[] };
}

function authedWorld() {
  const world = createWorld();
  const session = world.auth("guest:test");
  return { world, session, actor: session.actor };
}

function nativeVerb(name: string, native = "describe", owner = "$wiz"): VerbDef {
  return {
    kind: "native",
    name,
    aliases: [],
    owner,
    perms: "rx",
    arg_spec: {},
    source: `verb :${name}() rx { ... }`,
    source_hash: `test-${name}`,
    version: 1,
    line_map: {},
    native
  };
}

describe("woo core", () => {
  it("bootstraps the seed graph and describes objects", () => {
    const world = createWorld();
    expect(world.object("$root").id).toBe("$root");
    expect(world.object("the_dubspace").parent).toBe("$dubspace");
    expect(world.object("the_taskspace").parent).toBe("$taskspace");
    const description = world.describe("the_dubspace");
    expect(description.id).toBe("the_dubspace");
    expect(description.description).toContain("sound-space");
    expect(description.flags).toEqual({ wizard: false, programmer: false, fertile: false, recyclable: false });
    expect(description.verbs).toContain("set_control");
    expect(description.schemas).toContain("control_changed");
  });

  it("enforces property read permissions for actor-facing introspection", () => {
    const { world, actor } = authedWorld();
    const name = "private_rest_probe";
    world.defineProperty("the_taskspace", {
      name,
      defaultValue: "secret",
      owner: "$wiz",
      perms: "w",
      typeHint: "str"
    });

    expect(world.describeForActor("the_taskspace", actor).properties).toContain(name);
    expect(() => world.getPropForActor(actor, "the_taskspace", name)).toThrow(/cannot read/);
    expect(world.getPropForActor("$wiz", "the_taskspace", name)).toBe("secret");

    world.defineProperty("the_taskspace", {
      name: "description",
      defaultValue: "private taskspace",
      owner: "$wiz",
      perms: "w",
      typeHint: "str"
    });
    world.setProp("the_taskspace", "description", "private taskspace");
    expect((world.state(actor).objects.the_taskspace as Record<string, unknown>).description).toBeNull();
    expect((world.state("$wiz").objects.the_taskspace as Record<string, unknown>).description).toBe("private taskspace");
  });

  it("seeds readable descriptions for every bootstrap object", () => {
    const world = createWorld();
    for (const id of world.objects.keys()) {
      const description = world.getProp(id, "description");
      expect(typeof description, id).toBe("string");
      expect((description as string).length, id).toBeGreaterThan(40);
    }
  });

  it("installs first-light demos from local catalog manifests", () => {
    const world = createWorld();
    const installed = world.getProp("$catalog_registry", "installed_catalogs") as Record<string, unknown>[];
    const aliases = bundledCatalogAliases();
    expect(installed.map((record) => record.alias)).toEqual(aliases);
    expect(world.replay("$catalog_registry", 1, 10).map((entry) => entry.message.verb)).toEqual(aliases.map(() => "install"));
    bootstrap(world);
    expect(world.replay("$catalog_registry", 1, 10).map((entry) => entry.message.verb)).toEqual(aliases.map(() => "install"));
    expect(world.object("catalog_dubspace").parent).toBe("$catalog");
    expect(world.object("$space").parent).toBe("$sequenced_log");
    expect(world.object("$dubspace").parent).toBe("$space");
    expect(world.object("$taskspace").parent).toBe("$space");
    expect(world.object("$conversational").parent).toBe("$thing");
    expect(world.object("$dubspace").eventSchemas.has("control_changed")).toBe(true);
    expect(world.verbInfo("the_dubspace", "set_control").source).toContain("target.(name)");
    expect(world.verbInfo("the_dubspace", "start_loop").bytecode_version).toBeGreaterThan(0);
    expect(world.verbInfo("the_chatroom", "say").definer).toBe("$conversational");
  });

  it("can boot without demo catalogs and install them later", () => {
    const world = createWorld({ catalogs: false });
    expect(() => world.object("the_dubspace")).toThrow(/E_OBJNF|object not found/);
    expect(world.getProp("$catalog_registry", "installed_catalogs")).toEqual([]);
    const session = world.auth("guest:clean");
    expect(world.getProp(session.actor, "presence_in")).toEqual([]);

    installLocalCatalogs(world, ["chat", "taskspace", "dubspace"]);
    expect(world.object("the_chatroom").parent).toBe("$chatroom");
    expect(world.object("the_taskspace").parent).toBe("$taskspace");
    expect(world.object("the_dubspace").parent).toBe("$dubspace");
    expect(world.verbInfo("the_taskspace", "say").definer).toBe("$conversational");
  });

  it("exports host-scoped worlds for routed cluster hosts", () => {
    const world = createWorld();
    const session = world.auth("guest:host-scope");
    const scoped = world.exportHostScopedWorld("the_taskspace");
    const ids = scoped.objects.map((obj) => obj.id);

    expect(ids).toContain("the_taskspace");
    expect(ids).toContain("$taskspace");
    expect(ids).toContain("$task");
    expect(ids).toContain("$conversational");
    expect(ids).toContain(session.actor);
    expect(ids).not.toContain("the_dubspace");
    expect(ids).not.toContain("the_chatroom");
    expect(scoped.sessions).toEqual([]);
    expect(scoped.logs.every(([space]) => space === "the_taskspace")).toBe(true);

    const cluster = createWorldFromSerialized(scoped, { persist: false });
    cluster.ensureSessionForActor(session.id, session.actor, session.tokenClass, session.expiresAt);
    const created = cluster.call("host-scope-create", session.id, "the_taskspace", message(session.actor, "the_taskspace", "create_task", ["Scoped", ""]));
    expect(created.op).toBe("applied");
    if (created.op !== "applied") return;
    const task = String(created.observations.find((obs) => obs.type === "task_created")?.task ?? "");
    expect(task).toMatch(/^obj_the_taskspace_/);
    expect(cluster.object(task).parent).toBe("$task");
    expect(cluster.objectRoutes()).toContainEqual({ id: task, host: "the_taskspace", anchor: "the_taskspace" });
  });

  it("treats stored worlds without a host slice as unusable for cluster boot", () => {
    const full = createWorld().exportWorld();
    const stale = {
      ...full,
      objects: full.objects.map((obj) => obj.id === "the_dubspace"
        ? { ...obj, properties: obj.properties.filter(([name]) => name !== "host_placement") }
        : obj)
    };

    expect(nonEmptyHostScopedWorld(stale, "the_dubspace")).toBeNull();
    expect(nonEmptyHostScopedWorld(full, "the_dubspace")?.objects.map((obj) => obj.id)).toContain("the_dubspace");
  });

  it("can prune a full serialized world to one host slice", () => {
    const full = createWorld().exportWorld();
    const scoped = scopeSerializedWorldToHost(full, "the_dubspace");
    const ids = scoped.objects.map((obj) => obj.id);

    expect(ids).toContain("the_dubspace");
    expect(ids).toContain("$dubspace");
    expect(ids).toContain("$loop_slot");
    expect(ids).toContain("slot_1");
    expect(ids).not.toContain("the_taskspace");
    expect(ids).not.toContain("the_chatroom");
  });

  it("sequences calls and emits observations", () => {
    const { world, session, actor } = authedWorld();
    const first = world.call("1", session.id, "the_dubspace", message(actor, "the_dubspace", "set_control", ["delay_1", "feedback", 0.77]));
    const second = world.call("2", session.id, "the_dubspace", message(actor, "the_dubspace", "set_control", ["filter_1", "cutoff", 1440]));
    expect(first.op).toBe("applied");
    expect(second.op).toBe("applied");
    if (first.op === "applied" && second.op === "applied") {
      expect(first.seq).toBe(1);
      expect(second.seq).toBe(2);
      expect(first.observations[0].type).toBe("control_changed");
    }
    expect(world.getProp("delay_1", "feedback")).toBe(0.77);
    expect(world.getProp("filter_1", "cutoff")).toBe(1440);
    expect(world.replay("the_dubspace", 2, 1).map((entry) => entry.seq)).toEqual([2]);
  });

  it("resumes a live session token", () => {
    const world = createWorld();
    const first = world.auth("guest:resume");
    const resumed = world.auth(`session:${first.id}`);
    expect(resumed.id).toBe(first.id);
    expect(resumed.actor).toBe(first.actor);
  });

  it("claims the wizard bootstrap token exactly once", () => {
    const world = createWorld({ catalogs: false });
    const session = world.claimWizardBootstrapSession("secret", "secret");
    expect(session.actor).toBe("$wiz");
    expect(world.getProp("$system", "bootstrap_token_used")).toBe(true);
    expect(() => world.claimWizardBootstrapSession("secret", "secret")).toThrow(/E_TOKEN_CONSUMED|already been consumed/);
  });

  it("allocates guest instances, not the guest class", () => {
    const world = createWorld();
    const session = world.auth("guest:instance");
    expect(session.actor).toMatch(/^guest_/);
    expect(session.actor).not.toBe("$guest");
    expect(world.object(session.actor).parent).toBe("$guest");
  });

  it("does not join the chatroom until explicit enter", () => {
    const world = createWorld();
    const session = world.auth("guest:no-chat-autojoin");
    expect(world.hasPresence(session.actor, "the_dubspace")).toBe(true);
    expect(world.hasPresence(session.actor, "the_taskspace")).toBe(true);
    expect(world.hasPresence(session.actor, "the_chatroom")).toBe(false);

    const enter = world.directCall("enter-chat", session.actor, "the_chatroom", "enter", []);
    expect(enter.op).toBe("result");
    expect(world.hasPresence(session.actor, "the_chatroom")).toBe(true);
  });

  it("keeps detached guest sessions resumable during grace", () => {
    const world = createWorld();
    const session = world.auth("guest:grace");
    world.attachSocket(session.id, "ws-1");
    world.detachSocket(session.id, "ws-1");
    expect(world.sessions.get(session.id)?.lastDetachAt).toEqual(expect.any(Number));

    const resumed = world.auth(`session:${session.id}`);
    world.attachSocket(resumed.id, "ws-2");
    expect(resumed.actor).toBe(session.actor);
    expect(world.sessions.get(session.id)?.lastDetachAt).toBeNull();
  });

  it("does not expire a session while a socket is attached", () => {
    const world = createWorld();
    const session = world.auth("guest:attached");
    world.attachSocket(session.id, "ws-1");
    session.expiresAt = Date.now() - 1;

    expect(world.sessionAlive(session.id)).toBe(true);
    expect(world.reapExpiredSessions()).toEqual([]);
    expect(world.sessions.has(session.id)).toBe(true);
  });

  it("keeps a long-attached session resumable for the detach grace window", () => {
    const world = createWorld();
    const session = world.auth("guest:long-attached");
    world.attachSocket(session.id, "ws-1");
    session.expiresAt = Date.now() - 1;

    world.detachSocket(session.id, "ws-1");

    const detached = world.sessions.get(session.id);
    expect(detached?.lastDetachAt).toEqual(expect.any(Number));
    expect(detached?.expiresAt).toBeGreaterThan(detached?.lastDetachAt ?? 0);
    expect(world.auth(`session:${session.id}`).actor).toBe(session.actor);
  });

  it("reaps detached guest sessions and returns guests to the pool", () => {
    const world = createWorld();
    const session = world.auth("guest:reap");
    const actor = session.actor;
    world.directCall("enter-chat-before-reap", actor, "the_chatroom", "enter", []);
    world.setProp(actor, "description", "temporary guest description");
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

    const next = world.auth("guest:after-reap");
    expect(next.actor).toBe(actor);
  });

  it("rejects calls from expired sessions", () => {
    const world = createWorld();
    const session = world.auth("guest:expired-call");
    const actor = session.actor;
    world.attachSocket(session.id, "ws-1");
    world.detachSocket(session.id, "ws-1");
    const detachedAt = world.sessions.get(session.id)?.lastDetachAt ?? Date.now();
    world.reapExpiredSessions(detachedAt + 60_001);

    const result = world.call("expired-call", session.id, "the_dubspace", message(actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.5]));
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_NOSESSION");
  });

  it("rejects calls whose actor does not match the session", () => {
    const world = createWorld();
    const first = world.auth("guest:actor-one");
    const second = world.auth("guest:actor-two");
    const result = world.call("actor-mismatch", first.id, "the_dubspace", message(second.actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.5]));
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_PERM");
  });

  it("returns the same applied frame for idempotent retry", () => {
    const { world, session, actor } = authedWorld();
    const msg = message(actor, "the_dubspace", "set_control", ["delay_1", "wet", 0.91]);
    const first = world.call("same-id", session.id, "the_dubspace", msg);
    const second = world.call("same-id", session.id, "the_dubspace", msg);
    expect(first).toEqual(second);
    expect(world.replay("the_dubspace", 1, 10)).toHaveLength(1);
  });

  it("keeps failed behavior in sequence while rolling back mutation", () => {
    const { world, session, actor } = authedWorld();
    const result = world.call("bad", session.id, "the_dubspace", message(actor, "the_dubspace", "missing_verb", []));
    expect(result.op).toBe("applied");
    if (result.op === "applied") {
      expect(result.seq).toBe(1);
      expect(result.observations[0].type).toBe("$error");
      expect(result.observations[0].code).toBe("E_VERBNF");
    }
    expect(world.replay("the_dubspace", 1, 10)[0].applied_ok).toBe(false);
  });

  it("updates dubspace percussion pattern and transport through sequenced calls", () => {
    const { world, session, actor } = authedWorld();
    const step = world.call("drum-step", session.id, "the_dubspace", message(actor, "the_dubspace", "set_drum_step", ["tone", 3, true]));
    const tempo = world.call("tempo", session.id, "the_dubspace", message(actor, "the_dubspace", "set_tempo", [132]));
    const start = world.call("start", session.id, "the_dubspace", message(actor, "the_dubspace", "start_transport", []));
    const pattern = world.getProp("drum_1", "pattern") as Record<string, boolean[]>;
    expect(pattern.tone[3]).toBe(true);
    expect(world.getProp("drum_1", "bpm")).toBe(132);
    expect(world.getProp("drum_1", "playing")).toBe(true);
    expect(Number(world.getProp("drum_1", "started_at"))).toBeGreaterThan(0);
    if (step.op === "applied") expect(step.observations[0].type).toBe("drum_step_changed");
    if (tempo.op === "applied") expect(tempo.observations[0].type).toBe("tempo_changed");
    if (start.op === "applied") expect(start.observations[0].type).toBe("transport_started");
  });

  it("runs direct dubspace previews as live-only observations", () => {
    const { world, actor } = authedWorld();
    const result = world.directCall("preview-1", actor, "the_dubspace", "preview_control", ["delay_1", "feedback", 0.42]);
    expect(result.op).toBe("result");
    if (result.op === "result") {
      expect(result.result).toBe(0.42);
      expect(result.audience).toBe("the_dubspace");
      expect(result.observations).toMatchObject([
        { type: "gesture_progress", source: "the_dubspace", actor, target: "delay_1", name: "feedback", value: 0.42 }
      ]);
    }
    expect(world.getProp("delay_1", "feedback")).toBe(0.35);
    expect(world.getProp("the_dubspace", "next_seq")).toBe(1);
    expect(world.replay("the_dubspace", 1, 10)).toEqual([]);
  });

  it("runs chatroom speech as direct live-only observations", () => {
    const world = createWorld();
    const first = world.auth("guest:first");
    const second = world.auth("guest:second");
    expect(world.verbInfo("the_chatroom", "say").definer).toBe("$conversational");
    expect(world.verbInfo("the_taskspace", "say").definer).toBe("$conversational");

    const enterFirst = world.directCall("enter-first", first.actor, "the_chatroom", "enter", []);
    const enterSecond = world.directCall("enter-second", second.actor, "the_chatroom", "enter", []);
    expect(enterFirst.op).toBe("result");
    expect(enterSecond.op).toBe("result");

    const who = world.directCall("who", first.actor, "the_chatroom", "who", []);
    expect(who.op).toBe("result");
    if (who.op === "result") expect(who.result).toEqual([first.actor, second.actor]);

    const say = world.directCall("say", first.actor, "the_chatroom", "say", ["hello room"]);
    expect(say.op).toBe("result");
    if (say.op === "result") {
      expect(say.audience).toBe("the_chatroom");
      expect(say.observations).toMatchObject([{ type: "said", source: "the_chatroom", actor: first.actor, text: "hello room" }]);
    }

    const tell = world.directCall("tell", first.actor, "the_chatroom", "tell", [second.actor, "psst"]);
    expect(tell.op).toBe("result");
    if (tell.op === "result") {
      expect(tell.observations).toMatchObject([{ type: "told", source: "the_chatroom", from: first.actor, to: second.actor, text: "psst" }]);
    }

    world.directCall("leave-second", second.actor, "the_chatroom", "leave", []);
    world.directCall("enter-other", first.actor, "the_chatroom", "enter", [second.actor]);
    const afterEnter = world.directCall("who-2", first.actor, "the_chatroom", "who", []);
    if (afterEnter.op === "result") expect(afterEnter.result).toEqual([first.actor]);

    expect(world.getProp("the_chatroom", "next_seq")).toBe(1);
    expect(world.replay("the_chatroom", 1, 10)).toEqual([]);

    const taskspaceSay = world.directCall("taskspace-say", first.actor, "the_taskspace", "say", ["same feature"]);
    expect(taskspaceSay.op).toBe("result");
    if (taskspaceSay.op === "result") {
      expect(taskspaceSay.audience).toBe("the_taskspace");
      expect(taskspaceSay.observations).toMatchObject([{ type: "said", source: "the_taskspace", actor: first.actor, text: "same feature" }]);
    }
    expect(world.getProp("the_taskspace", "next_seq")).toBe(1);
    expect(world.replay("the_taskspace", 1, 10)).toEqual([]);
  });

  it("resolves feature verbs after the parent chain in feature-list order", () => {
    const world = createWorld();
    world.createObject({ id: "feature_a", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "feature_b", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "feature_nested", parent: "$thing", owner: "$wiz" });
    world.addVerb("feature_a", nativeVerb("ping"));
    world.addVerb("feature_b", nativeVerb("ping"));
    world.addVerb("feature_nested", nativeVerb("nested_only"));
    world.setProp("the_taskspace", "features", ["feature_a", "feature_b"]);
    world.setProp("the_taskspace", "features_version", 99);
    world.setProp("feature_a", "features", ["feature_nested"]);

    expect(world.verbInfo("the_taskspace", "ping").definer).toBe("feature_a");
    world.setProp("the_taskspace", "features", ["feature_b", "feature_a"]);
    world.setProp("the_taskspace", "features_version", 100);
    expect(world.verbInfo("the_taskspace", "ping").definer).toBe("feature_b");
    expect(() => world.verbInfo("the_taskspace", "nested_only")).toThrow(/E_VERBNF|verb not found/);

    world.addVerb("$taskspace", nativeVerb("ping"));
    expect(world.verbInfo("the_taskspace", "ping").definer).toBe("$taskspace");
  });

  it("manages feature lists through space feature verbs", () => {
    const world = createWorld();
    const session = world.auth("guest:feature-owner");
    world.createObject({ id: "owned_space", parent: "$space", owner: session.actor });
    world.createObject({ id: "owned_feature", parent: "$thing", owner: session.actor });
    world.setProp("owned_space", "next_seq", 1);
    world.setProp("owned_space", "subscribers", [session.actor]);
    world.setProp("owned_space", "last_snapshot_seq", 0);
    world.setProp(session.actor, "presence_in", [...(world.getProp(session.actor, "presence_in") as string[]), "owned_space"]);

    const add = world.call("add-feature", session.id, "owned_space", message(session.actor, "owned_space", "add_feature", ["owned_feature"]));
    expect(add.op).toBe("applied");
    if (add.op === "applied") expect(add.observations[0]).toMatchObject({ type: "feature_added", source: "owned_space", feature: "owned_feature" });
    expect(world.getProp("owned_space", "features")).toEqual(["owned_feature"]);
    expect(world.getProp("owned_space", "features_version")).toBe(1);

    const has = world.directCall("has-feature", session.actor, "owned_space", "has_feature", ["owned_feature"]);
    expect(has.op).toBe("result");
    if (has.op === "result") expect(has.result).toBe(true);

    const duplicate = world.call("add-feature-again", session.id, "owned_space", message(session.actor, "owned_space", "add_feature", ["owned_feature"]));
    expect(world.getProp("owned_space", "features_version")).toBe(1);
    if (duplicate.op === "applied") expect(duplicate.observations[0].type).toBe("feature_already_added");

    const remove = world.call("remove-feature", session.id, "owned_space", message(session.actor, "owned_space", "remove_feature", ["owned_feature"]));
    expect(remove.op).toBe("applied");
    expect(world.getProp("owned_space", "features")).toEqual([]);
    expect(world.getProp("owned_space", "features_version")).toBe(2);
  });

  it("allows conversational feature attachment by non-wizard space owners", () => {
    const world = createWorld();
    const session = world.auth("guest:chat-feature-owner");
    world.createObject({ id: "owned_chat_space", parent: "$space", owner: session.actor });
    world.setProp("owned_chat_space", "next_seq", 1);
    world.setProp("owned_chat_space", "subscribers", [session.actor]);
    world.setProp("owned_chat_space", "last_snapshot_seq", 0);
    world.setProp(session.actor, "presence_in", [...(world.getProp(session.actor, "presence_in") as string[]), "owned_chat_space"]);

    const add = world.call("add-conversational", session.id, "owned_chat_space", message(session.actor, "owned_chat_space", "add_feature", ["$conversational"]));
    expect(add.op).toBe("applied");
    expect(world.getProp("owned_chat_space", "features")).toEqual(["$conversational"]);
  });

  it("rejects non-direct-callable verbs over direct ingress", () => {
    const { world, actor } = authedWorld();
    const result = world.directCall("direct-denied", actor, "the_dubspace", "set_control", ["delay_1", "feedback", 0.44]);
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_DIRECT_DENIED");
    expect(world.getProp("delay_1", "feedback")).toBe(0.35);
    expect(world.replay("the_dubspace", 1, 10)).toEqual([]);
  });

  it("allows wizard force-direct repair and records the bypass", () => {
    const { world, actor } = authedWorld();
    const nonWizard = world.directCall("force-denied", actor, "the_dubspace", "set_control", ["delay_1", "feedback", 0.44], { forceDirect: true });
    expect(nonWizard.op).toBe("error");
    if (nonWizard.op === "error") expect(nonWizard.error.code).toBe("E_PERM");

    const wizard = world.directCall("force-wizard", "$wiz", "the_dubspace", "set_control", ["delay_1", "feedback", 0.44], {
      forceDirect: true,
      forceReason: "test repair"
    });
    expect(wizard.op).toBe("result");
    if (wizard.op === "result") {
      expect(wizard.observations[0]).toMatchObject({ type: "wizard_action", action: "force_direct", actor: "$wiz", target: "the_dubspace", verb: "set_control" });
      expect(wizard.observations[1]).toMatchObject({ type: "control_changed", target: "delay_1", name: "feedback", value: 0.44 });
    }
    expect(world.getProp("delay_1", "feedback")).toBe(0.44);
    expect(world.replay("the_dubspace", 1, 10)).toEqual([]);
    const audit = world.getProp("$system", "wizard_actions");
    expect(audit).toEqual([
      expect.objectContaining({ actor: "$wiz", action: "force_direct", target: "the_dubspace", verb: "set_control", reason: "test repair" })
    ]);
  });
});

describe("taskspace", () => {
  it("creates hierarchical tasks and emits soft definition-of-done observations", () => {
    const { world, session, actor } = authedWorld();
    const create = world.call("create", session.id, "the_taskspace", message(actor, "the_taskspace", "create_task", ["Build core", "Make it real"]));
    expect(create.op).toBe("applied");
    const task = create.op === "applied" ? (create.observations[0].task as string) : "";
    world.call("sub", session.id, "the_taskspace", message(actor, task, "add_subtask", ["Write tests", ""]));
    world.call("claim", session.id, "the_taskspace", message(actor, task, "claim", []));
    world.call("req", session.id, "the_taskspace", message(actor, task, "add_requirement", ["passes tests"]));
    const done = world.call("done", session.id, "the_taskspace", message(actor, task, "set_status", ["done"]));
    expect(world.getProp(task, "status")).toBe("done");
    if (done.op === "applied") {
      expect(done.observations.map((obs) => obs.type)).toContain("done_premature");
    }
  });

  it("prevents conflicting claims", () => {
    const world = createWorld();
    const session1 = world.auth("guest:1");
    const session2 = world.auth("guest:2");
    const create = world.call("create", session1.id, "the_taskspace", message(session1.actor, "the_taskspace", "create_task", ["Claimed", ""]));
    const task = create.op === "applied" ? (create.observations[0].task as string) : "";
    world.call("claim-1", session1.id, "the_taskspace", message(session1.actor, task, "claim", []));
    const conflict = world.call("claim-2", session2.id, "the_taskspace", message(session2.actor, task, "claim", []));
    expect(conflict.op).toBe("applied");
    if (conflict.op === "applied") {
      expect(conflict.observations[0].type).toBe("$error");
      expect(conflict.observations[0].code).toBe("E_CONFLICT");
    }
  });

  it("lets anyone close claimed tasks while keeping other claimed status updates gated", () => {
    const world = createWorld();
    const assignee = world.auth("guest:assignee");
    const other = world.auth("guest:other");
    world.sessions.set("wiz-session", {
      id: "wiz-session",
      actor: "$wiz",
      started: Date.now(),
      expiresAt: Date.now() + 60_000,
      lastDetachAt: null,
      tokenClass: "bearer",
      attachedSockets: new Set()
    });
    const create = world.call("create", assignee.id, "the_taskspace", message(assignee.actor, "the_taskspace", "create_task", ["Wizard check", ""]));
    const task = create.op === "applied" ? (create.observations[0].task as string) : "";
    world.call("claim", assignee.id, "the_taskspace", message(assignee.actor, task, "claim", []));
    const rejected = world.call("other-status", other.id, "the_taskspace", message(other.actor, task, "set_status", ["blocked"]));
    expect(world.getProp(task, "status")).toBe("claimed");
    if (rejected.op === "applied") expect(rejected.observations[0].code).toBe("E_PERM");
    const closed = world.call("other-done", other.id, "the_taskspace", message(other.actor, task, "set_status", ["done"]));
    expect(world.getProp(task, "status")).toBe("done");
    if (closed.op === "applied") expect(closed.observations[0].type).toBe("status_changed");
    const wizard = world.call("wiz-status", "wiz-session", "the_taskspace", message("$wiz", task, "set_status", ["blocked"]));
    expect(world.getProp(task, "status")).toBe("blocked");
    if (wizard.op === "applied") expect(wizard.observations[0].type).toBe("status_changed");
  });
});

describe("authoring", () => {
  it("compiles T0 source and installs with expected version", () => {
    const { world, session, actor } = authedWorld();
    const source = `verb :set_feedback(value) rx {
  this.feedback = value;
  observe({
    "type": "control_changed",
    "target": this,
    "name": "feedback",
    "value": value,
    "actor": actor,
    "seq": seq
  });
  return value;
}`;
    const compiled = compileVerb(source);
    expect(compiled.ok).toBe(true);
    expect(compiled.metadata).toMatchObject({ name: "set_feedback", perms: "rx", arg_spec: { params: ["value"] } });
    expect(Object.keys(compiled.line_map ?? {}).length).toBeGreaterThan(0);
    const installed = installVerb(world, "delay_1", "set_feedback", source, null);
    expect(installed.ok).toBe(true);
    const info = world.verbInfo("delay_1", "set_feedback");
    expect(info.perms).toBe("rx");
    expect(info.arg_spec).toEqual({ params: ["value"] });
    expect(Object.keys(info.line_map as Record<string, unknown>).length).toBeGreaterThan(0);
    const applied = world.call("test", session.id, "the_dubspace", message(actor, "delay_1", "set_feedback", [0.62]));
    expect(world.getProp("delay_1", "feedback")).toBe(0.62);
    if (applied.op === "applied") expect(applied.observations[0].type).toBe("control_changed");
    expect(() => installVerb(world, "delay_1", "set_feedback", source, null)).toThrow();
  });

  it("compiles string interpolation and dynamic index get/set", () => {
    const { world, session, actor } = authedWorld();
    const source = `verb :index_and_interp(name, value) rx {
  let controls = { feedback: 1 };
  controls[name] = value;
  this.(name) = value;
  let text = "set \${name}=\${controls[name]}";
  observe({ type: "index_interp", text: text, value: controls[name], prop_value: this.(name) });
  return text;
}`;
    const compiled = compileVerb(source);
    expect(compiled.ok).toBe(true);
    expect(compiled.bytecode?.ops.map(([op]) => op)).toEqual(expect.arrayContaining(["INDEX_SET", "INDEX_GET", "SET_PROP", "GET_PROP", "STR_INTERP"]));
    expect(installVerb(world, "delay_1", "index_and_interp", source, null).ok).toBe(true);

    const applied = world.call("index", session.id, "the_dubspace", message(actor, "delay_1", "index_and_interp", ["feedback", 0.7]));
    expect(applied.op).toBe("applied");
    expect(world.getProp("delay_1", "feedback")).toBe(0.7);
    if (applied.op === "applied") {
      expect(applied.observations[0]).toMatchObject({ type: "index_interp", text: "set feedback=0.7", value: 0.7, prop_value: 0.7 });
    }
  });

  it("adds line-mapped runtime traces to VM error observations", () => {
    const { world, session, actor } = authedWorld();
    const source = `verb :explode() rx {
  let denom = 0;
  return 1 / denom;
}`;
    expect(installVerb(world, "delay_1", "explode", source, null).ok).toBe(true);
    const applied = world.call("explode", session.id, "the_dubspace", message(actor, "delay_1", "explode", []));
    expect(applied.op).toBe("applied");
    if (applied.op === "applied") {
      expect(applied.observations[0].type).toBe("$error");
      expect(applied.observations[0].code).toBe("E_DIV");
      const trace = applied.observations[0].trace as Record<string, unknown>[];
      expect(trace[0]).toMatchObject({ obj: "delay_1", verb: "explode", definer: "delay_1", line: 3 });
    }
  });

  it("seeds dubspace loop transport verbs as authored source", () => {
    const { world, session, actor } = authedWorld();
    const info = world.verbInfo("the_dubspace", "start_loop");
    expect(info.source).toContain("slot.playing = true");
    expect(info.bytecode_version).toBeGreaterThan(0);

    const started = world.call("start-loop", session.id, "the_dubspace", message(actor, "the_dubspace", "start_loop", ["slot_1"]));
    expect(world.getProp("slot_1", "playing")).toBe(true);
    if (started.op === "applied") expect(started.observations[0]).toMatchObject({ type: "loop_started", slot: "slot_1", loop_id: "loop-1" });
    const stopped = world.call("stop-loop", session.id, "the_dubspace", message(actor, "the_dubspace", "stop_loop", ["slot_1"]));
    expect(world.getProp("slot_1", "playing")).toBe(false);
    if (stopped.op === "applied") expect(stopped.observations[0]).toMatchObject({ type: "loop_stopped", slot: "slot_1" });
  });

  it("compiles M1 source with locals, loops, conditionals, and observations", () => {
    const { world, session, actor } = authedWorld();
    const source = `verb :sum_to(limit) rx {
  let total = 0;
  for i in [1..limit] {
    total = total + i;
  }
  if (total > 10) {
    this.feedback = total;
  } else {
    this.feedback = 0;
  }
  observe({
    type: "compiled_sum",
    value: total,
    large: total > 10,
    has_feedback: "feedback" in { feedback: true }
  });
  return total;
}`;

    const compiled = compileVerb(source);
    expect(compiled.ok).toBe(true);
    expect(compiled.bytecode?.ops.some(([op]) => op === "FOR_RANGE_NEXT")).toBe(true);
    const installed = installVerb(world, "delay_1", "sum_to", source, null);
    expect(installed.ok).toBe(true);

    const applied = world.call("compiled-sum", session.id, "the_dubspace", message(actor, "delay_1", "sum_to", [5]));
    expect(applied.op).toBe("applied");
    expect(world.getProp("delay_1", "feedback")).toBe(15);
    if (applied.op === "applied") {
      expect(applied.observations[0]).toMatchObject({ type: "compiled_sum", value: 15, large: true, has_feedback: true });
    }
  });

  it("compiles source verb calls, pass, and try/except", () => {
    const { world, actor } = authedWorld();
    world.createObject({ id: "compiler_base", name: "Compiler Base", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "compiler_child", name: "Compiler Child", parent: "compiler_base", owner: "$wiz" });
    expect(installVerb(world, "compiler_base", "value", `verb :value() rx {
  return 10;
}`, null).ok).toBe(true);
    expect(installVerb(world, "compiler_child", "value", `verb :value() rx {
  return pass() + 5;
}`, null).ok).toBe(true);
    expect(installVerb(world, "delay_1", "call_child", `verb :call_child() rx {
  return "compiler_child":value();
}`, null).ok).toBe(true);
    expect(installVerb(world, "delay_1", "catcher", `verb :catcher() rx {
  try {
    raise "E_BOOM";
  } except err in (E_BOOM) {
    return err["code"];
  }
  return "miss";
}`, null).ok).toBe(true);

    const ctx = {
      world,
      space: "the_dubspace",
      seq: 110,
      actor,
      player: actor,
      caller: "#-1",
      progr: actor,
      thisObj: "delay_1",
      verbName: "call_child",
      definer: "delay_1",
      message: message(actor, "delay_1", "call_child", []),
      observations: [],
      observe: () => {}
    };
    expect(world.dispatch(ctx, "delay_1", "call_child", [])).toBe(15);
    expect(world.dispatch({ ...ctx, verbName: "catcher", message: message(actor, "delay_1", "catcher", []) }, "delay_1", "catcher", [])).toBe("E_BOOM");
  });

  it("returns structured diagnostics for bad source", () => {
    const result = compileVerb(`verb :bad() rx {
  let x = ;
}`);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ severity: "error", code: "E_COMPILE" });
    expect(result.diagnostics[0].span?.line).toBe(2);
  });

  it("verifies raw JSON bytecode fallback and versions property definitions", () => {
    const world = createWorld();
    const raw = JSON.stringify({
      ops: [["PUSH_ARG", 0], ["RETURN"]],
      literals: [],
      num_locals: 0,
      max_stack: 1,
      version: 1
    });
    expect(compileVerb(raw, { format: "t0-json-bytecode" }).ok).toBe(true);
    const prop = definePropertyVersioned(world, "delay_1", "note", "", "rw", null, "str");
    expect(prop.version).toBe(1);
    expect(() => definePropertyVersioned(world, "delay_1", "note", "", "rw", null, "str")).toThrow();
    const updated = definePropertyVersioned(world, "delay_1", "note", "x", "rw", 1, "str");
    expect(updated.version).toBe(2);
  });

  it("uses structural map equality in T0 EQ", () => {
    const { world, session, actor } = authedWorld();
    world.addVerb("delay_1", {
      kind: "bytecode",
      name: "observe_eq",
      aliases: [],
      owner: "$wiz",
      perms: "rxd",
      arg_spec: {},
      source: "test structural equality",
      source_hash: "test",
      version: 1,
      line_map: {},
      bytecode: {
        literals: ["type", "eq_result", "value", { a: 1, b: 2 }, { b: 2, a: 1 }, null],
        ops: [
          ["PUSH_LIT", 0],
          ["PUSH_LIT", 1],
          ["PUSH_LIT", 2],
          ["PUSH_LIT", 3],
          ["PUSH_LIT", 4],
          ["EQ"],
          ["MAKE_MAP", 2],
          ["OBSERVE"],
          ["PUSH_LIT", 5],
          ["RETURN"]
        ],
        num_locals: 0,
        max_stack: 6,
        version: 1
      }
    });
    const applied = world.call("eq", session.id, "the_dubspace", message(actor, "delay_1", "observe_eq", []));
    if (applied.op === "applied") expect(applied.observations[0].value).toBe(true);
  });
});
