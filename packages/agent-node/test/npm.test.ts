import { describe, expect, it } from "vitest";
import { MemoryFs } from "@00/agent-fs";
import { RegistryClient, assertSupportedRange, verifyIntegrity, verifyShasum, integrityBytes, DEFAULT_REGISTRY, ABBREVIATED_ACCEPT } from "../src/npm/registry.js";
import { hoistCandidates, resolveTree, buildLockfile, buildHiddenLockfile, readJsonFile, type Lockfile } from "../src/npm/tree.js";
import { install, stripTarballPrefix, writeBinShims } from "../src/npm/install.js";
import { npmLs, npmRunPlan, rewriteBinArgv, binDirectories, readManifest } from "../src/npm/scripts.js";
import { bytesToHex, sha1 } from "../src/modules/crypto.js";
import { fakeRegistry } from "./npm-fixtures.js";
import { createLoader, snapshotLoaderFs } from "../src/loader/index.js";

const encoder = new TextEncoder();
const REGISTRY = "https://registry.test";

async function project(manifest: Record<string, unknown>, extra: Record<string, string> = {}): Promise<MemoryFs> {
  const fs = new MemoryFs();
  await fs.writeFile("p/package.json", encoder.encode(JSON.stringify(manifest, null, 2)));
  for (const [path, body] of Object.entries(extra)) await fs.writeFile(`p/${path}`, encoder.encode(body));
  return fs;
}

describe("the registry client", () => {
  it("asks for the abbreviated document and caches one request per name", async () => {
    const registry = await fakeRegistry([{ name: "left-pad", version: "1.0.0" }], REGISTRY);
    const client = new RegistryClient({ registry: REGISTRY, fetch: registry.fetch });
    await client.packument("left-pad");
    await client.packument("left-pad");
    expect(registry.calls).toEqual([`${REGISTRY}/left-pad`]);
    expect(ABBREVIATED_ACCEPT).toBe("application/vnd.npm.install-v1+json");
    expect(DEFAULT_REGISTRY).toBe("https://registry.npmjs.org");
  });

  it("escapes a scope in the URL", () => {
    const client = new RegistryClient({ registry: REGISTRY, fetch: async () => new Response("{}") });
    expect(client.packumentUrl("@scope/pkg")).toBe(`${REGISTRY}/@scope%2fpkg`);
    expect(client.packumentUrl("plain")).toBe(`${REGISTRY}/plain`);
  });

  it("picks a version by range, by dist-tag and by exact match", async () => {
    const registry = await fakeRegistry(
      [
        { name: "many", version: "1.0.0" },
        { name: "many", version: "1.2.3" },
        { name: "many", version: "2.0.0" },
      ],
      REGISTRY,
    );
    const client = new RegistryClient({ registry: REGISTRY, fetch: registry.fetch });
    expect((await client.resolveVersion("many", "^1.0.0")).version).toBe("1.2.3");
    expect((await client.resolveVersion("many", "1.0.0")).version).toBe("1.0.0");
    expect((await client.resolveVersion("many", "latest")).version).toBe("2.0.0");
    expect((await client.resolveVersion("many", "*")).version).toBe("2.0.0");
    expect((await client.resolveVersion("many", "")).version).toBe("2.0.0");
    await expect(client.resolveVersion("many", "^9")).rejects.toThrow(/No matching version/);
    await expect(client.resolveVersion("absent", "1.0.0")).rejects.toThrow(/is not published/);
  });

  it("reports a registry error by status", async () => {
    const client = new RegistryClient({ registry: REGISTRY, fetch: async () => new Response("boom", { status: 500, statusText: "Server Error" }) });
    await expect(client.packument("x")).rejects.toThrow(/500 Server Error/);
    await expect(client.tarball(`${REGISTRY}/x.tgz`)).rejects.toThrow(/500 Server Error/);
  });

  it("refuses every specifier that is not a registry range, by name", () => {
    for (const range of ["git+https://x/y.git", "github:a/b#main", "file:../x", "link:../x", "https://x/y.tgz", "workspace:*", "npm:other@1"]) {
      expect(() => assertSupportedRange("pkg", range), range).toThrow(/registry only|aliased/);
    }
    expect(() => assertSupportedRange("pkg", "^1.0.0")).not.toThrow();
  });

  it("needs a fetch and says so when there is none", () => {
    const saved = globalThis.fetch;
    // @ts-expect-error — deliberately removing the global to prove the refusal.
    delete globalThis.fetch;
    try {
      expect(() => new RegistryClient()).toThrow(/needs a fetch implementation/);
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe("integrity", () => {
  const body = encoder.encode("the tarball bytes");

  it("verifies sha512, sha384 and sha256 through WebCrypto, and refuses a mismatch", async () => {
    for (const algorithm of ["SHA-512", "SHA-384", "SHA-256"]) {
      const copy = new Uint8Array(body.byteLength);
      copy.set(body);
      const digest = new Uint8Array(await crypto.subtle.digest(algorithm, copy.buffer));
      let binary = "";
      for (const b of digest) binary += String.fromCharCode(b);
      const integrity = `${algorithm.toLowerCase().replace("-", "")}-${btoa(binary)}`;
      await expect(verifyIntegrity(body, integrity)).resolves.toBeUndefined();
      expect(integrityBytes(integrity).byteLength).toBe(digest.byteLength);
    }
    await expect(verifyIntegrity(body, "sha512-AAAA")).rejects.toThrow(/refusing to unpack/);
  });

  it("verifies the legacy sha1 forms an old package still carries", async () => {
    let binary = "";
    for (const b of sha1(body)) binary += String.fromCharCode(b);
    await expect(verifyIntegrity(body, `sha1-${btoa(binary)}`)).resolves.toBeUndefined();
    await expect(verifyIntegrity(body, "sha1-AAAA")).rejects.toThrow(/refusing to unpack/);
    expect(() => verifyShasum(body, bytesToHex(sha1(body)))).not.toThrow();
    expect(() => verifyShasum(body, "0".repeat(40))).toThrow(/refusing to unpack/);
  });

  it("refuses an algorithm it cannot check rather than skipping the check", async () => {
    await expect(verifyIntegrity(body, "blake3-AAAA")).rejects.toThrow(/cannot verify/);
  });
});

describe("hoisting", () => {
  it("offers every ancestor slot, shallowest first", () => {
    expect(hoistCandidates("")).toEqual([""]);
    expect(hoistCandidates("node_modules/a")).toEqual(["", "node_modules/a"]);
    expect(hoistCandidates("node_modules/a/node_modules/b")).toEqual(["", "node_modules/a", "node_modules/a/node_modules/b"]);
  });
});

describe("resolveTree", () => {
  it("lays the tree out flat and nests only on a conflict", async () => {
    const registry = await fakeRegistry(
      [
        { name: "app-dep", version: "1.0.0", dependencies: { shared: "^1.0.0" } },
        { name: "other-dep", version: "1.0.0", dependencies: { shared: "^2.0.0" } },
        { name: "shared", version: "1.5.0" },
        { name: "shared", version: "2.1.0" },
      ],
      REGISTRY,
    );
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { "app-dep": "^1.0.0", "other-dep": "^1.0.0" } });
    const tree = await resolveTree(fs, "p", { registry: REGISTRY, fetch: registry.fetch });
    const paths = tree.placements.map((p) => `${p.path}@${p.version}`);
    expect(paths).toContain("node_modules/app-dep@1.0.0");
    expect(paths).toContain("node_modules/other-dep@1.0.0");
    // The first one to ask wins the top slot; the loser nests under the package that wanted it.
    expect(paths).toContain("node_modules/shared@1.5.0");
    expect(paths).toContain("node_modules/other-dep/node_modules/shared@2.1.0");
    expect(tree.fromLockfile).toBe(false);
  });

  it("dedupes two requests for the same version into one copy", async () => {
    const registry = await fakeRegistry(
      [
        { name: "a", version: "1.0.0", dependencies: { shared: "^1.0.0" } },
        { name: "b", version: "1.0.0", dependencies: { shared: "1.5.0" } },
        { name: "shared", version: "1.5.0" },
      ],
      REGISTRY,
    );
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { a: "^1", b: "^1" } });
    const tree = await resolveTree(fs, "p", { registry: REGISTRY, fetch: registry.fetch });
    expect(tree.placements.filter((p) => p.name === "shared")).toHaveLength(1);
  });

  it("takes devDependencies unless told not to, and marks them", async () => {
    const registry = await fakeRegistry([{ name: "tool", version: "1.0.0" }, { name: "lib", version: "1.0.0" }], REGISTRY);
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { lib: "^1" }, devDependencies: { tool: "^1" } });
    const withDev = await resolveTree(fs, "p", { registry: REGISTRY, fetch: registry.fetch });
    expect(withDev.placements.map((p) => p.name).sort()).toEqual(["lib", "tool"]);
    expect(withDev.placements.find((p) => p.name === "tool")?.dev).toBe(true);
    const withoutDev = await resolveTree(fs, "p", { registry: REGISTRY, fetch: registry.fetch, dev: false });
    expect(withoutDev.placements.map((p) => p.name)).toEqual(["lib"]);
  });

  it("warns about peers and deprecations rather than acting on them", async () => {
    const registry = await fakeRegistry(
      [
        {
          name: "plugin",
          version: "1.0.0",
          deprecated: "use plugin2",
          peerDependencies: { host: "^3", optionalpeer: "^1" },
          peerDependenciesMeta: { optionalpeer: { optional: true } },
        },
      ],
      REGISTRY,
    );
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { plugin: "^1" } });
    const tree = await resolveTree(fs, "p", { registry: REGISTRY, fetch: registry.fetch });
    expect(tree.warnings.some((w) => w.includes("deprecated"))).toBe(true);
    expect(tree.warnings.some((w) => w.includes("wants a peer host@^3"))).toBe(true);
    expect(tree.warnings.some((w) => w.includes("optionalpeer"))).toBe(false);
    expect(tree.placements.map((p) => p.name)).toEqual(["plugin"]);
  });

  it("skips an optional dependency that cannot be resolved, with a warning", async () => {
    const registry = await fakeRegistry([{ name: "core", version: "1.0.0", optionalDependencies: { "fast-thing": "^1" } }], REGISTRY);
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { core: "^1" }, optionalDependencies: { missing: "^1" } });
    const tree = await resolveTree(fs, "p", { registry: REGISTRY, fetch: registry.fetch });
    expect(tree.warnings.some((w) => w.includes("fast-thing"))).toBe(true);
    expect(tree.warnings.some((w) => w.includes("missing"))).toBe(true);
    expect(tree.placements.map((p) => p.name)).toEqual(["core"]);
  });

  it("says so when there is no package.json, and when one is not JSON", async () => {
    const empty = new MemoryFs();
    await expect(resolveTree(empty, "p")).rejects.toThrow(/no package.json/);
    const broken = new MemoryFs();
    await broken.writeFile("p/package.json", encoder.encode("{ not json"));
    await expect(readJsonFile(broken, "p/package.json")).rejects.toThrow(/not valid JSON/);
  });

  it("honours an existing lockfile exactly, asking the registry nothing", async () => {
    const registry = await fakeRegistry([{ name: "lib", version: "9.9.9" }], REGISTRY);
    const lockfile: Lockfile = {
      name: "proj",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "proj", version: "1.0.0", dependencies: { lib: "^1" } },
        "node_modules/lib": { version: "1.0.0", resolved: `${REGISTRY}/lib/-/lib-1.0.0.tgz`, integrity: "sha512-x", dev: true },
        "node_modules/lib/node_modules/inner": { version: "0.1.0", resolved: `${REGISTRY}/inner/-/inner-0.1.0.tgz` },
        "node_modules/no-resolution": { version: "1.0.0" },
      },
    };
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { lib: "^1", ghost: "^1" } });
    await fs.writeFile("p/package-lock.json", encoder.encode(JSON.stringify(lockfile)));
    const tree = await resolveTree(fs, "p", { registry: REGISTRY, fetch: registry.fetch });
    expect(registry.calls).toEqual([]);
    expect(tree.fromLockfile).toBe(true);
    expect(tree.placements.map((p) => p.path)).toEqual(["node_modules/lib", "node_modules/lib/node_modules/inner"]);
    expect(tree.placements[0]?.dev).toBe(true);
    expect(tree.placements[1]?.name).toBe("inner");
    expect(tree.warnings.some((w) => w.includes("ghost"))).toBe(true);
  });

  it("resolves afresh when the caller says to ignore the lockfile", async () => {
    const registry = await fakeRegistry([{ name: "lib", version: "1.4.0" }], REGISTRY);
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { lib: "^1" } });
    await fs.writeFile(
      "p/package-lock.json",
      encoder.encode(JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/lib": { version: "1.0.0", resolved: "stale" } } })),
    );
    expect((await resolveTree(fs, "p", { registry: REGISTRY, fetch: registry.fetch })).placements[0]?.version).toBe("1.0.0");
    const fresh = await resolveTree(fs, "p", { registry: REGISTRY, fetch: registry.fetch, useLockfile: false });
    expect(fresh.fromLockfile).toBe(false);
    expect(fresh.placements[0]?.version).toBe("1.4.0");
    expect(registry.calls.length).toBeGreaterThan(0);
  });

  it("refuses a lockfile from before the packages map", async () => {
    const fs = await project({ name: "proj", version: "1.0.0" });
    await fs.writeFile("p/package-lock.json", encoder.encode(JSON.stringify({ lockfileVersion: 1, dependencies: {} })));
    await expect(resolveTree(fs, "p")).rejects.toThrow(/lockfileVersion 1/);
  });

  it("builds a lockfileVersion 3 document and its hidden twin", () => {
    const lockfile = buildLockfile(
      { name: "proj", version: "1.0.0" },
      { dependencies: { lib: "^1" }, devDependencies: { tool: "^2" } },
      [
        { path: "node_modules/lib", name: "lib", version: "1.0.0", resolved: "u", integrity: "i", dependencies: { x: "^1" }, bin: "cli.js", dev: false, optional: false, hasInstallScript: true },
        { path: "node_modules/tool", name: "tool", version: "2.0.0", resolved: "u2", dependencies: {}, dev: true, optional: true, hasInstallScript: false },
      ],
    );
    expect(lockfile.lockfileVersion).toBe(3);
    expect(lockfile.packages[""]?.devDependencies).toEqual({ tool: "^2" });
    expect(lockfile.packages["node_modules/lib"]).toMatchObject({ version: "1.0.0", integrity: "i", hasInstallScript: true });
    expect(lockfile.packages["node_modules/tool"]).toMatchObject({ dev: true, optional: true });
    expect(lockfile.packages["node_modules/tool"]?.dependencies).toBeUndefined();
    const hidden = buildHiddenLockfile(lockfile);
    expect(hidden.packages[""]).toBeUndefined();
    expect(Object.keys(hidden.packages)).toEqual(["node_modules/lib", "node_modules/tool"]);
  });
});

describe("install", () => {
  it("fetches, verifies, unpacks, writes the lockfiles and the bin shims", async () => {
    const registry = await fakeRegistry(
      [
        { name: "left-pad", version: "1.3.0", bin: { "left-pad": "./cli.js" }, files: { "cli.js": `console.log("padded");`, "lib/deep.js": "module.exports = 1;" } },
        { name: "@scope/tool", version: "2.0.0", bin: "bin/tool.js", dependencies: { "left-pad": "^1.0.0" }, files: { "bin/tool.js": `console.log("tool");` } },
      ],
      REGISTRY,
    );
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { "@scope/tool": "^2" } });
    const progress: string[] = [];
    const result = await install(fs, "p", { registry: REGISTRY, fetch: registry.fetch, onProgress: (e) => progress.push(`${e.done}/${e.total} ${e.name}`) });

    expect(result.installed.map((i) => i.name).sort()).toEqual(["@scope/tool", "left-pad"]);
    expect(progress).toHaveLength(2);
    expect(await fs.readText("p/node_modules/left-pad/index.js")).toContain("left-pad@1.3.0");
    expect(await fs.readText("p/node_modules/left-pad/lib/deep.js")).toBe("module.exports = 1;");
    expect(await fs.readText("p/node_modules/@scope/tool/package.json")).toContain(`"version": "2.0.0"`);
    // The stray root-level entry in the archive is dropped, not written beside the package.
    expect(await fs.stat("p/node_modules/left-pad/pax_global_header")).toBeNull();

    const lock = JSON.parse(await fs.readText("p/package-lock.json")) as Lockfile;
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages["node_modules/left-pad"]?.version).toBe("1.3.0");
    const hidden = JSON.parse(await fs.readText("p/node_modules/.package-lock.json")) as Lockfile;
    expect(hidden.packages[""]).toBeUndefined();

    const shim = await fs.readText("p/node_modules/.bin/left-pad");
    expect(shim).toContain(`require("../left-pad/cli.js")`);
    expect(await fs.readText("p/node_modules/.bin/tool")).toContain(`require("../@scope/tool/bin/tool.js")`);
  });

  it("installs a tree the loader can then actually require", async () => {
    const registry = await fakeRegistry([{ name: "greeter", version: "1.0.0" }], REGISTRY);
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { greeter: "^1" } }, { "app.js": `module.exports = require("greeter");` });
    await install(fs, "p", { registry: REGISTRY, fetch: registry.fetch });

    // Snapshot the installed tree into the loader's synchronous view and require through it.
    const files: Record<string, Uint8Array> = {};
    for await (const entry of fs.walk("p")) files[`/${entry.path.slice(2)}`] = await fs.readFile(entry.path);
    const loader = createLoader({ fs: snapshotLoaderFs(files), cwd: "/", root: "/" });
    expect(loader.require("/app.js")).toBe("greeter@1.0.0");
  });

  it("skips a package that is already there at the same version", async () => {
    const registry = await fakeRegistry([{ name: "lib", version: "1.0.0" }], REGISTRY);
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { lib: "^1" } });
    await install(fs, "p", { registry: REGISTRY, fetch: registry.fetch });
    const before = registry.calls.length;
    const second = await install(fs, "p", { registry: REGISTRY, fetch: registry.fetch });
    expect(second.installed).toHaveLength(0);
    expect(second.skipped.map((s) => s.name)).toEqual(["lib"]);
    expect(registry.calls.length).toBe(before);
    // `incremental: false` does the work again.
    const third = await install(fs, "p", { registry: REGISTRY, fetch: registry.fetch, incremental: false });
    expect(third.installed.map((i) => i.name)).toEqual(["lib"]);
  });

  it("names the install scripts it did not run and the native code it cannot build", async () => {
    const registry = await fakeRegistry(
      [
        { name: "scripted", version: "1.0.0", scripts: { postinstall: "node build.js", preinstall: "echo hi" } },
        { name: "compiled", version: "1.0.0", native: true },
      ],
      REGISTRY,
    );
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { scripted: "^1", compiled: "^1" } });
    const result = await install(fs, "p", { registry: REGISTRY, fetch: registry.fetch });
    expect(result.skippedScripts.join(" ")).toContain("scripted@1.0.0");
    expect(result.skippedScripts.join(" ")).toContain("postinstall");
    expect(result.nativePackages).toEqual(["compiled@1.0.0"]);
    expect(result.warnings.some((w) => w.includes("never runs them"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("cannot run in a browser"))).toBe(true);
    // The files are still written: a package is often usable without its native fast path.
    expect(await fs.stat("p/node_modules/compiled/binding.gyp")).not.toBeNull();
  });

  it("refuses a tarball whose integrity does not match, and never writes it", async () => {
    const registry = await fakeRegistry([{ name: "tampered", version: "1.0.0", corrupt: true }], REGISTRY);
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { tampered: "^1" } });
    await expect(install(fs, "p", { registry: REGISTRY, fetch: registry.fetch })).rejects.toThrow(/refusing to unpack/);
    expect(await fs.stat("p/node_modules/tampered/index.js")).toBeNull();
  });

  it("falls back to dist.shasum, and refuses a package with neither", async () => {
    const registry = await fakeRegistry([{ name: "old", version: "0.1.0" }], REGISTRY);
    const stripped: typeof registry.fetch = async (input, init) => {
      const response = await registry.fetch(input, init);
      if (!input.endsWith(".tgz")) {
        const body = (await response.json()) as { versions: Record<string, { dist: Record<string, unknown> }> };
        for (const version of Object.values(body.versions)) delete version.dist.integrity;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return response;
    };
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { old: "^0" } });
    await expect(install(fs, "p", { registry: REGISTRY, fetch: stripped })).rejects.toThrow(/neither dist.integrity nor dist.shasum/);
  });

  it("turns an optional package's failure into a warning rather than a failed install", async () => {
    const registry = await fakeRegistry([{ name: "core", version: "1.0.0" }, { name: "fast", version: "1.0.0", corrupt: true }], REGISTRY);
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { core: "^1" }, optionalDependencies: { fast: "^1" } });
    const result = await install(fs, "p", { registry: REGISTRY, fetch: registry.fetch });
    expect(result.installed.map((i) => i.name)).toEqual(["core"]);
    expect(result.warnings.some((w) => w.includes("optional fast@1.0.0 failed"))).toBe(true);
  });

  it("strips only the tarball's own top directory", () => {
    expect(stripTarballPrefix("package/index.js")).toBe("index.js");
    expect(stripTarballPrefix("some-other-root/lib/a.js")).toBe("lib/a.js");
    expect(stripTarballPrefix("package/")).toBeNull();
    expect(stripTarballPrefix("loose-file")).toBeNull();
  });

  it("writes a shim per bin entry and nothing for a package with none", async () => {
    const fs = new MemoryFs();
    const written = await writeBinShims(fs, "p", [
      { path: "node_modules/one", name: "one", version: "1", resolved: "", dependencies: {}, bin: "a.js", dev: false, optional: false, hasInstallScript: false },
      { path: "node_modules/two", name: "two", version: "1", resolved: "", dependencies: {}, bin: { x: "x.js", y: "./y.js" }, dev: false, optional: false, hasInstallScript: false },
      { path: "node_modules/three", name: "three", version: "1", resolved: "", dependencies: {}, dev: false, optional: false, hasInstallScript: false },
      { path: "node_modules/two/node_modules/one", name: "one", version: "2", resolved: "", dependencies: {}, bin: "a.js", dev: false, optional: false, hasInstallScript: false },
      { path: "node_modules/@s/scoped", name: "@s/scoped", version: "1", resolved: "", dependencies: {}, bin: "s.js", dev: false, optional: false, hasInstallScript: false },
    ]);
    expect(written).toEqual([
      "node_modules/.bin/one",
      "node_modules/.bin/x",
      "node_modules/.bin/y",
      "node_modules/two/node_modules/.bin/one",
      "node_modules/.bin/scoped",
    ]);
    expect(await fs.readText("p/node_modules/.bin/y")).toContain(`require("../two/y.js")`);
    // A nested copy's shim lives in its OWN .bin and points at the copy beside it.
    expect(await fs.readText("p/node_modules/two/node_modules/.bin/one")).toContain(`require("../one/a.js")`);
    expect(await fs.readText("p/node_modules/.bin/scoped")).toContain(`require("../@s/scoped/s.js")`);
  });
});

describe("npm run and npm ls", () => {
  it("plans a script with its pre and post hooks and npm's environment", async () => {
    const fs = await project({
      name: "proj",
      version: "2.0.0",
      scripts: { prebuild: "echo before", build: "node build.js", postbuild: "echo after", lint: "eslint ." },
    });
    const plan = await npmRunPlan(fs, "p", "build");
    expect(plan.steps).toEqual([
      { script: "prebuild", command: "echo before" },
      { script: "build", command: "node build.js" },
      { script: "postbuild", command: "echo after" },
    ]);
    expect(plan.env.npm_package_name).toBe("proj");
    expect(plan.env.npm_package_version).toBe("2.0.0");
    expect(plan.env.npm_lifecycle_event).toBe("build");
    expect((await npmRunPlan(fs, "p", "lint")).steps).toHaveLength(1);
    await expect(npmRunPlan(fs, "p", "nope")).rejects.toThrow(/package.json has prebuild, build/);
  });

  it("knows npm's two built-in defaults and no others", async () => {
    const fs = await project({ name: "proj", version: "1.0.0" }, { "server.js": "// a server" });
    expect((await npmRunPlan(fs, "p", "start")).steps[0]?.command).toBe("node server.js");
    expect((await npmRunPlan(fs, "p", "test")).steps[0]?.command).toContain("no test specified");
    const bare = await project({ name: "bare", version: "1.0.0" });
    await expect(npmRunPlan(bare, "p", "start")).rejects.toThrow(/no script named "start"/);
    await expect(readManifest(new MemoryFs(), "p")).rejects.toThrow(/no package.json/);
  });

  it("rewrites an argv into node + the bin shim, and leaves anything else alone", async () => {
    const registry = await fakeRegistry([{ name: "tool", version: "1.0.0", bin: { tool: "cli.js" }, files: { "cli.js": "// cli" } }], REGISTRY);
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { tool: "^1" } });
    await install(fs, "p", { registry: REGISTRY, fetch: registry.fetch });
    expect(await rewriteBinArgv(fs, "p", ["tool", "--watch"])).toEqual({
      argv: ["node", "p/node_modules/.bin/tool", "--watch"],
      bin: "p/node_modules/.bin/tool",
    });
    expect(await rewriteBinArgv(fs, "p", ["echo", "hi"])).toEqual({ argv: ["echo", "hi"], bin: null });
    expect(await rewriteBinArgv(fs, "p", ["./local.sh"])).toEqual({ argv: ["./local.sh"], bin: null });
    expect(await rewriteBinArgv(fs, "p", [])).toEqual({ argv: [], bin: null });
    expect(binDirectories("a/b/c", "a")).toEqual(["a/b/c/node_modules/.bin", "a/b/node_modules/.bin", "a/node_modules/.bin"]);
    expect(binDirectories("top")).toEqual(["top/node_modules/.bin"]);
  });

  it("lists what is on disk, at a depth, and names what is missing", async () => {
    const registry = await fakeRegistry(
      [
        { name: "outer", version: "1.0.0", dependencies: { inner: "^1" } },
        { name: "inner", version: "1.0.0" },
      ],
      REGISTRY,
    );
    const fs = await project({ name: "proj", version: "1.0.0", dependencies: { outer: "^1" } });
    await install(fs, "p", { registry: REGISTRY, fetch: registry.fetch });
    // The dependency added after the install is exactly the one `npm ls` should report as missing.
    await fs.writeFile(
      "p/package.json",
      encoder.encode(JSON.stringify({ name: "proj", version: "1.0.0", dependencies: { outer: "^1", "never-installed": "^1" } })),
    );
    const listing = await npmLs(fs, "p");
    expect(listing.root).toEqual({ name: "proj", version: "1.0.0" });
    expect(listing.entries.map((e) => e.name).sort()).toEqual(["inner", "outer"]);
    expect(listing.entries.every((e) => e.depth === 0)).toBe(true);
    expect(listing.missing).toEqual(["never-installed"]);
    expect((await npmLs(fs, "p", -1)).entries).toEqual([]);
    const empty = await project({ name: "empty", version: "1.0.0" });
    expect((await npmLs(empty, "p")).entries).toEqual([]);
  });
});
