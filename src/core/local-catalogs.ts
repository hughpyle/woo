import chatManifest from "../../catalogs/chat/manifest.json";
import dubspaceManifest from "../../catalogs/dubspace/manifest.json";
import taskspaceManifest from "../../catalogs/taskspace/manifest.json";
import { installCatalogManifest, type CatalogManifest } from "./catalog-installer";
import { wooError, type Message, type WooValue } from "./types";
import type { WooWorld } from "./world";

export const DEFAULT_LOCAL_CATALOGS = ["chat", "taskspace", "dubspace"] as const;
export type LocalCatalogName = (typeof DEFAULT_LOCAL_CATALOGS)[number];

const LOCAL_CATALOGS: Record<LocalCatalogName, CatalogManifest> = {
  chat: chatManifest as unknown as CatalogManifest,
  taskspace: taskspaceManifest as unknown as CatalogManifest,
  dubspace: dubspaceManifest as unknown as CatalogManifest
};

export function parseAutoInstallCatalogs(value: string | undefined): string[] {
  if (value === undefined) return [...DEFAULT_LOCAL_CATALOGS];
  if (value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function installLocalCatalogs(world: WooWorld, names: readonly string[] = DEFAULT_LOCAL_CATALOGS): void {
  for (const name of names) installLocalCatalog(world, name);
}

export function installLocalCatalog(world: WooWorld, name: string): void {
  if (!isLocalCatalogName(name)) throw new Error(`unknown local catalog: ${name}`);
  // Boot auto-install is idempotent: the first install is sequenced through
  // $catalog_registry, while later boot passes skip without adding no-op log rows.
  if (localCatalogInstalled(world, name)) return;
  const manifest = LOCAL_CATALOGS[name];
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

function isLocalCatalogName(name: string): name is LocalCatalogName {
  return Object.prototype.hasOwnProperty.call(LOCAL_CATALOGS, name);
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
