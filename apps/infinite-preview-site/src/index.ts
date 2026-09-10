/**
 * infinite-preview-site — a second origin, and nothing else.
 *
 * WHY THIS WORKER EXISTS. The Infinite Agent's preview pane used to be a snapshot, and the reason was
 * measured rather than guessed (docs/HANDOFF-infinite-agent.md, review item 15, and the write-up at
 * the top of `apps/infinite/src/power/virtual-ports.ts`): on ONE origin a browser offers exactly two
 * frames, and neither is a preview. A frame with `sandbox="allow-scripts"` and no `allow-same-origin`
 * has an OPAQUE origin, and a service worker never serves an opaque client — the navigation is not
 * intercepted at all. Drop the sandbox and the frame IS served, and it is also the app's own origin,
 * with the app's OPFS, IndexedDB vault and localStorage readable from inside it.
 *
 * A SECOND ORIGIN dissolves that. The app frames this host with
 * `sandbox="allow-scripts allow-same-origin …"`, and "same origin" here means THIS origin — the frame
 * keeps its own identity, so it may register a service worker and be served by it, and that identity
 * is not the app's, so there is nothing of the person's to reach. The storage the frame can touch is
 * the storage this origin has, which is whatever the app just posted and nothing else.
 *
 * WHAT THIS SERVER KNOWS: nothing. There is no database, no binding, no logging of what is previewed,
 * and no state that outlives a request. Three static answers is the whole of it:
 *
 *   GET /                 the bootstrap page (src/bootstrap.ts)
 *   GET /preview-sw.js    the service worker (src/preview-sw.ts)
 *   GET /__inspector.js   the element picker (src/inspector.ts, a pinned copy of the app's)
 *
 * Everything under `/s/…` and `/p/…` is answered by the SERVICE WORKER out of this origin's Cache
 * Storage, from the files the app posted, and never reaches this code. A request for one of them that
 * DOES reach here means the worker is not installed yet, and the honest answer is 503 saying so —
 * not the bootstrap page, which would boot a second copy of the host inside its own frame.
 */
import { BOOTSTRAP_HTML } from "./bootstrap.js";
import { INSPECTOR_SOURCE } from "./inspector.js";
import { PREVIEW_SW_SOURCE } from "./preview-sw.js";

const JS = "text/javascript; charset=utf-8";

/**
 * WHY A COEP HEADER ON A HOST THAT NEEDS NO SharedArrayBuffer.
 *
 * The APP is cross-origin isolated: `apps/infinite-site/src/headers.ts` puts
 * `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` on its
 * document, because a synchronous filesystem for a script in a Worker needs `Atomics.wait` and that
 * needs isolation. A page with a COEP has a rule about what it may FRAME: a cross-origin document
 * must carry a compatible COEP of its own, or the frame is blocked outright. So this header is not
 * about this host's own capabilities at all — it is this host consenting to be embedded by an
 * isolated app, and without it the live preview simply does not load there.
 *
 * `credentialless` and not `require-corp`, for the same reason the app chose it and one more of our
 * own: `require-corp` would demand a `Cross-Origin-Resource-Policy` header from every cross-origin
 * subresource INSIDE the previewed page — a Google font, a CDN script, an image hotlinked from
 * anywhere — and a preview that silently drops the page's own font is a preview that lies about what
 * the page looks like. `credentialless` strips credentials from those no-cors loads instead of
 * demanding a header nobody else will send.
 *
 * IT MUST TRACK THE APP'S. `test/preview-live.test.ts` reads `apps/infinite-site/src/headers.ts` and
 * fails if the two values stop agreeing, because a mismatch is a frame that never renders and an
 * error message that names neither file.
 */
const COEP = "credentialless";

/**
 * Never cached, anywhere. A preview host that serves yesterday's worker to today's app is the single
 * worst failure this thing can have, and the bytes are a few kilobytes over a warm connection.
 */
const NO_STORE = "no-store, must-revalidate";

function js(source: string, extra: Record<string, string> = {}): Response {
  return new Response(source, {
    headers: {
      "content-type": JS,
      "cache-control": NO_STORE,
      // A service worker inherits its isolation from ITS OWN response, not from the page that
      // registers it, so the header goes on the scripts too and not only on the document.
      "cross-origin-embedder-policy": COEP,
      ...extra,
    },
  });
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("This host serves three static files and holds no data; there is nothing to POST to.", {
        status: 405,
        headers: { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" },
      });
    }

    if (url.pathname === "/preview-sw.js") {
      // `Service-Worker-Allowed` is redundant for a worker at the root and is set anyway: the day
      // this moves under a path, its scope should not quietly shrink to that path.
      return js(PREVIEW_SW_SOURCE, { "service-worker-allowed": "/" });
    }

    if (url.pathname === "/__inspector.js") {
      // CORP `cross-origin` because the document that loads this script is served by the service
      // worker inside a frame the APP embeds: a cross-origin embedder policy on the app's side would
      // otherwise block a same-origin subresource for reasons that have nothing to do with this file.
      return js(INSPECTOR_SOURCE, { "cross-origin-resource-policy": "cross-origin" });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(BOOTSTRAP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": NO_STORE,
          "cross-origin-embedder-policy": COEP,
        },
      });
    }

    if (url.pathname.startsWith("/s/") || url.pathname.startsWith("/p/")) {
      return new Response(
        "This path is served by the preview service worker out of this origin's Cache Storage, from " +
          "files the app posted. Reaching the server means the worker is not installed in this " +
          "browser yet — open the host page first.",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": NO_STORE } },
      );
    }

    return new Response("Not found. This host serves /, /preview-sw.js and /__inspector.js.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": NO_STORE },
    });
  },
};
