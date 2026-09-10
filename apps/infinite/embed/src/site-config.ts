/**
 * `site.json` — the owner's settings, and the three carriers they can arrive in.
 *
 * WHY a validator this paranoid for a file the owner wrote themselves: the loader runs inside a
 * stranger's page, and the document reaches it from a URL anyone who can write the site root can
 * write. So nothing is trusted by shape: every field is re-typed, every list is clamped, every path
 * is forced same-origin-relative, and **unknown fields are dropped** rather than carried (§5.2.4).
 * The output of `validateSiteConfig` is built fresh, so nothing that was not asked for survives.
 *
 * Precedence, exactly §5.1: the claimed app's signed public bundle, then the site file at
 * /.well-known/infinite-agent.json, then the snippet's `data-site`, then the built-in defaults.
 *
 * See docs/HANDOFF-infinite-agent.md §5.1, §5.2.4.
 */

export type SessionKind = "cookie" | "localStorage" | "temporary" | "none";

export interface SessionConfig {
  kind: SessionKind;
  /** kind: cookie — NAMES only. A value is never read into the index (§5.2.4). */
  cookies: string[];
  /** kind: localStorage — names only. */
  storageKeys: string[];
  /** Paths that mean "this person just signed out", whatever the signal says. */
  logoutPaths: string[];
}

export interface SiteConfig {
  version: number;
  /** Site file only: binds the file to the ref, which is the ownership proof. */
  ref?: string;
  /**
   * The owner's ed25519 LINK public key, base64url of the raw 32 bytes (§5.1).
   *
   * WHY A SETTING AND NOT A SECRET: it is the public half, and §5.1 says the ref and the tag are
   * "public by design". It has to travel with them because REGISTRATION HAPPENS IN A VISITOR'S
   * BROWSER (§5.3, and the worker's `Origin` check makes that mandatory) while the private half
   * never leaves the owner's. The key registered is the key the claim of §5.4 is verified against,
   * so a snippet that carries none can be set up, crawled and asked questions — everything at
   * level 0 — and simply cannot be registered until the owner pastes it in.
   */
  linkPub?: string;
  depth: number;
  includes: string[];
  excludes: string[];
  ttlDays: number;
  /** Paths added to the built-in state-change guard. */
  doNotTouch: string[];
  crawlAuthed: boolean;
  session: SessionConfig;
  intro: { name: string; line: string };
  /** Same-origin paths the agent may read as public knowledge, ≤ 256 KB in total. */
  knowledge: string[];
}

/** Which carrier the settings in force came from — shown in the owner panel. */
export type Carrier = "bundle" | "site-file" | "snippet" | "defaults";

export interface ResolvedSiteConfig {
  config: SiteConfig;
  carrier: Carrier;
  /** Human lines for the owner panel: a rejected site file, a clamped field, a ref mismatch. */
  notes: string[];
}

/** Hard caps. Lists are short on purpose: this is configuration, not a database. */
export const LIMITS = {
  listEntries: 16,
  nameChars: 64,
  pathChars: 256,
  introName: 64,
  introLine: 200,
  /** §5.2.4: knowledge files are text only and ≤ 256 KB in total. */
  knowledgeBytes: 256 * 1024,
} as const;

export const DEFAULT_SITE_CONFIG: SiteConfig = {
  version: 1,
  depth: 2,
  includes: [],
  excludes: [],
  ttlDays: 7,
  doNotTouch: [],
  crawlAuthed: true,
  session: { kind: "none", cookies: [], storageKeys: [], logoutPaths: [] },
  intro: { name: "", line: "" },
  knowledge: [],
};

/** Raw 32 bytes, base64url, unpadded — the worker's `isLinkPub` by shape rather than by decoding. */
export const LINK_PUB_RE = /^[A-Za-z0-9_-]{43}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === "number" ? Math.trunc(v) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
};

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max).trim() : "");

/** A cookie or storage key: a name, not a value, not a path. */
const nameList = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    const s = str(raw, LIMITS.nameChars);
    if (s && !/[\s;=]/.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= LIMITS.listEntries) break;
  }
  return out;
};

/**
 * A path list. Same-origin and relative is the rule, so anything carrying a scheme, an authority or
 * a `..` segment is dropped rather than repaired — a "path" that could point at another host is the
 * one thing this file must never be able to say.
 */
export const pathList = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    const p = normalisePath(raw);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= LIMITS.listEntries) break;
  }
  return out;
};

export function normalisePath(raw: unknown): string | null {
  const s = str(raw, LIMITS.pathChars);
  if (!s) return null;
  if (s.includes("://") || s.startsWith("//") || s.includes("\\")) return null;
  const p = s.startsWith("/") ? s : `/${s}`;
  if (p.split("/").some((seg) => seg === "..")) return null;
  return p;
}

/**
 * Re-type a parsed `site.json` into a `SiteConfig`. Never throws: a malformed document degrades
 * field by field to the defaults and says so in `notes`.
 */
export function validateSiteConfig(input: unknown): { config: SiteConfig; notes: string[] } {
  const notes: string[] = [];
  if (!isRecord(input)) return { config: { ...DEFAULT_SITE_CONFIG }, notes: ["settings were not an object; defaults used"] };

  const known = new Set([
    "version", "ref", "linkPub", "depth", "includes", "excludes", "ttlDays", "doNotTouch",
    "crawlAuthed", "session", "intro", "knowledge",
  ]);
  const dropped = Object.keys(input).filter((k) => !known.has(k));
  if (dropped.length) notes.push(`unknown field(s) dropped: ${dropped.slice(0, 8).join(", ")}`);

  const sessionIn = isRecord(input.session) ? input.session : {};
  const kinds: SessionKind[] = ["cookie", "localStorage", "temporary", "none"];
  const kind = kinds.includes(sessionIn.kind as SessionKind) ? (sessionIn.kind as SessionKind) : "none";
  if (sessionIn.kind !== undefined && kind !== sessionIn.kind) notes.push(`session.kind "${String(sessionIn.kind)}" is not a kind; "none" used`);

  const introIn = isRecord(input.intro) ? input.intro : {};
  const ref = typeof input.ref === "string" && /^ia_[a-z0-9_]{4,64}$/i.test(input.ref) ? input.ref : undefined;
  // 32 bytes of base64url is exactly 43 characters, unpadded. Checked by shape here so a typo is a
  // note in the owner panel rather than a `bad_link_pub` from a worker they cannot see.
  const linkPub = typeof input.linkPub === "string" && LINK_PUB_RE.test(input.linkPub) ? input.linkPub : undefined;
  if (input.linkPub !== undefined && !linkPub) {
    notes.push("linkPub is not an ed25519 public key (43 base64url characters); registration will be refused");
  }

  const depth = clampInt(input.depth, 1, 2, DEFAULT_SITE_CONFIG.depth);
  if (input.depth !== undefined && depth !== input.depth) notes.push(`depth clamped to ${depth} (1–2)`);
  const ttlDays = clampInt(input.ttlDays, 1, 365, DEFAULT_SITE_CONFIG.ttlDays);
  if (input.ttlDays !== undefined && ttlDays !== input.ttlDays) notes.push(`ttlDays clamped to ${ttlDays} (1–365)`);

  const config: SiteConfig = {
    version: clampInt(input.version, 1, 1_000_000, 1),
    ...(ref ? { ref } : {}),
    ...(linkPub ? { linkPub } : {}),
    depth,
    includes: pathList(input.includes),
    excludes: pathList(input.excludes),
    ttlDays,
    doNotTouch: pathList(input.doNotTouch),
    crawlAuthed: typeof input.crawlAuthed === "boolean" ? input.crawlAuthed : true,
    session: {
      kind,
      cookies: kind === "cookie" ? nameList(sessionIn.cookies) : [],
      storageKeys: kind === "localStorage" ? nameList(sessionIn.storageKeys) : [],
      logoutPaths: pathList(sessionIn.logoutPaths),
    },
    intro: { name: str(introIn.name, LIMITS.introName), line: str(introIn.line, LIMITS.introLine) },
    knowledge: pathList(input.knowledge),
  };
  return { config, notes };
}

/** `data-site='<base64url site.json>'` — the carrier for hosts where only a script tag can be pasted. */
export function decodeDataSite(attr: string): unknown | null {
  try {
    const b64 = attr.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = typeof atob === "function" ? atob(pad) : Buffer.from(pad, "base64").toString("binary");
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function encodeDataSite(config: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(config));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface CarrierInput {
  /** Phase 3: the claimed app's signed public bundle (§5.5). The typed hook is here now, unfed. */
  bundle?: unknown | null;
  /** GET /.well-known/infinite-agent.json, same origin. */
  siteFile?: unknown | null;
  /** The `data-site` attribute, already base64url-decoded. */
  snippet?: unknown | null;
  /** The ref the loaded script carries; a site file naming another ref is ignored (§5.2.4). */
  ref?: string;
}

/**
 * Pick the settings in force. The first carrier that yields a usable document wins; a site file
 * whose `ref` names a different app is not merged, not partially used — it is ignored, and the
 * owner panel says so, because a mismatch means the file belongs to somebody else's snippet.
 */
export function resolveSiteConfig(input: CarrierInput): ResolvedSiteConfig {
  const notes: string[] = [];

  if (input.bundle != null) {
    const { config, notes: n } = validateSiteConfig(input.bundle);
    return { config, carrier: "bundle", notes: [...notes, ...n] };
  }

  if (input.siteFile != null) {
    const { config, notes: n } = validateSiteConfig(input.siteFile);
    if (input.ref && config.ref && config.ref !== input.ref) {
      notes.push(
        `the site file at /.well-known/infinite-agent.json names ref ${config.ref}, but this page loads ${input.ref} — the file was ignored`,
      );
    } else {
      return { config, carrier: "site-file", notes: [...notes, ...n] };
    }
  }

  if (input.snippet != null) {
    const { config, notes: n } = validateSiteConfig(input.snippet);
    return { config, carrier: "snippet", notes: [...notes, ...n] };
  }

  return { config: { ...DEFAULT_SITE_CONFIG }, carrier: "defaults", notes };
}
