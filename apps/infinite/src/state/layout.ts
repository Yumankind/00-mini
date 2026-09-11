/**
 * Simple shell or power shell, and what "power" looks like at this width (§1).
 *
 * ONE RULE, STATED ONCE. The plan gives the power shell an IDE layout — files left, editor or
 * preview centre, chat right, terminal below — and the same app is a phone browser's. Four panes do
 * not fit on 375 px, and pretending they do is how a product grows a second layout nobody maintains.
 * So: below 1024 px the power shell keeps the SAME panes and turns them into tabs. `layoutMode` is
 * the whole decision, it is pure, and it is the thing the test pins.
 *
 * WHERE THE FLAG LIVES. `localStorage`, not the settings KV in `lib/kv.ts` — that file belongs to
 * another workstream this round and a new key in it is a merge conflict for a one-bit preference.
 * The trade is visible and small: a browser with storage blocked opens in simple mode every time,
 * which is the right default anyway. Move it to the KV when the file is quiet.
 */
import { computed, ref } from "vue";

/** The width at which four panes stop being cramped. Matches Tailwind's `lg`, which the markup uses. */
export const POWER_BREAKPOINT = 1024;

const POWER_STORAGE_KEY = "00.infinite.powerShell";
const RAIL_STORAGE_KEY = "00.infinite.sidebarRail";

export type LayoutMode = "simple" | "ide" | "tabs";
export type PowerPane = "files" | "editor" | "preview" | "git" | "chat" | "terminal";

export const POWER_PANES: { id: PowerPane; label: string; icon: string }[] = [
  { id: "files", label: "Files", icon: "folder" },
  { id: "editor", label: "Editor", icon: "file-text" },
  { id: "preview", label: "Preview", icon: "world" },
  { id: "git", label: "Git", icon: "history" },
  { id: "chat", label: "Chat", icon: "message-2" },
  { id: "terminal", label: "Terminal", icon: "chevron-right" },
];

/**
 * The workspace panel's own tabs — the panes above, without `chat`: the thread is beside the panel
 * on a desk and one of the four bottom-bar destinations on a phone, never a tab inside it.
 */
export const WORKSPACE_PANES = POWER_PANES.filter((p) => p.id !== "chat");

/** The one rule. `power` off is always the simple shell, at every width. */
export function layoutMode(width: number, power: boolean): LayoutMode {
  if (!power) return "simple";
  return width >= POWER_BREAKPOINT ? "ide" : "tabs";
}

// ── The store ─────────────────────────────────────────────────────────────────────────────────────

const power = ref(false);
const width = ref(typeof window === "undefined" ? 1280 : window.innerWidth);
const pane = ref<PowerPane>("files");
const terminalOpen = ref(true);
/** Which of the two centre panes is showing — the editor, or the rendered page. */
const centre = ref<"editor" | "preview">("editor");
/** The left sidebar, narrowed to its icon rail. A preference, remembered like the power flag. */
const rail = ref(false);

export const powerShell = computed(() => power.value);
/**
 * THE SAME BOOLEAN, IN THE WORDS THE SHELL NOW USES. The redesign turned "the power shell" into
 * "the workspace panel beside the thread" — the panes, the breakpoint rule and the storage key are
 * unchanged, so this is an alias and not a second flag: two names for one bit is a bug waiting for
 * a busy afternoon.
 */
export const workspaceOpen = computed(() => power.value);
export const sidebarRail = computed(() => rail.value);
export const viewportWidth = computed(() => width.value);
export const mode = computed(() => layoutMode(width.value, power.value));
export const powerPane = computed(() => pane.value);
export const centrePane = computed(() => centre.value);
export const terminalVisible = computed(() => terminalOpen.value);

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* a browser that will not remember still switches for this session */
  }
}

/** Called once at mount; returns the teardown the shell holds with its other listeners. */
export function startLayout(): () => void {
  power.value = readFlag(POWER_STORAGE_KEY);
  rail.value = readFlag(RAIL_STORAGE_KEY);
  const onResize = (): void => {
    width.value = window.innerWidth;
  };
  onResize();
  window.addEventListener("resize", onResize, { passive: true });
  return () => window.removeEventListener("resize", onResize);
}

export function setPower(next: boolean): void {
  power.value = next;
  writeFlag(POWER_STORAGE_KEY, next);
}

export function togglePower(): void {
  setPower(!power.value);
}

/** The workspace panel's own words for the same switch. */
export function toggleWorkspace(): void {
  setPower(!power.value);
}

/** Open the panel ON a given pane — what the sidebar's Files/Git/Terminal/Preview buttons do. */
export function openWorkspace(next: PowerPane): void {
  showPane(next);
  setPower(true);
}

export function setSidebarRail(next: boolean): void {
  rail.value = next;
  writeFlag(RAIL_STORAGE_KEY, next);
}

export function toggleSidebarRail(): void {
  setSidebarRail(!rail.value);
}

export function showPane(next: PowerPane): void {
  pane.value = next;
  if (next === "editor" || next === "preview") centre.value = next;
}

export function showCentre(next: "editor" | "preview"): void {
  centre.value = next;
  pane.value = next;
}

export function toggleTerminal(): void {
  terminalOpen.value = !terminalOpen.value;
}

/** Test seam, and what a Restore calls. */
export function resetLayout(): void {
  power.value = false;
  rail.value = false;
  pane.value = "files";
  centre.value = "editor";
  terminalOpen.value = true;
  width.value = 1280;
}

/** Only a test sets a width by hand; the app has a resize listener. */
export function setViewportWidth(next: number): void {
  width.value = next;
}
