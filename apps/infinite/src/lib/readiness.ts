/**
 * Provider readiness → the one line the UI shows for it.
 *
 * WHY A MODULE AND NOT AN INLINE TERNARY. The same sentence appears in three places — the boot
 * screen's "Local AI · …" progress line (§4.1), the brain card in Connections (§6.1) and the header
 * chip — and they must never disagree. `readiness()` is also the ONLY thing the contract gives us to
 * distinguish "downloading" from "this browser has no WebGPU", so the mapping from its four reasons
 * to human words is the whole of what the person is told.
 */
import type { ModelProvider } from "@00/agent-models";

export type Readiness = Awaited<ReturnType<ModelProvider["readiness"]>>;
export type ReadyTone = "ok" | "busy" | "warn" | "off";

/** The four peers of §6.1, by the provider ids the contract fixes. */
export function brainLabel(providerId: string): string {
  if (providerId.startsWith("byok:")) {
    const vendor = providerId.slice(5).trim();
    return vendor ? `Your key · ${vendor}` : "Your key";
  }
  switch (providerId) {
    case "local":
      return "Local AI";
    case "sponsored":
      return "Sponsored";
    case "overblast":
      return "Overblast";
    // The card exists before a vendor is picked, and "byok" is jargon on a screen that has none.
    case "byok":
      return "Your key";
    default:
      return providerId;
  }
}

/**
 * A percentage out of a provider's free-form `detail`. The contract does not type the download
 * progress, so this reads what a provider is likely to put there ("42%", "42", "loading 42.5%") and
 * refuses everything else rather than inventing a number.
 */
export function downloadPercent(detail?: string): number | null {
  if (!detail) return null;
  const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(detail) ?? /^\s*(\d{1,3}(?:\.\d+)?)\s*$/.exec(detail);
  if (!m) return null;
  const n = Math.round(Number(m[1]));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

/** The tail of the status line: what this provider needs before it can answer. */
export function readinessPhrase(r: Readiness): string {
  if (r.ready) return "ready";
  switch (r.reason) {
    case "download": {
      const pct = downloadPercent(r.detail);
      return pct === null ? "downloading" : `downloading ${pct}%`;
    }
    case "unsupported":
      return "unsupported here";
    case "credential":
      return r.detail?.trim() || "needs a sign-in";
    case "offline":
      return "offline";
    default:
      return "unavailable";
  }
}

/** `Local AI · downloading 42%` — the exact shape §4.1 asks the boot screen to show. */
export function statusLine(providerId: string, r: Readiness): string {
  return `${brainLabel(providerId)} · ${readinessPhrase(r)}`;
}

export function statusTone(r: Readiness): ReadyTone {
  if (r.ready) return "ok";
  if (r.reason === "download") return "busy";
  if (r.reason === "unsupported") return "off";
  return "warn";
}

/** A provider that cannot answer yet is still selectable when the only thing missing is a download. */
export function isUsable(r: Readiness): boolean {
  return r.ready;
}
