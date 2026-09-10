// The `.00agent` file, written and read in a browser — the other end of `apps/00d/src/burst-bundle.ts`.
//
// The container is specified in `@00/shared/bundle.ts` and this module implements it rather than
// re-deciding it: payload = `agent/<the whole agents/<id>/ tree>` plus `burst.json` AT THE PAYLOAD
// ROOT, tarred, gzipped, then AES-256-GCM with the key rule of crypto.ts. The `agent/` prefix is not
// decoration — the Mac engine's full-mode import copies exactly `<payload>/agent` onto the agent
// directory, so a browser bundle that put the tree at the root would import as an empty agent
// without erroring anywhere.
//
// WHAT DOES NOT TRAVEL is decided by `classify()` from @00/shared, the same function the engine's
// size preview and its exporter use, plus the person's own `workspace/.00ignore`. Any predicate the
// caller passes REPLACES that default, so a caller that narrows the set is doing it knowingly.

import {
  classify,
  compileIgnore,
  DEFAULT_IGNORE_PATTERNS,
  FULL_MOVE_SKIP,
  IGNORE_FILENAME,
  type BurstHost,
  type BurstManifest,
  type IgnoreMatcher,
} from "@00/shared";
import { utf8 } from "./bytes.js";
import { decryptBundle, encryptBundle } from "./crypto.js";
import { fail } from "./errors.js";
import { gunzip, gzip } from "./gzip.js";
import { readTar, tarPack, type TarEntry } from "./tar.js";
import type { AgentFs } from "./types.js";

/** Where the agent tree sits inside the payload of a FULL bundle. */
export const PAYLOAD_AGENT_DIR = "agent";
/** The manifest's name, at the payload root beside `agent/`. */
export const MANIFEST_NAME = "burst.json";

export interface ExportBundleOptions {
  /** The transfer secret or lease token. The key is SHA-256(utf8(secret + ":enc")). */
  secret: string;
  /** Which host wrote it — informational, carried in the manifest (@00/shared BurstHost). */
  host: BurstHost;
  /** Replaces the default travel rules entirely. Called with AGENT-ROOT-RELATIVE paths, for
   *  directories (no trailing slash) as well as files; `false` on a directory prunes its subtree. */
  include?: (relPath: string) => boolean;
  /** Overrides the id read from `profile.json` — the transfer flow's "import as" in reverse. */
  agentId?: string;
  /** Injectable clock, so a test can pin `createdAt`. */
  createdAt?: Date;
}

export interface ImportBundleOptions {
  secret: string;
}

/** The defaults plus `workspace/.00ignore`, in that order — so a `!` in the file can un-ignore. */
export async function ignoreMatcherFor(fs: AgentFs): Promise<IgnoreMatcher> {
  let own: string[] = [];
  try {
    own = (await fs.readText(`workspace/${IGNORE_FILENAME}`)).split("\n");
  } catch {
    /* an unreadable ignore file means the defaults, never a failed export */
  }
  return compileIgnore([...DEFAULT_IGNORE_PATTERNS, ...own]);
}

function skippedByFullMove(rel: string): boolean {
  return FULL_MOVE_SKIP.some((e) => rel === e || rel.startsWith(`${e}/`));
}

/** Everything but the ephemeral class, and not the per-thread sandboxes the far side rebuilds. */
export function fullModeInclude(ignore: IgnoreMatcher): (relPath: string) => boolean {
  return (rel) => classify(rel, ignore) !== "ephemeral" && !skippedByFullMove(rel);
}

async function collect(fs: AgentFs, dir: string, include: (rel: string) => boolean, out: TarEntry[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = dir === "" ? e.name : `${dir}/${e.name}`;
    if (!include(rel)) continue;
    const path = `${PAYLOAD_AGENT_DIR}/${rel}`;
    if (e.kind === "dir") {
      out.push({ path, kind: "dir", data: new Uint8Array(0), mtime: 0 });
      await collect(fs, rel, include, out);
      continue;
    }
    out.push({ path, kind: "file", data: await fs.readFile(rel), mtime: Math.floor(e.mtime / 1000) });
  }
}

/** Read the agent id out of `profile.json` — the id a bundle claims is the profile's, never a guess. */
async function agentIdOf(fs: AgentFs): Promise<string> {
  try {
    const profile = JSON.parse(await fs.readText("profile.json")) as { id?: string };
    if (profile.id) return profile.id;
  } catch {
    /* fall through to the refusal below — an id is not something to invent */
  }
  return fail("agent_id_unknown", "this filesystem has no readable profile.json, so the bundle has no agent id");
}

/** Write the whole agent as one encrypted `.00agent`. Full mode; nothing else is written here. */
export async function exportBundle(fs: AgentFs, opts: ExportBundleOptions): Promise<Uint8Array> {
  const agentId = opts.agentId ?? (await agentIdOf(fs));
  const include = opts.include ?? fullModeInclude(await ignoreMatcherFor(fs));
  const manifest: BurstManifest = {
    // Version 1 is what EVERY engine imports, including the oldest container one. A browser writes
    // full moves, and a full move has never needed version 2's baseline.
    version: 1,
    agentId,
    mode: "full",
    createdAt: (opts.createdAt ?? new Date()).toISOString(),
    host: opts.host,
  };
  const entries: TarEntry[] = [
    { path: MANIFEST_NAME, kind: "file", data: utf8.encode(JSON.stringify(manifest, null, 2)), mtime: 0 },
  ];
  await collect(fs, "", include, entries);
  return encryptBundle(await gzip(tarPack(entries)), opts.secret);
}

export interface ImportedBundle {
  manifest: BurstManifest;
  /** Payload-relative paths exactly as the tar holds them (`agent/workspace/AGENTS.md`,
   *  `secrets.json`, …) — `importBundleInto` is what maps them onto an agent folder. */
  files: AsyncIterable<{ path: string; data: Uint8Array }>;
}

/** macOS AppleDouble siblings: junk that would otherwise land in a workspace as if it were the
 *  agent's own files. Written by mac hubs from before COPYFILE_DISABLE; dropped on every import. */
function isResourceFork(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.startsWith("._");
}

async function openPayload(bytes: Uint8Array, opts: ImportBundleOptions): Promise<{ tar: Uint8Array; manifest: BurstManifest }> {
  const tar = await gunzip(await decryptBundle(bytes, opts.secret));
  let manifest: BurstManifest | undefined;
  for (const entry of readTar(tar)) {
    if (entry.kind !== "file" || entry.path !== MANIFEST_NAME) continue;
    try {
      manifest = JSON.parse(new TextDecoder().decode(entry.data)) as BurstManifest;
    } catch {
      fail("bundle_manifest_unreadable", "this bundle's burst.json is not JSON");
    }
    break;
  }
  if (!manifest) fail("bundle_manifest_missing", "this bundle has no burst.json at its root");
  if (manifest.version !== 1 && manifest.version !== 2) {
    fail("bundle_version_unknown", `unknown bundle version ${String(manifest.version)}`);
  }
  return { tar, manifest };
}

/**
 * Decrypt, decompress and read a `.00agent`. The manifest is resolved eagerly (a bundle whose
 * manifest is missing, unreadable or of an unknown version fails before a single file is handed
 * out); the files are a lazy iterable so a caller can write them one at a time.
 */
export async function importBundle(bytes: Uint8Array, opts: ImportBundleOptions): Promise<ImportedBundle> {
  const { tar, manifest } = await openPayload(bytes, opts);
  async function* files(): AsyncIterable<{ path: string; data: Uint8Array }> {
    for (const entry of readTar(tar)) {
      if (entry.kind !== "file" || entry.path === MANIFEST_NAME || isResourceFork(entry.path)) continue;
      yield { path: entry.path, data: entry.data };
    }
  }
  return { manifest, files: files() };
}

export interface ImportIntoResult {
  manifest: BurstManifest;
  /** Agent-root-relative paths written, in archive order. */
  written: string[];
  /** Directories created, including the empty ones a scaffolded agent has. */
  dirs: string[];
  /** Payload entries outside `agent/` (secrets.json, cli.json, a session bundle's git/ …) — this
   *  function does not vault secrets or clone repos, so it names what it left for the caller. */
  skipped: string[];
}

/** Import a FULL bundle into `fs`'s root. The caller decides what to do about an existing tree. */
export async function importBundleInto(fs: AgentFs, bytes: Uint8Array, opts: ImportBundleOptions): Promise<ImportIntoResult> {
  const { tar, manifest } = await openPayload(bytes, opts);
  if (manifest.mode !== "full") {
    fail("bundle_mode_unsupported", `this host imports full bundles only, and this one is "${manifest.mode}"`);
  }
  const written: string[] = [];
  const dirs: string[] = [];
  const skipped: string[] = [];
  const prefix = `${PAYLOAD_AGENT_DIR}/`;
  for (const entry of readTar(tar)) {
    if (entry.path === MANIFEST_NAME) continue;
    if (isResourceFork(entry.path)) continue;
    if (entry.path === PAYLOAD_AGENT_DIR) continue;
    if (!entry.path.startsWith(prefix)) {
      skipped.push(entry.path);
      continue;
    }
    const rel = entry.path.slice(prefix.length);
    if (!rel) continue;
    if (entry.kind === "dir") {
      await fs.mkdir(rel);
      dirs.push(rel);
      continue;
    }
    await fs.writeFile(rel, entry.data);
    written.push(rel);
  }
  return { manifest, written, dirs, skipped };
}
