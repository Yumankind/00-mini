/**
 * The Files pane's tree, built from what `AgentFs.walk()` yields.
 *
 * WHY BUILD IT FROM A FLAT WALK. The contract (packages/agent-fs/src/types.ts) gives `walk()` a
 * depth-first stream of FILES with relative paths, and `readdir()` a single level. Walking once and
 * folding the paths into a tree is one pass and one await instead of one round trip per directory,
 * which on OPFS is the difference between an instant pane and a visible stagger. Directories that
 * hold only files therefore appear because their files do, which is also why an empty directory does
 * not appear at all — the honest limitation of a file walk, and not worth a second traversal.
 */
import type { FsStat } from "@00/agent-fs";

export interface TreeNode {
  name: string;
  /** Full path from the agent root, the shape every AgentFs call wants. */
  path: string;
  kind: "file" | "dir";
  size: number;
  children?: TreeNode[];
}

export interface WalkedFile {
  path: string;
  stat: Pick<FsStat, "size">;
}

export function buildTree(files: WalkedFile[], root = ""): TreeNode[] {
  const dirs = new Map<string, TreeNode>();
  const top: TreeNode[] = [];

  const dirFor = (path: string): TreeNode[] => {
    if (path === "") return top;
    const existing = dirs.get(path);
    if (existing) return existing.children!;
    const slash = path.lastIndexOf("/");
    const parent = slash === -1 ? "" : path.slice(0, slash);
    const node: TreeNode = {
      name: slash === -1 ? path : path.slice(slash + 1),
      path: root ? `${root}/${path}` : path,
      kind: "dir",
      size: 0,
      children: [],
    };
    dirs.set(path, node);
    dirFor(parent).push(node);
    return node.children!;
  };

  for (const f of files) {
    const slash = f.path.lastIndexOf("/");
    const dir = slash === -1 ? "" : f.path.slice(0, slash);
    dirFor(dir).push({
      name: slash === -1 ? f.path : f.path.slice(slash + 1),
      path: root ? `${root}/${f.path}` : f.path,
      kind: "file",
      size: f.stat.size,
    });
  }

  // Sizes roll up so a folder can say how much of the origin's storage it is.
  const roll = (nodes: TreeNode[]): number => {
    let total = 0;
    for (const n of nodes) {
      if (n.kind === "dir") n.size = roll(n.children!);
      total += n.size;
    }
    return total;
  };
  roll(top);
  return sortTree(top);
}

/** Folders first, then files, each alphabetical — the order every file pane in 00 uses. */
export function sortTree(nodes: TreeNode[]): TreeNode[] {
  const sorted = [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const n of sorted) if (n.children) n.children = sortTree(n.children);
  return sorted;
}

const TEXT_EXT = new Set([
  "md", "txt", "json", "jsonl", "yml", "yaml", "toml", "csv", "tsv", "log", "ts", "tsx", "js", "jsx",
  "mjs", "cjs", "css", "html", "svg", "xml", "sh", "py", "rs", "go", "rb", "sql", "env", "gitignore",
  "00ignore", "ini", "conf",
]);

/** The read-only viewer only opens what it can honestly render as text. */
export function isTextPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name.startsWith(".") && !name.includes(".", 1)) return true; // .00ignore, .gitignore
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return TEXT_EXT.has(ext);
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Every ancestor of a path, so opening a file can reveal it in a collapsed tree. */
export function ancestors(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  const out: string[] = [];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    out.push(acc);
  }
  return out;
}

// ── Mutations, added with the power shell's file manager (B7) ─────────────────────────────────────
//
// WHY THE TREE IS EDITED IN PLACE RATHER THAN RE-WALKED. A rename inside a 4 000-file agent is one
// `AgentFs.rename` and one node moving; re-walking the whole folder to see it costs a second pass
// over OPFS and, worse, collapses nothing and re-sorts everything, so the row a person just renamed
// jumps somewhere else while their finger is still on it. The walk stays the source of truth (the
// pane reloads on the agent's own `file_changed`); these are the local echoes that keep a click
// feeling like a click. Every one of them is pure: nodes in, new nodes out.

/** `a/b/c.md` → `a/b`; a top-level path's parent is `""`. */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** `a/b/c.md` → `c.md`. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/**
 * Why a name is refused, or `null`. The rules are the filesystem's own (`assertRelativePath`), said
 * before the write rather than after it, so a person sees "no slashes" under the field rather than a
 * thrown adapter error in a toast.
 */
export function nameProblem(name: string, siblings: string[] = []): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A name is needed.";
  if (trimmed.includes("/")) return "No slashes — make a folder instead.";
  if (trimmed === "." || trimmed === "..") return "That name means something else to a filesystem.";
  if (/[\0\\]/.test(trimmed)) return "That character cannot be in a file name.";
  if (siblings.includes(trimmed)) return "Something here already has that name.";
  return null;
}

export function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/** The names directly inside `dir` — what `nameProblem` needs to refuse a collision. */
export function childNames(nodes: TreeNode[], dir: string): string[] {
  const list = dir === "" ? nodes : findNode(nodes, dir)?.children ?? [];
  return list.map((n) => n.name);
}

function mapChildren(nodes: TreeNode[], dir: string, fn: (children: TreeNode[]) => TreeNode[]): TreeNode[] {
  if (dir === "") return sortTree(fn(nodes));
  return nodes.map((n) => {
    if (n.path === dir && n.kind === "dir") return { ...n, children: sortTree(fn(n.children ?? [])) };
    if (n.children) return { ...n, children: mapChildren(n.children, dir, fn) };
    return n;
  });
}

/** Add a file or folder that was just written. A path whose parent is not in the tree is ignored. */
export function insertNode(nodes: TreeNode[], path: string, kind: "file" | "dir", size = 0): TreeNode[] {
  const dir = parentOf(path);
  if (dir && !findNode(nodes, dir)) return nodes;
  if (findNode(nodes, path)) return nodes;
  const node: TreeNode = { name: baseName(path), path, kind, size, ...(kind === "dir" ? { children: [] } : {}) };
  return mapChildren(nodes, dir, (children) => [...children, node]);
}

/** Drop a node and everything under it. */
export function removeNode(nodes: TreeNode[], path: string): TreeNode[] {
  return mapChildren(nodes, parentOf(path), (children) => children.filter((c) => c.path !== path));
}

/** Rename in place — the node keeps its children, whose paths are rewritten under the new prefix. */
export function renameNode(nodes: TreeNode[], path: string, name: string): TreeNode[] {
  const target = findNode(nodes, path);
  if (!target) return nodes;
  const next = joinPath(parentOf(path), name);
  const rewrite = (node: TreeNode, from: string, to: string): TreeNode => ({
    ...node,
    path: to,
    name: baseName(to),
    ...(node.children ? { children: node.children.map((c) => rewrite(c, from, `${to}/${c.name}`)) } : {}),
  });
  return mapChildren(nodes, parentOf(path), (children) =>
    children.map((c) => (c.path === path ? rewrite(c, path, next) : c)),
  );
}

/** Every file path under a node, for a folder download or a size count. */
export function filesUnder(node: TreeNode): string[] {
  if (node.kind === "file") return [node.path];
  return (node.children ?? []).flatMap(filesUnder);
}

// ── What the editor will open ────────────────────────────────────────────────────────────────────

/** Past this the textarea editor stops being an editor and starts being a way to hang a tab. */
export const EDITOR_MAX_BYTES = 1_048_576;

/**
 * Editable = text by extension AND small enough to hold in a textarea. Bigger or binary falls back
 * to the read-only viewer, which says so — an editor that opened a 40 MB log and could not save it
 * would be worse than one that refused.
 */
export function isEditablePath(path: string, size = 0): boolean {
  return isTextPath(path) && size <= EDITOR_MAX_BYTES;
}

/** The one extension the editor offers a rendered preview for. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** The one extension the preview pane will render. */
export function isPreviewablePath(path: string): boolean {
  return /\.html?$/i.test(path);
}
