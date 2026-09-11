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

  it("gives ONNX Runtime's worker glue the embedder policy, or the worker spawn is refused", () => {
    // Found live on 2026-09-11: ORT's threaded build spawns dedicated workers from its `.mjs`, and a
    // worker created by a cross-origin-isolated document is refused unless its OWN script response
    // carries a compatible COEP. The main-thread fetch of the same file answers 200, so the symptom is
    // a session build that never finishes and no error anyone can see.
    expect(headersFor("/ort/ort-wasm-simd-threaded.asyncify.mjs", "runtime-worker")).toEqual({
      "cross-origin-embedder-policy": COEP,
      "cross-origin-resource-policy": "same-origin",
    });
    // NOT the document's set: `Cross-Origin-Opener-Policy` means nothing on a subresource.
    expect(headersFor("/ort/x.wasm", "runtime-worker")["cross-origin-opener-policy"]).toBeUndefined();
    // And it is not `cross-origin` either: these bytes are the app's own, unlike the mirror's.
    expect(headersFor("/ort/x.wasm", "runtime-worker")["cross-origin-resource-policy"]).toBe("same-origin");
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
    expect(kindFor("/onnx/onnx-community/gemma-4-E2B-it-ONNX/config.json")).toBe("mirror");
    // `/ort/` is ONNX Runtime Web's own wasm: under the 25 MiB cap, so a static file from public/ and
    // this origin's own bytes. Calling it `mirror` would put `cross-origin` on the app's own runtime —
    // and calling it `asset` would drop the embedder policy its WORKERS need (see below).
    expect(kindFor("/ort/ort-wasm-simd-threaded.asyncify.wasm")).toBe("runtime-worker");
    expect(kindFor("/ort/ort-wasm-simd-threaded.asyncify.mjs")).toBe("runtime-worker");
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

  /**
   * The third local runtime's weights (2026-09-11). Unlike `/litert/`, which is flat and has a closed
   * list of extensions, this prefix carries a repo's own relative layout — so the door is a SHAPE, and
   * what a test has to hold is where that shape stops.
   */
  describe("the /onnx/ door", () => {
    const onnx = (path: string) => worker.fetch(new Request(`https://infinite-site.example${path}`), env);

    it("serves a repo's file, and the one subfolder those repos use", async () => {
      for (const path of [
        "/onnx/onnx-community/gemma-4-E2B-it-ONNX/config.json",
        "/onnx/onnx-community/gemma-4-E2B-it-ONNX/tokenizer.json",
        "/onnx/onnx-community/gemma-4-E2B-it-ONNX/chat_template.jinja",
        "/onnx/onnx-community/gemma-4-E2B-it-ONNX/onnx/decoder_model_merged_q4f16.onnx",
        "/onnx/onnx-community/gemma-4-E2B-it-ONNX/onnx/decoder_model_merged_q4f16.onnx_data",
      ]) {
        const response = await onnx(path);
        expect(response.status, path).toBe(200);
        // Published to be fetched from anywhere, and by an isolated page: both need `cross-origin`.
        expect(policy(response), path).toEqual({ coop: null, coep: null, corp: "cross-origin" });
        expect(response.headers.get("access-control-allow-origin"), path).toBe("*");
        expect(response.headers.get("accept-ranges"), path).toBe("bytes");
        // Content-addressed by the revision in the published key, so it never changes under its name.
        expect(response.headers.get("cache-control"), path).toContain("immutable");
      }
    });

    it("answers a ranged read, which is how three gigabytes arrive", async () => {
      const response = await worker.fetch(
        new Request("https://infinite-site.example/onnx/o/m/onnx/x.onnx_data", { headers: { range: "bytes=0-15" } }),
        env,
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 0-15/64");
    });

    it("refuses anything outside the shape, and never falls through to the shell", async () => {
      for (const path of [
        "/onnx/only-one-segment", // no repo
        "/onnx/org/repo/too/deep/for/us.onnx", // deeper than the one subfolder
        // A traversal the URL parser does NOT normalise away, which is the one that could reach the
        // key: `%2e%2e` survives `new URL`, so it is the shape's `[A-Za-z0-9._-]` that refuses it.
        // (A plain `/onnx/org/../../etc/passwd` never arrives here at all — `new URL` collapses it to
        // `/etc/passwd`, which is not under this prefix and is answered by the shell like any miss.)
        "/onnx/org/%2e%2e/x.json",
        "/onnx/org/repo/..", // collapses to `/onnx/org/`, which is not a file name
        "/onnx/", // the bare prefix
      ]) {
        const response = await onnx(path);
        expect(response.status, path).toBe(404);
        expect(await response.text(), path).toBe("not found");
      }
    });

    it("answers a preflight, because a cross-origin Range needs one", async () => {
      const response = await worker.fetch(
        new Request("https://infinite-site.example/onnx/o/m/config.json", { method: "OPTIONS" }),
        env,
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-headers")).toContain("range");
    });
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
