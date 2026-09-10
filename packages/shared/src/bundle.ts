/**
 * THE BUNDLE CONTAINER — what an agent looks like as ONE encrypted file, written down for the
 * hosts that have to produce and consume it without sharing a line of code.
 *
 * The engine's `apps/00d/src/burst-bundle.ts` is the reference implementation, and until now it was
 * also the only specification. That was fine while every producer was Node. It stops being fine the
 * moment a browser writes one (docs/HANDOFF-infinite-agent.md §3.2): a `.00agent` exported from OPFS
 * has to be importable by the Mac engine unchanged, so the format belongs here, beside the types,
 * where both sides read it.
 *
 * THE CONTAINER, outside in:
 *
 *   1. The payload is a directory. For a FULL bundle it holds `agent/` — the whole `agents/<id>/`
 *      tree minus the ephemeral class (bundle-policy.ts) — and `burst.json` AT THE ROOT of the
 *      payload, beside `agent/`, never inside it. Session/paths bundles lay the payload out
 *      differently (`workspace/`, `fs/`, `git/`, `profile.json`); a browser writes FULL.
 *   2. The payload is tarred and gzipped: `tar -czf bundle.tar.gz -C <payload> .`. Plain ustar/pax
 *      entries with relative paths — no absolute paths, no `..`, no symlinks (a link resolves to
 *      somebody else's file on the other machine, so the reader drops them and the writer must not
 *      emit them). Mac writers set `COPYFILE_DISABLE=1`; the reader deletes `._*` siblings anyway.
 *   3. The tar.gz is encrypted with AES-256-GCM. The key is `SHA-256(utf8(secret + ":enc"))` — the
 *      lease token for a cloud burst, the transfer secret for a `.00agent` a person moves by hand.
 *      The file layout is exactly `iv(12) || ciphertext || tag(16)`, concatenated, no header and no
 *      framing: a reader that finds fewer than 28 bytes refuses, and a GCM tag mismatch is a hard
 *      failure rather than a partial extract.
 *
 * THE MANIFEST, at `burst.json`: `BurstManifest` below, JSON, UTF-8. A browser-made FULL bundle
 * declares `version: 1` (the version every engine, including the oldest container one, imports) and
 * `host: "browser"`. Version 2 is session mode and carries the baseline; nothing browser-side writes
 * it yet. (docs/HANDOFF-infinite-agent.md §3.2 sketches the `.00agent` as "manifest version 2" —
 * that reads the version as a document revision, which it is not: the number says WHICH PAYLOAD
 * LAYOUT the reader must expect, and a full move's layout is 1. An engine will import a version-2
 * full bundle too, but writing one gains nothing and costs the oldest reader.)
 *
 * UNKNOWN FIELDS ARE TOLERATED, BY RULE. The reader parses this shape out of JSON and consults the
 * fields it knows; a field a newer host added is carried along and ignored. That is why `host` could
 * be added at all, and why the next additive field must be added the same way — optional, and never
 * load-bearing for an import to succeed.
 */

// `wake` is the operator's ON switch as a lease: metering + keep-awake, NO agent state — it never
// exports or imports a bundle, so exportBundle/importBundle must never see it.
export type BurstMode = "full" | "paths" | "session" | "wake";

/**
 * Which kind of engine wrote this bundle. Informational and additive: it never decides whether an
 * import succeeds, it answers "where did this agent come from" in a timeline entry and in the
 * transfer receipt. An older engine reading a bundle that carries it simply does not look.
 */
export type BurstHost = "mac" | "linux" | "container" | "browser";

/** What the exporting side held at export time — the merge's frame of reference (session mode). */
export interface BurstBaseline {
  /** Workspace-relative path → sha256 of every workspace file that went up. */
  files: Record<string, string>;
  /** Session file basenames present in sessions/ at export. */
  sessions: string[];
  /** Timeline event ids present at export. */
  timelineIds: string[];
}

/** What rides inside every bundle, at `burst.json`. */
export interface BurstManifest {
  /** 1 = full/paths (readable by every engine); 2 = session (adds baseline + home/ payload). */
  version: 1 | 2;
  agentId: string;
  mode: BurstMode;
  paths?: string[];
  /** Workspace-relative git repo roots included as git bundles (paths/session modes). */
  gitRepos?: { path: string; headRef: string }[];
  createdAt: string;
  /** Session mode only. On the way up: computed at export. On the way home: ECHOED from the
   *  inbound bundle, so the local merge compares against what it actually sent, not against what
   *  the replica happened to hold. */
  baseline?: BurstBaseline;
  /** Session mode, result bundles only: this bundle carries home/sessions, home/timeline and
   *  home/sidecars produced during the cloud run. */
  carriesHome?: boolean;
  /** Who exported it (see BurstHost) — optional, informational, ignored by every import path. */
  host?: BurstHost;
}
