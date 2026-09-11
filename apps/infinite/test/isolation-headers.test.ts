/**
 * Cross-origin isolation, decided in one place and checked without a deploy.
 *
 * WHY THIS TEST LIVES HERE. `apps/infinite-site` has no `package.json` and no `node_modules` — it is
 * deployed with the Homebrew wrangler and the only thing it serves that is built comes from this
 * package. So the Worker's one piece of real logic is imported across that boundary and run here,
 * with a stub `ASSETS` and a stub bucket. Two levels are checked, because they fail differently: the
 * pure decision (`headersFor`), and the Worker actually putting it on a response — a policy that is
 * right in a function and never reaches a header is a page that is not isolated.
 *
 * THE STAKE. Without these headers `crossOriginIsolated` is false, `SharedArrayBuffer` does not
 * exist, and every synchronous `fs` call in the power shell goes back to being a `SyncUnsupportedError`
 * (src/power/js-runner.ts). With `same-origin` on the wrong route, every site that embeds
 * `/e/<ref>.js` breaks at once. There is no middle outcome to either mistake.
 */
import { describe, expect, it } from "vitest";
import { COEP, COOP, headersFor, kindFor } from "../../infinite-site/src/headers.js";
import worker from "../../infinite-site/src/index.js";

// ── The stubs the Worker needs, and nothing more ─────────────────────────────────────────────────

const FILES: Record<string, { body: string; type: string }> = {
  "/": { body: "<!doctype html><title>Infinite Agent</title>", type: "text/html; charset=utf-8" },
  "/sw.js": { body: "self.addEventListener('fetch', () => {});", type: "text/javascript" },
  "/e.js": { body: "(function(){})();", type: "text/javascript" },
  "/m/brain.js": { body: "export const load = () => {};", type: "text/javascript" },
  "/assets/index-abc123.js": { body: "console.log(1)", type: "text/javascript" },
  "/manifest.webmanifest": { body: "{}", type: "application/manifest+json" },
};

const ASSETS = {
  fetch: async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const file = FILES[path];
    if (!file) return new Response("not found", { status: 404 });
    return new Response(file.body, { status: 200, headers: { "content-type": file.type } });
  },
};

/** One object in the mirror bucket, enough for the two calls the Worker makes. */
function bucketWith(size = 64): {
  head: (key: string) => Promise<unknown>;
  get: (key: string) => Promise<unknown>;
} {
  const meta = {
    size,
    httpEtag: '"deadbeef"',
    writeHttpMetadata: (headers: Headers) => headers.set("content-type", "application/wasm"),
  };
  return {
    head: async () => meta,
    get: async () => ({ ...meta, body: new Response("x".repeat(size)).body }),
  };
}

const env = { ASSETS, MODELS: bucketWith() } as unknown as Parameters<typeof worker.fetch>[1];

async function get(path: string): Promise<Response> {
  return await worker.fetch(new Request(`https://infinite-site.example${path}`), env);
}

const policy = (response: Response): Record<string, string | null> => ({
  coop: response.headers.get("cross-origin-opener-policy"),
  coep: response.headers.get("cross-origin-embedder-policy"),
  corp: response.headers.get("cross-origin-resource-policy"),
});

// ── The decision ─────────────────────────────────────────────────────────────────────────────────

describe("the cross-origin decision", () => {
  it("isolates a document, and says which flavour of embedder policy", () => {
    expect(headersFor("/", "document")).toEqual({
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "credentialless",
      "cross-origin-resource-policy": "same-origin",
    });
    // `credentialless` and not `require-corp`: the app fetches bytes from hosts it does not own, and
    // requiring a header from each of them would be requiring a change to dl.0-0.chat's twin, the
    // relay and the SFU. See apps/infinite-site/README.md.
    expect(COEP).toBe("credentialless");
    expect(COOP).toBe("same-origin");
  });

  it("isolates the service worker too, because its cached shell is what answers offline", () => {
    expect(headersFor("/sw.js", "service-worker")["cross-origin-embedder-policy"]).toBe(COEP);
  });

  it("never puts same-origin on anything another page is meant to load", () => {
    for (const kind of ["embed", "mirror"] as const) {
      expect(headersFor("/e/ia_test_abcdefgh.js", kind)).toEqual({
        "cross-origin-resource-policy": "cross-origin",
      });
    }
  });

  it("leaves a served page alone entirely", () => {
    expect(headersFor("/~/3000/index.html", "served")).toEqual({});
  });

  it("knows what each path is", () => {
    expect(kindFor("/")).toBe("document");
    expect(kindFor("/index.html")).toBe("document");
    expect(kindFor("/sw.js")).toBe("service-worker");
    expect(kindFor("/assets/index-abc123.js")).toBe("asset");
    expect(kindFor("/manifest.webmanifest")).toBe("asset");
    expect(kindFor("/e/ia_test_abcdefgh.js")).toBe("embed");
    expect(kindFor("/m/brain.js")).toBe("embed");
    expect(kindFor("/mediapipe/genai/wasm/genai_wasm_internal.wasm")).toBe("mirror");
    expect(kindFor("/litert/catalog.json")).toBe("mirror");
    expect(kindFor("/~/3000/")).toBe("served");
    // `/e/x.js` is not a ref shape, so it is not the loader — it falls through to the shell.
    expect(kindFor("/e/x.js")).toBe("asset");
  });
});

// ── The Worker, actually answering ───────────────────────────────────────────────────────────────

describe("the site Worker's responses", () => {
  it("isolates the shell, at the root and at every SPA route", async () => {
    for (const path of ["/", "/settings", "/chat/abc"]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(policy(response), path).toEqual({ coop: COOP, coep: COEP, corp: "same-origin" });
    }
  });

  it("isolates the service worker, so the shell it serves from cache is isolated too", async () => {
    const response = await get("/sw.js");
    expect(policy(response)).toEqual({ coop: COOP, coep: COEP, corp: "same-origin" });
  });

  it("leaves the embed loader loadable from any site on the web", async () => {
    const response = await get("/e/ia_test_abcdefgh.js");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("(function()");
    expect(policy(response)).toEqual({ coop: null, coep: null, corp: "cross-origin" });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("leaves the loader's model chunk loadable too, since the loader is what imports it", async () => {
    const response = await get("/m/brain.js");
    expect(policy(response)).toEqual({ coop: null, coep: null, corp: "cross-origin" });
  });

  it("marks the R2 mirror cross-origin, which is what an isolated page needs to fetch it", async () => {
    const response = await get("/mediapipe/genai/wasm/genai_wasm_internal.wasm");
    expect(response.status).toBe(200);
    expect(policy(response)).toEqual({ coop: null, coep: null, corp: "cross-origin" });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("keeps the app's own bundle to the app", async () => {
    const response = await get("/assets/index-abc123.js");
    expect(policy(response)).toEqual({ coop: null, coep: null, corp: "same-origin" });
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  it("does not decide a policy for a page a script in the tab is serving", async () => {
    // `/~/…` reaching the network at all means the service worker is not controlling this load, and
    // what comes back is the shell — but the path is still not ours to put a policy on.
    const response = await get("/~/3000/");
    expect(policy(response)).toEqual({ coop: null, coep: null, corp: null });
  });

  it("still answers a HEAD and a 404 the way it did", async () => {
    const head = await worker.fetch(new Request("https://infinite-site.example/", { method: "HEAD" }), env);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const missing = await worker.fetch(
      new Request("https://infinite-site.example/litert/not-a-weight.exe"),
      env,
    );
    expect(missing.status).toBe(404);
  });
});
