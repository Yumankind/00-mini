/**
 * THE PARENT SIDE OF THE LIVE PREVIEW — this app talking to the preview origin.
 *
 * WHY `allow-same-origin` IS HERE AND IS NOT A MISTAKE. Everywhere else in this app that flag is
 * forbidden beside `allow-scripts`, and for a good reason: on OUR origin the pair is documented as
 * equivalent to removing the sandbox, and it would hand a page the agent wrote this app's OPFS,
 * IndexedDB vault and DOM. The frame opened here is not on our origin. It is on the PREVIEW origin
 * (`apps/infinite-preview-site`, a Worker with no bindings and no storage of its own), so
 * "same origin" means same as ITSELF: the frame keeps an identity, which is what lets it register a
 * service worker and be served by one, and that identity is not ours, so there is nothing of the
 * person's inside it to reach. That is the entire reason the second origin exists — see review item
 * 15 of docs/HANDOFF-infinite-agent.md and the measured write-up at the top of `virtual-ports.ts`:
 * on one origin a browser offers only "opaque and never served" or "served and holding the vault".
 *
 * WHAT CROSSES THE BORDER, AND WHAT DOES NOT. What crosses: the bytes of ONE folder the person chose
 * to preview, and the answers to virtual-port requests for that preview. What does not: the vault,
 * the agent's identity files, anything outside the folder, and any dot-folder inside it (`planFileSet`
 * in `src/lib/pick.ts` refuses those by name). Nothing is ever written back — the preview origin can
 * ask this app to SERVE a port, and can tell it what a person clicked, and that is the whole of its
 * vocabulary.
 *
 * WHY THE HANDSHAKE ENDS ON A PORT. The host posts `00-preview-ready` to this app's exact origin (it
 * learned it from the fragment of the URL we framed it at, which never leaves the browser) with one
 * `MessagePort` attached. Everything after that travels on the port, so neither side has to keep
 * checking origins on a shared `window` bus that any other frame can also post to.
 */
import type { AgentFs } from "@00/agent-fs";
import {
  MSG_ERROR,
  MSG_FILE,
  MSG_FILES,
  MSG_INSPECT,
  MSG_NAV,
  MSG_NAVIGATE,
  MSG_PICK,
  MSG_PICK_CLEAR,
  MSG_PORT_REQUEST,
  MSG_PORT_RESPONSE,
  MSG_READY,
  PREVIEW_PROTOCOL,
  entryPageFor,
  isPickMessage,
  planFileSet,
  previewPortUrl,
  previewSiteUrl,
  type FileSetPlan,
  type PickedElement,
} from "../lib/pick.js";
import { serveMimeFor } from "../lib/virtual-route.js";
import { handleVirtualRequest, type VirtualResponse } from "./virtual-ports.js";

/**
 * The sandbox the host frame gets. `allow-same-origin` is the preview origin's own — see the header.
 * `allow-forms` so a form in the previewed page behaves like a form; `allow-popups` so a
 * `target="_blank"` link opens rather than silently doing nothing. Deliberately absent:
 * `allow-top-navigation` (a previewed page may not move the app out from under the person) and
 * `allow-modals` (an `alert()` loop in a page the agent wrote must not be able to freeze the app).
 */
export const PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

/** One file on its way over: `bytes: null` means "this one is gone". */
export interface PreviewFile {
  site: string;
  mime: string;
  bytes: Uint8Array | null;
  /** The workspace path, so the served page can say which file it came from. */
  source?: string;
}

export interface PreviewHostEvents {
  onPick?: (pick: PickedElement) => void;
  onClear?: () => void;
  onNav?: (nav: { url: string; title: string; source: string | null }) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
}

export interface PreviewHost {
  /** `https://<host>/#o=<this origin>` — what the iframe's `src` must be. */
  readonly url: string;
  /** Resolves when the host has handed over its control port; rejects on the timeout. */
  ready(): Promise<void>;
  send(files: PreviewFile[], siteId: string, entry: string): void;
  update(file: PreviewFile): void;
  navigate(url: string): void;
  setInspect(on: boolean): void;
  /** Where a served page lives on the preview origin, for the pane's address line. */
  siteUrl(siteId: string, path: string): string;
  portUrl(siteId: string, port: number, subpath?: string): string;
  destroy(): void;
}

/** How long the host has to say hello before the pane gives up and says so. */
export const HANDSHAKE_TIMEOUT_MS = 15_000;

/** `https://host` + this app's origin in the fragment — which is never sent to the server. */
export function hostUrl(origin: string, appOrigin: string): string {
  return `${origin}/#o=${encodeURIComponent(appOrigin)}`;
}

export function createPreviewHost(
  frame: HTMLIFrameElement,
  origin: string,
  events: PreviewHostEvents = {},
  opts: { appOrigin?: string; serve?: typeof handleVirtualRequest; timeoutMs?: number } = {},
): PreviewHost {
  const appOrigin = opts.appOrigin ?? (typeof location === "undefined" ? "" : location.origin);
  const serve = opts.serve ?? handleVirtualRequest;
  let control: MessagePort | null = null;
  let settle: (() => void) | null = null;
  let fail: ((err: Error) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const readyPromise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  timer = setTimeout(() => {
    fail?.(new Error(`the preview host at ${origin} did not answer within ${Math.round((opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS) / 1000)}s`));
  }, opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);

  function onControlMessage(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const message = data as { kind?: string; v?: number };
    if (message.kind === MSG_PICK) {
      if (isPickMessage(data)) events.onPick?.(data);
      return;
    }
    if (message.kind === MSG_PICK_CLEAR) {
      events.onClear?.();
      return;
    }
    if (message.kind === MSG_NAV) {
      const nav = data as { url?: string; title?: string; source?: string | null };
      events.onNav?.({ url: nav.url ?? "", title: nav.title ?? "", source: nav.source ?? null });
      return;
    }
    if (message.kind === MSG_ERROR) {
      events.onError?.(String((data as { message?: unknown }).message ?? "the preview host failed"));
      return;
    }
    if (message.kind === MSG_PORT_REQUEST) {
      void answerPort(data as PortRequest);
    }
  }

  interface PortRequest {
    id: number;
    port: number;
    request: { method: string; url: string; headers: Record<string, string>; body: Uint8Array | null };
  }

  async function answerPort(message: PortRequest): Promise<void> {
    // The reply is ALWAYS sent, a throw included: the preview worker is sitting on a 10 s timer, and
    // a request that is never answered becomes a 504 the person cannot explain.
    let answer: { ok: boolean; response?: VirtualResponse; error?: string };
    try {
      const response = await serve({ kind: "port", port: message.port, subpath: message.request.url.split("?")[0] ?? "/" }, message.request);
      answer = { ok: true, response };
    } catch (err) {
      answer = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    control?.postMessage({ kind: MSG_PORT_RESPONSE, v: PREVIEW_PROTOCOL, id: message.id, answer });
  }

  function onWindowMessage(event: MessageEvent): void {
    if (event.origin !== origin || event.source !== frame.contentWindow) return;
    const data = event.data as { kind?: string; v?: number } | null;
    if (!data) return;
    /**
     * THE FAILURE ARRIVES ON THE WINDOW, NOT ON THE PORT, and it has to: the host page posts this
     * exactly when it could NOT get far enough to hand a port over — a browser with service workers
     * blocked, a registration that 404s. Measured while building this: without the branch, a host
     * that had already printed its own error inside the frame left the app "connecting" for the full
     * fifteen seconds before the timeout dropped it back to the snapshot, and the person watched a
     * frame with an error in it and a pane that claimed to be fine.
     */
    if (data.kind === MSG_ERROR) {
      const message = String((data as { message?: unknown }).message ?? "the preview host failed to start");
      if (timer) clearTimeout(timer);
      events.onError?.(message);
      fail?.(new Error(message));
      return;
    }
    if (data.kind !== MSG_READY) return;
    if (data.v !== PREVIEW_PROTOCOL) {
      events.onError?.(
        `the preview host speaks protocol ${String(data.v)} and this build speaks ${PREVIEW_PROTOCOL} — one of the two needs a deploy`,
      );
      return;
    }
    const port = event.ports[0];
    if (!port) return;
    control = port;
    port.onmessage = (message) => onControlMessage(message.data);
    port.start();
    if (timer) clearTimeout(timer);
    settle?.();
    events.onReady?.();
  }

  window.addEventListener("message", onWindowMessage);

  return {
    url: hostUrl(origin, appOrigin),
    ready: () => readyPromise,
    send(files, siteId, entry) {
      control?.postMessage({ kind: MSG_FILES, v: PREVIEW_PROTOCOL, siteId, entry, files });
    },
    update(file) {
      control?.postMessage({ kind: MSG_FILE, v: PREVIEW_PROTOCOL, file });
    },
    navigate(url) {
      control?.postMessage({ kind: MSG_NAVIGATE, v: PREVIEW_PROTOCOL, url });
    },
    setInspect(on) {
      control?.postMessage({ kind: MSG_INSPECT, v: PREVIEW_PROTOCOL, on });
    },
    siteUrl: (siteId, path) => previewSiteUrl(origin, siteId, path),
    portUrl: (siteId, port, subpath) => previewPortUrl(origin, siteId, port, subpath),
    destroy() {
      if (timer) clearTimeout(timer);
      window.removeEventListener("message", onWindowMessage);
      control?.close();
      control = null;
    },
  };
}

// ── Reading the folder ────────────────────────────────────────────────────────────────────────────

export interface FileSetResult {
  plan: FileSetPlan;
  files: PreviewFile[];
  entry: string;
}

/**
 * A workspace folder, read and packed for the host.
 *
 * FOLDER-SCOPED, never the whole agent. The root is the folder of the page being previewed, so a
 * preview of `workspace/projects/site/index.html` carries `workspace/projects/site/**` and nothing
 * else — not the agent's identity files, not another project, and never `vault.json`. The cap and
 * the dot-folder rule are in `planFileSet`, which is pure and tested; this is only the part that
 * awaits.
 */
export async function buildFileSet(
  fs: AgentFs,
  root: string,
  opts: { entry?: string; maxBytes?: number; maxFiles?: number } = {},
): Promise<FileSetResult> {
  const listed: { path: string; size: number }[] = [];
  for await (const entry of fs.walk(root, { maxEntries: 5000 })) {
    listed.push({ path: entry.path, size: entry.stat.size });
  }
  const plan = planFileSet(root, listed, serveMimeFor, opts);
  if (plan.refusal) return { plan, files: [], entry: "" };
  const files: PreviewFile[] = [];
  for (const item of plan.entries) {
    files.push({ site: item.site, mime: item.mime, bytes: await fs.readFile(item.path), source: item.path });
  }
  return { plan, files, entry: entryPageFor(plan, opts.entry) };
}

/** One file, re-read after a `file_changed`. `bytes: null` when it went away. */
export async function reReadFile(fs: AgentFs, root: string, path: string): Promise<PreviewFile | null> {
  const prefix = root === "" ? "" : `${root.replace(/\/+$/, "")}/`;
  if (prefix && !path.startsWith(prefix)) return null;
  const site = prefix ? path.slice(prefix.length) : path;
  if (!site || site.split("/").some((segment) => segment.startsWith("."))) return null;
  const stat = await fs.stat(path);
  if (!stat || stat.kind !== "file") return { site, mime: serveMimeFor(path), bytes: null, source: path };
  return { site, mime: serveMimeFor(path), bytes: await fs.readFile(path), source: path };
}
