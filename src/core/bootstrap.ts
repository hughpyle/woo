import { claimBytecode, setControlBytecode, setPropBytecode, setStatusBytecode, setValueBytecode } from "./fixtures";
import { compileWooSource } from "./dsl-compiler";
import type { ObjectRepository, WorldRepository } from "./repository";
import { hashSource } from "./source-hash";
import type { ObjRef, TinyBytecode, VerbDef, WooValue } from "./types";
import { WooWorld } from "./world";

export function createWorld(options: { repository?: WorldRepository & Partial<ObjectRepository> } = {}): WooWorld {
  const world = new WooWorld(options.repository);
  const stored = options.repository?.load();
  if (stored) {
    world.importWorld(stored);
    world.withPersistencePaused(() => bootstrap(world));
    world.persist();
  } else {
    world.withPersistencePaused(() => bootstrap(world));
    world.persist();
  }
  world.enableIncrementalPersistence();
  return world;
}

export function bootstrap(world: WooWorld): WooWorld {
  seedUniversal(world);
  seedDemoScaffold(world);
  seedDubspace(world);
  seedTaskspace(world);
  seedChat(world);
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
  world.createObject({ id: "$space", name: "$space", parent: "$root", owner: "$wiz" });
  world.createObject({ id: "$thing", name: "$thing", parent: "$root", owner: "$wiz" });

  for (const id of ["$root", "$actor", "$player", "$space", "$thing"]) {
    define(world, id, "name", "", "str");
    define(world, id, "description", "", "str");
    define(world, id, "aliases", [], "list<str>");
  }
  describeSeed(world, "$system", "Bootstrap object and world registry root. It has no parent, owns the reserved #0 identity, carries wizard authority, and is where corenames and world-level metadata are anchored.");
  describeSeed(world, "$root", "Universal base class for ordinary persistent objects. It defines common descriptive slots and inherited utility verbs, so most object parent chains terminate here before reaching $system.");
  describeSeed(world, "$actor", "Base class for principals that can originate messages. Actors participate in spaces through presence, appear as message.actor, and are the objects whose authority user-facing calls represent.");
  describeSeed(world, "$player", "Session-capable actor class for humans, agents, or tools connected over the wire. A player composes actor identity with session bookkeeping and live connection state.");
  describeSeed(world, "$wiz", "Seed administrator player. It carries wizard and programmer flags so the initial world can bootstrap, inspect, and repair code, schema, and seeded objects.");
  describeSeed(world, "$guest", "Reusable temporary player class. Guest instances bind to short-lived sessions, reset through on_disfunc when the session is reaped, and then return to the free guest pool.");
  describeSeed(world, "$space", "Coordination base class. A space owns a local message sequence, accepts calls, applies them one at a time, stores replayable history, and pushes observations to present subscribers.");
  describeSeed(world, "$thing", "Simple non-actor base class for persistent objects that primarily hold state. Use it when an object should be addressable and programmable but should not itself originate calls.");
  seedProp(world, "$system", "wizard_actions", []);
  define(world, "$actor", "presence_in", [], "list<obj>");
  define(world, "$actor", "features", [], "list<obj>");
  define(world, "$actor", "features_version", 0, "int");
  define(world, "$player", "session_id", null, "str|null");
  define(world, "$player", "home", "$nowhere", "obj|null");
  removeSeedProperty(world, "$player", "attached_sockets");
  define(world, "$space", "next_seq", 1, "int");
  define(world, "$space", "subscribers", [], "list<obj>");
  define(world, "$space", "last_snapshot_seq", 0, "int");
  define(world, "$space", "features", [], "list<obj>");
  define(world, "$space", "features_version", 0, "int");

  bytecode(world, "$root", "set_value", setValueBytecode, "verb :set_value(value) rx { ... }");
  bytecode(world, "$root", "set_prop", setPropBytecode, "verb :set_prop(name, value) rx { ... }");
  native(world, "$root", "describe", "describe", "verb :describe() rxd { ... }", { directCallable: true });
  native(world, "$player", "on_disfunc", "player_on_disfunc", "verb :on_disfunc() rx { ... }");
  native(world, "$player", "moveto", "player_moveto", "verb :moveto(target) rx { ... }");
  native(world, "$guest", "on_disfunc", "guest_on_disfunc", "verb :on_disfunc() rx { ... }");
  native(world, "$system", "return_guest", "return_guest", "verb :return_guest(guest) rx { ... }");
  native(world, "$thing", "can_be_attached_by", "feature_can_be_attached_by", "verb :can_be_attached_by(actor) rxd { ... }", { directCallable: true });
  for (const obj of ["$actor", "$space"]) {
    native(world, obj, "add_feature", "add_feature", "verb :add_feature(f) rx { ... }");
    native(world, obj, "remove_feature", "remove_feature", "verb :remove_feature(f) rx { ... }");
    native(world, obj, "has_feature", "has_feature", "verb :has_feature(f) rxd { ... }", { directCallable: true });
  }
  native(world, "$space", "replay", "replay", "verb :replay(from_seq, limit) rxd { ... }", { directCallable: true });
}

function seedDemoScaffold(world: WooWorld): void {
  world.createObject({ id: "$nowhere", name: "$nowhere", parent: "$thing", owner: "$wiz" });
  describeSeed(world, "$nowhere", "Seed default home for disconnected guests and recycled objects. It is a quiet holding place outside active demo spaces, owned by the wizard for reset operations.");
}

function seedDubspace(world: WooWorld): void {
  world.createObject({ id: "$dubspace", name: "$dubspace", parent: "$space", owner: "$wiz" });
  world.createObject({ id: "$control", name: "$control", parent: "$root", owner: "$wiz" });
  world.createObject({ id: "$loop_slot", name: "$loop_slot", parent: "$control", owner: "$wiz" });
  world.createObject({ id: "$channel", name: "$channel", parent: "$control", owner: "$wiz" });
  world.createObject({ id: "$filter", name: "$filter", parent: "$control", owner: "$wiz" });
  world.createObject({ id: "$delay", name: "$delay", parent: "$control", owner: "$wiz" });
  world.createObject({ id: "$drum_loop", name: "$drum_loop", parent: "$control", owner: "$wiz" });
  world.createObject({ id: "$scene", name: "$scene", parent: "$root", owner: "$wiz" });
  world.createObject({ id: "the_dubspace", name: "Dubspace", parent: "$dubspace", owner: "$wiz" });

  describeSeed(world, "$dubspace", "Base class for shared dub-mix spaces. It composes $space sequencing with sound-control verbs for loop slots, mixer channels, filters, delay, and scene recall.");
  describeSeed(world, "$control", "Base class for addressable controls in a sound surface. Controls are anchored into a containing space so sequenced messages can mutate the whole control cluster atomically.");
  describeSeed(world, "$loop_slot", "Control class for a loaded loop slot. A loop slot stores the selected loop id, whether it is playing, and gain, and is driven by start/stop and control-change messages.");
  describeSeed(world, "$channel", "Control class for mixer-channel state. The first demo keeps this intentionally small, with gain as the primary channel property.");
  describeSeed(world, "$filter", "Control class for filter state. It currently models cutoff as a shared sequenced parameter in the dubspace control cluster.");
  describeSeed(world, "$delay", "Control class for delay-effect state. It groups send, time, feedback, and wet mix so actors can shape echo gestures through ordinary sequenced messages.");
  describeSeed(world, "$drum_loop", "Control class for a small step-sequenced percussion loop. It stores transport state, tempo, and an eight-step pattern for simple shared rhythmic play.");
  describeSeed(world, "$scene", "Class for saved control snapshots. A scene records a named map of control object refs to property values so a dubspace can restore a known mix state.");
  describeSeed(world, "the_dubspace", "The first runnable sound-space instance. It owns the sequenced coordination surface for four loop slots, one channel, one filter, one delay, one percussion loop, and one default scene.");

  for (const id of ["the_dubspace"]) {
    seedProp(world, id, "next_seq", 1);
    seedProp(world, id, "subscribers", []);
    seedProp(world, id, "last_snapshot_seq", 0);
  }

  bytecode(world, "$dubspace", "set_control", setControlBytecode, "verb :set_control(target, name, value) rx { ... }");
  native(world, "$dubspace", "preview_control", "preview_control", "verb :preview_control(target, name, value) rxd { ... }", { directCallable: true });
  native(world, "$dubspace", "cursor", "cursor", "verb :cursor(x, y) rxd { ... }", { directCallable: true });
  source(world, "$dubspace", "start_loop", `verb :start_loop(slot) rx {
  slot.playing = true;
  observe({ type: "loop_started", slot: slot, loop_id: slot.loop_id });
  return true;
}`, { replaceNative: "start_loop" });
  source(world, "$dubspace", "stop_loop", `verb :stop_loop(slot) rx {
  slot.playing = false;
  observe({ type: "loop_stopped", slot: slot });
  return true;
}`, { replaceNative: "stop_loop" });
  native(world, "$dubspace", "save_scene", "save_scene", "verb :save_scene(name) rx { ... }");
  native(world, "$dubspace", "recall_scene", "recall_scene", "verb :recall_scene(scene) rx { ... }");
  native(world, "$dubspace", "set_drum_step", "set_drum_step", "verb :set_drum_step(voice, step, enabled) rx { ... }");
  native(world, "$dubspace", "set_tempo", "set_tempo", "verb :set_tempo(bpm) rx { ... }");
  native(world, "$dubspace", "start_transport", "start_transport", "verb :start_transport() rx { ... }");
  native(world, "$dubspace", "stop_transport", "stop_transport", "verb :stop_transport() rx { ... }");

  for (let i = 1; i <= 4; i++) {
    const id = `slot_${i}`;
    world.createObject({ id, name: `Loop ${i}`, parent: "$loop_slot", owner: "$wiz", anchor: "the_dubspace", location: "the_dubspace" });
    describeSeed(world, id, `Loop slot ${i} in the demo dubspace. It is anchored to the_dubspace and stores its loop id, playing state, and gain as part of the shared sequenced mix.`);
    seedProp(world, id, "loop_id", `loop-${i}`);
    seedProp(world, id, "playing", false);
    seedProp(world, id, "gain", 0.75);
    seedProp(world, id, "freq", [110, 146.83, 196, 261.63][i - 1]);
  }
  world.createObject({ id: "channel_1", name: "Channel", parent: "$channel", owner: "$wiz", anchor: "the_dubspace", location: "the_dubspace" });
  describeSeed(world, "channel_1", "Mixer channel for the demo dubspace. It is anchored to the_dubspace and contributes shared gain state to the current mix.");
  seedProp(world, "channel_1", "gain", 0.8);
  world.createObject({ id: "filter_1", name: "Filter", parent: "$filter", owner: "$wiz", anchor: "the_dubspace", location: "the_dubspace" });
  describeSeed(world, "filter_1", "Shared filter control for the demo dubspace. It is anchored to the_dubspace and exposes cutoff as a sequenced parameter.");
  seedProp(world, "filter_1", "cutoff", 1000);
  world.createObject({ id: "delay_1", name: "Delay", parent: "$delay", owner: "$wiz", anchor: "the_dubspace", location: "the_dubspace" });
  describeSeed(world, "delay_1", "Shared delay control for the demo dubspace. It is anchored to the_dubspace and stores send, time, feedback, and wet mix values for collaborative echo gestures.");
  seedProp(world, "delay_1", "send", 0.3);
  seedProp(world, "delay_1", "time", 0.25);
  seedProp(world, "delay_1", "feedback", 0.35);
  seedProp(world, "delay_1", "wet", 0.4);
  world.createObject({ id: "drum_1", name: "Percussion Loop", parent: "$drum_loop", owner: "$wiz", anchor: "the_dubspace", location: "the_dubspace" });
  describeSeed(world, "drum_1", "Eight-step percussion loop for the demo dubspace. It is anchored to the_dubspace and stores tempo, transport state, and a shared kick/snare/hat/tone pattern.");
  seedProp(world, "drum_1", "bpm", 118);
  seedProp(world, "drum_1", "playing", false);
  seedProp(world, "drum_1", "started_at", 0);
  seedProp(world, "drum_1", "step_count", 8);
  seedProp(world, "drum_1", "pattern", {
    kick: [true, false, false, false, true, false, false, false],
    snare: [false, false, true, false, false, false, true, false],
    hat: [true, true, true, true, true, true, true, true],
    tone: [false, false, false, true, false, false, false, true]
  });
  world.createObject({ id: "default_scene", name: "Default Scene", parent: "$scene", owner: "$wiz", anchor: "the_dubspace", location: "the_dubspace" });
  describeSeed(world, "default_scene", "Initial saved scene for the demo dubspace. It records a named control snapshot and gives scene recall a concrete object to read and rewrite.");
  seedProp(world, "default_scene", "name", "Default");
  seedProp(world, "default_scene", "controls", {});
}

function seedTaskspace(world: WooWorld): void {
  world.createObject({ id: "$taskspace", name: "$taskspace", parent: "$space", owner: "$wiz" });
  world.createObject({ id: "$task", name: "$task", parent: "$root", owner: "$wiz" });
  world.createObject({ id: "the_taskspace", name: "Taskspace", parent: "$taskspace", owner: "$wiz" });

  describeSeed(world, "$taskspace", "Base class for spaces that coordinate hierarchical work. It extends $space with root task ordering and task-creation behavior for asynchronous human and agent collaboration.");
  describeSeed(world, "$task", "Base class for taskspace work items. A task stores title, description, status, assignee, requirements, artifacts, messages, parent linkage, and ordered subtasks.");
  describeSeed(world, "the_taskspace", "The first runnable task coordination space. It owns the sequenced timeline and anchored task tree used by people or agents to create, claim, discuss, and complete work.");

  seedProp(world, "the_taskspace", "next_seq", 1);
  seedProp(world, "the_taskspace", "subscribers", []);
  seedProp(world, "the_taskspace", "last_snapshot_seq", 0);
  seedProp(world, "the_taskspace", "root_tasks", []);

  native(world, "$taskspace", "create_task", "create_task", "verb :create_task(title, description) rx { ... }");
  native(world, "$task", "add_subtask", "add_subtask", "verb :add_subtask(title, description) rx { ... }");
  native(world, "$task", "move", "move_task", "verb :move(parent, index) rx { ... }");
  native(world, "$task", "claim", "claim_task", "verb :claim() rx { ... }");
  native(world, "$task", "release", "release_task", "verb :release() rx { ... }");
  native(world, "$task", "set_status", "set_status_task", "verb :set_status(status) rx { ... }");
  native(world, "$task", "add_requirement", "add_requirement", "verb :add_requirement(text) rx { ... }");
  native(world, "$task", "check_requirement", "check_requirement", "verb :check_requirement(index, checked) rx { ... }");
  native(world, "$task", "add_message", "add_message", "verb :add_message(body) rx { ... }");
  native(world, "$task", "add_artifact", "add_artifact", "verb :add_artifact(ref) rx { ... }");
  bytecode(world, "$task", "claim_fixture", claimBytecode, "verb :claim_fixture() rx { ... }");
  bytecode(world, "$task", "set_status_fixture", setStatusBytecode, "verb :set_status_fixture(status) rx { ... }");
}

function seedChat(world: WooWorld): void {
  world.createObject({ id: "$match", name: "$match", parent: "$thing", owner: "$wiz" });
  world.createObject({ id: "$failed_match", name: "$failed_match", parent: "$thing", owner: "$wiz" });
  world.createObject({ id: "$ambiguous_match", name: "$ambiguous_match", parent: "$thing", owner: "$wiz" });
  world.createObject({ id: "$conversational", name: "$conversational", parent: "$thing", owner: "$wiz" });
  world.createObject({ id: "$chatroom", name: "$chatroom", parent: "$space", owner: "$wiz" });
  world.createObject({ id: "the_chatroom", name: "Lobby", parent: "$chatroom", owner: "$wiz" });

  describeSeed(world, "$match", "Chat-shaped text-to-action scaffold. It tokenizes input, resolves visible objects and verbs, and lets text clients lower commands into structured calls.");
  describeSeed(world, "$failed_match", "Stable sentinel returned by matching code when no visible object matches a text phrase. It is compared by identity rather than raised as an exception.");
  describeSeed(world, "$ambiguous_match", "Stable sentinel returned by matching code when more than one visible object matches a text phrase. It lets callers ask for clarification without exceptions.");
  describeSeed(world, "$conversational", "Feature object carrying live chat verbs for spaces. Consumers attach it through their features list so talk, emote, tell, look, who, enter, leave, and command compose without inheritance.");
  describeSeed(world, "$chatroom", "Standalone chat room class for live, direct, non-logged conversation. It is a small $space subclass whose chat behavior comes from the $conversational feature.");
  describeSeed(world, "the_chatroom", "The first runnable chat room. It is a live lobby where connected actors can speak, emote, tell, look, and see who is present through the $conversational feature.");

  seedProp(world, "the_chatroom", "next_seq", 1);
  seedProp(world, "the_chatroom", "subscribers", []);
  seedProp(world, "the_chatroom", "last_snapshot_seq", 0);
  seedFeature(world, "the_chatroom", "$conversational");
  seedFeature(world, "the_taskspace", "$conversational");

  native(world, "$conversational", "can_be_attached_by", "conversational_can_be_attached_by", "verb :can_be_attached_by(actor) rxd { ... }", { directCallable: true });
  native(world, "$conversational", "say", "chat_say", "verb :say(text) rxd { ... }", { directCallable: true });
  native(world, "$conversational", "emote", "chat_emote", "verb :emote(text) rxd { ... }", { directCallable: true });
  native(world, "$conversational", "tell", "chat_tell", "verb :tell(recipient, text) rxd { ... }", { directCallable: true });
  native(world, "$conversational", "look", "chat_look", "verb :look() rxd { ... }", { directCallable: true });
  native(world, "$conversational", "who", "chat_who", "verb :who() rxd { ... }", { directCallable: true });
  native(world, "$conversational", "enter", "chat_enter", "verb :enter(actor?) rxd { ... }", { directCallable: true, skipPresenceCheck: true });
  native(world, "$conversational", "leave", "chat_leave", "verb :leave(actor?) rxd { ... }", { directCallable: true });
  native(world, "$conversational", "command", "chat_command", "verb :command(text) rxd { ... }", { directCallable: true });
  for (const name of ["say", "emote", "tell", "look", "who", "enter", "leave", "command"]) removeSeedNative(world, "$chatroom", name, `chat_${name}`);
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

function define(world: WooWorld, obj: ObjRef, name: string, defaultValue: WooValue, typeHint: string): void {
  if (world.object(obj).propertyDefs.has(name)) return;
  world.defineProperty(obj, {
    name,
    defaultValue,
    typeHint,
    owner: "$wiz",
    perms: "rw"
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

function seedFeature(world: WooWorld, obj: ObjRef, feature: ObjRef): void {
  const raw = world.getProp(obj, "features");
  const features = Array.isArray(raw) ? raw.map((item) => String(item)) : [];
  if (features.includes(feature)) return;
  world.setProp(obj, "features", [...features, feature]);
  const rawVersion = Number(world.getProp(obj, "features_version") ?? 0);
  world.setProp(obj, "features_version", Number.isFinite(rawVersion) ? rawVersion + 1 : 1);
}

function removeSeedNative(world: WooWorld, obj: ObjRef, name: string, nativeName: string): void {
  const verbs = world.object(obj).verbs;
  const existing = verbs.get(name);
  if (existing?.kind === "native" && existing.native === nativeName) verbs.delete(name);
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

function bytecode(world: WooWorld, obj: ObjRef, name: string, bytecodeValue: TinyBytecode, source: string, options: { directCallable?: boolean; skipPresenceCheck?: boolean } = {}): void {
  const existing = world.object(obj).verbs.get(name);
  if (existing) {
    const next = {
      ...existing,
      direct_callable: existing.direct_callable || options.directCallable === true,
      skip_presence_check: existing.skip_presence_check || options.skipPresenceCheck === true
    };
    if (next.direct_callable !== existing.direct_callable || next.skip_presence_check !== existing.skip_presence_check) world.addVerb(obj, next);
    return;
  }
  world.addVerb(obj, {
    kind: "bytecode",
    name,
    aliases: [],
    owner: "$wiz",
    perms: "rxd",
    arg_spec: {},
    source,
    source_hash: hashSource(source),
    bytecode: bytecodeValue,
    version: bytecodeValue.version,
    line_map: {},
    direct_callable: options.directCallable === true,
    skip_presence_check: options.skipPresenceCheck === true
  });
}

function native(world: WooWorld, obj: ObjRef, name: string, handler: string, source: string, options: { directCallable?: boolean; skipPresenceCheck?: boolean } = {}): void {
  const existing = world.object(obj).verbs.get(name);
  if (existing) {
    const next = {
      ...existing,
      direct_callable: existing.direct_callable || options.directCallable === true,
      skip_presence_check: existing.skip_presence_check || options.skipPresenceCheck === true
    };
    if (next.direct_callable !== existing.direct_callable || next.skip_presence_check !== existing.skip_presence_check) world.addVerb(obj, next);
    return;
  }
  world.addVerb(obj, {
    kind: "native",
    name,
    aliases: [],
    owner: "$wiz",
    perms: "rxd",
    arg_spec: {},
    source,
    source_hash: hashSource(source),
    version: 1,
    line_map: {},
    native: handler,
    direct_callable: options.directCallable === true,
    skip_presence_check: options.skipPresenceCheck === true
  });
}

function source(world: WooWorld, obj: ObjRef, name: string, sourceText: string, options: { directCallable?: boolean; skipPresenceCheck?: boolean; replaceNative?: string } = {}): void {
  const existing = world.object(obj).verbs.get(name);
  const compiled = compileWooSource(sourceText);
  if (!compiled.ok || !compiled.bytecode) throw new Error(`seed source failed for ${obj}:${name}: ${compiled.diagnostics[0]?.message ?? "compile failed"}`);
  const shouldReplace =
    !existing ||
    (existing.kind === "native" && existing.native === options.replaceNative) ||
    (existing.kind === "bytecode" && existing.source_hash === compiled.source_hash);
  if (!shouldReplace) {
    const next = {
      ...existing,
      direct_callable: existing.direct_callable || options.directCallable === true,
      skip_presence_check: existing.skip_presence_check || options.skipPresenceCheck === true
    };
    if (next.direct_callable !== existing.direct_callable || next.skip_presence_check !== existing.skip_presence_check) world.addVerb(obj, next);
    return;
  }
  const version = existing?.kind === "bytecode" && existing.source_hash === compiled.source_hash ? existing.version : (existing?.version ?? 0) + 1;
  world.addVerb(obj, {
    kind: "bytecode",
    name,
    aliases: [],
    owner: "$wiz",
    perms: compiled.metadata?.perms ?? "rxd",
    arg_spec: compiled.metadata?.arg_spec ?? {},
    source: sourceText,
    source_hash: compiled.source_hash ?? hashSource(sourceText),
    bytecode: { ...compiled.bytecode, version },
    version,
    line_map: compiled.line_map ?? {},
    direct_callable: options.directCallable === true,
    skip_presence_check: options.skipPresenceCheck === true
  });
}

export { hashSource };
