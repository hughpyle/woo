import { setPropBytecode, setValueBytecode } from "./fixtures";
import { installLocalCatalogs } from "./local-catalogs";
import type { ObjectRepository, SerializedWorld, WorldRepository } from "./repository";
import { hashSource } from "./source-hash";
import type { ObjRef, TinyBytecode, WooValue } from "./types";
import { normalizeVerbPerms } from "./verb-perms";
import { WooWorld } from "./world";

type BootstrapOptions = {
  catalogs?: readonly string[] | false;
};

export function createWorld(options: { repository?: WorldRepository & Partial<ObjectRepository>; catalogs?: readonly string[] | false } = {}): WooWorld {
  const world = new WooWorld(options.repository);
  const stored = options.repository?.load();
  if (stored) {
    world.importWorld(stored);
    world.withPersistencePaused(() => bootstrap(world, { catalogs: options.catalogs }));
    world.persist();
  } else {
    world.withPersistencePaused(() => bootstrap(world, { catalogs: options.catalogs }));
    world.persist();
  }
  world.enableIncrementalPersistence();
  return world;
}

export function createWorldFromSerialized(
  serialized: SerializedWorld,
  options: { repository?: WorldRepository & Partial<ObjectRepository>; persist?: boolean } = {}
): WooWorld {
  const world = new WooWorld(options.repository);
  world.importWorld(serialized);
  if (options.persist !== false) world.persist();
  world.enableIncrementalPersistence();
  return world;
}

export function scopeSerializedWorldToHost(serialized: SerializedWorld, host: ObjRef): SerializedWorld {
  const world = new WooWorld();
  world.importWorld(serialized);
  return world.exportHostScopedWorld(host);
}

export function nonEmptyHostScopedWorld(serialized: SerializedWorld, host: ObjRef): SerializedWorld | null {
  const scoped = scopeSerializedWorldToHost(serialized, host);
  return scoped.objects.length > 0 ? scoped : null;
}

export function bootstrap(world: WooWorld, options: BootstrapOptions = {}): WooWorld {
  seedUniversal(world);
  seedDemoScaffold(world);
  if (options.catalogs !== false) installLocalCatalogs(world, options.catalogs);
  seedGuests(world);
  world.rebuildGuestPool();
  return world;
}

function seedUniversal(world: WooWorld): void {
  world.createObject({ id: "$system", name: "$system", parent: null, owner: "$wiz", flags: { wizard: true } });
  world.createObject({ id: "$root", name: "$root", parent: "$system", owner: "$wiz" });
  world.createObject({ id: "$actor", name: "$actor", parent: "$root", owner: "$wiz" });
  world.createObject({ id: "$player", name: "$player", parent: "$actor", owner: "$wiz" });
  world.createObject({ id: "$wiz", name: "$wiz", parent: "$player", owner: "$wiz", flags: { wizard: true, programmer: true } });
  world.createObject({ id: "$guest", name: "$guest", parent: "$player", owner: "$wiz" });
  world.createObject({ id: "$sequenced_log", name: "$sequenced_log", parent: "$root", owner: "$wiz" });
  world.createObject({ id: "$space", name: "$space", parent: "$sequenced_log", owner: "$wiz" });
  world.createObject({ id: "$thing", name: "$thing", parent: "$root", owner: "$wiz" });
  world.object("$thing").flags.fertile = true;
  world.createObject({ id: "$catalog", name: "$catalog", parent: "$thing", owner: "$wiz" });
  world.createObject({ id: "$catalog_registry", name: "$catalog_registry", parent: "$space", owner: "$wiz" });
  reparentSeed(world, "$space", "$sequenced_log");

  for (const id of ["$root", "$actor", "$player", "$sequenced_log", "$space", "$thing", "$catalog", "$catalog_registry"]) {
    define(world, id, "name", "", "str", "r");
    define(world, id, "description", "", "str", "r");
    define(world, id, "aliases", [], "list<str>", "r");
  }
  define(world, "$root", "host_placement", null, "str|null");
  describeSeed(world, "$system", "Bootstrap object and world registry root. It has no parent, owns the reserved #0 identity, carries wizard authority, and is where corenames and world-level metadata are anchored.");
  describeSeed(world, "$root", "Universal base class for ordinary persistent objects. It defines common descriptive slots and inherited utility verbs, so most object parent chains terminate here before reaching $system.");
  describeSeed(world, "$actor", "Base class for principals that can originate messages. Actors participate in spaces through presence, appear as message.actor, and are the objects whose authority user-facing calls represent.");
  describeSeed(world, "$player", "Session-capable actor class for humans, agents, or tools connected over the wire. A player composes actor identity with session bookkeeping and live connection state.");
  describeSeed(world, "$wiz", "Seed administrator player. It carries wizard and programmer flags so the initial world can bootstrap, inspect, and repair code, schema, and seeded objects.");
  describeSeed(world, "$guest", "Reusable temporary player class. Guest instances bind to short-lived sessions, reset through on_disfunc when the session is reaped, and then return to the free guest pool.");
  describeSeed(world, "$sequenced_log", "Append-only sequenced log base class. It owns the conceptual sequence allocation and replay surface inherited by coordination spaces and catalog registries.");
  describeSeed(world, "$space", "Coordination base class. A space owns a local message sequence, accepts calls, applies them one at a time, stores replayable history, and pushes observations to present subscribers.");
  describeSeed(world, "$thing", "Simple non-actor base class for persistent objects that primarily hold state. Use it when an object should be addressable and programmable but should not itself originate calls.");
  describeSeed(world, "$catalog", "Base class for installed catalog records. Catalog instances record provenance, version, alias, created class objects, and seeded instances for introspection and uninstall planning.");
  describeSeed(world, "$catalog_registry", "Sequenced registry space for catalog operations. It records which catalogs are installed, their aliases and provenance, and the object refs each catalog introduced.");
  seedProp(world, "$system", "wizard_actions", []);
  seedProp(world, "$system", "bootstrap_token_used", false);
  seedProp(world, "$system", "applied_migrations", []);
  define(world, "$actor", "presence_in", [], "list<obj>", "r");
  define(world, "$actor", "features", [], "list<obj>", "r");
  define(world, "$actor", "features_version", 0, "int", "r");
  define(world, "$player", "session_id", null, "str|null", "r");
  define(world, "$player", "home", "$nowhere", "obj|null");
  removeSeedProperty(world, "$player", "attached_sockets");
  define(world, "$space", "next_seq", 1, "int", "r");
  define(world, "$space", "subscribers", [], "list<obj>", "r");
  define(world, "$space", "last_snapshot_seq", 0, "int", "r");
  define(world, "$space", "features", [], "list<obj>", "r");
  define(world, "$space", "features_version", 0, "int", "r");
  define(world, "$space", "auto_presence", false, "bool", "r");
  define(world, "$catalog", "catalog_name", "", "str");
  define(world, "$catalog", "alias", "", "str");
  define(world, "$catalog", "version", "", "str");
  define(world, "$catalog", "tap", "", "str");
  define(world, "$catalog", "objects", {}, "map");
  define(world, "$catalog", "seeds", {}, "map");
  define(world, "$catalog", "provenance", {}, "map");
  seedProp(world, "$catalog_registry", "next_seq", 1);
  seedProp(world, "$catalog_registry", "subscribers", []);
  seedProp(world, "$catalog_registry", "last_snapshot_seq", 0);
  seedProp(world, "$catalog_registry", "features", []);
  seedProp(world, "$catalog_registry", "features_version", 0);
  seedProp(world, "$catalog_registry", "installed_catalogs", []);

  bytecode(world, "$root", "set_value", setValueBytecode, "verb :set_value(value) r { ... }", { perms: "r" });
  bytecode(world, "$root", "set_prop", setPropBytecode, "verb :set_prop(name, value) r { ... }", { perms: "r" });
  native(world, "$root", "describe", "describe", "verb :describe() rxd { ... }", { directCallable: true });
  native(world, "$root", "title", "default_title", "verb :title() rxd { return this.name; }", { directCallable: true });
  native(world, "$root", "look_self", "default_look_self", "verb :look_self() rxd { return { title: this:title(), description: this.description }; }", { directCallable: true });
  native(world, "$player", "on_disfunc", "player_on_disfunc", "verb :on_disfunc() r { ... }", { perms: "r" });
  native(world, "$player", "moveto", "player_moveto", "verb :moveto(target) r { ... }", { perms: "r" });
  native(world, "$guest", "on_disfunc", "guest_on_disfunc", "verb :on_disfunc() r { ... }", { perms: "r" });
  native(world, "$system", "return_guest", "return_guest", "verb :return_guest(guest) r { ... }", { perms: "r" });
  native(world, "$thing", "can_be_attached_by", "feature_can_be_attached_by", "verb :can_be_attached_by(actor) rxd { ... }", { directCallable: true });
  for (const obj of ["$actor", "$space"]) {
    native(world, obj, "add_feature", "add_feature", "verb :add_feature(f) rx { ... }");
    native(world, obj, "remove_feature", "remove_feature", "verb :remove_feature(f) rx { ... }");
    native(world, obj, "has_feature", "has_feature", "verb :has_feature(f) rxd { ... }", { directCallable: true });
  }
  native(world, "$space", "look_self", "space_look_self", "verb :look_self() rxd { ... }", { directCallable: true });
  native(world, "$space", "replay", "replay", "verb :replay(from_seq, limit) rxd { ... }", { directCallable: true });
  native(world, "$catalog_registry", "install", "catalog_registry_install", "verb :install(manifest, frontmatter, alias, provenance) rx { ... }");
  native(world, "$catalog_registry", "list", "catalog_registry_list", "verb :list() rxd { ... }", { directCallable: true });
}

function seedDemoScaffold(world: WooWorld): void {
  world.createObject({ id: "$nowhere", name: "$nowhere", parent: "$thing", owner: "$wiz" });
  describeSeed(world, "$nowhere", "Seed default home for disconnected guests and recycled objects. It is a quiet holding place outside active demo spaces, owned by the wizard for reset operations.");
}

function seedGuests(world: WooWorld): void {
  for (let i = 1; i <= 8; i++) {
    const id = `guest_${i}`;
    world.createObject({ id, name: `Guest ${i}`, parent: "$guest", owner: "$wiz", location: "$nowhere" });
    reparentSeed(world, id, "$guest");
    describeSeed(world, id, `Pre-seeded guest player ${i}. It can be bound to a temporary session, gains presence in demo spaces on auth, and gives local users or agents a stable actor for first-light testing.`);
    seedProp(world, id, "presence_in", []);
    seedProp(world, id, "session_id", null);
    seedProp(world, id, "home", "$nowhere");
    removeSeedProperty(world, id, "attached_sockets");
  }
}

function define(world: WooWorld, obj: ObjRef, name: string, defaultValue: WooValue, typeHint: string, perms = "rw"): void {
  const existing = world.object(obj).propertyDefs.get(name);
  if (existing) {
    if (existing.typeHint !== typeHint || existing.perms !== perms) {
      world.defineProperty(obj, { ...existing, typeHint, perms, version: existing.version + 1 });
    }
    return;
  }
  world.defineProperty(obj, {
    name,
    defaultValue,
    typeHint,
    owner: "$wiz",
    perms
  });
}

function describeSeed(world: WooWorld, obj: ObjRef, description: string): void {
  const existing = world.object(obj).properties.get("description");
  if (typeof existing === "string" && existing.length > 0) return;
  world.setProp(obj, "description", description);
}

function seedProp(world: WooWorld, obj: ObjRef, name: string, value: WooValue): void {
  if (world.object(obj).properties.has(name)) return;
  world.setProp(obj, name, value);
}

function removeSeedProperty(world: WooWorld, obj: ObjRef, name: string): void {
  const target = world.object(obj);
  target.propertyDefs.delete(name);
  target.properties.delete(name);
  target.propertyVersions.delete(name);
}

function reparentSeed(world: WooWorld, obj: ObjRef, parent: ObjRef): void {
  const target = world.object(obj);
  if (target.parent === parent) return;
  if (target.parent && world.objects.has(target.parent)) world.object(target.parent).children.delete(obj);
  target.parent = parent;
  world.object(parent).children.add(obj);
}

function bytecode(world: WooWorld, obj: ObjRef, name: string, bytecodeValue: TinyBytecode, source: string, options: { directCallable?: boolean; skipPresenceCheck?: boolean; perms?: string } = {}): void {
  const existing = world.object(obj).verbs.get(name);
  if (existing) {
    const parsedPerms = normalizeVerbPerms(options.perms ?? existing.perms, existing.direct_callable || options.directCallable === true);
    const next = {
      ...existing,
      perms: parsedPerms.perms,
      direct_callable: parsedPerms.directCallable,
      skip_presence_check: existing.skip_presence_check || options.skipPresenceCheck === true
    };
    if (next.perms !== existing.perms || next.direct_callable !== existing.direct_callable || next.skip_presence_check !== existing.skip_presence_check) world.addVerb(obj, next);
    return;
  }
  const parsedPerms = normalizeVerbPerms(options.perms ?? "rx", options.directCallable === true);
  world.addVerb(obj, {
    kind: "bytecode",
    name,
    aliases: [],
    owner: "$wiz",
    perms: parsedPerms.perms,
    arg_spec: {},
    source,
    source_hash: hashSource(source),
    bytecode: bytecodeValue,
    version: bytecodeValue.version,
    line_map: {},
    direct_callable: parsedPerms.directCallable,
    skip_presence_check: options.skipPresenceCheck === true
  });
}

function native(world: WooWorld, obj: ObjRef, name: string, handler: string, source: string, options: { directCallable?: boolean; skipPresenceCheck?: boolean; perms?: string } = {}): void {
  const existing = world.object(obj).verbs.get(name);
  if (existing) {
    const parsedPerms = normalizeVerbPerms(options.perms ?? existing.perms, existing.direct_callable || options.directCallable === true);
    const next = {
      ...existing,
      perms: parsedPerms.perms,
      direct_callable: parsedPerms.directCallable,
      skip_presence_check: existing.skip_presence_check || options.skipPresenceCheck === true
    };
    if (next.perms !== existing.perms || next.direct_callable !== existing.direct_callable || next.skip_presence_check !== existing.skip_presence_check) world.addVerb(obj, next);
    return;
  }
  const parsedPerms = normalizeVerbPerms(options.perms ?? "rx", options.directCallable === true);
  world.addVerb(obj, {
    kind: "native",
    name,
    aliases: [],
    owner: "$wiz",
    perms: parsedPerms.perms,
    arg_spec: {},
    source,
    source_hash: hashSource(source),
    version: 1,
    line_map: {},
    native: handler,
    direct_callable: parsedPerms.directCallable,
    skip_presence_check: options.skipPresenceCheck === true
  });
}


export { hashSource };
