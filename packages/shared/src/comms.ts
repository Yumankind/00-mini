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
  decidedAt?: string;
  /**
   * Send no earlier than this (ISO). Set by the agent (`send_at`) or by the operator when approving.
   * An approval with a future `sendAt` parks the item as `scheduled`; the scheduler's sweep dispatches
   * it once the time passes. Absent = send on approval, which is the default.
   */
  sendAt?: string;
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
