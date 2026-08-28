/**
 * How the agent handles an incoming message:
 * - `off`      — don't auto-respond (the message is logged; you handle it yourself).
 * - `approve`  — auto-draft a reply, but it waits in Approvals for you to send (quarantine-safe).
 * - `send`     — auto-send the reply immediately, no human step (use only on trusted channels).
 */
export type AutoReplyMode = "off" | "approve" | "send";

export interface AutoReplySettings {
  /** Default mode per channel id (e.g. "signal", "overblast-dm"). */
  channels: Record<string, AutoReplyMode>;
  /** Overrides for a single conversation, keyed by `${channel}:${threadId}`. */
  conversations: Record<string, AutoReplyMode>;
}

/** A per-conversation auto-reply override, for display/editing in the UI. */
export interface AutoReplyOverride {
  channel: string;
  threadId: string;
  mode: AutoReplyMode;
}

export interface AutoReplyView {
  channels: Record<string, AutoReplyMode>;
  conversations: AutoReplyOverride[];
}

/** In a GROUP chat, when does the agent engage? "mention" = only when addressed (native @mention or a
 *  trigger word — the agent's name or a configured alias); "all" = on every group message. */
export type GroupEngageMode = "mention" | "all";

export interface GroupEngageSettings {
  /** Default per channel id. Unset → "mention" for Signal, "all" for others (legacy behavior). */
  channels?: Record<string, GroupEngageMode>;
  /** Per-conversation override, keyed by `${channel}:${threadId}`. */
  conversations?: Record<string, GroupEngageMode>;
  /** Extra trigger words (besides the agent's display name) that engage it in "mention" mode. */
  aliases?: string[];
}

export interface GroupEngageView {
  channels: Record<string, GroupEngageMode>;
  aliases: string[];
}

/**
 * How the MAIN agent's own proactive OUTGOING messages (the outgoing_message tool) are handled,
 * per channel and per conversation:
 * - `off`        — sending is disabled here; the tool refuses to queue anything.
 * - `quarantine` — the message is held in Approvals for you to send (safe default).
 * - `send`       — sent immediately with no approval (use only on channels/people you trust).
 */
export type OutgoingMode = "off" | "quarantine" | "send";

export interface OutgoingSettings {
  /** Default mode per channel id (e.g. "signal", "telegram"). */
  channels: Record<string, OutgoingMode>;
  /** Overrides for a single conversation/recipient, keyed by `${channel}:${threadId}`. */
  conversations: Record<string, OutgoingMode>;
}

export interface OutgoingOverride {
  channel: string;
  threadId: string;
  mode: OutgoingMode;
}

export interface OutgoingView {
  channels: Record<string, OutgoingMode>;
  conversations: OutgoingOverride[];
}

// ---------------------------------------------------------------------------
// Signal (signal-cli)
// ---------------------------------------------------------------------------

export interface SignalAccountStatus {
  installed: boolean;
  linked: boolean;
  phoneNumber?: string;
}

export type SignalLinkStatus = "pending" | "linked" | "failed" | "timeout";

export interface SignalLinkSession {
  id: string;
  /** The sgnl://linkdevice… URI to render as a QR code. Absent until signal-cli prints it. */
  uri?: string;
  status: SignalLinkStatus;
  error?: string;
}

// ---------------------------------------------------------------------------
// Team members — people the main agent can escalate to, defined from private DM threads.
// ---------------------------------------------------------------------------

export interface TeamMember {
  id: string;
  name: string;
  channel: string;
  threadId: string;
  /** What they do / when to contact them — freeform context the main agent uses to decide. */
  role: string;
  /**
   * Their email, when known — the JOIN KEY with the Overblast workspace's own team.
   *
   * The two rosters are two REACH LEVELS on one team (docs/cloud-public-agent.md, "One team, two reach
   * levels"): this one is reachable over the agent's installed channels, the platform's is reachable by
   * push in the Overblast app. An email that matches collapses the two rows into one person, so the
   * agent stops treating a teammate it can reach twice as two teammates. Optional because a Signal
   * contact defined from a thread genuinely may not have one.
   */
  email?: string;
  addedAt: string;
}

/**
 * A person surfaced from a connected channel's real conversations/contacts, offered as a one-click
 * starting point when adding a team member (so the operator needn't hand-type the channel + thread id).
 */
export interface ContactCandidate {
  channel: string; // channel id a team member would use (e.g. "signal", "overblast-dm")
  threadId: string; // phone number / conversation id
  name: string; // display name (falls back to threadId)
  source: string; // where it came from, for grouping (e.g. "Signal", "Overblast · instagram")
}

// ---------------------------------------------------------------------------
// Escalations — a thread-isolated light agent asking the main agent (which may in turn ask the
// operator or a team member) for input before it can answer. Uniform across every inbound channel.
// ---------------------------------------------------------------------------

export type EscalationStatus = "pending" | "answered" | "expired";

/** One structured question in an `ask_operator` call: pick one (or several) of the options. */
export interface OperatorAsk {
  question: string;
  options: string[];
  /** Allow selecting several options (checkbox semantics) instead of exactly one. */
  multi?: boolean;
}

export interface Escalation {
  id: string;
  agentId: string;
  channel: string;
  threadId: string;
  from: string;
  question: string;
  status: EscalationStatus;
  answer?: string;
  createdAt: string;
  answeredAt?: string;
  /** Structured multiple-choice questions (ask_operator) — rendered as numbered options in the notch/UI. */
  asks?: OperatorAsk[];
  /** Set when this escalation mirrors a WORKER-side human-ask (the hosted public agent's ask_human
   *  or a team mention) — the answer must travel back over REST instead of re-entering a local
   *  thread, and a mention is acknowledged rather than answered. */
  remote?: { kind: "ask_human" | "mention"; askId: string };
}

// ---------------------------------------------------------------------------
// Quarantine (outbound comms awaiting approval)
// ---------------------------------------------------------------------------

/**
 * `scheduled` = a human said yes, but the item carries a `sendAt` in the future, so it is waiting for
 * its time rather than for a person. It is NOT the same as `approved`: approved-with-no-sendAt means
 * "we tried and the transport failed, retry me", while scheduled means "don't touch this yet".
 */
export type QuarantineStatus = "pending" | "scheduled" | "approved" | "rejected" | "sent";

/** The kinds of outgoing action a channel may support. */
export type OutgoingAction = "message" | "post" | "comment" | "reply" | "react" | "email";

export const OUTGOING_ACTIONS: OutgoingAction[] = [
  "message",
  "post",
  "comment",
  "reply",
  "react",
  "email",
];

export interface QuarantineItem {
  id: string;
  agentId: string;
  createdAt: string; // ISO
  /** Channel the action would go out on, e.g. "telegram", "x", "email". */
  channel: string;
  /** What the agent wants to do. */
  action: OutgoingAction;
  /** Recipient / destination (address, handle, chat id, post target). */
  to?: string;
  /** Friendly display name for the destination (conversation/contact name) — shown instead of a raw
   *  handle or `group:<id>` when the engine could resolve one. */
  toName?: string;
  /** Thread being replied/reacted to (comment thread, email thread, DM thread). */
  threadId?: string;
  title?: string;
  description?: string;
  body?: string;
  /** Workspace-relative media paths (images/videos) to attach. */
  media?: string[];
  /** Reaction emoji/name for the "react" action. */
  reaction?: string;
  status: QuarantineStatus;
  /** The tool that produced this item (for audit). */
  tool: string;
  /**
   * WHERE THIS CAME FROM, when it did not originate with the operator or their agent's own intent.
   *
   * A relayed message is the case this exists for: the body is one member's words, carried to another
   * member, and an approval card that showed only the text and the destination would be asking the
   * operator to approve a sentence with no author. `tool` says which verb produced the item; this says
   * whose message it is. Absent on everything the agent composed itself, which is nearly everything.
   */
  origin?: {
    /** The channel the request arrived on. */
    channel: string;
    /** The thread it arrived in — where a reply-back goes. */
    threadId: string;
    /** The sender, as the transport named them. Never as they described themselves. */
    from: string;
    /** The group whose membership authorised this, by name — what the operator recognises. */
    groupName?: string;
  };
  decidedAt?: string;
  /**
   * Send no earlier than this (ISO). Set by the agent (`send_at`) or by the operator when approving.
   * An approval with a future `sendAt` parks the item as `scheduled`; the scheduler's sweep dispatches
   * it once the time passes. Absent = send on approval, which is the default.
   */
  sendAt?: string;
}

// ---------------------------------------------------------------------------
// The platform vocabulary — one canonical spelling per surface
// ---------------------------------------------------------------------------

/**
 * One surface, under the ONE name this codebase calls it.
 *
 * The engine and the worker are two halves of one product that had never agreed on how to spell a
 * platform. The worker writes `platform: 'website'` on every web-chat conversation; the engine tested
 * for `webchat` and routed the row to a fallback channel that answers strangers' DMs. Nothing failed —
 * a web-chat customer simply landed in the wrong inbox. That is what an undeclared vocabulary costs,
 * and this table is the declaration: every spelling either side may emit resolves here, once, instead
 * of at each `p === "..."` a reader happens to find.
 *
 * `aliases` are the OTHER spellings that must resolve to `name` — the worker's mostly, plus the two
 * this side grew (`x`, `messenger`). They are not "also acceptable": they are wrong spellings of a
 * right thing, and `canonicalPlatform` is where they stop existing.
 *
 * `localOnly` marks a surface the worker has no counterpart identity for: it lives on this machine and
 * nothing arriving from the worker will ever be spelled this way. `telegram-bot` is DISTINCT here by
 * decision, not oversight — a bot with its own @name is a different account from the operator's, and
 * routing identity keeps the channel apart even though `SELF_PLATFORM` (threads.ts) renames it to
 * `telegram` for DISPLAY. Those are two different questions and this table answers only the first.
 */
export interface CanonicalPlatformInfo {
  /** The one spelling every surface in this codebase uses. */
  name: string;
  /** Spellings that MUST resolve to `name`. */
  aliases?: string[];
  /** No worker counterpart as a distinct identity — this surface only exists locally. */
  localOnly?: boolean;
}

/**
 * The whole vocabulary, declared once.
 *
 * The non-`localOnly` half is the worker's own list twice over: `SocialPlatform` (social/types.ts) and
 * the three named kinds `conversationKindOf` (workspace/conversations-store.ts) can answer — email,
 * webchat, phone. That is a twin, so it is guarded rather than trusted: `platform-vocabulary.test.ts`
 * carries the worker's unions as fixtures and fails with a sentence when either side moves. The worker
 * is authoritative; this file follows it.
 *
 * `social` is deliberately absent. It is `conversationKindOf`'s CATEGORY for "not email, not webchat,
 * not phone", not a place anyone writes from — treating it as a platform would mint `overblast-dm-social`
 * for every Instagram row on the feed.
 */
export const CANONICAL_PLATFORMS: CanonicalPlatformInfo[] = [
  // ── Social platforms the worker connects (SocialPlatform) ──
  { name: "twitter", aliases: ["x"] },
  { name: "instagram" },
  // Messenger is Facebook's DM surface on one connected Facebook account, not a second account.
  { name: "facebook", aliases: ["messenger"] },
  { name: "linkedin" },
  { name: "tiktok" },
  { name: "youtube" },
  { name: "threads" },
  { name: "pinterest" },
  { name: "mastodon" },
  { name: "bluesky" },
  { name: "telegram" },
  { name: "whatsapp" },
  { name: "reddit" },
  { name: "google_business", aliases: ["googlebusiness", "google-business"] },

  // ── The three named conversation kinds (conversationKindOf) ──
  { name: "email" },
  // THE BUG THIS TABLE WAS BORN FOR: the worker's spelling is `website`.
  { name: "webchat", aliases: ["website", "web"] },
  { name: "phone", aliases: ["voice", "call"] },

  // ── Local transports: no worker counterpart, so nothing inbound is ever spelled this way ──
  { name: "signal", localOnly: true },
  { name: "imessage", localOnly: true },
  { name: "slack", localOnly: true },
  { name: "discord", localOnly: true },
  { name: "telegram-bot", localOnly: true },
  // Two of the operator's OWN agents talking to each other (AGENT_CHANNEL). Never leaves the machine.
  { name: "agent", localOnly: true },
];

/** alias → canonical name, built once. */
const PLATFORM_ALIASES: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const p of CANONICAL_PLATFORMS) for (const a of p.aliases ?? []) m[a] = p.name;
  return m;
})();

/**
 * The canonical spelling of a platform name.
 *
 * Unknown names pass through lower-cased rather than being mapped to anything: a platform this build
 * has never heard of is still a real place someone wrote from, and inventing a name for it would route
 * their message somewhere confidently wrong. Empty in, empty out.
 */
export function canonicalPlatform(name: string): string {
  const p = (name ?? "").trim().toLowerCase();
  if (!p) return "";
  return PLATFORM_ALIASES[p] ?? p;
}

/** The canonical names, in declaration order. */
export function canonicalPlatformNames(): string[] {
  return CANONICAL_PLATFORMS.map((p) => p.name);
}

/**
 * Does this platform exist ONLY on this machine — no worker counterpart identity?
 *
 * The table above already knows; this is the question asked out loud, so a caller stamping a record
 * with "the platform cannot reach this person" reads the same list every other surface reads instead
 * of keeping its own copy of which names are local. An unknown name answers `false`: a surface this
 * build has never heard of is not one we may assert anything about, and claiming it is unreachable
 * would be a guess written into stored data.
 */
export function isLocalOnlyPlatform(name: string): boolean {
  const canon = canonicalPlatform(name);
  return CANONICAL_PLATFORMS.some((p) => p.name === canon && p.localOnly === true);
}

// --- Comms channels (installable, off by default) ---

export interface CommsChannelInfo {
  id: string;
  label: string;
  description: string;
  /** Underlying transport (informational). */
  transport: string;
  /** Outgoing actions this channel supports. */
  actions: OutgoingAction[];
  /** Content fields this channel accepts. */
  content: { title: boolean; description: boolean; media: boolean };
  /** Platforms this channel can run on at all (absent = anywhere). The machine that would RUN it
   *  answers the catalog, so a Mac-only channel simply isn't offered by a Linux server. */
  platforms?: string[];
  /** Its dependency is a Homebrew formula — unavailable on a machine without brew. */
  needsBrew?: boolean;
  /** Set by the serving machine when it cannot run this channel: why, in one line. */
  unsupported?: string;
  /** Whether threads (email/comment/DM) can be read from this channel. */
  canReadThreads: boolean;
  /** Secret name that must exist in the vault before this channel can send. */
  requiredSecret?: string;
  /** Where to connect/manage accounts for this channel (opened externally). */
  connectUrl?: string;
}

export interface CommsCatalogResponse {
  channels: CommsChannelInfo[];
}

export interface InstalledCommsResponse {
  channels: string[];
}

// ── What one channel can DO with a message, and who is on the other end ──────────────────────────

/**
 * What a transport can actually do with ONE message: "both" = we can send it AND read it; "receive" =
 * it arrives and renders, but we cannot send one; "none" = the transport has no such concept (or no
 * path to it we would trust).
 *
 * Reactions and quoted replies exist on most transports, but not symmetrically: iMessage delivers
 * tapbacks and inline replies and has no way to send either. Offering a react button that would be
 * dropped on the floor is worse than not offering one, so the UI asks the table first — and that table
 * (`MESSAGE_ACTION_CAPS`) lives in the engine, beside the adapters that do the sending, because it is a
 * fact about them. Only the SHAPE of the answer lives here.
 */
export type ActionSupport = "none" | "receive" | "both";

export interface MessageActionCaps {
  react: ActionSupport;
  reply: ActionSupport;
}

/** "main" = the agent itself, with its workspace and tools. "public" = the restricted light agent. */
export type SenderMode = "main" | "public";

/** One person (or group) that has written to a channel the agent answers on, and which agent they get. */
export interface DirectSender {
  channel: string;
  /** The conversation id (a Telegram chat id — a person's chat or a group's). */
  threadId: string;
  name?: string;
  /** Their @handle, when the channel has one — what the owner will actually recognise. */
  username?: string;
  isGroup?: boolean;
  mode: SenderMode;
  firstSeen: string;
  lastSeen: string;
  messages: number;
  /** When the owner last changed the mode, so the UI can show a decision as deliberate. */
  decidedAt?: string;
}

/** Telegram-as-the-operator (GramJS, QR login) — everything a link screen needs to draw itself. */
export interface TelegramStatus {
  /** GramJS importable (bundled). */
  installed: boolean;
  /** TELEGRAM_API_ID + TELEGRAM_API_HASH present in Secrets. */
  configured: boolean;
  /** Session authorized and connected. */
  linked: boolean;
  /** The current login QR as a data URL, while waiting to be scanned. */
  qr?: string;
  /** The account has 2FA — waiting for the cloud password. */
  needsPassword?: boolean;
  passwordHint?: string;
  self?: { username?: string; name?: string; phone?: string };
  /** The last login error, surfaced on the link screen. */
  error?: string;
}

/** WhatsApp via Baileys — pairing is a QR and nothing else, so the shape is three fields. */
export interface WhatsappStatus {
  /** Baileys importable (bundled). */
  installed: boolean;
  /** Paired and connected. */
  linked: boolean;
  /** The current pairing QR as a data URL, while waiting to be scanned. */
  qr?: string;
}
