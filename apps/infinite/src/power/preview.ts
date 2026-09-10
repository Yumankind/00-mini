/**
 * The filesystem half of the preview: read an `.html` file and the assets it names, hand back one
 * document. The RULES are in `src/lib/preview-resolve.ts`, which is pure and tested; this is the
 * part that awaits.
 *
 * WHY IT REFUSES TO GO DEEP. Only the references in the page itself are followed — a stylesheet's
 * own `@import` and `url()` are not. That is a real limit, said out loud in `missing`, and it is
 * deliberate: following them means a resolver that walks CSS, and a page that pulls in a hundred
 * sprites would then block the pane on a hundred OPFS reads. One level covers the pages an agent
 * actually writes into `projects/<name>/`.
 */
import type { AgentFs } from "@00/agent-fs";
import {
  collectRefs,
  ensureDocument,
  inlinePreview,
  mimeFor,
  type LoadedAsset,
} from "../lib/preview-resolve.js";
import { VIRTUAL_PREFIX } from "../lib/virtual-route.js";

/** Above this an asset is skipped rather than turned into a megabyte of base64 in a string. */
export const MAX_INLINE_BYTES = 2_000_000;

export interface PreviewBuild {
  /** The document, ready for `srcdoc`. */
  html: string;
  /** References that could not be inlined, as written in the page, so the pane can say which. */
  missing: string[];
  /** External URLs left alone — the page will try to fetch them, and inside the sandbox it may. */
  external: string[];
}

/** Base64 without a Buffer: the browser's own encoder, over a binary string built in chunks. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function buildPreview(fs: AgentFs, path: string): Promise<PreviewBuild> {
  const source = await fs.readText(path);
  const refs = collectRefs(source, path);
  const assets = new Map<string, LoadedAsset>();
  const missing: string[] = [];
  const external: string[] = [];

  for (const ref of refs) {
    if (!ref.path) {
      external.push(ref.ref);
      continue;
    }
    if (assets.has(ref.path)) continue;
    const stat = await fs.stat(ref.path);
    if (!stat || stat.kind !== "file" || stat.size > MAX_INLINE_BYTES) {
      missing.push(ref.ref);
      continue;
    }
    try {
      if (ref.kind === "image") {
        assets.set(ref.path, { dataUrl: `data:${mimeFor(ref.path)};base64,${toBase64(await fs.readFile(ref.path))}` });
      } else {
        assets.set(ref.path, { text: await fs.readText(ref.path) });
      }
    } catch {
      missing.push(ref.ref);
    }
  }

  return {
    html: ensureDocument(inlinePreview(source, path, assets), path.slice(path.lastIndexOf("/") + 1)),
    missing,
    external,
  };
}

/**
 * A SERVED port, previewed — fetched through the service worker, then inlined like any other page.
 *
 * WHY NOT JUST POINT THE IFRAME AT `/~/3000/`. Because a browser will not serve it there. Measured
 * in Chrome 152 against this app's own production build (`vite build && vite preview`, the app's real
 * service worker, a real `/~/` handler): a frame with `sandbox="allow-scripts allow-forms"` and no
 * `allow-same-origin` has an OPAQUE origin, and its navigation NEVER REACHES the service worker —
 * the page bridge saw zero requests for it, while the same frame without the sandbox attribute was
 * served normally and reported `location.origin` as the app's, with `localStorage` and
 * `navigator.storage.getDirectory()` both READABLE from inside it. So the two roads a browser offers
 * are "opaque and not served" or "served and holding this app's storage", and the second is the one
 * the sandbox exists to prevent.
 *
 * The road taken is the third: the PAGE fetches the document and its assets (the app's own tab is
 * controlled, so `/~/3000/…` answers there — also measured), and the result is inlined into one
 * document and handed to the same opaque `srcdoc` iframe a workspace file gets. The person sees the
 * served page; the served page sees no storage of ours.
 *
 * WHAT THIS COSTS, said out loud in the pane: it is a SNAPSHOT. Links inside it do not navigate,
 * `fetch("/api")` from the page's own script has no origin to reach, and only the references in the
 * document itself are followed (the same one level `buildPreview` follows). "Open in a new tab" is
 * the full-fidelity road, and it is a top-level document on this origin — which is why the button
 * says so rather than being the default.
 */
export async function buildPortPreview(
  port: number,
  opts: { fetch?: typeof fetch; base?: string } = {},
): Promise<PreviewBuild> {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.base ?? `${VIRTUAL_PREFIX}${port}/`;
  const response = await doFetch(base);
  const source = await response.text();
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    // The 502/504 the worker answers with is text, and text is what it should look like — a fake
    // page saying "not found" would hide which of the two it was.
    return { html: ensureDocument(`<pre>${escapeText(source)}</pre>`, `:${port}`), missing: [], external: [] };
  }
  if (type && !type.includes("html")) {
    return { html: ensureDocument(`<pre>${escapeText(source)}</pre>`, `:${port}`), missing: [], external: [] };
  }

  const refs = collectRefs(source, "index.html");
  const assets = new Map<string, LoadedAsset>();
  const missing: string[] = [];
  const external: string[] = [];
  for (const ref of refs) {
    if (!ref.path) {
      external.push(ref.ref);
      continue;
    }
    if (assets.has(ref.path)) continue;
    try {
      const asset = await doFetch(`${base}${ref.path}`);
      if (!asset.ok) {
        missing.push(ref.ref);
        continue;
      }
      if (ref.kind === "image") {
        assets.set(ref.path, {
          dataUrl: `data:${mimeFor(ref.path)};base64,${toBase64(new Uint8Array(await asset.arrayBuffer()))}`,
        });
      } else {
        assets.set(ref.path, { text: await asset.text() });
      }
    } catch {
      missing.push(ref.ref);
    }
  }
  return {
    html: ensureDocument(inlinePreview(source, "index.html", assets), `:${port}`),
    missing,
    external,
  };
}

/** A served body shown as text is still text — nothing in it may become a tag. */
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
