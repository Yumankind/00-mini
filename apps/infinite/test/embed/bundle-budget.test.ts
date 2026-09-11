/**
 * THE PIN ON WHAT A VISITOR DOWNLOADS (§5.2, §10).
 *
 * `dist/embed/e.js` is one script on somebody else's website, fetched on every page load of every
 * site running the embed, and the whole product at level 0: search the site, open a page, have a
 * control outlined. On 2026-09-11 it was 167.7 KB raw / 56.7 KB gzipped, and the source map said why
 * — the agent runtime, agent-fs (git included), the owner's setup wizard and the registry client
 * were all in it, none of which a visitor at level 0 can reach.
 *
 * They are lazy modules now (`embed/src/modules.ts`). THIS TEST IS WHAT KEEPS THEM THERE, and it is
 * static on purpose: running the real vite build takes seconds and needs a disk, so instead it walks
 * the IMPORT GRAPH from `loader.ts` exactly as a bundler would — following relative imports, ignoring
 * `import type` (erased before a byte is emitted) — and fails if anything the split removed can be
 * reached again. A regression here is a value import someone added, and the message names the path.
 *
 * The counterpart at build time is the source map: `npx vite build --config vite.embed.config.ts
 * --sourcemap` and then check that no `packages/` source is listed in `e.js.map`. That check and
 * this one must agree; if they ever do not, this parser is what is wrong.
 */

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "../..");
const ENTRY = resolve(appRoot, "embed/src/loader.ts");

/** The four the embed must not carry at level 0. A `import type` from any of them is fine. */
const FORBIDDEN_PACKAGES = ["@00/agent-runtime", "@00/agent-fs", "@00/agent-models", "@00/shared"];

/** The modules that MOVED, by path. Reaching one of these from the loader is the regression. */
const LAZY_ONLY = [
  "embed/src/brain-impl.ts",
  "embed/src/model-entry.ts",
  "embed/src/panel/setup.ts",
  "embed/src/panel/setup-model.ts",
  "embed/src/panel/wizard-model.ts",
  "embed/src/registry/client.ts",
  "embed/src/registry/device.ts",
  "embed/src/registry/bundle.ts",
  "embed/src/entries/brain.ts",
  "embed/src/entries/setup.ts",
  "embed/src/entries/registry.ts",
];

interface Edge {
  specifier: string;
  typeOnly: boolean;
}

/** Comments out, so a sentence about an import in a header is not read as one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every static import and re-export of one file, and whether it is TYPE-ONLY — which is the whole
 * question, because a type is erased and costs nothing while a value is bytes.
 */
export function edgesOf(source: string): Edge[] {
  const clean = stripComments(source);
  const edges: Edge[] = [];
  // `[^;]` on purpose: a clause never contains a semicolon, and without it a side-effect import
  // (`import "./x.js";`) swallows the next statement's `from` and reads as one long clause.
  for (const m of clean.matchAll(/\b(?:import|export)\s+([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = m[1]!.trim();
    const specifier = m[2]!;
    // `import type { X }` / `export type { X }` — erased whole.
    if (/^type\b/.test(clause)) {
      edges.push({ specifier, typeOnly: true });
      continue;
    }
    const braces = /^\{([\s\S]*)\}$/.exec(clause);
    if (braces) {
      const members = braces[1]!.split(",").map((s) => s.trim()).filter(Boolean);
      // `{ type A, type B }` is as erased as `import type` is; one bare member makes it a value.
      const allTypes = members.length > 0 && members.every((s) => /^type\b/.test(s));
      edges.push({ specifier, typeOnly: allTypes });
      continue;
    }
    edges.push({ specifier, typeOnly: false });
  }
  // A bare `import "x";` is a side effect, and side effects are bytes.
  for (const m of clean.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']\s*;/g)) {
    edges.push({ specifier: m[1]!, typeOnly: false });
  }
  return edges;
}

interface Walk {
  files: string[];
  bare: Map<string, string[]>;
}

/** What a bundler would pull in, following VALUE imports only, from one entry. */
function walkFrom(entry: string): Walk {
  const seen = new Set<string>();
  const bare = new Map<string, string[]>();
  const queue: { file: string; via: string[] }[] = [{ file: entry, via: [] }];
  while (queue.length) {
    const { file, via } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const trail = [...via, relative(appRoot, file)];
    for (const edge of edgesOf(readFileSync(file, "utf8"))) {
      if (edge.typeOnly) continue;
      if (!edge.specifier.startsWith(".")) {
        if (!bare.has(edge.specifier)) bare.set(edge.specifier, trail);
        continue;
      }
      queue.push({ file: resolve(dirname(file), edge.specifier.replace(/\.js$/, ".ts")), via: trail });
    }
  }
  return { files: [...seen].map((f) => relative(appRoot, f)), bare };
}

describe("the embed core, as a bundler would build it", () => {
  const walk = walkFrom(ENTRY);

  it("reaches the modules level 0 actually needs, so the walk is a walk and not a typo", () => {
    // A parser that silently matched nothing would pass every assertion below it.
    expect(walk.files.length).toBeGreaterThan(20);
    for (const needed of [
      "embed/src/loader.ts",
      "embed/src/panel/panel.ts",
      "embed/src/crawl/crawler.ts",
      "embed/src/index/site-index.ts",
      "embed/src/tools/index.ts",
      "src/mini/mini-css.ts",
    ]) {
      expect(walk.files, needed).toContain(needed);
    }
  });

  it("imports NOTHING from the four packages except as a type", () => {
    for (const pkg of FORBIDDEN_PACKAGES) {
      const via = walk.bare.get(pkg);
      expect(via ? `${pkg} reached through ${via.join(" → ")}` : "none", pkg).toBe("none");
    }
    // Nor a deep path into one of them, which would dodge the exact-name check above.
    for (const specifier of walk.bare.keys()) {
      expect(FORBIDDEN_PACKAGES.some((p) => specifier.startsWith(`${p}/`)), specifier).toBe(false);
    }
  });

  it("cannot reach the brain, the wizard or the registry client", () => {
    for (const lazy of LAZY_ONLY) expect(walk.files, lazy).not.toContain(lazy);
  });

  it("keeps the markdown highlighter out of the panel's path", () => {
    // `markdown-lite.ts` still imports `lib/highlight.ts` for the APP's renderer, and the panel uses
    // `renderMarkdownPlain`, which does not — so the bundler drops the 9 KB tokeniser as dead code.
    // The edge is real, which is why this is asserted at the CALL and not at the import.
    const panel = readFileSync(resolve(appRoot, "embed/src/panel/panel.ts"), "utf8");
    expect(panel).toContain("renderMarkdownPlain");
    expect(panel).not.toMatch(/\brenderMarkdown\(/);
  });

  it("keeps every lazy module behind the one loader in modules.ts", () => {
    const modules = readFileSync(resolve(appRoot, "embed/src/modules.ts"), "utf8");
    for (const name of ["/m/brain.js", "/m/setup.js", "/m/registry.js"]) {
      expect(modules, name).toContain(name);
    }
    // The specifier must stay computed, or the bundler resolves it and inlines what it points at.
    expect(modules).toContain("@vite-ignore");
  });
});

describe("the lazy modules, as their own bundles", () => {
  it("each entry pulls its own half and nothing of the others", () => {
    const brain = walkFrom(resolve(appRoot, "embed/src/entries/brain.ts"));
    expect(brain.bare.has("@00/agent-runtime")).toBe(true);
    expect(brain.bare.has("@00/agent-models")).toBe(true);
    expect(brain.files).not.toContain("embed/src/panel/setup.ts");
    expect(brain.files).not.toContain("embed/src/registry/client.ts");

    const setup = walkFrom(resolve(appRoot, "embed/src/entries/setup.ts"));
    expect(setup.files).toContain("embed/src/panel/setup.ts");
    expect(setup.bare.has("@00/agent-runtime")).toBe(false);

    const registry = walkFrom(resolve(appRoot, "embed/src/entries/registry.ts"));
    expect(registry.files).toContain("embed/src/registry/client.ts");
    expect(registry.files).toContain("embed/src/registry/device.ts");
    expect(registry.bare.size).toBe(0);
  });
});

describe("the edge reader itself", () => {
  it("tells a type import from a value one", () => {
    const source = [
      'import type { A } from "./a.js";',
      'import { type B, c } from "./b.js";',
      'import { type D, type E } from "./d.js";',
      'import "./side.js";',
      'export type { F } from "./f.js";',
      'export { g } from "./g.js";',
    ].join("\n");
    const byName = Object.fromEntries(edgesOf(source).map((e) => [e.specifier, e.typeOnly]));
    expect(byName).toEqual({
      "./a.js": true,
      "./b.js": false,
      "./d.js": true,
      "./side.js": false,
      "./f.js": true,
      "./g.js": false,
    });
  });

  it("does not read a sentence in a comment as an import", () => {
    expect(edgesOf('/* import { x } from "@00/agent-runtime" */\n// import y from "./z.js"\n')).toEqual([]);
  });
});
