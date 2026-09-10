/**
 * Move to my Mac — docs/HANDOFF-infinite-agent.md §7 ("one live residence") and §3.2.
 *
 * WHY A WORD CODE AND NOT A PASSPHRASE. The Backup file of §7.2 asks for a passphrase because the
 * person keeps that file and remembers its secret. A MOVE is different: the secret is born on one
 * device and TYPED on another, minutes later, by the same person reading it off a screen. A random
 * string is unreadable across that gap — it gets mistyped, screenshotted, or pasted into a chat. Six
 * words out of a fixed list of 256 is 48 bits, which is more than the 40 the transfer needs, and it
 * is a thing a person can say out loud. The list is embedded rather than fetched, because the whole
 * flow must work with the network off.
 *
 * WHY THE CODE IS NEVER IN A URL. The Mac's second scheme, `zerozero://agent/receive?code=…`, is
 * §7.1's live transfer and belongs to Phase 4; the flow this module serves is the file one, and its
 * deep link carries only the FILE NAME so the Mac can hint a picker at the right download. A URL is
 * written to history, to the app-switch log and to whatever handler the OS shows in its "open this?"
 * prompt, and the bundle key has no business in any of them. `importDeepLink` therefore takes a name
 * and nothing else, and a test pins that it cannot be talked into carrying more.
 */
import { cryptoRandom, type RandomBytes } from "./id.js";
import { slugName } from "./backup.js";

/** Six, because the shape the Mac app validates is `^[a-z]+(-[a-z]+){5}$`. */
export const MOVE_CODE_WORDS = 6;

/** The app's own reader for a code someone typed back. Kept identical to the Mac's regex. */
export const MOVE_CODE_RE = /^[a-z]+(-[a-z]+){5}$/;

/**
 * 256 lowercase words, 3–6 letters, no homophones and no plurals of each other, so a code read down
 * a phone line survives the trip. 256 is a power of two, which is what makes a byte an unbiased pick
 * — a list of 250 would need rejection sampling, and rejection sampling written in a hurry is how
 * word codes stop being uniform.
 */
export const MOVE_WORDS: readonly string[] = [
  "able", "acid", "acorn", "actor", "after", "agent", "album", "alarm",
  "alert", "alley", "almond", "amber", "anchor", "angle", "ankle", "apple",
  "april", "apron", "arbor", "arch", "arena", "argon", "arrow", "ash",
  "aspen", "atlas", "atom", "attic", "audio", "auto", "autumn", "bacon",
  "badge", "bagel", "baker", "ballad", "bamboo", "banana", "banjo", "barge",
  "barley", "basil", "basin", "basket", "batch", "baton", "beacon", "beetle",
  "bench", "berry", "bison", "bloom", "board", "bonus", "borrow", "bottle",
  "bounce", "branch", "brave", "bread", "breeze", "bridge", "bright", "bronze",
  "brook", "brush", "bubble", "bucket", "budget", "buffet", "bugle", "bunny",
  "burrow", "butler", "butter", "button", "cabin", "cable", "cactus", "camel",
  "campus", "canal", "candle", "canoe", "canvas", "canyon", "carbon", "cargo",
  "carpet", "carrot", "castle", "cattle", "cedar", "celery", "cello", "cement",
  "census", "chalk", "charm", "cheese", "cherry", "chess", "chill", "chorus",
  "cider", "cinema", "circle", "citrus", "clover", "cobalt", "cocoa", "coffee",
  "comet", "copper", "coral", "cotton", "cousin", "coyote", "crane", "crater",
  "crayon", "cream", "credit", "crown", "cruise", "cube", "curve", "dagger",
  "daisy", "dancer", "dawn", "debate", "decade", "deck", "delta", "denim",
  "desert", "desk", "detail", "diesel", "dinner", "divide", "dizzy", "dock",
  "doctor", "dollar", "domain", "donkey", "double", "dragon", "drama", "dream",
  "drill", "drum", "duck", "dune", "dusk", "eagle", "earth", "easel",
  "east", "echo", "edge", "editor", "eight", "elbow", "elder", "elite",
  "elm", "ember", "empire", "enamel", "energy", "engine", "enjoy", "entry",
  "equal", "era", "error", "escape", "estate", "ether", "event", "exact",
  "exile", "expert", "extra", "fabric", "falcon", "family", "fancy", "farm",
  "fauna", "fern", "ferry", "fever", "fiber", "fiddle", "field", "fig",
  "filter", "final", "finch", "finger", "fir", "fire", "first", "fish",
  "flame", "flask", "fleet", "flint", "float", "flour", "flower", "flute",
  "focus", "foil", "forest", "forge", "fossil", "fox", "fresh", "frost",
  "fruit", "fuel", "funnel", "future", "gadget", "galaxy", "garden", "garlic",
  "gate", "gauge", "gear", "gem", "gentle", "ginger", "glass", "globe",
  "glove", "glue", "goat", "golden", "goose", "grain", "grand", "grape",
  "grass", "gravel", "green", "grill", "grove", "guitar", "gulf", "harbor",
];

/** How much a code of this shape is worth, in bits. Stated so a test can hold the ≥ 40 floor. */
export function codeEntropyBits(listLength = MOVE_WORDS.length, words = MOVE_CODE_WORDS): number {
  return words * Math.log2(listLength);
}

/**
 * A fresh transfer secret. One byte per word, masked to the list length — with 256 words the mask is
 * the identity, so every byte is one uniform word and no draw is ever thrown away.
 */
export function newMoveCode(random: RandomBytes = cryptoRandom): string {
  const bytes = random(MOVE_CODE_WORDS);
  const out: string[] = [];
  for (let i = 0; i < MOVE_CODE_WORDS; i++) out.push(MOVE_WORDS[bytes[i] & (MOVE_WORDS.length - 1)]);
  return out.join("-");
}

export function isMoveCode(value: string): boolean {
  return MOVE_CODE_RE.test(value);
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * `<agent-name-slug>-<YYYY-MM-DD>.00agent`.
 *
 * Deliberately NOT `backupFilename`'s shape. A backup is one of many and carries the agent id and a
 * minute so a folder of them sorts; a move happens once and its name is read out loud to a person
 * standing at a Mac, hunting for it in Downloads. Date only, name only, and UTC so the two devices
 * agree about which day it is.
 */
export function moveFilename(displayName: string, at: Date): string {
  const date = `${at.getUTCFullYear()}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}`;
  return `${slugName(displayName)}-${date}.00agent`;
}

/** The scheme the Mac app registers. `import` hints a picker; `receive` is Phase 4 and not built. */
export const MAC_SCHEME = "zerozero://agent";

/** `zerozero://agent/import?name=<file name>` — the file name, percent-encoded, and nothing else. */
export function importDeepLink(fileName: string): string {
  return `${MAC_SCHEME}/import?name=${encodeURIComponent(fileName)}`;
}

// ── The receipt: what is left in this browser after the agent has gone ────────────────────────────

/**
 * §7's "the source keeps a locked receipt (name, avatar, when and where it went)". The local copy is
 * NOT deleted — a move whose far side silently failed would otherwise be an agent nobody has — it is
 * locked, so that the one-live-residence rule is kept by the shell rather than by the person's
 * memory. Two ways out, and they are different things: bringing it back (the Mac exported it again,
 * so this browser is the residence once more) and overriding (the person accepts two live copies).
 */
export interface MoveReceipt {
  agentId: string;
  displayName: string;
  emoji: string;
  /** ISO, when the person said the Mac had it. */
  movedAt: string;
  /** The `.00agent` that went — shown so the person can find it again. */
  fileName: string;
  /** ISO once the lock is off; null while this browser is a receipt and not an agent. */
  releasedAt: string | null;
  releasedBy: "restore" | "override" | null;
}

export type MoveAction =
  | { type: "moved"; profile: { id: string; displayName: string; emoji: string }; fileName: string; at: Date }
  | { type: "brought-back"; at: Date }
  | { type: "unlock-anyway"; at: Date }
  | { type: "cleared" };

/** Pure, so the whole locked → unlocked story is one table in a test and not a walk through the UI. */
export function moveReceiptReducer(state: MoveReceipt | null, action: MoveAction): MoveReceipt | null {
  switch (action.type) {
    case "moved":
      return {
        agentId: action.profile.id,
        displayName: action.profile.displayName,
        emoji: action.profile.emoji,
        movedAt: action.at.toISOString(),
        fileName: action.fileName,
        releasedAt: null,
        releasedBy: null,
      };
    case "brought-back":
      return state ? { ...state, releasedAt: action.at.toISOString(), releasedBy: "restore" } : null;
    case "unlock-anyway":
      return state ? { ...state, releasedAt: action.at.toISOString(), releasedBy: "override" } : null;
    case "cleared":
      return null;
  }
}

/** The shell shows the receipt pane instead of the agent exactly while this is true. */
export function isLocked(state: MoveReceipt | null): boolean {
  return state !== null && state.releasedAt === null;
}

/** True when this browser is knowingly a second live copy — §7's rule, broken on purpose. */
export function isSecondCopy(state: MoveReceipt | null): boolean {
  return state !== null && state.releasedBy === "override";
}

function dayOf(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? "an unknown day"
    : `${at.getUTCFullYear()}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}`;
}

/** The receipt pane's one sentence, and the Connections line once it is unlocked. */
export function receiptLine(state: MoveReceipt): string {
  if (state.releasedBy === "restore") return `Brought back on ${dayOf(state.releasedAt ?? state.movedAt)}.`;
  if (state.releasedBy === "override") {
    return `Unlocked here on ${dayOf(state.releasedAt ?? state.movedAt)} — your Mac may still be running a copy.`;
  }
  return `Moved to your Mac on ${dayOf(state.movedAt)}.`;
}

/** The five screens of the flow, in order; the panel is a switch over this and nothing else. */
export const MOVE_STEPS = ["explain", "code", "download", "open", "confirm"] as const;
export type MoveStep = (typeof MOVE_STEPS)[number];

export function nextMoveStep(step: MoveStep): MoveStep {
  const i = MOVE_STEPS.indexOf(step);
  return i < 0 || i === MOVE_STEPS.length - 1 ? step : MOVE_STEPS[i + 1];
}
