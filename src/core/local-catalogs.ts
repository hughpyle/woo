import { BUNDLED_CATALOGS } from "../generated/bundled-catalogs";
import { installCatalogManifest, repairCatalogManifest, type CatalogManifest } from "./catalog-installer";
import { wooError, type Message, type WooValue } from "./types";
import type { WooWorld } from "./world";

export type LocalCatalogName = string;

const LOCAL_CATALOGS = new Map(BUNDLED_CATALOGS.map((entry) => [entry.manifest.name, entry.manifest] as const));
const LOCAL_CATALOG_SOURCE_MIGRATION = "2026-04-30-source-catalog-verbs";
const LOCAL_CATALOG_PLACEMENT_MIGRATION = "2026-04-30-catalog-placement-metadata";
const LOCAL_CATALOG_CHAT_COCKATOO_MIGRATION = "2026-04-30-chat-cockatoo";

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
  // Boot auto-install is idempotent: the first install is sequenced through
  // $catalog_registry, while later boot passes skip without adding no-op log rows.
  if (localCatalogInstalled(world, name)) return;
  const manifest = LOCAL_CATALOGS.get(name)!;
  const provenance: Record<string, WooValue> = {
    tap: "@local",
    catalog: name,
    alias: name,
    ref_requested: "@local",
    ref_resolved_sha: "unversioned"
  };
  if (!world.objects.has("$catalog_registry") || !world.object("$catalog_registry").verbs.has("install")) {
    installCatalogManifest(world, manifest, { tap: "@local", alias: name, actor: "$wiz", provenance });
    return;
  }
  const message: Message = {
    actor: "$wiz",
    target: "$catalog_registry",
    verb: "install",
    args: [manifest as unknown as WooValue, {}, name, provenance]
  };
  const frame = world.applyCall(undefined, "$catalog_registry", message);
  const errorObservation = frame.observations.find((observation) => observation.type === "$error");
  if (errorObservation) {
    throw wooError(String(errorObservation.code ?? "E_CATALOG"), String(errorObservation.message ?? "catalog install failed"), errorObservation as unknown as WooValue);
  }
}

function runLocalCatalogMigrations(world: WooWorld, names: readonly string[]): void {
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_SOURCE_MIGRATION);
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PLACEMENT_MIGRATION);
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_COCKATOO_MIGRATION);
}

function runLocalCatalogMigration(world: WooWorld, names: readonly string[], id: string): void {
  if (migrationApplied(world, id)) return;
  for (const name of names) {
    if (!localCatalogInstalled(world, name)) continue;
    repairCatalogManifest(world, LOCAL_CATALOGS.get(name)!, { actor: "$wiz" });
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
