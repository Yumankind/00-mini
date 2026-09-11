/**
 * `install()` — tarballs in, a `node_modules` out, and two things deliberately not done.
 *
 * WHAT IT DOES. For every placement `resolveTree` produced: fetch `dist.tarball`, verify
 * `dist.integrity` (sha512 through WebCrypto, or the legacy sha1 `dist.shasum` for old packages, and
 * REFUSE either way if it does not match), gunzip with the platform's DecompressionStream, read the
 * tar with `@00/agent-fs`'s reader (which refuses a `..` or an absolute path in an entry — a tarball
 * is a stranger's file), strip the `package/` prefix every npm tarball has, and write the files.
 * Then write `.bin` shims for every `bin` entry, `package-lock.json` (lockfileVersion 3) beside
 * `package.json`, and `node_modules/.package-lock.json` so a second install knows what is already
 * there.
 *
 * WHAT IT DOES NOT DO, and this is the load-bearing half:
 *
 *   1. **It never runs a lifecycle script.** No `preinstall`, no `install`, no `postinstall`, no
 *      `prepare`. Same decision WebContainers took, for the same reason: a postinstall is arbitrary
 *      code from a stranger running with the workspace's own filesystem, at the moment a person
 *      typed a package name rather than "run this". Packages that NEED one are listed by name in
 *      `skippedScripts` so the person can see exactly which ones may be half-installed.
 *   2. **It cannot build a native addon.** A `binding.gyp` or a `.node` file is machine code for a
 *      real operating system; there is no browser answer. Those packages are listed by name in
 *      `nativePackages` and their files are still written (a package is often usable without its
 *      optional native fast path), with a warning saying which ones are not.
 *
 * Also absent: `npm audit`, `npm dedupe` beyond what the layout already does, shrinkwrap, workspace
 * links, and the `.bin` shims being executable (there are no file modes in this filesystem, so the
 * host's shell finds them by path, not by mode).
 */

import type { AgentFs } from "@00/agent-fs";
import { gunzip, readTar } from "@00/agent-fs";
import { NodeCompatError } from "../errors.js";
import { RegistryClient, verifyIntegrity, verifyShasum, type FetchLike } from "./registry.js";
import {
  buildHiddenLockfile,
  readJsonFile,
  resolveTree,
  type Lockfile,
  type Placement,
  type ResolveTreeOptions,
} from "./tree.js";

export interface InstallOptions extends ResolveTreeOptions {
  /** How many tarballs are in the air at once. A tab is not a build server. */
  concurrency?: number;
  onProgress?: (event: { done: number; total: number; name: string; version: string }) => void;
  /** Skip a package whose files are already on disk at the same version. Default true. */
  incremental?: boolean;
}

export interface InstallResult {
  installed: { name: string; version: string; path: string }[];
  skipped: { name: string; version: string; path: string }[];
  /** Packages whose `postinstall`/`install`/`preinstall` was NOT run. */
  skippedScripts: string[];
  /** Packages carrying a `binding.gyp` or a prebuilt `.node`. */
  nativePackages: string[];
  warnings: string[];
  lockfile: Lockfile;
}

export const DEFAULT_CONCURRENCY = 6;

const decoder = new TextDecoder();

/** npm tarballs put everything under a single top directory, almost always literally `package/`. */
export function stripTarballPrefix(path: string): string | null {
  const at = path.indexOf("/");
  if (at < 0) return null; // a bare file at the archive root is not part of the package tree
  return path.slice(at + 1) || null;
}

export async function install(fs: AgentFs, cwd: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const client = opts.client ?? new RegistryClient({ registry: opts.registry, fetch: opts.fetch });
  const tree = await resolveTree(fs, cwd, { ...opts, client });
  const hidden = await readJsonFile<Lockfile>(fs, `${cwd}/node_modules/.package-lock.json`);
  const already = new Map<string, string>();
  if (opts.incremental !== false && hidden) {
    for (const [path, entry] of Object.entries(hidden.packages)) if (entry.version) already.set(path, entry.version);
  }

  const installed: InstallResult["installed"] = [];
  const skipped: InstallResult["skipped"] = [];
  const skippedScripts: string[] = [];
  const nativePackages: string[] = [];
  const warnings = [...tree.warnings];

  const todo: Placement[] = [];
  for (const placement of tree.placements) {
    const here = already.get(placement.path);
    if (here === placement.version && (await fs.stat(`${cwd}/${placement.path}/package.json`))) {
      skipped.push({ name: placement.name, version: placement.version, path: placement.path });
      continue;
    }
    todo.push(placement);
  }

  let done = 0;
  const limit = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const queue = [...todo];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const placement = queue.shift();
      if (!placement) return;
      try {
        const report = await unpack(fs, cwd, placement, client);
        if (report.native) nativePackages.push(`${placement.name}@${placement.version}`);
        if (report.scripts.length) {
          skippedScripts.push(`${placement.name}@${placement.version} (${report.scripts.join(", ")})`);
        }
        installed.push({ name: placement.name, version: placement.version, path: placement.path });
      } catch (err) {
        if (!placement.optional) throw err;
        warnings.push(`optional ${placement.name}@${placement.version} failed to install: ${(err as Error).message}`);
      }
      done += 1;
      opts.onProgress?.({ done, total: todo.length, name: placement.name, version: placement.version });
    }
  });
  await Promise.all(workers);

  await writeBinShims(fs, cwd, tree.placements);
  const encoder = new TextEncoder();
  await fs.writeFile(`${cwd}/package-lock.json`, encoder.encode(`${JSON.stringify(tree.lockfile, null, 2)}\n`));
  await fs.mkdir(`${cwd}/node_modules`);
  await fs.writeFile(
    `${cwd}/node_modules/.package-lock.json`,
    encoder.encode(`${JSON.stringify(buildHiddenLockfile(tree.lockfile), null, 2)}\n`),
  );

  if (skippedScripts.length) {
    warnings.push(
      `${skippedScripts.length} package(s) have install scripts, and this runtime never runs them: ${skippedScripts.join("; ")}`,
    );
  }
  if (nativePackages.length) {
    warnings.push(
      `${nativePackages.length} package(s) carry native code, which cannot run in a browser: ${nativePackages.join(", ")}`,
    );
  }

  return { installed, skipped, skippedScripts, nativePackages, warnings, lockfile: tree.lockfile };
}

async function unpack(
  fs: AgentFs,
  cwd: string,
  placement: Placement,
  client: RegistryClient,
): Promise<{ native: boolean; scripts: string[] }> {
  const tarball = await client.tarball(placement.resolved);
  if (placement.integrity) await verifyIntegrity(tarball, placement.integrity);
  else {
    const packument = await client.packument(placement.name).catch(() => null);
    const shasum = packument?.versions[placement.version]?.dist?.shasum;
    if (shasum) verifyShasum(tarball, shasum);
    else {
      throw new NodeCompatError(
        "ERR_NO_INTEGRITY",
        `${placement.name}@${placement.version} came with neither dist.integrity nor dist.shasum — this runtime will not unpack a tarball it cannot check`,
      );
    }
  }
  const bytes = tarball[0] === 0x1f && tarball[1] === 0x8b ? await gunzip(tarball) : tarball;
  const target = `${cwd}/${placement.path}`;
  await fs.remove(target);
  await fs.mkdir(target);
  let native = false;
  let scripts: string[] = [];
  for (const entry of readTar(bytes)) {
    const rel = stripTarballPrefix(entry.path);
    if (!rel) continue;
    if (entry.kind === "dir") {
      await fs.mkdir(`${target}/${rel}`);
      continue;
    }
    if (rel === "binding.gyp" || rel.endsWith(".node")) native = true;
    await fs.writeFile(`${target}/${rel}`, entry.data);
    if (rel === "package.json") {
      try {
        const manifest = JSON.parse(decoder.decode(entry.data)) as { scripts?: Record<string, string> };
        scripts = ["preinstall", "install", "postinstall"].filter((name) => manifest.scripts?.[name]);
      } catch {
        // A package.json this runtime cannot parse is the package's problem, not the install's.
      }
    }
  }
  return { native, scripts };
}

/**
 * `node_modules/.bin/<name>` — a one-line CommonJS file that requires the real entry point relative
 * to itself. There are no file modes here and no `#!` interpreter, so a shim is a MODULE, and the
 * host's shell runs it with `node`. That is also why it works from a nested `node_modules`: the
 * relative path is computed from the shim's own directory.
 */
export async function writeBinShims(fs: AgentFs, cwd: string, placements: Placement[]): Promise<string[]> {
  const written: string[] = [];
  const encoder = new TextEncoder();
  for (const placement of placements) {
    if (!placement.bin) continue;
    const entries: [string, string][] =
      typeof placement.bin === "string" ? [[placement.name.replace(/^@[^/]+\//, ""), placement.bin]] : Object.entries(placement.bin);
    // The LAST `node_modules/` in the path: a nested copy's bin belongs to the `.bin` of the
    // `node_modules` it lives in, not to the one at the top — that is how npm keeps two versions of
    // the same tool from overwriting each other's shim.
    const dir = placement.path.slice(0, placement.path.lastIndexOf("node_modules/") + "node_modules".length);
    const binDir = `${cwd}/${dir}/.bin`;
    await fs.mkdir(binDir);
    for (const [name, relative] of entries) {
      const targetFromBin = `../${placement.path.slice(dir.length + 1)}/${relative.replace(/^\.\//, "")}`;
      const shim =
        `#!/usr/bin/env node\n` +
        `// A bin shim written by @00/agent-node's npm client. There are no symlinks in this\n` +
        `// filesystem, so a shim is a module that requires the real entry point.\n` +
        `module.exports = require(${JSON.stringify(targetFromBin)});\n`;
      await fs.writeFile(`${binDir}/${name}`, encoder.encode(shim));
      written.push(`${dir}/.bin/${name}`);
    }
  }
  return written;
}
