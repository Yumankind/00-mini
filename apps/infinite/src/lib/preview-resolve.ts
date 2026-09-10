/**
 * The preview pane's resolver — a workspace `.html` file turned into ONE self-contained document.
 *
 * WHY INLINE EVERYTHING INSTEAD OF SERVING IT. The pages this renders live in OPFS, which no URL can
 * address: there is no origin under which `./styles.css` would resolve, and a service worker that
 * invented one would have to serve the agent's own files to the page's own origin, which is exactly
 * the boundary the sandbox exists to keep. So the page is assembled first and handed to the iframe
 * whole, via `srcdoc`, inside `sandbox="allow-scripts"` — an OPAQUE origin, so the page can run its
 * own script and reach neither this app's storage nor its DOM.
 *
 * WHY IT IS PURE AND SEPARATE FROM THE READING. Everything here is string → string with an asset map
 * supplied by the caller. The filesystem half lives in `src/power/preview.ts`; this half is the part
 * with the rules a test can pin — which references count, how `../` resolves, what happens to an
 * absolute URL (it is LEFT ALONE, so a page that loads a CDN font still says so in the network tab
 * rather than silently losing it).
 */

/** A reference found in the document, with enough about it to put the answer back. */
export interface AssetRef {
  kind: "style" | "script" | "image";
  /** As written in the document. */
  ref: string;
  /** Agent-root-relative, or `null` when it points outside the workspace or off the machine. */
  path: string | null;
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * `workspace/projects/site/index.html` + `../shared/a.css` → `workspace/projects/shared/a.css`.
 *
 * `null` means "not ours": an absolute URL, a data URI, a fragment, or a path that climbs out of the
 * agent's folder. A climb is refused rather than clamped, the same rule as the runtime's path guard.
 */
export function resolveRelative(basePath: string, ref: string): string | null {
  const raw = ref.trim();
  if (!raw || EXTERNAL.test(raw)) return null;
  const withoutQuery = raw.split(/[?#]/)[0] ?? "";
  if (!withoutQuery) return null;
  const baseDir = basePath.slice(0, Math.max(0, basePath.lastIndexOf("/")));
  const start = withoutQuery.startsWith("/") ? [] : baseDir ? baseDir.split("/") : [];
  const out = [...start];
  for (const segment of withoutQuery.replace(/^\//, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length ? out.join("/") : null;
}

const LINK_RE = /<link\b[^>]*>/gi;
const SCRIPT_RE = /<script\b([^>]*)\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)([^>]*)>\s*<\/script\s*>/gi;
const IMG_RE = /<img\b[^>]*>/gi;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

/** Every local asset the document asks for, in document order, duplicates included. */
export function collectRefs(html: string, basePath: string): AssetRef[] {
  const out: AssetRef[] = [];
  for (const tag of html.match(LINK_RE) ?? []) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    if (!rel.split(/\s+/).includes("stylesheet")) continue;
    const href = attr(tag, "href");
    if (href) out.push({ kind: "style", ref: href, path: resolveRelative(basePath, href) });
  }
  for (const m of html.matchAll(SCRIPT_RE)) {
    const src = unquote(m[2] ?? "");
    if (src) out.push({ kind: "script", ref: src, path: resolveRelative(basePath, src) });
  }
  for (const tag of html.match(IMG_RE) ?? []) {
    const src = attr(tag, "src");
    if (src) out.push({ kind: "image", ref: src, path: resolveRelative(basePath, src) });
  }
  return out;
}

/** Enough of a MIME table for the things a page in a workspace actually loads. */
export function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const table: Record<string, string> = {
    css: "text/css",
    js: "text/javascript",
    mjs: "text/javascript",
    json: "application/json",
    html: "text/html",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
  };
  return table[ext] ?? "application/octet-stream";
}

/** What the caller loaded for one path: text for CSS and JS, a data URL for anything binary. */
export interface LoadedAsset {
  text?: string;
  dataUrl?: string;
}

/**
 * The document with its local assets folded in.
 *
 * A reference the caller could not load is LEFT AS IT WAS: the page then shows a broken image or an
 * unstyled block, which is the truth ("that file is not there"), where silently deleting the tag
 * would look like a bug in the preview.
 */
export function inlinePreview(html: string, basePath: string, assets: Map<string, LoadedAsset>): string {
  let out = html;

  out = out.replace(LINK_RE, (tag) => {
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    if (!rel.split(/\s+/).includes("stylesheet")) return tag;
    const href = attr(tag, "href");
    const path = href ? resolveRelative(basePath, href) : null;
    const asset = path ? assets.get(path) : undefined;
    if (asset?.text === undefined) return tag;
    return `<style data-from="${escapeAttr(href ?? "")}">\n${asset.text}\n</style>`;
  });

  out = out.replace(SCRIPT_RE, (tag, _before: string, src: string) => {
    const path = resolveRelative(basePath, unquote(src));
    const asset = path ? assets.get(path) : undefined;
    if (asset?.text === undefined) return tag;
    // `</script>` inside the body would close this tag early — the one escape every inliner needs.
    return `<script data-from="${escapeAttr(unquote(src))}">\n${asset.text.replace(/<\/script/gi, "<\\/script")}\n</script>`;
  });

  out = out.replace(IMG_RE, (tag) => {
    const src = attr(tag, "src");
    const path = src ? resolveRelative(basePath, src) : null;
    const asset = path ? assets.get(path) : undefined;
    if (!asset?.dataUrl || !src) return tag;
    return tag.replace(src, asset.dataUrl);
  });

  return out;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** A fragment (no `<html>`) still needs a document around it, or the iframe inherits nothing. */
export function ensureDocument(html: string, title: string): string {
  if (/<html[\s>]/i.test(html)) return html;
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8" />',
    `<title>${escapeAttr(title)}</title>`,
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "</head><body>",
    html,
    "</body></html>",
  ].join("\n");
}
