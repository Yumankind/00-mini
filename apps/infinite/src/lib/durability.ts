/**
 * Storage durability, said out loud — docs/HANDOFF-infinite-agent.md §3.3.
 *
 * WHY THE ANSWER IS SHOWN AND NOT SWALLOWED. `navigator.storage.persist()` can say no, and on Safari
 * it effectively does: script-writable storage of a site the person has not opened for seven days is
 * evicted unless the site is installed to the home screen. §3.3's instruction is to call it on first
 * agent creation and SHOW THE ANSWER, then nag once to install and offer Backup from day one. This
 * module is that honesty: it reports what the browser actually said, never a reassuring guess.
 */

export type PersistVerdict = "granted" | "refused" | "unsupported";

export interface DurabilityReport {
  verdict: PersistVerdict;
  /** Bytes this origin is using, when the browser will say. */
  usage?: number;
  quota?: number;
}

export async function requestPersistence(): Promise<DurabilityReport> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return { verdict: "unsupported" };
  let verdict: PersistVerdict;
  try {
    verdict = (await navigator.storage.persist()) ? "granted" : "refused";
  } catch {
    verdict = "unsupported";
  }
  let usage: number | undefined;
  let quota: number | undefined;
  try {
    const est = await navigator.storage.estimate?.();
    usage = est?.usage;
    quota = est?.quota;
  } catch {
    /* an estimate is a nicety; its absence changes nothing */
  }
  return { verdict, usage, quota };
}

export function persistLine(report: DurabilityReport): string {
  switch (report.verdict) {
    case "granted":
      return "This browser has promised to keep your agent. Back it up anyway.";
    case "refused":
      return "This browser would not promise to keep your agent — install the app and keep a backup.";
    default:
      return "This browser cannot promise anything about keeping your agent. Keep a backup.";
  }
}

export function persistTone(report: DurabilityReport): "ok" | "warn" {
  return report.verdict === "granted" ? "ok" : "warn";
}

/** iOS is the case §3.3 names by name, and the one where the install nag actually changes the outcome. */
export function evictionRisk(): { risky: boolean; why: string } {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const isWebkit = /Safari/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  const installed =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true);
  if (installed) return { risky: false, why: "Installed to the home screen — storage is not evicted." };
  if (isWebkit) {
    return {
      risky: true,
      why: "Safari clears storage for sites you have not opened in seven days. Add this to your home screen to stop that.",
    };
  }
  return { risky: false, why: "" };
}

export function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}
