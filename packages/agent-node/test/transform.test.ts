import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLoader } from "../src/loader/index.js";
import { TransformCache, transformLoaderFor, isDeclarationFile, TRANSFORM_EXTENSIONS } from "../src/loader/transform.js";
import { createEsbuildTransformer, resetEsbuildForTests, type EsbuildApi } from "../src/transform/esbuild.js";
import { snap } from "./helpers.js";

// esbuild-wasm's NODE entry is what an `import("esbuild-wasm")` gets here, and it refuses the three
// browser-only options (wasmURL, wasmModule, worker) by name while needing none of them: it runs the
// wasm in a child process. `ready()` is what makes `transformSync` reachable, and `transformSync` is
// what lets the synchronous `require` in these tests transform on demand. A browser has neither and
// uses `loader.warmup` instead, which is tested below with a deliberately async-only transformer.
const transformer = createEsbuildTransformer();

beforeAll(async () => {
  await transformer.ready();
}, 120_000);

afterAll(async () => {
  await transformer.stop();
  resetEsbuildForTests();
});

describe("the transform seam", () => {
  it("names a loader for every extension it claims and nothing else", () => {
    expect(transformLoaderFor("/a/b.ts")).toBe("ts");
    expect(transformLoaderFor("/a/b.mts")).toBe("ts");
    expect(transformLoaderFor("/a/b.cts")).toBe("ts");
    expect(transformLoaderFor("/a/b.tsx")).toBe("tsx");
    expect(transformLoaderFor("/a/b.jsx")).toBe("jsx");
    // Extension-based on purpose: a .js file holding JSX is a bundler's problem, not this one's.
    expect(transformLoaderFor("/a/b.js")).toBeNull();
    expect(transformLoaderFor("/a/b.json")).toBeNull();
    expect(transformLoaderFor("/a/README")).toBeNull();
    expect(Object.keys(TRANSFORM_EXTENSIONS)).toHaveLength(5);
    expect(isDeclarationFile("/a/b.d.ts")).toBe(true);
    expect(isDeclarationFile("/a/b.ts")).toBe(false);
  });

  it("caches by path AND by the sha256 of the source, so a saved file is never served stale", () => {
    const cache = new TransformCache();
    cache.set("/a.ts", "const x = 1", { code: "1" });
    expect(cache.get("/a.ts", "const x = 1")?.code).toBe("1");
    expect(cache.get("/a.ts", "const x = 2")).toBeUndefined();
    expect(cache.get("/b.ts", "const x = 1")).toBeUndefined();
    expect(TransformCache.key("/a.ts", "abc")).toBe(`/a.ts\0${"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}`);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("refuses a .ts file BY NAME when the host configured no transform", () => {
    const loader = createLoader({ fs: snap({ "/app/index.ts": "export const x: number = 1;" }), cwd: "/app" });
    expect(() => loader.runMain("/app/index.ts")).toThrow(/the host did not provide a TypeScript transform/);
    try {
      loader.runMain("/app/index.ts");
    } catch (err) {
      expect((err as { code: string }).code).toBe("ERR_TRANSFORM_UNAVAILABLE");
      expect((err as Error).message).toContain("/app/index.ts");
    }
  });

  it("refuses a .d.ts, which is types and no runtime", () => {
    const loader = createLoader({ fs: snap({ "/app/t.d.ts": "export declare const x: number;" }), cwd: "/app", transformer });
    expect(() => loader.runMain("/app/t.d.ts")).toThrow(/type declarations only/);
  });
});

describe("TypeScript through the loader", () => {
  it("runs a .ts entry, strips the types and keeps the ESM semantics", () => {
    const loader = createLoader({
      fs: snap({
        "/app/index.ts": `import { greet } from "./greet";\ninterface Who { name: string }\nconst who: Who = { name: "world" };\nexport const message = greet(who.name);\n`,
        "/app/greet.ts": `export function greet(name: string): string { return \`hello \${name}\`; }\n`,
      }),
      cwd: "/app",
      transformer,
    });
    expect((loader.runMain("/app/index.ts") as { message: string }).message).toBe("hello world");
  });

  it("finds a.ts for require('./a') when there is no a.js, and prefers a.js when there is", () => {
    const loader = createLoader({
      fs: snap({
        "/app/index.ts": `export const both = [require("./only-ts").v, require("./both").v];`,
        "/app/only-ts.ts": `export const v: number = 1;`,
        "/app/both.js": `exports.v = "js";`,
        "/app/both.ts": `export const v = "ts";`,
      }),
      cwd: "/app",
      transformer,
    });
    // The compiled artefact wins over its own source: that is what every TypeScript runtime does.
    expect((loader.runMain("/app/index.ts") as { both: unknown[] }).both).toEqual([1, "js"]);
  });

  it("loads an npm package whose exports map points at a .ts source", () => {
    const loader = createLoader({
      fs: snap({
        "/app/index.js": `module.exports = require("tslib-ish").double(21);`,
        "/app/node_modules/tslib-ish/package.json": JSON.stringify({ name: "tslib-ish", exports: { ".": "./src/main.ts" } }),
        "/app/node_modules/tslib-ish/src/main.ts": `export function double(n: number): number { return n * 2; }\n`,
      }),
      cwd: "/app",
      root: "/app",
      transformer,
    });
    expect(loader.runMain("/app/index.js")).toBe(42);
  });

  it("lowers dynamic import() to a require the loader can resolve, and answers import.meta", async () => {
    const loader = createLoader({
      fs: snap({
        "/app/index.ts": `export const url = import.meta.url;\nexport const dir = import.meta.dirname;\nexport const later = import("./late").then((m) => m.n);\n`,
        "/app/late.ts": `export const n: number = 7;\n`,
      }),
      cwd: "/app",
      transformer,
    });
    const out = loader.runMain("/app/index.ts") as { url: string; dir: string; later: Promise<number> };
    expect(out.url).toBe("file:///app/index.ts");
    expect(out.dir).toBe("/app");
    await expect(out.later).resolves.toBe(7);
  });

  it("re-throws esbuild's top-level-await refusal under this package's own code", () => {
    const loader = createLoader({
      fs: snap({ "/app/index.ts": `const x = await Promise.resolve(1);\nexport default x;\n` }),
      cwd: "/app",
      transformer,
    });
    try {
      loader.runMain("/app/index.ts");
      expect.unreachable("a top-level await should have been refused");
    } catch (err) {
      expect((err as { code: string }).code).toBe("ERR_TOP_LEVEL_AWAIT");
      expect((err as Error).message).toContain("/app/index.ts");
    }
  });

  it("reports a syntax error against the file that has it", () => {
    const loader = createLoader({
      fs: snap({ "/app/bad.ts": `export const x: = ;` }),
      cwd: "/app",
      transformer,
    });
    try {
      loader.runMain("/app/bad.ts");
      expect.unreachable("a syntax error should have been refused");
    } catch (err) {
      expect((err as { code: string }).code).toBe("ERR_TRANSFORM_FAILED");
      expect((err as Error).message).toContain("/app/bad.ts");
    }
  });
});

describe("JSX", () => {
  const jsx = `export const tree = <div id="x">{"hi"}</div>;\n`;

  it("uses the classic runtime when the nearest package.json does not depend on react", () => {
    const calls: unknown[][] = [];
    const loader = createLoader({
      fs: snap({ "/app/package.json": JSON.stringify({ name: "app" }), "/app/view.jsx": jsx }),
      cwd: "/app",
      root: "/app",
      transformer,
      // The classic runtime compiles to React.createElement and expects a React in scope.
      globals: { React: { createElement: (...args: unknown[]) => (calls.push(args), "element") } },
    });
    expect((loader.runMain("/app/view.jsx") as { tree: unknown }).tree).toBe("element");
    expect(calls[0]?.[0]).toBe("div");
  });

  it("uses the automatic runtime when it does, importing react/jsx-runtime", () => {
    const loader = createLoader({
      fs: snap({
        "/app/package.json": JSON.stringify({ name: "app", dependencies: { react: "^18.0.0" } }),
        "/app/view.tsx": `type P = { id: string };\nconst props: P = { id: "x" };\nexport const tree = <div {...props}>hi</div>;\n`,
        "/app/node_modules/react/package.json": JSON.stringify({ name: "react", main: "./index.js" }),
        "/app/node_modules/react/index.js": `exports.createElement = () => "classic";`,
        "/app/node_modules/react/jsx-runtime.js": `exports.jsx = (type, props) => ({ type, props });`,
      }),
      cwd: "/app",
      root: "/app",
      transformer,
    });
    const out = loader.runMain("/app/view.tsx") as { tree: { type: string; props: { id: string } } };
    expect(out.tree.type).toBe("div");
    expect(out.tree.props.id).toBe("x");
  });
});

describe("warmup — the road a browser has to take", () => {
  /** esbuild's browser build has no transformSync, so this is what the loader sees in a tab. */
  const asyncOnly = {
    transform: (source: string, opts: Parameters<typeof transformer.transform>[1]) => transformer.transform(source, opts),
  };

  const files = {
    "/app/index.ts": `const dep = require("./dep");\nimport { n } from "./mid";\nexport const total: number = dep.d + n;\n`,
    "/app/dep.ts": `export const d: number = 1;\n`,
    "/app/mid.js": `const deep = require("./deep");\nmodule.exports = { n: deep.n };\n`,
    "/app/deep.tsx": `export const n: number = 2;\n`,
  };

  it("refuses by name before a warmup and works after it", async () => {
    const loader = createLoader({ fs: snap(files), cwd: "/app", transformer: asyncOnly });
    try {
      loader.runMain("/app/index.ts");
      expect.unreachable("an untransformed .ts should not have run");
    } catch (err) {
      expect((err as { code: string }).code).toBe("ERR_TRANSFORM_PENDING");
      expect((err as Error).message).toContain("/app/index.ts");
    }
    // The walk follows require() through a plain .js file to the .tsx on the other side of it.
    const warmed = await loader.warmup("/app/index.ts");
    expect(warmed.sort()).toEqual(["/app/deep.tsx", "/app/dep.ts", "/app/index.ts"]);
    expect((loader.runMain("/app/index.ts") as { total: number }).total).toBe(3);
  });

  it("runMainAsync is warmup then runMain", async () => {
    const loader = createLoader({ fs: snap(files), cwd: "/app", transformer: asyncOnly });
    expect(((await loader.runMainAsync("/app/index.ts")) as { total: number }).total).toBe(3);
  });

  it("a second warmup transforms nothing, because the cache is keyed by content", async () => {
    const loader = createLoader({ fs: snap(files), cwd: "/app", transformer: asyncOnly });
    expect((await loader.warmup("/app/index.ts")).length).toBe(3);
    expect(await loader.warmup("/app/index.ts")).toEqual([]);
    expect(loader.transformCache.size).toBe(3);
  });

  it("shares one cache between loaders when the host passes one in", async () => {
    const transformCache = new TransformCache();
    const first = createLoader({ fs: snap(files), cwd: "/app", transformer: asyncOnly, transformCache });
    await first.warmup("/app/index.ts");
    const second = createLoader({ fs: snap(files), cwd: "/app", transformer: null, transformCache });
    // No transformer at all on the second loader, and it still runs: the cache is the whole road.
    expect((second.runMain("/app/index.ts") as { total: number }).total).toBe(3);
  });

  it("skips what it cannot resolve rather than throwing, and refuses by name with no transformer", async () => {
    const loader = createLoader({
      fs: snap({
        "/app/index.js": `const name = "./" + process.argv[2];\nrequire("node:path");\nrequire("./gone");\nmodule.exports = require(name);\n`,
        "/app/real.js": `module.exports = 1;`,
      }),
      cwd: "/app",
    });
    await expect(loader.warmup("/app/index.js")).resolves.toEqual([]);
    const bare = createLoader({ fs: snap({ "/app/index.ts": `export const x: number = 1;` }), cwd: "/app" });
    await expect(bare.warmup("/app/index.ts")).rejects.toThrow(/ERR_TRANSFORM_UNAVAILABLE|did not provide/);
  });
});

describe("createEsbuildTransformer", () => {
  it("asks for an inline source map only when told to", async () => {
    const plain = createEsbuildTransformer();
    const mapped = createEsbuildTransformer({ sourcemap: true });
    const source = "export const x: number = 1;\n";
    const request = { path: "/app/x.ts", loader: "ts", format: "cjs" } as const;
    expect((await plain.transform(source, request)).code).not.toContain("sourceMappingURL");
    expect((await mapped.transform(source, request)).code).toContain("sourceMappingURL=data:application/json;base64,");
  });

  it("serves a repeat transform out of its own cache", async () => {
    const t = createEsbuildTransformer();
    const request = { path: "/app/y.ts", loader: "ts", format: "cjs" } as const;
    const first = await t.transform("export const y: number = 1;\n", request);
    const second = await t.transform("export const y: number = 1;\n", request);
    expect(second).toBe(first);
    expect(t.cache.size).toBe(1);
  });

  it("names the missing wasm when a browser-shaped esbuild has none", async () => {
    resetEsbuildForTests();
    const browserish: EsbuildApi = {
      initialize: () => Promise.reject(new Error('Must provide either the "wasmURL" option or the "wasmModule" option')),
      transform: () => Promise.reject(new Error("unreachable")),
    };
    const t = createEsbuildTransformer({ load: async () => browserish });
    await expect(t.ready()).rejects.toThrow(/esbuild\.wasm/);
    try {
      await t.ready();
    } catch (err) {
      expect((err as { code: string }).code).toBe("ERR_ESBUILD_WASM_MISSING");
    }
    resetEsbuildForTests();
  });

  it("falls back to a bare initialize when the entry refuses the browser-only options", async () => {
    resetEsbuildForTests();
    const seen: Record<string, unknown>[] = [];
    const nodeish: EsbuildApi = {
      initialize: (options) => {
        seen.push(options);
        if (options.wasmURL) return Promise.reject(new Error('The "wasmURL" option only works in the browser'));
        return Promise.resolve();
      },
      transform: () => Promise.resolve({ code: "ok", map: "" }),
    };
    const t = createEsbuildTransformer({ wasmURL: "/esbuild/0.25.9/esbuild.wasm", load: async () => nodeish });
    expect((await t.transform("x", { path: "/a.ts", loader: "ts", format: "cjs" })).code).toBe("ok");
    expect(seen).toEqual([{ wasmURL: "/esbuild/0.25.9/esbuild.wasm" }, {}]);
    resetEsbuildForTests();
  });

  it("refuses a synchronous transform in a browser, where esbuild has none", async () => {
    resetEsbuildForTests();
    const browserish: EsbuildApi = {
      initialize: () => Promise.resolve(),
      transform: () => Promise.resolve({ code: "ok", map: "" }),
    };
    const t = createEsbuildTransformer({ wasmURL: "/esbuild/0.25.9/esbuild.wasm", load: async () => browserish });
    await t.ready();
    expect(() => t.transformSync?.("x", { path: "/a.ts", loader: "ts", format: "cjs" })).toThrow(/only works in node/);
    // A second transformer with different options gets the wasm that is already up, and says so.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const second = createEsbuildTransformer({ wasmURL: "/other.wasm", load: async () => browserish });
    await second.ready();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("one initialize per module instance"));
    warn.mockRestore();
    // A cached entry is served without ever reaching esbuild, sync or not.
    const request = { path: "/a.ts", loader: "ts", format: "cjs" } as const;
    const cached = await t.transform("cache me", request);
    expect(t.transformSync?.("cache me", request)).toBe(cached);
    resetEsbuildForTests();
  });

  it("refuses a synchronous transform before it has started, naming ready()", () => {
    resetEsbuildForTests();
    const t = createEsbuildTransformer();
    expect(() => t.transformSync?.("x", { path: "/a.ts", loader: "ts", format: "cjs" })).toThrow(/ready\(\)/);
    resetEsbuildForTests();
  });

  it("passes the browser's wasmURL and worker through to initialize", async () => {
    resetEsbuildForTests();
    const seen: Record<string, unknown>[] = [];
    const browserish: EsbuildApi = {
      initialize: (options) => {
        seen.push(options);
        return Promise.resolve();
      },
      transform: () => Promise.resolve({ code: "ok", map: "" }),
    };
    const t = createEsbuildTransformer({ wasmURL: "/esbuild/0.25.9/esbuild.wasm", worker: false, load: async () => browserish });
    await t.ready();
    expect(seen).toEqual([{ wasmURL: "/esbuild/0.25.9/esbuild.wasm", worker: false }]);
    await t.stop();
    resetEsbuildForTests();
  });
});
