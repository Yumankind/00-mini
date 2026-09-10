/**
 * The install nag — ONCE — and the theme, which shares this module because both are the same kind of
 * thing: a preference that lives in this browser and travels with nothing.
 *
 * WHY ONCE IS A RULE. §3.3 says the owned agent "nags, once, to install the PWA". The reason is not
 * politeness: on Safari, installing to the home screen is the difference between storage that is
 * evicted after seven idle days and storage that is not, and a nag that appears on every visit is a
 * nag people learn to dismiss without reading. So it is shown once, its answer is remembered, and
 * Backup is offered from day one regardless — the honest fallback that needs no permission at all.
 */
import { computed, ref } from "vue";
import { evictionRisk, isInstalled } from "../lib/durability.js";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const NAG_KEY = "00.infinite.installNag";
const THEME_KEY = "00.infinite.theme";

const deferred = ref<InstallPromptEvent | null>(null);
const nagged = ref(false);
const installed = ref(false);

export const canInstall = computed(() => deferred.value !== null);
export const showInstallNag = computed(() => !nagged.value && !installed.value && (canInstall.value || evictionRisk().risky));
export const installReason = computed(() => evictionRisk().why);

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a browser that will not remember a preference still shows the app */
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function startInstallWatch(): () => void {
  installed.value = isInstalled();
  nagged.value = recall(NAG_KEY) !== null;
  const onPrompt = (event: Event) => {
    // Chromium only fires this when the app is installable; holding it is the only way to offer the
    // install from our own UI instead of the browser's mini-infobar.
    event.preventDefault();
    deferred.value = event as InstallPromptEvent;
  };
  const onInstalled = () => {
    installed.value = true;
    deferred.value = null;
    remember(NAG_KEY, "installed");
  };
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  return () => {
    window.removeEventListener("beforeinstallprompt", onPrompt);
    window.removeEventListener("appinstalled", onInstalled);
  };
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferred.value;
  dismissNag();
  if (!event) return "unavailable";
  await event.prompt();
  const { outcome } = await event.userChoice;
  deferred.value = null;
  return outcome;
}

export function dismissNag(): void {
  nagged.value = true;
  remember(NAG_KEY, "seen");
}

// ── Theme ─────────────────────────────────────────────────────────────────────────────────────────

export type ThemeChoice = "system" | "light" | "dark";

const theme = ref<ThemeChoice>("system");
export const themeChoice = computed(() => theme.value);

export function applyTheme(choice: ThemeChoice): void {
  theme.value = choice;
  remember(THEME_KEY, choice);
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function startTheme(): void {
  const saved = recall(THEME_KEY);
  applyTheme(saved === "light" || saved === "dark" ? saved : "system");
}

/** The toggle cycles system → light → dark → system, so "follow my phone" stays reachable. */
export function nextTheme(current: ThemeChoice): ThemeChoice {
  return current === "system" ? "light" : current === "light" ? "dark" : "system";
}
