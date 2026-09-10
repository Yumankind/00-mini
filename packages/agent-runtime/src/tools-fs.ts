/**
 * read / write / edit / ls / grep / find — THE ENGINE'S NAMES, THE ENGINE'S ARGUMENTS.
 *
 * Every schema in this file is pi's (`core/tools/{read,write,edit,ls,grep,find}.js` in
 * @earendil-works/pi-coding-agent 0.84.2), field for field, description for description, including
 * the defaults quoted in the descriptions. That is not politeness: `apps/00d/src/tools.ts` hands the
 * Mac agent exactly those definitions, and an agent moves between the two hosts as one file. A skill
 * that says `edit` with `edits[].oldText` must find the same tool here or the move breaks it.
 *
 * What this host adds is the CONTAINMENT, which the engine also adds (guardReadable / containNavTool
 * in tools.ts): every path goes through `resolveInSandbox`, and there is no way to reach the agent
 * folder outside the sandbox — `vault.json`, `permissions.json` and `sessions/` are the runtime's
 * record, and an agent that could rewrite its own permissions has none.
 *
 * The read-before-overwrite guard is the engine's too, and kept for the same reason: a model that
 * writes a file it has not read this session is replacing something it cannot describe.
 */
import type { AgentFs } from "@00/agent-fs";
import type { Tool } from "./api.js";
import { globToRegExp, relativeToSandbox, resolveInSandbox } from "./sandbox.js";
import {
  FIND_DEFAULT_LIMIT,
  GREP_DEFAULT_LIMIT,
  LS_DEFAULT_LIMIT,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_LINES,
  PUBLIC_READ_MAX_CHARS,
  truncateHead,
  truncateLine,
} from "./truncate.js";

/** Bound on a single grep/find walk. The engine leans on `fd`/`rg`; here the walk is ours to bound. */
const WALK_MAX_ENTRIES = 20000;

type Args = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function required(args: Args, name: string): string {
  const v = str(args[name]);
  if (v === undefined) throw new Error(`${name} is required and must be a string`);
  return v;
}

/**
 * Files under `dir`, as paths RELATIVE TO `dir`.
 *
 * `AgentFs.walk` is documented to yield relative paths; adapters have been seen to yield
 * agent-root-relative ones instead, and the difference would silently make every grep return
 * nothing. Accepting both is one line and removes a whole class of adapter-shaped bug.
 */
async function walkFiles(fs: AgentFs, dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of fs.walk(dir, { maxEntries: WALK_MAX_ENTRIES })) {
    const p = entry.path.startsWith(`${dir}/`) ? entry.path.slice(dir.length + 1) : entry.path;
    out.push(p);
  }
  return out.sort();
}

async function isDir(fs: AgentFs, path: string): Promise<boolean> {
  const stat = await fs.stat(path);
  return stat?.kind === "dir";
}

function ok(output: string) {
  return { output };
}
function fail(output: string) {
  return { output, isError: true };
}

/**
 * The read-before-overwrite guard's memory.
 *
 * It is an OBJECT the caller owns rather than module state, for the reason the engine scopes it to a
 * session: "you must have read it this session" is a statement about one conversation, and two
 * runtimes in one Worker (the owned agent and a preview) must not vouch for each other's reads. The
 * runtime clears it when a run opens a NEW session; `read`/`edit` mark, `write` checks.
 */
export class SeenFiles {
  private readonly paths = new Set<string>();
  mark(path: string): void {
    this.paths.add(path);
  }
  has(path: string): boolean {
    return this.paths.has(path);
  }
  clear(): void {
    this.paths.clear();
  }
}

// ── read ────────────────────────────────────────────────────────────────────────────────────────

export function readTool(seen: SeenFiles = new SeenFiles()): Tool {
  return {
    tier: "safe",
    schema: {
      name: "read",
      // pi's description, with the image half dropped: this host hands text to the loop, and a tool
      // that promises to attach an image the runtime cannot carry is a promise it cannot keep.
      description: `Read the contents of a file. Output is truncated to ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_CHARS / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to read (relative or absolute)" },
          offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
          limit: { type: "number", description: "Maximum number of lines to read" },
        },
        required: ["path"],
      },
    },
    async run(args, ctx) {
      const path = resolveInSandbox(ctx.sandbox, required(args, "path"));
      const stat = await ctx.fs.stat(path);
      if (!stat) return fail(`File not found: ${relativeToSandbox(ctx.sandbox, path)}`);
      if (stat.kind === "dir") return fail(`${relativeToSandbox(ctx.sandbox, path)} is a directory — use ls.`);
      seen.mark(path);
      const text = await ctx.fs.readText(path);
      const allLines = text.split("\n");
      const offset = num(args.offset);
      const limit = num(args.limit);
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      if (startLine >= allLines.length) {
        return fail(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
      }
      const startDisplay = startLine + 1;
      let selected: string;
      let userLimited: number | undefined;
      if (limit !== undefined) {
        const end = Math.min(startLine + limit, allLines.length);
        selected = allLines.slice(startLine, end).join("\n");
        userLimited = end - startLine;
      } else {
        selected = allLines.slice(startLine).join("\n");
      }
      const t = truncateHead(selected);
      if (t.truncated) {
        const endDisplay = startDisplay + t.outputLines - 1;
        return ok(
          `${t.content}\n\n[Showing lines ${startDisplay}-${endDisplay} of ${allLines.length}${
            t.truncatedBy === "chars" ? ` (${MAX_OUTPUT_CHARS / 1024}KB limit)` : ""
          }. Use offset=${endDisplay + 1} to continue.]`,
        );
      }
      if (userLimited !== undefined && startLine + userLimited < allLines.length) {
        const remaining = allLines.length - (startLine + userLimited);
        return ok(
          `${t.content}\n\n[${remaining} more lines in file. Use offset=${startLine + userLimited + 1} to continue.]`,
        );
      }
      return ok(t.content);
    },
  };
}

// ── write ───────────────────────────────────────────────────────────────────────────────────────

async function ensureParent(fs: AgentFs, path: string): Promise<void> {
  const cut = path.lastIndexOf("/");
  if (cut > 0) await fs.mkdir(path.slice(0, cut));
}

export function writeTool(seen: SeenFiles = new SeenFiles()): Tool {
  return {
    tier: "confirm",
    schema: {
      name: "write",
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to write (relative or absolute)" },
          content: { type: "string", description: "Content to write to the file" },
        },
        required: ["path", "content"],
      },
    },
    async run(args, ctx) {
      const path = resolveInSandbox(ctx.sandbox, required(args, "path"));
      const content = typeof args.content === "string" ? args.content : "";
      const existing = await ctx.fs.stat(path);
      if (existing?.kind === "dir") return fail(`${relativeToSandbox(ctx.sandbox, path)} is a directory.`);
      if (existing && !seen.has(path)) {
        return fail(
          `Refusing to overwrite ${relativeToSandbox(ctx.sandbox, path)} without reading it first — ` +
            `call the read tool on this file to see what you'd replace, then write again. ` +
            `(Creating a NEW file needs no prior read.)`,
        );
      }
      await ensureParent(ctx.fs, path);
      await ctx.fs.writeFile(path, content);
      seen.mark(path);
      ctx.emit({ type: "file_changed", path, op: "write" });
      return ok(`Wrote ${content.length} characters to ${relativeToSandbox(ctx.sandbox, path)}`);
    },
  };
}

// ── edit ────────────────────────────────────────────────────────────────────────────────────────

interface Replacement {
  oldText: string;
  newText: string;
}

/** Some models (pi's comment names Opus 4.6 and GLM-5.1) send `edits` as a JSON string. */
function parseEdits(raw: unknown): Replacement[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("edits must be an array of { oldText, newText }");
    }
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("edits must be a non-empty array of { oldText, newText }");
  }
  return value.map((e, i) => {
    const item = e as Args;
    const oldText = str(item?.oldText);
    const newText = str(item?.newText);
    if (oldText === undefined || newText === undefined) {
      throw new Error(`edits[${i}] must have string oldText and newText`);
    }
    return { oldText, newText };
  });
}

export function editTool(seen: SeenFiles = new SeenFiles()): Tool {
  return {
    tier: "confirm",
    schema: {
      name: "edit",
      description:
        "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
          edits: {
            type: "array",
            description:
              "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
            items: {
              type: "object",
              properties: {
                oldText: {
                  type: "string",
                  description:
                    "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
                },
                newText: { type: "string", description: "Replacement text for this targeted edit." },
              },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
    async run(args, ctx) {
      const path = resolveInSandbox(ctx.sandbox, required(args, "path"));
      const edits = parseEdits(args.edits);
      const stat = await ctx.fs.stat(path);
      if (!stat || stat.kind !== "file") return fail(`File not found: ${relativeToSandbox(ctx.sandbox, path)}`);
      const original = await ctx.fs.readText(path);
      seen.mark(path);

      // Every oldText is located in the ORIGINAL text (pi's rule), so the spans can be checked for
      // uniqueness and overlap before a single byte is written — a half-applied edit is unrecoverable.
      const spans: { start: number; end: number; newText: string }[] = [];
      for (const [i, edit] of edits.entries()) {
        if (edit.oldText === "") return fail(`edits[${i}].oldText is empty — it must be exact text from the file.`);
        const first = original.indexOf(edit.oldText);
        if (first === -1) {
          return fail(`edits[${i}].oldText was not found in ${relativeToSandbox(ctx.sandbox, path)}.`);
        }
        if (original.indexOf(edit.oldText, first + 1) !== -1) {
          return fail(
            `edits[${i}].oldText appears more than once in ${relativeToSandbox(ctx.sandbox, path)} — make it unique by including more surrounding context.`,
          );
        }
        spans.push({ start: first, end: first + edit.oldText.length, newText: edit.newText });
      }
      spans.sort((a, b) => a.start - b.start);
      for (let i = 1; i < spans.length; i++) {
        if (spans[i].start < spans[i - 1].end) {
          return fail("Two edits overlap in the original file — merge them into one edit.");
        }
      }
      let out = "";
      let cursor = 0;
      for (const span of spans) {
        out += original.slice(cursor, span.start) + span.newText;
        cursor = span.end;
      }
      out += original.slice(cursor);
      await ctx.fs.writeFile(path, out);
      ctx.emit({ type: "file_changed", path, op: "write" });
      return ok(`Applied ${spans.length} edit${spans.length === 1 ? "" : "s"} to ${relativeToSandbox(ctx.sandbox, path)}`);
    },
  };
}

// ── ls ──────────────────────────────────────────────────────────────────────────────────────────

export function lsTool(): Tool {
  return {
    tier: "safe",
    schema: {
      name: "ls",
      description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${LS_DEFAULT_LIMIT} entries or ${MAX_OUTPUT_CHARS / 1024}KB (whichever is hit first).`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list (default: current directory)" },
          limit: { type: "number", description: "Maximum number of entries to return (default: 500)" },
        },
      },
    },
    async run(args, ctx) {
      const path = resolveInSandbox(ctx.sandbox, str(args.path));
      if (!(await isDir(ctx.fs, path))) return fail(`Not a directory: ${relativeToSandbox(ctx.sandbox, path)}`);
      const limit = num(args.limit) ?? LS_DEFAULT_LIMIT;
      // pi sorts the NAMES case-insensitively, then decorates directories — copied exactly, because
      // a listing in a different order reads as a different folder to a model comparing two turns.
      const entries = (await ctx.fs.readdir(path))
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
        .map((e) => (e.kind === "dir" ? `${e.name}/` : e.name));
      const shown = entries.slice(0, limit);
      const body = shown.join("\n");
      if (entries.length > shown.length) {
        return ok(`${body}\n\n[Showing ${shown.length} of ${entries.length} entries. Raise limit to see more.]`);
      }
      return ok(body || "(empty directory)");
    },
  };
}

// ── grep ────────────────────────────────────────────────────────────────────────────────────────

export function grepTool(): Tool {
  return {
    tier: "safe",
    schema: {
      name: "grep",
      description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Output is truncated to ${GREP_DEFAULT_LIMIT} matches or ${MAX_OUTPUT_CHARS / 1024}KB (whichever is hit first). Long lines are truncated to ${500} chars.`,
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern (regex or literal string)" },
          path: { type: "string", description: "Directory or file to search (default: current directory)" },
          glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
          ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
          literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" },
          context: { type: "number", description: "Number of lines to show before and after each match (default: 0)" },
          limit: { type: "number", description: "Maximum number of matches to return (default: 100)" },
        },
        required: ["pattern"],
      },
    },
    async run(args, ctx) {
      const pattern = required(args, "pattern");
      const root = resolveInSandbox(ctx.sandbox, str(args.path));
      const limit = num(args.limit) ?? GREP_DEFAULT_LIMIT;
      const contextLines = Math.max(0, num(args.context) ?? 0);
      const flags = bool(args.ignoreCase) ? "i" : "";
      let re: RegExp;
      try {
        re = bool(args.literal)
          ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
          : new RegExp(pattern, flags);
      } catch (err) {
        return fail(`Invalid pattern: ${(err as Error).message}`);
      }
      const globRe = str(args.glob) ? globToRegExp(str(args.glob)!) : null;

      const files = (await isDir(ctx.fs, root)) ? await walkFiles(ctx.fs, root) : [""];
      const out: string[] = [];
      let matches = 0;
      for (const rel of files) {
        if (ctx.signal.aborted) break;
        if (globRe && rel && !globRe.test(rel)) continue;
        const full = rel ? `${root}/${rel}` : root;
        let text: string;
        try {
          text = await ctx.fs.readText(full);
        } catch {
          continue; // binary or unreadable — grep skips, it does not fail
        }
        const lines = text.split("\n");
        const shownPath = relativeToSandbox(ctx.sandbox, full);
        for (let i = 0; i < lines.length && matches < limit; i++) {
          if (!re.test(lines[i])) continue;
          re.lastIndex = 0;
          matches++;
          const from = Math.max(0, i - contextLines);
          const to = Math.min(lines.length - 1, i + contextLines);
          for (let j = from; j <= to; j++) {
            out.push(`${shownPath}:${j + 1}${j === i ? ":" : "-"}${truncateLine(lines[j])}`);
          }
        }
        if (matches >= limit) break;
      }
      if (!out.length) return ok("No matches found.");
      const body = out.join("\n");
      return ok(matches >= limit ? `${body}\n\n[Reached the ${limit}-match limit. Narrow the pattern or raise limit.]` : body);
    },
  };
}

// ── find ────────────────────────────────────────────────────────────────────────────────────────

export function findTool(): Tool {
  return {
    tier: "safe",
    schema: {
      name: "find",
      description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Output is truncated to ${FIND_DEFAULT_LIMIT} results or ${MAX_OUTPUT_CHARS / 1024}KB (whichever is hit first).`,
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
          },
          path: { type: "string", description: "Directory to search in (default: current directory)" },
          limit: { type: "number", description: "Maximum number of results (default: 1000)" },
        },
        required: ["pattern"],
      },
    },
    async run(args, ctx) {
      const pattern = required(args, "pattern");
      const root = resolveInSandbox(ctx.sandbox, str(args.path));
      if (!(await isDir(ctx.fs, root))) return fail(`Not a directory: ${relativeToSandbox(ctx.sandbox, root)}`);
      const limit = num(args.limit) ?? FIND_DEFAULT_LIMIT;
      const re = globToRegExp(pattern);
      const hits = (await walkFiles(ctx.fs, root)).filter((p) => re.test(p));
      const shown = hits.slice(0, limit);
      if (!shown.length) return ok("No files found.");
      const body = shown.join("\n");
      return ok(
        hits.length > shown.length
          ? `${body}\n\n[Showing ${shown.length} of ${hits.length} results. Raise limit to see more.]`
          : body,
      );
    },
  };
}

// ── read_public (light agent only) ──────────────────────────────────────────────────────────────

/**
 * The ONE bridge from the operator's private workspace to an untrusted conversation
 * (docs/agent-layout.md, "Trust & isolation"). Named, capped and read-only exactly as the engine's
 * `buildReadPublicTool` — including the 20 000-character cap, so an operator who drops a large file
 * into `public/` gets the same answer on both hosts.
 */
export function readPublicTool(publicDir = "workspace/public"): Tool {
  return {
    tier: "safe",
    schema: {
      name: "read_public",
      description:
        "Read a file from the agent's PUBLIC folder (safe to share with outside people). Read-only.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path within the public folder." } },
        required: ["path"],
      },
    },
    async run(args, ctx) {
      let path: string;
      try {
        path = resolveInSandbox(publicDir, required(args, "path"));
      } catch {
        return fail("Path is outside the public folder.");
      }
      const stat = await ctx.fs.stat(path);
      if (!stat || stat.kind !== "file") return fail("File not found in public folder.");
      const text = await ctx.fs.readText(path);
      return ok(text.slice(0, PUBLIC_READ_MAX_CHARS));
    },
  };
}
