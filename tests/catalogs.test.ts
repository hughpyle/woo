import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { installCatalogManifest, type CatalogManifest as RuntimeCatalogManifest } from "../src/core/catalog-installer";
import { bundledCatalogAliases } from "../src/core/local-catalogs";

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
