import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import { installCatalogManifest, type CatalogManifest as RuntimeCatalogManifest } from "../src/core/catalog-installer";
import { bundledCatalogAliases, installLocalCatalogs } from "../src/core/local-catalogs";
import type { VerbDef } from "../src/core/types";

type CatalogManifest = {
  name: string;
  version: string;
  spec_version: string;
  license: string;
  depends?: string[];
  classes?: { local_name: string; parent: string; verbs?: { name: string; source: string }[] }[];
  features?: { local_name: string; parent: string; verbs?: { name: string; source: string }[] }[];
  schemas?: { on: string; type: string; shape: Record<string, unknown> }[];
  seed_hooks?: Record<string, unknown>[];
};

const root = new URL("../catalogs", import.meta.url).pathname;

function readManifest(name: string): CatalogManifest {
  return JSON.parse(readFileSync(join(root, name, "manifest.json"), "utf8")) as CatalogManifest;
}

function readFrontmatter(name: string): Record<string, string> {
  const readme = readFileSync(join(root, name, "README.md"), "utf8");
  const match = /^---\n([\s\S]*?)\n---/.exec(readme);
  expect(match, `${name} README should have frontmatter`).not.toBeNull();
  const entries = (match?.[1] ?? "")
    .split("\n")
    .filter((line) => line.includes(":"))
    .map((line) => {
      const index = line.indexOf(":");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    });
  return Object.fromEntries(entries);
}

describe("local catalogs", () => {
  it("discovers bundled catalogs from manifest locations", async () => {
    const catalogDirs = readdirSync(root).filter((name) => existsSync(join(root, name, "manifest.json"))).sort();
    const manifestNames = catalogDirs.map((name) => readManifest(name).name).sort();
    expect([...bundledCatalogAliases()].sort()).toEqual(manifestNames);
  });

  it("keeps README frontmatter aligned with manifests", async () => {
    for (const name of readdirSync(root).filter((entry) => existsSync(join(root, entry, "manifest.json")))) {
      const manifest = readManifest(name);
      const frontmatter = readFrontmatter(name);
      expect(manifest.name).toBe(name);
      expect(frontmatter.name).toBe(manifest.name);
      expect(frontmatter.version).toBe(manifest.version);
      expect(frontmatter.spec_version).toBe(manifest.spec_version);
      expect(frontmatter.license).toBe(manifest.license);
    }
  });

  it("keeps each catalog's app design with the catalog", async () => {
    for (const name of readdirSync(root).filter((entry) => existsSync(join(root, entry, "manifest.json")))) {
      const design = readFileSync(join(root, name, "DESIGN.md"), "utf8");
      expect(design).toMatch(/^# .+ Demo/m);
      expect(readFileSync(join(root, name, "README.md"), "utf8")).toContain("[DESIGN.md](DESIGN.md)");
    }
  });

  it("uses explicit dependency order for embedded chat", async () => {
    const taskspace = readManifest("taskspace");
    expect(taskspace.depends).toEqual(["@local:chat"]);
    expect(taskspace.seed_hooks).toContainEqual({ kind: "attach_feature", consumer: "the_taskspace", feature: "chat:$conversational" });
  });

  it("rejects missing catalog dependencies with the installed set in the error", async () => {
    const world = createWorld({ catalogs: false });
    const manifest: RuntimeCatalogManifest = {
      name: "needs-chat",
      version: "1.0.0",
      spec_version: "v1",
      depends: ["@local:chat"],
      classes: []
    };
    expect(() => installCatalogManifest(world, manifest, { tap: "@local", alias: "needs-chat" })).toThrow(/@local:chat.*\(none\)/);
  });

  it("installs chat from source without trusted implementation hints", async () => {
    const world = createWorld({ catalogs: false });
    const manifest = readManifest("chat") as unknown as RuntimeCatalogManifest;
    installCatalogManifest(world, manifest, {
      tap: "github:hugh/woo",
      alias: "chat",
      allowImplementationHints: false
    });

    expect(world.object("$conversational").verbs.get("say")?.kind).toBe("bytecode");
    expect(world.object("$conversational").verbs.get("enter")?.kind).toBe("bytecode");
    expect(world.object("$conversational").verbs.get("leave")?.kind).toBe("bytecode");
    expect(world.object("$conversational").verbs.get("command_plan")?.kind).toBe("bytecode");
    expect(world.object("$match").verbs.get("parse_command")?.kind).toBe("bytecode");

    const first = world.auth("guest:catalog-chat-1");
    const second = world.auth("guest:catalog-chat-2");
    const enterFirst = await world.directCall("enter-first", first.actor, "the_chatroom", "enter", []);
    const enterSecond = await world.directCall("enter-second", second.actor, "the_chatroom", "enter", []);
    expect(enterFirst.op).toBe("result");
    expect(enterSecond.op).toBe("result");
    expect(world.hasPresence(first.actor, "the_chatroom")).toBe(true);
    expect(world.hasPresence(second.actor, "the_chatroom")).toBe(true);

    const say = await world.directCall("say", first.actor, "the_chatroom", "say", ["hello from source"]);
    expect(say.op).toBe("result");
    if (say.op === "result") {
      expect(say.observations).toMatchObject([{ type: "said", source: "the_chatroom", actor: first.actor, text: "hello from source" }]);
      expect(typeof say.observations[0].ts).toBe("number");
    }

    const leave = await world.directCall("leave", second.actor, "the_chatroom", "leave", []);
    expect(leave.op).toBe("result");
    expect(world.hasPresence(second.actor, "the_chatroom")).toBe(false);
  });

  it("treats rxd catalog source perms as direct-callable shorthand", async () => {
    const world = createWorld({ catalogs: false });
    const manifest: RuntimeCatalogManifest = {
      name: "shorthand",
      version: "1.0.0",
      spec_version: "v1",
      classes: [
        {
          local_name: "$shorthand_probe",
          parent: "$thing",
          verbs: [
            {
              name: "ping",
              source: "verb :ping() rxd { return \"pong\"; }"
            }
          ]
        }
      ]
    };

    installCatalogManifest(world, manifest, {
      tap: "github:hugh/woo",
      alias: "shorthand",
      allowImplementationHints: false
    });

    const verb = world.object("$shorthand_probe").verbs.get("ping");
    expect(verb?.perms).toBe("rx");
    expect(verb?.direct_callable).toBe(true);
    expect((await world.directCall("catalog-shorthand-ping", "$wiz", "$shorthand_probe", "ping", [])).op).toBe("result");
  });

  it("installs taskspace from source without trusted implementation hints", async () => {
    const world = createWorld({ catalogs: false });
    installCatalogManifest(world, readManifest("chat") as unknown as RuntimeCatalogManifest, {
      tap: "@local",
      alias: "chat",
      allowImplementationHints: false
    });
    installCatalogManifest(world, readManifest("taskspace") as unknown as RuntimeCatalogManifest, {
      tap: "github:hugh/woo",
      alias: "taskspace",
      allowImplementationHints: false
    });

    expect(world.object("$taskspace").verbs.get("create_task")?.kind).toBe("bytecode");
    expect(world.object("$task").verbs.get("set_status")?.kind).toBe("bytecode");

    const session = world.auth("guest:catalog-taskspace");
    const created = await world.call("create-task", session.id, "the_taskspace", {
      actor: session.actor,
      target: "the_taskspace",
      verb: "create_task",
      args: ["Source task", ""]
    });
    expect(created.op).toBe("applied");
    const task = created.op === "applied" ? String(created.observations[0].task) : "";
    expect(world.getProp(task, "title")).toBe("Source task");

    await world.call("requirement", session.id, "the_taskspace", { actor: session.actor, target: task, verb: "add_requirement", args: ["has source verbs"] });
    const done = await world.call("done", session.id, "the_taskspace", { actor: session.actor, target: task, verb: "set_status", args: ["done"] });
    expect(world.getProp(task, "status")).toBe("done");
    if (done.op === "applied") expect(done.observations.map((obs) => obs.type)).toContain("done_premature");
  });

  it("installs dubspace from source without trusted implementation hints", async () => {
    const world = createWorld({ catalogs: false });
    installCatalogManifest(world, readManifest("chat") as unknown as RuntimeCatalogManifest, {
      tap: "github:hugh/woo",
      alias: "chat",
      allowImplementationHints: false
    });
    installCatalogManifest(world, readManifest("dubspace") as unknown as RuntimeCatalogManifest, {
      tap: "github:hugh/woo",
      alias: "dubspace",
      allowImplementationHints: false
    });

    expect(world.object("the_dubspace").location).toBe("the_chatroom");
    expect(world.object("the_chatroom").contents.has("the_dubspace")).toBe(true);
    expect(world.object("$dubspace").verbs.get("set_control")?.kind).toBe("bytecode");
    expect(world.object("$dubspace").verbs.get("set_drum_step")?.kind).toBe("bytecode");
    expect(world.object("$dubspace").verbs.get("save_scene")?.kind).toBe("bytecode");
    expect(world.object("$dubspace").verbs.get("enter")?.kind).toBe("bytecode");

    const session = world.auth("guest:catalog-dubspace");
    const actor = session.actor;
    const actorName = String(world.getProp(actor, "name"));
    const entered = await world.directCall("dubspace-enter", actor, "the_dubspace", "enter", []);
    expect(entered.op).toBe("result");
    if (entered.op === "result") {
      expect(entered.result).toEqual([actor]);
      expect(entered.observations.map((obs) => obs.type)).toEqual(["dubspace_entered", "dubspace_activity"]);
      expect(entered.observations[0]).toMatchObject({ text: `${actorName} steps up to Dubspace.` });
      expect(entered.observations[1]).toMatchObject({ source: "the_chatroom", space: "the_dubspace", actor });
    }
    expect(world.getProp("the_dubspace", "operators")).toEqual([actor]);

    const applied = await world.call("set-control", session.id, "the_dubspace", {
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "feedback", 0.44]
    });
    expect(applied.op).toBe("applied");
    expect(world.getProp("delay_1", "feedback")).toBe(0.44);

    const preview = await world.directCall("preview", actor, "the_dubspace", "preview_control", ["delay_1", "feedback", 0.5]);
    expect(preview.op).toBe("result");
    if (preview.op === "result") {
      expect(preview.observations[0]).toMatchObject({ type: "gesture_progress", source: "the_dubspace", actor, target: "delay_1", name: "feedback", value: 0.5 });
    }
    expect(world.getProp("delay_1", "feedback")).toBe(0.44);

    await world.call("drum", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "set_drum_step", args: ["tone", 3, true] });
    await world.call("tempo", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "set_tempo", args: [250] });
    const pattern = world.getProp("drum_1", "pattern") as Record<string, boolean[]>;
    expect(pattern.tone[3]).toBe(true);
    expect(world.getProp("drum_1", "bpm")).toBe(200);

    await world.call("save", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "save_scene", args: ["Source Scene"] });
    await world.call("mutate", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "set_control", args: ["delay_1", "feedback", 0.11] });
    expect(world.getProp("delay_1", "feedback")).toBe(0.11);
    await world.call("recall", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "recall_scene", args: ["default_scene"] });
    expect(world.getProp("delay_1", "feedback")).toBe(0.44);

    const left = await world.directCall("dubspace-leave", actor, "the_dubspace", "leave", []);
    expect(left.op).toBe("result");
    if (left.op === "result") {
      expect(left.result).toEqual([]);
      expect(left.observations[0]).toMatchObject({ text: `${actorName} steps away from Dubspace.` });
    }
    expect(world.getProp("the_dubspace", "operators")).toEqual([]);
  });

  it("installs pinboard from source and keeps notes as board-local records", async () => {
    const world = createWorld({ catalogs: false });
    installCatalogManifest(world, readManifest("chat") as unknown as RuntimeCatalogManifest, {
      tap: "github:hugh/woo",
      alias: "chat",
      allowImplementationHints: false
    });
    installCatalogManifest(world, readManifest("pinboard") as unknown as RuntimeCatalogManifest, {
      tap: "github:hugh/woo",
      alias: "pinboard",
      allowImplementationHints: false
    });

    expect(world.object("$pinboard").verbs.get("add_note")?.kind).toBe("bytecode");
    expect(world.object("$pinboard").verbs.get("enter")?.kind).toBe("bytecode");
    expect(world.object("the_pinboard").location).toBe("the_deck");
    expect(world.object("the_deck").contents.has("the_pinboard")).toBe(true);

    const session = world.auth("guest:catalog-pinboard");
    const entered = await world.directCall("pinboard-enter", session.actor, "the_pinboard", "enter", []);
    expect(entered.op).toBe("result");
    expect(world.hasPresence(session.actor, "the_pinboard")).toBe(true);

    const added = await world.call("pinboard-add", session.id, "the_pinboard", {
      actor: session.actor,
      target: "the_pinboard",
      verb: "add_note",
      args: ["Bring the towel to the hot tub", "blue", 12, 24, 160, 88]
    });
    expect(added.op).toBe("applied");
    if (added.op !== "applied") return;
    expect(added.observations.map((obs) => obs.type)).toEqual(["note_added", "pinboard_activity"]);
    const note = added.observations.find((obs) => obs.type === "note_added")?.note as Record<string, unknown>;
    expect(note).toMatchObject({ id: "n1", color: "blue", x: 12, y: 24, w: 160, h: 88 });
    expect(world.getProp("the_pinboard", "notes")).toHaveLength(1);
    expect([...world.objects.keys()].filter((id) => id.includes("note"))).not.toContain("n1");

    const addedAgain = await world.call("pinboard-add-2", session.id, "the_pinboard", {
      actor: session.actor,
      target: "the_pinboard",
      verb: "add_note",
      args: ["Bring the mug too", "yellow", 48, 50, 160, 88]
    });
    expect(addedAgain.op).toBe("applied");
    const appendedNotes = world.getProp("the_pinboard", "notes") as Record<string, unknown>[];
    expect(appendedNotes).toHaveLength(2);
    expect(appendedNotes.map((item) => item.id)).toEqual(["n1", "n2"]);
    expect(appendedNotes[0]).toMatchObject({ text: "Bring the towel to the hot tub", color: "blue" });
    expect(appendedNotes[1]).toMatchObject({ text: "Bring the mug too", color: "yellow" });

    await world.call("pinboard-add-defaults", session.id, "the_pinboard", {
      actor: session.actor,
      target: "the_pinboard",
      verb: "add_note",
      args: ["Default-position note", "green"]
    });
    const defaultedNotes = world.getProp("the_pinboard", "notes") as Record<string, unknown>[];
    expect(defaultedNotes).toHaveLength(3);
    expect(defaultedNotes.map((item) => item.id)).toEqual(["n1", "n2", "n3"]);
    expect(defaultedNotes[2]).toMatchObject({ text: "Default-position note", color: "green", x: 112, y: 100 });

    await world.call("pinboard-move", session.id, "the_pinboard", { actor: session.actor, target: "the_pinboard", verb: "move_note", args: ["n1", 80, 96] });
    await world.call("pinboard-edit", session.id, "the_pinboard", { actor: session.actor, target: "the_pinboard", verb: "edit_note", args: ["n1", "Towel is ready"] });
    const notes = world.getProp("the_pinboard", "notes") as Record<string, unknown>[];
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatchObject({ id: "n1", text: "Towel is ready", x: 80, y: 96, updated_by: session.actor });
    expect(notes[1]).toMatchObject({ id: "n2", text: "Bring the mug too" });
    expect(notes[2]).toMatchObject({ id: "n3", text: "Default-position note" });
  });

  it("seeds the_cockatoo in the chatroom with random-pick squawk", async () => {
    const world = createWorld();
    expect(world.objects.has("$cockatoo")).toBe(true);
    expect(world.objects.has("the_cockatoo")).toBe(true);
    expect(world.object("the_cockatoo").parent).toBe("$cockatoo");
    expect(world.object("the_cockatoo").anchor).toBe("the_chatroom");
    expect(world.object("the_cockatoo").location).toBe("the_chatroom");

    const session = world.auth("guest:cockatoo");
    const phrases = world.getProp("the_cockatoo", "phrases") as string[];
    expect(phrases.length).toBeGreaterThan(0);

    // Cockatoo lives in the_chatroom; presence required to poke it
    await world.directCall("enter", session.actor, "the_chatroom", "enter", []);

    const squawk = await world.directCall("squawk", session.actor, "the_cockatoo", "squawk", []);
    expect(squawk.op).toBe("result");
    if (squawk.op === "result") {
      expect(phrases).toContain(String(squawk.result));
      expect(squawk.observations[0]).toMatchObject({ type: "cockatoo_squawk", source: "the_cockatoo", actor: session.actor });
    }

    // Persistent mutations (teach/gag/ungag) are sequenced through the chatroom
    // so they appear in the room's log and replicate as sequenced state.
    const taught = await world.call("teach", session.id, "the_chatroom", { actor: session.actor, target: "the_cockatoo", verb: "teach", args: ["world of objects"] });
    expect(taught.op).toBe("applied");
    expect((world.getProp("the_cockatoo", "phrases") as string[]).at(-1)).toBe("world of objects");

    // Non-string phrases must be rejected at the verb boundary (would otherwise
    // violate the cockatoo_squawk schema, which declares text: str).
    const badTeach = await world.call("teach-bad", session.id, "the_chatroom", { actor: session.actor, target: "the_cockatoo", verb: "teach", args: [{ not: "a string" } as unknown as string] });
    expect(badTeach.op).toBe("applied");
    if (badTeach.op === "applied") {
      const errObs = badTeach.observations.find((obs) => obs.type === "$error");
      expect(errObs?.code).toBe("E_TYPE");
    }

    await world.call("gag", session.id, "the_chatroom", { actor: session.actor, target: "the_cockatoo", verb: "gag", args: [] });
    const muffled = await world.directCall("squawk-gagged", session.actor, "the_cockatoo", "squawk", []);
    if (muffled.op === "result") {
      expect(muffled.result).toBe("*muffled noises*");
      expect(muffled.observations[0]).toMatchObject({ type: "cockatoo_muffled" });
    }

    // :look() composes room contents via :title() — the cockatoo is in
    // the_chatroom, so a looker sees it without subscribing or knowing the
    // objref ahead of time. The cockatoo overrides $root:title for flair.
    const look = await world.directCall("look", session.actor, "the_chatroom", "look", []);
    expect(look.op).toBe("result");
    if (look.op === "result") {
      const room = look.result as { contents: Array<{ id: string; title: string; description: string }> };
      expect(Array.isArray(room.contents)).toBe(true);
      const cockatooEntry = room.contents.find((item) => item.id === "the_cockatoo");
      expect(cockatooEntry).toBeDefined();
      expect(cockatooEntry?.title).toMatch(/sulphur-crested cockatoo perched on the mantelpiece, gagged/);
      expect(cockatooEntry?.description).toMatch(/sulphur-crested cockatoo/);
    }

    // $root:title default is the object's name; verify directly on a fresh
    // object so the override-vs-default distinction is pinned.
    const wizTitle = await world.directCall("wiz-title", session.actor, "$wiz", "title", []);
    expect(wizTitle.op).toBe("result");
    if (wizTitle.op === "result") expect(wizTitle.result).toBe(world.object("$wiz").name);
  });

  it("plans chat speech and object commands through the room parser", async () => {
    const world = createWorld();
    const first = world.auth("guest:chat-command-first");
    const second = world.auth("guest:chat-command-second");
    expect(world.object("$conversational").verbs.get("command_plan")?.kind).toBe("native");
    expect(world.object("$match").verbs.get("parse_command")?.kind).toBe("native");
    await world.directCall("enter-first", first.actor, "the_chatroom", "enter", []);
    await world.directCall("enter-second", second.actor, "the_chatroom", "enter", []);

    const emotePlan = await world.directCall("plan-emote", first.actor, "the_chatroom", "command_plan", [":waves"]);
    expect(emotePlan.op).toBe("result");
    if (emotePlan.op === "result") {
      expect(emotePlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "emote", args: ["waves"] });
    }

    const tellPlan = await world.directCall("plan-tell", first.actor, "the_chatroom", "command_plan", [`tell ${second.actor} psst`]);
    expect(tellPlan.op).toBe("result");
    if (tellPlan.op === "result") {
      expect(tellPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "tell", args: [second.actor, "psst"] });
    }

    const lookPlan = await world.directCall("plan-look-cockatoo", first.actor, "the_chatroom", "command_plan", ["l cock"]);
    expect(lookPlan.op).toBe("result");
    if (lookPlan.op === "result") {
      expect(lookPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_cockatoo", verb: "look", args: [] });
    }

    const prepPlan = await world.directCall("plan-long-prep", first.actor, "the_chatroom", "command_plan", ["look cock in front of me"]);
    expect(prepPlan.op).toBe("result");
    if (prepPlan.op === "result") {
      const cmd = (prepPlan.result as Record<string, any>).cmd as Record<string, any>;
      expect(cmd).toMatchObject({ dobj: "the_cockatoo", dobjstr: "cock", prep: "in front of", iobj: first.actor, iobjstr: "me" });
    }

    const squawkPlan = await world.directCall("plan-squawk-cockatoo", first.actor, "the_chatroom", "command_plan", ["sq bird"]);
    expect(squawkPlan.op).toBe("result");
    if (squawkPlan.op === "result") {
      expect(squawkPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_cockatoo", verb: "squawk", args: [] });
    }

    const teachPlan = await world.directCall("plan-teach-cockatoo", first.actor, "the_chatroom", "command_plan", ["teach duck \"object worlds\""]);
    expect(teachPlan.op).toBe("result");
    if (teachPlan.op === "result") {
      const plan = teachPlan.result as Record<string, any>;
      expect(plan).toMatchObject({ ok: true, route: "sequenced", space: "the_chatroom", target: "the_cockatoo", verb: "teach", args: ["object worlds"] });
      const applied = await world.call("teach-cockatoo-command", first.id, String(plan.space), {
        actor: first.actor,
        target: String(plan.target),
        verb: String(plan.verb),
        args: plan.args
      });
      expect(applied.op).toBe("applied");
      expect((world.getProp("the_cockatoo", "phrases") as string[]).at(-1)).toBe("object worlds");
    }

    world.addVerb("the_cockatoo", {
      kind: "native",
      name: "preen",
      aliases: ["p*reen"],
      owner: "$wiz",
      perms: "rxd",
      arg_spec: {},
      source: "verb :preen() rxd { ... }",
      source_hash: "test-preen",
      version: 1,
      line_map: {},
      native: "describe",
      direct_callable: true
    } satisfies VerbDef);
    const middleStarPlan = await world.directCall("plan-middle-star-alias", first.actor, "the_chatroom", "command_plan", ["p bird"]);
    expect(middleStarPlan.op).toBe("result");
    if (middleStarPlan.op === "result") {
      expect(middleStarPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_cockatoo", verb: "preen", args: [] });
    }

    const override = installVerb(world, "the_chatroom", "huh", `verb :huh(text, reason) rxd {
  observe({ type: "custom_huh", source: this, actor: actor, text: text, reason: reason, ts: now() });
  return false;
}`, null);
    expect(override.ok).toBe(true);
    const huh = await world.directCall("plan-huh-override", first.actor, "the_chatroom", "command_plan", ["/doesnotexist"]);
    expect(huh.op).toBe("result");
    if (huh.op === "result") {
      expect(huh.result).toMatchObject({ ok: false, route: "huh", target: "the_chatroom", verb: "huh" });
      expect(huh.observations).toMatchObject([{ type: "custom_huh", source: "the_chatroom", actor: first.actor, text: "/doesnotexist" }]);
    }
  });

  it("supports a small multi-room chat world with stable carryable placement", async () => {
    const world = createWorld();
    const session = world.auth("guest:room-walk");
    const watcher = world.auth("guest:room-walk-watcher");

    expect(world.objects.has("the_deck")).toBe(true);
    expect(world.objects.has("the_hot_tub")).toBe(true);
    expect(world.getProp("the_chatroom", "host_placement")).toBe("self");
    expect(world.getProp("the_deck", "host_placement")).toBe("self");
    expect(world.getProp("the_hot_tub", "host_placement")).toBe("self");
    expect(world.objectRoutes()).toEqual(expect.arrayContaining([
      { id: "the_chatroom", host: "the_chatroom", anchor: null },
      { id: "the_deck", host: "the_deck", anchor: null },
      { id: "the_hot_tub", host: "the_hot_tub", anchor: null }
    ]));
    expect(world.objectRoutes().find((route) => route.id === "the_lamp")).toBeUndefined();

    const enterRoom = await world.directCall("enter-lr", session.actor, "the_chatroom", "enter", []);
    expect(enterRoom.op).toBe("result");
    if (enterRoom.op === "result") {
      expect(enterRoom.observations.map((obs) => obs.type)).toEqual(["entered", "looked"]);
      expect(enterRoom.observationAudiences?.[0]).not.toContain(session.actor);
      expect(enterRoom.observationAudiences?.[1]).toEqual([session.actor]);
    }
    await world.directCall("enter-lr-watcher", watcher.actor, "the_chatroom", "enter", []);
    expect(world.hasPresence(session.actor, "the_chatroom")).toBe(true);
    expect(world.object(session.actor).location).toBe("the_chatroom");

    const look = await world.directCall("look-lr", session.actor, "the_chatroom", "look", []);
    expect(look.op).toBe("result");
    if (look.op === "result") {
      const room = look.result as { contents: Array<{ id: string; title: string }> };
      expect(room.contents.map((item) => item.id)).toEqual(expect.arrayContaining(["the_couch", "the_lamp", "the_mug", "the_cockatoo"]));
      expect(room.contents.map((item) => item.id)).not.toContain(session.actor);
    }

    const takePlan = await world.directCall("plan-take-lamp", session.actor, "the_chatroom", "command_plan", ["take lamp"]);
    expect(takePlan.op).toBe("result");
    if (takePlan.op === "result") {
      expect(takePlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "take", args: ["lamp"] });
    }

    const takeLamp = await world.directCall("take-lamp", session.actor, "the_chatroom", "take", ["lamp"]);
    expect(takeLamp.op).toBe("result");
    expect(world.object("the_lamp").location).toBe(session.actor);
    expect(world.objectRoutes().find((route) => route.id === "the_lamp")).toBeUndefined();

    const takeCouch = await world.directCall("take-couch", session.actor, "the_chatroom", "take", ["couch"]);
    expect(takeCouch.op).toBe("error");
    if (takeCouch.op === "error") expect(takeCouch.error.code).toBe("E_PERM");
    expect(world.object("the_couch").location).toBe("the_chatroom");

    const blockedSouth = await world.directCall("south-window", session.actor, "the_chatroom", "south", []);
    expect(blockedSouth.op).toBe("result");
    if (blockedSouth.op === "result") expect(String(blockedSouth.result)).toMatch(/plate-glass/);
    expect(world.object(session.actor).location).toBe("the_chatroom");

    const goPlan = await world.directCall("plan-se-deck", session.actor, "the_chatroom", "command_plan", ["se"]);
    expect(goPlan.op).toBe("result");
    if (goPlan.op === "result") {
      expect(goPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "southeast", args: [] });
    }

    const goDeck = await world.directCall("se-deck", session.actor, "the_chatroom", "southeast", []);
    expect(goDeck.op).toBe("result");
    if (goDeck.op === "result") {
      expect(goDeck.result).toMatchObject({ room: "the_deck", from: "the_chatroom" });
      expect(goDeck.observations).toMatchObject([
        { type: "left", source: "the_chatroom", actor: session.actor, destination: "the_deck", text: `${world.object(session.actor).name} goes southeast.` },
        { type: "entered", source: "the_deck", actor: session.actor, origin: "the_chatroom", text: `${world.object(session.actor).name} has arrived.` },
        { type: "looked", source: "the_deck", actor: session.actor, to: session.actor }
      ]);
      expect(goDeck.observationAudiences?.[0]).toContain(watcher.actor);
      expect(goDeck.observationAudiences?.[0]).not.toContain(session.actor);
      expect(goDeck.observationAudiences?.[2]).toEqual([session.actor]);
    }
    expect(world.hasPresence(session.actor, "the_chatroom")).toBe(false);
    expect(world.hasPresence(session.actor, "the_deck")).toBe(true);
    expect(world.object(session.actor).location).toBe("the_deck");

    const enterTubPlan = await world.directCall("plan-enter-tub", session.actor, "the_deck", "command_plan", ["enter tub"]);
    expect(enterTubPlan.op).toBe("result");
    if (enterTubPlan.op === "result") {
      expect(enterTubPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_hot_tub", verb: "enter", args: [] });
    }

    const takeTowel = await world.directCall("take-towel", session.actor, "the_deck", "take", ["towel"]);
    expect(takeTowel.op).toBe("result");
    expect(world.object("the_towel").location).toBe(session.actor);
    expect(world.objectRoutes().find((route) => route.id === "the_towel")).toBeUndefined();

    const goTub = await world.directCall("enter-hot-tub", session.actor, "the_hot_tub", "enter", []);
    expect(goTub.op).toBe("result");
    expect(world.hasPresence(session.actor, "the_hot_tub")).toBe(true);
    expect(world.hasPresence(session.actor, "the_deck")).toBe(false);
    expect(world.object(session.actor).location).toBe("the_hot_tub");

    const dropTowel = await world.directCall("drop-towel", session.actor, "the_hot_tub", "drop", ["towel"]);
    expect(dropTowel.op).toBe("result");
    expect(world.object("the_towel").location).toBe("the_hot_tub");
    expect(world.objectRoutes().find((route) => route.id === "the_towel")).toBeUndefined();
  });

  it("repairs stale chat room seed metadata and missing room contents", () => {
    const world = createWorld();
    world.setProp("$system", "applied_migrations", [
      "2026-04-30-source-catalog-verbs",
      "2026-04-30-catalog-placement-metadata",
      "2026-04-30-chat-cockatoo",
      "2026-04-30-chat-look-contents",
      "2026-04-30-chat-command-parser",
      "2026-04-30-dubspace-control-guards",
      "2026-04-30-room-look-self",
      "2026-05-01-chat-three-room-demo",
      "2026-05-01-chat-observation-output"
    ]);
    world.object("the_chatroom").name = "Lobby";
    world.setProp("the_chatroom", "name", "Lobby");
    world.setProp("the_chatroom", "description", "The first runnable chat room.");
    world.setProp("the_chatroom", "next_seq", 37);
    world.setProp("the_chatroom", "subscribers", ["guest_1"]);
    for (const id of ["the_lamp", "the_towel", "the_mug"]) {
      const obj = world.objects.get(id);
      if (obj?.location && world.objects.has(obj.location)) world.object(obj.location).contents.delete(id);
      world.objects.delete(id);
    }

    installLocalCatalogs(world, ["chat"]);

    expect(world.object("the_chatroom").name).toBe("Living Room");
    expect(world.getProp("the_chatroom", "description")).toContain("bright, open living room");
    expect(world.objects.has("the_lamp")).toBe(true);
    expect(world.objects.has("the_towel")).toBe(true);
    expect(world.objects.has("the_mug")).toBe(true);
    expect(world.object("the_lamp").location).toBe("the_chatroom");
    expect(world.object("the_towel").location).toBe("the_deck");
    expect(world.object("the_mug").location).toBe("the_chatroom");
    expect(world.object("the_chatroom").contents.has("the_lamp")).toBe(true);
    expect(world.object("the_chatroom").contents.has("the_mug")).toBe(true);
    expect(world.object("the_deck").contents.has("the_towel")).toBe(true);
    expect(world.getProp("the_chatroom", "next_seq")).toBe(37);
    expect(world.getProp("the_chatroom", "subscribers")).toEqual(["guest_1"]);
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-01-chat-room-contents-repair");
  });

  it("rehomes chat seed portables stranded in $nowhere", () => {
    const world = createWorld();
    world.setProp("$system", "applied_migrations", [
      "2026-04-30-source-catalog-verbs",
      "2026-04-30-catalog-placement-metadata",
      "2026-04-30-chat-cockatoo",
      "2026-04-30-chat-look-contents",
      "2026-04-30-chat-command-parser",
      "2026-04-30-dubspace-control-guards",
      "2026-04-30-room-look-self",
      "2026-05-01-chat-three-room-demo",
      "2026-05-01-chat-observation-output",
      "2026-05-01-chat-room-contents-repair",
      "2026-05-01-agent-tool-exposure-repair",
      "2026-05-01-chat-navigation-tool-exposure"
    ]);
    world.object("the_deck").contents.delete("the_towel");
    world.object("the_towel").location = "$nowhere";
    world.object("the_towel").properties.delete("home");
    world.object("$nowhere").contents.add("the_towel");

    installLocalCatalogs(world, ["chat"]);

    expect(world.object("the_towel").location).toBe("the_deck");
    expect(world.object("the_deck").contents.has("the_towel")).toBe(true);
    expect(world.object("$nowhere").contents.has("the_towel")).toBe(false);
    expect(world.getProp("the_towel", "home")).toBe("the_deck");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-01-chat-nowhere-portables-repair");
  });

  it("repairs stale catalog tool exposure for agent-visible taskspace and dubspace verbs", () => {
    const world = createWorld();
    world.setProp("$system", "applied_migrations", [
      "2026-04-30-source-catalog-verbs",
      "2026-04-30-catalog-placement-metadata",
      "2026-04-30-chat-cockatoo",
      "2026-04-30-chat-look-contents",
      "2026-04-30-chat-command-parser",
      "2026-04-30-dubspace-control-guards",
      "2026-04-30-room-look-self",
      "2026-05-01-chat-three-room-demo",
      "2026-05-01-chat-observation-output",
      "2026-05-01-chat-room-contents-repair"
    ]);
    const createTask = world.object("$taskspace").verbs.get("create_task");
    const setControl = world.object("$dubspace").verbs.get("set_control");
    expect(createTask).toBeDefined();
    expect(setControl).toBeDefined();
    if (!createTask || !setControl) return;
    world.addVerb("$taskspace", { ...createTask, tool_exposed: false, version: createTask.version + 1 });
    world.addVerb("$dubspace", { ...setControl, tool_exposed: false, version: setControl.version + 1 });

    installLocalCatalogs(world, ["chat", "taskspace", "dubspace"]);

    expect(world.object("$taskspace").verbs.get("create_task")?.tool_exposed).toBe(true);
    expect(world.object("$dubspace").verbs.get("set_control")?.tool_exposed).toBe(true);
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-01-agent-tool-exposure-repair");
  });

  it("migrates the cockatoo into worlds installed before it landed", async () => {
    const world = createWorld();
    // Reset to before the cockatoo migration ran
    world.setProp("$system", "applied_migrations", ["2026-04-30-source-catalog-verbs", "2026-04-30-catalog-placement-metadata"]);
    // Pretend the cockatoo never existed in this world
    world.objects.delete("the_cockatoo");
    world.objects.delete("$cockatoo");
    expect(world.objects.has("$cockatoo")).toBe(false);
    expect(world.objects.has("the_cockatoo")).toBe(false);

    installLocalCatalogs(world, ["chat"]);

    expect(world.objects.has("$cockatoo")).toBe(true);
    expect(world.objects.has("the_cockatoo")).toBe(true);
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-04-30-chat-cockatoo");

    const session = world.auth("guest:migrated-cockatoo");
    await world.directCall("enter", session.actor, "the_chatroom", "enter", []);
    const squawk = await world.directCall("squawk", session.actor, "the_cockatoo", "squawk", []);
    expect(squawk.op).toBe("result");
  });

  it("migrates stale local catalog native verbs to current catalog implementations", async () => {
    const world = createWorld();
    world.setProp("$system", "applied_migrations", []);
    const look = world.object("$conversational").verbs.get("look")!;
    world.addVerb("$conversational", {
      kind: "native",
      name: look.name,
      aliases: look.aliases,
      owner: look.owner,
      perms: look.perms,
      arg_spec: look.arg_spec,
      source: look.source,
      source_hash: look.source_hash,
      version: look.version + 1,
      line_map: look.line_map,
      native: "chat_look",
      direct_callable: look.direct_callable,
      skip_presence_check: look.skip_presence_check
    });
    const enter = world.object("$conversational").verbs.get("enter")!;
    world.addVerb("$conversational", {
      kind: "native",
      name: enter.name,
      aliases: enter.aliases,
      owner: enter.owner,
      perms: enter.perms,
      arg_spec: enter.arg_spec,
      source: enter.source,
      source_hash: enter.source_hash,
      version: enter.version + 1,
      line_map: enter.line_map,
      native: "chat_enter",
      direct_callable: enter.direct_callable,
      skip_presence_check: enter.skip_presence_check
    });
    const addSubtask = world.object("$task").verbs.get("add_subtask")!;
    world.addVerb("$task", {
      kind: "native",
      name: addSubtask.name,
      aliases: addSubtask.aliases,
      owner: addSubtask.owner,
      perms: addSubtask.perms,
      arg_spec: addSubtask.arg_spec,
      source: addSubtask.source,
      source_hash: addSubtask.source_hash,
      version: addSubtask.version + 1,
      line_map: addSubtask.line_map,
      native: "add_subtask",
      direct_callable: addSubtask.direct_callable,
      skip_presence_check: addSubtask.skip_presence_check
    });

    installLocalCatalogs(world, ["chat", "taskspace"]);

    const migratedEnter = world.object("$conversational").verbs.get("enter");
    expect(migratedEnter?.kind).toBe("native");
    if (migratedEnter?.kind === "native") expect(migratedEnter.native).toBe("room_enter");
    const migratedLook = world.object("$conversational").verbs.get("look");
    expect(migratedLook?.kind).toBe("bytecode");
    expect(migratedLook?.source).toContain("look_self");
    expect(world.object("$task").verbs.get("add_subtask")?.kind).toBe("bytecode");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-04-30-source-catalog-verbs");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-04-30-catalog-placement-metadata");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-04-30-room-look-self");
    expect(world.getProp("the_taskspace", "auto_presence")).toBe(true);
    expect(world.getProp("the_taskspace", "host_placement")).toBe("self");

    const session = world.auth("guest:migrated-catalog");
    expect((await world.directCall("enter", session.actor, "the_chatroom", "enter", [])).op).toBe("result");
    const created = await world.call("create-task", session.id, "the_taskspace", {
      actor: session.actor,
      target: "the_taskspace",
      verb: "create_task",
      args: ["Migrated task", ""]
    });
    const task = created.op === "applied" ? String(created.observations[0].task) : "";
    const subtask = await world.call("add-subtask", session.id, "the_taskspace", {
      actor: session.actor,
      target: task,
      verb: "add_subtask",
      args: ["Migrated subtask", ""]
    });
    expect(subtask.op).toBe("applied");
  });

  it("surfaces :title failures during room look composition", async () => {
    const world = createWorld();
    const session = world.auth("guest:title-failure");
    await world.directCall("enter", session.actor, "the_chatroom", "enter", []);
    world.createObject({ id: "bad_title_item", name: "Bad Title", parent: "$thing", owner: "$wiz", location: "the_chatroom" });
    expect(installVerb(world, "bad_title_item", "title", `verb :title() rxd {
  raise { code: "E_PERM", message: "title denied" };
}`, null).ok).toBe(true);

    const look = await world.directCall("look-title-failure", session.actor, "the_chatroom", "look", []);
    expect(look.op).toBe("error");
    if (look.op === "error") expect(look.error.code).toBe("E_PERM");
  });

  it("exposes generic catalog-derived state and object routes", async () => {
    const world = createWorld();
    const session = world.auth("guest:catalog-state");
    const state = world.state(session.actor);
    expect(state.catalogs.installed.map((record: any) => record.catalog)).toEqual(expect.arrayContaining(["chat", "dubspace", "taskspace"]));
    expect(state.spaces).toHaveProperty("the_dubspace");
    expect(state.spaces).toHaveProperty("the_taskspace");
    expect(state.spaces).toHaveProperty("the_chatroom");
    expect((state.objects.the_dubspace as any).props.auto_presence).toBe(true);
    expect((state.objects.the_dubspace as any).location).toBe("the_chatroom");
    expect((state.objects.the_dubspace as any).props.operators).toEqual([]);
    expect((state.objects.slot_1 as any).props.gain).toBe(0.75);
    expect(state.object_routes).toEqual(expect.arrayContaining([
      { id: "the_dubspace", host: "the_dubspace", anchor: null },
      { id: "slot_1", host: "the_dubspace", anchor: "the_dubspace" },
      { id: "the_taskspace", host: "the_taskspace", anchor: null }
    ]));
  });

  it("declares source for every catalog verb", async () => {
    for (const name of readdirSync(root).filter((entry) => existsSync(join(root, entry, "manifest.json")))) {
      const manifest = readManifest(name);
      const defs = [...(manifest.classes ?? []), ...(manifest.features ?? [])];
      for (const def of defs) {
        expect(def.local_name.startsWith("$")).toBe(true);
        expect(def.parent).toBeTruthy();
        for (const verb of def.verbs ?? []) {
          expect(verb.name).toBeTruthy();
          expect(verb.source).toContain("verb");
        }
      }
    }
  });
});
