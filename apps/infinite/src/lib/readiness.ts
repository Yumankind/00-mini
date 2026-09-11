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
    // §8.4's brain: the agent on the person's own Mac, named by where it is rather than what it runs.
    case "remote-mac":
    case "remote":
      return "Your Mac";
    default:
      return providerId;
  }
}

/**
 * The download percentage, from the TYPED `progress` the contract revision of 2026-09-10 added.
 *
 * The sentence-parsing path is kept behind it, and is not dead code: `detail` is still free-form, a
 * provider written against the older contract fills only that, and a percentage a person can see in
 * the status line but not in the bar would be a UI arguing with itself. Typed first, words second,
 * and nothing invented when neither says.
 */
export function downloadPercent(readiness?: Readiness | string): number | null {
  if (typeof readiness === "object") {
    if (readiness.ready) return null;
    const p = readiness.progress;
    // A compile has no percentage; a bar frozen at 100 while it runs is the "stuck" look.
    if (p?.phase === "load") return null;
    if (p?.percent !== undefined) return clampPercent(p.percent);
    // Bytes with no total is an honest "we do not know how far this is": no bar, and the byte count
    // is what a card shows instead.
    if (p && p.totalBytes) return clampPercent((p.loadedBytes / p.totalBytes) * 100);
    return fromDetail(readiness.detail);
  }
  return fromDetail(readiness);
}

function clampPercent(value: number): number | null {
  const n = Math.round(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

/** "42%", "42", "loading 42.5%" — and a refusal for anything else. */
function fromDetail(detail?: string): number | null {
  if (!detail) return null;
  const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(detail) ?? /^\s*(\d{1,3}(?:\.\d+)?)\s*$/.exec(detail);
  if (!m) return null;
  return clampPercent(Number(m[1]));
}

/** `1.4 GB`, `250 MB` — the unit a two-gigabyte model download is honestly measured in. */
export function formatBytes(bytes?: number): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return null;
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** `1.2 GB of 2.0 GB` while a download is running, or null when there is nothing to say. */
export function progressLine(r: Readiness): string | null {
  if (r.ready || !r.progress) return null;
  const loaded = formatBytes(r.progress.loadedBytes);
  if (!loaded) return null;
  const total = formatBytes(r.progress.totalBytes);
  return total ? `${loaded} of ${total}` : loaded;
}

/** The tail of the status line: what this provider needs before it can answer. */
export function readinessPhrase(r: Readiness): string {
  if (r.ready) return "ready";
  switch (r.reason) {
    case "download": {
      const pct = downloadPercent(r);
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
