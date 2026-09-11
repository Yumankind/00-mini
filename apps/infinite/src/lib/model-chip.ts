/**
 * WHAT THE COMPOSER'S CHIP SAYS — the one sentence naming the brain that answers the NEXT message.
 *
 * WHY A MODULE AND NOT A COMPUTED IN THE COMPONENT. Three screens now name a brain: the chip in the
 * composer, the line under an assistant message that says which brain wrote it (§B20 of the gap
 * audit), and the status row that reports a download the run is waiting on (§A6). They must agree
 * word for word — "Gemma 4 E2B" in the chip and "gemma-4-E2B-it-web" under the answer would read as
 * two different models — so the naming rule lives here, pure, beside the formatting of the bytes.
 *
 * `lib/readiness.ts` stays the owner of "can this brain answer": this module never re-derives a
 * tone or a percentage, it asks that one and dresses the answer.
 */
import type { ModelClass } from "@00/agent-models";
import type { BrainId } from "./brains.js";
import { brainLabel, downloadPercent, formatBytes, statusTone, type Readiness, type ReadyTone } from "./readiness.js";

/** What `model_started` tells us about the call that is answering (contract revision 2026-09-10). */
export interface BrainStamp {
  providerId: string;
  model?: string;
  brainClass?: ModelClass;
}

/** The shape of a `ProviderHandle` this module needs — id, peer and readiness, nothing live. */
export interface ChipBrain {
  id: string;
  peer: BrainId;
  readiness: Readiness;
}

export interface ChipNames {
  /** The local row's own label, from the connection settings the two pickers share. */
  localModel?: string | null;
  /** The BYOK vendor, so the chip can say "Claude" rather than "byok:anthropic". */
  byokVendor?: string | null;
  /** The far agent's own name on the Mac (§8.4), so the chip says what is actually thinking. */
  macAgent?: string | null;
}

export interface ChipInput extends ChipNames {
  /** The settings' `selected`: a provider id (`byok:openai`), a peer id (`local`), or `auto`. */
  selected: string;
  brains: ChipBrain[];
}

/**
 * A vendor's product name, not its company name: a person who pasted an Anthropic key thinks of the
 * thing at the other end as Claude. `custom` has no name to know, so it is described instead.
 */
export const VENDOR_NAME: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
  openrouter: "OpenRouter",
  custom: "Your endpoint",
};

/** The identity half: what the brain IS, with no note about where it runs. */
export function brainShortName(brain: ChipBrain, names: ChipNames = {}): string {
  if (brain.peer === "local") return names.localModel?.trim() || "Local AI";
  if (brain.peer === "byok") {
    const vendor = names.byokVendor?.trim() || brain.id.replace(/^byok:/, "");
    return VENDOR_NAME[vendor] ?? (vendor || "Your key");
  }
  if (brain.peer === "overblast") return "Overblast";
  // The Mac names its own agent; until this browser has been admitted there, it has no name to use.
  if (brain.peer === "remote") return names.macAgent?.trim() || "Your Mac's agent";
  return "Sponsored";
}

/** The identity, then where it runs or whose it is: `Gemma 4 E2B · local`, `Claude · your key`. */
export function brainName(brain: ChipBrain, names: ChipNames = {}): string {
  const short = brainShortName(brain, names);
  switch (brain.peer) {
    case "local":
      return `${short} · local`;
    case "byok":
      return `${short} · your key`;
    case "overblast":
      return `${short} · credits`;
    case "remote":
      // Where the thinking happens is the whole point of this one, so it is the half that is named.
      return `${short} · via my Mac`;
    default:
      // "Sponsored · sponsored" says nothing twice.
      return short;
  }
}

/**
 * A run can start on a brain that is READY or one that is merely DOWNLOADING — the download is the
 * run's first minute, not a refusal (§A6). A brain that needs a key, a sign-in, WebGPU or the
 * network cannot start anything, and saying so before the message is sent is the whole of B's fix.
 */
export function canAnswer(readiness: Readiness): boolean {
  return readiness.ready || readiness.reason === "download";
}

/** What `auto` would reach for: the first ready peer, else the first that is merely downloading. */
export function autoPick(brains: ChipBrain[]): ChipBrain | null {
  return brains.find((b) => b.readiness.ready) ?? brains.find((b) => canAnswer(b.readiness)) ?? null;
}

export interface ChipLabel {
  text: string;
  tone: ReadyTone;
  /** True while the choice is `auto` — the chip draws it, and the picker keeps the row ticked. */
  auto: boolean;
  /** The brain the label is about, or null when nothing can answer. */
  brain: ChipBrain | null;
}

/** The one line on the chip. `auto` names its pick, because that is the brain answering next. */
export function chipLabel(input: ChipInput): ChipLabel {
  if (input.selected === "auto") {
    const pick = autoPick(input.brains);
    if (!pick) return { text: "Automatic · nothing ready", tone: "warn", auto: true, brain: null };
    return {
      text: `Automatic · ${brainShortName(pick, input)}`,
      tone: statusTone(pick.readiness),
      auto: true,
      brain: pick,
    };
  }
  const chosen = input.brains.find((b) => b.id === input.selected || b.peer === input.selected) ?? null;
  if (!chosen) return { text: "Choose a brain", tone: "warn", auto: false, brain: null };
  return { text: brainName(chosen, input), tone: statusTone(chosen.readiness), auto: false, brain: chosen };
}

/** The sentence under `Automatic` in the picker: what it would actually pick, in its own words. */
export function autoSentence(brains: ChipBrain[], names: ChipNames = {}): string {
  const pick = autoPick(brains);
  if (!pick) return "Nothing is ready yet — set up a brain below.";
  if (pick.readiness.ready) return `Would use ${brainShortName(pick, names)}.`;
  return `Would use ${brainShortName(pick, names)}, once it has downloaded.`;
}

/**
 * `103 of 250 MB` — the same unit written once.
 *
 * `formatBytes` is the unit rule and stays where it is; this only drops the repeated word, because
 * "103 MB of 250 MB" in a 10px chip on a 375px screen is three characters of noise in a line that
 * has no room for them. Different units keep both ("980 MB of 2.0 GB").
 */
export function compactBytes(progress?: { loadedBytes: number; totalBytes?: number }): string | null {
  if (!progress) return null;
  const loaded = formatBytes(progress.loadedBytes);
  if (!loaded) return null;
  const total = formatBytes(progress.totalBytes);
  if (!total) return loaded;
  const unit = total.slice(total.lastIndexOf(" ") + 1);
  return loaded.endsWith(` ${unit}`) ? `${loaded.slice(0, -unit.length - 1)} of ${total}` : `${loaded} of ${total}`;
}

/**
 * `Downloading Gemma 3 270m · 41% · 103 of 250 MB` — the row A6 asks for, and the chip's own line.
 *
 * ONLY WHILE BYTES ARE ACTUALLY MOVING. A provider that merely has nothing cached also answers
 * `download`, and a chip reading "Downloading" beside a bar at nothing, for a download that has not
 * been asked for, is the app talking about itself: that state is a NOTE (`pendingDownloadNote`), not
 * a progress line. Everything after the name is optional and appears only when it is known — a host
 * with no `Content-Length` gives bytes and no percent — so the line shortens rather than lying.
 */
export function downloadLine(name: string, readiness: Readiness): string | null {
  if (readiness.ready || readiness.reason !== "download" || !readiness.progress) return null;
  // The bytes are here and the runtime is compiling them: a different wait, said in its own words,
  // with no percentage (there is none to give) — Bruno saw "100 %" sit there and read it as stuck.
  if (readiness.progress.phase === "load") return `Loading ${name} into the GPU…`;
  const parts = [`Downloading ${name}`];
  const percent = downloadPercent(readiness);
  if (percent !== null) parts.push(`${percent}%`);
  const bytes = compactBytes(readiness.progress);
  if (bytes) parts.push(bytes);
  return parts.join(" · ");
}

/** What the chip says under the name when the weights are simply not here yet. Never a zero bar. */
export function pendingDownloadNote(name: string, readiness: Readiness): string | null {
  if (readiness.ready || readiness.reason !== "download" || readiness.progress) return null;
  return `${name} downloads with your next message`;
}

/**
 * A6's status row while a RUN is waiting: the same line, plus the moment before the first byte —
 * inside a run, a local brain that is not cached is not a promise about the next message, it is a
 * download about to start, and the row says so rather than going blank until the bytes move.
 */
export function runStatusLine(name: string, readiness: Readiness): string | null {
  if (readiness.ready || readiness.reason !== "download") return null;
  return downloadLine(name, readiness) ?? `Downloading ${name}…`;
}

/** `Local AI · gemma3-270m · small` — B20's line under an assistant message. */
export function answeredByLine(stamp: BrainStamp): string {
  const parts = [brainLabel(stamp.providerId)];
  if (stamp.model && stamp.model !== stamp.providerId) parts.push(stamp.model);
  if (stamp.brainClass) parts.push(stamp.brainClass);
  return parts.join(" · ");
}

/**
 * Why this message cannot be sent, named per brain — never "something went wrong".
 *
 * Null when ANY brain could start (§A6's rule: a download counts). Otherwise every peer's own
 * refusal, in the provider's words where it gave any, because "no brain is ready" without the four
 * reasons is a dead end and the four reasons are four things a person can go and fix.
 */
export function noBrainReason(brains: ChipBrain[], names: ChipNames = {}): string | null {
  if (!brains.length) return "No brain is set up yet. Choose one to answer with.";
  if (brains.some((b) => canAnswer(b.readiness))) return null;
  const reasons = brains.map((b) => `${brainShortName(b, names)} ${refusal(b.readiness)}`);
  return `No brain can answer yet — ${reasons.join(", ")}.`;
}

function refusal(readiness: Readiness): string {
  if (readiness.ready) return "is ready";
  switch (readiness.reason) {
    case "unsupported":
      return readiness.detail?.trim() || "cannot run in this browser";
    case "offline":
      return "is offline";
    case "credential":
      return readiness.detail?.trim() || "needs a sign-in";
    default:
      return "is unavailable";
  }
}

/**
 * The three settings of `RunOptions.brain` (§6, class-aware routing). A preference and never a cap:
 * the runtime still answers on what is ready, and says which class it used.
 */
export const BRAIN_CLASSES = [
  { id: "auto", label: "auto", hint: "Small for a quick question, strong after a tool result." },
  { id: "small", label: "small", hint: "Always the fast brain, even for planning." },
  { id: "strong", label: "strong", hint: "Always the capable brain, even for one-liners." },
] as const;

export type BrainPreference = (typeof BRAIN_CLASSES)[number]["id"];
