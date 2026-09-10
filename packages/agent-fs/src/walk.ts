// One walk, shared by every adapter — because `walk()` is the contract's only ORDERED, BOUNDED
// operation and three hand-written traversals would drift on exactly the two things callers depend
// on: that the order is stable (a bundle's tar entries, a size preview's "heaviest paths" and a git
// status all get compared across machines) and that the entry cap is honoured before the memory is
// spent, not after. An adapter supplies `readdir`; the traversal lives here.

import type { AgentFs, FsStat } from "./types.js";
import { assertRelativePath } from "./types.js";

/** The engine's preview cap (apps/00d/src/bundle-policy.ts WALK_LIMIT), so both sides truncate alike. */
export const DEFAULT_MAX_ENTRIES = 50_000;

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Depth-first over `path`, files only, each level sorted by name, dotfiles included, directories
 * descended where their name falls in that order. `path` may be "" for the fs root. Stops once
 * `maxEntries` files have been yielded — a caller that needs to know it truncated counts what it
 * got against the cap it set.
 */
export async function* walkFs(
  fs: AgentFs,
  path: string,
  opts: { maxEntries?: number } = {},
): AsyncIterable<{ path: string; stat: FsStat }> {
  const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (max <= 0) return;
  const root = path === "" ? "" : assertRelativePath(path);
  const budget = { left: max };
  yield* walkInto(fs, root, budget);
}

async function* walkInto(
  fs: AgentFs,
  dir: string,
  budget: { left: number },
): AsyncIterable<{ path: string; stat: FsStat }> {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return; // a directory that vanished (or was never one) is not a failed walk
  }
  for (const e of [...entries].sort(byName)) {
    if (budget.left <= 0) return;
    const child = dir === "" ? e.name : `${dir}/${e.name}`;
    if (e.kind === "dir") {
      yield* walkInto(fs, child, budget);
      continue;
    }
    budget.left--;
    yield { path: child, stat: { kind: e.kind, size: e.size, mtime: e.mtime } };
  }
}

/** Split a relative path into [parentDir, name]; a root-level path's parent is "". */
export function splitPath(rel: string): [string, string] {
  const i = rel.lastIndexOf("/");
  return i < 0 ? ["", rel] : [rel.slice(0, i), rel.slice(i + 1)];
}

/** Every ancestor of `rel`, shallowest first, excluding the root and `rel` itself. */
export function ancestors(rel: string): string[] {
  const parts = rel.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}
