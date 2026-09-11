/**
 * IS THERE A 00 ENGINE ON THIS COMPUTER? — §14's first question, asked in 1.5 seconds or not at all.
 *
 * The companion is the person's own `00d`, running on this machine, offering the browser the three
 * things a tab cannot have (git over smart-HTTP, a fetch from this network, later a folder and a
 * command). Finding it is a GET to `127.0.0.1:4600`, and everything interesting about that call is a
 * failure mode:
 *
 * · **It must not hold the UI.** A closed port answers instantly, but a filtered one hangs for the
 *   OS's connect timeout — tens of seconds — so the probe carries its own 1.5 s `AbortController`
 *   and a card that says "not running" after a second and a half is the honest answer.
 * · **It must not be asked on a phone at all.** There is no `00d` on an iPhone, and a probe to
 *   localhost on a phone is a wasted second and a scary-looking console error. `not-a-desktop` is a
 *   STATE, not an error: the card is hidden entirely.
 * · **Safari refuses localhost from an https page** (mixed content, with no prompt and no way to
 *   allow it), and the refusal arrives as the same bare `TypeError` a missing engine gives. The two
 *   are told apart by the page's own scheme, because that is the only evidence there is — and the
 *   sentence has to name the road that still works instead of telling the person to run a command
 *   that would not help.
 * · **An engine that IS there but too old** answers 404 — the route family is new. That is not
 *   "unreachable" in the network sense, but it is unreachable in the only sense the person cares
 *   about, so it is that state with its own sentence: update.
 *
 * Pure but for the `fetch` it is handed, so the whole table above is a test.
 */

/** Where `00d` listens. The same constant the Mac app, the CLI and web-vue use. */
export const DEFAULT_COMPANION_BASE = "http://127.0.0.1:4600";

/** How long a probe may take. A card is worth 1.5 s of someone's attention, and no more. */
export const COMPANION_PROBE_TIMEOUT_MS = 1500;

/** Under this width, with a coarse pointer, there is no `00d` to find (§14.1: desktop widths only). */
export const DESKTOP_MIN_WIDTH = 900;

export const SAFARI_LOCALHOST_REASON =
  "Safari does not let a page reach localhost; use the relay road or open the app from the companion";

export const NO_COMPANION_ROUTES_REASON = "the engine here has no companion yet — update 00d";

export type CompanionProbe =
  | { state: "found"; name: string; engineFp: string; version?: string; scopes?: string[] }
  | { state: "unreachable"; reason: string }
  | { state: "not-a-desktop" };

export interface ProbeEnv {
  fetch?: typeof globalThis.fetch;
  /** The page's own scheme, which is the only evidence for Safari's refusal. */
  protocol?: string;
  matchMedia?: (query: string) => { matches: boolean };
  innerWidth?: number;
  timeoutMs?: number;
}

/**
 * Is this a surface that could have a `00d` on it?
 *
 * The test is the pair §14.1 names — a coarse pointer AND a narrow window — rather than a user-agent
 * string: a touchscreen laptop has a coarse pointer and a wide window and absolutely does have an
 * engine, and a phone in landscape is still a phone. Where `matchMedia` does not exist (node, a
 * worker) the answer is yes, because there is nothing that says otherwise.
 */
export function isDesktopSurface(env: ProbeEnv = {}): boolean {
  const mm = env.matchMedia ?? (typeof matchMedia === "function" ? matchMedia : undefined);
  const width = env.innerWidth ?? (typeof innerWidth === "number" ? innerWidth : DESKTOP_MIN_WIDTH);
  if (!mm) return true;
  let coarse = false;
  try {
    coarse = mm("(pointer: coarse)").matches;
  } catch {
    coarse = false;
  }
  return !(coarse && width < DESKTOP_MIN_WIDTH);
}

/** The health route. Named once: the client signs paths and a typo here is an unsigned 404. */
export const COMPANION_HEALTH_PATH = "/api/companion/health";

function readHealth(body: unknown): CompanionProbe {
  const row = (body ?? {}) as Record<string, unknown>;
  // The engine's own spelling is `engineName`/`fingerprint` on the pair reply (§14.1); health is
  // read loosely on purpose, because this browser and that engine ship separately and a field that
  // moved must not turn a working companion into "unreachable".
  const engineFp = String(row.engineFp ?? row.fingerprint ?? "");
  const name = String(row.name ?? row.engineName ?? "This computer");
  if (!engineFp) return { state: "unreachable", reason: NO_COMPANION_ROUTES_REASON };
  return {
    state: "found",
    name,
    engineFp,
    ...(row.version ? { version: String(row.version) } : {}),
    ...(Array.isArray(row.scopes) ? { scopes: row.scopes.map(String) } : {}),
  };
}

export async function probeCompanion(base = DEFAULT_COMPANION_BASE, env: ProbeEnv = {}): Promise<CompanionProbe> {
  if (!isDesktopSurface(env)) return { state: "not-a-desktop" };
  const doFetch = env.fetch ?? globalThis.fetch;
  if (!doFetch) return { state: "unreachable", reason: "this browser cannot make requests" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.timeoutMs ?? COMPANION_PROBE_TIMEOUT_MS);
  try {
    const response = await doFetch(`${base}${COMPANION_HEALTH_PATH}`, {
      method: "GET",
      credentials: "omit",
      signal: controller.signal,
    });
    // A 404 is an engine that is RUNNING and does not know this route family yet — the one case
    // where "install it" would be the wrong advice.
    if (response.status === 404) return { state: "unreachable", reason: NO_COMPANION_ROUTES_REASON };
    if (!response.ok) {
      return { state: "unreachable", reason: `the companion answered HTTP ${response.status}` };
    }
    return readHealth(await response.json().catch(() => null));
  } catch (err) {
    return { state: "unreachable", reason: probeFailureReason(err, env) };
  } finally {
    clearTimeout(timer);
  }
}

/** The sentence for a probe that threw. Exported because the wording is the whole of the card. */
export function probeFailureReason(err: unknown, env: ProbeEnv = {}): string {
  const name = (err as { name?: string })?.name;
  if (name === "AbortError" || name === "TimeoutError") {
    return "nothing answered on this computer — run `00d companion` in a terminal";
  }
  const protocol = env.protocol ?? (typeof location === "undefined" ? "" : location.protocol);
  // A TypeError is a browser's one word for "blocked or unreachable". On an https page it is very
  // probably the mixed-content rule, which Safari enforces for localhost where Chrome and Firefox
  // carve it out — and the person cannot fix that by installing anything.
  if (err instanceof TypeError && protocol === "https:") return SAFARI_LOCALHOST_REASON;
  return "nothing answered on this computer — run `00d companion` in a terminal";
}
