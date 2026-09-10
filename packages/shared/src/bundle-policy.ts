/**
 * TRAVEL RULES for an agent folder — one place that answers "does this file leave the machine".
 *
 * The question used to be answered in four different places with four different lists: a closed
 * identity list in burst-bundle.ts, an exclude list beside it, the chosen folders in the burst call,
 * and "whatever the full-mode copy happens to include". Each was right on its own and none of them
 * could be read against the others, so the honest answer to "will my node_modules go to the cloud"
 * was "read three files and hope". This module is that answer, written down once.
 *
 * IT LIVES IN `@00/shared` because the browser runtime is the fourth engine host
 * (docs/HANDOFF-infinite-agent.md §2): an agent exported from OPFS and imported on the Mac has to
 * have been classified by the SAME rules, or the two hosts disagree about what an agent even is.
 * So everything here is pure — no `node:fs`, no `node:path`, paths as agent-root-relative POSIX
 * strings — and the file-reading half (`ignoreFor`, the size preview) stays in the engine, where a
 * filesystem exists. Adding a `node:` import here breaks the browser build, silently, at bundle time.
 *
 * FOUR CLASSES, and the reason each exists:
 *
 *   identity   the agent ITSELF — who it is, what it remembers, what it can do. Travels in every
 *              mode, because a copy without it is a stranger wearing the agent's name.
 *   work       what it is working ON (projects/, files/). Travels when CHOSEN, because sending a
 *              40 GB media folder to finish a README is a bill, not a feature.
 *   record     what it DID and who talked to it (sessions, timeline, threads, contacts, quarantine,
 *              run state). Full move only. A cloud task must not answer the operator's inbox — the
 *              rule burst-bundle.ts's header has always stated, now expressible as a class.
 *   ephemeral  never, in any mode: caches, build output, scratch, logs. Not a privacy rule, a WEIGHT
 *              rule — these are the files that make a bundle big and are worthless on the far side
 *              because the other machine rebuilds them.
 *
 * `classify()` is TOTAL over the agent folder: every path lands in exactly one class, and
 * apps/00d/test/bundle-policy.test.ts walks the tree documented in docs/agent-layout.md to prove it.
 * The defaults are deliberately generous at the edges — an unrecognised path inside the workspace is
 * `work` (the agent's own material) and an unrecognised path outside it is `record` (the folder
 * outside the sandbox IS the record) — so a folder somebody adds next month is classified the
 * conservative way rather than not at all.
 *
 * The person's own say is `workspace/.00ignore` (see compileIgnore): gitignore syntax, applied on
 * top of the defaults by every export.
 */

export type TravelClass = "identity" | "work" | "record" | "ephemeral";

/**
 * The identity surface as FILES at the workspace root. Deliberately a closed list — an addition here
 * widens what a cloud run can rewrite at home, so each one is a decision, not a glob.
 * `.00ignore` is here because the far side must export by the same rules it was imported under.
 */
export const IDENTITY_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "MEMORY.md",
  "branding.json",
  "avatar.txt",
  ".00ignore",
] as const;

/**
 * The identity surface as DIRECTORIES under the workspace.
 *
 * `schedules` and `watchers` are here for a reason worth stating: they are DEFINITIONS the agent
 * wrote — a standing job and what wakes it — and a copy of the agent that cannot see its own
 * standing jobs is missing part of itself. Their RUN STATE (schedules.json, watchers-state.json)
 * is `record` and stays home, which is exactly the split that makes this safe: the cloud copy can
 * read and edit what it is supposed to do, and cannot claim to have done it.
 */
export const IDENTITY_DIRS = ["memory", "skills", "public", "tools", "schedules", "watchers"] as const;

/** Chosen-per-burst folders. Everything else inside the workspace defaults to this class too. */
export const WORK_DIRS = ["projects", "files"] as const;

/**
 * The record, outside the sandbox: what the agent did and who talked to it. Listed for the docs and
 * for the totality test; anything else outside `workspace/` falls here anyway (see classify).
 */
export const RECORD_ENTRIES = [
  "sessions",
  "timeline",
  "threads",
  "threads-fs",
  "contacts",
  "quarantine",
  "escalations",
  "team.json",
  "attention.json",
  "unread.json",
  "archived.json",
  "pinned.json",
  "pinned-files.json",
  "muted.json",
  "pending-prompt.json",
  "schedules.json",
  "watchers-state.json",
] as const;

/**
 * What never travels, as gitignore patterns — these ARE the defaults `.00ignore` starts from, so the
 * ephemeral class and the ignore file speak one language instead of two.
 *
 * The build-output names (dist, build, .next, target, __pycache__, .venv) matter most inside a
 * project's working tree: a git repo travels as a `git bundle`, which carries only committed
 * objects, but a NON-git folder is copied file by file — which is how an untracked `node_modules`
 * turns a three-file project into a 400 MB upload.
 */
export const DEFAULT_IGNORE_PATTERNS: string[] = [
  "tmp/",
  "cache/",
  ".cache/",
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "target/",
  "__pycache__/",
  ".venv/",
  // Meeting audio: minutes of raw webm per meeting, and the transcript is what anyone ever reads.
  "files/meetings/*.webm",
  "*.log",
  ".DS_Store",
];

/**
 * Agent-folder entries that never travel and are not expressible as workspace-relative patterns.
 *
 * The browser host adds one of its own on top of this list rather than in it — `.browser/` is
 * OPFS-only bookkeeping (model cache pointers, crawl indexes) and is expressed as an ignore pattern
 * by the runtime that owns it, so this engine never has to know the name.
 */
const EPHEMERAL_AGENT_ENTRIES = [
  // A LIVENESS signal, not state: shipping it would make the replica look already claimed by a
  // dead process (burst-bundle.ts has excluded it since the first bundle).
  "workspace.lock",
  ".cache",
  // The manifest the replica keeps so its result can echo the baseline — bookkeeping, not agent state.
  "burst-inbound.json",
];

// ── The ignore matcher (a small, tested subset of gitignore) ─────────────────────────────────────

interface IgnoreRule {
  re: RegExp;
  /** Match against the path's last segment (a pattern with no slash matches at any depth). */
  basename: boolean;
  /** `!pattern` — un-ignores what an earlier rule ignored. */
  negate: boolean;
  source: string;
}

export interface IgnoreMatcher {
  /** Is this workspace-relative path excluded? */
  ignores(rel: string): boolean;
  /** WHICH pattern excluded it — the preview says "left out by" and has to name a reason. */
  reason(rel: string): string | undefined;
  patterns: string[];
}

/** Glob → RegExp source. `*` and `?` stop at `/`; `**` crosses separators, and `**` followed by a
 *  separator also matches zero directories. */
function globToRe(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // `**/x` matches `x` as well as `a/b/x`
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return re;
}

/**
 * Compile gitignore-style patterns. Supported on purpose and no more: `*`, `**`, `?`, a leading or
 * embedded `/` to anchor at the workspace root, a trailing `/` for "this directory and everything
 * under it", `!` to un-ignore, `#` comments and blank lines.
 *
 * Matching walks the path's ANCESTORS shallowest-first and lets the last matching rule win, which is
 * what makes both halves work at once: `node_modules/` excludes everything beneath it (the rule
 * matched an ancestor), and `!keep.log` beats the default `*.log` (a later rule matched the file
 * itself).
 */
export function compileIgnore(patterns: string[]): IgnoreMatcher {
  const rules: IgnoreRule[] = [];
  for (const raw of patterns) {
    let p = raw.trim();
    if (!p || p.startsWith("#")) continue;
    const negate = p.startsWith("!");
    if (negate) p = p.slice(1);
    let dirOnly = false;
    if (p.endsWith("/")) {
      dirOnly = true;
      p = p.slice(0, -1);
    }
    if (!p) continue;
    let anchored = false;
    if (p.startsWith("/")) {
      anchored = true;
      p = p.slice(1);
    }
    if (p.includes("/")) anchored = true;
    const body = globToRe(p);
    // A directory rule also matches everything under it — cheaper here than a second pass, and it
    // means `dist/` catches `dist/app.js` even when the walk never yielded `dist` itself.
    const re = new RegExp(`^${body}${dirOnly ? "(?:/.*)?" : ""}$`);
    rules.push({ re, basename: !anchored, negate, source: raw.trim() });
  }

  const decide = (rel: string): IgnoreRule | undefined => {
    const parts = rel.split("/").filter(Boolean);
    let hit: IgnoreRule | undefined;
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.slice(0, i + 1).join("/");
      const base = parts[i];
      // An unanchored pattern matches the SEGMENT at any depth; an anchored one the path so far.
      for (const rule of rules) {
        if (rule.re.test(rule.basename ? base : prefix)) hit = rule;
      }
    }
    return hit;
  };

  return {
    ignores: (rel) => decide(rel)?.negate === false,
    reason: (rel) => {
      const hit = decide(rel);
      return hit && !hit.negate ? hit.source : undefined;
    },
    // The rules AS WRITTEN (comments and blanks dropped) — the preview shows them, so "why is this
    // left out" is answerable without opening a file.
    patterns: rules.map((r) => r.source),
  };
}

/** Where a person (or the agent) writes their additions. */
export const IGNORE_FILENAME = ".00ignore";

/** The defaults on their own — used when there is no agent to read a file from. Compiled once:
 *  classify() asks for it per path, and rebuilding a dozen RegExps per file is a walk's worth of
 *  work for an answer that never changes. */
let defaultMatcher: IgnoreMatcher | undefined;
export function defaultIgnore(): IgnoreMatcher {
  return (defaultMatcher ??= compileIgnore(DEFAULT_IGNORE_PATTERNS));
}

// ── Classification ───────────────────────────────────────────────────────────────────────────────

const IDENTITY_FILE_SET = new Set<string>(IDENTITY_FILES);
const IDENTITY_DIR_SET = new Set<string>(IDENTITY_DIRS);

/**
 * Which class does one AGENT-FOLDER-RELATIVE path belong to? (`workspace/memory/x.md`,
 * `sessions/a.jsonl`, `team.json` — never an absolute path, never workspace-relative.) POSIX
 * separators only: the caller converts, because a browser has no other kind and the engine's
 * callers already walk with `/`.
 *
 * `ignore` is the agent's compiled matcher when there is one; without it the defaults apply. It is
 * consulted FIRST for workspace paths, because "never travels" is a stronger statement than any
 * class: a `node_modules` inside `skills/` is still weight, not identity.
 */
export function classify(relPath: string, ignore: IgnoreMatcher = defaultIgnore()): TravelClass {
  const rel = relPath.replace(/^\.?\//, "").replace(/\/+$/, "");
  if (!rel) return "record";
  const parts = rel.split("/");

  if (parts[0] !== "workspace") {
    if (EPHEMERAL_AGENT_ENTRIES.includes(parts[0])) return "ephemeral";
    // The generic weight rules still apply outside the sandbox (a stray .DS_Store in sessions/).
    if (defaultIgnore().ignores(rel)) return "ephemeral";
    // profile.json is WHO THE AGENT IS — it travels in every mode, so it is identity, not record.
    if (rel === "profile.json") return "identity";
    // Everything else outside the sandbox is the record, by construction: that is what the folder
    // outside `workspace/` is for (docs/agent-layout.md).
    return "record";
  }

  const wsRel = parts.slice(1).join("/");
  if (!wsRel) return "identity"; // the workspace dir itself
  if (ignore.ignores(wsRel)) return "ephemeral";
  // The platform docs are copied FRESH from the repo every session (scaffold.syncWorkspaceDocs), so
  // carrying them is paying to move a file the other side is about to overwrite.
  if (parts[1] === "docs") return "ephemeral";
  if (parts.length === 2 && IDENTITY_FILE_SET.has(parts[1])) return "identity";
  if (IDENTITY_DIR_SET.has(parts[1])) return "identity";
  // Anything else the agent made inside its sandbox is its work — including folders nobody has
  // thought of yet, which is the point of the default.
  return "work";
}

/** Every class, in the order the UI says them. */
export const TRAVEL_CLASSES: TravelClass[] = ["identity", "work", "record", "ephemeral"];

/**
 * Record entries a FULL move skips anyway, because the far side REBUILDS them from what does travel:
 * `threads-fs/` is materialized per thread out of `threads/`. Still `record` — it is the operator's
 * inbox made into files — but shipping it would be paying to move a cache of something in the box.
 */
export const FULL_MOVE_SKIP: string[] = ["threads-fs"];

/** Does this class travel in a session/paths burst, given the chosen folders? */
export function travelsInSession(cls: TravelClass, wsRel: string, chosen: string[]): boolean {
  if (cls === "identity") return true;
  if (cls === "work") return chosen.some((c) => wsRel === c || wsRel.startsWith(`${c}/`));
  return false;
}

// ── Size preview, the parts that do not need a filesystem ────────────────────────────────────────

export interface ClassStat {
  bytes: number;
  files: number;
}
