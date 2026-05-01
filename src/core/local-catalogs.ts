import { BUNDLED_CATALOGS } from "../generated/bundled-catalogs";
import { installCatalogManifest, repairCatalogManifest, type CatalogManifest } from "./catalog-installer";
import type { WooValue } from "./types";
import type { WooWorld } from "./world";

export type LocalCatalogName = string;

const LOCAL_CATALOGS = new Map(BUNDLED_CATALOGS.map((entry) => [entry.manifest.name, entry.manifest] as const));
const LOCAL_CATALOG_SOURCE_MIGRATION = "2026-04-30-source-catalog-verbs";
const LOCAL_CATALOG_PLACEMENT_MIGRATION = "2026-04-30-catalog-placement-metadata";
const LOCAL_CATALOG_CHAT_COCKATOO_MIGRATION = "2026-04-30-chat-cockatoo";
const LOCAL_CATALOG_CHAT_LOOK_CONTENTS_MIGRATION = "2026-04-30-chat-look-contents";
const LOCAL_CATALOG_CHAT_COMMAND_PARSER_MIGRATION = "2026-04-30-chat-command-parser";
const LOCAL_CATALOG_DUBSPACE_CONTROL_GUARDS_MIGRATION = "2026-04-30-dubspace-control-guards";
const LOCAL_CATALOG_DUBSPACE_MOUNTED_CONTROLS_MIGRATION = "2026-05-01-dubspace-mounted-controls";
const LOCAL_CATALOG_ROOM_LOOK_SELF_MIGRATION = "2026-04-30-room-look-self";
const LOCAL_CATALOG_CHAT_THREE_ROOM_MIGRATION = "2026-05-01-chat-three-room-demo";
const LOCAL_CATALOG_CHAT_OBSERVATION_OUTPUT_MIGRATION = "2026-05-01-chat-observation-output";
const LOCAL_CATALOG_CHAT_ROOM_CONTENTS_REPAIR_MIGRATION = "2026-05-01-chat-room-contents-repair";
const LOCAL_CATALOG_AGENT_TOOL_EXPOSURE_REPAIR_MIGRATION = "2026-05-01-agent-tool-exposure-repair";
const LOCAL_CATALOG_CHAT_NAVIGATION_TOOL_EXPOSURE_MIGRATION = "2026-05-01-chat-navigation-tool-exposure";
const LOCAL_CATALOG_COCKATOO_TOOL_EXPOSURE_MIGRATION = "2026-05-01-cockatoo-tool-exposure";
const LOCAL_CATALOG_CHAT_NOWHERE_PORTABLES_REPAIR_MIGRATION = "2026-05-01-chat-nowhere-portables-repair";
const LOCAL_CATALOG_TASKSPACE_VERBS_REPAIR_MIGRATION = "2026-05-01-taskspace-verbs-repair";
const LOCAL_CATALOG_PINBOARD_LOOK_OBSERVATION_MIGRATION = "2026-05-01-pinboard-look-observation";
const LOCAL_CATALOG_PINBOARD_ACTIVITY_TEXT_MIGRATION = "2026-05-01-pinboard-activity-text";
const LOCAL_CATALOG_PINBOARD_VIEWPORT_PRESENCE_MIGRATION = "2026-05-01-pinboard-viewport-presence";
const LOCAL_CATALOG_PINBOARD_FREE_COORDS_MIGRATION = "2026-05-01-pinboard-free-coordinates";
const LOCAL_CATALOG_DUBSPACE_SOURCE_PRESENCE_MIGRATION = "2026-05-01-dubspace-source-presence";
const LOCAL_CATALOG_PINBOARD_SOURCE_PRESENCE_MIGRATION = "2026-05-01-pinboard-source-presence";

export const DEFAULT_LOCAL_CATALOGS = bundledCatalogAliases();

export function bundledCatalogAliases(): string[] {
  return sortCatalogNames(Array.from(LOCAL_CATALOGS.keys()));
}

export function parseAutoInstallCatalogs(value: string | undefined): string[] {
  if (value === undefined) return bundledCatalogAliases();
  if (value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function installLocalCatalogs(world: WooWorld, names: readonly string[] = DEFAULT_LOCAL_CATALOGS): void {
  const sorted = sortCatalogNames(names);
  for (const name of sorted) installLocalCatalog(world, name);
  runLocalCatalogMigrations(world, sorted);
}

export function installLocalCatalog(world: WooWorld, name: string): void {
  if (!isLocalCatalogName(name)) throw new Error(`unknown local catalog: ${name}`);
  // Boot auto-install is part of deterministic world construction, not a user
  // catalog operation. Runtime installs still go through $catalog_registry.
  if (localCatalogInstalled(world, name)) return;
  const manifest = LOCAL_CATALOGS.get(name)!;
  const provenance: Record<string, WooValue> = {
    tap: "@local",
    catalog: name,
    alias: name,
    ref_requested: "@local",
    ref_resolved_sha: "unversioned"
  };
  installCatalogManifest(world, manifest, { tap: "@local", alias: name, actor: "$wiz", provenance });
}

function runLocalCatalogMigrations(world: WooWorld, names: readonly string[]): void {
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_SOURCE_MIGRATION);
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PLACEMENT_MIGRATION);
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_COCKATOO_MIGRATION);
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_LOOK_CONTENTS_MIGRATION);
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_COMMAND_PARSER_MIGRATION, { allowImplementationHints: true });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_DUBSPACE_CONTROL_GUARDS_MIGRATION, { allowImplementationHints: true });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_DUBSPACE_MOUNTED_CONTROLS_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, only: "dubspace" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_ROOM_LOOK_SELF_MIGRATION, { allowImplementationHints: true });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_THREE_ROOM_MIGRATION, { allowImplementationHints: true });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_OBSERVATION_OUTPUT_MIGRATION, { allowImplementationHints: true });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_ROOM_CONTENTS_REPAIR_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, only: "chat" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_AGENT_TOOL_EXPOSURE_REPAIR_MIGRATION, { allowImplementationHints: true });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_NAVIGATION_TOOL_EXPOSURE_MIGRATION, { allowImplementationHints: true, only: "chat" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_COCKATOO_TOOL_EXPOSURE_MIGRATION, { allowImplementationHints: true, only: "chat" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_NOWHERE_PORTABLES_REPAIR_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, rehomeNowhereSeedObjects: true, only: "chat" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_TASKSPACE_VERBS_REPAIR_MIGRATION, { allowImplementationHints: true, only: "taskspace" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PINBOARD_LOOK_OBSERVATION_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PINBOARD_ACTIVITY_TEXT_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PINBOARD_VIEWPORT_PRESENCE_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PINBOARD_FREE_COORDS_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_DUBSPACE_SOURCE_PRESENCE_MIGRATION, { allowImplementationHints: true, only: "dubspace" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PINBOARD_SOURCE_PRESENCE_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
}

function runLocalCatalogMigration(world: WooWorld, names: readonly string[], id: string, options: { allowImplementationHints?: boolean; reconcileSeedHooks?: boolean; rehomeNowhereSeedObjects?: boolean; only?: string } = {}): void {
  if (migrationApplied(world, id)) return;
  for (const name of names) {
    if (options.only && name !== options.only) continue;
    if (!localCatalogInstalled(world, name)) continue;
    repairCatalogManifest(world, LOCAL_CATALOGS.get(name)!, {
      actor: "$wiz",
      allowImplementationHints: options.allowImplementationHints,
      reconcileSeedHooks: options.reconcileSeedHooks,
      rehomeNowhereSeedObjects: options.rehomeNowhereSeedObjects
    });
  }
  markMigrationApplied(world, id);
}

function isLocalCatalogName(name: string): name is LocalCatalogName {
  return LOCAL_CATALOGS.has(name);
}

function sortCatalogNames(names: readonly string[]): string[] {
  const selected = new Set(names);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: string[] = [];

  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`local catalog dependency cycle at ${name}`);
    const manifest = LOCAL_CATALOGS.get(name);
    if (!manifest) throw new Error(`unknown local catalog: ${name}`);
    visiting.add(name);
    for (const dependency of manifest.depends ?? []) {
      const dependencyName = localDependencyName(dependency);
      if (selected.has(dependencyName)) visit(dependencyName);
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(name);
  };

  for (const name of names) visit(name);
  return sorted;
}

function localDependencyName(dependency: string): string {
  return dependency.startsWith("@local:") ? dependency.slice("@local:".length) : dependency;
}

function localCatalogInstalled(world: WooWorld, name: string): boolean {
  if (!world.objects.has("$catalog_registry")) return false;
  const raw = world.propOrNull("$catalog_registry", "installed_catalogs");
  return Array.isArray(raw) && raw.some((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const item = record as Record<string, WooValue>;
    return item.alias === name || item.catalog === name;
  });
}

function migrationApplied(world: WooWorld, id: string): boolean {
  if (!world.objects.has("$system")) return false;
  const raw = world.propOrNull("$system", "applied_migrations");
  return Array.isArray(raw) && raw.includes(id);
}

function markMigrationApplied(world: WooWorld, id: string): void {
  if (!world.objects.has("$system")) return;
  const raw = world.propOrNull("$system", "applied_migrations");
  const migrations = Array.isArray(raw) ? raw.map(String) : [];
  if (!migrations.includes(id)) world.setProp("$system", "applied_migrations", [...migrations, id]);
}
