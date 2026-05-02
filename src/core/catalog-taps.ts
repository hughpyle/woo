import type { CatalogManifest, CatalogMigrationManifest, InstalledCatalogRecord } from "./catalog-installer";
import { wooError, type AppliedFrame, type Message, type ObjRef, type WooValue } from "./types";
import type { WooWorld } from "./world";

const MAX_TAP_FETCHES = 8;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_README_BYTES = 512 * 1024;
const MAX_MIGRATION_BYTES = 256 * 1024;

type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export type TapHashText = (text: string) => string | Promise<string>;

export type CatalogTapLogEvent =
  | {
      kind: "tap_fetch";
      tap: string;
      catalog: string;
      alias: string;
      ref_requested: string;
      ref_resolved_sha: string;
      manifest_hash: string;
      readme_hash: string;
      manifest_bytes: number;
      readme_bytes: number;
      subrequests: number;
    }
  | {
      kind: "tap_migration_fetch";
      tap: string;
      catalog: string;
      alias: string;
      ref_resolved_sha: string;
      from_major: number;
      to_major: number;
      migration_hash: string;
      migration_bytes: number;
      subrequests: number;
    }
  | {
      kind: "tap_install" | "tap_update";
      tap: string;
      catalog: string;
      alias: string;
      version: string;
      ref_resolved_sha: string;
      seq: number;
      subrequests: number;
    };

export type GitHubTapInstallRequest = {
  tap: string;
  catalog: string;
  ref?: string;
  as?: string;
};

export type GitHubTapUpdateRequest = GitHubTapInstallRequest & {
  accept_major?: boolean;
};

export type LoadedGitHubCatalog = {
  manifest: CatalogManifest;
  frontmatter: Record<string, WooValue>;
  alias: string;
  provenance: Record<string, WooValue>;
  baseUrl: string;
  fetcher: FetchLike;
  loadContext: TapLoadContext;
};

type LoadOptions = {
  fetch?: FetchLike;
  now?: () => number;
  hashText?: TapHashText;
  log?: (event: CatalogTapLogEvent) => void;
  maxFetches?: number;
};

type GitHubCommit = { sha?: unknown };
type GitHubTag = { name?: unknown };
type TapLoadContext = {
  fetcher: FetchLike;
  fetchCount: number;
  maxFetches: number;
  hashText: TapHashText;
};

export async function loadGitHubCatalog(request: GitHubTapInstallRequest, options: LoadOptions = {}): Promise<LoadedGitHubCatalog> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw wooError("E_NOTAPPLICABLE", "fetch is not available in this runtime");
  const loadContext: TapLoadContext = {
    fetcher,
    fetchCount: 0,
    maxFetches: options.maxFetches ?? MAX_TAP_FETCHES,
    hashText: options.hashText ?? defaultHashText
  };
  const now = options.now ?? Date.now;
  const tap = normalizeTap(request.tap);
  const catalog = normalizeCatalogName(request.catalog);
  const alias = normalizeAlias(request.as ?? catalog);
  const refRequested = normalizeRef(request.ref);
  const refToResolve = refRequested ?? await defaultRef(loadContext, tap, catalog);
  const resolvedSha = await resolveCommitSha(loadContext, tap, refToResolve);
  const base = `https://raw.githubusercontent.com/${tap}/${resolvedSha}/catalogs/${encodeURIComponent(catalog)}`;
  const [manifestText, readmeText] = await Promise.all([
    fetchLimitedText(loadContext, `${base}/manifest.json`, "manifest.json", MAX_MANIFEST_BYTES),
    fetchLimitedText(loadContext, `${base}/README.md`, "README.md", MAX_README_BYTES)
  ]);
  const manifest = parseManifest(manifestText);
  if (manifest.name !== catalog) throw wooError("E_CATALOG", `manifest name ${manifest.name} does not match requested catalog ${catalog}`);
  const frontmatter = parseFrontmatter(readmeText);
  validateFrontmatter(frontmatter, manifest);
  const [manifestHash, readmeHash] = await Promise.all([
    hashWithPrefix(loadContext.hashText, manifestText),
    hashWithPrefix(loadContext.hashText, readmeText)
  ]);
  const provenance: Record<string, WooValue> = {
    tap,
    catalog,
    alias,
    ref_requested: refRequested ?? refToResolve,
    ref_resolved_sha: resolvedSha,
    manifest_hash: manifestHash,
    readme_hash: readmeHash,
    fetched_at: now()
  };
  emitTapLog(options, {
    kind: "tap_fetch",
    tap,
    catalog,
    alias,
    ref_requested: String(provenance.ref_requested),
    ref_resolved_sha: resolvedSha,
    manifest_hash: manifestHash,
    readme_hash: readmeHash,
    manifest_bytes: byteLength(manifestText),
    readme_bytes: byteLength(readmeText),
    subrequests: loadContext.fetchCount
  });
  return { manifest, frontmatter, alias, provenance, baseUrl: base, fetcher, loadContext };
}

export async function installGitHubTap(
  world: WooWorld,
  actor: ObjRef,
  request: GitHubTapInstallRequest,
  options: LoadOptions = {}
): Promise<AppliedFrame> {
  if (!world.object(actor).flags.wizard) throw wooError("E_PERM", "only wizards may install catalogs", actor);
  const loaded = await loadGitHubCatalog(request, options);
  const existing = installedCatalog(world, loaded.alias, String(loaded.provenance.tap), loaded.manifest.name);
  if (existing && existing.version === loaded.manifest.version && sameInstallProvenance(existing.provenance, loaded.provenance)) {
    throw wooError("E_CATALOG_ALREADY_INSTALLED", `catalog is already installed at this version: ${loaded.alias}`, {
      alias: loaded.alias,
      tap: loaded.provenance.tap,
      catalog: loaded.manifest.name,
      version: loaded.manifest.version
    });
  }
  const message: Message = {
    actor,
    target: "$catalog_registry",
    verb: "install",
    args: [loaded.manifest as unknown as WooValue, loaded.frontmatter as WooValue, loaded.alias, loaded.provenance]
  };
  const frame = await world.applyCall(undefined, "$catalog_registry", message);
  emitTapLog(options, {
    kind: "tap_install",
    tap: String(loaded.provenance.tap),
    catalog: loaded.manifest.name,
    alias: loaded.alias,
    version: loaded.manifest.version,
    ref_resolved_sha: String(loaded.provenance.ref_resolved_sha),
    seq: frame.seq,
    subrequests: loaded.loadContext.fetchCount
  });
  return frame;
}

export async function updateGitHubTap(
  world: WooWorld,
  actor: ObjRef,
  request: GitHubTapUpdateRequest,
  options: LoadOptions = {}
): Promise<AppliedFrame> {
  if (!world.object(actor).flags.wizard) throw wooError("E_PERM", "only wizards may update catalogs", actor);
  const loaded = await loadGitHubCatalog(request, options);
  const current = installedCatalog(world, loaded.alias, loaded.provenance.tap as string, loaded.manifest.name);
  if (!current) throw wooError("E_CATALOG", `catalog is not installed: ${loaded.alias}`, loaded.alias);
  const currentMajor = majorVersion(current.version);
  const nextMajor = majorVersion(loaded.manifest.version);
  let migration: CatalogMigrationManifest | null = null;
  let provenance = loaded.provenance;
  if (currentMajor !== nextMajor) {
    if (request.accept_major !== true) {
      throw wooError("E_CATALOG", `catalog major update requires accept_major: true: ${current.version} -> ${loaded.manifest.version}`, {
        from: current.version,
        to: loaded.manifest.version
      });
    }
    const migrationText = await fetchLimitedText(loaded.loadContext, `${loaded.baseUrl}/migration-v${currentMajor}-to-v${nextMajor}.json`, `migration-v${currentMajor}-to-v${nextMajor}.json`, MAX_MIGRATION_BYTES);
    migration = parseMigration(migrationText);
    const migrationHash = await hashWithPrefix(loaded.loadContext.hashText, migrationText);
    provenance = { ...loaded.provenance, migration_hash: migrationHash };
    emitTapLog(options, {
      kind: "tap_migration_fetch",
      tap: String(loaded.provenance.tap),
      catalog: loaded.manifest.name,
      alias: loaded.alias,
      ref_resolved_sha: String(loaded.provenance.ref_resolved_sha),
      from_major: currentMajor,
      to_major: nextMajor,
      migration_hash: migrationHash,
      migration_bytes: byteLength(migrationText),
      subrequests: loaded.loadContext.fetchCount
    });
  }
  const message: Message = {
    actor,
    target: "$catalog_registry",
    verb: "update",
    args: [
      loaded.manifest as unknown as WooValue,
      loaded.frontmatter as WooValue,
      loaded.alias,
      provenance,
      { accept_major: request.accept_major === true },
      migration as unknown as WooValue
    ]
  };
  const frame = await world.applyCall(undefined, "$catalog_registry", message);
  emitTapLog(options, {
    kind: "tap_update",
    tap: String(provenance.tap),
    catalog: loaded.manifest.name,
    alias: loaded.alias,
    version: loaded.manifest.version,
    ref_resolved_sha: String(provenance.ref_resolved_sha),
    seq: frame.seq,
    subrequests: loaded.loadContext.fetchCount
  });
  return frame;
}

export function parseFrontmatter(markdown: string): Record<string, WooValue> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) throw wooError("E_CATALOG", "catalog README.md is missing YAML frontmatter");
  const result: Record<string, WooValue> = {};
  let currentList: string | null = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") continue;
    const listItem = /^\s*-\s+(.+)$/.exec(line);
    if (listItem && currentList) {
      const existing = result[currentList];
      if (Array.isArray(existing)) existing.push(parseScalar(listItem[1]));
      continue;
    }
    const field = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!field) throw wooError("E_CATALOG", `unsupported README frontmatter line: ${rawLine}`);
    const [, key, value] = field;
    if (value === "") {
      result[key] = [];
      currentList = key;
    } else {
      result[key] = parseScalar(value);
      currentList = null;
    }
  }
  return result;
}

function parseScalar(value: string): WooValue {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

async function defaultRef(ctx: TapLoadContext, tap: string, catalog: string): Promise<string> {
  const tags = await fetchJson(ctx, `https://api.github.com/repos/${tap}/tags?per_page=100`);
  if (!Array.isArray(tags)) return "main";
  const prefix = `${catalog}-v`;
  const candidates = tags
    .map((tag): string | null => {
      const name = (tag as GitHubTag).name;
      return typeof name === "string" && name.startsWith(prefix) ? name : null;
    })
    .filter((name): name is string => Boolean(name))
    .sort(compareCatalogTags);
  return candidates[candidates.length - 1] ?? "main";
}

function compareCatalogTags(a: string, b: string): number {
  const av = semverParts(a);
  const bv = semverParts(b);
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] - bv[i];
  }
  return a.localeCompare(b);
}

function semverParts(tag: string): [number, number, number] {
  const match = /-v(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

async function resolveCommitSha(ctx: TapLoadContext, tap: string, ref: string): Promise<string> {
  const commit = await fetchJson(ctx, `https://api.github.com/repos/${tap}/commits/${encodeURIComponent(ref)}`);
  const sha = (commit as GitHubCommit).sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw wooError("E_CATALOG", `GitHub did not return a commit SHA for ${tap}@${ref}`);
  }
  return sha.toLowerCase();
}

async function fetchLimitedText(ctx: TapLoadContext, url: string, label: string, maxBytes: number): Promise<string> {
  const response = await fetchChecked(ctx, url);
  if (!response.ok) throw wooError("E_NOTFOUND", `GitHub fetch failed ${response.status}: ${url}`);
  const declared = Number(response.headers?.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw wooError("E_RATE", `${label} exceeds ${maxBytes} bytes`);
  const text = await response.text();
  const actual = byteLength(text);
  if (actual > maxBytes) throw wooError("E_RATE", `${label} exceeds ${maxBytes} bytes`);
  return text;
}

async function fetchJson(ctx: TapLoadContext, url: string): Promise<unknown> {
  const response = await fetchChecked(ctx, url);
  if (!response.ok) throw wooError("E_NOTFOUND", `GitHub API fetch failed ${response.status}: ${url}`);
  return response.json();
}

async function fetchChecked(ctx: TapLoadContext, url: string): Promise<Awaited<ReturnType<FetchLike>>> {
  ctx.fetchCount += 1;
  if (ctx.fetchCount > ctx.maxFetches) throw wooError("E_RATE", `catalog tap fetch exceeded ${ctx.maxFetches} subrequests`);
  return await ctx.fetcher(url, { headers: githubHeaders() });
}

function githubHeaders(): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "woo-catalog-installer"
  };
}

function parseManifest(text: string): CatalogManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw wooError("E_CATALOG", `catalog manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw wooError("E_CATALOG", "catalog manifest must be an object");
  const manifest = parsed as CatalogManifest;
  for (const field of ["name", "version", "spec_version"] as const) {
    if (typeof manifest[field] !== "string" || manifest[field].trim() === "") throw wooError("E_CATALOG", `catalog manifest missing ${field}`);
  }
  return manifest;
}

function parseMigration(text: string): CatalogMigrationManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw wooError("E_CATALOG", `catalog migration is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw wooError("E_CATALOG", "catalog migration must be an object");
  const migration = parsed as CatalogMigrationManifest;
  for (const field of ["from_version", "to_version", "spec_version"] as const) {
    if (typeof migration[field] !== "string" || migration[field].trim() === "") throw wooError("E_CATALOG", `catalog migration missing ${field}`);
  }
  if (!Array.isArray(migration.steps)) throw wooError("E_CATALOG", "catalog migration missing steps");
  return migration;
}

function validateFrontmatter(frontmatter: Record<string, WooValue>, manifest: CatalogManifest): void {
  for (const field of ["name", "version", "spec_version", "license"]) {
    if (typeof frontmatter[field] !== "string" || String(frontmatter[field]).trim() === "") {
      throw wooError("E_CATALOG", `catalog README frontmatter missing ${field}`);
    }
  }
  if (!isSemver(String(frontmatter.version)) || !isSemver(manifest.version)) {
    throw wooError("E_CATALOG", "catalog version must be semver major.minor.patch", { frontmatter: frontmatter.version, manifest: manifest.version });
  }
  for (const field of ["name", "version", "spec_version"] as const) {
    if (frontmatter[field] !== manifest[field]) throw wooError("E_CATALOG", `README frontmatter ${field} does not match manifest`);
  }
}

function isSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function majorVersion(value: string): number {
  const match = /^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) throw wooError("E_CATALOG", `catalog version must be semver major.minor.patch: ${value}`);
  return Number(match[1]);
}

function installedCatalog(world: WooWorld, alias: string, tap: string, catalog: string): InstalledCatalogRecord | null {
  const raw = world.propOrNull("$catalog_registry", "installed_catalogs");
  if (!Array.isArray(raw)) return null;
  return (raw as unknown as InstalledCatalogRecord[]).find((record) => record.alias === alias || (record.tap === tap && record.catalog === catalog)) ?? null;
}

function sameInstallProvenance(left: Record<string, WooValue>, right: Record<string, WooValue>): boolean {
  return (
    left.ref_resolved_sha === right.ref_resolved_sha &&
    left.manifest_hash === right.manifest_hash &&
    left.readme_hash === right.readme_hash
  );
}

function normalizeTap(value: string): string {
  const tap = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(tap)) throw wooError("E_INVARG", "tap must be GitHub owner/repo");
  return tap;
}

function normalizeCatalogName(value: string): string {
  const catalog = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(catalog)) throw wooError("E_INVARG", "catalog name contains unsupported characters");
  return catalog;
}

function normalizeAlias(value: string): string {
  const alias = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(alias)) throw wooError("E_INVARG", "catalog alias contains unsupported characters");
  return alias;
}

function normalizeRef(value: string | undefined): string | undefined {
  const ref = value?.trim();
  if (!ref) return undefined;
  if (ref.includes("..") || ref.startsWith("/") || ref.endsWith("/") || /[\s~^:?*[\\]/.test(ref)) {
    throw wooError("E_INVARG", "git ref contains unsupported characters");
  }
  return ref;
}

async function hashWithPrefix(hashText: TapHashText, text: string): Promise<string> {
  const value = await hashText(text);
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

async function defaultHashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function emitTapLog(options: LoadOptions, event: CatalogTapLogEvent): void {
  try {
    options.log?.(event);
  } catch {
    // Catalog logging is diagnostic only; install/update semantics must not
    // depend on the log sink.
  }
}
