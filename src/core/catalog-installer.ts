import { compileVerb } from "./authoring";
import { fixtureByName } from "./fixtures";
import { hashSource } from "./source-hash";
import { wooError, type ObjRef, type TinyBytecode, type VerbDef, type WooValue } from "./types";
import { normalizeVerbPerms } from "./verb-perms";
import type { WooWorld } from "./world";

export type CatalogManifest = {
  name: string;
  version: string;
  spec_version: string;
  description?: string;
  license?: string;
  depends?: string[];
  classes?: CatalogObjectDef[];
  features?: CatalogObjectDef[];
  schemas?: CatalogSchemaDef[];
  seed_hooks?: CatalogSeedHook[];
};

type CatalogObjectDef = {
  local_name: string;
  parent: string;
  description?: string;
  properties?: CatalogPropertyDef[];
  verbs?: CatalogVerbDef[];
};

type CatalogPropertyDef = {
  name: string;
  type?: string;
  default?: WooValue;
  perms?: string;
};

type CatalogVerbDef = {
  name: string;
  aliases?: string[];
  perms?: string;
  arg_spec?: Record<string, WooValue>;
  source: string;
  direct_callable?: boolean;
  skip_presence_check?: boolean;
  tool_exposed?: boolean;
  implementation?: { kind: "native"; handler: string } | { kind: "fixture"; name: keyof typeof fixtureByName };
};

type CatalogSchemaDef = {
  on: string;
  type: string;
  shape: Record<string, WooValue>;
};

type CatalogSeedHook =
  | {
      kind: "create_instance";
      class: string;
      as: string;
      name?: string;
      description?: string;
      anchor?: string;
      location?: string;
      properties?: Record<string, WooValue>;
    }
  | {
      kind: "attach_feature";
      consumer: string;
      feature: string;
    };

type InstalledCatalogRecord = {
  tap: string;
  catalog: string;
  alias: string;
  version: string;
  installed_at: number;
  owner: ObjRef;
  objects: Record<string, ObjRef>;
  seeds: Record<string, ObjRef>;
  provenance: Record<string, WooValue>;
};

const DYNAMIC_SEED_PROPERTIES = new Set([
  "next_seq",
  "subscribers",
  "last_snapshot_seq"
]);

export type InstallCatalogOptions = {
  actor?: ObjRef;
  tap?: string;
  alias?: string;
  provenance?: Record<string, WooValue>;
  allowImplementationHints?: boolean;
};

export type RepairCatalogOptions = {
  actor?: ObjRef;
  allowImplementationHints?: boolean;
  reconcileSeedHooks?: boolean;
  rehomeNowhereSeedObjects?: boolean;
};

export function installCatalogManifest(world: WooWorld, manifest: CatalogManifest, options: InstallCatalogOptions = {}): InstalledCatalogRecord {
  const actor = options.actor ?? "$wiz";
  const tap = options.tap ?? "@local";
  const alias = options.alias ?? manifest.name;
  const allowImplementationHints = options.allowImplementationHints ?? tap === "@local";
  const provenance = options.provenance ?? {
    tap,
    catalog: manifest.name,
    alias,
    ref_requested: tap === "@local" ? "@local" : "unversioned",
    ref_resolved_sha: "unversioned"
  };
  const existing = installedCatalogs(world);
  assertDependenciesInstalled(manifest, existing);

  const localObjects = new Map<string, ObjRef>();
  const localSeeds = new Map<string, ObjRef>();
  const objectDefs = [...(manifest.classes ?? []), ...(manifest.features ?? [])];
  for (const def of objectDefs) localObjects.set(def.local_name, def.local_name);

  for (const def of objectDefs) {
    const id = def.local_name;
    const parent = resolveObjectRef(world, def.parent, localObjects, localSeeds, existing);
    world.createObject({ id, name: id, parent, owner: actor });
    setDescriptionIfEmpty(world, id, catalogDescription(def.description, id, manifest.name));
    for (const property of def.properties ?? []) installProperty(world, id, property, actor);
    for (const verb of def.verbs ?? []) installVerbDef(world, id, verb, actor, allowImplementationHints, false);
  }

  for (const schema of manifest.schemas ?? []) {
    const on = resolveObjectRef(world, schema.on, localObjects, localSeeds, existing);
    world.defineEventSchema(on, schema.type, schema.shape);
  }

  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind === "create_instance") {
      const id = hook.as;
      const parent = resolveObjectRef(world, hook.class, localObjects, localSeeds, existing);
      const anchor = hook.anchor ? resolveObjectRef(world, hook.anchor, localObjects, localSeeds, existing) : null;
      const location = hook.location ? resolveObjectRef(world, hook.location, localObjects, localSeeds, existing) : null;
      world.createObject({ id, name: hook.name ?? id, parent, owner: actor, anchor, location });
      localSeeds.set(hook.as, id);
      setDescriptionIfEmpty(world, id, catalogDescription(hook.description, hook.name ?? id, manifest.name));
      setNameIfMissing(world, id, hook.name ?? id);
      for (const [name, value] of Object.entries(hook.properties ?? {})) setPropIfMissing(world, id, name, value);
      continue;
    }
    const consumer = resolveObjectRef(world, hook.consumer, localObjects, localSeeds, existing);
    const feature = resolveObjectRef(world, hook.feature, localObjects, localSeeds, existing);
    attachFeature(world, consumer, feature);
  }

  const record: InstalledCatalogRecord = {
    tap,
    catalog: manifest.name,
    alias,
    version: manifest.version,
    installed_at: Date.now(),
    owner: actor,
    objects: Object.fromEntries(localObjects),
    seeds: Object.fromEntries(localSeeds),
    provenance
  };
  recordCatalogInstall(world, record);
  return record;
}

export function repairCatalogManifest(world: WooWorld, manifest: CatalogManifest, options: RepairCatalogOptions = {}): void {
  const actor = options.actor ?? "$wiz";
  const allowImplementationHints = options.allowImplementationHints ?? false;
  const reconcileSeedHooks = options.reconcileSeedHooks ?? false;
  const rehomeNowhereSeedObjects = options.rehomeNowhereSeedObjects ?? false;
  const existing = installedCatalogs(world);
  const localObjects = new Map<string, ObjRef>();
  const localSeeds = new Map<string, ObjRef>();
  const objectDefs = [...(manifest.classes ?? []), ...(manifest.features ?? [])];
  for (const def of objectDefs) localObjects.set(def.local_name, def.local_name);

  for (const def of objectDefs) {
    if (!world.objects.has(def.local_name)) {
      const parent = resolveObjectRef(world, def.parent, localObjects, localSeeds, existing);
      world.createObject({ id: def.local_name, name: def.local_name, parent, owner: actor });
    }
    setDescriptionIfEmpty(world, def.local_name, catalogDescription(def.description, def.local_name, manifest.name));
    for (const property of def.properties ?? []) installProperty(world, def.local_name, property, actor);
    for (const verb of def.verbs ?? []) installVerbDef(world, def.local_name, verb, actor, allowImplementationHints, true);
  }
  for (const schema of manifest.schemas ?? []) {
    if (world.objects.has(schema.on)) world.defineEventSchema(schema.on, schema.type, schema.shape);
  }
  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind === "create_instance") {
      const id = hook.as;
      if (!world.objects.has(id)) {
        const parent = resolveObjectRef(world, hook.class, localObjects, localSeeds, existing);
        const anchor = hook.anchor ? resolveObjectRef(world, hook.anchor, localObjects, localSeeds, existing) : null;
        const location = hook.location ? resolveObjectRef(world, hook.location, localObjects, localSeeds, existing) : null;
        world.createObject({ id, name: hook.name ?? id, parent, owner: actor, anchor, location });
      } else if (reconcileSeedHooks) {
        reconcileSeedObject(world, id, hook, manifest, actor, localObjects, localSeeds, existing, rehomeNowhereSeedObjects);
      }
      localSeeds.set(hook.as, id);
      setDescriptionIfEmpty(world, id, catalogDescription(hook.description, hook.name ?? id, manifest.name));
      setNameIfMissing(world, id, hook.name ?? id);
      for (const [name, value] of Object.entries(hook.properties ?? {})) setPropIfMissing(world, id, name, value);
      continue;
    }
    if (world.objects.has(hook.consumer) && world.objects.has(hook.feature)) attachFeature(world, hook.consumer, hook.feature);
  }
}

function reconcileSeedObject(
  world: WooWorld,
  id: ObjRef,
  hook: Extract<CatalogSeedHook, { kind: "create_instance" }>,
  manifest: CatalogManifest,
  actor: ObjRef,
  localObjects: Map<string, ObjRef>,
  localSeeds: Map<string, ObjRef>,
  existing: InstalledCatalogRecord[],
  rehomeNowhereSeedObjects: boolean
): void {
  const obj = world.object(id);
  const parent = resolveObjectRef(world, hook.class, localObjects, localSeeds, existing);
  const anchor = hook.anchor ? resolveObjectRef(world, hook.anchor, localObjects, localSeeds, existing) : null;
  const location = hook.location ? resolveObjectRef(world, hook.location, localObjects, localSeeds, existing) : null;
  if (obj.parent !== parent) {
    if (obj.parent && world.objects.has(obj.parent)) world.object(obj.parent).children.delete(id);
    obj.parent = parent;
    world.object(parent).children.add(id);
  }
  if (obj.owner !== actor) obj.owner = actor;
  obj.anchor = anchor;
  if (hook.name) {
    obj.name = hook.name;
    world.setProp(id, "name", hook.name);
  }
  if (hook.description) world.setProp(id, "description", catalogDescription(hook.description, hook.name ?? id, manifest.name));
  for (const [name, value] of Object.entries(hook.properties ?? {})) {
    if (DYNAMIC_SEED_PROPERTIES.has(name) && obj.properties.has(name)) continue;
    world.setProp(id, name, value);
  }
  const strandedInNowhere = rehomeNowhereSeedObjects && obj.location === "$nowhere" && location !== null && location !== "$nowhere";
  if (obj.location !== location && (!obj.location || !world.objects.has(obj.location) || strandedInNowhere)) {
    if (obj.location && world.objects.has(obj.location)) world.object(obj.location).contents.delete(id);
    obj.location = location;
    if (location && world.objects.has(location)) world.object(location).contents.add(id);
  } else if (obj.location && world.objects.has(obj.location)) {
    world.object(obj.location).contents.add(id);
  }
  obj.modified = Date.now();
  world.persist(true);
}

function installProperty(world: WooWorld, obj: ObjRef, property: CatalogPropertyDef, owner: ObjRef): void {
  const target = world.object(obj);
  if (target.propertyDefs.has(property.name)) return;
  world.defineProperty(obj, {
    name: property.name,
    defaultValue: property.default ?? null,
    typeHint: property.type,
    owner,
    perms: property.perms ?? "rw"
  });
}

function installVerbDef(world: WooWorld, obj: ObjRef, def: CatalogVerbDef, owner: ObjRef, allowImplementationHints: boolean, repairExisting: boolean): void {
  const target = world.object(obj);
  const existing = target.verbs.get(def.name);
  if (existing) {
    if (!repairExisting) {
      const parsedPerms = normalizeVerbPerms(def.perms ?? existing.perms, existing.direct_callable || def.direct_callable === true);
      const next = {
        ...existing,
        perms: parsedPerms.perms,
        direct_callable: parsedPerms.directCallable,
        skip_presence_check: existing.skip_presence_check || def.skip_presence_check === true,
        tool_exposed: existing.tool_exposed || def.tool_exposed === true
      };
      if (
        next.perms !== existing.perms ||
        next.direct_callable !== existing.direct_callable ||
        next.skip_presence_check !== existing.skip_presence_check ||
        next.tool_exposed !== existing.tool_exposed
      ) world.addVerb(obj, next);
      return;
    }
    const repaired = compileCatalogVerbDef(obj, def, owner, existing.version + 1, allowImplementationHints);
    const changed =
      existing.kind !== repaired.kind ||
      (existing.kind === "native" && repaired.kind === "native" && existing.native !== repaired.native) ||
      existing.source !== repaired.source ||
      existing.source_hash !== repaired.source_hash ||
      JSON.stringify(existing.aliases ?? []) !== JSON.stringify(repaired.aliases ?? []) ||
      existing.perms !== repaired.perms ||
      JSON.stringify(existing.arg_spec ?? {}) !== JSON.stringify(repaired.arg_spec ?? {}) ||
      existing.direct_callable !== repaired.direct_callable ||
      existing.skip_presence_check !== repaired.skip_presence_check ||
      existing.tool_exposed !== repaired.tool_exposed ||
      Object.keys(existing.line_map ?? {}).length === 0;
    if (changed) world.addVerb(obj, repaired);
    return;
  }

  world.addVerb(obj, compileCatalogVerbDef(obj, def, owner, 1, allowImplementationHints));
}

function compileCatalogVerbDef(obj: ObjRef, def: CatalogVerbDef, owner: ObjRef, version: number, allowImplementationHints: boolean): VerbDef {
  const parsedPerms = normalizeVerbPerms(def.perms ?? "rx", def.direct_callable === true);
  const base = {
    name: def.name,
    aliases: def.aliases ?? [],
    owner,
    perms: parsedPerms.perms,
    arg_spec: def.arg_spec ?? {},
    source: def.source,
    source_hash: hashSource(def.source),
    version,
    line_map: {},
    direct_callable: parsedPerms.directCallable,
    skip_presence_check: def.skip_presence_check === true,
    tool_exposed: def.tool_exposed === true
  };

  if (allowImplementationHints && def.implementation?.kind === "native") {
    return { ...base, kind: "native", native: def.implementation.handler };
  }

  if (allowImplementationHints && def.implementation?.kind === "fixture") {
    const bytecode = fixtureByName[def.implementation.name] as TinyBytecode | undefined;
    if (!bytecode) throw wooError("E_CATALOG", `unknown fixture implementation: ${def.implementation.name}`);
    return { ...base, kind: "bytecode", bytecode: { ...bytecode, version } };
  }

  return compileCatalogVerb(obj, def, owner, version);
}

function compileCatalogVerb(obj: ObjRef, def: CatalogVerbDef, owner: ObjRef, version: number): VerbDef {
  const compiled = compileVerb(def.source);
  if (!compiled.ok || !compiled.bytecode) {
    throw wooError("E_CATALOG", `catalog verb failed to compile: ${obj}:${def.name}`, {
      diagnostics: compiled.diagnostics as unknown as WooValue
    });
  }
  const parsedPerms = normalizeVerbPerms(def.perms ?? compiled.metadata?.perms ?? "rx", def.direct_callable === true);
  return {
    kind: "bytecode",
    name: def.name,
    aliases: def.aliases ?? [],
    owner,
    perms: parsedPerms.perms,
    arg_spec: def.arg_spec ?? compiled.metadata?.arg_spec ?? {},
    source: def.source,
    source_hash: compiled.source_hash ?? hashSource(def.source),
    version,
    bytecode: { ...compiled.bytecode, version },
    line_map: compiled.line_map ?? {},
    direct_callable: parsedPerms.directCallable,
    skip_presence_check: def.skip_presence_check === true,
    tool_exposed: def.tool_exposed === true
  };
}

function resolveObjectRef(
  world: WooWorld,
  ref: string,
  localObjects: Map<string, ObjRef>,
  localSeeds: Map<string, ObjRef>,
  installed: InstalledCatalogRecord[]
): ObjRef {
  if (localObjects.has(ref)) return localObjects.get(ref)!;
  if (localSeeds.has(ref)) return localSeeds.get(ref)!;
  if (world.objects.has(ref)) return ref;
  const split = ref.indexOf(":");
  if (split > 0) {
    const alias = ref.slice(0, split);
    const name = ref.slice(split + 1);
    const record = installed.find((item) => item.alias === alias || item.catalog === alias);
    const resolved = name.startsWith("$") ? record?.objects?.[name] : record?.seeds?.[name];
    if (resolved) return resolved;
  }
  throw wooError("E_UNRESOLVED_REFERENCE", `catalog reference could not be resolved: ${ref}`, ref);
}

function attachFeature(world: WooWorld, consumer: ObjRef, feature: ObjRef): void {
  const raw = world.getProp(consumer, "features");
  const features = Array.isArray(raw) ? raw.map((item) => String(item)) : [];
  if (features.includes(feature)) return;
  world.setProp(consumer, "features", [...features, feature]);
  const current = Number(world.getProp(consumer, "features_version") ?? 0);
  world.setProp(consumer, "features_version", Number.isFinite(current) ? current + 1 : 1);
}

function setDescriptionIfEmpty(world: WooWorld, obj: ObjRef, description: string): void {
  const existing = world.propOrNull(obj, "description");
  if (typeof existing === "string" && existing.length > 0) return;
  world.setProp(obj, "description", description);
}

function catalogDescription(description: string | undefined, subject: string, catalog: string): string {
  const text = description?.trim() || `${subject} from the ${catalog} catalog.`;
  if (text.length >= 40) return text;
  return `${text} Installed by the ${catalog} catalog as part of the local demo surface.`;
}

function setPropIfMissing(world: WooWorld, obj: ObjRef, name: string, value: WooValue): void {
  if (world.object(obj).properties.has(name)) return;
  world.setProp(obj, name, value);
}

function setNameIfMissing(world: WooWorld, obj: ObjRef, name: string): void {
  if (!name) return;
  const existing = world.propOrNull(obj, "name");
  if (typeof existing === "string" && existing.length > 0) return;
  world.setProp(obj, "name", name);
}

function assertDependenciesInstalled(manifest: CatalogManifest, installed: InstalledCatalogRecord[]): void {
  for (const dependency of manifest.depends ?? []) {
    const name = dependency.startsWith("@local:") ? dependency.slice("@local:".length) : dependency;
    const ok = installed.some((record) => record.alias === name || record.catalog === name || `${record.tap}:${record.catalog}` === dependency);
    if (!ok) {
      const installedNames = installed.map((record) => record.alias || record.catalog).filter(Boolean);
      throw wooError(
        "E_DEPENDENCY",
        `catalog dependency is not installed: ${dependency}; installed catalogs: ${installedNames.length ? installedNames.join(", ") : "(none)"}`,
        { dependency, installed: installedNames }
      );
    }
  }
}

function installedCatalogs(world: WooWorld): InstalledCatalogRecord[] {
  if (!world.objects.has("$catalog_registry")) return [];
  const raw = world.propOrNull("$catalog_registry", "installed_catalogs");
  return Array.isArray(raw) ? (raw as unknown as InstalledCatalogRecord[]) : [];
}

function recordCatalogInstall(world: WooWorld, record: InstalledCatalogRecord): void {
  const id = `catalog_${record.alias.replace(/[^A-Za-z0-9_]/g, "_")}`;
  if (world.objects.has("$catalog")) {
    world.createObject({ id, name: record.alias, parent: "$catalog", owner: record.owner });
    setDescriptionIfEmpty(world, id, `Installed catalog record for ${record.alias}. It records provenance, version, created class objects, and seeded instances for local introspection.`);
    world.setProp(id, "catalog_name", record.catalog);
    world.setProp(id, "alias", record.alias);
    world.setProp(id, "version", record.version);
    world.setProp(id, "tap", record.tap);
    world.setProp(id, "objects", record.objects as unknown as WooValue);
    world.setProp(id, "seeds", record.seeds as unknown as WooValue);
    world.setProp(id, "provenance", record.provenance);
  }

  if (!world.objects.has("$catalog_registry")) return;
  const records = installedCatalogs(world);
  const next = [...records.filter((item) => item.alias !== record.alias), record];
  world.setProp("$catalog_registry", "installed_catalogs", next as unknown as WooValue);
}
