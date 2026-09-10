/**
 * THE PUBLIC BUNDLE, READ (§5.5) — the one bridge from the owner's private workspace to this embed.
 *
 * The owned agent publishes `workspace/public/**` — where the scaffold keeps `PERSONA.md` — and
 * NOTHING ELSE: not memory, not projects, not sessions. The worker stores those bytes opaquely (its
 * own `bundle.ts` says so: it enforces the signature and the 256 KB and never guesses what is
 * inside), so the FORMAT is a contract between the two browsers at the ends of it. This file is the
 * reader's half; the writer's half is `apps/infinite/src/registry/public-bundle.ts`.
 *
 * ── THE FORMAT, AS THE PUBLISHER WRITES IT ─────────────────────────────────────────────────────
 *
 *     { "version": 1, "ref": "ia_…", "publishedAt": "…", "files": [ { "path": "PERSONA.md", "text": "…" } ] }
 *
 * One JSON document, `application/json`, ≤ 256 KB, paths relative to `workspace/public/`. The
 * publisher's file argues the choice at length and the argument holds from this side too: the
 * reader is a 33 KB script on a stranger's website whose `read_public` already deals in path → text,
 * and a gzip-tar would mean shipping a tar reader and a gunzip to every visitor of every site for a
 * payload capped at a quarter of a megabyte of prose.
 *
 * ── AND THE ONE THING THIS SIDE ADDS: `site.json` ──────────────────────────────────────────────
 *
 * §5.1 makes the bundle CARRIER 1 of the settings precedence, above the site file and the snippet.
 * The publisher has no separate slot for that document, and it does not need one: a file named
 * `site.json` in the list IS the settings document, because an owner who puts one in
 * `workspace/public/` has published it in the only place this reader looks. It is parsed here and
 * handed to `resolveSiteConfig`, which re-types every field of it as it does for every other
 * carrier; it is not offered to `read_public`, because settings are not knowledge.
 *
 * ── WHY IT IS READ THIS DEFENSIVELY ────────────────────────────────────────────────────────────
 *
 * These bytes were assembled by a browser and signed by a key; nothing between here and there
 * checked what is in them, and this code runs inside somebody else's page. So the document is
 * re-typed field by field, a path that could leave the bundle is dropped rather than repaired, the
 * total kept is capped, and an entry that is not a `{ path, text }` pair is skipped. What comes back
 * is text the agent may quote — data, never instructions, exactly as a crawled page is.
 */

/** The worker's `PUBLIC_BUNDLE_MAX_BYTES`, the publisher's, and §5.5's: the 256 KB `public/` has on the Mac. */
export const BUNDLE_MAX_BYTES = 256 * 1024;

/** The settings document's name inside the bundle — carrier 1 of §5.1. */
export const BUNDLE_SITE_FILE = "site.json";

export interface PublicBundle {
  version: number;
  /** The ref the publisher stamped, so a bundle served for another app can be recognised. */
  ref: string;
  publishedAt: string;
  /** `PERSONA.md` and the rest of `workspace/public/`, path → text. */
  files: Record<string, string>;
  /** `site.json`, parsed — or null when the owner published none. */
  siteFile: unknown | null;
  bytes: number;
}

export const EMPTY_BUNDLE: PublicBundle = {
  version: 1,
  ref: "",
  publishedAt: "",
  files: {},
  siteFile: null,
  bytes: 0,
};

/**
 * A path inside the bundle, or null.
 *
 * Same rule as `site-config.ts::normalisePath`: anything with a scheme, an authority, a backslash, a
 * leading slash or a `..` segment is DROPPED rather than repaired, because a "path" that could point
 * somewhere else is the one thing this reader must not be able to say.
 */
export function bundlePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.replace(/^\.\//, "").trim();
  if (!p || p.length > 256) return null;
  if (p.includes("://") || p.includes("\\") || p.startsWith("/")) return null;
  if (p.split("/").some((seg) => seg === ".." || seg === "")) return null;
  return p;
}

/**
 * Read one bundle from the bytes the registry served.
 *
 * Throws only when the bytes are not a bundle at all — too big, not UTF-8, not JSON, not the shape.
 * Everything unreadable INSIDE a well-formed document is skipped instead, so one bad entry cannot
 * cost the owner their persona.
 */
export function parsePublicBundle(input: Uint8Array): PublicBundle {
  if (input.byteLength === 0) throw new Error("an empty public bundle");
  if (input.byteLength > BUNDLE_MAX_BYTES) throw new Error("a public bundle is at most 256 KB");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
  } catch (err) {
    throw new Error(`this public bundle is not a JSON document (${String(err)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("this public bundle is not a JSON object");
  }
  const doc = parsed as Record<string, unknown>;
  const entries = Array.isArray(doc.files) ? doc.files : [];

  const files: Record<string, string> = {};
  let siteFile: unknown | null = null;
  let bytes = 0;
  for (const raw of entries) {
    const entry = raw as { path?: unknown; text?: unknown } | null;
    if (!entry || typeof entry !== "object") continue;
    const path = bundlePath(entry.path);
    if (!path || typeof entry.text !== "string") continue;
    // No second ceiling here: the document itself was refused above if it was over 256 KB, and the
    // text inside a JSON document is never larger than the document. One cap, at the door.
    bytes += entry.text.length;
    if (path === BUNDLE_SITE_FILE) {
      try {
        siteFile = JSON.parse(entry.text) as unknown;
      } catch {
        // A settings document that will not parse is no document: the next carrier down wins, and
        // `resolveSiteConfig` never sees a half-read one.
        siteFile = null;
      }
      continue;
    }
    files[path] = entry.text;
  }

  return {
    version: typeof doc.version === "number" ? doc.version : 1,
    ref: typeof doc.ref === "string" ? doc.ref.slice(0, 80) : "",
    publishedAt: typeof doc.publishedAt === "string" ? doc.publishedAt.slice(0, 40) : "",
    files,
    siteFile,
    bytes,
  };
}
