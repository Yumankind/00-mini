/**
 * THE PUBLIC BUNDLE — the one bridge from a private workspace to a light agent (§5.5).
 *
 * What travels: `workspace/public/**`, which is where the scaffold puts `PERSONA.md` and where the
 * Mac agent's public surface lives. What does NOT travel: memory, projects, sessions, files, skills,
 * the vault — everything else in the agent folder. That is the same boundary `workspace/public/` has
 * on the Mac, and it is enforced HERE, in the owner's browser, because the worker cannot enforce it:
 * `bundle.ts` takes opaque bytes and checks two things a server can check — the signature and the
 * size. Nothing on the far side can tell a persona from a private diary.
 *
 * ── THE FORMAT IS JSON, AND THAT IS A DECISION THIS FILE OWNS ──────────────────────────────────
 *
 * The worker stores the bytes with whatever `Content-Type` the PUT carried and serves them back
 * unchanged with `nosniff` (`bundle.ts`: "The bundle is opaque bytes to this worker"). So the format
 * is a contract between THIS file and the embed's `read_public`, and nothing else has an opinion.
 *
 * It is a single JSON document — `{ version, ref, publishedAt, files: [{ path, text }] }` — rather
 * than a gzip-tar, for one reason that outweighs the size saving: the reader is `embed/src/`, a
 * 32 KB script on a stranger's website, and its `read_public` already deals in path → text
 * (`knowledge.ts`). JSON is `JSON.parse`; a tar means shipping a tar reader and a gunzip to every
 * visitor of every site for a payload capped at 256 KB of prose. `DecompressionStream` would carry
 * the gunzip, but not the tar, and half a format is worse than either.
 *
 * Text only, for the same reason `workspace/public/` is text only on the Mac: a binary in a bundle
 * whose whole purpose is to be read aloud by a language model is bytes nobody will ever read.
 *
 * ── THE CAP IS REFUSED BY NAME, NEVER TRIMMED ──────────────────────────────────────────────────
 *
 * 256 KB is `PUBLIC_BUNDLE_MAX_BYTES`, the plan's ceiling and the worker's. A builder that silently
 * dropped the last file to fit would publish a persona missing its last paragraph and say nothing;
 * the owner would find out from a visitor. So an oversize bundle comes back as
 * `{ ok: false, code: "too_large" }` WITH THE FILE LIST AND EACH SIZE, which is what a person needs
 * to decide what to remove.
 */
import type { AgentFs } from "@00/agent-fs";

/** `workspace/public/` — the scaffold's own directory (`SCAFFOLD_DIRS` in @00/agent-fs). */
export const PUBLIC_ROOT = "workspace/public";

/** The worker's `PUBLIC_BUNDLE_MAX_BYTES`, and §5.5's "≤ 256 KB". */
export const PUBLIC_BUNDLE_MAX_BYTES = 256 * 1024;

/** What the PUT carries, so the GET serves it back as this and the embed can `JSON.parse` it. */
export const PUBLIC_BUNDLE_CONTENT_TYPE = "application/json";

export interface PublicBundleFile {
  /** Relative to `workspace/public/` — `PERSONA.md`, `faq/shipping.md`. */
  path: string;
  text: string;
  bytes: number;
}

export interface PublicBundle {
  version: 1;
  ref: string;
  publishedAt: string;
  files: { path: string; text: string }[];
}

export type BuildResult =
  | { ok: true; bundle: PublicBundle; bytes: Uint8Array; files: PublicBundleFile[] }
  | { ok: false; code: "empty"; files: PublicBundleFile[] }
  | { ok: false; code: "too_large"; bytes: number; maxBytes: number; files: PublicBundleFile[] };

/** A file that is not text is not knowledge. Same list `knowledge.ts` accepts on the visitor's side. */
const TEXT_SUFFIXES = [".md", ".txt", ".json", ".csv", ".html", ".htm", ".yaml", ".yml"];

export function looksTextual(path: string): boolean {
  const lower = path.toLowerCase();
  return TEXT_SUFFIXES.some((s) => lower.endsWith(s));
}

/**
 * Read `workspace/public/**` and assemble the document.
 *
 * `PERSONA.md` is not special-cased: the scaffold writes it INSIDE `workspace/public/`, so it is
 * already the first file this walk finds, and a second code path for it would be a second place to
 * get its name wrong.
 */
export async function buildPublicBundle(
  fs: AgentFs,
  input: { ref: string; now?: Date; maxBytes?: number },
): Promise<BuildResult> {
  const maxBytes = input.maxBytes ?? PUBLIC_BUNDLE_MAX_BYTES;
  const files: PublicBundleFile[] = [];
  const encoder = new TextEncoder();

  const root = await fs.stat(PUBLIC_ROOT);
  if (root?.kind === "dir") {
    for await (const entry of fs.walk(PUBLIC_ROOT)) {
      // `walkFs` yields paths relative to the FS ROOT, not to the directory it was handed
      // (`workspace/public/PERSONA.md`), so the prefix comes off here and the published path is the
      // one a visitor's `read_public("PERSONA.md")` will ask for.
      if (!entry.path.startsWith(`${PUBLIC_ROOT}/`)) continue;
      const rel = entry.path.slice(PUBLIC_ROOT.length + 1);
      // Dotfiles are the workspace's own bookkeeping, at any depth. Nothing named `.something` was
      // written to be read by a stranger.
      if (!rel || rel.split("/").some((s) => s.startsWith("."))) continue;
      if (!looksTextual(rel)) continue;
      let text: string;
      try {
        text = await fs.readText(`${PUBLIC_ROOT}/${rel}`);
      } catch {
        // One unreadable file must not cost the owner the whole publish; it is simply not published,
        // and the caller sees it missing from the list it is shown before it sends.
        continue;
      }
      files.push({ path: rel, text, bytes: encoder.encode(text).length });
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (files.length === 0) return { ok: false, code: "empty", files };

  const bundle: PublicBundle = {
    version: 1,
    ref: input.ref,
    publishedAt: (input.now ?? new Date()).toISOString(),
    files: files.map((f) => ({ path: f.path, text: f.text })),
  };
  const bytes = encoder.encode(JSON.stringify(bundle));
  if (bytes.length > maxBytes) {
    return { ok: false, code: "too_large", bytes: bytes.length, maxBytes, files };
  }
  return { ok: true, bundle, bytes, files };
}
