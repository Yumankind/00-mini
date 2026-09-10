/**
 * THE PICK — what "click a thing in the preview and tell the agent about it" is made of.
 *
 * WHY THIS MODULE EXISTS, AND WHY IT IS THE ONLY PLACE THE INSPECTOR IS WRITTEN. The live preview
 * runs on a SECOND ORIGIN (`apps/infinite-preview-site`), which cannot import anything from this app
 * — it is a Worker outside the pnpm workspace with no node_modules at all. But the SAME inspector has
 * to run in the snapshot frame too (an opaque `srcdoc` iframe can still `postMessage` its parent), so
 * a second implementation would be two implementations of one algorithm and one of them would rot.
 *
 * So the script is written ONCE, here, as source text, and the preview host carries a byte-identical
 * copy that `test/preview-live.test.ts` pins. The app inlines this copy into the snapshot document
 * (`withInspector`); the host serves its copy at `/__inspector.js` and its service worker injects the
 * `<script>` tag into every HTML page it serves. Two deploys, one algorithm, one test that fails the
 * day they drift.
 *
 * WHY IT IS SOURCE TEXT AND NOT A MODULE. The script must run inside a document this app does not
 * own — an opaque srcdoc frame, or a page on another origin — where there is no bundler, no import
 * map and no module graph. A string is the only thing both roads can carry. It is written in ES5-ish
 * browser JavaScript with no backtick and no `${`, because it lives inside a `String.raw` here and
 * inside another one over there, and both of those would eat an interpolation.
 *
 * WHAT A NODE TEST CAN STILL REACH. The script hangs its pure halves off `globalThis.__00_inspector`
 * before it decides whether to start, and it starts only when there is a `document`. So a vitest run
 * in the node environment evaluates the SHIPPED text and calls the SHIPPED selector algorithm — the
 * one thing that could otherwise pass while the browser ran something else.
 */

// ── The wire ──────────────────────────────────────────────────────────────────────────────────────
//
// Every message in either direction carries `v` and `kind`. `v` is checked, not assumed: a preview
// host deployed before an app (or long after it) is the normal state of two independently deployed
// origins, and a mismatched frame that says so is better than one that silently drops picks.

/** Bumped when a message shape changes in a way the other side cannot ignore. */
export const PREVIEW_PROTOCOL = 1;

/** iframe → app, over `window.postMessage`: the host booted and is offering its control port. */
export const MSG_READY = "00-preview-ready";
/** app → iframe, over the port: here is the whole file set for a site id. */
export const MSG_FILES = "00-preview-files";
/** app → iframe, over the port: one file changed (or, with `bytes: null`, went away). */
export const MSG_FILE = "00-preview-file";
/** app → iframe: point the inner frame at this path under the current site. */
export const MSG_NAVIGATE = "00-preview-navigate";
/** app → iframe: inspect mode on or off. Forwarded by the host into the served page. */
export const MSG_INSPECT = "00-inspect";
/** iframe → app: the service worker wants a virtual port served. */
export const MSG_PORT_REQUEST = "00-preview-port-request";
/** app → iframe: the answer to one of those. */
export const MSG_PORT_RESPONSE = "00-preview-port-response";
/** page → app (via the host, or straight up out of the snapshot frame): a person clicked something. */
export const MSG_PICK = "00-pick";
/** page → app: Escape, or a click on nothing. */
export const MSG_PICK_CLEAR = "00-pick-clear";
/** page → app: the served page navigated; the pane's address line follows it. */
export const MSG_NAV = "00-nav";
/** iframe → app: the host could not do what was asked, with a sentence a person can read. */
export const MSG_ERROR = "00-preview-error";

/** The meta the service worker stamps on a served HTML file: which workspace file it came from. */
export const SOURCE_META = "00-source";
/** The meta the SNAPSHOT road stamps: where to post, since an opaque frame's own origin is `null`. */
export const TARGET_META = "00-target";

// ─── SHARED WITH apps/infinite-preview-site/src/preview-sw.ts — BEGIN ────────────────────────────
// The preview host's service worker decides what one of its own paths means, and this is that
// decision. It is duplicated rather than imported because the host is a separate deploy unit with no
// dependency on this repo's packages; `test/preview-live.test.ts` reads both files and fails the day
// they stop being the same text. Keep it plain: it is inlined into a classic service worker.

/** Files the app posted, served back: `/s/<siteId>/<path>`. */
const PREVIEW_SITE_PREFIX = "/s/";
/** A virtual port, forwarded to the app: `/p/<siteId>/<port>/<path>`. */
const PREVIEW_PORT_PREFIX = "/p/";

/**
 * `pathname` → what the preview worker should do about it, or `null` for "let the network have it".
 *
 * A path with a `..` segment or an undecodable escape is `null` too, and 404 is what the caller
 * answers: the store is keyed by the exact path the app posted, so a climb has nothing to reach, and
 * refusing it here means one shape of nonsense fewer inside the cache lookup.
 */
export function previewRouteFor(
  pathname: string,
):
  | { kind: "site"; siteId: string; path: string }
  | { kind: "port"; siteId: string; port: number; subpath: string }
  | null {
  if (typeof pathname !== "string") return null;
  const site = pathname.startsWith(PREVIEW_SITE_PREFIX);
  const port = pathname.startsWith(PREVIEW_PORT_PREFIX);
  if (!site && !port) return null;
  const rest = pathname.slice(PREVIEW_SITE_PREFIX.length).split("/");
  const siteId = rest.shift() ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(siteId)) return null;
  const decoded: string[] = [];
  for (const raw of rest) {
    if (raw === "") {
      decoded.push("");
      continue;
    }
    let part: string;
    try {
      part = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (part === ".." || part === "." || part.includes("/") || part.includes("\\") || part.includes("\0")) return null;
    decoded.push(part);
  }
  if (site) return { kind: "site", siteId, path: decoded.join("/") };
  const head = decoded.shift() ?? "";
  if (!/^[1-9][0-9]{0,4}$/.test(head) || Number(head) > 65535) return null;
  return { kind: "port", siteId, port: Number(head), subpath: "/" + decoded.join("/") };
}
// ─── SHARED WITH apps/infinite-preview-site/src/preview-sw.ts — END ──────────────────────────────

/** The inverse of the `site` branch: where a workspace file lands on the preview origin. */
export function previewSiteUrl(origin: string, siteId: string, path: string): string {
  const clean = path.replace(/^\/+/, "");
  return `${origin}${PREVIEW_SITE_PREFIX}${siteId}/${clean.split("/").map(encodeURIComponent).join("/")}`;
}

/** The inverse of the `port` branch: where `server.listen(3000)` shows up on the preview origin. */
export function previewPortUrl(origin: string, siteId: string, port: number, subpath = "/"): string {
  const clean = subpath.replace(/^\/+/, "");
  return `${origin}${PREVIEW_PORT_PREFIX}${siteId}/${port}/${clean}`;
}

// ── Where the host lives ──────────────────────────────────────────────────────────────────────────

/**
 * The preview host this build talks to. The DEFAULT is the workers.dev link the integrator deploys
 * `apps/infinite-preview-site` to; `off`, an empty value, a `.invalid` host or anything unparseable
 * means "this build has no live preview", and the pane falls back to the snapshot road rather than
 * pointing an iframe at nothing. Same shape as `relayConfigured()` in `src/mac/config.ts` and
 * `roomsConfigured()` in `src/transfer/config.ts`, for the same reason: a placeholder must be
 * something the UI can SAY, never something a fetch discovers.
 */
export const PREVIEW_ORIGIN_DEFAULT = "https://infinite-preview.powerhouse.workers.dev";

function envPreviewOrigin(): string | undefined {
  const raw = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_PREVIEW_ORIGIN;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** The origin, or `""` when this build has no live preview. The argument is a test seam only. */
export function previewOrigin(raw: string = envPreviewOrigin() ?? PREVIEW_ORIGIN_DEFAULT): string {
  if (raw === "off") return "";
  try {
    const { origin, hostname } = new URL(raw);
    if (hostname.endsWith(".invalid")) return "";
    return origin;
  } catch {
    return "";
  }
}

export function previewHostConfigured(raw?: string): boolean {
  return previewOrigin(raw ?? envPreviewOrigin() ?? PREVIEW_ORIGIN_DEFAULT) !== "";
}

/** The one line the pane shows in place of the live frame. */
export const PREVIEW_NOT_CONFIGURED_LINE =
  "This build has no preview host, so the live road is off and the pane is showing a snapshot. " +
  "Set VITE_PREVIEW_ORIGIN to a deployed apps/infinite-preview-site and rebuild.";

// ── The file set ──────────────────────────────────────────────────────────────────────────────────

/**
 * The cap. Twenty megabytes is what a `postMessage` of a project folder may cost before the tab
 * stutters — a structured clone of that much is copied twice (once out of the page, once into the
 * frame), and above it the honest answer is "this folder is too big for the live preview", not a
 * frozen pane.
 */
export const MAX_FILE_SET_BYTES = 20 * 1024 * 1024;
/** A second cap, on COUNT: ten thousand tiny files is a cheap byte total and a slow clone all the same. */
export const MAX_FILE_SET_FILES = 2000;

export interface FileSetEntry {
  /** The workspace path, as `AgentFs` spells it. */
  path: string;
  /** Where it lands under `/s/<siteId>/` — the path relative to the folder being served. */
  site: string;
  /** What the host stores it with, so the browser is never left to sniff. */
  mime: string;
  size: number;
}

export interface FileSetPlan {
  entries: FileSetEntry[];
  totalBytes: number;
  /** Paths left out, and why — the pane prints this so a missing image is never a mystery. */
  skipped: { path: string; why: string }[];
  /** Non-null when the folder cannot be posted at all; the pane says this and stays on snapshot. */
  refusal: string | null;
}

/**
 * Which of a folder's files go to the preview host, and what they are called there.
 *
 * WHAT IT LEAVES OUT, ON PURPOSE. Anything under a dot-segment: `.git` alone is usually larger than
 * everything a page needs, and none of it is ever fetched by a browser. Anything outside `root`,
 * which cannot happen from a walk of `root` but is checked because this function is also the thing a
 * test points at nonsense. And, once either cap is crossed, everything — a HALF-posted site serves a
 * page whose stylesheet 404s, which looks like a bug in the page rather than a limit of the preview.
 *
 * `mimeFor` comes in as a parameter so this stays pure; every caller passes `serveMimeFor` from
 * `src/lib/virtual-route.ts`, which is the same table the app's own service worker puts on the wire.
 */
export function planFileSet(
  root: string,
  files: { path: string; size: number }[],
  mimeFor: (path: string) => string,
  opts: { maxBytes?: number; maxFiles?: number } = {},
): FileSetPlan {
  const maxBytes = opts.maxBytes ?? MAX_FILE_SET_BYTES;
  const maxFiles = opts.maxFiles ?? MAX_FILE_SET_FILES;
  const prefix = root === "" ? "" : `${root.replace(/\/+$/, "")}/`;
  const entries: FileSetEntry[] = [];
  const skipped: { path: string; why: string }[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (prefix && !file.path.startsWith(prefix)) {
      skipped.push({ path: file.path, why: "outside the folder" });
      continue;
    }
    const site = prefix ? file.path.slice(prefix.length) : file.path;
    if (!site || site.split("/").some((segment) => segment.startsWith("."))) {
      skipped.push({ path: file.path, why: "a dot-folder or dotfile" });
      continue;
    }
    entries.push({ path: file.path, site, mime: mimeFor(file.path), size: file.size });
    totalBytes += file.size;
  }

  entries.sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : 0));

  let refusal: string | null = null;
  if (entries.length > maxFiles) {
    refusal = `${entries.length} files under ${root || "the workspace"} — the live preview posts at most ${maxFiles}. Serve a smaller folder, or use the snapshot.`;
  } else if (totalBytes > maxBytes) {
    refusal = `${formatBytes(totalBytes)} under ${root || "the workspace"} — the live preview posts at most ${formatBytes(maxBytes)}. Serve a smaller folder, or use the snapshot.`;
  }
  return { entries, totalBytes, skipped, refusal };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The entry page of a folder: the file the person selected, or `index.html`, or the first page. */
export function entryPageFor(plan: FileSetPlan, preferred?: string): string {
  const has = (name: string): boolean => plan.entries.some((e) => e.site === name);
  if (preferred && has(preferred)) return preferred;
  if (has("index.html")) return "index.html";
  const first = plan.entries.find((e) => e.site.endsWith(".html"));
  return first?.site ?? preferred ?? "index.html";
}

/** A site id is a cache namespace on somebody else's origin: opaque, per tab, and never a path. */
export function newSiteId(): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return uuid.replace(/-/g, "").slice(0, 24);
}

// ── What a pick is ────────────────────────────────────────────────────────────────────────────────

export interface PickedElement {
  kind: typeof MSG_PICK;
  v: number;
  /** A stable-ish CSS selector for the element, from the algorithm inside the inspector. */
  selector: string;
  /** The tag name, lowercased. */
  tag: string;
  /** ARIA role, explicit or derived from the tag. */
  role: string;
  /** The accessible name — aria-label, a label, alt text, or the visible text. */
  name: string;
  /** Trimmed visible text of the element. */
  text: string;
  /** `outerHTML`, trimmed to 2 KB with a marker when it was cut. */
  html: string;
  box: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  /** The document the element is in. */
  url: string;
  /** The workspace file the served page came from, when the host knew it. */
  source: string | null;
}

/** True for a message shaped like a pick. An iframe can post anything; this is the door. */
export function isPickMessage(data: unknown): data is PickedElement {
  if (!data || typeof data !== "object") return false;
  const m = data as Partial<PickedElement>;
  return (
    m.kind === MSG_PICK &&
    m.v === PREVIEW_PROTOCOL &&
    typeof m.selector === "string" &&
    typeof m.tag === "string" &&
    typeof m.html === "string"
  );
}

export function baseName(path: string): string {
  const clean = path.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  return slash < 0 ? clean : clean.slice(slash + 1);
}

/** The last part of a selector — `main > div.card > button.buy` reads as `button.buy` on a chip. */
export function shortSelector(selector: string): string {
  const parts = selector.split(">").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? selector;
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * The composer's chip: `Selected: <button.buy> 'Add to cart' · index.html`.
 *
 * The file wins over the URL because it is the thing the person can ask the agent to edit; the URL is
 * the fallback for a page served by a script, where there is no file to name.
 */
export function chipTextFor(pick: PickedElement): string {
  const what = shortSelector(pick.selector);
  const name = pick.name ? ` '${clip(pick.name, 40)}'` : "";
  // A file name is a thing the person can ask the agent to open. The URL's last segment is only
  // that when it LOOKS like a file — `…/p/abc/3000/` would otherwise put the bare word "3000" on the
  // chip, which names nothing.
  let where = "";
  if (pick.source) where = ` · ${baseName(pick.source)}`;
  else if (pick.url) {
    const tail = baseName(pick.url);
    where = tail.includes(".") ? ` · ${tail}` : "";
  }
  return `Selected: <${what}>${name}${where}`;
}

// ── The snapshot road's copy of the script ────────────────────────────────────────────────────────

/**
 * Put the inspector into a document the app assembled itself (`power/preview.ts`'s output).
 *
 * The frame it goes into is `srcdoc` with `sandbox="allow-scripts"` — an OPAQUE origin, whose own
 * `location.origin` is the string `"null"` — so it cannot work out where to post. The app announces
 * that: `<meta name="00-target">` carries this app's origin, and the script targets it exactly rather
 * than falling back to `"*"`. `<meta name="00-source">` is the same fact the live road's service
 * worker stamps: which workspace file this document was built from.
 */
export function withInspector(html: string, opts: { target: string; source?: string | null }): string {
  const metas =
    `<meta name="${TARGET_META}" content="${escapeAttr(opts.target)}">` +
    (opts.source ? `<meta name="${SOURCE_META}" content="${escapeAttr(opts.source)}">` : "");
  const script = `<script>\n${INSPECTOR_SOURCE}\n</` + `script>`;
  const withMeta = html.includes("</head>") ? html.replace("</head>", `${metas}</head>`) : `${metas}${html}`;
  if (withMeta.includes("</body>")) return withMeta.replace("</body>", `${script}</body>`);
  if (withMeta.includes("</html>")) return withMeta.replace("</html>", `${script}</html>`);
  return `${withMeta}${script}`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * THE INSPECTOR, in full.
 *
 * ⚠️ `apps/infinite-preview-site/src/inspector.ts` holds a byte-identical copy and serves it at
 * `/__inspector.js`. `test/preview-live.test.ts` compares the two. If you change one, change both.
 *
 * No backtick and no `${` may appear below: this text lives inside `String.raw` in two files.
 */
export const INSPECTOR_SOURCE = String.raw`/* 00 preview inspector — see apps/infinite/src/lib/pick.ts for why this text exists twice. */
(function () {
  "use strict";

  var V = 1;
  var MAX_HTML = 2048;
  var MAX_TEXT = 200;
  var MAX_DEPTH = 5;
  var RING_ID = "__00_inspect_ring";

  // ---------- pure: a chain of element descriptions -> one CSS selector ----------

  // Classes a bundler generated are not classes a person can point at tomorrow. Anything that looks
  // like a hash, a CSS-module suffix or a framework scope is dropped from the selector; the element
  // still gets found by tag and position, which is at least honest about being positional.
  var SCOPED = /^(?:svelte|css|sc|jsx|emotion|tw|module)[-_][A-Za-z0-9]{4,}$/;
  var HASHY = /^[A-Za-z_-]*[0-9a-f]{6,}$/;

  function stableClass(name) {
    if (!name || name.length > 40) return false;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) return false;
    if (SCOPED.test(name)) return false;
    if (HASHY.test(name)) return false;
    return true;
  }

  function signatureOf(classes) {
    var out = [];
    for (var i = 0; i < classes.length; i++) {
      if (stableClass(classes[i]) && out.length < 2) out.push(classes[i]);
    }
    return out;
  }

  // chain[0] is the element, chain[n] its ancestors. Each entry says what makes it findable:
  // a document-unique id, the classes worth keeping, its nth-of-type index, and whether tag +
  // classes already tell it apart from its same-tag siblings.
  function selectorFromChain(chain) {
    var parts = [];
    for (var i = 0; i < chain.length && i < MAX_DEPTH; i++) {
      var node = chain[i];
      if (node.id && node.idUnique) {
        parts.unshift("#" + node.id);
        break;
      }
      var part = node.tag;
      var classes = signatureOf(node.classes || []);
      for (var c = 0; c < classes.length; c++) part += "." + classes[c];
      if (!node.uniqueAmongSiblings) part += ":nth-of-type(" + node.nth + ")";
      parts.unshift(part);
      if (node.tag === "body") break;
    }
    return parts.join(" > ") || "html";
  }

  function trimText(raw) {
    var one = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
    return one.length > MAX_TEXT ? one.slice(0, MAX_TEXT - 1) + "…" : one;
  }

  function trimHtml(raw) {
    var text = String(raw == null ? "" : raw);
    if (text.length <= MAX_HTML) return text;
    return text.slice(0, MAX_HTML) + "\n<!-- trimmed at " + MAX_HTML + " characters -->";
  }

  var ROLES = {
    a: "link", button: "button", h1: "heading", h2: "heading", h3: "heading", h4: "heading",
    h5: "heading", h6: "heading", img: "img", nav: "navigation", main: "main", form: "form",
    ul: "list", ol: "list", li: "listitem", table: "table", select: "combobox", textarea: "textbox",
    header: "banner", footer: "contentinfo", aside: "complementary", section: "region", p: "paragraph"
  };

  function roleFor(tag, type, explicit) {
    if (explicit) return explicit;
    if (tag === "input") {
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return ROLES[tag] || tag;
  }

  var api = {
    selectorFromChain: selectorFromChain,
    stableClass: stableClass,
    trimText: trimText,
    trimHtml: trimHtml,
    roleFor: roleFor
  };
  if (typeof globalThis !== "undefined") globalThis.__00_inspector = api;

  // ---------- everything below needs a document ----------

  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (window.parent === window) return; // opened in a tab: there is nobody to tell

  var inspecting = false;
  var hovered = null;

  function meta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    return el ? el.getAttribute("content") : null;
  }

  // The parent's origin, announced rather than guessed. On the live road this page and the host page
  // share an origin, so location.origin is exactly right; in the snapshot frame the origin is opaque
  // (the literal string "null") and the app stamps the meta instead.
  function target() {
    var announced = meta("00-target");
    if (announced) return announced;
    if (location.origin && location.origin !== "null") return location.origin;
    return "*";
  }

  function post(data) {
    try {
      window.parent.postMessage(data, target());
    } catch (err) {
      /* a parent that went away is not something a preview can fix */
    }
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^A-Za-z0-9_-]/g, "\\$&");
  }

  function classesOf(el) {
    var raw = (el.getAttribute("class") || "").split(/\s+/);
    var out = [];
    for (var i = 0; i < raw.length; i++) if (raw[i]) out.push(raw[i]);
    return out;
  }

  function chainFor(el) {
    var chain = [];
    var node = el;
    while (node && node.nodeType === 1 && chain.length < 12) {
      var tag = node.tagName.toLowerCase();
      if (tag === "html") break;
      var parent = node.parentElement;
      var sameTag = [];
      if (parent) {
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) sameTag.push(parent.children[i]);
        }
      }
      var classes = classesOf(node);
      var mine = signatureOf(classes).join(".");
      var twins = 0;
      for (var s = 0; s < sameTag.length; s++) {
        if (signatureOf(classesOf(sameTag[s])).join(".") === mine) twins++;
      }
      var id = node.getAttribute("id");
      var idUsable = !!id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);
      chain.push({
        tag: tag,
        id: idUsable ? id : null,
        idUnique: idUsable && document.querySelectorAll("#" + cssEscape(id)).length === 1,
        classes: classes,
        nth: sameTag.indexOf(node) + 1,
        uniqueAmongSiblings: sameTag.length === 1 || (mine !== "" && twins === 1)
      });
      node = parent;
    }
    return chain;
  }

  function nameFor(el) {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return trimText(aria);
    var by = el.getAttribute("aria-labelledby");
    if (by) {
      var labelled = document.getElementById(by.split(/\s+/)[0]);
      if (labelled) return trimText(labelled.textContent);
    }
    var tag = el.tagName.toLowerCase();
    if (tag === "img") return trimText(el.getAttribute("alt") || "");
    if (tag === "input" || tag === "select" || tag === "textarea") {
      var id = el.getAttribute("id");
      if (id) {
        var label = document.querySelector('label[for="' + cssEscape(id) + '"]');
        if (label) return trimText(label.textContent);
      }
      return trimText(el.getAttribute("placeholder") || el.getAttribute("value") || "");
    }
    var text = trimText(el.textContent);
    if (text) return text;
    return trimText(el.getAttribute("title") || el.getAttribute("placeholder") || "");
  }

  var STYLE_KEYS = ["color", "backgroundColor", "font", "fontSize", "margin", "padding", "display"];

  function describe(el) {
    var box = el.getBoundingClientRect();
    var computed = window.getComputedStyle(el);
    var styles = {};
    for (var i = 0; i < STYLE_KEYS.length; i++) {
      var key = STYLE_KEYS[i];
      var value = computed[key];
      if (value) styles[key] = String(value);
    }
    var tag = el.tagName.toLowerCase();
    return {
      kind: "00-pick",
      v: V,
      selector: selectorFromChain(chainFor(el)),
      tag: tag,
      role: roleFor(tag, el.getAttribute("type"), el.getAttribute("role")),
      name: nameFor(el),
      text: trimText(el.textContent),
      html: trimHtml(el.outerHTML),
      box: {
        x: Math.round(box.left + window.scrollX),
        y: Math.round(box.top + window.scrollY),
        width: Math.round(box.width),
        height: Math.round(box.height)
      },
      styles: styles,
      url: location.href,
      source: meta("00-source")
    };
  }

  // The ring is the inspector's OWN element, positioned over the page — the host page's styles are
  // never touched, the same rule the embed's dom-bridge follows. It is skipped by every hit test.
  function ring() {
    var el = document.getElementById(RING_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = RING_ID;
    el.setAttribute("data-00-inspector", "");
    el.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #22d3ee;" +
      "border-radius:4px;background:rgba(34,211,238,.10);transition:all .06s linear;display:none";
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function outline(el) {
    var host = ring();
    if (!el) {
      host.style.display = "none";
      return;
    }
    var box = el.getBoundingClientRect();
    host.style.display = "block";
    host.style.left = box.left - 2 + "px";
    host.style.top = box.top - 2 + "px";
    host.style.width = box.width + "px";
    host.style.height = box.height + "px";
  }

  function candidate(event) {
    var el = event.target;
    if (!el || el.nodeType !== 1) return null;
    if (el.id === RING_ID || el.hasAttribute("data-00-inspector")) return null;
    return el;
  }

  function armed(event) {
    return inspecting || event.altKey;
  }

  document.addEventListener(
    "mousemove",
    function (event) {
      if (!armed(event)) {
        if (hovered) {
          hovered = null;
          outline(null);
        }
        return;
      }
      var el = candidate(event);
      if (el === hovered) return;
      hovered = el;
      outline(el);
    },
    true
  );

  document.addEventListener(
    "click",
    function (event) {
      if (!armed(event)) return;
      var el = candidate(event);
      if (!el) return;
      // A picked link must not also navigate, and a picked submit must not also submit: pointing at
      // a thing is not operating it.
      event.preventDefault();
      event.stopPropagation();
      outline(el);
      post(describe(el));
    },
    true
  );

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    hovered = null;
    outline(null);
    post({ kind: "00-pick-clear", v: V });
  });

  window.addEventListener("scroll", function () {
    if (hovered) outline(hovered);
  }, true);

  // The parent turns inspect mode on and off; every other message is somebody else's.
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.kind !== "00-inspect") return;
    inspecting = !!data.on;
    if (!inspecting) {
      hovered = null;
      outline(null);
    }
  });

  post({ kind: "00-nav", v: V, url: location.href, title: document.title, source: meta("00-source") });
})();
`;
