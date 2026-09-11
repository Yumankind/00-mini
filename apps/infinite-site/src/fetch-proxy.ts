/**
 * `/~fetch` — the read-only door that lets the agent READ the web.
 *
 * WHY IT EXISTS AT ALL. `http_get` (packages/agent-runtime/src/tools-net.ts) is a browser `fetch`,
 * and a browser refuses to hand a page cross-origin bytes unless the far side sent
 * `Access-Control-Allow-Origin`. Almost no website does. So an agent living in a tab could dial its
 * own origin and a handful of APIs, and every ordinary link — a doc page, a README, a news article —
 * came back as a `TypeError` the model could only report as "could not reach". The Worker that
 * already serves this origin has no such rule: server-to-server there is no CORS. One route, GET
 * only, text only, same-origin callers only, and the tool falls back to it when the direct fetch is
 * blocked.
 *
 * WHY THE DECISION IS A PURE FUNCTION IN ITS OWN FILE, exactly like `headers.ts`: this folder has no
 * `package.json` and no `node_modules`, so the only way its logic is tested without a deploy is for
 * `apps/infinite` to import it across the boundary (apps/infinite/test/fetch-proxy.test.ts). Nothing
 * here imports anything; everything here is data in, verdict out.
 *
 * WHAT THIS IS NOT. It is not an open proxy, and the rules below are what keeps it from becoming
 * one — each of them is an abuse road that was closed on purpose:
 *
 * 1. **GET and HEAD only.** No body ever reaches the far side, so nothing can be changed through it.
 * 2. **`https:` only.** Plain `http:` would make this a way to reach cleartext hosts from a
 *    Cloudflare IP, and everything worth reading is on TLS.
 * 3. **Public hosts only.** No IP literal (v4 or v6, in any of the spellings the URL parser folds
 *    into one), no `localhost`, no `*.local`, `*.internal` or `*.arpa`, and no single-label name —
 *    those are the addresses that mean "something on the network I am standing in", which for a
 *    Worker is Cloudflare's network and never the person's.
 * 4. **Same-origin callers only.** A browser stamps `sec-fetch-site` on every request it makes, and
 *    a cross-site page cannot forge it, cannot set `origin`, and cannot set `referer`. Without this
 *    the route would be a free anonymising proxy for anybody who found the URL.
 * 5. **No credentials, ever.** The Worker builds a fresh header set for the upstream call: no
 *    cookie, no authorization, no incoming header of any kind is forwarded. Server-side that is what
 *    "no credentials" means — there is no cookie jar to omit.
 *
 * The caps that bound the cost — 1 MiB, 10 seconds, 3 redirects, 5 minutes of cache on a success and
 * at most 60 seconds on anything else — are named here and enforced in `index.ts`.
 */

/** The path, spelled once. `/~fetch` and not `/~/fetch`: `/~/…` belongs to the service worker. */
export const PROXY_PATH = "/~fetch";

/** The body cap, matching `HTTP_GET_MAX_BYTES` in packages/agent-runtime/src/tools-net.ts. */
export const PROXY_MAX_BYTES = 1024 * 1024;

/** How many hops a redirect chain may take before it is called a loop. */
export const PROXY_MAX_REDIRECTS = 3;

/** The whole upstream call, from connect to last byte. */
export const PROXY_TIMEOUT_MS = 10_000;

/** What the far side is told is asking. Honest, and pointing at a page that explains itself. */
export const PROXY_USER_AGENT = "00-Mini/1.0 (+https://0-0.chat)";

/** Text first, and a low-weight wildcard so a server with only one representation still answers. */
export const PROXY_ACCEPT = "text/html,application/json,text/plain,*/*;q=0.5";

/**
 * A content type worth passing through. Deliberately the SAME list as `isTextual` in
 * packages/agent-runtime/src/tools-net.ts: the tool refuses the same types on the direct road, and a
 * proxy that was more permissive than the tool would be a way around the tool's own rule.
 */
export function isTextual(contentType: string): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("text/")) return true;
  return [
    "application/json",
    "application/xml",
    "application/xhtml+xml",
    "application/javascript",
    "application/x-ndjson",
    "application/ld+json",
  ].includes(type);
}

/** Dotted-quad, after the URL parser has already folded `0x7f.1` and `2130706433` into this shape. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Suffixes that mean "the network this machine is standing in", which is never the person's. */
const PRIVATE_SUFFIXES = [".local", ".internal", ".arpa", ".localhost"];

/**
 * Is this a host on the public internet? The URL parser has already normalised the hostname — an
 * IPv6 literal arrives in brackets, and every legal spelling of an IPv4 address arrives as a dotted
 * quad — so the checks here are on the normalised form and cannot be spelled around.
 *
 * A SINGLE-LABEL NAME IS REFUSED (`http://intranet/`). It has no public meaning; it resolves against
 * whatever search domain the resolver carries, which for this code is Cloudflare's. A real website
 * always has a dot in its name.
 */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith("[")) return false; // an IPv6 literal, in the only form a URL can carry one
  if (IPV4.test(host)) return false;
  if (host === "localhost") return false;
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return host.includes(".") && !host.startsWith(".") && !host.endsWith(".");
}

/**
 * The target this request is asking for, or why it is not one. `https:` only — see rule 2. Exported
 * because `index.ts` runs it again for EVERY redirect hop: a chain that starts at a public https
 * host and ends at `http://169.254.169.254/` is the oldest trick there is, and the hop that arrives
 * is checked by exactly the same function as the hop that was asked for.
 */
export function publicHttpsTarget(raw: string, base?: string): URL | null {
  if (!raw.trim()) return null;
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!isPublicHost(url.hostname)) return null;
  // Credentials in the URL itself are credentials, and rule 5 has no exceptions.
  if (url.username || url.password) return null;
  return url;
}

/** The one shape the Worker needs off a `Request`, so a test needs no `Request`. */
export interface ProxyRequestLike {
  method: string;
  url: string;
  headers: { get(name: string): string | null };
}

export type ProxyDecision =
  | { kind: "refuse"; status: number; reason: string }
  | { kind: "fetch"; target: URL };

/**
 * `https://site` vs `https://site.evil.example` — a prefix test alone says yes to both, so the
 * character after the origin has to be the end of the string or a path separator.
 */
function beginsAtOrigin(value: string | null, siteOrigin: string): boolean {
  if (!value) return false;
  return value === siteOrigin || value.startsWith(`${siteOrigin}/`);
}

/**
 * Was this request made by this site's own page? `sec-fetch-site` is set by the browser and cannot
 * be written by script, so it is the strong answer; `origin` and `referer` are the fallback for a
 * browser too old to send it, and both are also browser-set on a cross-origin request.
 *
 * A request with NO such header at all — curl, a bot, a person pasting the URL into an address bar
 * (`sec-fetch-site: none`) — is refused. That is the whole anti-abuse story of this route.
 */
export function calledBySite(request: ProxyRequestLike, siteOrigin: string): boolean {
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  if (beginsAtOrigin(request.headers.get("origin"), siteOrigin)) return true;
  return beginsAtOrigin(request.headers.get("referer"), siteOrigin);
}

/**
 * The whole verdict, in the order a reader would check it: is this even the route, may this method
 * be used, is the caller this site, and only then — what is being asked for. The order matters for
 * the answer a prober gets: somebody who is not this site learns "403" and nothing about whether
 * their target would have been allowed.
 */
export function decideProxy(request: ProxyRequestLike, siteOrigin: string): ProxyDecision {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { kind: "refuse", status: 400, reason: "bad request URL" };
  }
  if (url.pathname !== PROXY_PATH) return { kind: "refuse", status: 404, reason: "not found" };

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return { kind: "refuse", status: 405, reason: "GET and HEAD only — this proxy only reads" };
  }
  if (!calledBySite(request, siteOrigin)) {
    return { kind: "refuse", status: 403, reason: "same-origin callers only" };
  }

  const raw = url.searchParams.get("url");
  if (raw === null || !raw.trim()) return { kind: "refuse", status: 400, reason: "missing ?url=" };

  const target = publicHttpsTarget(raw);
  if (!target) {
    return { kind: "refuse", status: 400, reason: "?url= must be an https:// URL on a public host" };
  }
  return { kind: "fetch", target };
}
