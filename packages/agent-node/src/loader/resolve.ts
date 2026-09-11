/**
 * Node's module resolution algorithm, written out.
 *
 * WHY WRITE IT OUT. Because every shortcut version of it breaks a real package. The prelude in
 * `apps/infinite/src/power/js-runner.ts` tries five suffixes and gives up; that is enough for a
 * script beside its own files and not enough for anything with a `node_modules`, which is the whole
 * point of this package. What follows is the algorithm from Node's own documentation
 * (`LOAD_AS_FILE`, `LOAD_AS_DIRECTORY`, `NODE_MODULES_PATHS`, `PACKAGE_EXPORTS_RESOLVE`) with the
 * browserfield map on top, and the deliberate differences listed here:
 *
 * DOES: relative and absolute requests; the `node_modules` walk from the requesting directory up to
 * the WORKSPACE ROOT and no further (there is no `/usr/lib/node` here, and no global prefix);
 * `package.json` `exports` with conditions (`browser`, `import`, `require`, `default`, plus whatever
 * the host adds), subpath keys, `./*` patterns, condition arrays and `null` blocks; `main`;
 * `browser` as a string and as a map, including `false` for "this module is empty in a browser";
 * `index.js`; the extension ladder `.js` `.cjs` `.mjs` `.json`; and `imports` (`#internal`) with the
 * same condition machinery.
 *
 * DOES NOT: `.node` (a native addon has no browser; it refuses by name), symlink realpath (there are
 * no symlinks in this filesystem, so `preserveSymlinks` is moot), `NODE_PATH`, the legacy
 * `require.extensions` hook, or self-reference by package name outside an `exports`-declaring
 * package. `exports` patterns are matched literally rather than by Node's longest-specificity sort
 * for keys that are not patterns — the difference only shows in a package with overlapping
 * `./*` keys, and it is written here rather than pretended away.
 */

import { NodeCompatError } from "../errors.js";
import { normalizeAbs, resolveAbs } from "../paths.js";

export interface ResolveHost {
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  readJson(path: string): Record<string, unknown> | null;
  /** The `node_modules` walk stops here. `/` in this runtime. */
  root: string;
  /** Ordered; the first that matches an `exports` key wins. `default` is always accepted last. */
  conditions: string[];
}

/** What a `browser: { "x": false }` entry resolves to. The loader turns it into an empty exports. */
export const EMPTY_MODULE = "\0empty";

export const EXTENSIONS = [".js", ".cjs", ".mjs", ".json"] as const;

/** `NODE_MODULES_PATHS`: every `node_modules` from `fromDir` up to (and including) `root`. */
export function nodeModulesPaths(fromDir: string, root = "/"): string[] {
  const out: string[] = [];
  let dir = normalizeAbs(fromDir);
  const stop = normalizeAbs(root);
  for (;;) {
    if (!dir.endsWith("/node_modules")) out.push(dir === "/" ? "/node_modules" : `${dir}/node_modules`);
    if (dir === stop || dir === "/") break;
    const parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function loadAsFile(target: string, host: ResolveHost): string | null {
  if (target.endsWith(".node")) {
    throw new NodeCompatError(
      "ERR_NATIVE_ADDON",
      `${target}: this is a native addon (.node), machine code for a real operating system — there is no way to load one in a browser, and no polyfill can stand in for it`,
    );
  }
  if (host.isFile(target)) return target;
  for (const ext of EXTENSIONS) if (host.isFile(target + ext)) return target + ext;
  return null;
}

function loadIndex(dir: string, host: ResolveHost): string | null {
  for (const ext of EXTENSIONS) if (host.isFile(`${dir}/index${ext}`)) return `${dir}/index${ext}`;
  return null;
}

/** Is `key` an active condition? `default` always is; the rest come from the host's list. */
function conditionActive(key: string, host: ResolveHost): boolean {
  return key === "default" || host.conditions.includes(key);
}

/**
 * `PACKAGE_TARGET_RESOLVE`: a target is a string, an array of alternatives, an object of conditions,
 * or `null` (deliberately blocked). `star` is what `*` matched in the key, substituted into the value.
 */
function resolveTarget(target: unknown, packageDir: string, star: string | null, host: ResolveHost): string | null {
  if (target === null) return null;
  if (typeof target === "string") {
    if (!target.startsWith("./")) return null; // an external target ("dep/x") is not a file in this package
    const withStar = star === null ? target : target.replace(/\*/g, star);
    return normalizeAbs(`${packageDir}/${withStar.slice(2)}`);
  }
  if (Array.isArray(target)) {
    for (const option of target) {
      const found = resolveTarget(option, packageDir, star, host);
      if (found && (host.isFile(found) || host.isDirectory(found))) return found;
    }
    return null;
  }
  if (typeof target === "object") {
    for (const [key, value] of Object.entries(target as Record<string, unknown>)) {
      if (!conditionActive(key, host)) continue;
      const found = resolveTarget(value, packageDir, star, host);
      if (found !== null) return found;
    }
    return null;
  }
  return null;
}

/**
 * `PACKAGE_EXPORTS_RESOLVE`. `subpath` is `"."` or `"./thing"`. Exact keys win over patterns, and
 * among patterns the longest prefix wins — which is Node's rule and the one packages rely on.
 */
export function resolveExports(
  exportsField: unknown,
  subpath: string,
  packageDir: string,
  host: ResolveHost,
): string | null | undefined {
  if (exportsField === undefined || exportsField === null) return undefined;
  // Sugar: `"exports": "./index.js"` or `"exports": { "require": … }` both mean the "." subpath.
  const isSubpathMap =
    typeof exportsField === "object" &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField as object).length > 0 &&
    Object.keys(exportsField as object).every((k) => k === "." || k.startsWith("./"));
  if (!isSubpathMap) {
    return subpath === "." ? resolveTarget(exportsField, packageDir, null, host) : undefined;
  }
  const map = exportsField as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(map, subpath)) {
    return resolveTarget(map[subpath], packageDir, null, host);
  }
  let best: { key: string; star: string } | null = null;
  for (const key of Object.keys(map)) {
    const at = key.indexOf("*");
    if (at < 0) continue;
    const head = key.slice(0, at);
    const tail = key.slice(at + 1);
    if (!subpath.startsWith(head) || !subpath.endsWith(tail)) continue;
    if (subpath.length < head.length + tail.length) continue;
    if (best && best.key.length >= key.length) continue;
    best = { key, star: subpath.slice(head.length, subpath.length - tail.length) };
  }
  if (!best) return undefined;
  return resolveTarget(map[best.key], packageDir, best.star, host);
}

/** `LOAD_AS_DIRECTORY`, with `exports` and the `browser` string form ahead of `main`. */
function loadAsDirectory(dir: string, host: ResolveHost, subpath = "."): string | null {
  const pkg = host.readJson(`${dir}/package.json`);
  if (pkg) {
    const fromExports = resolveExports(pkg.exports, subpath, dir, host);
    if (fromExports === null) {
      throw new NodeCompatError(
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        `Package subpath '${subpath}' is not defined by "exports" in ${dir}/package.json — the package blocked it on purpose`,
      );
    }
    if (fromExports !== undefined) {
      const found = loadAsFile(fromExports, host) ?? loadIndex(fromExports, host);
      if (found) return found;
      throw new NodeCompatError(
        "ERR_MODULE_NOT_FOUND",
        `"exports" in ${dir}/package.json points at ${fromExports}, which is not there`,
      );
    }
    if (subpath !== ".") return null; // no exports map: the caller retries as a plain file path
    const browser = host.conditions.includes("browser") ? pkg.browser : undefined;
    const entry = typeof browser === "string" ? browser : typeof pkg.main === "string" ? pkg.main : null;
    if (entry) {
      const target = normalizeAbs(`${dir}/${entry.replace(/^\.\//, "")}`);
      const found = loadAsFile(target, host) ?? loadIndex(target, host);
      if (found) return found;
    }
  }
  return loadIndex(dir, host);
}

/** `"@scope/name/sub/path"` → `{ name: "@scope/name", subpath: "./sub/path" }`. */
export function splitBareRequest(request: string): { name: string; subpath: string } {
  const parts = request.split("/");
  const name = request.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
  const rest = request.slice(name.length);
  return { name, subpath: rest === "" ? "." : `.${rest}` };
}

/**
 * The `browser` field as a MAP. Node ignores it; bundlers honour it; a browser runtime that ignored
 * it would load the `fs`-using half of a hundred packages. Returns the replacement for `request`
 * seen from `fromDir`, `EMPTY_MODULE` for a `false`, or `null` for "not mapped".
 */
export function applyBrowserMap(request: string, fromDir: string, host: ResolveHost): string | null {
  if (!host.conditions.includes("browser")) return null;
  const packageDir = findPackageDir(fromDir, host);
  if (!packageDir) return null;
  const pkg = host.readJson(`${packageDir}/package.json`);
  const map = pkg?.browser;
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const table = map as Record<string, unknown>;
  const keys: string[] = [request];
  if (request.startsWith(".")) {
    // A relative request is keyed in the map by its path relative to the package root.
    const abs = resolveAbs(fromDir, request);
    const rel = abs.startsWith(`${packageDir}/`) ? abs.slice(packageDir.length + 1) : abs;
    keys.push(`./${rel}`, `./${rel}.js`, rel);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(table, key)) continue;
    const value = table[key];
    if (value === false) return EMPTY_MODULE;
    if (typeof value !== "string") continue;
    return value.startsWith(".") ? resolveAbs(packageDir, value) : value;
  }
  return null;
}

/** The nearest ancestor directory holding a `package.json`, stopping at the workspace root. */
export function findPackageDir(fromDir: string, host: ResolveHost): string | null {
  let dir = normalizeAbs(fromDir);
  const stop = normalizeAbs(host.root);
  for (;;) {
    if (host.isFile(`${dir}/package.json`)) return dir;
    if (dir === stop || dir === "/") return null;
    const parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `#internal` requests: the `imports` field of the nearest package. */
function resolveImports(request: string, fromDir: string, host: ResolveHost): string | null {
  const packageDir = findPackageDir(fromDir, host);
  if (!packageDir) return null;
  const pkg = host.readJson(`${packageDir}/package.json`);
  const imports = pkg?.imports;
  if (!imports || typeof imports !== "object") return null;
  const map = imports as Record<string, unknown>;
  const direct = Object.prototype.hasOwnProperty.call(map, request) ? resolveTarget(map[request], packageDir, null, host) : null;
  if (direct) return loadAsFile(direct, host) ?? loadIndex(direct, host);
  for (const key of Object.keys(map)) {
    const at = key.indexOf("*");
    if (at < 0) continue;
    const head = key.slice(0, at);
    const tail = key.slice(at + 1);
    if (!request.startsWith(head) || !request.endsWith(tail)) continue;
    const star = request.slice(head.length, request.length - tail.length);
    const target = resolveTarget(map[key], packageDir, star, host);
    if (target) return loadAsFile(target, host) ?? loadIndex(target, host);
  }
  return null;
}

/**
 * The whole algorithm. Returns an absolute virtual path, `EMPTY_MODULE`, or `null` when nothing
 * resolved — the caller decides what "not found" reads like, because it knows the request's origin.
 */
export function resolveRequest(request: string, fromDir: string, host: ResolveHost): string | null {
  const mapped = applyBrowserMap(request, fromDir, host);
  if (mapped === EMPTY_MODULE) return EMPTY_MODULE;
  const target = mapped ?? request;
  if (target.startsWith("#")) return resolveImports(target, fromDir, host);
  if (target.startsWith("/") || target.startsWith("./") || target.startsWith("../")) {
    const abs = target.startsWith("/") ? normalizeAbs(target) : resolveAbs(fromDir, target);
    return loadAsFile(abs, host) ?? loadAsDirectory(abs, host);
  }
  // Bare. `mapped` may have turned a relative request into a bare one; that is the browser map's job.
  const { name, subpath } = splitBareRequest(target);
  for (const dir of nodeModulesPaths(fromDir, host.root)) {
    const packageDir = `${dir}/${name}`;
    if (!host.isDirectory(packageDir)) continue;
    const viaExports = loadAsDirectory(packageDir, host, subpath);
    if (viaExports) return viaExports;
    if (subpath === ".") continue;
    // A package that DECLARES `exports` hides everything the map does not name, even a file that is
    // right there. That is the whole point of the field, and a runtime that fell back to the raw
    // path would let a workspace depend on internals the package deliberately closed.
    const manifest = host.readJson(`${packageDir}/package.json`);
    if (manifest?.exports !== undefined && manifest.exports !== null) {
      throw new NodeCompatError(
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        `Package subpath '${subpath}' is not defined by "exports" in ${packageDir}/package.json`,
      );
    }
    const abs = normalizeAbs(`${packageDir}/${subpath.slice(2)}`);
    const found = loadAsFile(abs, host) ?? loadAsDirectory(abs, host);
    if (found) return found;
  }
  return null;
}
