/**
 * The Files pane — a tree over `AgentFs`, a viewer, and (since the power shell, B7) writing.
 *
 * WHY IT IS NO LONGER READ-ONLY. The old rule here was that a second, silent write path into the
 * agent's folder would be a way to change files the agent had already read this turn, with nothing
 * in the session saying it happened. That reasoning was right about SILENT and wrong about the
 * SECOND path: the plan's §1 gives the owned agent a power shell with an editor and a file manager,
 * and §4.5 states the rule that settles it — in the owned agent the owner IS at the machine. So the
 * writes are here, and the objection is answered rather than avoided:
 *
 *   - every write goes through the SAME `AgentFs` the tools use, so the agent's next `read` sees it
 *     and the runtime's read-before-overwrite guard (`SeenFiles`) treats it as the change it is;
 *   - every write refreshes this tree, so the pane never shows a folder that is no longer true;
 *   - the editor compares mtime before saving over something the agent changed underneath, and
 *     offers to reload rather than clobbering it.
 *
 * WHY THE TREE COMES FROM ONE FLAT WALK: see `lib/files-tree.ts`. The local mutations there are the
 * echo of a write that has already happened, never a prediction of one.
 */
import { computed, ref, shallowRef } from "vue";
import type { AgentEvent } from "@00/agent-runtime";
import {
  EDITOR_MAX_BYTES,
  ancestors,
  baseName,
  buildTree,
  childNames,
  findNode,
  insertNode,
  isEditablePath,
  isMarkdownPath,
  isTextPath,
  joinPath,
  nameProblem,
  parentOf,
  removeNode,
  renameNode,
  type TreeNode,
} from "../lib/files-tree.js";
import { walkAll } from "../runtime/bootstrap.js";
import { changedUnderneath } from "../power/editor.js";
import { agent } from "./agent.js";

const tree = shallowRef<TreeNode[]>([]);
const expanded = ref<Set<string>>(new Set(["workspace"]));
const selected = ref<string | null>(null);
const contents = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

export const fileTree = computed(() => tree.value);
export const openFolders = computed(() => expanded.value);
export const selectedPath = computed(() => selected.value);
export const fileText = computed(() => contents.value);
export const filesLoading = computed(() => loading.value);
export const filesError = computed(() => error.value);

// ── The editor (§1's centre pane) ────────────────────────────────────────────────────────────────

const draft = ref("");
const savedText = ref("");
const openedStat = ref<{ mtime: number; size: number } | null>(null);
const editable = ref(false);
const stale = ref(false);
const saving = ref(false);
const markdownPreview = ref(false);

export const editorText = computed(() => draft.value);
export const editorDirty = computed(() => draft.value !== savedText.value);
export const editorEditable = computed(() => editable.value);
export const editorStale = computed(() => stale.value);
export const editorSaving = computed(() => saving.value);
export const editorMarkdown = computed(() => selected.value !== null && isMarkdownPath(selected.value));
export const editorPreviewing = computed(() => markdownPreview.value && editorMarkdown.value);

export function toggleMarkdownPreview(): void {
  markdownPreview.value = !markdownPreview.value;
}

export function setEditorText(next: string): void {
  draft.value = next;
}

// ── Reading ───────────────────────────────────────────────────────────────────────────────────────

export async function refreshFiles(): Promise<void> {
  const owned = agent.value;
  if (!owned) return;
  loading.value = true;
  error.value = null;
  try {
    tree.value = buildTree(await walkAll(owned.fs));
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    tree.value = [];
  } finally {
    loading.value = false;
  }
}

/**
 * The last row a person touched, file or folder. It is what "new file", "upload" and drag-drop mean
 * by HERE — a file manager whose New button always wrote to the root would be a worse tool than no
 * New button. A file's `here` is its folder, which is the answer every desktop gives.
 */
const focused = ref<string>("workspace");
export const focusedPath = computed(() => focused.value);
export const activeDir = computed(() => {
  const node = findNode(tree.value, focused.value);
  if (node?.kind === "dir") return node.path;
  return parentOf(focused.value) || "workspace";
});

export function focusNode(path: string): void {
  focused.value = path;
}

export function toggleFolder(path: string): void {
  const next = new Set(expanded.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expanded.value = next;
}

export function expandFolder(path: string): void {
  const next = new Set(expanded.value);
  for (const dir of [...ancestors(path), path]) next.add(dir);
  expanded.value = next;
}

const VIEWER_MAX_CHARS = 200_000;

export async function openFile(path: string): Promise<void> {
  const owned = agent.value;
  if (!owned) return;
  selected.value = path;
  contents.value = null;
  error.value = null;
  stale.value = false;
  markdownPreview.value = isMarkdownPath(path);
  const stat = await owned.fs.stat(path).catch(() => null);
  openedStat.value = stat ? { mtime: stat.mtime, size: stat.size } : null;
  editable.value = isEditablePath(path, stat?.size ?? 0);

  if (!isTextPath(path)) {
    draft.value = "";
    savedText.value = "";
    error.value = "Not a text file — the viewer only opens what it can honestly render.";
    return;
  }
  if (!editable.value) {
    // Over a megabyte the editor would be a way to hang the tab; the viewer still shows the head.
    error.value = `Over ${(EDITOR_MAX_BYTES / 1024 / 1024).toFixed(0)} MB — opened read-only.`;
  }
  try {
    const text = await owned.fs.readText(path);
    draft.value = text;
    savedText.value = text;
    contents.value =
      text.length > VIEWER_MAX_CHARS
        ? `${text.slice(0, VIEWER_MAX_CHARS)}\n\n… truncated at ${VIEWER_MAX_CHARS.toLocaleString()} characters.`
        : text;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/** Opening a file from elsewhere (a tool row, a search hit) reveals it in a collapsed tree. */
export async function reveal(path: string): Promise<void> {
  const next = new Set(expanded.value);
  for (const dir of ancestors(path)) next.add(dir);
  expanded.value = next;
  await openFile(path);
}

export function closeFile(): void {
  selected.value = null;
  contents.value = null;
  error.value = null;
  draft.value = "";
  savedText.value = "";
  openedStat.value = null;
  editable.value = false;
  stale.value = false;
}

// ── Writing ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The one place a write happens, so the tree refresh and the error surface are not four copies.
 * `local` is the tree mutation that echoes the change immediately; the walk still follows, because
 * only the walk knows what the agent did in the same second.
 */
async function write(
  label: string,
  fn: (fs: NonNullable<typeof agent.value>["fs"]) => Promise<void>,
  local?: (nodes: TreeNode[]) => TreeNode[],
): Promise<boolean> {
  const owned = agent.value;
  if (!owned) return false;
  error.value = null;
  try {
    await fn(owned.fs);
    if (local) tree.value = local(tree.value);
    await refreshFiles();
    return true;
  } catch (err) {
    error.value = `${label}: ${err instanceof Error ? err.message : String(err)}`;
    return false;
  }
}

/** The names already inside a folder, for the "already exists" refusal before the write. */
export function siblingsOf(dir: string): string[] {
  return childNames(tree.value, dir);
}

export function checkName(dir: string, name: string): string | null {
  return nameProblem(name, siblingsOf(dir));
}

export async function createFile(dir: string, name: string): Promise<boolean> {
  const problem = checkName(dir, name);
  if (problem) {
    error.value = problem;
    return false;
  }
  const path = joinPath(dir, name.trim());
  const done = await write("New file", (fs) => fs.writeFile(path, ""), (nodes) => insertNode(nodes, path, "file"));
  if (done) {
    expandFolder(dir);
    await openFile(path);
  }
  return done;
}

export async function createFolder(dir: string, name: string): Promise<boolean> {
  const problem = checkName(dir, name);
  if (problem) {
    error.value = problem;
    return false;
  }
  const path = joinPath(dir, name.trim());
  const done = await write("New folder", (fs) => fs.mkdir(path), (nodes) => insertNode(nodes, path, "dir"));
  if (done) expandFolder(path);
  return done;
}

export async function renamePath(path: string, name: string): Promise<boolean> {
  const dir = parentOf(path);
  const problem = nameProblem(name, siblingsOf(dir).filter((n) => n !== baseName(path)));
  if (problem) {
    error.value = problem;
    return false;
  }
  const next = joinPath(dir, name.trim());
  const done = await write("Rename", (fs) => fs.rename(path, next), (nodes) => renameNode(nodes, path, name.trim()));
  if (done && selected.value === path) await openFile(next);
  return done;
}

export async function deletePath(path: string): Promise<boolean> {
  const done = await write("Delete", (fs) => fs.remove(path), (nodes) => removeNode(nodes, path));
  if (done && selected.value === path) closeFile();
  return done;
}

/**
 * An upload is a write like any other — the bytes land in the agent's folder where the agent can
 * read them, not in a staging area it would have to be told about.
 */
export async function uploadInto(dir: string, files: { name: string; bytes: Uint8Array }[]): Promise<number> {
  let written = 0;
  for (const file of files) {
    const safe = baseName(file.name).replace(/[\0/\\]/g, "-");
    const done = await write("Upload", (fs) => fs.writeFile(joinPath(dir, safe), file.bytes));
    if (done) written++;
  }
  if (written) expandFolder(dir);
  return written;
}

/** The bytes of a file, for the pane's download button. */
export async function readBytes(path: string): Promise<Uint8Array | null> {
  const owned = agent.value;
  if (!owned) return null;
  try {
    return await owned.fs.readFile(path);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return null;
  }
}

// ── Saving ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Cmd/Ctrl+S. It re-stats first: if the agent wrote the file while it was open, saving would throw
 * the agent's work away silently, so the save is refused once and the pane offers the reload. A
 * second save after that warning goes through — the person has been told, and it is their file.
 */
export async function saveOpenFile(force = false): Promise<boolean> {
  const owned = agent.value;
  const path = selected.value;
  if (!owned || !path || !editable.value || saving.value) return false;
  saving.value = true;
  error.value = null;
  try {
    const current = await owned.fs.stat(path);
    const currentStat = current ? { mtime: current.mtime, size: current.size } : null;
    if (!force && changedUnderneath(openedStat.value, currentStat)) {
      stale.value = true;
      error.value = "Your agent changed this file while it was open. Reload it, or save again to overwrite.";
      return false;
    }
    await owned.fs.writeFile(path, draft.value);
    savedText.value = draft.value;
    stale.value = false;
    const after = await owned.fs.stat(path);
    openedStat.value = after ? { mtime: after.mtime, size: after.size } : null;
    contents.value = draft.value;
    await refreshFiles();
    return true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    saving.value = false;
  }
}

export async function reloadFromDisk(): Promise<void> {
  const path = selected.value;
  if (path) await openFile(path);
}

// ── The agent's own writes ───────────────────────────────────────────────────────────────────────

let detachFiles: (() => void) | null = null;

/**
 * `file_changed` is on the contract's bus, so the pane never has to poll. A change to the file that
 * is OPEN raises the stale flag instead of reloading it — a textarea that swapped its text under a
 * cursor would lose whatever was half-typed.
 */
export function watchFileChanges(): () => void {
  const owned = agent.value;
  if (!owned || detachFiles) return () => undefined;
  const onEvent = (event: AgentEvent): void => {
    if (event.type !== "file_changed") return;
    if (event.path === selected.value) stale.value = true;
    void refreshFiles();
  };
  detachFiles = owned.runtime.on(onEvent);
  return () => {
    detachFiles?.();
    detachFiles = null;
  };
}

export function nodeAt(path: string): TreeNode | null {
  return findNode(tree.value, path);
}

export function resetFiles(): void {
  tree.value = [];
  expanded.value = new Set(["workspace"]);
  detachFiles?.();
  detachFiles = null;
  closeFile();
}
