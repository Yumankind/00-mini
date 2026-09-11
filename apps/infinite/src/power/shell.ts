/**
 * `BuiltinShell` — the browser tab's own shell, over `AgentFs`.
 *
 * WHY A HAND-WRITTEN INTERPRETER AND NOT A WASM COREUTILS. §12.4 of the plan has never chosen a WASM
 * shell, and the two candidates both cost megabytes and, worse, a SECOND filesystem: busybox-wasm
 * wants its own memfs, so `ls` would list files the agent's tools cannot see and a `>` would write
 * bytes that never reach OPFS. The whole value of a terminal here is that it is the SAME filesystem
 * the agent reads and the same path guard the tools use — `resolveInSandbox`, imported, not
 * re-implemented. That is worth more than a complete coreutils, so this is a small POSIX-flavoured
 * interpreter over the twenty-odd commands people actually type at a file tree, and everything it
 * cannot do it REFUSES BY NAME (`node`, `npm`, `curl`, `git push`) instead of pretending.
 *
 * THE SANDBOX IS THE ROOT. `run()` is handed a cwd by the runtime (`ctx.sandbox`, i.e. `workspace`),
 * and inside this shell that folder IS `/`. `pwd` at the top prints `/`, `cd ..` there is a refusal
 * rather than a climb, and a leading slash means sandbox-absolute, never agent-root-absolute — a
 * person typing `/etc/passwd` gets "no such file", not a peek at `vault.json`. Every path argument,
 * every glob expansion and every redirect target goes through `resolve()`, which is four lines
 * around the guard the tools share.
 *
 * NO PROCESSES. A pipeline is a string handed from one async function to the next; `>` collects the
 * left side's stdout and writes it once. That is a real limitation (nothing streams, `tail -f` does
 * not exist, a `yes | head` would never end) and it is why there is a hard output cap per command:
 * a runaway `find /` in a browser tab has no OOM killer to save the page.
 */
import type { AgentFs, FsEntry } from "@00/agent-fs";
import type { NetworkPolicy, Shell, ShellResult, ShellRunOptions } from "@00/agent-runtime";
import { PathEscapeError, globToRegExp, normalizeSandbox, resolveInSandbox } from "@00/agent-runtime";
import {
  DEFAULT_REGISTRY,
  RegistryClient,
  install,
  npmLs,
  npmRunPlan,
  rewriteBinArgv,
  type FetchLike,
  type InstallResult,
  type WorkerFactory,
} from "@00/agent-node";
import { NO_PACKAGES_LINE, runScript } from "./js-runner.js";
import { DEFAULT_SERVE_PORT, PortInUseError, listPorts, portUrl, serveFolder, unregister } from "./virtual-ports.js";

// ── What the shell answers with ───────────────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * The git this shell delegates to — `@00/agent-fs`'s helpers, bound to one filesystem.
 *
 * It is an INTERFACE and not an import because half of it does not exist on every build: `diff`,
 * `branches` and `checkout` are being added to the package by another hand, and a shell that
 * imported them by name would fail to build the day it was ahead of the package. Absent members
 * answer with their own sentence (`git diff` says it can only name files yet), which is the same
 * rule the remote refusals follow.
 */
export interface ShellGit {
  init(dir: string): Promise<void>;
  status(dir: string): Promise<{ path: string; status: string; staged: boolean }[]>;
  log(dir: string, depth: number): Promise<{ oid: string; message: string; timestamp: number; author: string }[]>;
  add(dir: string, paths: string[]): Promise<void>;
  commit(dir: string, message: string): Promise<string>;
  /** `git diff --name-only`, always available — the honest floor. */
  diffNames(dir: string): Promise<string[]>;
  /** A real unified diff, when the package has one. */
  diff?(dir: string, path?: string, opts?: { staged?: boolean }): Promise<string>;
  branches?(dir: string): Promise<{ current: string | null; branches: string[] }>;
  checkout?(dir: string, ref: string, opts?: { create?: boolean }): Promise<void>;
  /**
   * The four that leave this computer (§14). Optional for the same reason the three above are: a
   * build whose backend has no road out still has a `git`, and every one of them answers with the
   * package's own sentence rather than being missing. They return the line to print.
   */
  clone?(url: string, dir: string): Promise<string>;
  push?(dir: string, remote?: string, branch?: string): Promise<string>;
  pull?(dir: string, remote?: string, branch?: string): Promise<string>;
  fetch?(dir: string, remote?: string, branch?: string): Promise<string>;
}

export interface BuiltinShellOptions {
  git?: ShellGit | null;
  /** Injectable so `date` is testable. */
  now?: () => Date;
  /** Extra environment on top of the built-in four. */
  env?: Record<string, string>;
  /** Per-command output cap; a browser tab has no OOM killer. */
  maxOutputChars?: number;
  /**
   * How `node` gets its Worker. The browser passes nothing (a module Worker built by vite from
   * src/power/node-runtime-worker.ts); a node test passes `createInlineNodeWorker`, which runs the
   * SAME worker code in-process.
   */
  createWorker?: WorkerFactory;
  /** Wall clock for one `node` run; a server is exempt while its port is registered. */
  scriptTimeoutMs?: number;
  /** The hosts a script may reach with `fetch`. Absent = the empty list, and every call refuses. */
  network?: NetworkPolicy | null;
  /** The registry `npm install` talks to, and the fetch it talks with. Both injectable for tests. */
  npm?: { registry?: string; fetch?: FetchLike };
}

/**
 * Where a running command's output goes WHILE it runs.
 *
 * THE RULE, once: anything handed to this sink is NOT also in the `ExecResult` the call returns. A
 * terminal that passes one prints chunks as they arrive (`src/state/terminal.ts`); an agent's `bash`
 * passes none and gets the two strings it always got, which is what a tool result is. Only the
 * commands that have a process behind them stream — `node`, `npm install`, `npm run`, `npx` — and
 * only when their stdout is not being piped or redirected somewhere else.
 */
export type OutputSink = (chunk: { stream: "stdout" | "stderr"; text: string }) => void;

/** The two streams of one command, going either to the terminal as they happen or into the result. */
class Out {
  stdout = "";
  stderr = "";
  constructor(private readonly live?: OutputSink) {}
  write(stream: "stdout" | "stderr", text: string): void {
    if (!text) return;
    if (this.live) {
      this.live({ stream, text });
      return;
    }
    if (stream === "stdout") this.stdout += text;
    else this.stderr += text;
  }
  done(exitCode: number): ExecResult {
    return { stdout: this.stdout, stderr: this.stderr, exitCode };
  }
}

/**
 * Where `git clone <url>` puts the working tree when the command names no folder.
 *
 * git's own rule: the last path segment of the URL, minus `.git`. Written here rather than taken
 * from the package because the shell is the only place a MISSING argument has to be invented — the
 * ops object always receives a folder.
 */
export function defaultCloneDir(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  const last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return last.replace(/\.git$/, "") || "repo";
}

/** The line every "not in a browser" refusal ends with, so the model repeats one sentence, not five. */
export const NO_NODE_LINE = "this browser has no Node; run it on your Mac";
/**
 * Reaching a git host from a page needs a proxy, and §14 chose one: the 00 engine on this same
 * computer, in companion mode. This is what `git clone/push/pull/fetch` says while it is not there —
 * the same sentence @00/agent-fs's `GitRemoteUnavailableError` carries, so the shell, the tool and
 * the panel all say one thing.
 */
export const GIT_REMOTE_LINE =
  "connect this computer (Connections → This computer) — nothing was sent";

/**
 * The ones that stay refused. `node`, `npm` and `npx` LEFT this set when the runner arrived
 * (src/power/js-runner.ts), and `npm install` left it when `@00/agent-node`'s npm client did: this
 * tab now fetches from registry.npmjs.org itself. What is still here needs a real toolchain — a
 * bundler is a build, and the three other package managers are three more lockfile dialects for a
 * runtime that has exactly one client. The sentence says which one.
 */
const OTHER_CLIENT_LINE =
  "npm is the one package client in this tab (it installs pure-JS packages straight from " +
  "registry.npmjs.org) — use `npm install`, or run this on your Mac";
const NODE_FAMILY = new Set(["tsc", "vite", "webpack", "esbuild"]);
const PACKAGE_CLIENTS = new Set(["pnpm", "yarn", "bun", "deno"]);
const OTHER_BINARIES: Record<string, string> = {
  python: "this browser has no Python; run it on your Mac (Pyodide is a later phase)",
  python3: "this browser has no Python; run it on your Mac (Pyodide is a later phase)",
  pip: "this browser has no Python; run it on your Mac (Pyodide is a later phase)",
  curl: "this browser can only fetch same-origin and CORS-open URLs; run curl on your Mac",
  wget: "this browser can only fetch same-origin and CORS-open URLs; run wget on your Mac",
  ssh: "this browser has no SSH; run it on your Mac",
  scp: "this browser has no SSH; run it on your Mac",
  docker: "this browser has no container runtime; run it on your Mac or a cloud computer",
  make: "this browser has no build toolchain; run it on your Mac",
  sudo: "there is nothing to escalate to — this shell only ever sees your agent's own folder",
};

const DEFAULT_MAX_OUTPUT = 200_000;
const EXIT_NOT_FOUND = 127;
/** `npm run a` whose script is `npm run b` is fine; a ring of them is not. */
const MAX_SCRIPT_DEPTH = 4;
/** The sandbox `serve` and the virtual routes agree on — the same root `/` means in this shell. */
const WORKSPACE_ROOT = "workspace";

// ── Lexing ────────────────────────────────────────────────────────────────────────────────────────

export type Token =
  | { kind: "word"; text: string; quoted: boolean }
  | { kind: "op"; op: "|" | "||" | "&&" | ";" | ">" | ">>" | "<" };

/**
 * Quotes, escapes and operators. Single quotes are literal; double quotes keep `$` expansion and
 * `\` escapes; an unquoted `\` escapes the next character. `quoted` travels with the word because it
 * is what stops `"*.md"` from globbing — the one place quoting changes meaning after the split.
 */
export function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let text = "";
  let has = false;
  let quoted = false;

  const flush = (): void => {
    if (has) out.push({ kind: "word", text, quoted });
    text = "";
    has = false;
    quoted = false;
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === "'" || c === '"') {
      const close = c;
      has = true;
      quoted = true;
      i++;
      for (; i < input.length && input[i] !== close; i++) {
        if (close === '"' && input[i] === "\\" && i + 1 < input.length) {
          const next = input[i + 1]!;
          // Inside double quotes a backslash only escapes the four characters it can hide.
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            text += next;
            i++;
            continue;
          }
        }
        text += input[i];
      }
      continue;
    }
    if (c === "\\" && i + 1 < input.length) {
      has = true;
      quoted = true;
      text += input[++i];
      continue;
    }
    if (c === " " || c === "\t" || c === "\n") {
      flush();
      continue;
    }
    if (c === "#" && !has) break; // a comment runs to the end of the line
    if (c === "|" || c === "&" || c === ";" || c === ">" || c === "<") {
      flush();
      if ((c === "|" || c === "&") && input[i + 1] === c) {
        out.push({ kind: "op", op: c === "|" ? "||" : "&&" });
        i++;
        continue;
      }
      if (c === "&") {
        // A single `&` would be a background job, and there are no jobs here.
        out.push({ kind: "op", op: ";" });
        continue;
      }
      if (c === ">" && input[i + 1] === ">") {
        out.push({ kind: "op", op: ">>" });
        i++;
        continue;
      }
      out.push({ kind: "op", op: c as ">" | "<" | "|" | ";" });
      continue;
    }
    has = true;
    text += c;
  }
  flush();
  return out;
}

// ── Parsing ───────────────────────────────────────────────────────────────────────────────────────

export interface Redirect {
  op: ">" | ">>" | "<";
  target: string;
}

export interface ParsedCommand {
  words: { text: string; quoted: boolean }[];
  redirects: Redirect[];
}

export interface ParsedStage {
  /** One or more commands joined by `|`. */
  pipeline: ParsedCommand[];
  /** How this stage is reached from the one before it. */
  connector: ";" | "&&" | "||";
}

export class ShellSyntaxError extends Error {}

export function parse(tokens: Token[]): ParsedStage[] {
  const stages: ParsedStage[] = [];
  let connector: ";" | "&&" | "||" = ";";
  let pipeline: ParsedCommand[] = [];
  let current: ParsedCommand = { words: [], redirects: [] };

  const endCommand = (): void => {
    if (current.words.length || current.redirects.length) pipeline.push(current);
    current = { words: [], redirects: [] };
  };
  const endStage = (next: ";" | "&&" | "||"): void => {
    endCommand();
    if (pipeline.length) stages.push({ pipeline, connector });
    pipeline = [];
    connector = next;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "word") {
      current.words.push({ text: t.text, quoted: t.quoted });
      continue;
    }
    if (t.op === ">" || t.op === ">>" || t.op === "<") {
      const target = tokens[i + 1];
      if (!target || target.kind !== "word") throw new ShellSyntaxError(`syntax error near \`${t.op}\``);
      current.redirects.push({ op: t.op, target: target.text });
      i++;
      continue;
    }
    if (t.op === "|") {
      endCommand();
      if (!pipeline.length) throw new ShellSyntaxError("syntax error near `|`");
      continue;
    }
    endStage(t.op);
  }
  endStage(";");
  return stages;
}

// ── The shell ─────────────────────────────────────────────────────────────────────────────────────

interface CommandContext {
  argv: string[];
  stdin: string;
  signal?: AbortSignal;
  /** Present only when THIS command's output may go straight to the terminal — see `OutputSink`. */
  stream?: OutputSink;
}

type Builtin = (ctx: CommandContext) => Promise<ExecResult>;

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
const bad = (stderr: string, exitCode = 1): ExecResult => ({ stdout: "", stderr: `${stderr}\n`, exitCode });

function lines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\n$/, "").split("\n");
}

export class BuiltinShell implements Shell {
  readonly available = true;
  /** §4.2's terminal row, named for what it is. The prompt text says this word to the model. */
  readonly label = "browser shell";

  private readonly fs: AgentFs;
  private readonly git: ShellGit | null;
  private readonly now: () => Date;
  private readonly maxOutput: number;
  /** Not readonly: `npm run` puts npm's own `npm_package_*` in front of it for the length of a script. */
  private env: Record<string, string>;
  private readonly createWorker?: WorkerFactory;
  private readonly scriptTimeoutMs?: number;
  private readonly network: NetworkPolicy | null;
  private readonly npmRegistry: string;
  private readonly npmFetch?: FetchLike;
  /** `npm run` runs a line through this same shell; a script that calls itself must not spin. */
  private scriptDepth = 0;
  /** The sandbox root, agent-root-relative (`workspace`). */
  private root = "workspace";
  /** Where we are INSIDE the root, `""` at the top. */
  private rel = "";
  private previous = "";
  private readonly builtins: Record<string, Builtin>;

  constructor(fs: AgentFs, opts: BuiltinShellOptions = {}) {
    this.fs = fs;
    this.git = opts.git ?? null;
    this.now = opts.now ?? (() => new Date());
    this.maxOutput = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    this.createWorker = opts.createWorker;
    this.scriptTimeoutMs = opts.scriptTimeoutMs;
    this.network = opts.network ?? null;
    this.npmRegistry = opts.npm?.registry ?? DEFAULT_REGISTRY;
    this.npmFetch = opts.npm?.fetch;
    this.env = { SHELL: "browser shell", HOME: "/", PWD: "/", TERM: "00-infinite", ...(opts.env ?? {}) };
    this.builtins = this.table();
  }

  /** The prompt's own text: where we are, sandbox-relative, with `/` for the top. */
  get cwd(): string {
    return this.rel ? `/${this.rel}` : "/";
  }

  /** Every name this shell answers to — `help`, `which` and the terminal's completion all read it. */
  get commands(): string[] {
    return Object.keys(this.builtins).sort();
  }

  /** The runtime's `Shell`: one string back, because that is what a tool result is. */
  async run(command: string, opts: ShellRunOptions): Promise<ShellResult> {
    const result = await this.exec(command, opts);
    const output = [result.stdout, result.stderr].filter((s) => s.length).join("");
    return { output: output || (result.exitCode === 0 ? "" : `exit ${result.exitCode}`), exitCode: result.exitCode };
  }

  /**
   * What the terminal pane calls: the two streams kept apart, so stderr can be red.
   * `cwd` re-roots the shell when it changes; the working directory itself survives between calls,
   * which is the whole reason a terminal feels like a terminal.
   *
   * `onOutput` is how a terminal sees a long command as it runs rather than when it ends; what goes
   * to it does not come back in the result (see `OutputSink`).
   */
  async exec(command: string, opts: Partial<ShellRunOptions> & { onOutput?: OutputSink } = {}): Promise<ExecResult> {
    if (opts.cwd) {
      const root = normalizeSandbox(opts.cwd);
      if (root !== this.root) {
        this.root = root;
        this.rel = "";
        this.previous = "";
      }
    }
    let stages: ParsedStage[];
    try {
      stages = parse(tokenize(command));
    } catch (err) {
      return bad(err instanceof Error ? err.message : String(err), 2);
    }
    if (!stages.length) return ok();

    let stdout = "";
    let stderr = "";
    let code = 0;
    for (const stage of stages) {
      if (stage.connector === "&&" && code !== 0) continue;
      if (stage.connector === "||" && code === 0) continue;
      const result = await this.runPipeline(stage.pipeline, opts.signal, opts.onOutput);
      // WITH A SINK, EVERYTHING GOES THROUGH IT — including the stages that had no process to
      // stream. Otherwise `ls && npm run build` would print the build's live lines first and the
      // `ls` afterwards, because one road prints as it goes and the other hands back a string.
      if (opts.onOutput) {
        if (result.stdout) opts.onOutput({ stream: "stdout", text: result.stdout });
        if (result.stderr) opts.onOutput({ stream: "stderr", text: result.stderr });
      } else {
        stdout += result.stdout;
        stderr += result.stderr;
      }
      code = result.exitCode;
      if (opts.signal?.aborted) {
        stderr += "aborted\n";
        return { stdout: this.cap(stdout), stderr: this.cap(stderr), exitCode: 130 };
      }
    }
    this.env.PWD = this.cwd;
    return { stdout: this.cap(stdout), stderr: this.cap(stderr), exitCode: code };
  }

  private cap(text: string): string {
    if (text.length <= this.maxOutput) return text;
    return `${text.slice(0, this.maxOutput)}\n… truncated at ${this.maxOutput.toLocaleString()} characters.\n`;
  }

  private async runPipeline(pipeline: ParsedCommand[], signal?: AbortSignal, onOutput?: OutputSink): Promise<ExecResult> {
    let carried = "";
    let stderr = "";
    let code = 0;
    for (const [at, command] of pipeline.entries()) {
      let argv: string[];
      try {
        argv = await this.expand(command.words);
      } catch (err) {
        return { stdout: "", stderr: `${this.message(err)}\n`, exitCode: 1 };
      }
      if (!argv.length) continue;

      let stdin = carried;
      const input = command.redirects.find((r) => r.op === "<");
      if (input) {
        try {
          stdin = await this.fs.readText(this.resolve(input.target));
        } catch (err) {
          return { stdout: "", stderr: `${argv[0]}: ${this.message(err)}\n`, exitCode: 1 };
        }
      }

      // Only the last command of a pipeline may stream, and only when its stdout is not on its way
      // into a file: everything else has a reader that needs the string.
      const streams =
        onOutput && at === pipeline.length - 1 && !command.redirects.some((r) => r.op === ">" || r.op === ">>");
      const ctx: CommandContext = { argv, stdin, signal, stream: streams ? onOutput : undefined };

      const run = this.builtins[argv[0]!];
      let result: ExecResult;
      if (run) {
        try {
          result = await run(ctx);
        } catch (err) {
          result = bad(`${argv[0]}: ${this.message(err)}`);
        }
      } else {
        result = await this.runUnknown(ctx);
      }

      stderr += result.stderr;
      code = result.exitCode;
      carried = result.stdout;

      const write = command.redirects.find((r) => r.op === ">" || r.op === ">>");
      if (write) {
        try {
          await this.writeRedirect(write, carried);
          carried = "";
        } catch (err) {
          return { stdout: "", stderr: `${stderr}${argv[0]}: ${this.message(err)}\n`, exitCode: 1 };
        }
      }
    }
    return { stdout: carried, stderr, exitCode: code };
  }

  private async writeRedirect(redirect: Redirect, text: string): Promise<void> {
    const path = this.resolve(redirect.target);
    if (redirect.op === ">>") {
      const before = (await this.fs.stat(path)) ? await this.fs.readText(path) : "";
      await this.fs.writeFile(path, before + text);
      return;
    }
    await this.fs.writeFile(path, text);
  }

  /** A command this host cannot run, said by name — never "command not found" for a real binary. */
  private refuse(name: string): ExecResult {
    if (PACKAGE_CLIENTS.has(name)) return bad(`${name}: ${OTHER_CLIENT_LINE}`, EXIT_NOT_FOUND);
    if (NODE_FAMILY.has(name)) return bad(`${name}: ${NO_NODE_LINE}`, EXIT_NOT_FOUND);
    const other = OTHER_BINARIES[name];
    if (other) return bad(`${name}: ${other}`, EXIT_NOT_FOUND);
    return bad(`${name}: command not found`, EXIT_NOT_FOUND);
  }

  /**
   * A name this shell has no builtin for: the PATH substitute, then the refusal.
   *
   * `node_modules/.bin` is what npm puts on a script's PATH, and there is no PATH here — so
   * `rewriteBinArgv` (@00/agent-node) turns `tool --flag` into `node <cwd>/node_modules/.bin/tool
   * --flag` when a shim of that name is installed, and leaves it alone when none is. The refusals
   * come FIRST: a person who typed `vite` after installing it should read why a bundler needs their
   * Mac rather than watch this runtime try.
   */
  private async runUnknown(ctx: CommandContext): Promise<ExecResult> {
    const name = ctx.argv[0]!;
    if (PACKAGE_CLIENTS.has(name) || NODE_FAMILY.has(name) || OTHER_BINARIES[name]) return this.refuse(name);
    const rewritten = await this.binArgv(ctx.argv);
    if (!rewritten) return this.refuse(name);
    return await this.runNode({ entry: rewritten.entry, argv: rewritten.args, signal: ctx.signal, stream: ctx.stream });
  }

  /** `["vitest","run"]` → the shim's workspace path and the rest, or `null` when nothing is installed. */
  private async binArgv(argv: string[]): Promise<{ entry: string; args: string[] } | null> {
    const rewritten = await rewriteBinArgv(this.fs, this.dir(), argv, this.root);
    if (!rewritten.bin) return null;
    return { entry: this.display(rewritten.bin), args: rewritten.argv.slice(2) };
  }

  /** Where we are, as an `AgentFs` path — what every `@00/agent-node` npm call takes. */
  private dir(): string {
    return this.rel ? `${this.root}/${this.rel}` : this.root;
  }

  private message(err: unknown): string {
    if (err instanceof PathEscapeError) return `outside your workspace — this shell cannot leave it`;
    return err instanceof Error ? err.message : String(err);
  }

  // ── Paths ───────────────────────────────────────────────────────────────────────────────────────

  /** A word from the command line → an agent-root-relative `AgentFs` path, or a throw. */
  private resolve(p: string): string {
    const raw = p.startsWith("/") ? p.slice(1) : this.rel ? `${this.rel}/${p}` : p;
    return resolveInSandbox(this.root, raw);
  }

  /** The inverse, for output a person reads. */
  private display(full: string): string {
    if (full === this.root) return "/";
    return full.startsWith(`${this.root}/`) ? `/${full.slice(this.root.length + 1)}` : full;
  }

  // ── Expansion ───────────────────────────────────────────────────────────────────────────────────

  private expandEnv(text: string): string {
    return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, braced, bare) => {
      const key = (braced ?? bare) as string;
      if (key === "PWD") return this.cwd;
      return this.env[key] ?? "";
    });
  }

  /**
   * Globs, ONE LEVEL: the pattern lives in the last segment (`*.md`, `src/*.ts`), which is what a
   * person types at a file tree. `**` is left to `find`, whose whole job it is. A pattern that
   * matches nothing stays literal, exactly as POSIX says, so `grep x *.md` in an empty folder
   * reports "no such file" rather than silently grepping stdin.
   */
  private async glob(pattern: string): Promise<string[]> {
    const slash = pattern.lastIndexOf("/");
    const dirPart = slash === -1 ? "" : pattern.slice(0, slash);
    const namePart = slash === -1 ? pattern : pattern.slice(slash + 1);
    if (!/[*?[]/.test(namePart) || /[*?[]/.test(dirPart)) return [pattern];
    let entries: FsEntry[];
    try {
      entries = await this.fs.readdir(this.resolve(dirPart || "."));
    } catch {
      return [pattern];
    }
    const re = globToRegExp(namePart, { matchBasename: false });
    const hits = entries
      .map((e) => e.name)
      .filter((name) => re.test(name) && (namePart.startsWith(".") || !name.startsWith(".")))
      .sort()
      .map((name) => (dirPart ? `${dirPart}/${name}` : name));
    return hits.length ? hits : [pattern];
  }

  private async expand(words: { text: string; quoted: boolean }[]): Promise<string[]> {
    const out: string[] = [];
    for (const word of words) {
      if (word.quoted) {
        out.push(this.expandEnv(word.text));
        continue;
      }
      const expanded = this.expandEnv(word.text);
      out.push(...(await this.glob(expanded)));
    }
    return out;
  }

  // ── Reading arguments ───────────────────────────────────────────────────────────────────────────

  /** Split argv into flags (`-la` → `l`,`a`) and operands, stopping at `--`. */
  private static split(argv: string[]): { flags: Set<string>; values: Map<string, string>; rest: string[] } {
    const flags = new Set<string>();
    const values = new Map<string, string>();
    const rest: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--") {
        rest.push(...argv.slice(i + 1));
        break;
      }
      if (a.length > 1 && a.startsWith("-") && !/^-\d/.test(a)) {
        if (a.startsWith("--")) {
          flags.add(a.slice(2));
          continue;
        }
        for (const ch of a.slice(1)) flags.add(ch);
        // `-n 5` and `-d ,` take the next word; the callers that care ask `values` for it.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) values.set(a.slice(-1), next);
        continue;
      }
      rest.push(a);
    }
    return { flags, values, rest };
  }

  /** Operands minus the ones that were consumed as a flag's value. */
  private static operands(argv: string[], consumed: string[]): string[] {
    const { rest } = BuiltinShell.split(argv);
    const drop = new Set(consumed);
    return rest.filter((r) => !drop.has(r));
  }

  private async textOf(paths: string[], stdin: string, who: string): Promise<{ text: string; error: string }> {
    if (!paths.length) return { text: stdin, error: "" };
    let text = "";
    let error = "";
    for (const p of paths) {
      try {
        const full = this.resolve(p);
        const stat = await this.fs.stat(full);
        if (!stat) throw new Error(`${p}: No such file or directory`);
        if (stat.kind === "dir") throw new Error(`${p}: Is a directory`);
        text += await this.fs.readText(full);
      } catch (err) {
        error += `${who}: ${this.message(err)}\n`;
      }
    }
    return { text, error };
  }

  // ── The commands ────────────────────────────────────────────────────────────────────────────────

  private table(): Record<string, Builtin> {
    const fs = this.fs;

    return {
      pwd: async () => ok(`${this.cwd}\n`),

      cd: async ({ argv }) => {
        const target = argv[1] ?? "/";
        if (target === "-") {
          const back = this.previous;
          this.previous = this.rel;
          this.rel = back;
          return ok(`${this.cwd}\n`);
        }
        let full: string;
        try {
          full = this.resolve(target);
        } catch (err) {
          return bad(`cd: ${this.message(err)}`);
        }
        const stat = await fs.stat(full);
        // The sandbox root itself may have no `stat` on an adapter that only tracks files.
        if (!stat && full !== this.root) return bad(`cd: ${target}: No such file or directory`);
        if (stat && stat.kind !== "dir") return bad(`cd: ${target}: Not a directory`);
        this.previous = this.rel;
        this.rel = full === this.root ? "" : full.slice(this.root.length + 1);
        return ok();
      },

      ls: async ({ argv }) => {
        const { flags } = BuiltinShell.split(argv);
        const paths = BuiltinShell.operands(argv, []);
        const targets = paths.length ? paths : ["."];
        let stdout = "";
        let stderr = "";
        let code = 0;
        for (const target of targets) {
          let full: string;
          try {
            full = this.resolve(target);
          } catch (err) {
            stderr += `ls: ${this.message(err)}\n`;
            code = 1;
            continue;
          }
          const stat = await fs.stat(full);
          if (!stat && full !== this.root) {
            stderr += `ls: ${target}: No such file or directory\n`;
            code = 1;
            continue;
          }
          if (stat?.kind === "file") {
            stdout += flags.has("l") ? `${lsLong({ name: target, ...stat })}\n` : `${target}\n`;
            continue;
          }
          let entries = await fs.readdir(full);
          if (!flags.has("a")) entries = entries.filter((e) => !e.name.startsWith("."));
          entries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
          if (targets.length > 1) stdout += `${target}:\n`;
          for (const e of entries) {
            stdout += flags.has("l") ? `${lsLong(e)}\n` : `${e.name}${e.kind === "dir" ? "/" : ""}\n`;
          }
          if (targets.length > 1) stdout += "\n";
        }
        return { stdout, stderr, exitCode: code };
      },

      cat: async ({ argv, stdin }) => {
        const { text, error } = await this.textOf(BuiltinShell.operands(argv, []), stdin, "cat");
        return { stdout: text, stderr: error, exitCode: error ? 1 : 0 };
      },

      echo: async ({ argv }) => {
        const noNewline = argv[1] === "-n";
        const words = argv.slice(noNewline ? 2 : 1);
        return ok(`${words.join(" ")}${noNewline ? "" : "\n"}`);
      },

      mkdir: async ({ argv }) => {
        const { flags } = BuiltinShell.split(argv);
        const paths = BuiltinShell.operands(argv, []);
        if (!paths.length) return bad("mkdir: missing operand");
        let stderr = "";
        for (const p of paths) {
          try {
            const full = this.resolve(p);
            if ((await fs.stat(full)) && !flags.has("p")) {
              stderr += `mkdir: ${p}: File exists\n`;
              continue;
            }
            await fs.mkdir(full);
          } catch (err) {
            stderr += `mkdir: ${this.message(err)}\n`;
          }
        }
        return { stdout: "", stderr, exitCode: stderr ? 1 : 0 };
      },

      rm: async ({ argv }) => {
        const { flags } = BuiltinShell.split(argv);
        const paths = BuiltinShell.operands(argv, []);
        if (!paths.length && !flags.has("f")) return bad("rm: missing operand");
        let stderr = "";
        for (const p of paths) {
          try {
            const full = this.resolve(p);
            const stat = await fs.stat(full);
            if (!stat) {
              if (!flags.has("f")) stderr += `rm: ${p}: No such file or directory\n`;
              continue;
            }
            if (stat.kind === "dir" && !(flags.has("r") || flags.has("R"))) {
              stderr += `rm: ${p}: is a directory (use -r)\n`;
              continue;
            }
            await fs.remove(full);
          } catch (err) {
            stderr += `rm: ${this.message(err)}\n`;
          }
        }
        return { stdout: "", stderr, exitCode: stderr ? 1 : 0 };
      },

      mv: async ({ argv }) => {
        const paths = BuiltinShell.operands(argv, []);
        if (paths.length < 2) return bad("mv: usage: mv SOURCE… DEST");
        const dest = paths[paths.length - 1]!;
        const sources = paths.slice(0, -1);
        const destStat = await fs.stat(this.resolve(dest)).catch(() => null);
        if (sources.length > 1 && destStat?.kind !== "dir") return bad(`mv: ${dest}: Not a directory`);
        let stderr = "";
        for (const source of sources) {
          try {
            const from = this.resolve(source);
            if (!(await fs.stat(from))) {
              stderr += `mv: ${source}: No such file or directory\n`;
              continue;
            }
            const base = source.slice(source.lastIndexOf("/") + 1);
            const to = destStat?.kind === "dir" ? this.resolve(`${dest}/${base}`) : this.resolve(dest);
            await fs.rename(from, to);
          } catch (err) {
            stderr += `mv: ${this.message(err)}\n`;
          }
        }
        return { stdout: "", stderr, exitCode: stderr ? 1 : 0 };
      },

      cp: async ({ argv }) => {
        const { flags } = BuiltinShell.split(argv);
        const paths = BuiltinShell.operands(argv, []);
        if (paths.length < 2) return bad("cp: usage: cp [-r] SOURCE… DEST");
        const dest = paths[paths.length - 1]!;
        const sources = paths.slice(0, -1);
        const destStat = await fs.stat(this.resolve(dest)).catch(() => null);
        let stderr = "";
        for (const source of sources) {
          try {
            const from = this.resolve(source);
            const stat = await fs.stat(from);
            if (!stat) {
              stderr += `cp: ${source}: No such file or directory\n`;
              continue;
            }
            const base = source.slice(source.lastIndexOf("/") + 1);
            const toBase = destStat?.kind === "dir" ? `${dest}/${base}` : dest;
            if (stat.kind === "dir") {
              if (!(flags.has("r") || flags.has("R"))) {
                stderr += `cp: ${source}: is a directory (use -r)\n`;
                continue;
              }
              for await (const entry of fs.walk(from)) {
                const tail = entry.path.slice(from.length + 1);
                await fs.writeFile(this.resolve(`${toBase}/${tail}`), await fs.readFile(entry.path));
              }
              continue;
            }
            await fs.writeFile(this.resolve(toBase), await fs.readFile(from));
          } catch (err) {
            stderr += `cp: ${this.message(err)}\n`;
          }
        }
        return { stdout: "", stderr, exitCode: stderr ? 1 : 0 };
      },

      touch: async ({ argv }) => {
        const paths = BuiltinShell.operands(argv, []);
        if (!paths.length) return bad("touch: missing operand");
        let stderr = "";
        for (const p of paths) {
          try {
            const full = this.resolve(p);
            const stat = await fs.stat(full);
            // Rewriting the same bytes is what bumps an mtime on a filesystem with no utimes.
            await fs.writeFile(full, stat?.kind === "file" ? await fs.readFile(full) : "");
          } catch (err) {
            stderr += `touch: ${this.message(err)}\n`;
          }
        }
        return { stdout: "", stderr, exitCode: stderr ? 1 : 0 };
      },

      head: async ({ argv, stdin }) => this.headTail(argv, stdin, "head"),
      tail: async ({ argv, stdin }) => this.headTail(argv, stdin, "tail"),

      wc: async ({ argv, stdin }) => {
        const { flags } = BuiltinShell.split(argv);
        const paths = BuiltinShell.operands(argv, []);
        const { text, error } = await this.textOf(paths, stdin, "wc");
        const l = lines(text).length;
        const w = text.split(/\s+/).filter(Boolean).length;
        const c = text.length;
        const only = flags.has("l") || flags.has("w") || flags.has("c");
        const parts = only
          ? [flags.has("l") ? l : null, flags.has("w") ? w : null, flags.has("c") ? c : null]
          : [l, w, c];
        const body = parts.filter((n): n is number => n !== null).join(" ");
        return { stdout: `${body}${paths.length === 1 ? ` ${paths[0]}` : ""}\n`, stderr: error, exitCode: error ? 1 : 0 };
      },

      grep: async (ctx) => this.grep(ctx),
      find: async (ctx) => this.find(ctx),

      sort: async ({ argv, stdin }) => {
        const { flags } = BuiltinShell.split(argv);
        const { text, error } = await this.textOf(BuiltinShell.operands(argv, []), stdin, "sort");
        let rows = lines(text);
        rows = flags.has("n")
          ? [...rows].sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b) || a.localeCompare(b))
          : [...rows].sort((a, b) => a.localeCompare(b));
        if (flags.has("r")) rows.reverse();
        if (flags.has("u")) rows = rows.filter((row, i) => i === 0 || row !== rows[i - 1]);
        return { stdout: rows.length ? `${rows.join("\n")}\n` : "", stderr: error, exitCode: error ? 1 : 0 };
      },

      uniq: async ({ argv, stdin }) => {
        const { flags } = BuiltinShell.split(argv);
        const { text, error } = await this.textOf(BuiltinShell.operands(argv, []), stdin, "uniq");
        const rows = lines(text);
        const out: string[] = [];
        let count = 0;
        for (let i = 0; i < rows.length; i++) {
          count++;
          if (rows[i] !== rows[i + 1]) {
            out.push(flags.has("c") ? `${String(count).padStart(4, " ")} ${rows[i]}` : rows[i]!);
            count = 0;
          }
        }
        return { stdout: out.length ? `${out.join("\n")}\n` : "", stderr: error, exitCode: error ? 1 : 0 };
      },

      tr: async ({ argv, stdin }) => {
        const { flags } = BuiltinShell.split(argv);
        const rest = BuiltinShell.operands(argv, []);
        if (flags.has("d")) {
          const set = new Set(expandSet(rest[0] ?? ""));
          return ok([...stdin].filter((ch) => !set.has(ch)).join(""));
        }
        const from = expandSet(rest[0] ?? "");
        const to = expandSet(rest[1] ?? "");
        if (!from.length || !to.length) return bad("tr: usage: tr SET1 SET2 | tr -d SET");
        const map = new Map<string, string>();
        from.forEach((ch, i) => map.set(ch, to[Math.min(i, to.length - 1)]!));
        return ok([...stdin].map((ch) => map.get(ch) ?? ch).join(""));
      },

      cut: async ({ argv, stdin }) => {
        const { values, flags } = BuiltinShell.split(argv);
        const delimiter = values.get("d") ?? "\t";
        const spec = values.get("f") ?? values.get("c") ?? "";
        const consumed = [delimiter, spec].filter(Boolean);
        const { text, error } = await this.textOf(BuiltinShell.operands(argv, consumed), stdin, "cut");
        if (!spec) return bad("cut: usage: cut -d DELIM -f LIST | cut -c LIST");
        const wanted = spec.split(",").flatMap(rangeToNumbers);
        const byChar = flags.has("c") && !flags.has("f");
        const out = lines(text).map((row) => {
          const cells = byChar ? [...row] : row.split(delimiter);
          return wanted.map((n) => cells[n - 1] ?? "").join(byChar ? "" : delimiter);
        });
        return { stdout: out.length ? `${out.join("\n")}\n` : "", stderr: error, exitCode: error ? 1 : 0 };
      },

      tee: async ({ argv, stdin }) => {
        const { flags } = BuiltinShell.split(argv);
        const paths = BuiltinShell.operands(argv, []);
        let stderr = "";
        for (const p of paths) {
          try {
            const full = this.resolve(p);
            const before = flags.has("a") && (await fs.stat(full)) ? await fs.readText(full) : "";
            await fs.writeFile(full, before + stdin);
          } catch (err) {
            stderr += `tee: ${this.message(err)}\n`;
          }
        }
        return { stdout: stdin, stderr, exitCode: stderr ? 1 : 0 };
      },

      env: async () => ok(`${Object.entries({ ...this.env, PWD: this.cwd }).map(([k, v]) => `${k}=${v}`).sort().join("\n")}\n`),

      date: async ({ argv }) => {
        const now = this.now();
        const format = argv[1]?.startsWith("+") ? argv[1].slice(1) : "";
        return ok(`${format ? strftime(now, format) : now.toISOString()}\n`);
      },

      true: async () => ok(),
      false: async () => ({ stdout: "", stderr: "", exitCode: 1 }),

      which: async ({ argv }) => {
        const name = argv[1] ?? "";
        if (this.builtins[name]) return ok(`${name}: shell builtin\n`);
        if (PACKAGE_CLIENTS.has(name) || NODE_FAMILY.has(name) || OTHER_BINARIES[name]) {
          return bad(this.refuse(name).stderr.trim());
        }
        // `node_modules/.bin` is the PATH here, so `which` must look down it like any other shell.
        const installed = await this.binArgv([name]);
        if (installed) return ok(`${installed.entry}\n`);
        return bad(`which: ${name}: not found`);
      },

      help: async () => ok(this.helpText()),

      git: async (ctx) => this.gitCommand(ctx),

      node: async (ctx) => this.nodeCommand(ctx),
      npm: async (ctx) => this.npmCommand(ctx),
      npx: async (ctx) => this.npxCommand(ctx),
      serve: async (ctx) => this.serveCommand(ctx.argv.slice(1)),
      ports: async () => this.portsCommand(),
      kill: async ({ argv }) => this.killCommand(argv[1]),
    };
  }

  private async headTail(argv: string[], stdin: string, which: "head" | "tail"): Promise<ExecResult> {
    const { values } = BuiltinShell.split(argv);
    const raw = values.get("n");
    const count = raw && /^\d+$/.test(raw) ? Number(raw) : 10;
    const paths = BuiltinShell.operands(argv, raw ? [raw] : []);
    const { text, error } = await this.textOf(paths, stdin, which);
    const rows = lines(text);
    const picked = which === "head" ? rows.slice(0, count) : rows.slice(Math.max(0, rows.length - count));
    return { stdout: picked.length ? `${picked.join("\n")}\n` : "", stderr: error, exitCode: error ? 1 : 0 };
  }

  /**
   * `grep [-inrvl] PATTERN [FILE…]`. The pattern is a JavaScript RegExp, which is what the runtime's
   * own grep tool uses — one dialect in the product beats a half-hearted BRE nobody can predict.
   */
  private async grep({ argv, stdin }: CommandContext): Promise<ExecResult> {
    const { flags } = BuiltinShell.split(argv);
    const rest = BuiltinShell.operands(argv, []);
    const pattern = rest[0];
    if (pattern === undefined) return bad("grep: usage: grep [-inrvl] PATTERN [FILE…]");
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags.has("i") ? "i" : "");
    } catch (err) {
      return bad(`grep: ${this.message(err)}`, 2);
    }
    const targets = rest.slice(1);
    const invert = flags.has("v");
    const namesOnly = flags.has("l");
    const withNumbers = flags.has("n");

    const emit = (label: string, text: string, showName: boolean): string => {
      let out = "";
      let hit = false;
      lines(text).forEach((row, i) => {
        if (re.test(row) === invert) return;
        hit = true;
        if (namesOnly) return;
        out += `${showName ? `${label}:` : ""}${withNumbers ? `${i + 1}:` : ""}${row}\n`;
      });
      if (namesOnly && hit) out += `${label}\n`;
      return out;
    };

    if (!targets.length) return finish(emit("(stdin)", stdin, false));

    let stdout = "";
    let stderr = "";
    for (const target of targets) {
      let full: string;
      try {
        full = this.resolve(target);
      } catch (err) {
        stderr += `grep: ${this.message(err)}\n`;
        continue;
      }
      const stat = await this.fs.stat(full);
      if (!stat) {
        stderr += `grep: ${target}: No such file or directory\n`;
        continue;
      }
      if (stat.kind === "dir") {
        if (!(flags.has("r") || flags.has("R"))) {
          stderr += `grep: ${target}: Is a directory\n`;
          continue;
        }
        for await (const entry of this.fs.walk(full)) {
          const text = await this.fs.readText(entry.path).catch(() => "");
          stdout += emit(this.display(entry.path), text, true);
        }
        continue;
      }
      const text = await this.fs.readText(full).catch(() => "");
      stdout += emit(target, text, targets.length > 1 || flags.has("r"));
    }
    return { stdout, stderr, exitCode: stderr ? 2 : stdout ? 0 : 1 };

    function finish(out: string): ExecResult {
      return { stdout: out, stderr: "", exitCode: out ? 0 : 1 };
    }
  }

  /** `find [PATH] [-name GLOB] [-type f|d] [-maxdepth N]` — the subset a person types. */
  private async find({ argv }: CommandContext): Promise<ExecResult> {
    const args = argv.slice(1);
    let start = ".";
    let name: string | null = null;
    let type: "f" | "d" | null = null;
    let maxDepth = Infinity;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-name" || a === "-iname") name = args[++i] ?? null;
      else if (a === "-type") type = (args[++i] as "f" | "d") ?? null;
      else if (a === "-maxdepth") maxDepth = Number(args[++i] ?? "") || Infinity;
      else if (!a.startsWith("-")) start = a;
    }
    let root: string;
    try {
      root = this.resolve(start);
    } catch (err) {
      return bad(`find: ${this.message(err)}`);
    }
    if (!(await this.fs.stat(root)) && root !== this.root) return bad(`find: ${start}: No such file or directory`);
    const re = name ? globToRegExp(name, { matchBasename: false }) : null;
    const depthOf = (full: string): number => (full === root ? 0 : full.slice(root.length + 1).split("/").length);

    const out: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      let entries: FsEntry[];
      try {
        entries = await this.fs.readdir(dir);
      } catch {
        return;
      }
      for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        const full = `${dir}/${e.name}`;
        const matches = (!re || re.test(e.name)) && (!type || (type === "d") === (e.kind === "dir"));
        if (matches && depthOf(full) <= maxDepth) out.push(this.display(full));
        if (e.kind === "dir" && depthOf(full) < maxDepth) await visit(full);
      }
    };
    if (!re && (!type || type === "d")) out.push(this.display(root));
    await visit(root);
    return ok(out.length ? `${out.join("\n")}\n` : "");
  }

  // ── git ─────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `git`, delegated to `@00/agent-fs` rather than re-implemented. The subcommands that reach a
   * REMOTE are refused by name with the package's own sentence — a shell that silently did nothing
   * for `git push` would be the worst possible answer in a tool whose entire premise is honesty
   * about where things run.
   */
  private async gitCommand({ argv }: CommandContext): Promise<ExecResult> {
    const sub = argv[1] ?? "";
    if (sub === "remote") return bad(`git ${sub}: ${GIT_REMOTE_LINE}`, EXIT_NOT_FOUND);
    const git = this.git;
    if (!git) return bad("git: no git backend is wired into this shell", EXIT_NOT_FOUND);
    const dir = this.rel ? `${this.root}/${this.rel}` : this.root;
    const args = argv.slice(2);

    try {
      switch (sub) {
        case "":
        case "--help":
          return ok("usage: git <init|status|log|diff|add|commit|branch|checkout|clone|fetch|pull|push>\n");
        // ── The four that leave this computer (§14) ────────────────────────────────────────────
        //
        // They RUN when the companion is paired and refuse with the same sentence when it is not.
        // The refusal is the backend's, not the shell's: @00/agent-fs throws
        // `git_remote_not_available` with the road in it, and repeating that here in different words
        // is how two surfaces end up telling a person two different things.
        case "clone": {
          const url = args.find((a) => !a.startsWith("-"));
          if (!url) return bad("git clone: which repository?");
          if (!git.clone) return bad(`git clone: ${GIT_REMOTE_LINE}`, EXIT_NOT_FOUND);
          const into = args.filter((a) => !a.startsWith("-"))[1] ?? defaultCloneDir(url);
          return ok(`${await git.clone(url, this.resolve(into))}\n`);
        }
        case "fetch":
        case "pull":
        case "push": {
          const call = git[sub];
          if (!call) return bad(`git ${sub}: ${GIT_REMOTE_LINE}`, EXIT_NOT_FOUND);
          const rest = args.filter((a) => !a.startsWith("-"));
          return ok(`${await call(dir, rest[0], rest[1])}\n`);
        }
        case "init":
          await git.init(dir);
          return ok(`Initialised a git repository in ${this.cwd}\n`);
        case "status": {
          const entries = (await git.status(dir)).filter((e) => e.status !== "unmodified");
          const branch = git.branches ? (await git.branches(dir)).current : null;
          if (!entries.length) return ok(`${branch ? `On branch ${branch}\n` : ""}nothing to commit, working tree clean\n`);
          const body = entries
            .map((e) => `${e.staged ? "staged  " : "        "}${e.status.padEnd(10)} ${e.path}`)
            .join("\n");
          return ok(`${branch ? `On branch ${branch}\n` : ""}${body}\n`);
        }
        case "log": {
          const depth = Number(args.find((a) => /^-\d+$/.test(a))?.slice(1) ?? 20) || 20;
          const commits = await git.log(dir, depth);
          if (!commits.length) return ok("no commits yet\n");
          return ok(
            `${commits
              .map((c) => `${c.oid.slice(0, 7)} ${new Date(c.timestamp * 1000).toISOString().slice(0, 10)} ${c.message.split("\n")[0]}`)
              .join("\n")}\n`,
          );
        }
        case "diff": {
          const staged = args.includes("--staged") || args.includes("--cached");
          const path = args.find((a) => !a.startsWith("-"));
          if (git.diff) return ok(await git.diff(dir, path, { staged }));
          const names = await git.diffNames(dir);
          if (!names.length) return ok("");
          return ok(`${names.join("\n")}\n\n(names only — this build of @00/agent-fs has no textual diff yet)\n`);
        }
        case "add": {
          if (!args.length) return bad("git add: nothing to stage — pass paths, or `.`");
          await git.add(dir, args);
          return ok();
        }
        case "commit": {
          const at = args.indexOf("-m");
          const message = at >= 0 ? args[at + 1] ?? "" : "";
          if (!message.trim()) return bad("git commit: a commit needs a message (-m)");
          if (args.includes("-a") || args.includes("-am")) await git.add(dir, ["."]);
          const oid = await git.commit(dir, message);
          return ok(`[${oid.slice(0, 7)}] ${message.split("\n")[0]}\n`);
        }
        case "branch": {
          if (!git.branches) return bad("git branch: this build of @00/agent-fs has no branch helpers yet");
          const wanted = args.find((a) => !a.startsWith("-"));
          if (wanted) {
            if (!git.checkout) return bad("git branch: this build cannot create a branch");
            await git.checkout(dir, wanted, { create: true });
            return ok(`created ${wanted}\n`);
          }
          const { current, branches } = await git.branches(dir);
          return ok(`${branches.map((b) => `${b === current ? "* " : "  "}${b}`).join("\n")}\n`);
        }
        case "checkout":
        case "switch": {
          if (!git.checkout) return bad(`git ${sub}: this build of @00/agent-fs has no checkout yet`);
          const create = args.includes("-b") || args.includes("-c");
          const ref = args.find((a) => !a.startsWith("-"));
          if (!ref) return bad(`git ${sub}: which branch?`);
          await git.checkout(dir, ref, { create });
          return ok(`Switched to ${create ? "a new branch " : "branch "}${ref}\n`);
        }
        default:
          return bad(`git: '${sub}' is not a subcommand this shell knows`, EXIT_NOT_FOUND);
      }
    } catch (err) {
      return bad(`git ${sub}: ${this.message(err)}`);
    }
  }

  // ── Scripts, packages, servers and static folders ───────────────────────────────────────────────
  //
  // WHY THESE LIVE IN THE SHELL AND NOT IN A PANE. `node app.js`, `npm install`, `npm run build`,
  // `npx serve` are what a person's hands already know, and the agent's `bash` tool is this same
  // table — so wiring them here gives the agent the runner for free, with the same refusals and the
  // same sandbox. The process behind `node` is `@00/agent-node`'s (src/power/js-runner.ts), its
  // packages come from registry.npmjs.org through that package's own client, and the output streams
  // to whoever passed an `OutputSink` rather than arriving in one lump at the end.

  /** `node file.js [args]`, `node -e "…"`, `node -v`. */
  private async nodeCommand({ argv, signal, stream }: CommandContext): Promise<ExecResult> {
    const args = argv.slice(1);
    if (!args.length) {
      return bad("node: there is no REPL here — give it a file (`node app.js`) or `-e \"console.log(1)\"`.", 2);
    }
    if (args[0] === "-v" || args[0] === "--version") {
      return ok(`browser runtime — your scripts run in a Web Worker, not in Node (${NO_PACKAGES_LINE})\n`);
    }
    if (args[0] === "-p" || args[0] === "--print") {
      return bad("node -p is not supported here — use -e and console.log(), which prints the same thing.", 2);
    }
    if (args[0] === "-e" || args[0] === "--eval") {
      const code = args[1];
      if (code === undefined) return bad("node: -e wants some code after it", 2);
      return await this.runNode({ code, argv: args.slice(2), signal, stream });
    }
    if (args[0]!.startsWith("-")) return bad(`node: ${args[0]} is not a flag this runtime has (-e, -v)`, 2);
    return await this.runNode({ entry: args[0], argv: args.slice(1), signal, stream });
  }

  private async runNode(opts: {
    entry?: string;
    code?: string;
    argv: string[];
    signal?: AbortSignal;
    stream?: OutputSink;
    env?: Record<string, string>;
  }): Promise<ExecResult> {
    const out = new Out(opts.stream);
    try {
      const result = await runScript(this.fs, {
        entry: opts.entry,
        code: opts.code,
        argv: opts.argv,
        cwd: this.cwd,
        env: { ...this.env, ...(opts.env ?? {}), PWD: this.cwd },
        signal: opts.signal,
        timeoutMs: this.scriptTimeoutMs,
        createWorker: this.createWorker,
        network: this.network,
        onStdout: (text) => out.write("stdout", text),
        onStderr: (text) => out.write("stderr", text),
      });
      for (const port of result.listening) {
        out.write("stdout", `listening on ${portUrl(port)} — it answers while this tab is open; \`kill ${port}\` stops it.\n`);
      }
      return out.done(result.exitCode);
    } catch (err) {
      out.write("stderr", `node: ${this.message(err)}\n`);
      return out.done(1);
    }
  }

  // ── npm ─────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `npm install`, `npm run`, `npm ls` — a real client, in the tab.
   *
   * WHY THIS STOPPED BEING A REFUSAL. `@00/agent-node`'s npm client fetches from
   * registry.npmjs.org directly (the registry answers `Access-Control-Allow-Origin: *` on both the
   * abbreviated metadata and the tarballs, which is what makes this possible at all), verifies every
   * tarball's sha512, unpacks it with agent-fs's tar reader and writes `node_modules` into the same
   * workspace the file tree shows. What it will NOT do is run a lifecycle script or build a native
   * addon, and both are named package by package in the output rather than discovered later.
   */
  private async npmCommand({ argv, signal, stream }: CommandContext): Promise<ExecResult> {
    const sub = argv[1] ?? "";
    if (sub === "install" || sub === "i" || sub === "add" || sub === "ci") {
      return await this.npmInstall(argv.slice(2), stream);
    }
    if (sub === "ls" || sub === "list") return await this.npmLsCommand(argv.slice(2));
    if (sub === "run" || sub === "run-script") return await this.npmRun(argv[2], argv.slice(3), signal, stream);
    if (sub === "start" || sub === "test") return await this.npmRun(sub, argv.slice(2), signal, stream);
    if (!sub) {
      return bad(
        "npm: which one? `npm install` fetches packages, `npm run <script>` reads package.json, `npm ls` lists what is installed.",
        2,
      );
    }
    return bad(
      `npm ${sub}: this tab's npm does install, run, ls and the two lifecycle names (start, test) — ` +
        `everything else (${NO_NODE_LINE}) needs a real one`,
      EXIT_NOT_FOUND,
    );
  }

  /**
   * `npm install [pkg…]`, with the two things it does not do said out loud.
   *
   * A named package is WRITTEN INTO `package.json` first (npm's own `--save` default) and the
   * lockfile is bypassed for that run, because a lockfile that has never heard of the package a
   * person just asked for is a lockfile that would quietly install nothing.
   */
  private async npmInstall(args: string[], stream?: OutputSink): Promise<ExecResult> {
    const out = new Out(stream);
    const dev = args.some((a) => a === "-D" || a === "--save-dev");
    const specs = args.filter((a) => !a.startsWith("-"));
    const dir = this.dir();
    const manifestPath = `${dir}/package.json`;
    if (!(await this.fs.stat(manifestPath))) {
      return bad(
        `npm install: there is no package.json in ${this.cwd} — npm needs one to know what to install ` +
          `(\`echo '{"name":"app","version":"1.0.0"}' > package.json\`)`,
      );
    }
    const client = new RegistryClient({ registry: this.npmRegistry, fetch: this.npmFetch });

    if (specs.length) {
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(await this.fs.readText(manifestPath)) as Record<string, unknown>;
      } catch (err) {
        return bad(`npm install: package.json is not valid JSON — ${this.message(err)}`);
      }
      const field = dev ? "devDependencies" : "dependencies";
      const deps = { ...((manifest[field] ?? {}) as Record<string, string>) };
      for (const spec of specs) {
        const at = spec.lastIndexOf("@");
        const name = at > 0 ? spec.slice(0, at) : spec;
        const range = at > 0 ? spec.slice(at + 1) : "";
        try {
          const version = await client.resolveVersion(name, range || "latest");
          deps[name] = range && !/^\d/.test(range) ? range : `^${version.version}`;
          out.write("stdout", `resolved ${name}@${version.version}\n`);
        } catch (err) {
          out.write("stderr", `npm install: ${this.message(err)}\n`);
          return out.done(1);
        }
      }
      manifest[field] = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : 1)));
      await this.fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    try {
      const result = await install(this.fs, dir, {
        client,
        registry: this.npmRegistry,
        fetch: this.npmFetch,
        // A lockfile that has never heard of the package just asked for would quietly install
        // nothing, so naming one bypasses it; `npm install` with no names obeys it, as npm does.
        useLockfile: specs.length === 0,
        onProgress: ({ done, total, name, version }) => out.write("stdout", `fetched ${done}/${total} ${name}@${version}\n`),
      });
      out.write("stdout", this.installSummary(result));
      return out.done(0);
    } catch (err) {
      out.write("stderr", `npm install: ${this.message(err)}\n`);
      return out.done(1);
    }
  }

  /** What was added, what was already there, and — by name — what was skipped and why. */
  private installSummary(result: InstallResult): string {
    let text = `added ${result.installed.length} package${result.installed.length === 1 ? "" : "s"}`;
    if (result.skipped.length) text += `, ${result.skipped.length} already installed`;
    text += "\n";
    if (result.skippedScripts.length) {
      text +=
        `install scripts NOT run (arbitrary code from a stranger, at the moment you typed a name): ` +
        `${result.skippedScripts.join(", ")}\n`;
    }
    if (result.nativePackages.length) {
      text +=
        `native addons NOT built (machine code needs a real OS; the JavaScript was written anyway): ` +
        `${result.nativePackages.join(", ")}\n`;
    }
    for (const warning of result.warnings) text += `warning: ${warning}\n`;
    return text;
  }

  /** `npm ls` over what is actually on disk — the question a person asking `npm ls` really has. */
  private async npmLsCommand(args: string[]): Promise<ExecResult> {
    const depthArg = args.find((a) => a.startsWith("--depth"));
    const depth = depthArg ? Number(depthArg.split("=")[1] ?? "0") || 0 : Infinity;
    try {
      const listed = await npmLs(this.fs, this.dir(), depth);
      let text = `${listed.root.name}@${listed.root.version} ${this.cwd}\n`;
      for (const entry of listed.entries) {
        text += `${"  ".repeat(entry.depth + 1)}${entry.name}@${entry.version}\n`;
      }
      if (!listed.entries.length) text += "  (nothing installed — `npm install` fetches what package.json asks for)\n";
      for (const name of listed.missing) text += `  UNMET DEPENDENCY ${name}\n`;
      return ok(text);
    } catch (err) {
      return bad(`npm ls: ${this.message(err)}`);
    }
  }

  /**
   * `npm run <script>`: the plan `@00/agent-node` works out (pre/post hooks, npm's own environment,
   * npm's two defaults for `start` and `test`), each line run through this same shell — which is
   * exactly what npm does, `node_modules/.bin` included, since `runUnknown` is the PATH here.
   */
  private async npmRun(
    name: string | undefined,
    extra: string[] = [],
    signal?: AbortSignal,
    stream?: OutputSink,
  ): Promise<ExecResult> {
    if (!name) return bad("npm run: which script? `npm run` with a name, and package.json says the rest", 2);
    let plan: Awaited<ReturnType<typeof npmRunPlan>>;
    try {
      plan = await npmRunPlan(this.fs, this.dir(), name);
    } catch (err) {
      return bad(`npm run: ${this.message(err).replace(/^npm run \S+: /, "")}`);
    }
    if (this.scriptDepth >= MAX_SCRIPT_DEPTH) {
      return bad(`npm run ${name}: scripts are ${MAX_SCRIPT_DEPTH} deep here — something is calling itself`);
    }
    const passed = extra.filter((a) => a !== "--");
    const out = new Out(stream);
    const before = { ...this.env };
    Object.assign(this.env, plan.env);
    this.scriptDepth += 1;
    try {
      let code = 0;
      for (const step of plan.steps) {
        const line = step === plan.steps[plan.steps.length - 1] && passed.length ? `${step.command} ${passed.join(" ")}` : step.command;
        out.write("stdout", `> ${step.script}\n> ${line}\n\n`);
        const result = await this.exec(line, { signal, onOutput: stream });
        out.write("stdout", result.stdout);
        out.write("stderr", result.stderr);
        code = result.exitCode;
        if (code !== 0) break;
      }
      return out.done(code);
    } finally {
      this.scriptDepth -= 1;
      this.env = before;
    }
  }

  /**
   * `npx <tool>`: the local `node_modules/.bin` and nothing else. npx's other half — fetching a
   * package it has never seen into a cache and running it — is a download a person did not ask for,
   * so it says so and names `npm install` instead.
   */
  private async npxCommand({ argv, signal, stream }: CommandContext): Promise<ExecResult> {
    const tool = argv[1] ?? "";
    if (tool === "serve" || tool === "http-server") return await this.serveCommand(argv.slice(2));
    if (!tool) return bad(`npx: which one? \`npx serve\` serves a folder, and \`npx <tool>\` runs one from node_modules/.bin.`, 2);
    const rewritten = await this.binArgv(argv.slice(1));
    if (rewritten) {
      return await this.runNode({ entry: rewritten.entry, argv: rewritten.args, signal, stream });
    }
    if (PACKAGE_CLIENTS.has(tool) || NODE_FAMILY.has(tool) || OTHER_BINARIES[tool]) return this.refuse(tool);
    return bad(
      `npx ${tool}: there is no ${tool} in node_modules/.bin here, and this npx does not fetch a package ` +
        `you did not ask for — \`npm install ${tool}\` first.`,
      EXIT_NOT_FOUND,
    );
  }

  /** `serve [dir] [-p PORT]` — a workspace folder on a virtual port, served by the service worker. */
  private async serveCommand(args: string[]): Promise<ExecResult> {
    let dir = "";
    let port = DEFAULT_SERVE_PORT;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "-p" || arg === "--port" || arg === "-l") {
        const value = args[++i];
        if (!value || !/^\d+$/.test(value)) return bad(`serve: ${arg} wants a port number`, 2);
        port = Number(value);
        continue;
      }
      const inline = /^--port=(\d+)$/.exec(arg);
      if (inline) {
        port = Number(inline[1]);
        continue;
      }
      if (arg.startsWith("-")) return bad(`serve: ${arg} is not a flag this has (dir, -p PORT)`, 2);
      if (!dir) dir = arg;
    }
    let full: string;
    try {
      full = this.resolve(dir || ".");
    } catch (err) {
      return bad(`serve: ${this.message(err)}`);
    }
    const stat = await this.fs.stat(full);
    if (full !== this.root && (!stat || stat.kind !== "dir")) {
      return bad(`serve: ${dir || "."}: not a folder here`);
    }
    // `serveFolder` roots at the workspace, which is what `/` means everywhere in this shell.
    if (full !== WORKSPACE_ROOT && !full.startsWith(`${WORKSPACE_ROOT}/`)) {
      return bad(`serve: only folders under your workspace can be served`);
    }
    const relative = full === WORKSPACE_ROOT ? "." : full.slice(WORKSPACE_ROOT.length + 1);
    try {
      serveFolder(this.fs, port, relative);
    } catch (err) {
      return bad(`serve: ${err instanceof PortInUseError ? err.message : this.message(err)}`);
    }
    return ok(
      `serving ${this.display(full)} on port ${port}\n` +
        `  ${portUrl(port)}\n` +
        `open it in the preview pane, or \`kill ${port}\` to stop. It answers only in this browser, ` +
        `only while this tab is open.\n`,
    );
  }

  /** `ports` — what is listening in this tab, and where. */
  private portsCommand(): ExecResult {
    const live = listPorts();
    if (!live.length) {
      return ok("nothing is listening. `node server.js` takes a port, `serve ./public` takes one for a folder.\n");
    }
    let out = "PORT   KIND    WHAT                          URL\n";
    for (const entry of live) {
      out += `${String(entry.port).padEnd(6)} ${entry.kind.padEnd(7)} ${entry.label.slice(0, 29).padEnd(29)} ${portUrl(entry.port)}\n`;
    }
    return ok(out);
  }

  /** `kill <port>` — the only "process control" this shell has, because a port is the only process. */
  private killCommand(raw: string | undefined): ExecResult {
    if (!raw) return bad("kill: which port? `ports` lists them", 2);
    if (!/^\d+$/.test(raw)) return bad(`kill: ${raw} is not a port — this shell kills ports, not pids`, 2);
    const port = Number(raw);
    return unregister(port) ? ok(`${port} stopped\n`) : bad(`kill: nothing is listening on ${port}`);
  }

  private helpText(): string {
    return [
      `${this.label} — the same filesystem your agent reads, and nothing else.`,
      "",
      `files      ls cat head tail wc cp mv rm mkdir touch tee find grep`,
      `text       echo sort uniq tr cut`,
      `shell      cd pwd env date true false which help`,
      `git        init status log diff add commit branch checkout`,
      `run        node file.js · node -e "…" · npm run <script> · npx <tool>`,
      `packages   npm install [pkg] · npm ls`,
      `serve      serve ./dir -p 3000 · ports · kill 3000`,
      "",
      "pipes `|`, redirects `>` `>>` `<`, `&&` `||` `;`, quotes and one level of globbing.",
      `\`/\` is your workspace, and there is no way out of it.`,
      `Scripts run in a Web Worker with Node's own modules, your own require and the packages npm put`,
      `in node_modules — but ${NO_PACKAGES_LINE}.`,
      `python, curl, ssh, pnpm, vite: ${NO_NODE_LINE.replace("Node", "runtime")} — they are named, not hidden.`,
      "",
    ].join("\n");
  }
}

// ── Small pure helpers, exported because the tests read them directly ─────────────────────────────

/** `ls -l`'s row: kind, size, date, name. Not `rwxr-xr-x` — there are no modes here to lie about. */
export function lsLong(entry: { name: string; kind: "file" | "dir"; size: number; mtime: number }): string {
  const when = entry.mtime ? new Date(entry.mtime).toISOString().slice(0, 16).replace("T", " ") : "                ";
  return `${entry.kind === "dir" ? "d" : "-"} ${String(entry.size).padStart(8, " ")} ${when} ${entry.name}`;
}

/** `a-f` → the letters between; anything else is taken literally. */
export function expandSet(spec: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < spec.length; i++) {
    if (spec[i + 1] === "-" && spec[i + 2]) {
      const from = spec.charCodeAt(i);
      const to = spec.charCodeAt(i + 2);
      for (let c = from; c <= to; c++) out.push(String.fromCharCode(c));
      i += 2;
      continue;
    }
    out.push(spec[i]!);
  }
  return out;
}

/** `2-4` → [2,3,4]; `3` → [3]; `2-` → [2..64], because a shell's open range needs a ceiling here. */
export function rangeToNumbers(spec: string): number[] {
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m) return /^\d+$/.test(spec) ? [Number(spec)] : [];
  const from = Number(m[1] || "1");
  const to = Number(m[2] || "64");
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

/** The six `date` fields anybody writes in a filename. */
export function strftime(date: Date, format: string): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return format.replace(/%[YmdHMS%]/g, (token) => {
    switch (token) {
      case "%Y":
        return String(date.getUTCFullYear());
      case "%m":
        return pad(date.getUTCMonth() + 1);
      case "%d":
        return pad(date.getUTCDate());
      case "%H":
        return pad(date.getUTCHours());
      case "%M":
        return pad(date.getUTCMinutes());
      case "%S":
        return pad(date.getUTCSeconds());
      default:
        return "%";
    }
  });
}
