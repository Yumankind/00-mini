/**
 * Virtual ports — what `server.listen(3000)` means in a browser tab.
 *
 * WHY. A tab cannot bind a TCP port; nothing in a browser can. But everything a person wants from
 * `node server.js` — hit it, see it, iterate — needs a URL. So the port becomes a HANDLER in this
 * registry, the service worker turns `/~/3000/…` on this origin into a message to the page
 * (`public/sw.js`, routing decided by `src/lib/virtual-route.ts`), and the page calls the handler and
 * sends the bytes back. `serveFolder` is the same road for a folder of files, which is what
 * `npx serve` means here. Nothing is proxied, nothing leaves the machine, and the moment the tab
 * closes every port is gone — which is the truth about a server that lives in a tab, said out loud in
 * the 504 the worker answers with.
 *
 * ── THE SANDBOX DECISION (this is the honest part, and it is a real limit) ──────────────────────
 *
 * A service worker's scope is a PATH on the origin that registered it. It cannot serve a different
 * origin, and a second registration cannot change that: `/~/3000/` is unavoidably a URL on the app's
 * own origin. So a page served here is, at the network level, our own origin — and a top-level tab
 * opened at `/~/3000/` is a document on our origin with our OPFS, our IndexedDB and our Cache
 * Storage reachable from its script. That is the browser's answer, not a bug we can fix from here.
 *
 * WHAT WAS MEASURED, because the obvious mitigation turns out not to exist. Chrome 152, headless,
 * against this app's own production build (`vite build && vite preview`, the real `public/sw.js`, a
 * real handler registered on 3000):
 *
 *   - An iframe with `sandbox="allow-scripts allow-forms"` (no `allow-same-origin`, so an OPAQUE
 *     origin) is NOT SERVED AT ALL: the page bridge received zero requests for its navigation. A
 *     service worker does not control an opaque-origin client, and the navigation is not intercepted
 *     on its behalf either. The frame gets whatever the network gives, which on this origin is the
 *     app's own `index.html`.
 *   - The same iframe WITHOUT the sandbox attribute is served normally, and from inside it
 *     `location.origin` is this app's, with `localStorage` and `navigator.storage.getDirectory()`
 *     both readable. So "served" and "holding this app's storage" are the same state.
 *   - The APP'S OWN PAGE can `fetch("/~/3000/…")` and gets the handler's bytes, document and assets
 *     alike.
 *
 * So the pane takes the third road: it FETCHES the served page and inlines it into the opaque
 * `srcdoc` frame a workspace file already gets (`buildPortPreview` in `src/power/preview.ts`). The
 * person sees the page; the page sees no storage of ours; and what it costs — a snapshot, no links,
 * no live requests — is printed above the frame. "Open in a new tab" is the full-fidelity road, has
 * no sandbox at all, and is a button a person presses knowing that: open a page you wrote, not a
 * page you pasted.
 *
 * The proper fix is a SEPARATE ORIGIN for served content — `sandbox.<product>`, or a second worker
 * scope on a second host — and it needs a product origin to exist first (§12.1 is still open) plus,
 * for anything that wants `SharedArrayBuffer` or a synchronous filesystem, cross-origin isolation
 * headers this dev server does not send. That is the next round, and until it lands this module never
 * serves anything to a THIRD party: the registry is per tab, the URLs work only in the browser that
 * registered them, and there is no network listener anywhere.
 *
 * NO CACHING, EVER. Every response leaves here with `cache-control: no-store`, and the fetch handler
 * refuses to put a `/~/` response in Cache Storage. A cached virtual response would survive the
 * script that produced it, which is the most confusing thing a dev server can do.
 */
import type { AgentFs } from "@00/agent-fs";
import { PathEscapeError, resolveInSandbox } from "@00/agent-runtime";
import { INDEX_FILE, serveMimeFor, staticTarget, type VirtualRoute } from "../lib/virtual-route.js";

// ── The wire between the worker, the page and the script ──────────────────────────────────────────

export interface VirtualRequest {
  method: string;
  /** Node's spelling: path plus query, never an absolute URL. */
  url: string;
  headers: Record<string, string>;
  /** Bytes, or `null` for a GET. */
  body: Uint8Array | null;
}

export interface VirtualResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type PortHandler = (request: VirtualRequest) => Promise<VirtualResponse> | VirtualResponse;

export interface PortEntry {
  port: number;
  /** `script` is a `listen()` inside a running script; `folder` is `serve`. */
  kind: "script" | "folder";
  /** What to show a person: the workspace path for a folder, the script name for a script. */
  label: string;
  /** `Date.now()` when it was registered — the terminal prints "since". */
  since: number;
}

/** Registering a port that is already taken is the one error a caller must handle by name. */
export class PortInUseError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`port ${port} is already in use in this tab — \`ports\` lists them, \`kill ${port}\` frees it`);
    this.name = "PortInUseError";
    this.port = port;
  }
}

/** The workspace is the root of `/~/files/…`, exactly as `/` is the shell's root. */
export const FILES_ROOT = "workspace";
/** What `serve` takes when nobody says otherwise; the number every static server has used forever. */
export const DEFAULT_SERVE_PORT = 3000;

interface Registration extends PortEntry {
  handler: PortHandler;
  /** Called by `unregister` — how a script's Worker is torn down with its port. */
  stop?: () => void;
}

const registry = new Map<number, Registration>();
const watchers = new Set<() => void>();
let workspaceFs: AgentFs | null = null;
let bridged = false;

function changed(): void {
  for (const watcher of [...watchers]) {
    try {
      watcher();
    } catch {
      // A pane that throws while re-rendering must not take the registry down with it.
    }
  }
}

/** The filesystem `/~/files/…` reads from. Set once the agent exists; without it that route 404s. */
export function setWorkspaceFs(fs: AgentFs | null): void {
  workspaceFs = fs;
}

/** Every live port, in port order — what `ports` prints and what the preview pane offers. */
export function listPorts(): PortEntry[] {
  return [...registry.values()]
    .map(({ port, kind, label, since }) => ({ port, kind, label, since }))
    .sort((a, b) => a.port - b.port);
}

export function portEntry(port: number): PortEntry | null {
  const found = registry.get(port);
  return found ? { port: found.port, kind: found.kind, label: found.label, since: found.since } : null;
}

/** A pane subscribes; the returned function unsubscribes. */
export function onPortsChanged(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/**
 * Take a port. Throws `PortInUseError` rather than replacing a live handler: two scripts silently
 * fighting over 3000 is the bug that eats an afternoon, and a real `listen` throws `EADDRINUSE` too.
 */
export function registerPort(
  port: number,
  handler: PortHandler,
  opts: { kind?: PortEntry["kind"]; label?: string; stop?: () => void; now?: () => number } = {},
): () => void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${String(port)}`);
  if (registry.has(port)) throw new PortInUseError(port);
  registry.set(port, {
    port,
    kind: opts.kind ?? "script",
    label: opts.label ?? `port ${port}`,
    since: (opts.now ?? Date.now)(),
    handler,
    stop: opts.stop,
  });
  changed();
  return () => unregister(port);
}

/** Free a port and stop whatever was behind it. `false` when there was nothing there. */
export function unregister(port: number): boolean {
  const found = registry.get(port);
  if (!found) return false;
  registry.delete(port);
  try {
    found.stop?.();
  } catch {
    // Terminating a Worker that has already gone is not an error worth surfacing.
  }
  changed();
  return true;
}

/** Test seam, and what a Restore calls: a new filesystem means none of these ports mean anything. */
export function resetPorts(): void {
  for (const port of [...registry.keys()]) unregister(port);
  workspaceFs = null;
  bridged = false;
}

// ── Serving a folder ──────────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** The one-line body of a refusal; `text/plain` so nothing in it can run. */
export function textResponse(status: number, text: string): VirtualResponse {
  return {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    body: encoder.encode(text),
  };
}

/**
 * A folder of files, served: GET (and HEAD) only, `index.html` for a directory, 404 for the rest.
 *
 * WHY IT REFUSES A POST. This is a static server; a POST that answered 200 would tell a page's form
 * that its submission was accepted, and nothing accepted it. 405 with the reason is what a real
 * static server says.
 */
export function folderHandler(fs: AgentFs, root: string): PortHandler {
  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse(405, `${request.method} is not something a static folder can do — this serves files.`);
    }
    const subpath = request.url.split(/[?#]/)[0] ?? "/";
    let path: string;
    try {
      path = resolveInSandbox(root, decodeURIComponent(subpath).replace(/^\//, "") || ".");
    } catch (err) {
      if (err instanceof PathEscapeError) return textResponse(403, `${subpath}: outside the folder being served.`);
      return textResponse(400, `${subpath}: not a path this can serve.`);
    }
    // A directory (with or without the trailing slash a person forgets) is its index.
    const stat = await fs.stat(path);
    if (stat?.kind === "dir" || subpath === "" || subpath === "/" || subpath.endsWith("/")) {
      path = staticTarget(root, decodeURIComponent(subpath), true);
    }
    const file = await fs.stat(path);
    if (!file || file.kind !== "file") {
      const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
      return textResponse(404, `${relative} is not in this folder.${relative.endsWith(INDEX_FILE) ? ` A folder is served as its ${INDEX_FILE}.` : ""}`);
    }
    const bytes = await fs.readFile(path);
    return {
      status: 200,
      headers: {
        "content-type": serveMimeFor(path),
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
      },
      body: request.method === "HEAD" ? new Uint8Array(0) : bytes,
    };
  };
}

/**
 * `serve ./public -p 3000`: a workspace folder on a virtual port.
 * `workspacePath` is workspace-relative, the way the shell's `/` is the workspace.
 */
export function serveFolder(fs: AgentFs, port: number, workspacePath: string): () => void {
  const root = resolveInSandbox(FILES_ROOT, workspacePath || ".");
  const label = root === FILES_ROOT ? "/" : `/${root.slice(FILES_ROOT.length + 1)}`;
  return registerPort(port, folderHandler(fs, root), { kind: "folder", label });
}

// ── Dispatch ──────────────────────────────────────────────────────────────────────────────────────

/**
 * A routed request → a response. The one place both roads meet, and the only thing the service
 * worker bridge knows how to call.
 */
export async function handleVirtualRequest(route: VirtualRoute, request: VirtualRequest): Promise<VirtualResponse> {
  if (route.kind === "files") {
    if (!workspaceFs) return textResponse(503, "no agent in this tab yet — open the app and try again.");
    return folderHandler(workspaceFs, FILES_ROOT)(request);
  }
  const found = registry.get(route.port);
  if (!found) {
    const live = listPorts();
    const known = live.length ? ` Live here: ${live.map((p) => p.port).join(", ")}.` : " Nothing is listening in this tab.";
    return textResponse(502, `nothing is listening on ${route.port}.${known}`);
  }
  try {
    const response = await found.handler(request);
    return {
      status: response.status,
      headers: { "cache-control": "no-store", ...response.headers },
      body: response.body,
    };
  } catch (err) {
    // The script threw inside its own handler: that is a 500 with the message, exactly as a Node
    // server prints a stack and answers 500. Swallowing it would show an empty page.
    return textResponse(500, `the handler on ${route.port} threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── The bridge the service worker talks to ────────────────────────────────────────────────────────

/** What `public/sw.js` posts; kept as a constant so a rename cannot silently unhook the two halves. */
export const VIRTUAL_MESSAGE = "00-virtual-request";

export interface BridgeMessage {
  type: typeof VIRTUAL_MESSAGE;
  route: VirtualRoute;
  request: VirtualRequest;
}

/** True for a message shaped like one of ours — an extension or another library may post here too. */
export function isBridgeMessage(data: unknown): data is BridgeMessage {
  if (!data || typeof data !== "object") return false;
  const message = data as Partial<BridgeMessage>;
  return message.type === VIRTUAL_MESSAGE && !!message.route && !!message.request;
}

/**
 * Answer one bridged message on the `MessagePort` the worker sent with it.
 *
 * The reply is ALWAYS sent, including for a throw: the worker is sitting on a 10 s timer and a page
 * that never answers turns into a 504 the person cannot explain.
 */
export async function answerBridgeMessage(data: unknown, reply: MessagePort | null): Promise<void> {
  if (!isBridgeMessage(data) || !reply) return;
  try {
    const response = await handleVirtualRequest(data.route, data.request);
    reply.postMessage({ ok: true, response });
  } catch (err) {
    reply.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Listen for the worker. Idempotent, and safe in a tab with no service worker at all (a dev server,
 * a browser with workers disabled) — there the `/~/` URLs simply never resolve, which is why the
 * terminal prints the URL and the pane offers a button rather than promising anything.
 */
export function installServiceWorkerBridge(): boolean {
  if (bridged) return true;
  const container = typeof navigator === "undefined" ? null : navigator.serviceWorker;
  if (!container) return false;
  container.addEventListener("message", (event) => {
    void answerBridgeMessage(event.data, event.ports?.[0] ?? null);
  });
  bridged = true;
  return true;
}

/** The URL a person can open, absolute when there is a page to be absolute against. */
export function portUrl(port: number, origin?: string): string {
  const base = origin ?? (typeof location === "undefined" ? "" : location.origin);
  return `${base}/~/${port}/`;
}
