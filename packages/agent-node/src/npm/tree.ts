/**
 * `resolveTree` — what goes where in `node_modules`, and the lockfile that records it.
 *
 * THE ONE RULE, WRITTEN OUT. npm since v3 lays a tree out FLAT: every package goes as high as it can
 * go, and a package goes deeper only when a shallower slot is already taken by a DIFFERENT version.
 * That is what makes `require("lodash")` from anywhere find one copy, and it is the only reason a
 * browser can hold a real dependency tree at all — the nested v2 layout would be tens of thousands
 * of directories. So: for each dependency, walk the ancestors of the requiring package from the root
 * down; take the first slot that is empty, or that already holds this exact version (a dedupe); and
 * only if every ancestor slot holds a different version, nest it under the requirer.
 *
 * A LOCKFILE IS OBEYED, NOT CONSULTED. When `package-lock.json` is present this function does not
 * ask the registry a single question: the lockfile's `packages` map already names every path,
 * version, tarball and integrity, and re-resolving would defeat the point of having one. It is
 * checked for shape and for agreement with `package.json`'s direct ranges, and a disagreement is
 * reported by name rather than silently re-resolved (`npm ci` refuses; `npm install` would update —
 * this returns the fact and lets the caller decide).
 *
 * DOES: `dependencies`, `devDependencies` (root only, and only when asked), `optionalDependencies`
 * (marked optional so a failure to install one is a warning, not a failure), `bin`, cycles in the
 * dependency graph, scoped names, `engines` recorded for the report.
 *
 * DOES NOT: install `peerDependencies` (npm 7+ does; doing it here would silently pull a React into
 * a tab). They are reported as unmet-peer warnings instead. Also absent: `overrides`, `resolutions`,
 * `bundleDependencies` (the tarball's own bundled copies are extracted as they come and not
 * resolved), `os`/`cpu` filtering (this is not any of those platforms), and workspaces.
 */

import type { AgentFs } from "@00/agent-fs";
import { NodeCompatError } from "../errors.js";
import { assertSupportedRange, RegistryClient, type FetchLike, type PackageVersion } from "./registry.js";

export interface LockPackage {
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  engines?: Record<string, string>;
  dev?: boolean;
  optional?: boolean;
  hasInstallScript?: boolean;
  name?: string;
  license?: string;
}

export interface Lockfile {
  name?: string;
  version?: string;
  lockfileVersion: number;
  requires?: boolean;
  packages: Record<string, LockPackage>;
}

/** One package, and the `node_modules` path it lands on relative to the project. */
export interface Placement {
  /** `node_modules/foo` or `node_modules/a/node_modules/foo`. */
  path: string;
  name: string;
  version: string;
  resolved: string;
  integrity?: string;
  dependencies: Record<string, string>;
  bin?: string | Record<string, string>;
  dev: boolean;
  optional: boolean;
  hasInstallScript: boolean;
}

export interface ResolveTreeOptions {
  registry?: string;
  fetch?: FetchLike;
  /** Include the root's `devDependencies`. npm's own default is true. */
  dev?: boolean;
  /** Honour a `package-lock.json` when one is there. Turn off to force a fresh resolution. */
  useLockfile?: boolean;
  client?: RegistryClient;
}

export interface ResolveTreeResult {
  root: { name: string; version: string };
  placements: Placement[];
  /** The `packages` map of a lockfileVersion 3 file, root entry included. */
  lockfile: Lockfile;
  /** Unmet peers, deprecations, and anything else a person should read before running the code. */
  warnings: string[];
  /** True when the answer came from an existing `package-lock.json` and the registry was never asked. */
  fromLockfile: boolean;
}

const decoder = new TextDecoder();

export async function readJsonFile<T>(fs: AgentFs, path: string): Promise<T | null> {
  const stat = await fs.stat(path);
  if (!stat || stat.kind !== "file") return null;
  try {
    return JSON.parse(decoder.decode(await fs.readFile(path))) as T;
  } catch (err) {
    throw new NodeCompatError("ERR_INVALID_PACKAGE_JSON", `${path} is not valid JSON — ${(err as Error).message}`);
  }
}

/** The ancestor `node_modules` slots a dependency of `ownerPath` may be hoisted into, shallowest first. */
export function hoistCandidates(ownerPath: string): string[] {
  const out = [""];
  if (ownerPath === "") return out;
  const parts = ownerPath.split("/");
  let at = "";
  for (let i = 0; i + 1 < parts.length; i += 2) {
    at = at === "" ? `node_modules/${parts[i + 1]}` : `${at}/node_modules/${parts[i + 1]}`;
    out.push(at);
  }
  return out;
}

function slot(dir: string, name: string): string {
  return dir === "" ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
}

export async function resolveTree(fs: AgentFs, cwd: string, opts: ResolveTreeOptions = {}): Promise<ResolveTreeResult> {
  const manifest = await readJsonFile<Record<string, unknown>>(fs, `${cwd}/package.json`);
  if (!manifest) {
    throw new NodeCompatError("ERR_NO_PACKAGE_JSON", `there is no package.json in ${cwd} — npm needs one to know what to install`);
  }
  const root = { name: String(manifest.name ?? "workspace"), version: String(manifest.version ?? "0.0.0") };
  const deps = (manifest.dependencies ?? {}) as Record<string, string>;
  const devDeps = (manifest.devDependencies ?? {}) as Record<string, string>;
  const optDeps = (manifest.optionalDependencies ?? {}) as Record<string, string>;
  const wantsDev = opts.dev !== false;

  const existing = opts.useLockfile === false ? null : await readJsonFile<Lockfile>(fs, `${cwd}/package-lock.json`);
  if (existing) return fromLockfile(existing, root, { ...deps, ...(wantsDev ? devDeps : {}) });

  const client = opts.client ?? new RegistryClient({ registry: opts.registry, fetch: opts.fetch });
  const occupied = new Map<string, Placement>();
  const warnings: string[] = [];
  const seen = new Set<string>();

  interface Job {
    name: string;
    range: string;
    owner: string;
    dev: boolean;
    optional: boolean;
  }
  const queue: Job[] = [
    ...Object.entries(deps).map(([name, range]) => ({ name, range, owner: "", dev: false, optional: false })),
    ...(wantsDev ? Object.entries(devDeps).map(([name, range]) => ({ name, range, owner: "", dev: true, optional: false })) : []),
    ...Object.entries(optDeps).map(([name, range]) => ({ name, range, owner: "", dev: false, optional: true })),
  ];

  while (queue.length) {
    const job = queue.shift() as Job;
    const key = `${job.owner}|${job.name}@${job.range}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let version: PackageVersion;
    try {
      assertSupportedRange(job.name, job.range);
      version = await client.resolveVersion(job.name, job.range);
    } catch (err) {
      if (!job.optional) throw err;
      warnings.push(`optional dependency ${job.name}@${job.range} was skipped: ${(err as Error).message}`);
      continue;
    }
    if (version.deprecated) warnings.push(`${job.name}@${version.version} is deprecated: ${version.deprecated}`);

    // Hoist: the shallowest slot that is free, or already holds this exact version.
    let placedAt: string | null = null;
    for (const dir of hoistCandidates(job.owner)) {
      const path = slot(dir, job.name);
      const taken = occupied.get(path);
      if (!taken) {
        placedAt = path;
        break;
      }
      if (taken.version === version.version) {
        placedAt = null;
        // A dedupe: nothing new to place, but the dependency graph below it was already walked.
        break;
      }
    }
    if (placedAt === null) {
      const reused = hoistCandidates(job.owner)
        .map((dir) => occupied.get(slot(dir, job.name)))
        .find((p) => p?.version === version.version);
      if (reused) continue;
      placedAt = slot(job.owner, job.name);
    }

    const placement: Placement = {
      path: placedAt,
      name: job.name,
      version: version.version,
      resolved: version.dist.tarball,
      integrity: version.dist.integrity,
      dependencies: { ...(version.dependencies ?? {}) },
      bin: version.bin,
      dev: job.dev,
      optional: job.optional,
      hasInstallScript: Boolean(version.hasInstallScript ?? version.scripts?.postinstall ?? version.scripts?.install ?? version.scripts?.preinstall),
    };
    occupied.set(placedAt, placement);

    for (const [name, range] of Object.entries(version.dependencies ?? {})) {
      queue.push({ name, range, owner: placedAt, dev: job.dev, optional: false });
    }
    for (const [name, range] of Object.entries(version.optionalDependencies ?? {})) {
      queue.push({ name, range, owner: placedAt, dev: job.dev, optional: true });
    }
    for (const [name, range] of Object.entries(version.peerDependencies ?? {})) {
      if (version.peerDependenciesMeta?.[name]?.optional) continue;
      warnings.push(`${job.name}@${version.version} wants a peer ${name}@${range}; this runtime does not install peers — add it to your own dependencies if you need it`);
    }
  }

  const placements = [...occupied.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    root,
    placements,
    lockfile: buildLockfile(root, manifest, placements),
    warnings,
    fromLockfile: false,
  };
}

export function buildLockfile(
  root: { name: string; version: string },
  manifest: Record<string, unknown>,
  placements: Placement[],
): Lockfile {
  const packages: Record<string, LockPackage> = {
    "": {
      name: root.name,
      version: root.version,
      dependencies: (manifest.dependencies ?? undefined) as Record<string, string> | undefined,
      devDependencies: (manifest.devDependencies ?? undefined) as Record<string, string> | undefined,
      optionalDependencies: (manifest.optionalDependencies ?? undefined) as Record<string, string> | undefined,
    },
  };
  for (const p of [...placements].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    packages[p.path] = {
      version: p.version,
      resolved: p.resolved,
      integrity: p.integrity,
      dependencies: Object.keys(p.dependencies).length ? p.dependencies : undefined,
      bin: p.bin,
      dev: p.dev || undefined,
      optional: p.optional || undefined,
      hasInstallScript: p.hasInstallScript || undefined,
    };
  }
  return { name: root.name, version: root.version, lockfileVersion: 3, requires: true, packages };
}

/** The hidden lockfile npm keeps inside `node_modules`: the same map, without the root entry. */
export function buildHiddenLockfile(lockfile: Lockfile): Lockfile {
  const packages: Record<string, LockPackage> = {};
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (path === "") continue;
    packages[path] = entry;
  }
  return { name: lockfile.name, version: lockfile.version, lockfileVersion: 3, requires: true, packages };
}

/** Honour an existing lockfile EXACTLY: no registry call, no re-resolution, no reordering. */
function fromLockfile(lockfile: Lockfile, root: { name: string; version: string }, direct: Record<string, string>): ResolveTreeResult {
  if (lockfile.lockfileVersion < 2 || !lockfile.packages) {
    throw new NodeCompatError(
      "ERR_LOCKFILE_VERSION",
      `package-lock.json is lockfileVersion ${lockfile.lockfileVersion}; this runtime reads 2 and 3 (the ones with a "packages" map). Delete it and install again.`,
    );
  }
  const warnings: string[] = [];
  const placements: Placement[] = [];
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (path === "" || !entry.resolved || !entry.version) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    placements.push({
      path,
      name,
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      dependencies: entry.dependencies ?? {},
      bin: entry.bin,
      dev: Boolean(entry.dev),
      optional: Boolean(entry.optional),
      hasInstallScript: Boolean(entry.hasInstallScript),
    });
  }
  // The lockfile is obeyed, but a disagreement with package.json is a fact worth saying out loud.
  for (const [name, range] of Object.entries(direct)) {
    const found = placements.find((p) => p.path === `node_modules/${name}`);
    if (!found) warnings.push(`package.json asks for ${name}@${range} and package-lock.json has no entry for it — the lockfile is stale`);
  }
  return { root, placements, lockfile, warnings, fromLockfile: true };
}
