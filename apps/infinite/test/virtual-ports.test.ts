/**
 * The virtual ports: what a `/~/` path means, what the registry does with it, and — at the bottom —
 * the real service worker answering a real `fetch` event through the real page half.
 *
 * The last block is the one that would catch the mistake that matters. Everything else here can be
 * green while the two halves fail to meet: a marker that moved, a message shape that drifted, a
 * `Response` built out of the wrong field. So the build's own substitution is run over the tracked
 * `public/sw.js`, the result is executed in a fake worker global, and the client it postMessages to
 * is `answerBridgeMessage` — the shipped page code — over a real `MessageChannel`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFs } from "@00/agent-fs";
import {
  FILES_SEGMENT,
  INDEX_FILE,
  VIRTUAL_PREFIX,
  isVirtualPath,
  parsePort,
  requestUrlFor,
  routeFor,
  serveMimeFor,
  staticTarget,
} from "../src/lib/virtual-route.js";
import {
  DEFAULT_SERVE_PORT,
  PortInUseError,
  answerBridgeMessage,
  folderHandler,
  handleVirtualRequest,
  isBridgeMessage,
  listPorts,
  onPortsChanged,
  portEntry,
  portUrl,
  registerPort,
  resetPorts,
  serveFolder,
  setWorkspaceFs,
  textResponse,
  unregister,
} from "../src/power/virtual-ports.js";

const decoder = new TextDecoder();
const GET = (url: string) => ({ method: "GET", url, headers: {}, body: null });

let fs: MemoryFs;

beforeEach(async () => {
  resetPorts();
  fs = new MemoryFs();
  await fs.mkdir("workspace/projects/site/assets");
  await fs.writeFile("workspace/projects/site/index.html", "<!doctype html><h1>home</h1>");
  await fs.writeFile("workspace/projects/site/assets/app.css", "body { color: red }");
  await fs.writeFile("workspace/projects/site/assets/logo.png", new Uint8Array([137, 80, 78, 71]));
  await fs.mkdir("workspace/projects/site/sub");
  await fs.writeFile("workspace/projects/site/sub/index.html", "<!doctype html><h1>sub</h1>");
  await fs.writeFile("workspace/notes.md", "# notes");
  await fs.writeFile("vault.json", '{"secret":true}');
});
afterEach(() => resetPorts());

// ── The pure decision ─────────────────────────────────────────────────────────────────────────────

describe("what a path means", () => {
  it("routes a port, with and without a path", () => {
    expect(routeFor("/~/3000/")).toEqual({ kind: "port", port: 3000, subpath: "/" });
    expect(routeFor("/~/3000")).toEqual({ kind: "port", port: 3000, subpath: "/" });
    expect(routeFor("/~/3000/a/b.css")).toEqual({ kind: "port", port: 3000, subpath: "/a/b.css" });
    expect(routeFor("/~/8080/deep/")).toEqual({ kind: "port", port: 8080, subpath: "/deep/" });
  });

  it("routes a folder under the workspace", () => {
    expect(routeFor(`${VIRTUAL_PREFIX}${FILES_SEGMENT}/projects/site/index.html`)).toEqual({
      kind: "files",
      path: "projects/site/index.html",
      subpath: "/projects/site/index.html",
    });
    expect(routeFor("/~/files/")).toEqual({ kind: "files", path: "", subpath: "/" });
  });

  it("decodes a segment a browser escaped", () => {
    expect(routeFor("/~/files/my%20notes.md")?.subpath).toBe("/my notes.md");
  });

  it("leaves everything else to the network", () => {
    for (const path of ["/", "/index.html", "/assets/app-abc123.js", "/mediapipe/genai/wasm/x.wasm", "/~", "/~/"]) {
      expect(routeFor(path), path).toBeNull();
    }
    expect(isVirtualPath("/assets/x.js")).toBe(false);
  });

  it("refuses a path that is not a port, or that climbs", () => {
    for (const path of ["/~/0/x", "/~/03000/x", "/~/70000/x", "/~/abc/x", "/~/3000x/"]) {
      expect(routeFor(path), path).toBeNull();
    }
    expect(routeFor("/~/3000/../../vault.json")).toBeNull();
    expect(routeFor("/~/files/..%2Fvault.json")).toBeNull();
    expect(routeFor("/~/files/a%ZZb")).toBeNull();
    expect(parsePort("3000")).toBe(3000);
    expect(parsePort("")).toBeNull();
  });

  it("keeps the query, because a handler reads it", () => {
    const route = routeFor("/~/3000/search")!;
    expect(requestUrlFor(route, "?q=cats&page=2")).toBe("/search?q=cats&page=2");
    expect(requestUrlFor(route, "")).toBe("/search");
    expect(requestUrlFor(route, "?")).toBe("/search");
  });
});

describe("the content types", () => {
  it("puts a charset on text and names the binaries", () => {
    expect(serveMimeFor("a/b.html")).toBe("text/html; charset=utf-8");
    expect(serveMimeFor("app.js")).toBe("text/javascript; charset=utf-8");
    expect(serveMimeFor("style.css")).toBe("text/css; charset=utf-8");
    expect(serveMimeFor("logo.png")).toBe("image/png");
    expect(serveMimeFor("f.wasm")).toBe("application/wasm");
  });

  it("never guesses text for something it cannot name — a browser would sniff it", () => {
    expect(serveMimeFor("thing.unknownext")).toBe("application/octet-stream");
    expect(serveMimeFor("LICENSE")).toBe("application/octet-stream");
    expect(serveMimeFor("dir.with.dots/file")).toBe("application/octet-stream");
  });

  it("makes a directory its index", () => {
    expect(staticTarget("workspace/site", "/")).toBe(`workspace/site/${INDEX_FILE}`);
    expect(staticTarget("workspace/site", "")).toBe(`workspace/site/${INDEX_FILE}`);
    expect(staticTarget("workspace/site", "/sub/")).toBe(`workspace/site/sub/${INDEX_FILE}`);
    expect(staticTarget("workspace/site", "/sub", true)).toBe(`workspace/site/sub/${INDEX_FILE}`);
    expect(staticTarget("workspace/site", "/a/b.css")).toBe("workspace/site/a/b.css");
  });
});

// ── The registry ──────────────────────────────────────────────────────────────────────────────────

describe("the registry", () => {
  it("takes a port, lists it, and gives it back", () => {
    const stop = registerPort(4000, () => textResponse(200, "ok"), { label: "test", now: () => 5 });
    expect(listPorts()).toEqual([{ port: 4000, kind: "script", label: "test", since: 5 }]);
    expect(portEntry(4000)?.label).toBe("test");
    stop();
    expect(listPorts()).toEqual([]);
    expect(portEntry(4000)).toBeNull();
    expect(unregister(4000)).toBe(false);
  });

  it("refuses a port that is taken, by name", () => {
    registerPort(3000, () => textResponse(200, "one"));
    expect(() => registerPort(3000, () => textResponse(200, "two"))).toThrow(PortInUseError);
    try {
      registerPort(3000, () => textResponse(200, "two"));
    } catch (err) {
      expect((err as Error).message).toContain("kill 3000");
    }
    expect(() => registerPort(0, () => textResponse(200, ""))).toThrow(/not a port/);
    expect(() => registerPort(70000, () => textResponse(200, ""))).toThrow(/not a port/);
  });

  it("stops what was behind the port when it is freed", () => {
    let stopped = false;
    registerPort(3000, () => textResponse(200, ""), { stop: () => (stopped = true) });
    unregister(3000);
    expect(stopped).toBe(true);
  });

  it("tells the panes, and survives a pane that throws", () => {
    const seen: number[] = [];
    const off = onPortsChanged(() => {
      throw new Error("a pane blew up");
    });
    const off2 = onPortsChanged(() => seen.push(listPorts().length));
    registerPort(3000, () => textResponse(200, ""));
    unregister(3000);
    expect(seen).toEqual([1, 0]);
    off();
    off2();
    registerPort(3001, () => textResponse(200, ""));
    expect(seen).toEqual([1, 0]);
  });

  it("builds a URL a person can open", () => {
    expect(portUrl(3000, "https://app.example")).toBe("https://app.example/~/3000/");
    expect(portUrl(DEFAULT_SERVE_PORT)).toBe("/~/3000/");
  });
});

// ── A folder, served ──────────────────────────────────────────────────────────────────────────────

describe("a folder on a port", () => {
  it("serves the index for the root and for a directory", async () => {
    serveFolder(fs, 3000, "projects/site");
    const root = await handleVirtualRequest({ kind: "port", port: 3000, subpath: "/" }, GET("/"));
    expect(root.status).toBe(200);
    expect(decoder.decode(root.body)).toContain("home");
    expect(root.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(root.headers["cache-control"]).toBe("no-store");

    for (const url of ["/sub", "/sub/"]) {
      const sub = await handleVirtualRequest({ kind: "port", port: 3000, subpath: url }, GET(url));
      expect(decoder.decode(sub.body), url).toContain("sub");
    }
  });

  it("serves a nested file with its own content type, and the bytes of a binary", async () => {
    serveFolder(fs, 3000, "projects/site");
    const css = await handleVirtualRequest({ kind: "port", port: 3000, subpath: "/assets/app.css" }, GET("/assets/app.css"));
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(decoder.decode(css.body)).toBe("body { color: red }");
    const png = await handleVirtualRequest({ kind: "port", port: 3000, subpath: "/assets/logo.png" }, GET("/assets/logo.png"));
    expect([...png.body]).toEqual([137, 80, 78, 71]);
    expect(png.headers["content-length"]).toBe("4");
  });

  it("keeps the query out of the filename", async () => {
    serveFolder(fs, 3000, "projects/site");
    const answer = await handleVirtualRequest(
      { kind: "port", port: 3000, subpath: "/assets/app.css" },
      GET("/assets/app.css?v=2"),
    );
    expect(answer.status).toBe(200);
  });

  it("404s what is not there, and says what a folder is served as", async () => {
    const handler = folderHandler(fs, "workspace/projects/site");
    const missing = await handler(GET("/nope.css"));
    expect(missing.status).toBe(404);
    const noIndex = await handler(GET("/assets/"));
    expect(noIndex.status).toBe(404);
    expect(decoder.decode(noIndex.body)).toContain(INDEX_FILE);
  });

  it("answers HEAD with no body, and refuses a POST as a static server does", async () => {
    const handler = folderHandler(fs, "workspace/projects/site");
    const head = await handler({ method: "HEAD", url: "/", headers: {}, body: null });
    expect(head.status).toBe(200);
    expect(head.body.byteLength).toBe(0);
    expect(head.headers["content-length"]).toBe("28");
    const post = await handler({ method: "POST", url: "/", headers: {}, body: null });
    expect(post.status).toBe(405);
  });

  it("cannot be walked out of", async () => {
    const handler = folderHandler(fs, "workspace/projects/site");
    const escaped = await handler(GET("/../../vault.json"));
    expect(escaped.status).toBe(403);
    expect(decoder.decode(escaped.body)).toContain("outside the folder");
  });

  it("serves the workspace itself under /~/files/", async () => {
    setWorkspaceFs(fs);
    const answer = await handleVirtualRequest({ kind: "files", path: "notes.md", subpath: "/notes.md" }, GET("/notes.md"));
    expect(decoder.decode(answer.body)).toBe("# notes");
    expect(answer.headers["content-type"]).toBe("text/markdown; charset=utf-8");
  });

  it("says there is no agent rather than 404ing when the tab has none", async () => {
    const answer = await handleVirtualRequest({ kind: "files", path: "notes.md", subpath: "/notes.md" }, GET("/notes.md"));
    expect(answer.status).toBe(503);
  });

  it("says nothing is listening, and names what is", async () => {
    serveFolder(fs, 3000, "projects/site");
    const answer = await handleVirtualRequest({ kind: "port", port: 9999, subpath: "/" }, GET("/"));
    expect(answer.status).toBe(502);
    expect(decoder.decode(answer.body)).toContain("3000");
  });

  it("refuses a folder outside the workspace before it registers anything", () => {
    expect(() => serveFolder(fs, 3000, "../secrets")).toThrow();
    expect(listPorts()).toEqual([]);
  });
});

// ── The bridge ────────────────────────────────────────────────────────────────────────────────────

describe("the bridge", () => {
  it("knows one of its own messages", () => {
    expect(isBridgeMessage({ type: "00-virtual-request", route: {}, request: {} })).toBe(true);
    for (const other of [null, "hello", { type: "skip-waiting" }, { type: "00-virtual-request" }]) {
      expect(isBridgeMessage(other)).toBe(false);
    }
  });

  it("always answers on the port it was given", async () => {
    serveFolder(fs, 3000, "projects/site");
    const replies: unknown[] = [];
    const port = { postMessage: (m: unknown) => replies.push(m) } as unknown as MessagePort;
    await answerBridgeMessage(
      { type: "00-virtual-request", route: { kind: "port", port: 3000, subpath: "/" }, request: GET("/") },
      port,
    );
    expect((replies[0] as { ok: boolean; response: { status: number } }).ok).toBe(true);
    expect((replies[0] as { response: { status: number } }).response.status).toBe(200);
  });

  it("ignores a message that is not ours, and a message with no way back", async () => {
    const replies: unknown[] = [];
    const port = { postMessage: (m: unknown) => replies.push(m) } as unknown as MessagePort;
    await answerBridgeMessage({ type: "skip-waiting" }, port);
    await answerBridgeMessage({ type: "00-virtual-request", route: {}, request: {} }, null);
    expect(replies).toEqual([]);
  });
});

// ── The worker the build ships, answering a real fetch ─────────────────────────────────────────────

describe("the substituted service worker", () => {
  const swSource = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");

  it("carries the marker and calls what the build inlines", () => {
    expect(swSource).toContain("//__VIRTUAL_ROUTE_LIB__");
    for (const name of ["routeFor", "requestUrlFor"]) expect(swSource).toContain(`${name}(`);
    // The prefix is reserved before anything else in the handler, or a `/~/` POST would fall through
    // to the "GET only" early return and hit the network.
    expect(swSource.indexOf("const route = routeFor")).toBeLessThan(swSource.indexOf('if (request.method !== "GET") return;'));
  });

  interface Fetched {
    status: number;
    body: string;
    headers: Headers;
  }

  /** The built worker, in a scope with just enough of a browser, plus whatever clients we hand it. */
  async function runWorker(clients: { url: string; focused?: boolean; bridged?: boolean }[]): Promise<{
    fetch(url: string, init?: RequestInit): Promise<Fetched | null>;
  }> {
    const { inlinePushLib, inlineVirtualRouteLib } = await import("../vite.config.js");
    const withPush = await inlinePushLib(swSource, fileURLToPath(new URL("../src/lib/push-notification.ts", import.meta.url)));
    const code = await inlineVirtualRouteLib(withPush, fileURLToPath(new URL("../src/lib/virtual-route.ts", import.meta.url)));
    const handlers: Record<string, (event: unknown) => void> = {};
    const windows = clients.map((client) => ({
      url: client.url,
      focused: client.focused ?? false,
      postMessage: (message: unknown, transfer: MessagePort[]) => {
        // The page half, for real — this is the shipped `answerBridgeMessage`.
        if (client.bridged !== false) void answerBridgeMessage(message, transfer[0] ?? null);
      },
    }));
    const fakeSelf = {
      addEventListener: (type: string, handler: (event: unknown) => void) => (handlers[type] = handler),
      location: { origin: "https://app.example" },
      registration: { showNotification: () => undefined },
      clients: { matchAll: async () => windows, openWindow: async () => undefined, claim: async () => undefined },
      skipWaiting: async () => undefined,
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("self", "caches", "clients", "console", code)(fakeSelf, {}, fakeSelf.clients, console);

    return {
      async fetch(url, init) {
        let answer: Promise<Response> | null = null;
        handlers.fetch?.({
          request: new Request(url, init),
          respondWith: (promise: Promise<Response>) => (answer = promise),
        });
        if (!answer) return null; // the worker left it to the network
        const response = await (answer as Promise<Response>);
        return { status: response.status, body: await response.text(), headers: response.headers };
      },
    };
  }

  it("serves a port out of the page, over a real MessageChannel", async () => {
    setWorkspaceFs(fs);
    serveFolder(fs, 3000, "projects/site");
    const worker = await runWorker([{ url: "https://app.example/", focused: true }]);
    const answer = await worker.fetch("https://app.example/~/3000/");
    expect(answer?.status).toBe(200);
    expect(answer?.body).toContain("home");
    expect(answer?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(answer?.headers.get("cache-control")).toBe("no-store");
  });

  it("carries the query and the method through to a handler", async () => {
    const seen: { method: string; url: string; body: string }[] = [];
    registerPort(4000, async (request) => {
      seen.push({ method: request.method, url: request.url, body: request.body ? decoder.decode(request.body) : "" });
      return textResponse(201, "made it");
    });
    const worker = await runWorker([{ url: "https://app.example/" }]);
    const answer = await worker.fetch("https://app.example/~/4000/save?q=1", { method: "POST", body: "a=1" });
    expect(answer?.status).toBe(201);
    expect(seen).toEqual([{ method: "POST", url: "/save?q=1", body: "a=1" }]);
  });

  it("serves a workspace file under /~/files/", async () => {
    setWorkspaceFs(fs);
    const worker = await runWorker([{ url: "https://app.example/" }]);
    const answer = await worker.fetch("https://app.example/~/files/projects/site/assets/app.css");
    expect(answer?.body).toBe("body { color: red }");
  });

  it("says the tab is not open rather than hanging, when there is no page to ask", async () => {
    const worker = await runWorker([]);
    const answer = await worker.fetch("https://app.example/~/3000/");
    expect(answer?.status).toBe(504);
    expect(answer?.body).toContain("the app tab is not open");
  });

  it("never asks a served frame to serve itself", async () => {
    // A `/~/` document is a window client too. Asking it would time out for ten seconds and then
    // 504, which is exactly the bug that would look like "the server is slow".
    serveFolder(fs, 3000, "projects/site");
    const worker = await runWorker([
      { url: "https://app.example/~/3000/", focused: true, bridged: false },
      { url: "https://app.example/", focused: false },
    ]);
    const answer = await worker.fetch("https://app.example/~/3000/");
    expect(answer?.status).toBe(200);
  });

  it("leaves the app's own assets to the cache-first path, and other origins alone", async () => {
    const worker = await runWorker([{ url: "https://app.example/" }]);
    expect(await worker.fetch("https://dl.0-0.chat/litert/model.bin")).toBeNull();
    // Not a `/~/` path: it goes down the ordinary asset road (which needs `caches`, not this test's job).
    const asset = await worker.fetch("https://app.example/assets/app.js", { method: "POST" });
    expect(asset).toBeNull();
  });
}, 20_000);

// ── The panes' side ───────────────────────────────────────────────────────────────────────────────

describe("the store the panes read", () => {
  it("mirrors the registry, and stops a port from a button", async () => {
    const { ensurePortRuntime, livePorts, resetPortsState, stopPort, urlForPort } = await import("../src/state/ports.js");
    resetPortsState();
    // No agent and no service worker in a node runner: the wiring says so rather than throwing, and
    // the ports still exist — which is exactly what the pane's one red line reports.
    expect(ensurePortRuntime()).toBe(false);
    registerPort(3000, () => textResponse(200, "ok"), { label: "x" });
    expect(livePorts.value.map((p) => p.port)).toEqual([3000]);
    expect(urlForPort(3000)).toBe("/~/3000/");
    expect(stopPort(3000)).toBe(true);
    expect(livePorts.value).toEqual([]);
    expect(stopPort(3000)).toBe(false);
    resetPortsState();
  });
});

describe("the preview pane's sandbox", () => {
  const pane = readFileSync(fileURLToPath(new URL("../src/components/PreviewPane.vue", import.meta.url)), "utf8");

  /**
   * THIS GUARD CHANGED WHEN THE PREVIEW ORIGIN ARRIVED, and the reason it changed is the whole point
   * of that origin. `allow-scripts` + `allow-same-origin` together are documented as equivalent to
   * removing the sandbox: on THIS origin that pair would hand a previewed page our OPFS and our
   * vault's IndexedDB, so the snapshot frame still may not have it, and the literal
   * `sandbox="allow-scripts"` is still the only sandbox written into this file. The live frame's
   * sandbox is `PREVIEW_SANDBOX`, bound as a prop from `power/preview-host.ts`, and the origin it
   * applies to is the PREVIEW HOST's — a Worker with no bindings and no storage — never ours. So the
   * assertion is now: no hard-coded `allow-same-origin` anywhere in the template, and the one frame
   * that gets it gets it from that constant and is pointed at `hostSrc`.
   */
  it("never lets a page have THIS origin's storage", () => {
    // The TEMPLATE only: the module header quotes the live frame's sandbox in prose, and prose is
    // not what ships to a browser.
    const template = pane.slice(pane.indexOf("<template>"));
    expect(template).not.toMatch(/sandbox="[^"]*allow-same-origin/);
    expect(template).toContain('sandbox="allow-scripts"');
    expect(pane).not.toContain(':src="portSrc"');
    expect(pane).toContain("buildPortPreview");
    // The live frame: someone else's origin, and its sandbox comes from the module that explains why.
    expect(pane).toContain(':sandbox="PREVIEW_SANDBOX"');
    expect(pane).toContain(':src="hostSrc"');
  });
});

describe("a served page, previewed", () => {
  /** What the service worker would have answered, without a service worker. */
  function fakeFetch(pages: Record<string, { body: string | Uint8Array; type?: string; status?: number }>): typeof fetch {
    return (async (url: string) => {
      const page = pages[String(url)];
      if (!page) return new Response("nothing is listening", { status: 502, headers: { "content-type": "text/plain" } });
      const body = typeof page.body === "string" ? page.body : new Uint8Array(page.body).buffer;
      return new Response(body, { status: page.status ?? 200, headers: { "content-type": page.type ?? "text/html" } });
    }) as unknown as typeof fetch;
  }

  it("fetches the page and folds its assets in, so the frame can stay opaque", async () => {
    const { buildPortPreview } = await import("../src/power/preview.js");
    const build = await buildPortPreview(3000, {
      fetch: fakeFetch({
        "/~/3000/": { body: '<html><head><link rel="stylesheet" href="/style.css"></head><body><img src="./logo.png"><script src="app.js"></script></body></html>' },
        "/~/3000/style.css": { body: "h1 { color: red }", type: "text/css" },
        "/~/3000/app.js": { body: "console.log(1)", type: "text/javascript" },
        "/~/3000/logo.png": { body: new Uint8Array([137, 80]), type: "image/png" },
      }),
    });
    expect(build.html).toContain("h1 { color: red }");
    expect(build.html).toContain("console.log(1)");
    expect(build.html).toContain("data:image/png;base64,");
    expect(build.missing).toEqual([]);
  });

  it("names what it could not fetch and leaves an off-origin URL alone", async () => {
    const { buildPortPreview } = await import("../src/power/preview.js");
    const build = await buildPortPreview(3000, {
      fetch: fakeFetch({
        "/~/3000/": { body: '<link rel="stylesheet" href="gone.css"><script src="https://cdn.example/x.js"></script>' },
      }),
    });
    expect(build.missing).toEqual(["gone.css"]);
    expect(build.external).toEqual(["https://cdn.example/x.js"]);
  });

  it("shows a refusal, or a non-page, as text rather than pretending it is a page", async () => {
    const { buildPortPreview } = await import("../src/power/preview.js");
    const dead = await buildPortPreview(3000, { fetch: fakeFetch({}) });
    expect(dead.html).toContain("nothing is listening");
    const json = await buildPortPreview(3000, {
      fetch: fakeFetch({ "/~/3000/": { body: '{"a":1}<script>x</script>', type: "application/json" } }),
    });
    expect(json.html).toContain("&lt;script&gt;");
  });
});
