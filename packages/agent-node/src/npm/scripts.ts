/**
 * `npm run` and `npm ls`, as facts a shell can act on rather than as a shell of their own.
 *
 * WHY THESE RETURN DATA INSTEAD OF RUNNING ANYTHING. The host already has a shell
 * (`apps/infinite/src/power/shell.ts`) with its own parser, its own job control and its own idea of
 * a working directory. A second one here would be a second set of quoting rules to get wrong. So
 * `npmRunPlan` answers "which command lines, in which order" — `pre<name>`, `<name>`, `post<name>`,
 * exactly npm's order — and `rewriteBinArgv` answers the only other thing npm does for a script:
 * put `node_modules/.bin` in front of the PATH. There is no PATH in this runtime, so the same effect
 * is achieved by REWRITING an argv whose first word is a package's bin into `node <shim path>`.
 *
 * DOES: script lookup with the `pre`/`post` hooks; `npm start` and `npm test` and their defaults
 * (`node server.js` for start when a `server.js` exists, and the "no test specified" line for test —
 * npm's own two special cases); the `.bin` lookup from the nearest `node_modules` upward; `npm ls`
 * over the hidden lockfile with a depth limit; unmet dependency detection.
 *
 * DOES NOT: `npm_config_*` and the rest of the environment npm exports into a script (`npm_package_*`
 * is the one people use, and it is provided); `npm exec`/`npx` remote fetching; `--if-present`;
 * lifecycle scripts around install (`install()` never runs one, and this never invents a place to);
 * `npm ls --json` for the whole registry-resolved tree — it reports what is ON DISK, which is the
 * question a person asking `npm ls` actually has.
 */

import type { AgentFs } from "@00/agent-fs";
import { NodeCompatError } from "../errors.js";
import { readJsonFile, type Lockfile } from "./tree.js";

export interface RunStep {
  /** `prebuild`, `build`, `postbuild`. */
  script: string;
  command: string;
}

export interface RunPlan {
  steps: RunStep[];
  /** `npm_package_name` and friends, for a host that wants npm's environment. */
  env: Record<string, string>;
}

export interface PackageManifest {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
}

export async function readManifest(fs: AgentFs, cwd: string): Promise<PackageManifest> {
  const manifest = await readJsonFile<PackageManifest>(fs, `${cwd}/package.json`);
  if (!manifest) {
    throw new NodeCompatError("ERR_NO_PACKAGE_JSON", `there is no package.json in ${cwd}`);
  }
  return manifest;
}

/** The command lines `npm run <name>` would execute, in npm's order. Throws when there is no script. */
export async function npmRunPlan(fs: AgentFs, cwd: string, name: string): Promise<RunPlan> {
  const manifest = await readManifest(fs, cwd);
  const scripts = manifest.scripts ?? {};
  const steps: RunStep[] = [];
  const main = scripts[name] ?? (await defaultScript(fs, cwd, name));
  if (!main) {
    const known = Object.keys(scripts);
    throw new NodeCompatError(
      "ERR_NO_SCRIPT",
      `npm run ${name}: no script named "${name}"${known.length ? ` — package.json has ${known.join(", ")}` : " and package.json has no scripts"}`,
    );
  }
  const pre = scripts[`pre${name}`];
  const post = scripts[`post${name}`];
  if (pre) steps.push({ script: `pre${name}`, command: pre });
  steps.push({ script: name, command: main });
  if (post) steps.push({ script: `post${name}`, command: post });
  const env: Record<string, string> = {
    npm_lifecycle_event: name,
    npm_lifecycle_script: main,
    npm_package_name: manifest.name ?? "",
    npm_package_version: manifest.version ?? "",
    npm_execpath: "agent-node",
    npm_config_user_agent: "agent-node/0.0.1 (browser)",
  };
  return { steps, env };
}

/** npm's two built-in defaults, and no others. */
async function defaultScript(fs: AgentFs, cwd: string, name: string): Promise<string | null> {
  if (name === "start" && (await fs.stat(`${cwd}/server.js`))) return "node server.js";
  if (name === "test") return `echo "Error: no test specified" && exit 1`;
  return null;
}

/** Every `.bin` directory visible from `cwd`, nearest first. */
export function binDirectories(cwd: string, root = ""): string[] {
  const out: string[] = [];
  let dir = cwd;
  for (;;) {
    out.push(`${dir}/node_modules/.bin`);
    if (dir === root || !dir.includes("/")) break;
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  return out;
}

export interface ArgvRewrite {
  /** The argv the host should actually run. */
  argv: string[];
  /** The shim that was found, for a host that wants to say so. */
  bin: string | null;
}

/**
 * The PATH substitute: `["vitest", "run"]` becomes `["node", "<cwd>/node_modules/.bin/vitest", "run"]`
 * when a shim exists, and is returned untouched when none does — the host then answers "not found"
 * in its own words, which is the shell's job and not this module's.
 */
export async function rewriteBinArgv(fs: AgentFs, cwd: string, argv: string[], root = ""): Promise<ArgvRewrite> {
  const [command, ...rest] = argv;
  if (!command || command.startsWith(".") || command.startsWith("/") || command.includes("/")) return { argv, bin: null };
  for (const dir of binDirectories(cwd, root)) {
    const path = `${dir}/${command}`;
    const stat = await fs.stat(path);
    if (stat?.kind === "file") return { argv: ["node", path, ...rest], bin: path };
  }
  return { argv, bin: null };
}

export interface LsEntry {
  name: string;
  version: string;
  path: string;
  depth: number;
}

export interface LsResult {
  root: { name: string; version: string };
  entries: LsEntry[];
  /** Direct dependencies of `package.json` with nothing on disk. */
  missing: string[];
}

/** `npm ls` over what is actually on disk, read from the hidden lockfile npm and this client write. */
export async function npmLs(fs: AgentFs, cwd: string, depth = Infinity): Promise<LsResult> {
  const manifest = await readManifest(fs, cwd);
  const hidden = await readJsonFile<Lockfile>(fs, `${cwd}/node_modules/.package-lock.json`);
  const entries: LsEntry[] = [];
  for (const [path, entry] of Object.entries(hidden?.packages ?? {})) {
    if (!entry.version) continue;
    const level = path.split("node_modules/").length - 2;
    if (level > depth) continue;
    entries.push({
      name: path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
      version: entry.version,
      path,
      depth: level,
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const missing: string[] = [];
  for (const name of Object.keys({ ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) })) {
    if (!entries.some((e) => e.path === `node_modules/${name}`)) missing.push(name);
  }
  return { root: { name: manifest.name ?? "workspace", version: manifest.version ?? "0.0.0" }, entries, missing };
}
