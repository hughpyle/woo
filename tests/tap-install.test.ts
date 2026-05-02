import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { installGitHubTap, loadGitHubCatalog, parseFrontmatter, updateGitHubTap, type CatalogTapLogEvent } from "../src/core/catalog-taps";

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

const updatedManifest = {
  ...manifest,
  version: "1.3.0",
  classes: [
    {
      local_name: "$remote_control",
      parent: "$thing",
      description: "Remote catalog control class used to prove tap updates replace class verbs from fetched manifests.",
      properties: [{ name: "value", type: "num", default: 1 }, { name: "mode", type: "str", default: "updated" }],
      verbs: [
        {
          name: "ping",
          source: "verb :ping() rxd {\n  return \"updated\";\n}"
        }
      ]
    }
  ]
};

const updatedReadme = readme.replace("version: 1.2.0", "version: 1.3.0");

describe("GitHub catalog taps", () => {
  it("loads a catalog by resolving the highest catalog semver tag", async () => {
    const loaded = await loadGitHubCatalog(
      { tap: "hughpyle/woo-libs", catalog: "remote-demo", as: "remote" },
      { fetch: mockFetch(), now: () => 1234 }
    );

    expect(loaded.alias).toBe("remote");
    expect(loaded.manifest.name).toBe("remote-demo");
    expect(loaded.frontmatter.depends).toEqual(["chat"]);
    expect(loaded.provenance).toMatchObject({
      tap: "hughpyle/woo-libs",
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
      { tap: "hughpyle/woo-libs", catalog: "remote-demo", ref: "remote-demo-v1.2.0", as: "remote" },
      { fetch: mockFetch(), now: () => 5678 }
    );

    expect(frame.space).toBe("$catalog_registry");
    expect(frame.seq).toBe(1);
    expect(world.object("$remote_control").parent).toBe("$thing");
    expect(world.object("remote_control_1").parent).toBe("$remote_control");
    expect(world.object("catalog_remote").parent).toBe("$catalog");
    const ping = world.ownVerb("$remote_control", "ping");
    expect(ping?.kind).toBe("bytecode");
    expect(ping?.perms).toBe("rx");
    expect(ping?.direct_callable).toBe(true);
    expect(world.getProp("$catalog_registry", "installed_catalogs")).toMatchObject([
      {
        tap: "hughpyle/woo-libs",
        catalog: "remote-demo",
        alias: "remote",
        version: "1.2.0",
        provenance: { ref_resolved_sha: sha, fetched_at: 5678 }
      }
    ]);
    expect(world.replay("$catalog_registry", 1, 10).map((entry) => entry.message.verb)).toEqual(["install"]);
  });

  it("refuses exact retry installs without appending a registry log row", async () => {
    const world = createWorld({ catalogs: false });
    await installGitHubTap(
      world,
      "$wiz",
      { tap: "hughpyle/woo-libs", catalog: "remote-demo", ref: "remote-demo-v1.2.0", as: "remote" },
      { fetch: mockFetch(), now: () => 1000 }
    );

    await expect(installGitHubTap(
      world,
      "$wiz",
      { tap: "hughpyle/woo-libs", catalog: "remote-demo", ref: "remote-demo-v1.2.0", as: "remote" },
      { fetch: mockFetch(), now: () => 2000 }
    )).rejects.toMatchObject({ code: "E_CATALOG_ALREADY_INSTALLED" });
    expect(world.replay("$catalog_registry", 1, 10).map((entry) => entry.message.verb)).toEqual(["install"]);
  });

  it("updates fetched manifests through the catalog registry log", async () => {
    const world = createWorld({ catalogs: false });
    await installGitHubTap(
      world,
      "$wiz",
      { tap: "hughpyle/woo-libs", catalog: "remote-demo", ref: "remote-demo-v1.2.0", as: "remote" },
      { fetch: mockFetch(), now: () => 1000 }
    );

    const frame = await updateGitHubTap(
      world,
      "$wiz",
      { tap: "hughpyle/woo-libs", catalog: "remote-demo", ref: "remote-demo-v1.3.0", as: "remote" },
      { fetch: mockFetch({ manifest: updatedManifest, readme: updatedReadme, refs: ["remote-demo-v1.2.0", "remote-demo-v1.3.0"] }), now: () => 2000 }
    );

    expect(frame.space).toBe("$catalog_registry");
    expect(frame.seq).toBe(2);
    expect(world.getProp("$remote_control", "mode")).toBe("updated");
    expect(world.getProp("$catalog_registry", "installed_catalogs")).toMatchObject([
      {
        alias: "remote",
        version: "1.3.0",
        updated_at: expect.any(Number),
        migration_state: { status: "not_required" },
        provenance: { ref_requested: "remote-demo-v1.3.0", fetched_at: 2000 }
      }
    ]);
    expect(world.replay("$catalog_registry", 1, 10).map((entry) => entry.message.verb)).toEqual(["install", "update"]);
  });

  it("enforces tap body size limits and emits structured fetch/install logs", async () => {
    const logs: CatalogTapLogEvent[] = [];
    const loaded = await loadGitHubCatalog(
      { tap: "hughpyle/woo-libs", catalog: "remote-demo", ref: "remote-demo-v1.2.0", as: "remote" },
      { fetch: mockFetch(), now: () => 1000, log: (event) => logs.push(event) }
    );

    expect(loaded.provenance.manifest_hash).toBe(`sha256:${hash(JSON.stringify(manifest))}`);
    expect(logs).toMatchObject([{ kind: "tap_fetch", ref_resolved_sha: sha, manifest_hash: `sha256:${hash(JSON.stringify(manifest))}`, subrequests: 3 }]);

    const world = createWorld({ catalogs: false });
    await installGitHubTap(
      world,
      "$wiz",
      { tap: "hughpyle/woo-libs", catalog: "remote-demo", ref: "remote-demo-v1.2.0", as: "remote" },
      { fetch: mockFetch(), now: () => 1000, log: (event) => logs.push(event) }
    );
    expect(logs.some((event) => event.kind === "tap_install" && event.ref_resolved_sha === sha)).toBe(true);

    await expect(loadGitHubCatalog(
      { tap: "hughpyle/woo-libs", catalog: "remote-demo", ref: "remote-demo-v1.2.0" },
      { fetch: mockFetch({ manifestText: "x".repeat(300 * 1024), readme }), now: () => 1000 }
    )).rejects.toMatchObject({ code: "E_RATE" });
  });

  it("requires wizard authority before fetching", async () => {
    const world = createWorld({ catalogs: false });
    const session = world.auth("guest:tap");
    let fetchCalled = false;
    try {
      await installGitHubTap(
        world,
        session.actor,
        { tap: "hughpyle/woo-libs", catalog: "remote-demo" },
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

  it("parses the README frontmatter subset used by catalogs", async () => {
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
      { tap: "hughpyle/woo-libs", catalog: "remote-demo", ref: "remote-demo-v1.2.0" },
      {
        fetch: mockFetch({
          manifest: { ...manifest, version: "not-a-version" },
          readme: readme.replace("version: 1.2.0", "version: not-a-version")
        })
      }
    )).rejects.toMatchObject({ code: "E_CATALOG" });
  });
});

function mockFetch(options: { manifest?: unknown; manifestText?: string; readme?: string; refs?: string[] } = {}) {
  const manifestBody = options.manifest ?? manifest;
  const manifestText = options.manifestText ?? JSON.stringify(manifestBody);
  const readmeBody = options.readme ?? readme;
  const refs = options.refs ?? ["remote-demo-v1.0.0", "remote-demo-v1.2.0"];
  return async (url: string) => {
    if (url === "https://api.github.com/repos/hughpyle/woo-libs/tags?per_page=100") {
      return response([...refs.map((name) => ({ name })), { name: "other-v9.0.0" }]);
    }
    for (const ref of refs) {
      if (url === `https://api.github.com/repos/hughpyle/woo-libs/commits/${ref}`) return response({ sha });
    }
    if (url === `https://raw.githubusercontent.com/hughpyle/woo-libs/${sha}/catalogs/remote-demo/manifest.json`) return textResponse(manifestText);
    if (url === `https://raw.githubusercontent.com/hughpyle/woo-libs/${sha}/catalogs/remote-demo/README.md`) return textResponse(readmeBody);
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
