/**
 * The owner's first setup flow, as data (§5.2.4). The DOM that renders it is setup.ts.
 *
 * WHY the model is separate from the view: what this flow PRODUCES is a document that will be
 * pasted into a website — a `site.json` or a script tag — and that document has to be right the
 * first time, because the owner may only get one paste. So the production of it is pure, and
 * tested, and the view is just inputs bound to these fields.
 *
 * Every answer §5.2.4 asks for lives in `SetupAnswers` below, and every field of the document it
 * produces is built in `buildSiteConfig`. WHICH SCREEN ASKS FOR WHAT is not here: that is the walk,
 * and the walk is `wizard-model.ts` (which is also where the step list went when the flow became a
 * modal wizard). Nothing about the document moved when it did.
 */

import type { ClaimNonceResult, RegisterResult } from "../registry/client.js";
import { DEFAULT_SITE_CONFIG, LINK_PUB_RE, encodeDataSite, normalisePath, type SessionKind, type SiteConfig } from "../site-config.js";

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
  /**
   * The owner's agent key (ed25519 public half, base64url), copied out of the Infinite Agent app.
   *
   * It rides in BOTH carriers, unlike `ref`: registration happens in a visitor's browser (§5.3) and
   * the key it registers is the one the claim of §5.4 is verified against, so a snippet-only owner
   * needs it as much as a file one does. It is public by design — see `SiteConfig.linkPub`.
   */
  linkPub: string;
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
    linkPub: "",
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
    ...(LINK_PUB_RE.test(answers.linkPub.trim()) ? { linkPub: answers.linkPub.trim() } : {}),
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

// ── Step 5: register and claim (§5.3, §5.4) ─────────────────────────────────────────────────────

/** What the Register card shows after one attempt. Pure data, so every branch is a test. */
export interface RegistrationView {
  /** `dev` | `unclaimed` | `claimed` | `requested` | `refused` — what the card is now showing. */
  state: "dev" | "unclaimed" | "claimed" | "requested" | "refused";
  headline: string;
  detail: string;
  /** The ONE button, when there is one: opening the owned agent to sign the claim. */
  action: { label: string; url: string } | null;
  /**
   * True when the card should also offer "Get a new claim link" — an app that is not claimed and a
   * browser holding no code for it. The call behind it is the site's own door, not a signature; see
   * `requestClaimNonce` in `registry/client.ts`.
   */
  reissue: boolean;
}

/**
 * The four answers §5.3 and §5.4 allow, and the refusals, turned into a card.
 *
 * THE ONE BUTTON is deliberate. A claim is an ed25519 signature under the link key, which lives in
 * the owner's OTHER browser — the owned agent's. So the admin flow cannot claim anything itself; all
 * it can do is send the person to `<product origin>/?claim=<appId>&nonce=…&origin=…` and let the
 * agent that holds the key sign. Anything else on this card would be a promise this page cannot keep.
 */
export function describeRegistration(result: RegisterResult, claimUrl: string | null): RegistrationView {
  if (result.ok) {
    if (result.status === "dev") {
      return {
        state: "dev",
        headline: "Dev mode",
        detail:
          "This is a local origin, so the agent is registered as a development app: level 0 plus a dev-sized allowance. Paste the snippet on the real domain to register it there.",
        // A dev app has not been claimed either, and the worker answers it a claim code like any
        // other — so the two claim controls are the same ones, offered on the same rule.
        action: claimUrl ? { label: "Claim it in your agent", url: claimUrl } : null,
        reissue: !claimUrl,
      };
    }
    if (result.status === "claimed") {
      return {
        state: "claimed",
        headline: "Claimed",
        detail: "This agent is yours. You can publish its knowledge and read what visitors send you.",
        action: null,
        reissue: false,
      };
    }
    if (!claimUrl) {
      return {
        state: "unclaimed",
        headline: "Registered, not claimed",
        detail:
          "The claim link was minted in the browser that first registered this site, and it is held there — a reload, a closed tab or a different browser and that copy is gone. This site can ask the registry for a fresh one.",
        action: null,
        reissue: true,
      };
    }
    return {
      state: "unclaimed",
      headline: "Registered — now prove it is yours",
      detail:
        "Claiming is a signature under your agent's own key, so it is done in the Infinite Agent app. This opens it in a new tab; nothing here holds that key.",
      action: { label: "Claim it in your agent", url: claimUrl },
      reissue: false,
    };
  }

  if (result.code === "ref_registered") {
    return {
      state: "requested",
      headline: "Another site holds this snippet",
      detail:
        "This agent ref is already registered to a different origin, so this one has been queued as requested. Its owner allows it from their own panel — nobody else can.",
      action: null,
      reissue: false,
    };
  }
  if (result.code === "not_connected") {
    return {
      state: "refused",
      headline: "Not connected yet",
      detail: "This build points at no registry, so there is nothing to register with. Level 0 works exactly as it does now.",
      action: null,
      reissue: false,
    };
  }
  if (result.code === "no_link_pub") {
    return {
      state: "refused",
      headline: "Your agent key is missing",
      detail:
        "Paste your agent's public key above and save the settings again. Registration stores that key, and it is what proves the claim later is yours.",
      action: null,
      reissue: false,
    };
  }
  if (result.code === "ip_limited") {
    const hours = result.retryAfter ? Math.ceil(result.retryAfter / 3600) : 24;
    return {
      state: "refused",
      headline: "One registration a day from this address",
      detail: `${result.message} Try again in about ${hours} hour(s).`,
      action: null,
      reissue: false,
    };
  }
  return { state: "refused", headline: "Not registered", detail: result.message, action: null, reissue: false };
}

/**
 * The same card, after "Get a new claim link" (§5.4's re-issue).
 *
 * FOUR ANSWERS, FOUR DIFFERENT NEXT MOVES, which is why this is its own function rather than a
 * boolean on the one above: a fresh code opens the agent; `already_claimed` means the job is done and
 * the card should stop asking; `origin_not_allowed` is the site's own standing and is fixed in the
 * OWNER'S panel, not here; `rate_limited` is a wait, and a wait a person can act on is a number of
 * minutes rather than a shrug.
 */
export function describeClaimNonce(result: ClaimNonceResult, claimUrl: string | null): RegistrationView {
  if (result.ok) {
    if (!claimUrl) {
      // The code arrived and this browser still cannot build the link — a state only a bug reaches,
      // and one that must not show a button that goes nowhere.
      return {
        state: "unclaimed",
        headline: "A new claim link was issued",
        detail: "The registry issued a fresh claim code, but this browser could not build the link. Try registering again.",
        action: null,
        reissue: false,
      };
    }
    return {
      state: "unclaimed",
      headline: "A new claim link is ready",
      detail:
        "This replaces any earlier claim link — the registry keeps one at a time, so a link you opened before this will no longer work. Claiming itself still happens in the Infinite Agent app, under your agent's own key.",
      action: { label: "Claim it in your agent", url: claimUrl },
      reissue: false,
    };
  }

  if (result.code === "already_claimed") {
    return {
      state: "claimed",
      headline: "Claimed",
      detail:
        "This agent has already been claimed, so there is no claim left to make. If that was not you, block this site's address from the owner's panel.",
      action: null,
      reissue: false,
    };
  }
  if (result.code === "origin_not_allowed") {
    return {
      state: "refused",
      headline: "This address is not on the agent's list",
      detail:
        "The registry only issues a claim code to a browser standing on an address the agent already answers. Allow this one from the owner's panel first — that is the only door.",
      action: null,
      reissue: false,
    };
  }
  if (result.code === "rate_limited") {
    const minutes = result.retryAfter ? Math.ceil(result.retryAfter / 60) : 60;
    return {
      state: "refused",
      headline: "Too many claim links from this address",
      detail: `${result.message} Try again in about ${minutes} minute(s).`,
      action: null,
      // Still offered: the button is what the person presses when the wait is over.
      reissue: true,
    };
  }
  return { state: "refused", headline: "No new claim link", detail: result.message, action: null, reissue: true };
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
