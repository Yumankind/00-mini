import { describe, expect, it } from "vitest";
import { createLoader, snapshotLoaderFs, backendLoaderFs, type LoaderFs } from "../src/loader/index.js";
import { nodeModulesPaths, resolveExports, splitBareRequest, EMPTY_MODULE, applyBrowserMap, findPackageDir, type ResolveHost } from "../src/loader/resolve.js";
import { memoryBackend, snap } from "./helpers.js";

/**
 * The fixture tree, which exists to be awkward on purpose: a plain package, a scoped one with an
 * `exports` map and a `./*` pattern, a package with a `browser` map (including a `false`), a
 * `"type": "module"` package, a cycle, a JSON file and a deep nested `node_modules` that only a real
 * walk finds.
 */
const files: Record<string, string> = {
  "/app.js": `
    const util = require("./lib/util");
    const data = require("./data.json");
    module.exports = { sum: util.sum(2, 3), name: data.name, dir: __dirname, file: __filename };
  `,
  "/lib/util.js": `exports.sum = (a, b) => a + b;`,
  "/lib/index.js": `module.exports = "the lib index";`,
  "/data.json": `{ "name": "fixture" }`,

  "/cycle/a.js": `exports.name = "a"; const b = require("./b"); exports.sawB = b.name; exports.bSawA = b.sawA;`,
  "/cycle/b.js": `const a = require("./a"); exports.name = "b"; exports.sawA = a.name;`,

  "/node_modules/plain/package.json": `{ "name": "plain", "version": "1.0.0", "main": "lib/main.js" }`,
  "/node_modules/plain/lib/main.js": `module.exports = { who: "plain" };`,
  "/node_modules/plain/extra.js": `module.exports = "plain extra";`,

  "/node_modules/@scope/pkg/package.json": JSON.stringify({
    name: "@scope/pkg",
    version: "2.0.0",
    main: "./dist/node.js",
    exports: {
      ".": { browser: "./dist/browser.js", require: "./dist/node.js", default: "./dist/node.js" },
      "./feature": "./dist/feature.js",
      "./deep/*": "./dist/deep/*.js",
      "./blocked": null,
      "./array": ["./dist/missing.js", "./dist/feature.js"],
    },
  }),
  "/node_modules/@scope/pkg/dist/browser.js": `module.exports = "the browser build";`,
  "/node_modules/@scope/pkg/dist/node.js": `module.exports = "the node build";`,
  "/node_modules/@scope/pkg/dist/feature.js": `module.exports = "the feature";`,
  "/node_modules/@scope/pkg/dist/deep/thing.js": `module.exports = "a deep thing";`,

  "/node_modules/mapped/package.json": JSON.stringify({
    name: "mapped",
    version: "1.0.0",
    main: "index.js",
    browser: { "./impl.js": "./impl.browser.js", fs: false, plain: "./vendored.js" },
  }),
  "/node_modules/mapped/index.js": `module.exports = { impl: require("./impl.js"), fs: require("fs"), plain: require("plain") };`,
  "/node_modules/mapped/impl.js": `module.exports = "the node impl";`,
  "/node_modules/mapped/impl.browser.js": `module.exports = "the browser impl";`,
  "/node_modules/mapped/vendored.js": `module.exports = "vendored plain";`,

  "/node_modules/esmpkg/package.json": `{ "name": "esmpkg", "version": "1.0.0", "type": "module", "main": "index.js" }`,
  "/node_modules/esmpkg/index.js": `export const greeting = "hello from esm"; export default greeting.length;`,

  "/node_modules/imports-pkg/package.json": JSON.stringify({
    name: "imports-pkg",
    version: "1.0.0",
    main: "index.js",
    imports: { "#internal": "./internal.js", "#deep/*": "./parts/*.js" },
  }),
  "/node_modules/imports-pkg/index.js": `module.exports = { a: require("#internal"), b: require("#deep/one") };`,
  "/node_modules/imports-pkg/internal.js": `module.exports = "internal";`,
  "/node_modules/imports-pkg/parts/one.js": `module.exports = "part one";`,

  "/node_modules/outer/package.json": `{ "name": "outer", "version": "1.0.0", "main": "index.js" }`,
  "/node_modules/outer/index.js": `module.exports = require("nested");`,
  "/node_modules/outer/node_modules/nested/package.json": `{ "name": "nested", "version": "1.0.0" }`,
  "/node_modules/outer/node_modules/nested/index.js": `module.exports = "the nested copy";`,

  "/node_modules/native/package.json": `{ "name": "native", "version": "1.0.0", "main": "binding.node" }`,
  "/node_modules/native/binding.node": `not javascript`,

  "/esm/main.mjs": `
    import { sum } from "./helper.mjs";
    import data from "../data.json";
    export const total = sum(1, 2);
    export const name = data.name;
    export const here = import.meta.url;
    export async function later() { const m = await import("./helper.mjs"); return m.sum(3, 4); }
  `,
  "/esm/helper.mjs": `export function sum(a, b) { return a + b; }`,

  "/globals.js": `module.exports = { hasBuffer: typeof Buffer === "function", pid: process.pid, extra: typeof injected === "string" ? injected : null };`,
  "/throws.js": `throw new Error("this module refuses to load");`,
};

function loader(overrides: Record<string, unknown> = {}, fs: LoaderFs = snap(files)) {
  const lines: string[] = [];
  return {
    lines,
    loader: createLoader({
      fs,
      cwd: "/",
      root: "/",
      stdout: (t) => lines.push(t),
      stderr: (t) => lines.push(`!${t}`),
      ...overrides,
    }),
  };
}

describe("nodeModulesPaths", () => {
  it("walks up to the workspace root and no further", () => {
    expect(nodeModulesPaths("/a/b/c", "/")).toEqual(["/a/b/c/node_modules", "/a/b/node_modules", "/a/node_modules", "/node_modules"]);
    expect(nodeModulesPaths("/", "/")).toEqual(["/node_modules"]);
    expect(nodeModulesPaths("/w/p/x", "/w")).toEqual(["/w/p/x/node_modules", "/w/p/node_modules", "/w/node_modules"]);
    // A directory that IS a node_modules does not get a `node_modules/node_modules` candidate.
    expect(nodeModulesPaths("/a/node_modules", "/")).toEqual(["/a/node_modules", "/node_modules"]);
  });
});

describe("splitBareRequest", () => {
  it("keeps a scope with its name", () => {
    expect(splitBareRequest("lodash")).toEqual({ name: "lodash", subpath: "." });
    expect(splitBareRequest("lodash/fp")).toEqual({ name: "lodash", subpath: "./fp" });
    expect(splitBareRequest("@scope/pkg")).toEqual({ name: "@scope/pkg", subpath: "." });
    expect(splitBareRequest("@scope/pkg/deep/x")).toEqual({ name: "@scope/pkg", subpath: "./deep/x" });
  });
});

describe("require — the CommonJS half", () => {
  it("resolves relative files, the extension ladder, index.js and JSON", () => {
    const { loader: l } = loader();
    const app = l.require("/app.js") as Record<string, unknown>;
    expect(app.sum).toBe(5);
    expect(app.name).toBe("fixture");
    expect(app.dir).toBe("/");
    expect(app.file).toBe("/app.js");
    expect(l.require("./lib")).toBe("the lib index");
    expect(l.require("./data.json")).toEqual({ name: "fixture" });
  });

  it("caches a module and runs it once", () => {
    const { loader: l } = loader();
    expect(l.require("./lib/util")).toBe(l.require("./lib/util"));
    expect(l.cache.has("/lib/util.js")).toBe(true);
  });

  it("survives a cycle by caching before it runs", () => {
    const { loader: l } = loader();
    const a = l.require("/cycle/a.js") as Record<string, unknown>;
    expect(a.name).toBe("a");
    expect(a.sawB).toBe("b");
    // b required a while a was half-built: it saw the name, which was set before the require.
    expect(a.bSawA).toBe("a");
  });

  it("walks node_modules for a bare request, up to the root", () => {
    const { loader: l } = loader();
    expect(l.require("plain")).toEqual({ who: "plain" });
    expect(l.require("plain/extra")).toBe("plain extra");
    expect(l.require("plain/extra.js")).toBe("plain extra");
  });

  it("finds a nested copy from the package that owns it", () => {
    const { loader: l } = loader();
    expect(l.require("outer")).toBe("the nested copy");
  });

  it("honours an exports map, its conditions, its patterns, its arrays and its blocks", () => {
    const { loader: browser } = loader();
    expect(browser.require("@scope/pkg")).toBe("the browser build");
    expect(browser.require("@scope/pkg/feature")).toBe("the feature");
    expect(browser.require("@scope/pkg/deep/thing")).toBe("a deep thing");
    // An array target takes the first alternative that is actually there.
    expect(browser.require("@scope/pkg/array")).toBe("the feature");
    expect(() => browser.require("@scope/pkg/blocked")).toThrow(/not defined by "exports"/);
    // `exports` hides everything it does not name, even a file that exists.
    expect(() => browser.require("@scope/pkg/dist/node.js")).toThrow(/not defined by "exports"/);

    const { loader: node } = loader({ conditions: ["node", "require", "default"] });
    expect(node.require("@scope/pkg")).toBe("the node build");
  });

  it("honours the browser field map, including a false for 'this is empty in a browser'", () => {
    const { loader: l } = loader();
    const mapped = l.require("mapped") as Record<string, unknown>;
    expect(mapped.impl).toBe("the browser impl");
    expect(mapped.fs).toEqual({});
    expect(mapped.plain).toBe("vendored plain");

    // Without the browser condition the same package loads its node halves.
    const { loader: node } = loader({ conditions: ["node", "require", "default"] });
    const plain = node.require("mapped") as Record<string, unknown>;
    expect(plain.impl).toBe("the node impl");
  });

  it("resolves a package's own #imports", () => {
    const { loader: l } = loader();
    expect(l.require("imports-pkg")).toEqual({ a: "internal", b: "part one" });
  });

  it("refuses a native addon by name", () => {
    const { loader: l } = loader();
    expect(() => l.require("native")).toThrow(/native addon/);
  });

  it("says how to fix a missing package, and names the directory for a missing file", () => {
    const { loader: l } = loader();
    expect(() => l.require("express")).toThrow(/npm install express/);
    expect(() => l.require("./nope.js")).toThrow(/Cannot find module '\.\/nope\.js'/);
  });

  it("does not leave a half-built module in the cache when one throws", () => {
    const { loader: l } = loader();
    expect(() => l.require("/throws.js")).toThrow(/refuses to load/);
    expect(l.cache.has("/throws.js")).toBe(false);
    expect(() => l.require("/throws.js")).toThrow(/refuses to load/);
  });

  it("gives every module the globals a Worker lacks, plus whatever the host injects", () => {
    const { loader: l } = loader({ globals: { injected: "from the host" } });
    const globals = l.require("/globals.js") as Record<string, unknown>;
    expect(globals.hasBuffer).toBe(true);
    expect(globals.pid).toBe(1);
    expect(globals.extra).toBe("from the host");
  });

  it("answers builtins before it ever looks at the filesystem, with or without node:", () => {
    const { loader: l } = loader();
    expect(l.require("path")).toBe(l.require("node:path"));
    expect((l.require("os") as { EOL: string }).EOL).toBe("\n");
    expect(l.builtin("path")).toBeDefined();
    expect(l.builtin("express")).toBeUndefined();
  });

  it("lets the host override or add a builtin", () => {
    const { loader: l } = loader({ builtins: { fs: { mine: true }, "my-host-api": { hello: 1 } } });
    expect(l.require("fs")).toEqual({ mine: true });
    expect(l.require("node:fs")).toEqual({ mine: true });
    expect(l.require("my-host-api")).toEqual({ hello: 1 });
  });
});

describe("require.resolve, module.paths and require.cache", () => {
  it("resolves without loading, and reports the paths it would search", () => {
    const { loader: l } = loader();
    expect(l.require.resolve("./lib/util")).toBe("/lib/util.js");
    expect(l.require.resolve("plain")).toBe("/node_modules/plain/lib/main.js");
    expect(l.require.resolve("path")).toBe("path");
    expect(l.require.resolve.paths("plain")).toEqual(["/node_modules"]);
    expect(l.require.resolve.paths("./x")).toEqual([]);
    expect(l.require.resolve("plain", { paths: ["/"] })).toBe("/node_modules/plain/lib/main.js");
    expect(() => l.require.resolve("nope", { paths: ["/"] })).toThrow(/Cannot find module/);
    expect(l.cache.has("/lib/util.js")).toBe(false);
    expect(l.resolve("./lib/util", "/")).toBe("/lib/util.js");
  });

  it("gives a module the Node shape: paths, children, parent and a deletable cache entry", () => {
    const { loader: l } = loader();
    l.require("/app.js");
    const cached = l.cache.get("/app.js");
    expect(cached?.paths).toEqual(["/node_modules"]);
    expect(cached?.children.map((c) => c.filename)).toEqual(["/lib/util.js", "/data.json"]);
    expect(cached?.children[0]?.parent?.filename).toBe("/app.js");
    expect(l.require.cache["/app.js"]).toBe(cached);
    expect("/app.js" in l.require.cache).toBe(true);
    expect(Object.keys(l.require.cache)).toContain("/lib/util.js");
    delete l.require.cache["/app.js"];
    expect(l.cache.has("/app.js")).toBe(false);
    l.require.cache["/fake.js"] = cached!;
    expect(l.cache.get("/fake.js")).toBe(cached);
  });

  it("runMain sets argv[1] and require.main", () => {
    const { loader: l } = loader();
    const exports = l.runMain("/app.js", ["--flag"]) as Record<string, unknown>;
    expect(exports.sum).toBe(5);
    expect(l.process.argv).toEqual(["node", "/app.js", "--flag"]);
    expect(l.require.main?.filename).toBe("/app.js");
    // A relative entry resolves against the loader's cwd.
    expect(loader().loader.runMain("./lib/util.js")).toHaveProperty("sum");
  });
});

describe("require — the ESM half", () => {
  it("loads .mjs, its named and default exports, import.meta and a dynamic import", async () => {
    const { loader: l } = loader();
    const main = l.require("/esm/main.mjs") as Record<string, unknown>;
    expect(main.total).toBe(3);
    expect(main.name).toBe("fixture");
    expect(main.here).toBe("file:///esm/main.mjs");
    expect(main.__esModule).toBe(true);
    expect(await (main.later as () => Promise<number>)()).toBe(7);
  });

  it("treats a .js file under a type:module package as ESM", () => {
    const { loader: l } = loader();
    const pkg = l.require("esmpkg") as Record<string, unknown>;
    expect(pkg.greeting).toBe("hello from esm");
    expect(pkg.default).toBe("hello from esm".length);
  });
});

describe("the two synchronous filesystems a loader can be given", () => {
  it("the snapshot answers from what it was handed, and says so when it was not handed something", () => {
    const fs = snapshotLoaderFs({ "/a.js": new TextEncoder().encode("module.exports = 1;") });
    expect(fs.statSync("/a.js")?.isFile()).toBe(true);
    expect(fs.statSync("/")?.isDirectory()).toBe(true);
    expect(fs.statSync("/nope")).toBeNull();
    expect(() => fs.readFileSync("/nope")).toThrow(/folder snapshot/);
  });

  it("the backend one refuses with the isolation sentence when there is no channel", async () => {
    const { backend } = await memoryBackend({ "/a.js": "module.exports = 1;" });
    const fs = backendLoaderFs(backend);
    expect(() => fs.readFileSync("/a.js")).toThrow(/cross-origin isolation/);
    expect(() => fs.statSync("/a.js")).toThrow(/cross-origin isolation/);
  });
});

describe("resolve internals", () => {
  const host: ResolveHost = {
    isFile: (p) => p.endsWith(".js") && !p.includes("missing"),
    isDirectory: () => false,
    readJson: () => null,
    root: "/",
    conditions: ["browser", "require", "default"],
  };

  it("resolveExports handles the sugar, the map, the conditions and a non-relative target", () => {
    expect(resolveExports(undefined, ".", "/p", host)).toBeUndefined();
    expect(resolveExports("./a.js", ".", "/p", host)).toBe("/p/a.js");
    expect(resolveExports("./a.js", "./sub", "/p", host)).toBeUndefined();
    expect(resolveExports({ browser: "./b.js", default: "./d.js" }, ".", "/p", host)).toBe("/p/b.js");
    expect(resolveExports({ node: "./n.js" }, ".", "/p", host)).toBeNull();
    // An external target ("other-pkg/x") is not a file in this package, so it does not resolve here.
    expect(resolveExports({ ".": "other/x.js" }, ".", "/p", host)).toBeNull();
    expect(resolveExports({ "./a/*": "./src/*.js" }, "./a/deep/x", "/p", host)).toBe("/p/src/deep/x.js");
    // The longest matching pattern wins, which is Node's rule.
    expect(resolveExports({ "./*": "./short/*.js", "./a/*": "./long/*.js" }, "./a/x", "/p", host)).toBe("/p/long/x.js");
    expect(resolveExports({ "./a": "./a.js" }, "./b", "/p", host)).toBeUndefined();
    expect(resolveExports({ ".": [{ browser: "./b.js" }] }, ".", "/p", host)).toBe("/p/b.js");
    expect(resolveExports({ ".": 42 }, ".", "/p", host)).toBeNull();
  });

  it("the browser map is inert without the browser condition and without a package.json", () => {
    const noBrowser: ResolveHost = { ...host, conditions: ["node"] };
    expect(applyBrowserMap("fs", "/p", noBrowser)).toBeNull();
    expect(applyBrowserMap("fs", "/p", host)).toBeNull();
    expect(findPackageDir("/a/b", host)).toBeNull();
  });

  it("EMPTY_MODULE resolves to an empty exports object rather than a throw", () => {
    const { loader: l } = loader();
    expect(l.require("mapped")).toBeDefined();
    expect(EMPTY_MODULE).toBe("\0empty");
  });
});
