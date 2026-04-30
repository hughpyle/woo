import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { installCatalogManifest, type CatalogManifest as RuntimeCatalogManifest } from "../src/core/catalog-installer";
import { bundledCatalogAliases, installLocalCatalogs } from "../src/core/local-catalogs";

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
  it("discovers bundled catalogs from manifest locations", () => {
    const catalogDirs = readdirSync(root).filter((name) => existsSync(join(root, name, "manifest.json"))).sort();
    const manifestNames = catalogDirs.map((name) => readManifest(name).name).sort();
    expect([...bundledCatalogAliases()].sort()).toEqual(manifestNames);
  });

  it("keeps README frontmatter aligned with manifests", () => {
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

  it("keeps each catalog's app design with the catalog", () => {
    for (const name of readdirSync(root).filter((entry) => existsSync(join(root, entry, "manifest.json")))) {
      const design = readFileSync(join(root, name, "DESIGN.md"), "utf8");
      expect(design).toMatch(/^# .+ Demo/m);
      expect(readFileSync(join(root, name, "README.md"), "utf8")).toContain("[DESIGN.md](DESIGN.md)");
    }
  });

  it("uses explicit dependency order for embedded chat", () => {
    const taskspace = readManifest("taskspace");
    expect(taskspace.depends).toEqual(["@local:chat"]);
    expect(taskspace.seed_hooks).toContainEqual({ kind: "attach_feature", consumer: "the_taskspace", feature: "chat:$conversational" });
  });

  it("rejects missing catalog dependencies with the installed set in the error", () => {
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

  it("installs chat from source without trusted implementation hints", () => {
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

    const first = world.auth("guest:catalog-chat-1");
    const second = world.auth("guest:catalog-chat-2");
    const enterFirst = world.directCall("enter-first", first.actor, "the_chatroom", "enter", []);
    const enterSecond = world.directCall("enter-second", second.actor, "the_chatroom", "enter", []);
    expect(enterFirst.op).toBe("result");
    expect(enterSecond.op).toBe("result");
    expect(world.hasPresence(first.actor, "the_chatroom")).toBe(true);
    expect(world.hasPresence(second.actor, "the_chatroom")).toBe(true);

    const say = world.directCall("say", first.actor, "the_chatroom", "say", ["hello from source"]);
    expect(say.op).toBe("result");
    if (say.op === "result") {
      expect(say.observations).toMatchObject([{ type: "said", source: "the_chatroom", actor: first.actor, text: "hello from source" }]);
      expect(typeof say.observations[0].ts).toBe("number");
    }

    const leave = world.directCall("leave", second.actor, "the_chatroom", "leave", []);
    expect(leave.op).toBe("result");
    expect(world.hasPresence(second.actor, "the_chatroom")).toBe(false);
  });

  it("installs taskspace from source without trusted implementation hints", () => {
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
    const created = world.call("create-task", session.id, "the_taskspace", {
      actor: session.actor,
      target: "the_taskspace",
      verb: "create_task",
      args: ["Source task", ""]
    });
    expect(created.op).toBe("applied");
    const task = created.op === "applied" ? String(created.observations[0].task) : "";
    expect(world.getProp(task, "title")).toBe("Source task");

    world.call("requirement", session.id, "the_taskspace", { actor: session.actor, target: task, verb: "add_requirement", args: ["has source verbs"] });
    const done = world.call("done", session.id, "the_taskspace", { actor: session.actor, target: task, verb: "set_status", args: ["done"] });
    expect(world.getProp(task, "status")).toBe("done");
    if (done.op === "applied") expect(done.observations.map((obs) => obs.type)).toContain("done_premature");
  });

  it("installs dubspace from source without trusted implementation hints", () => {
    const world = createWorld({ catalogs: false });
    installCatalogManifest(world, readManifest("dubspace") as unknown as RuntimeCatalogManifest, {
      tap: "github:hugh/woo",
      alias: "dubspace",
      allowImplementationHints: false
    });

    expect(world.object("$dubspace").verbs.get("set_control")?.kind).toBe("bytecode");
    expect(world.object("$dubspace").verbs.get("set_drum_step")?.kind).toBe("bytecode");
    expect(world.object("$dubspace").verbs.get("save_scene")?.kind).toBe("bytecode");

    const session = world.auth("guest:catalog-dubspace");
    const actor = session.actor;
    const applied = world.call("set-control", session.id, "the_dubspace", {
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "feedback", 0.44]
    });
    expect(applied.op).toBe("applied");
    expect(world.getProp("delay_1", "feedback")).toBe(0.44);

    const preview = world.directCall("preview", actor, "the_dubspace", "preview_control", ["delay_1", "feedback", 0.5]);
    expect(preview.op).toBe("result");
    if (preview.op === "result") {
      expect(preview.observations[0]).toMatchObject({ type: "gesture_progress", source: "the_dubspace", actor, target: "delay_1", name: "feedback", value: 0.5 });
    }
    expect(world.getProp("delay_1", "feedback")).toBe(0.44);

    world.call("drum", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "set_drum_step", args: ["tone", 3, true] });
    world.call("tempo", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "set_tempo", args: [250] });
    const pattern = world.getProp("drum_1", "pattern") as Record<string, boolean[]>;
    expect(pattern.tone[3]).toBe(true);
    expect(world.getProp("drum_1", "bpm")).toBe(200);

    world.call("save", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "save_scene", args: ["Source Scene"] });
    world.call("mutate", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "set_control", args: ["delay_1", "feedback", 0.11] });
    expect(world.getProp("delay_1", "feedback")).toBe(0.11);
    world.call("recall", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "recall_scene", args: ["default_scene"] });
    expect(world.getProp("delay_1", "feedback")).toBe(0.44);
  });

  it("seeds the_cockatoo in the chatroom with random-pick squawk", () => {
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
    world.directCall("enter", session.actor, "the_chatroom", "enter", []);

    const squawk = world.directCall("squawk", session.actor, "the_cockatoo", "squawk", []);
    expect(squawk.op).toBe("result");
    if (squawk.op === "result") {
      expect(phrases).toContain(String(squawk.result));
      expect(squawk.observations[0]).toMatchObject({ type: "cockatoo_squawk", source: "the_cockatoo", actor: session.actor });
    }

    world.directCall("teach", session.actor, "the_cockatoo", "teach", ["world of objects"]);
    expect((world.getProp("the_cockatoo", "phrases") as string[]).at(-1)).toBe("world of objects");

    world.directCall("gag", session.actor, "the_cockatoo", "gag", []);
    const muffled = world.directCall("squawk-gagged", session.actor, "the_cockatoo", "squawk", []);
    if (muffled.op === "result") {
      expect(muffled.result).toBe("*muffled noises*");
      expect(muffled.observations[0]).toMatchObject({ type: "cockatoo_muffled" });
    }
  });

  it("migrates the cockatoo into worlds installed before it landed", () => {
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
    world.directCall("enter", session.actor, "the_chatroom", "enter", []);
    const squawk = world.directCall("squawk", session.actor, "the_cockatoo", "squawk", []);
    expect(squawk.op).toBe("result");
  });

  it("migrates stale local catalog native verbs to source bytecode", () => {
    const world = createWorld();
    world.setProp("$system", "applied_migrations", []);
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

    expect(world.object("$conversational").verbs.get("enter")?.kind).toBe("bytecode");
    expect(world.object("$task").verbs.get("add_subtask")?.kind).toBe("bytecode");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-04-30-source-catalog-verbs");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-04-30-catalog-placement-metadata");
    expect(world.getProp("the_taskspace", "auto_presence")).toBe(true);
    expect(world.getProp("the_taskspace", "host_placement")).toBe("self");

    const session = world.auth("guest:migrated-catalog");
    expect(world.directCall("enter", session.actor, "the_chatroom", "enter", []).op).toBe("result");
    const created = world.call("create-task", session.id, "the_taskspace", {
      actor: session.actor,
      target: "the_taskspace",
      verb: "create_task",
      args: ["Migrated task", ""]
    });
    const task = created.op === "applied" ? String(created.observations[0].task) : "";
    const subtask = world.call("add-subtask", session.id, "the_taskspace", {
      actor: session.actor,
      target: task,
      verb: "add_subtask",
      args: ["Migrated subtask", ""]
    });
    expect(subtask.op).toBe("applied");
  });

  it("declares source for every catalog verb", () => {
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
