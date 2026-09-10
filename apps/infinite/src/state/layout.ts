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

export const powerShell = computed(() => power.value);
export const viewportWidth = computed(() => width.value);
export const mode = computed(() => layoutMode(width.value, power.value));
export const powerPane = computed(() => pane.value);
export const centrePane = computed(() => centre.value);
export const terminalVisible = computed(() => terminalOpen.value);

function readFlag(): boolean {
  try {
    return localStorage.getItem(POWER_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Called once at mount; returns the teardown the shell holds with its other listeners. */
export function startLayout(): () => void {
  power.value = readFlag();
  const onResize = (): void => {
    width.value = window.innerWidth;
  };
  onResize();
  window.addEventListener("resize", onResize, { passive: true });
  return () => window.removeEventListener("resize", onResize);
}

export function setPower(next: boolean): void {
  power.value = next;
  try {
    localStorage.setItem(POWER_STORAGE_KEY, next ? "1" : "0");
  } catch {
    /* a browser that will not remember still switches for this session */
  }
}

export function togglePower(): void {
  setPower(!power.value);
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
  pane.value = "files";
  centre.value = "editor";
  terminalOpen.value = true;
  width.value = 1280;
}

/** Only a test sets a width by hand; the app has a resize listener. */
export function setViewportWidth(next: number): void {
  width.value = next;
}
