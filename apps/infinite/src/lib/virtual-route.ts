/**
 * `/~/…` — the two virtual routes, decided as a pure function.
 *
 * WHY THIS FILE EXISTS AT ALL. A browser tab cannot bind a TCP port, so a script's
 * `server.listen(3000)` registers a handler in a runner Worker and the SERVICE WORKER turns
 * `GET /~/3000/index.html` on this origin into a call into that handler (`src/power/virtual-ports.ts`
 * holds the registry, `public/sw.js` does the intercepting). A static folder is the same road with a
 * different destination: `/~/files/projects/site/…` reads out of `AgentFs`. Both live under one
 * reserved prefix so that everything else on the origin — the shell, the hashed assets, the
 * MediaPipe wasm — is untouched by any of this.
 *
 * WHY IT IS SEPARATE AND IMPORT-FREE. A service worker has no module graph a node test can reach, so
 * the decision is made here and the build INLINES this file into `public/sw.js` at the
 * `//__VIRTUAL_ROUTE_LIB__` marker (the same substitution `push-notification.ts` gets; see the plugin
 * in vite.config.ts). Inlined source cannot resolve an `import`, so this module imports nothing —
 * which is also why the MIME table below is its own and not `preview-resolve.ts`'s: that one answers
 * "how do I inline this asset into a document", this one answers "what content-type do I put on the
 * wire", with the charset a served file needs and the extensions a project folder actually contains.
 *
 * WHY A PREFIX AND NOT A SUBDOMAIN. A second origin would be the better answer (see the sandbox note
 * in `src/power/virtual-ports.ts`), and a service worker cannot change origin: its scope is a path on
 * the origin that registered it. `/~/` is the path we take, chosen because no build tool emits it and
 * a person reading `/~/3000/` can guess what it is.
 */

/** Everything virtual hangs off this one path. Nothing else on the origin is touched. */
export const VIRTUAL_PREFIX = "/~/";
/** The second segment that means "a workspace folder", not a port. */
export const FILES_SEGMENT = "files";
/** A directory, or a path that ends in `/`, is served as this — the rule every static server has. */
export const INDEX_FILE = "index.html";

export type VirtualRoute =
  /** `/~/3000/a/b` → a request for handler 3000, whose `req.url` is `subpath` (always leading `/`). */
  | { kind: "port"; port: number; subpath: string }
  /** `/~/files/projects/site/a.css` → that file under the workspace; `subpath` is `/` + `path`. */
  | { kind: "files"; path: string; subpath: string };

/** A cheap first question for the fetch handler, before any URL parsing. */
export function isVirtualPath(pathname: string): boolean {
  return typeof pathname === "string" && pathname.startsWith(VIRTUAL_PREFIX);
}

/**
 * One decoded path segment, or `null` when it is one we refuse to carry.
 *
 * `..` is refused rather than resolved: these paths reach a real filesystem at the far end, and the
 * shell's own guard (`resolveInSandbox`) would throw there anyway. Refusing here means the SW answers
 * 404 instead of waking the page to be told no.
 */
function segment(raw: string): string | null {
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return null; // a broken `%` escape
  }
  // A DECODED `/` is the one that gets past a naive guard: `..%2Fvault.json` is one segment on the
  // wire and two after decoding, and a server that joins it has just been walked out of.
  if (text.includes("\0") || text.includes("\\") || text.includes("/") || text === "..") return null;
  return text;
}

/** `"3000"` → 3000; anything else — `"0"`, `"03000"`, `"70000"`, `"3000x"` — is not a port. */
export function parsePort(raw: string): number | null {
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) return null;
  const port = Number(raw);
  return port <= 65535 ? port : null;
}

/**
 * `pathname` → what to do about it, or `null` for "not ours, let the network have it".
 *
 * The query string is NOT part of this: the caller keeps it and appends it to `subpath` when it
 * builds the `req.url` the script sees, because a handler that reads `?page=2` must still get it.
 */
export function routeFor(pathname: string): VirtualRoute | null {
  if (!isVirtualPath(pathname)) return null;
  const rest = pathname.slice(VIRTUAL_PREFIX.length);
  if (!rest) return null;
  const raw = rest.split("/");
  const head = raw[0] ?? "";
  const tail: string[] = [];
  for (const part of raw.slice(1)) {
    if (part === "") {
      tail.push(""); // a trailing slash is meaningful — it is what makes a directory a directory
      continue;
    }
    const decoded = segment(part);
    if (decoded === null) return null;
    tail.push(decoded);
  }

  if (head === FILES_SEGMENT) {
    const path = tail.join("/");
    return { kind: "files", path, subpath: `/${path}` };
  }
  const port = parsePort(head);
  if (port === null) return null;
  return { kind: "port", port, subpath: `/${tail.join("/")}` };
}

/**
 * `/~/3000/a` + `?x=1` → the `url` a Node handler expects on `req`.
 * Node's `req.url` is the path with its query and nothing else, which is exactly this.
 */
export function requestUrlFor(route: VirtualRoute, search: string): string {
  const query = search && search !== "?" ? (search.startsWith("?") ? search : `?${search}`) : "";
  return `${route.subpath}${query}`;
}

/**
 * The content-type a served file gets, charset included for the text ones.
 *
 * An unknown extension is `application/octet-stream` on purpose: a browser shown
 * `text/plain` for a file it cannot name will render bytes, and a browser shown nothing will sniff —
 * and sniffing is how a `.png` full of markup becomes script on your origin.
 */
export function serveMimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const ext = dot > slash ? path.slice(dot + 1).toLowerCase() : "";
  const text: Record<string, string> = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "text/javascript",
    mjs: "text/javascript",
    cjs: "text/javascript",
    json: "application/json",
    map: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    xml: "application/xml",
    svg: "image/svg+xml",
  };
  if (text[ext]) return `${text[ext]}; charset=utf-8`;
  const binary: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    wasm: "application/wasm",
    pdf: "application/pdf",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    webm: "video/webm",
    zip: "application/zip",
  };
  return binary[ext] ?? "application/octet-stream";
}

/**
 * What a static request actually asks the filesystem for, given the folder it is rooted at.
 *
 * `""` and any path ending in `/` mean the directory, and a directory means its `index.html` — the
 * caller stats the result first and asks again with `directory: true` when it turns out to be one,
 * which is one round trip more than a real server and one less filesystem convention to invent.
 */
export function staticTarget(root: string, subpath: string, directory = false): string {
  const parts = [...root.split("/"), ...subpath.split("/")].filter((s) => s.length > 0 && s !== ".");
  const wantsIndex = directory || subpath === "" || subpath === "/" || subpath.endsWith("/");
  if (wantsIndex) parts.push(INDEX_FILE);
  return parts.join("/");
}
