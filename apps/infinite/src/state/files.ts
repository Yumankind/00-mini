/**
 * The Files pane — a tree over `AgentFs` and a read-only viewer.
 *
 * READ-ONLY IS THE POINT, not a missing feature. The person edits through the agent (that is what the
 * approvals door is for); a second, silent write path into the same folder would be a way to change
 * files the agent has already read this turn, with nothing in the session saying it happened.
 */
import { computed, ref, shallowRef } from "vue";
import { ancestors, buildTree, isTextPath, type TreeNode } from "../lib/files-tree.js";
import { walkAll } from "../runtime/bootstrap.js";
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

export function toggleFolder(path: string): void {
  const next = new Set(expanded.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expanded.value = next;
}

const VIEWER_MAX_CHARS = 200_000;

export async function openFile(path: string): Promise<void> {
  const owned = agent.value;
  if (!owned) return;
  selected.value = path;
  contents.value = null;
  error.value = null;
  if (!isTextPath(path)) {
    contents.value = null;
    error.value = "Not a text file — the viewer only opens what it can honestly render.";
    return;
  }
  try {
    const text = await owned.fs.readText(path);
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
}

export function resetFiles(): void {
  tree.value = [];
  expanded.value = new Set(["workspace"]);
  closeFile();
}
