import { createHash } from "node:crypto";
import type { CatalogManifest } from "../core/catalog-installer";
import { wooError, type AppliedFrame, type Message, type ObjRef, type WooValue } from "../core/types";
import type { WooWorld } from "../core/world";

type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export type GitHubTapInstallRequest = {
  tap: string;
  catalog: string;
  ref?: string;
  as?: string;
};

export type LoadedGitHubCatalog = {
  manifest: CatalogManifest;
  frontmatter: Record<string, WooValue>;
  alias: string;
  provenance: Record<string, WooValue>;
};

type LoadOptions = {
  fetch?: FetchLike;
  now?: () => number;
};

type GitHubCommit = { sha?: unknown };
type GitHubTag = { name?: unknown };

export async function loadGitHubCatalog(request: GitHubTapInstallRequest, options: LoadOptions = {}): Promise<LoadedGitHubCatalog> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw wooError("E_NOTAPPLICABLE", "fetch is not available in this runtime");
  const now = options.now ?? Date.now;
  const tap = normalizeTap(request.tap);
  const catalog = normalizeCatalogName(request.catalog);
  const alias = normalizeAlias(request.as ?? catalog);
  const refRequested = normalizeRef(request.ref);
  const refToResolve = refRequested ?? await defaultRef(fetcher, tap, catalog);
  const resolvedSha = await resolveCommitSha(fetcher, tap, refToResolve);
  const base = `https://raw.githubusercontent.com/${tap}/${resolvedSha}/catalogs/${encodeURIComponent(catalog)}`;
  const [manifestText, readmeText] = await Promise.all([
    fetchText(fetcher, `${base}/manifest.json`),
    fetchText(fetcher, `${base}/README.md`)
  ]);
  const manifest = parseManifest(manifestText);
  if (manifest.name !== catalog) throw wooError("E_CATALOG", `manifest name ${manifest.name} does not match requested catalog ${catalog}`);
  const frontmatter = parseFrontmatter(readmeText);
  validateFrontmatter(frontmatter, manifest);
  const provenance: Record<string, WooValue> = {
    tap,
    catalog,
    alias,
    ref_requested: refRequested ?? refToResolve,
    ref_resolved_sha: resolvedSha,
    manifest_hash: hashText(manifestText),
    readme_hash: hashText(readmeText),
    fetched_at: now()
  };
  return { manifest, frontmatter, alias, provenance };
}

export async function installGitHubTap(
  world: WooWorld,
  actor: ObjRef,
  request: GitHubTapInstallRequest,
  options: LoadOptions = {}
): Promise<AppliedFrame> {
  if (!world.object(actor).flags.wizard) throw wooError("E_PERM", "only wizards may install catalogs", actor);
  const loaded = await loadGitHubCatalog(request, options);
  const message: Message = {
    actor,
    target: "$catalog_registry",
    verb: "install",
    args: [loaded.manifest as unknown as WooValue, loaded.frontmatter as WooValue, loaded.alias, loaded.provenance]
  };
  return world.applyCall(undefined, "$catalog_registry", message);
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

async function defaultRef(fetcher: FetchLike, tap: string, catalog: string): Promise<string> {
  const tags = await fetchJson(fetcher, `https://api.github.com/repos/${tap}/tags?per_page=100`);
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

async function resolveCommitSha(fetcher: FetchLike, tap: string, ref: string): Promise<string> {
  const commit = await fetchJson(fetcher, `https://api.github.com/repos/${tap}/commits/${encodeURIComponent(ref)}`);
  const sha = (commit as GitHubCommit).sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw wooError("E_CATALOG", `GitHub did not return a commit SHA for ${tap}@${ref}`);
  }
  return sha.toLowerCase();
}

async function fetchText(fetcher: FetchLike, url: string): Promise<string> {
  const response = await fetcher(url, { headers: githubHeaders() });
  if (!response.ok) throw wooError("E_NOTFOUND", `GitHub fetch failed ${response.status}: ${url}`);
  return response.text();
}

async function fetchJson(fetcher: FetchLike, url: string): Promise<unknown> {
  const response = await fetcher(url, { headers: githubHeaders() });
  if (!response.ok) throw wooError("E_NOTFOUND", `GitHub API fetch failed ${response.status}: ${url}`);
  return response.json();
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

function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
