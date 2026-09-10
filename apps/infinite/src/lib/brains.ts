/**
 * The four peers behind one door — docs/HANDOFF-infinite-agent.md §6.1.
 *
 * WHY THE CARDS ARE DATA HERE AND NOT COPY IN A COMPONENT. Each peer's row in §6.1 is a promise about
 * what it needs before it will answer ("nothing", "a passkey account — no email required", "Overblast
 * sign-in", "the key, sealed in the vault"), and that promise is the single most important sentence
 * on the Connections pane. Keeping the four in one list means the offline reducer, the router picker
 * and the boot screen all read the same four facts, and adding a fifth peer is one entry.
 *
 * The house rule about business models applies (`docs/…/no-hardcoded-business-models`): nothing here
 * names a price, a tier or a plan. Those come from the worker when a peer is actually reached for.
 */

export type BrainId = "local" | "sponsored" | "overblast" | "byok" | "remote";

export interface BrainPeer {
  id: BrainId;
  /**
   * §6.1's level column, kept because the router orders by it.
   *
   * `4` is NOT a fifth rung of the free-to-paid ladder the first four make: `remote` is off the
   * ladder altogether — it asks for no key, no account and no money, only a Mac the person already
   * owns and is already sitting in front of sometimes. It is last because it is the newest road and
   * because `auto` walks this order, not because it costs the most.
   */
  level: 0 | 1 | 2 | 3 | 4;
  label: string;
  /** One line of what it is. */
  blurb: string;
  /** One line of what it asks for, in the person's words. */
  needs: string;
  /** False for `local` only: the offline reducer greys the rest. */
  remote: boolean;
}

export const BRAIN_PEERS: BrainPeer[] = [
  {
    id: "local",
    level: 0,
    label: "Local AI",
    blurb: "A small model in this browser, on your own GPU. Private and offline.",
    needs: "Nothing — a one-time download.",
    remote: false,
  },
  {
    id: "sponsored",
    level: 1,
    label: "Sponsored",
    blurb: "Answers paid for by the sponsored pool, with a sponsor line under them.",
    needs: "A passkey account — no email required.",
    remote: true,
  },
  {
    id: "overblast",
    level: 2,
    label: "Overblast",
    blurb: "Your workspace's credits, as a brain for this browser.",
    needs: "An Overblast sign-in; this browser gets its own revocable token.",
    remote: true,
  },
  {
    id: "byok",
    level: 3,
    label: "Your own key",
    blurb: "OpenAI, Anthropic, OpenRouter or any OpenAI-compatible endpoint.",
    needs: "The key, sealed in your vault.",
    remote: true,
  },
  {
    // §8.4's second door. The subscription is used ON THE MAC, by the Mac's own app; this browser
    // only asks its agent a question and reads the answer, over the relay it was admitted through.
    id: "remote",
    level: 4,
    label: "Your Mac",
    blurb: "Your Mac's agent thinks, with whatever brain it runs — Claude Code, Codex, its own key.",
    needs: "00 running on your Mac, and this browser admitted there.",
    remote: true,
  },
];

export function peer(id: BrainId): BrainPeer {
  const found = BRAIN_PEERS.find((p) => p.id === id);
  if (!found) throw new Error(`unknown brain ${id}`);
  return found;
}

/** A provider id from the contract (`byok:openai`) back to the card it belongs to. */
export function peerIdForProvider(providerId: string): BrainId | null {
  if (providerId.startsWith("byok:")) return "byok";
  // One Mac, one provider id — the contract's `remote-mac`, the card's `remote`.
  if (providerId === "remote-mac") return "remote";
  if (providerId === "local" || providerId === "sponsored" || providerId === "overblast") return providerId;
  return null;
}

/**
 * The vendors the BYOK card offers, as labels only. The BASE URLS are deliberately not here:
 * `@00/agent-models` already owns them (`BYOK_BASE_URLS`), and two copies of an endpoint is a way to
 * ship a stale one. `custom` is last, and is why this is not a closed set.
 */
export const BYOK_VENDORS = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "custom", label: "Custom (OpenAI-compatible)" },
] as const;

export function byokProviderId(vendor: string): string {
  return `byok:${vendor}`;
}

/** The vault name a BYOK key is stored under — names are visible, values are sealed (§4.5). */
export function byokSecretName(vendor: string): string {
  return `byok.${vendor}.apiKey`;
}

export function byokProblem(vendor: string, key: string, baseUrl: string): string | null {
  if (!vendor) return "Pick a vendor.";
  if (!key.trim()) return "Paste the key.";
  if (vendor === "custom" && !/^https:\/\/.+/.test(baseUrl.trim())) {
    return "A custom endpoint needs an https base URL.";
  }
  return null;
}

/** Overblast device tokens are `sk-obd`; anything else pasted in that field is a different secret. */
export function overblastTokenProblem(token: string): string | null {
  const t = token.trim();
  if (!t) return "Paste or mint a token first.";
  if (!t.startsWith("sk-obd")) return "An Overblast device token starts with sk-obd.";
  if (t.length < 16) return "That token looks truncated.";
  return null;
}
