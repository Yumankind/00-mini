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
