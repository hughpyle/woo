import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { installGitHubTap, loadGitHubCatalog, parseFrontmatter } from "../src/server/github-taps";

const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const manifest = {
  name: "remote-demo",
  version: "1.2.0",
  spec_version: "v1",
  license: "MIT",
  classes: [
    {
      local_name: "$remote_control",
      parent: "$thing",
      description: "Remote catalog control class used to prove tap installation creates classes from fetched manifests.",
      properties: [{ name: "value", type: "num", default: 0 }],
      verbs: [
        {
          name: "ping",
          source: "verb :ping() rxd {\n  return \"pong\";\n}",
          implementation: { kind: "native", handler: "remote_native_must_be_ignored" }
        }
      ]
    }
  ],
  seed_hooks: [
    {
      kind: "create_instance",
      class: "$remote_control",
      as: "remote_control_1",
      name: "Remote Control",
      description: "Seeded remote catalog control instance installed from a mocked GitHub tap for the test suite."
    }
  ]
};

const readme = `---
name: remote-demo
version: 1.2.0
spec_version: v1
license: MIT
depends:
  - chat
---

# Remote Demo
`;

describe("GitHub catalog taps", () => {
  it("loads a catalog by resolving the highest catalog semver tag", async () => {
    const loaded = await loadGitHubCatalog(
      { tap: "hugh/woo-libs", catalog: "remote-demo", as: "remote" },
      { fetch: mockFetch(), now: () => 1234 }
    );

    expect(loaded.alias).toBe("remote");
    expect(loaded.manifest.name).toBe("remote-demo");
    expect(loaded.frontmatter.depends).toEqual(["chat"]);
    expect(loaded.provenance).toMatchObject({
      tap: "hugh/woo-libs",
      catalog: "remote-demo",
      alias: "remote",
      ref_requested: "remote-demo-v1.2.0",
      ref_resolved_sha: sha,
      fetched_at: 1234,
      manifest_hash: `sha256:${hash(JSON.stringify(manifest))}`,
      readme_hash: `sha256:${hash(readme)}`
    });
  });

  it("installs fetched manifests through the catalog registry log", async () => {
    const world = createWorld({ catalogs: false });
    const frame = await installGitHubTap(
      world,
      "$wiz",
      { tap: "hugh/woo-libs", catalog: "remote-demo", ref: "remote-demo-v1.2.0", as: "remote" },
      { fetch: mockFetch(), now: () => 5678 }
    );

    expect(frame.space).toBe("$catalog_registry");
    expect(frame.seq).toBe(1);
    expect(world.object("$remote_control").parent).toBe("$thing");
    expect(world.object("remote_control_1").parent).toBe("$remote_control");
    expect(world.object("catalog_remote").parent).toBe("$catalog");
    expect(world.object("$remote_control").verbs.get("ping")?.kind).toBe("bytecode");
    expect(world.getProp("$catalog_registry", "installed_catalogs")).toMatchObject([
      {
        tap: "hugh/woo-libs",
        catalog: "remote-demo",
        alias: "remote",
        version: "1.2.0",
        provenance: { ref_resolved_sha: sha, fetched_at: 5678 }
      }
    ]);
    expect(world.replay("$catalog_registry", 1, 10).map((entry) => entry.message.verb)).toEqual(["install"]);
  });

  it("requires wizard authority before fetching", async () => {
    const world = createWorld({ catalogs: false });
    const session = world.auth("guest:tap");
    let fetchCalled = false;
    try {
      await installGitHubTap(
        world,
        session.actor,
        { tap: "hugh/woo-libs", catalog: "remote-demo" },
        {
          fetch: async () => {
            fetchCalled = true;
            throw new Error("should not fetch");
          }
        }
      );
      throw new Error("expected install to fail");
    } catch (err) {
      expect(err).toMatchObject({ code: "E_PERM" });
      expect(fetchCalled).toBe(false);
    }
  });

  it("parses the README frontmatter subset used by catalogs", () => {
    expect(parseFrontmatter(readme)).toEqual({
      name: "remote-demo",
      version: "1.2.0",
      spec_version: "v1",
      license: "MIT",
      depends: ["chat"]
    });
  });

  it("rejects non-semver catalog versions", async () => {
    await expect(loadGitHubCatalog(
      { tap: "hugh/woo-libs", catalog: "remote-demo", ref: "remote-demo-v1.2.0" },
      {
        fetch: mockFetch({
          manifest: { ...manifest, version: "not-a-version" },
          readme: readme.replace("version: 1.2.0", "version: not-a-version")
        })
      }
    )).rejects.toMatchObject({ code: "E_CATALOG" });
  });
});

function mockFetch(options: { manifest?: typeof manifest; readme?: string } = {}) {
  const manifestBody = options.manifest ?? manifest;
  const readmeBody = options.readme ?? readme;
  return async (url: string) => {
    if (url === "https://api.github.com/repos/hugh/woo-libs/tags?per_page=100") {
      return response([{ name: "remote-demo-v1.0.0" }, { name: "remote-demo-v1.2.0" }, { name: "other-v9.0.0" }]);
    }
    if (url === "https://api.github.com/repos/hugh/woo-libs/commits/remote-demo-v1.2.0") return response({ sha });
    if (url === `https://raw.githubusercontent.com/hugh/woo-libs/${sha}/catalogs/remote-demo/manifest.json`) return textResponse(JSON.stringify(manifestBody));
    if (url === `https://raw.githubusercontent.com/hugh/woo-libs/${sha}/catalogs/remote-demo/README.md`) return textResponse(readmeBody);
    return { ok: false, status: 404, statusText: "Not Found", text: async () => "", json: async () => ({}) };
  };
}

function response(value: unknown) {
  return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(value), json: async () => value };
}

function textResponse(value: string) {
  return { ok: true, status: 200, statusText: "OK", text: async () => value, json: async () => JSON.parse(value) };
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
