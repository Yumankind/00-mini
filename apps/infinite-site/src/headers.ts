/**
 * Cross-origin isolation, decided in one place.
 *
 * WHY THE ORIGIN IS ISOLATED AT ALL. `SharedArrayBuffer` — and therefore `Atomics.wait`, and
 * therefore a SYNCHRONOUS filesystem for a script running in a Worker — exists only in a page the
 * browser calls `crossOriginIsolated`. That is not a flag; it is two response headers on the
 * document (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy`), and the
 * browser grants the capability only when both are there. Without them `node script.js` in this app
 * can never do `readFileSync` against the real workspace — it answers from a snapshot taken when the
 * script started, which is what `SyncUnsupportedError` says today (apps/infinite/src/power/js-runner.ts).
 *
 * WHY `credentialless` AND NOT `require-corp`. `require-corp` demands that EVERY cross-origin
 * subresource opt in with a `Cross-Origin-Resource-Policy` header of its own. This app loads bytes
 * from hosts it does not own (the model mirror, the relay, the SFU); `credentialless` gets the same
 * isolation by stripping credentials from no-cors cross-origin loads instead of demanding a header
 * from the far side, so a CORS-enabled fetch — which is every cross-origin load this app makes —
 * keeps working unchanged. See README.md, "What still loads under credentialless".
 *
 * WHY THE POLICY IS PER ROUTE AND NOT PER WORKER. Two of this Worker's routes exist to be used BY
 * SOMEBODY ELSE'S PAGE: `/e/<ref>.js` is the embed loader a third-party site puts in a `<script>`,
 * and `/m/*` is the local-model chunk that loader imports. Isolating those would be isolating the
 * wrong origin — a `Cross-Origin-Resource-Policy: same-origin` on the loader is a loader no site can
 * load. They carry `cross-origin` instead, which is the header that says "yes, embed me". Same for
 * the R2 mirror: those bytes are published to be fetched from anywhere.
 *
 * `/~/…` (a virtual port or a served folder, apps/infinite/public/sw.js) carries no policy at all.
 * Those responses normally never reach the network — the service worker makes them from a script
 * running in the app's tab — and when one does reach here it is the SPA shell answering a route that
 * belongs to a page, not a document this Worker is deciding a policy for.
 */

/** What a response IS, which is the only thing the policy depends on. */
export type ResponseKind =
  /** An HTML document: the app shell, at `/` or at any SPA route. */
  | "document"
  /** `/sw.js`. A service worker inherits isolation from ITS OWN response, not from the page's. */
  | "service-worker"
  /** This origin's own bytes: hashed assets, icons, the manifest, robots.txt. */
  | "asset"
  /** Made to be loaded by a third-party page: the embed loader and its model chunk. */
  | "embed"
  /** The R2 mirror (`/mediapipe/genai/wasm/*`, `/litert/*`) — published to be fetched anywhere. */
  | "mirror"
  /** `/~/…`, answered by a script in the app's tab. No policy of ours. */
  | "served";

/** `Cross-Origin-Embedder-Policy`. One value, named once, so the README and the tests quote it. */
export const COEP = "credentialless";
/** `Cross-Origin-Opener-Policy`. `same-origin` is the half that severs the opener relationship. */
export const COOP = "same-origin";

/** The two prefixes served from R2, and the two served to other people's pages. */
const MIRROR_PREFIXES = ["/mediapipe/genai/wasm/", "/litert/"];
const EMBED_MODEL_PREFIX = "/m/";
const SERVED_PREFIX = "/~/";
const EMBED_PATH = /^\/e\/[A-Za-z0-9_-]{4,80}\.js$/;

/**
 * What this path is, when the answer is a real file or a Worker-made response rather than the SPA
 * fallback. `document` is decided by the CALLER for anything that ends up serving index.html,
 * because a miss is only a document once this Worker has decided to answer it with the shell.
 */
export function kindFor(pathname: string): ResponseKind {
  if (pathname.startsWith(SERVED_PREFIX)) return "served";
  if (EMBED_PATH.test(pathname) || pathname.startsWith(EMBED_MODEL_PREFIX)) return "embed";
  if (MIRROR_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return "mirror";
  if (pathname === "/sw.js") return "service-worker";
  if (pathname === "/" || pathname === "/index.html" || pathname.endsWith(".html")) return "document";
  return "asset";
}

/**
 * The cross-origin headers this response must carry, and nothing else. Pure: a path and a kind in,
 * a small map out, so the decision is a unit test rather than a curl against a deploy.
 */
export function headersFor(pathname: string, kind: ResponseKind): Record<string, string> {
  switch (kind) {
    case "document":
    case "service-worker":
      // The document that must be isolated, and the worker that serves it offline from cache. Both
      // also refuse to be embedded elsewhere: nothing on the web has a reason to frame the shell.
      return {
        "cross-origin-opener-policy": COOP,
        "cross-origin-embedder-policy": COEP,
        "cross-origin-resource-policy": "same-origin",
      };
    case "asset":
      // Isolation says nothing about these; `same-origin` says the app's own bundle is the app's.
      return { "cross-origin-resource-policy": "same-origin" };
    case "embed":
    case "mirror":
      // The whole point of both is that another origin loads them.
      return { "cross-origin-resource-policy": "cross-origin" };
    case "served":
      return {};
    default: {
      // A kind that does not exist cannot be given a policy by guessing. Exhaustive by construction.
      const never: never = kind;
      throw new Error(`no cross-origin policy for ${String(never)} (${pathname})`);
    }
  }
}

/** Put the decision on a `Headers` — the one place the map above becomes a response. */
export function applyCrossOrigin(headers: Headers, pathname: string, kind: ResponseKind): Headers {
  for (const [name, value] of Object.entries(headersFor(pathname, kind))) headers.set(name, value);
  return headers;
}
