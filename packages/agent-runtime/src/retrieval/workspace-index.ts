/**
 * THE WORKSPACE, SEARCHABLE WITH NO BRAIN IN THE BUILDING (§4.1, gap B14).
 *
 * `grep` needs the person to know the word that is in the file. Retrieval does not: "what did I
 * decide about pricing" finds the note that says "we settled on per-seat" because BM25 ranks the
 * chunk that shares the most rare words with the question. That is the difference between a file
 * tool and a memory, and it is the reason this exists as a MODULE and not only as a tool —
 * `createWorkspaceIndex(fs)` is callable with no runtime, no provider and no model at all, which is
 * how the PWA answers a question on a browser that has downloaded nothing.
 *
 * THE FOUR BOUNDS, and why each number is where it is:
 *
 *   · ≤ 5 000 FILES. A person's workspace is hundreds of notes; five thousand is a repository that
 *     was copied in, and indexing it in a tab would freeze the tab. Past the bound the index stops
 *     and SAYS it stopped, rather than silently answering from half a workspace.
 *   · ≤ 256 KB PER FILE. Past that it is a dataset, a log or a bundle, not something anybody wrote.
 *   · TEXT ONLY, decided by extension and then by a NUL sniff. A minified bundle or a png would
 *     otherwise fill the postings with garbage tokens that match nothing and slow everything.
 *   · CHUNKS OF ~40 LINES with a 5-line overlap, addressed as `path:from-to`. A whole file is too
 *     coarse to quote and one line is too small to score, and the overlap keeps a paragraph that
 *     straddles a boundary findable from either side.
 *
 * IT IS LAZY AND IT IS INVALIDATED, never refreshed on a timer: the first `search()` after a change
 * pays for the rebuild and every one after it is free. `observe()` takes the runtime's own
 * `file_changed` event, so the wiring at the host is one line and there is no second notion of
 * "something changed" to keep in step (see the note on `observe`).
 */
import type { AgentFs } from "@00/agent-fs";
import type { AgentEvent } from "../api.js";
import { Bm25Index, type Bm25Document } from "./bm25.js";

export const INDEX_MAX_FILES = 5000;
export const INDEX_MAX_FILE_BYTES = 256 * 1024;
const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 5;

/** Extensions worth indexing. Anything else is skipped without being read. */
const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "text",
  "json",
  "jsonl",
  "yml",
  "yaml",
  "toml",
  "csv",
  "tsv",
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "sh",
  "swift",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "sql",
  "env",
  "ini",
  "conf",
  "log",
  "vue",
  "svelte",
]);

/** Files with no extension that are still text — the ones an agent's workspace actually holds. */
const TEXT_NAMES = new Set(["AGENTS", "SOUL", "IDENTITY", "USER", "MEMORY", "TOOLS", "BOOTSTRAP", "LICENSE", "README"]);

function looksTextual(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return TEXT_NAMES.has(name.toUpperCase());
  return TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export interface WorkspaceChunk extends Bm25Document {
  /** `notes/pricing.md:41-80` — the id, and also how a person is told where the answer is. */
  id: string;
  path: string;
  fromLine: number;
  toLine: number;
  text: string;
}

export interface WorkspaceHit {
  path: string;
  fromLine: number;
  toLine: number;
  score: number;
  /** The chunk, trimmed to a window around the first query word that appears in it. */
  passage: string;
}

export interface WorkspaceIndexStats {
  files: number;
  chunks: number;
  /** True when the walk hit `INDEX_MAX_FILES` — the answer is from part of the workspace. */
  truncated: boolean;
  builtAt: number;
}

export interface WorkspaceIndex {
  search(query: string, opts?: { limit?: number }): Promise<WorkspaceHit[]>;
  stats(): Promise<WorkspaceIndexStats>;
  /** Drop the index; the next search rebuilds. A path is accepted and ignored — see the note. */
  invalidate(path?: string): void;
  /** Hand it the runtime's events and it invalidates itself on `file_changed`. */
  observe(event: AgentEvent): void;
}

export interface WorkspaceIndexOptions {
  /** What to index. The agent's own sandbox by default. */
  root?: string;
  maxFiles?: number;
  maxFileBytes?: number;
  now?: () => number;
}

/** ~40-line chunks with a 5-line overlap, so a paragraph on a boundary is findable from both sides. */
function chunkFile(path: string, text: string): WorkspaceChunk[] {
  const lines = text.split("\n");
  const out: WorkspaceChunk[] = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let start = 0; start < lines.length; start += step) {
    const slice = lines.slice(start, start + CHUNK_LINES);
    const body = slice.join("\n").trim();
    if (body.length > 1) {
      const fromLine = start + 1;
      const toLine = Math.min(start + slice.length, lines.length);
      out.push({
        id: `${path}:${fromLine}-${toLine}`,
        // The PATH is part of what is scored: a question about "pricing" should find
        // `projects/site/pricing.md` even when the word is only in its name.
        title: path.replace(/[/_-]/g, " "),
        path,
        fromLine,
        toLine,
        text: body,
      });
    }
    if (start + CHUNK_LINES >= lines.length) break;
  }
  return out;
}

/** The passage a hit is quoted as: a window around the first query word inside the chunk. */
function passageFor(text: string, query: string, width = 320): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1)) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0 || text.length <= width) return text.slice(0, width) + (text.length > width ? "…" : "");
  const start = Math.max(0, text.lastIndexOf(" ", Math.max(0, at - 100)) + 1);
  return (start > 0 ? "…" : "") + text.slice(start, start + width).trim() + (start + width < text.length ? "…" : "");
}

const decoder = new TextDecoder();

export function createWorkspaceIndex(fs: AgentFs, opts: WorkspaceIndexOptions = {}): WorkspaceIndex {
  const root = opts.root ?? "workspace";
  const maxFiles = opts.maxFiles ?? INDEX_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? INDEX_MAX_FILE_BYTES;
  const now = opts.now ?? (() => Date.now());

  let index: Bm25Index<WorkspaceChunk> | null = null;
  let stats: WorkspaceIndexStats = { files: 0, chunks: 0, truncated: false, builtAt: 0 };
  /** One build at a time: two searches during a rebuild must not walk the tree twice. */
  let building: Promise<Bm25Index<WorkspaceChunk>> | null = null;

  async function build(): Promise<Bm25Index<WorkspaceChunk>> {
    const chunks: WorkspaceChunk[] = [];
    let files = 0;
    let truncated = false;
    // maxFiles + 1 so hitting the bound is DETECTED rather than silently landing exactly on it.
    for await (const entry of fs.walk(root, { maxEntries: maxFiles + 1 })) {
      if (files >= maxFiles) {
        truncated = true;
        break;
      }
      const rel = entry.path.startsWith(`${root}/`) ? entry.path.slice(root.length + 1) : entry.path;
      if (!looksTextual(rel)) continue;
      if (entry.stat.size > maxFileBytes) continue;
      let bytes: Uint8Array;
      try {
        bytes = await fs.readFile(`${root}/${rel}`);
      } catch {
        continue; // a file that vanished between the walk and the read is not an error here
      }
      if (bytes.includes(0)) continue; // the extension lied; it is binary
      files++;
      chunks.push(...chunkFile(rel, decoder.decode(bytes)));
    }
    stats = { files, chunks: chunks.length, truncated, builtAt: now() };
    return new Bm25Index(chunks);
  }

  async function ready(): Promise<Bm25Index<WorkspaceChunk>> {
    if (index) return index;
    building ??= build().then((built) => {
      index = built;
      building = null;
      return built;
    });
    return building;
  }

  /** Free-standing so `runtime.on(index.observe)` works — a method would lose `this` on the way. */
  const invalidate = (): void => {
    index = null;
    building = null;
  };

  return {
    async search(query, searchOpts = {}) {
      const built = await ready();
      return built.search(query, searchOpts.limit ?? 5).map(({ doc, score }) => ({
        path: doc.path,
        fromLine: doc.fromLine,
        toLine: doc.toLine,
        score,
        passage: passageFor(doc.text, query),
      }));
    },
    async stats() {
      await ready();
      return { ...stats };
    },
    /**
     * `path` is accepted and IGNORED, deliberately. A partial update would have to know which chunks
     * a file produced, re-chunk it, splice the postings and fix the average document length — for a
     * workspace of hundreds of files, whose rebuild is a walk and some string work, that is a lot of
     * code to make a fast thing slightly faster and a correct thing occasionally wrong. The argument
     * stays in the signature because the caller has it and a later, measured optimisation will want
     * it, without every call site changing.
     */
    invalidate,
    observe: (event: AgentEvent) => {
      if (event.type === "file_changed") invalidate();
    },
  };
}
