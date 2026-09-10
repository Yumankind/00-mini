/**
 * The owner's first setup flow, as data (§5.2.4). The DOM that renders it is setup.ts.
 *
 * WHY the model is separate from the view: what this flow PRODUCES is a document that will be
 * pasted into a website — a `site.json` or a script tag — and that document has to be right the
 * first time, because the owner may only get one paste. So the production of it is pure, and
 * tested, and the view is just inputs bound to these fields.
 *
 * The five steps are §5.2.4's, in its order and in its words:
 *   1. This site — the origin, shown as a rule, not a choice. On localhost the flow says dev mode.
 *   2. What the agent may read — depth, includes/excludes, TTL, do-not-touch, and the auto knowledge
 *      base toggle, which asks how a visitor's session is kept BECAUSE that is how the agent knows
 *      to forget (index/session.ts holds the purge those answers drive).
 *   3. How it introduces itself — name, one line, and same-origin knowledge files.
 *   4. Where to keep these settings — a file on the site, or the snippet attribute.
 *   5. Optional, later — register, claim, publish, messages, a stronger brain. None required.
 */

import { DEFAULT_SITE_CONFIG, encodeDataSite, normalisePath, type SessionKind, type SiteConfig } from "../site-config.js";

export interface SetupStep {
  id: "site" | "read" | "intro" | "keep" | "later";
  title: string;
  blurb: string;
}

export const SETUP_STEPS: SetupStep[] = [
  { id: "site", title: "This site", blurb: "The agent only ever reads this one domain. That is a rule, not a setting." },
  { id: "read", title: "What it may read", blurb: "How deep to look on load, what to leave alone, and how long a page stays fresh." },
  { id: "intro", title: "How it introduces itself", blurb: "A name, one line, and any text files on your site it may quote." },
  { id: "keep", title: "Where to keep these settings", blurb: "A file on your site, or inside the snippet itself." },
  { id: "later", title: "Optional, later", blurb: "Register for a stronger brain and for messages. Nothing here is required." },
];

export interface SetupAnswers {
  origin: string;
  /** Asked on localhost: the domain the snippet will finally live on. */
  finalDomain: string;
  depth: number;
  includes: string[];
  excludes: string[];
  ttlDays: number;
  doNotTouch: string[];
  /** "Auto knowledge base": index this visitor's signed-in pages, on this visitor's device. */
  crawlAuthed: boolean;
  sessionKind: SessionKind;
  cookies: string[];
  storageKeys: string[];
  logoutPaths: string[];
  introName: string;
  introLine: string;
  knowledge: string[];
  carrier: "site-file" | "snippet";
}

export function defaultAnswers(origin: string): SetupAnswers {
  return {
    origin,
    finalDomain: "",
    depth: DEFAULT_SITE_CONFIG.depth,
    includes: [],
    excludes: [],
    ttlDays: DEFAULT_SITE_CONFIG.ttlDays,
    doNotTouch: [],
    crawlAuthed: true,
    sessionKind: "none",
    cookies: [],
    storageKeys: [],
    logoutPaths: [],
    introName: "",
    introLine: "",
    knowledge: [],
    carrier: "site-file",
  };
}

/** localhost, 127.0.0.1, *.local and the file: origin are all dev; the flow says so and asks for the real domain. */
export function isDevOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "" ||
      host.endsWith(".local") ||
      host.endsWith(".localhost")
    );
  } catch {
    return true;
  }
}

/** The one line the flow shows under step 2's toggle, per the session kind the owner picked. */
export function sessionKindHelp(kind: SessionKind): string {
  switch (kind) {
    case "cookie":
      return "Name the cookie. HttpOnly cookies are invisible to any script, including this one — if yours is HttpOnly, pick another kind.";
    case "localStorage":
      return "Name the keys. Only their presence is read, never their value.";
    case "temporary":
      return "Signed-in pages are never written to disk. They live in the tab and die with it.";
    case "none":
      return "The agent guesses from the page (a sign-in control means signed out, an account control means signed in) and forgets more aggressively.";
  }
}

/** Build the document. Field for field §5.2.4's schema, and nothing else in it. */
export function buildSiteConfig(answers: SetupAnswers, ref?: string): SiteConfig {
  const paths = (list: string[]): string[] =>
    list.map((p) => normalisePath(p)).filter((p): p is string => !!p).slice(0, 16);
  const names = (list: string[]): string[] =>
    list.map((n) => n.trim()).filter((n) => n && n.length <= 64).slice(0, 16);

  return {
    version: 1,
    // The ref binds the file to this snippet, which is what makes the file an ownership proof —
    // and only the site-file carrier carries it (§5.2.4).
    ...(ref && answers.carrier === "site-file" ? { ref } : {}),
    depth: answers.depth >= 2 ? 2 : 1,
    includes: paths(answers.includes),
    excludes: paths(answers.excludes),
    ttlDays: Math.max(1, Math.min(365, Math.trunc(answers.ttlDays) || 7)),
    doNotTouch: paths(answers.doNotTouch),
    crawlAuthed: answers.crawlAuthed,
    session: {
      kind: answers.crawlAuthed ? answers.sessionKind : "none",
      cookies: answers.sessionKind === "cookie" ? names(answers.cookies) : [],
      storageKeys: answers.sessionKind === "localStorage" ? names(answers.storageKeys) : [],
      logoutPaths: paths(answers.logoutPaths),
    },
    intro: { name: answers.introName.slice(0, 64).trim(), line: answers.introLine.slice(0, 200).trim() },
    knowledge: paths(answers.knowledge),
  };
}

/** What the owner saves at /.well-known/infinite-agent.json — pretty-printed, so it reads as a file. */
export function siteFileText(config: SiteConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export const WELL_KNOWN_PATH = "/.well-known/infinite-agent.json";

/**
 * The snippet. With a site file it stays bare, for ever: settings are edited in the file and the
 * tag never changes again. With the attribute carrier the settings ride in the tag, and the flow
 * says out loud that changing one means pasting again.
 */
export function snippetFor(host: string, ref: string, config: SiteConfig, carrier: SetupAnswers["carrier"]): string {
  const src = `${host.replace(/\/+$/, "")}/e/${ref}.js`;
  if (carrier === "site-file") return `<script async src="${src}"></script>`;
  const { ref: _dropped, ...withoutRef } = config;
  return `<script async src="${src}" data-site='${encodeDataSite(withoutRef)}'></script>`;
}

/** The "did it land?" check the flow re-runs until the file answers (§5.2.4, step 4). */
export async function checkSiteFile(
  origin: string,
  ref: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetchImpl(new URL(WELL_KNOWN_PATH, origin).toString(), { method: "GET", credentials: "same-origin" });
    if (!res.ok) return { ok: false, message: `${WELL_KNOWN_PATH} answered ${res.status}. Save the file and check again.` };
    const body = (await res.json()) as { ref?: unknown };
    if (typeof body.ref === "string" && body.ref !== ref) {
      return { ok: false, message: `That file names another agent (${body.ref}). Replace it with the one above.` };
    }
    return { ok: true, message: "Found it. The settings are live for every visitor." };
  } catch (err) {
    return { ok: false, message: `Could not read ${WELL_KNOWN_PATH} (${String(err)}).` };
  }
}
