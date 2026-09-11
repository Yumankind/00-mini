import { describe, expect, it } from "vitest";
import { hasEsmSyntax, maskSource, transformEsm } from "../src/loader/esm.js";

/** Run transformed CommonJS the way the loader does, with a `require` the test controls. */
function run(source: string, modules: Record<string, unknown> = {}, filename = "/m.js"): Record<string, unknown> {
  const { code } = transformEsm(source, filename);
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const require = (request: string): unknown => {
    if (!(request in modules)) throw new Error(`Cannot find module '${request}'`);
    return modules[request];
  };
  (require as unknown as { resolve(r: string): string }).resolve = (r: string) => r;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("exports", "require", "module", "__filename", code)(exports, require, module, filename);
  return module.exports as Record<string, unknown>;
}

describe("maskSource", () => {
  it("blanks string, template, regex and comment contents and keeps every index", () => {
    const source = `const a = "import x from 'y'";\n// export const b = 1\n/* import z */\nconst r = /ex\\/port/g;\nconst t = \`import q\`;\n`;
    const masked = maskSource(source);
    expect(masked).toHaveLength(source.length);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
    expect(masked).not.toContain("import x");
    expect(masked).not.toContain("export const b");
    expect(masked).not.toContain("import z");
    expect(masked).not.toContain("ex/port");
    expect(masked).not.toContain("import q");
    expect(masked).toContain("const a");
  });

  it("keeps the code inside a template's ${} expression, where a dynamic import can live", () => {
    const masked = maskSource("const t = `a${import('m')}b`;");
    expect(masked).toContain("import('m')");
  });

  it("does not mistake division for a regex after a closing paren or an identifier", () => {
    const masked = maskSource("const x = (a + b) / c / d;\nconst y = count / 2;\n");
    expect(masked).toContain("/ c / d");
    expect(masked).toContain("count / 2");
  });

  it("recovers when a slash that looked like a regex hits a newline", () => {
    const masked = maskSource("const a = 1;\nif (a) { b = a /\nc; }\n");
    expect(masked).toHaveLength("const a = 1;\nif (a) { b = a /\nc; }\n".length);
  });
});

describe("hasEsmSyntax", () => {
  it("finds module syntax at a statement start and nowhere else", () => {
    expect(hasEsmSyntax(`import a from "b";`)).toBe(true);
    expect(hasEsmSyntax(`export default 1;`)).toBe(true);
    expect(hasEsmSyntax(`console.log(import.meta.url);`)).toBe(true);
    expect(hasEsmSyntax(`const x = 1;\nexport { x };`)).toBe(true);
    expect(hasEsmSyntax(`const s = "export default";`)).toBe(false);
    expect(hasEsmSyntax(`obj.import = 1; obj.export = 2;`)).toBe(false);
    expect(hasEsmSyntax(`const m = await import("./x.js");`)).toBe(false);
    expect(hasEsmSyntax(`module.exports = 1;`)).toBe(false);
  });

  it("leaves a plain CommonJS file completely untouched", () => {
    const source = `const fs = require("fs");\nmodule.exports = { fs };\n`;
    const result = transformEsm(source, "/a.js");
    expect(result.transformed).toBe(false);
    expect(result.code).toBe(source);
  });
});

describe("transformEsm — imports", () => {
  it("handles every import clause shape", () => {
    const dep = { a: 1, b: 2 };
    const exports = run(
      `import "./side.js";
       import d from "m";
       import * as ns from "m";
       import d2, { a } from "m";
       import d3, * as ns2 from "m";
       import { a as renamed, b } from "m";
       export { d, ns, d2, a, d3, ns2, renamed, b };`,
      { "./side.js": {}, m: dep },
    );
    expect(exports.d).toBe(dep);
    expect((exports.ns as Record<string, unknown>).a).toBe(1);
    expect(exports.d2).toBe(dep);
    expect(exports.a).toBe(1);
    expect(exports.d3).toBe(dep);
    expect((exports.ns2 as Record<string, unknown>).b).toBe(2);
    expect(exports.renamed).toBe(1);
    expect(exports.b).toBe(2);
  });

  it("gives a CommonJS module's exports object as its default, and passes an ESM one through", () => {
    const cjs = { a: 1 };
    const esm = { __esModule: true, default: "real", a: 1 };
    const fromCjs = run(`import d, { a } from "m"; export { d, a };`, { m: cjs });
    expect(fromCjs.d).toBe(cjs);
    expect(fromCjs.a).toBe(1);
    const fromEsm = run(`import d from "m"; export { d };`, { m: esm });
    expect(fromEsm.d).toBe("real");
    // A null module is not a crash.
    const fromNull = run(`import d from "m"; export { d };`, { m: null });
    expect(fromNull.d).toBeNull();
  });

  it("spans lines and survives a comment inside the clause", () => {
    const exports = run(
      `import {
         a, // the first
         b as c
       } from "m";
       export { a, c };`,
      { m: { a: 1, b: 2 } },
    );
    expect(exports.a).toBe(1);
    expect(exports.c).toBe(2);
  });
});

describe("transformEsm — exports", () => {
  it("exports declarations of every kind, live", () => {
    const exports = run(
      `export const one = 1;
       export let two = 2;
       export var three = 3;
       export function four() { return 4; }
       export async function five() { return 5; }
       export function* six() { yield 6; }
       export class Seven { value() { return 7; } }
       two = 22;
       export default "the default";`,
    );
    expect(exports.one).toBe(1);
    expect(exports.two).toBe(22); // live: the getter reads the binding, not a copy taken at export time
    expect(exports.three).toBe(3);
    expect((exports.four as () => number)()).toBe(4);
    expect(exports.five).toBeTypeOf("function");
    expect(exports.six).toBeTypeOf("function");
    expect(new (exports.Seven as new () => { value(): number })().value()).toBe(7);
    expect(exports.default).toBe("the default");
    expect(exports.__esModule).toBe(true);
  });

  it("exports destructured and multi-declarator bindings", () => {
    const exports = run(
      `export const { a, b: renamed } = { a: 1, b: 2 };
       export const [first, second] = [3, 4];
       export const x = 5, y = 6;`,
    );
    expect(exports.a).toBe(1);
    expect(exports.renamed).toBe(2);
    expect(exports.first).toBe(3);
    expect(exports.second).toBe(4);
    expect(exports.x).toBe(5);
    expect(exports.y).toBe(6);
  });

  it("re-exports by name and by star", () => {
    const exports = run(
      `export { a, b as bee } from "m";
       export * from "n";
       export * as everything from "n";`,
      { m: { a: 1, b: 2 }, n: { c: 3, default: "ignored" } },
    );
    expect(exports.a).toBe(1);
    expect(exports.bee).toBe(2);
    expect(exports.c).toBe(3);
    // `export *` never re-exports a default, which is the rule in real ESM too.
    expect(Object.prototype.hasOwnProperty.call(exports, "default")).toBe(false);
    expect((exports.everything as Record<string, unknown>).c).toBe(3);
  });

  it("export default takes a function, a class or an expression", () => {
    expect(run(`export default function named() { return 1; }`).default).toBeTypeOf("function");
    expect(run(`export default class {}`).default).toBeTypeOf("function");
    expect(run(`export default { a: 1 };`).default).toEqual({ a: 1 });
  });
});

describe("transformEsm — import.meta and dynamic import", () => {
  it("fills import.meta from the filename", () => {
    const exports = run(`export const url = import.meta.url;
       export const file = import.meta.filename;
       export const dir = import.meta.dirname;
       export const resolved = import.meta.resolve("x");`, {}, "/a/b/c.js");
    expect(exports.url).toBe("file:///a/b/c.js");
    expect(exports.file).toBe("/a/b/c.js");
    expect(exports.dir).toBe("/a/b");
    expect(exports.resolved).toBe("x");
  });

  it("turns a dynamic import into a resolved promise over require", async () => {
    const exports = run(`export const load = () => import("m");`, { m: { a: 1 } });
    const loaded = (await (exports.load as () => Promise<Record<string, unknown>>)()) as Record<string, unknown>;
    expect(loaded.a).toBe(1);
    expect(loaded.default).toEqual({ a: 1 });
  });
});

describe("transformEsm — the limits it names", () => {
  it("refuses top-level await by name", () => {
    expect(() => transformEsm(`import a from "m";\nconst v = await a();`, "/tla.js")).toThrow(/top-level await/);
    // Inside a function it is ordinary code and passes through untouched.
    expect(() => transformEsm(`export async function f() { await 1; }`, "/ok.js")).not.toThrow();
  });

  it("takes a snapshot of an imported binding rather than a live view", () => {
    const source = { value: 1 };
    const exports = run(`import { value } from "m"; export const read = () => value;`, { m: source });
    source.value = 2;
    // Real ESM would report 2 here. This is limit 1 in the module's header, pinned.
    expect((exports.read as () => number)()).toBe(1);
  });

  it("counts each transform separately, so two modules cannot collide on a helper name", () => {
    const a = transformEsm(`export default 1;`, "/a.js").code;
    const b = transformEsm(`export default 2;`, "/b.js").code;
    const tagA = /__esm(\d+)ns/.exec(a)?.[1];
    const tagB = /__esm(\d+)ns/.exec(b)?.[1];
    expect(tagA).toBeDefined();
    expect(tagA).not.toBe(tagB);
  });

  it("reports what a module requires, in source order", () => {
    const result = transformEsm(`import "a";\nimport x from "b";\nexport { y } from "c";\nexport * from "d";`, "/r.js");
    expect(result.requires).toEqual(["a", "b", "c", "d"]);
    expect(result.transformed).toBe(true);
  });
});
