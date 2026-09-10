/**
 * THE LIVE PREVIEW — the pure halves of it, and the two twins that hold it together.
 *
 * The block that would catch the mistake that matters is at the bottom: the element picker and the
 * preview worker's routing decision exist TWICE, once in this app and once in
 * `apps/infinite-preview-site`, because that Worker is a separate deploy unit outside the pnpm
 * workspace with no node_modules and no way to import a thing from here. Everything else in this file
 * can be green while the two copies quietly diverge, so both files are read off disk and compared.
 *
 * The picker itself is tested by EVALUATING THE SHIPPED TEXT: the script hangs its pure halves off
 * `globalThis.__00_inspector` before deciding whether to start, and it starts only where there is a
 * `document`, which a node runner does not have. So the selector algorithm a test calls is byte-for-
 * byte the one a browser runs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transformWithEsbuild } from "vite";
import { MemoryFs } from "@00/agent-fs";
import {
  INSPECTOR_SOURCE,
  MAX_FILE_SET_BYTES,
  MSG_FILES,
  MSG_INSPECT,
  MSG_NAV,
  MSG_PICK,
  MSG_PICK_CLEAR,
  MSG_PORT_REQUEST,
  MSG_PORT_RESPONSE,
  MSG_READY,
  PREVIEW_NOT_CONFIGURED_LINE,
  PREVIEW_ORIGIN_DEFAULT,
  PREVIEW_PROTOCOL,
  baseName,
  chipTextFor,
  entryPageFor,
  formatBytes,
  isPickMessage,
  newSiteId,
  planFileSet,
  previewHostConfigured,
  previewOrigin,
  previewPortUrl,
  previewRouteFor,
  previewSiteUrl,
  shortSelector,
  withInspector,
  type PickedElement,
} from "../src/lib/pick.js";
import { serveMimeFor } from "../src/lib/virtual-route.js";
import { SELECTION_FENCE, selectionBlock, withSelection } from "../src/power/inspector-context.js";
import { PREVIEW_SANDBOX, buildFileSet, createPreviewHost, hostUrl, reReadFile } from "../src/power/preview-host.js";
// The very text the host Worker serves at /preview-sw.js — executed at the bottom of this file.
import { PREVIEW_SW_SOURCE } from "../../infinite-preview-site/src/preview-sw.js";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const read = (relative: string): string => readFileSync(here(relative), "utf8");

const APP_PICK = "../src/lib/pick.ts";
const HOST_INSPECTOR = "../../infinite-preview-site/src/inspector.ts";
const HOST_SW = "../../infinite-preview-site/src/preview-sw.ts";
const HOST_INDEX = "../../infinite-preview-site/src/index.ts";
const HOST_BOOTSTRAP = "../../infinite-preview-site/src/bootstrap.ts";

function pick(over: Partial<PickedElement> = {}): PickedElement {
  return {
    kind: MSG_PICK,
    v: PREVIEW_PROTOCOL,
    selector: "main > div.card > button.buy",
    tag: "button",
    role: "button",
    name: "Add to cart",
    text: "Add to cart",
    html: '<button class="buy">Add to cart</button>',
    box: { x: 24, y: 310, width: 148, height: 40 },
    styles: { color: "rgb(255, 255, 255)", backgroundColor: "rgb(0, 0, 0)", padding: "8px 16px" },
    url: "https://preview.example/s/abc/index.html",
    source: "workspace/projects/site/index.html",
    ...over,
  };
}

// ── The route the preview worker takes ────────────────────────────────────────────────────────────

describe("what a path on the preview origin means", () => {
  it("serves a posted file", () => {
    expect(previewRouteFor("/s/abc123/index.html")).toEqual({ kind: "site", siteId: "abc123", path: "index.html" });
    expect(previewRouteFor("/s/abc123/assets/app.css")).toEqual({
      kind: "site",
      siteId: "abc123",
      path: "assets/app.css",
    });
  });

  it("keeps a trailing slash, because that is what makes a directory a directory", () => {
    expect(previewRouteFor("/s/abc123/sub/")).toEqual({ kind: "site", siteId: "abc123", path: "sub/" });
    expect(previewRouteFor("/s/abc123/")).toEqual({ kind: "site", siteId: "abc123", path: "" });
  });

  it("forwards a virtual port with its subpath", () => {
    expect(previewRouteFor("/p/abc123/3000/api/items")).toEqual({
      kind: "port",
      siteId: "abc123",
      port: 3000,
      subpath: "/api/items",
    });
    expect(previewRouteFor("/p/abc123/3000/")).toEqual({ kind: "port", siteId: "abc123", port: 3000, subpath: "/" });
  });

  it("is not ours for anything else", () => {
    expect(previewRouteFor("/")).toBeNull();
    expect(previewRouteFor("/preview-sw.js")).toBeNull();
    expect(previewRouteFor("/__inspector.js")).toBeNull();
    expect(previewRouteFor("/sp/abc/x")).toBeNull();
  });

  it("refuses a climb, a decoded slash, a broken escape and a nonsense port", () => {
    expect(previewRouteFor("/s/abc/../vault.json")).toBeNull();
    expect(previewRouteFor("/s/abc/..%2Fvault.json")).toBeNull();
    expect(previewRouteFor("/s/abc/%E0%A4%A")).toBeNull();
    expect(previewRouteFor("/s/../x")).toBeNull();
    expect(previewRouteFor("/p/abc/0/x")).toBeNull();
    expect(previewRouteFor("/p/abc/70000/x")).toBeNull();
    expect(previewRouteFor("/p/abc/3000x/x")).toBeNull();
    expect(previewRouteFor("/s/not a site id/x")).toBeNull();
  });

  it("round-trips against the URL builders the app uses", () => {
    const url = new URL(previewSiteUrl("https://host", "abc", "assets/app css.txt"));
    expect(previewRouteFor(url.pathname)).toEqual({ kind: "site", siteId: "abc", path: "assets/app css.txt" });
    const port = new URL(previewPortUrl("https://host", "abc", 3000, "/x"));
    expect(previewRouteFor(port.pathname)).toEqual({ kind: "port", siteId: "abc", port: 3000, subpath: "/x" });
  });
});

// ── Where the host is ────────────────────────────────────────────────────────────────────────────

describe("the preview origin sentinel", () => {
  it("takes a real origin and drops the path", () => {
    expect(previewOrigin("https://preview.example/anything")).toBe("https://preview.example");
    expect(previewHostConfigured("http://localhost:8795")).toBe(true);
  });

  it("treats `off`, a placeholder and nonsense as no host at all", () => {
    expect(previewOrigin("off")).toBe("");
    expect(previewOrigin("https://infinite-preview.invalid")).toBe("");
    expect(previewOrigin("not a url")).toBe("");
    expect(previewHostConfigured("off")).toBe(false);
    expect(PREVIEW_NOT_CONFIGURED_LINE).toContain("VITE_PREVIEW_ORIGIN");
  });

  it("defaults to the workers.dev link the integrator deploys", () => {
    expect(previewOrigin()).toBe(PREVIEW_ORIGIN_DEFAULT);
  });

  it("puts this app's origin in the fragment, where no server ever sees it", () => {
    const url = new URL(hostUrl("https://preview.example", "https://app.example"));
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(url.hash).toBe("#o=https%3A%2F%2Fapp.example");
  });

  it("keeps the two sandbox flags that are the whole point, and none of the dangerous ones", () => {
    expect(PREVIEW_SANDBOX).toContain("allow-scripts");
    expect(PREVIEW_SANDBOX).toContain("allow-same-origin");
    expect(PREVIEW_SANDBOX).not.toContain("allow-top-navigation");
    expect(PREVIEW_SANDBOX).not.toContain("allow-modals");
  });
});

// ── The file set ─────────────────────────────────────────────────────────────────────────────────

describe("what goes over to the preview host", () => {
  const files = [
    { path: "workspace/projects/site/index.html", size: 100 },
    { path: "workspace/projects/site/assets/app.css", size: 50 },
    { path: "workspace/projects/site/assets/logo.png", size: 900 },
    { path: "workspace/projects/site/.git/objects/ab/cdef", size: 4_000_000 },
    { path: "workspace/projects/site/.env", size: 20 },
    { path: "workspace/vault.json", size: 10 },
  ];

  it("is folder-scoped, dot-free, sorted, and carries the wire MIME", () => {
    const plan = planFileSet("workspace/projects/site", files, serveMimeFor);
    expect(plan.entries.map((e) => e.site)).toEqual(["assets/app.css", "assets/logo.png", "index.html"]);
    expect(plan.totalBytes).toBe(1050);
    expect(plan.refusal).toBeNull();
    expect(plan.entries.find((e) => e.site === "assets/app.css")?.mime).toBe("text/css; charset=utf-8");
    expect(plan.entries.find((e) => e.site === "assets/logo.png")?.mime).toBe("image/png");
    // The three that were left out say so, by name.
    expect(plan.skipped.map((s) => s.path)).toContain("workspace/vault.json");
    expect(plan.skipped.some((s) => s.path.includes(".git"))).toBe(true);
    expect(plan.skipped.some((s) => s.path.endsWith(".env"))).toBe(true);
  });

  it("refuses the whole folder rather than posting half of it", () => {
    const big = [{ path: "workspace/site/huge.bin", size: 40 * 1024 * 1024 }];
    const plan = planFileSet("workspace/site", big, serveMimeFor);
    expect(plan.refusal).toContain("40.0 MB");
    expect(plan.refusal).toContain(formatBytes(MAX_FILE_SET_BYTES));
    expect(plan.entries).toHaveLength(1); // the plan is still readable; the caller is the one that stops
  });

  it("refuses on count as well as on bytes", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `workspace/site/f${i}.txt`, size: 1 }));
    expect(planFileSet("workspace/site", many, serveMimeFor, { maxFiles: 10 }).refusal).toContain("12 files");
  });

  it("picks the entry the person chose, then index.html, then any page", () => {
    const plan = planFileSet("workspace/projects/site", files, serveMimeFor);
    expect(entryPageFor(plan, "index.html")).toBe("index.html");
    expect(entryPageFor(plan, "nope.html")).toBe("index.html");
    const noIndex = planFileSet("w", [{ path: "w/about.html", size: 1 }], serveMimeFor);
    expect(entryPageFor(noIndex)).toBe("about.html");
  });

  it("reads the bytes for exactly what the plan named", async () => {
    const fs = new MemoryFs();
    await fs.mkdir("workspace/projects/site/assets");
    await fs.mkdir("workspace/projects/site/.git");
    await fs.writeFile("workspace/projects/site/index.html", "<h1>hi</h1>");
    await fs.writeFile("workspace/projects/site/assets/app.css", "body{}");
    await fs.writeFile("workspace/projects/site/.git/HEAD", "ref: refs/heads/main");
    await fs.writeFile("workspace/vault.json", "{}");

    const set = await buildFileSet(fs, "workspace/projects/site", { entry: "index.html" });
    expect(set.entry).toBe("index.html");
    expect(set.files.map((f) => f.site).sort()).toEqual(["assets/app.css", "index.html"]);
    expect(new TextDecoder().decode(set.files.find((f) => f.site === "index.html")!.bytes!)).toBe("<h1>hi</h1>");
    expect(set.files[0]?.source).toBe("workspace/projects/site/assets/app.css");

    // A refusal posts nothing at all.
    const refused = await buildFileSet(fs, "workspace/projects/site", { maxBytes: 1 });
    expect(refused.plan.refusal).toBeTruthy();
    expect(refused.files).toEqual([]);
  });

  it("re-reads one changed file, and reports a deletion as null bytes", async () => {
    const fs = new MemoryFs();
    await fs.mkdir("workspace/site");
    await fs.writeFile("workspace/site/index.html", "<h1>one</h1>");
    const changed = await reReadFile(fs, "workspace/site", "workspace/site/index.html");
    expect(new TextDecoder().decode(changed!.bytes!)).toBe("<h1>one</h1>");
    expect(changed!.mime).toBe("text/html; charset=utf-8");

    await fs.remove("workspace/site/index.html");
    expect((await reReadFile(fs, "workspace/site", "workspace/site/index.html"))?.bytes).toBeNull();
    // Outside the folder, and inside a dot-folder, are not the preview's business.
    expect(await reReadFile(fs, "workspace/site", "workspace/vault.json")).toBeNull();
    expect(await reReadFile(fs, "workspace/site", "workspace/site/.git/HEAD")).toBeNull();
  });

  it("gives a site id that is a cache namespace and never a path", () => {
    const id = newSiteId();
    expect(id).toMatch(/^[A-Za-z0-9]{1,64}$/);
    expect(newSiteId()).not.toBe(id);
  });
});

// ── A pick, and what a person sees of it ─────────────────────────────────────────────────────────

describe("a pick becomes a chip and a block", () => {
  it("reads as the element, its name and the file it lives in", () => {
    expect(chipTextFor(pick())).toBe("Selected: <button.buy> 'Add to cart' · index.html");
  });

  it("falls back to the URL when the served page came from no file", () => {
    expect(chipTextFor(pick({ source: null }))).toBe("Selected: <button.buy> 'Add to cart' · index.html");
    // A served page whose URL names no file names nothing: "3000" would not help anyone.
    expect(chipTextFor(pick({ source: null, url: "http://localhost:8795/p/abc/3000/" }))).toBe(
      "Selected: <button.buy> 'Add to cart'",
    );
  });

  it("says nothing it does not have", () => {
    expect(chipTextFor(pick({ name: "", source: null, url: "" }))).toBe("Selected: <button.buy>");
  });

  it("clips a long accessible name rather than filling the composer with it", () => {
    const long = chipTextFor(pick({ name: "x".repeat(200) }));
    expect(long.length).toBeLessThan(80);
    expect(long).toContain("…");
  });

  it("shortens a selector and names a file", () => {
    expect(shortSelector("main > div.card > button.buy")).toBe("button.buy");
    expect(shortSelector("#buy")).toBe("#buy");
    expect(baseName("workspace/projects/site/index.html")).toBe("index.html");
    expect(baseName("https://x/y/z.html?a=1")).toBe("z.html");
  });

  it("only accepts a message that really is a pick", () => {
    expect(isPickMessage(pick())).toBe(true);
    expect(isPickMessage({ ...pick(), v: 99 })).toBe(false);
    expect(isPickMessage({ kind: "00-pick" })).toBe(false);
    expect(isPickMessage(null)).toBe(false);
    expect(isPickMessage("00-pick")).toBe(false);
  });

  it("goes into the prompt as a named fence, first, with the person's words after it", () => {
    const block = selectionBlock(pick());
    expect(block.startsWith("```" + SELECTION_FENCE)).toBe(true);
    expect(block).toContain("selector: main > div.card > button.buy");
    expect(block).toContain("file:     workspace/projects/site/index.html");
    expect(block).toContain("148×40 at (24, 310)");
    expect(block).toContain('<button class="buy">Add to cart</button>');
    // The url is redundant when a file was named, and is carried when one was not.
    expect(block).not.toContain("url:");
    expect(selectionBlock(pick({ source: null }))).toContain("url:");

    const message = withSelection("make it red", pick());
    expect(message.indexOf("```")).toBe(0);
    expect(message.endsWith("make it red")).toBe(true);
    expect(withSelection("", pick())).toBe(block);
    expect(withSelection("just words", null)).toBe("just words");
  });
});

// ── The picker itself, as it ships ───────────────────────────────────────────────────────────────

interface InspectorApi {
  selectorFromChain(chain: unknown[]): string;
  stableClass(name: string): boolean;
  trimText(raw: unknown): string;
  trimHtml(raw: unknown): string;
  roleFor(tag: string, type: string | null, explicit: string | null): string;
}

/** Evaluates the SHIPPED text. There is no `document` in this runner, so it never starts. */
function loadInspector(source: string): InspectorApi {
  const scope: Record<string, unknown> = {};
  new Function("globalThis", `${source}\n;return globalThis.__00_inspector;`);
  const api = new Function(
    "globalThis",
    "window",
    "document",
    `${source}\n;return globalThis.__00_inspector;`,
  )(scope, undefined, undefined) as InspectorApi;
  return api;
}

const inspector = loadInspector(INSPECTOR_SOURCE);

const link = (over: Record<string, unknown> = {}) => ({
  tag: "button",
  id: null,
  idUnique: false,
  classes: ["buy"],
  nth: 1,
  uniqueAmongSiblings: true,
  ...over,
});

describe("the selector algorithm, as the browser runs it", () => {
  it("stops at a document-unique id and says nothing above it", () => {
    expect(
      inspector.selectorFromChain([
        link({ classes: ["buy"] }),
        link({ tag: "div", id: "cart", idUnique: true, classes: ["card"] }),
        link({ tag: "main", classes: [] }),
      ]),
    ).toBe("#cart > button.buy");
  });

  it("uses the element's own id when it has one", () => {
    expect(inspector.selectorFromChain([link({ id: "buy", idUnique: true })])).toBe("#buy");
  });

  it("falls back to nth-of-type when tag and classes do not tell siblings apart", () => {
    expect(
      inspector.selectorFromChain([link({ classes: [], nth: 3, uniqueAmongSiblings: false })]),
    ).toBe("button:nth-of-type(3)");
  });

  it("keeps at most two stable classes and drops the generated ones", () => {
    expect(
      inspector.selectorFromChain([link({ classes: ["btn", "buy", "big", "svelte-1a2b3c", "css-9f8e7d6c"] })]),
    ).toBe("button.btn.buy");
    expect(inspector.stableClass("buy")).toBe(true);
    expect(inspector.stableClass("svelte-1a2b3c")).toBe(false);
    expect(inspector.stableClass("x9f8e7d6c")).toBe(false);
    expect(inspector.stableClass("3d")).toBe(false);
    expect(inspector.stableClass("a".repeat(50))).toBe(false);
  });

  it("stops at body, and never walks more than five levels", () => {
    const deep = [link(), link({ tag: "div" }), link({ tag: "section" }), link({ tag: "main" }), link({ tag: "body" }), link({ tag: "div" })];
    const selector = inspector.selectorFromChain(deep);
    expect(selector.startsWith("body")).toBe(true);
    expect(selector.split(">").length).toBe(5);
  });

  it("answers html for nothing at all", () => {
    expect(inspector.selectorFromChain([])).toBe("html");
  });

  it("trims text and outerHTML to what a message can carry", () => {
    expect(inspector.trimText("  a\n  b  ")).toBe("a b");
    expect(inspector.trimText("x".repeat(500))).toHaveLength(200);
    expect(inspector.trimHtml("<b>hi</b>")).toBe("<b>hi</b>");
    const big = inspector.trimHtml("<b>" + "x".repeat(5000) + "</b>");
    expect(big).toContain("trimmed at 2048 characters");
  });

  it("derives a role the way an accessibility tree would", () => {
    expect(inspector.roleFor("div", null, "tab")).toBe("tab");
    expect(inspector.roleFor("a", null, null)).toBe("link");
    expect(inspector.roleFor("h2", null, null)).toBe("heading");
    expect(inspector.roleFor("input", "submit", null)).toBe("button");
    expect(inspector.roleFor("input", "text", null)).toBe("textbox");
    expect(inspector.roleFor("input", "checkbox", null)).toBe("checkbox");
    expect(inspector.roleFor("mark", null, null)).toBe("mark");
  });
});

describe("the snapshot road carries the same script", () => {
  it("stamps the target and the source, and puts the script before </body>", () => {
    const out = withInspector("<html><head><title>x</title></head><body><h1>hi</h1></body></html>", {
      target: "https://app.example",
      source: "workspace/projects/site/index.html",
    });
    expect(out).toContain('<meta name="00-target" content="https://app.example">');
    expect(out).toContain('<meta name="00-source" content="workspace/projects/site/index.html">');
    expect(out.indexOf("__00_inspector")).toBeGreaterThan(out.indexOf("<h1>hi</h1>"));
    expect(out.indexOf("</body>")).toBeGreaterThan(out.indexOf("__00_inspector"));
  });

  it("still lands in a document with no head and no body", () => {
    const out = withInspector("<h1>bare</h1>", { target: "https://app.example" });
    expect(out).toContain('name="00-target"');
    expect(out).toContain("__00_inspector");
    expect(out).not.toContain('name="00-source"');
  });

  it("escapes an origin rather than letting it close the attribute", () => {
    expect(withInspector("<body></body>", { target: 'https://x"><script>bad()</' + "script>" })).toContain("&quot;");
  });
});

// ── The two twins ────────────────────────────────────────────────────────────────────────────────

/** Comments and formatting are not the decision; running them both through esbuild removes both. */
async function normalise(source: string): Promise<string> {
  const { code } = await transformWithEsbuild(source, "region.ts", { loader: "ts", format: "esm", target: "es2022" });
  return code
    .replace(/^export\s*\{[^}]*\};?$/gm, "")
    .replace(/^export\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function region(source: string, begin: string, end: string): string {
  const from = source.indexOf(begin);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`no region between ${begin} and ${end}`);
  return source.slice(from + begin.length, to);
}

describe("the preview host carries the same code this app does", () => {
  it("serves the very bytes of INSPECTOR_SOURCE", () => {
    const theirs = read(HOST_INSPECTOR);
    const marker = "export const INSPECTOR_SOURCE = String.raw`";
    const from = theirs.indexOf(marker);
    expect(from).toBeGreaterThan(-1);
    const copy = theirs.slice(from + marker.length, theirs.lastIndexOf("`;"));
    expect(copy).toBe(INSPECTOR_SOURCE);
  });

  it("makes the same routing decision in its service worker", async () => {
    const mine = region(read(APP_PICK), "— BEGIN ────────────────────────────\n", "// ─── SHARED WITH");
    const theirs = region(read(HOST_SW), "const ROUTE_JS = String.raw`", "`;");
    expect(await normalise(mine)).toBe(await normalise(theirs));
  });

  it("cannot hold a backtick or an interpolation in either served source", () => {
    for (const file of [HOST_INSPECTOR, HOST_SW, HOST_BOOTSTRAP]) {
      const source = read(file);
      const raws = source.split("String.raw`").slice(1);
      expect(raws.length).toBeGreaterThan(0);
      for (const raw of raws) {
        const body = raw.slice(0, raw.indexOf("`"));
        expect(body.includes("${"), `${file} interpolates inside String.raw`).toBe(false);
      }
    }
  });

  it("speaks the message names this app speaks", () => {
    const wire = read(HOST_SW) + read(HOST_BOOTSTRAP) + read(HOST_INSPECTOR);
    for (const name of [MSG_READY, MSG_FILES, MSG_INSPECT, MSG_PICK, MSG_PORT_REQUEST, MSG_PORT_RESPONSE]) {
      expect(wire, `the host never says ${name}`).toContain(name);
    }
    // And the protocol version both sides check.
    expect(read(HOST_BOOTSTRAP)).toContain("var V = 1;");
    expect(PREVIEW_PROTOCOL).toBe(1);
  });

  it("sets the headers that make the host work at all", () => {
    const index = read(HOST_INDEX);
    expect(index).toContain('"service-worker-allowed": "/"');
    expect(index).toContain('"cross-origin-resource-policy": "cross-origin"');
    expect(index).toContain("no-store");
    // And answers the three paths, and nothing else.
    expect(index).toContain('"/preview-sw.js"');
    expect(index).toContain('"/__inspector.js"');
  });

  /**
   * A frame that is embedded by a CROSS-ORIGIN-ISOLATED page must carry a compatible
   * `Cross-Origin-Embedder-Policy` of its own or the browser blocks it outright — no request, no
   * error in the pane, just an empty frame. The app is isolated (`apps/infinite-site/src/headers.ts`,
   * and `vite.config.ts` in dev), so the two values have to agree, and neither file's error message
   * would ever mention the other. Hence this.
   */
  it("consents to being embedded by the isolated app, with the same COEP the app uses", () => {
    expect(read(HOST_INDEX)).toContain('const COEP = "credentialless"');
    const site = read("../../infinite-site/src/headers.ts");
    const declared = /export const COEP = "([^"]+)"/.exec(site);
    // Skipped rather than guessed if that file is rewritten: a missing pin is better than a wrong one.
    if (declared) expect(declared[1]).toBe("credentialless");
  });

  it("has no bindings and no package.json — it holds nothing and installs nothing", () => {
    const wrangler = read("../../infinite-preview-site/wrangler.jsonc");
    expect(wrangler).not.toContain("kv_namespaces");
    expect(wrangler).not.toContain("d1_databases");
    expect(wrangler).not.toContain("r2_buckets");
    expect(() => read("../../infinite-preview-site/package.json")).toThrow();
  });
});

// ── The handshake, and the port that carries everything after it ─────────────────────────────────

/**
 * `createPreviewHost` touches exactly two browser things — `window`'s message bus and an
 * `<iframe>`'s `contentWindow` — so a node runner can drive the whole protocol with a stub for each
 * and a REAL `MessageChannel`, which Node has. What is proven here is the part no pure function
 * covers: that the app refuses a hello from the wrong origin or the wrong window, that everything
 * after the hello rides the port, and that a virtual-port request is ALWAYS answered — a throw
 * included, because the preview worker is sitting on a ten-second timer at the other end.
 */
describe("the app and the preview host talking", () => {
  const listeners = new Set<(event: unknown) => void>();
  const frame = { contentWindow: { id: "the frame" } } as unknown as HTMLIFrameElement;

  beforeEach(() => {
    listeners.clear();
    (globalThis as Record<string, unknown>).window = {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        if (type === "message") listeners.add(fn);
      },
      removeEventListener: (_type: string, fn: (event: unknown) => void) => listeners.delete(fn),
    };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  function hello(port: MessagePort, over: Record<string, unknown> = {}): void {
    for (const fn of [...listeners]) {
      fn({
        origin: "https://preview.example",
        source: frame.contentWindow,
        data: { kind: MSG_READY, v: PREVIEW_PROTOCOL, ...over },
        ports: [port],
      });
    }
  }

  /** One message off the far end of the channel. */
  function next(port: MessagePort): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      port.onmessage = (event: MessageEvent) => resolve(event.data as Record<string, unknown>);
    });
  }

  it("takes the port from the right frame and refuses it from anywhere else", async () => {
    const channel = new MessageChannel();
    const seen: PickedElement[] = [];
    const host = createPreviewHost(frame, "https://preview.example", { onPick: (p) => seen.push(p) }, {
      appOrigin: "https://app.example",
      timeoutMs: 200,
    });

    // A hello from another origin, and one from another window, are both ignored.
    for (const fn of [...listeners]) {
      fn({ origin: "https://evil.example", source: frame.contentWindow, data: { kind: MSG_READY, v: 1 }, ports: [channel.port2] });
      fn({ origin: "https://preview.example", source: { other: true }, data: { kind: MSG_READY, v: 1 }, ports: [channel.port2] });
    }
    hello(channel.port2);
    await expect(host.ready()).resolves.toBeUndefined();

    channel.port1.postMessage(pick({ name: "Buy" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.map((p) => p.name)).toEqual(["Buy"]);
    host.destroy();
  });

  it("says which side needs a deploy when the protocol versions differ", async () => {
    const channel = new MessageChannel();
    let said = "";
    const host = createPreviewHost(frame, "https://preview.example", { onError: (m) => (said = m) }, {
      appOrigin: "https://app.example",
      timeoutMs: 60,
    });
    hello(channel.port2, { v: 99 });
    expect(said).toContain("protocol 99");
    await expect(host.ready()).rejects.toThrow(/did not answer/);
    host.destroy();
  });

  it("posts the file set, one changed file, a navigation and the inspect flag on the port", async () => {
    const channel = new MessageChannel();
    const host = createPreviewHost(frame, "https://preview.example", {}, { appOrigin: "https://app.example", timeoutMs: 200 });
    hello(channel.port2);
    await host.ready();

    const bytes = new TextEncoder().encode("<h1>hi</h1>");
    host.send([{ site: "index.html", mime: "text/html", bytes }], "abc", "index.html");
    const files = await next(channel.port1);
    expect(files.kind).toBe(MSG_FILES);
    expect(files.v).toBe(PREVIEW_PROTOCOL);
    expect(files.entry).toBe("index.html");
    expect(new TextDecoder().decode((files.files as { bytes: Uint8Array }[])[0]!.bytes)).toBe("<h1>hi</h1>");

    host.setInspect(true);
    expect(await next(channel.port1)).toMatchObject({ kind: MSG_INSPECT, on: true });

    host.navigate("https://preview.example/s/abc/about.html");
    expect(await next(channel.port1)).toMatchObject({ kind: "00-preview-navigate" });

    host.update({ site: "index.html", mime: "text/html", bytes: null });
    expect(await next(channel.port1)).toMatchObject({ kind: "00-preview-file" });
    host.destroy();
  });

  it("always answers a virtual-port request, including when serving it throws", async () => {
    const channel = new MessageChannel();
    const host = createPreviewHost(
      frame,
      "https://preview.example",
      {},
      {
        appOrigin: "https://app.example",
        timeoutMs: 200,
        serve: (async (route: { port: number }) => {
          if (route.port === 500) throw new Error("the handler exploded");
          return { status: 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("ok") };
        }) as never,
      },
    );
    hello(channel.port2);
    await host.ready();

    channel.port1.postMessage({
      kind: MSG_PORT_REQUEST,
      v: PREVIEW_PROTOCOL,
      id: 7,
      port: 3000,
      request: { method: "GET", url: "/api?page=2", headers: {}, body: null },
    });
    const good = await next(channel.port1);
    expect(good).toMatchObject({ kind: MSG_PORT_RESPONSE, id: 7 });
    expect((good.answer as { ok: boolean; response: { status: number } }).ok).toBe(true);
    expect((good.answer as { response: { status: number } }).response.status).toBe(200);

    channel.port1.postMessage({
      kind: MSG_PORT_REQUEST,
      v: PREVIEW_PROTOCOL,
      id: 8,
      port: 500,
      request: { method: "GET", url: "/", headers: {}, body: null },
    });
    const bad = await next(channel.port1);
    expect((bad.answer as { ok: boolean; error: string })).toMatchObject({ ok: false, error: "the handler exploded" });
    host.destroy();
  });

  it("relays a navigation and a clear, and gives up with a sentence when nobody says hello", async () => {
    const navs: string[] = [];
    let cleared = 0;
    const channel = new MessageChannel();
    const host = createPreviewHost(
      frame,
      "https://preview.example",
      { onNav: (n) => navs.push(n.url), onClear: () => (cleared += 1) },
      { appOrigin: "https://app.example", timeoutMs: 200 },
    );
    hello(channel.port2);
    await host.ready();
    channel.port1.postMessage({ kind: MSG_NAV, v: PREVIEW_PROTOCOL, url: "https://preview.example/s/abc/about.html", title: "About" });
    channel.port1.postMessage({ kind: MSG_PICK_CLEAR, v: PREVIEW_PROTOCOL });
    await new Promise((r) => setTimeout(r, 10));
    expect(navs).toEqual(["https://preview.example/s/abc/about.html"]);
    expect(cleared).toBe(1);
    host.destroy();

    const lonely = createPreviewHost(frame, "https://preview.example", {}, { appOrigin: "https://app.example", timeoutMs: 20 });
    await expect(lonely.ready()).rejects.toThrow(/preview host at https:\/\/preview.example did not answer/);
    lonely.destroy();
  });
});

/**
 * Found by the live check, not by reading: the host page posts `00-preview-error` on the WINDOW when
 * it cannot get far enough to hand a port over (a browser with service workers blocked does exactly
 * that). Before this branch the app sat on its fifteen-second handshake timeout while the frame in
 * front of the person already had the reason printed in it.
 */
describe("a host that cannot start says so at once", () => {
  const listeners = new Set<(event: unknown) => void>();
  const frame = { contentWindow: { id: "the frame" } } as unknown as HTMLIFrameElement;

  beforeEach(() => {
    listeners.clear();
    (globalThis as Record<string, unknown>).window = {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        if (type === "message") listeners.add(fn);
      },
      removeEventListener: (_type: string, fn: (event: unknown) => void) => listeners.delete(fn),
    };
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it("rejects `ready()` with the host's own sentence rather than waiting out the timeout", async () => {
    let said = "";
    const host = createPreviewHost(frame, "https://preview.example", { onError: (m) => (said = m) }, {
      appOrigin: "https://app.example",
      timeoutMs: 30_000,
    });
    for (const fn of [...listeners]) {
      fn({
        origin: "https://preview.example",
        source: frame.contentWindow,
        data: { kind: "00-preview-error", v: PREVIEW_PROTOCOL, message: "service workers are blocked here" },
        ports: [],
      });
    }
    expect(said).toBe("service workers are blocked here");
    await expect(host.ready()).rejects.toThrow("service workers are blocked here");
    host.destroy();
  });
});

// ── The preview worker, run ──────────────────────────────────────────────────────────────────────

/**
 * THE BLOCK THAT PROVES THE TWO HALVES MEET. Everything above can be green while the service worker
 * this repo actually SERVES fails to parse, routes to the wrong place, or forgets the injection. So
 * the shipped text is executed here in a fake worker global — the same trick `virtual-ports.test.ts`
 * plays on the app's own `public/sw.js` — with a fake Cache Storage standing in for the one the
 * bootstrap page fills, and its `fetch` handler is driven with real `Request`s.
 *
 * (Node has `Request`, `Response`, `Headers` and `MessageChannel`; Cache Storage it does not, and a
 * Map keyed by URL is all this worker asks of it.)
 */
describe("the preview host's service worker, executed", () => {

  interface FakeCache {
    match(request: Request): Promise<Response | undefined>;
  }

  function bootWorker(stored: Record<string, { body: string; type: string; source?: string }>, client: unknown) {
    const listeners = new Map<string, (event: unknown) => void>();
    const caches = {
      open: async (name: string): Promise<FakeCache> => ({
        async match(request: Request) {
          const entry = stored[new URL(request.url).pathname];
          if (!entry || !name.startsWith("00-preview-")) return undefined;
          const headers: Record<string, string> = { "content-type": entry.type };
          if (entry.source) headers["x-00-source"] = entry.source;
          return new Response(entry.body, { headers });
        },
      }),
    };
    const self = {
      location: { origin: "https://preview.example" },
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      skipWaiting: () => undefined,
      clients: {
        claim: async () => undefined,
        matchAll: async () => (client ? [client] : []),
      },
    };
    new Function("self", "caches", "Response", "Request", "Headers", "URL", "MessageChannel", "TextDecoder", "setTimeout", "clearTimeout", PREVIEW_SW_SOURCE)(
      self,
      caches,
      Response,
      Request,
      Headers,
      URL,
      MessageChannel,
      TextDecoder,
      setTimeout,
      clearTimeout,
    );
    return async (url: string, init?: RequestInit): Promise<Response> => {
      let answered: Promise<Response> | null = null;
      listeners.get("fetch")?.({
        request: new Request(url, init),
        respondWith: (response: Promise<Response>) => (answered = response),
      } as unknown);
      return answered ? await answered : new Response(null, { status: 599 });
    };
  }

  const page = { body: "<html><head><title>t</title></head><body><h1>hi</h1></body></html>", type: "text/html" };

  it("serves a posted page and injects the inspector and its source", async () => {
    const fetchIt = bootWorker(
      { "/s/abc/index.html": { ...page, source: "workspace/projects/shop/index.html" } },
      null,
    );
    const response = await fetchIt("https://preview.example/s/abc/index.html");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The private header the app used to carry the path never reaches the browser.
    expect(response.headers.get("x-00-source")).toBeNull();
    const html = await response.text();
    expect(html).toContain('<script src="/__inspector.js"></script>');
    expect(html).toContain('<meta name="00-source" content="workspace/projects/shop/index.html">');
    expect(html.indexOf("</body>")).toBeGreaterThan(html.indexOf("__inspector.js"));
  });

  it("serves a directory as its index, and a CSS file untouched", async () => {
    const fetchIt = bootWorker(
      { "/s/abc/index.html": page, "/s/abc/assets/app.css": { body: "body{}", type: "text/css" } },
      null,
    );
    expect(await (await fetchIt("https://preview.example/s/abc/")).text()).toContain("__inspector.js");
    const css = await fetchIt("https://preview.example/s/abc/assets/app.css");
    expect(await css.text()).toBe("body{}");
  });

  it("404s a file the app never posted, and says why", async () => {
    const fetchIt = bootWorker({}, null);
    const response = await fetchIt("https://preview.example/s/abc/missing.html");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("The app posts a folder of files");
  });

  it("forwards a virtual port to the host page and puts the answer on the wire", async () => {
    const asked: Record<string, unknown>[] = [];
    const client = {
      url: "https://preview.example/",
      postMessage(message: Record<string, unknown>, transfer: MessagePort[]) {
        asked.push(message);
        transfer[0]!.postMessage({
          ok: true,
          response: {
            status: 200,
            headers: { "content-type": "text/plain" },
            body: new TextEncoder().encode("from the script"),
          },
        });
      },
    };
    const fetchIt = bootWorker({}, client);
    const response = await fetchIt("https://preview.example/p/abc/3000/api?page=2");
    expect(await response.text()).toBe("from the script");
    expect(asked[0]).toMatchObject({ kind: "00-preview-port-request", port: 3000 });
    expect((asked[0] as { request: { url: string } }).request.url).toBe("/api?page=2");
  });

  it("504s when the host page is gone, and says the tab is what serves it", async () => {
    const response = await bootWorker({}, null)("https://preview.example/p/abc/3000/");
    expect(response.status).toBe(504);
    expect(await response.text()).toContain("only while that tab is open");
  });

  it("leaves its own three files, and every other origin, to the network", async () => {
    const fetchIt = bootWorker({}, null);
    for (const url of ["https://preview.example/", "https://preview.example/preview-sw.js", "https://preview.example/__inspector.js", "https://elsewhere.example/s/abc/x.html"]) {
      expect((await fetchIt(url)).status, url).toBe(599); // 599 = respondWith was never called
    }
  });
});
