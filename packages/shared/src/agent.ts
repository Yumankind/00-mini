import type { AgentEngine, CliEngineId } from "./cli-engines.js";
import type { WorkspaceMemberCard, WorkspaceSeatRevoked } from "./overblast.js";
import type { AutoReplySettings, GroupEngageSettings, OutgoingSettings } from "./comms.js";
import type { VoiceConfig } from "./voice.js";
import { isLocalProviderId } from "./models.js";

/** Capabilities that can be toggled per agent. Default: everything OFF (opt-in). */
export interface Capabilities {
  /** Read/write files inside the agent's own workspace. */
  files: boolean;
  /** Run shell commands (bash tool). */
  shell: boolean;
  /** Reach the internet (fetch/browse tools + bash egress). */
  internet: boolean;
  /** Drive a BROWSER PAGE (the agent's own Chrome — click, type, read the page). Named `computer`
   *  since before there was anything else to drive; `desktop` below is the whole screen, and the two
   *  are separate keys on purpose — see CAPABILITY_RISK. */
  computer: boolean;
  /** Drive the agent's whole DESKTOP: every window on its screen, not just a browser tab. Container
   *  and Linux only — on a Mac the desktop is the operator's own, which 00 never screencasts. */
  desktop: boolean;
  /** Move the COMPANION CURSOR on the operator's Mac — the agent's face, out beside the real pointer —
   *  to show things: go there, ring it, say a line. Look-and-point only; it never clicks or types
   *  (that is a later, separate step), and the operator's own mouse or ESC takes it back at once.
   *  Only the Mac app can grant it (there is no companion anywhere else); off by default. */
  pointer: boolean;
  /** Send outbound comms (messages/email/posts) — always quarantined first. */
  comms: boolean;
  /** Create scheduled / cron tasks. */
  schedule: boolean;
  /** Media generation (image/speech/…), enabled per available provider key. */
  media: boolean;
  /** Web + maps search, enabled per available provider key. */
  search: boolean;
  /** Run coding tasks via an installed CLI (Claude Code / Codex / Gemini) on projects. Only usable when one of
   *  those CLIs is on PATH; off by default. */
  coding: boolean;
}

/**
 * Extra tools that may be granted to the RESTRICTED public/DM agent. All off by default. shell,
 * computer, and arbitrary comms are intentionally NOT grantable to public interactions.
 */
export interface PublicExtras {
  internet: boolean;
  media: boolean;
  search: boolean;
  /**
   * May the public agent hand a question to the operator's MAIN agent (`ask_for_help`)?
   *
   * On, a stranger's question can reach an agent with the whole workspace and the full toolset behind
   * it — which is why the public agent can answer things it has no business knowing, and equally why
   * this is the one path by which untrusted text reaches the powerful half of the system. Off, the
   * same question goes to the OPERATOR instead: the escalation is raised and flagged exactly as
   * before, but no main-agent turn runs on it.
   *
   * Defaults ON, which is how every agent behaved before this switch existed — turning it off is a
   * deliberate tightening, not a migration.
   */
  mainAgentHelp: boolean;
  /**
   * May the public agent see that the person it is talking to has OTHER channels on file?
   *
   * The operator links a Signal number to an email address by hand (contact-links.ts), and to an agent
   * answering that thread the link is real context: this is the person who wrote in by email last week.
   * The main agent gets it unconditionally. The public agent does not, for one reason — it talks to
   * whoever writes in, and the handle on an inbound message is only as trustworthy as the channel it
   * arrived on. Somebody who can put a known address in the "from" field would otherwise be told which
   * other addresses and numbers that person uses.
   *
   * So it is off by default, and even when granted the public agent is given the channels with the
   * handles MASKED and no thread ids: enough to say "we can also reach you by email", never enough to
   * read out somebody's address or to read another conversation. Reading across threads stays the main
   * agent's alone.
   */
  contacts: boolean;
}

export const DEFAULT_PUBLIC_EXTRAS: PublicExtras = {
  internet: false,
  media: false,
  search: false,
  mainAgentHelp: true,
  contacts: false,
};

/**
 * A NEW AGENT ARRIVES ABLE TO WORK. These are the main capabilities, not add-ons, and an agent that
 * has to ask permission for each one before it can do anything useful teaches its operator to
 * approve without reading — which is worse for safety than starting broad and narrowing.
 *
 * What that does NOT relax, because it lives elsewhere and still applies to every one of these:
 *   · outbound comms stay QUARANTINED for approval, message by message;
 *   · media/search do nothing without a provider key, and coding nothing without a CLI on PATH;
 *   · the browser needs a vision model before its tools register at all;
 *   · `set_capabilities` stays asymmetric — an agent may narrow ITSELF instantly, but re-widening
 *     anything the operator turned off is still an ask, on a card, with a reason.
 *
 * `desktop` is the one exception and it is not a policy choice: it depends on the MACHINE. It stays
 * off here and is switched on by the engine when the box actually has a screen of the agent's own
 * (see scaffold.ts) — on a Mac that desktop belongs to a person, and defaulting it on would be a
 * promise the surface then refuses to keep.
 */
export const DEFAULT_CAPABILITIES: Capabilities = {
  files: true, // its own sandboxed workspace — an agent without this is an ornament
  shell: true, // bash in that workspace, with a scrubbed (secret-free) env
  internet: true,
  computer: true, // its own browser; the tools still require a vision-capable model
  desktop: false, // MACHINE-decided, not policy — scaffold.ts turns it on where a screen is the agent's
  pointer: false, // the operator's own screen, in front of them — asked for, never assumed
  comms: true, // outgoing is quarantined for approval regardless, so this grants reach, not send
  schedule: true, // its own cron/interval/one-shot tasks
  media: true, // inert until a provider key exists (OpenAI/Gemini/…)
  search: true, // inert until a provider key exists (Tavily/Gemini)
  coding: true, // inert until a coding CLI (Claude Code / Codex / Gemini) is on PATH
};

export interface ModelConfig {
  /** Provider id understood by pi-ai, e.g. "anthropic", "openai", "google". */
  provider: string;
  /** Model id, e.g. "claude-sonnet-5". */
  model: string;
}

export const DEFAULT_MODEL: ModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-5",
};

// ---------------------------------------------------------------------------
// Active hours — when an agent is allowed to run autonomously (inbound + scheduled + dispatched
// work). Direct local chat from the operator always works regardless.
// ---------------------------------------------------------------------------

/** One weekly window. days: 0=Sunday…6=Saturday. from/to are "HH:MM" local time; a window with
 *  to <= from crosses midnight (e.g. 22:00–06:00). */
export interface ActiveWindow {
  days: number[];
  from: string;
  to: string;
}

export interface ActiveHours {
  mode: "always" | "windows";
  windows: ActiveWindow[];
}

export const ALWAYS_ON: ActiveHours = { mode: "always", windows: [] };

/**
 * Where an agent's browser (the "computer use" Chrome) keeps what a login leaves behind — cookies,
 * localStorage, IndexedDB.
 *
 * "shared" is the useful default: ONE Chrome profile on disk per agent, so an operator logs into a site
 * once in the browser panel and every future session of that agent is already signed in. The cost is
 * plain: that login is now the AGENT's, and anyone who can reach the agent (a paired device, a peer
 * operator it's shared with) can drive a browser that is already inside the account.
 *
 * "session" is the answer when that's not acceptable: a throwaway context per agent SESSION, nothing
 * written to disk, gone when the session ends. Every session starts logged out.
 */
export type BrowserPersistence = "shared" | "session";

export interface BrowserSettings {
  /** Default "shared". See BrowserPersistence. */
  persistence?: BrowserPersistence;
  /**
   * Run a REAL Chrome window on the machine the agent lives on instead of a headless one. It exists
   * because headless Chrome is refused outright by several sign-in flows (Google and Microsoft both
   * do this), so a manual login in the panel can be impossible otherwise — and because Chrome's own
   * interface (profile picker, permission prompts, chrome:// pages) only exists in a window.
   *
   * ABSENT MEANS "FOLLOW THE MACHINE", NOT "OFF", and storing `false` to mean absent throws that
   * away. The engine's default depends on where it is running (resource-arbiter's headfulDefault):
   * on in a container big enough to draw and with nobody sitting at it, off on a Mac and off on a
   * plain Linux box, where a window would appear on somebody's real screen. Set explicitly, either
   * value wins over that — an operator's decision is not overruled by the box it runs on.
   *
   * Ignored on an engine with no display at all: there is nowhere to put a window and Chrome would
   * fail to launch rather than degrade.
   */
  headed?: boolean;
}

/** Update display name / emoji / active hours. */
export interface UpdateAgentProfileRequest {
  displayName?: string;
  emoji?: string;
  /** Accent color (hex); "" resets to the default. */
  color?: string;
  /** Bind this agent to a saved Overblast workspace key (cloud runs land on — and bill — that
   *  workspace). null unbinds → shared/default workspace for temporary cloud work. */
  overblastKeyId?: string | null;
  /** CLI session model — "default" | claude's "sonnet"/"opus"/"haiku" | a full model id (also used
   *  for gemini's -m). Codex ignores it. */
  cliModel?: string;
  /** Per-engine account association (see AgentProfile.cliAccounts). Replaces the whole map when set. */
  cliAccounts?: Partial<Record<CliEngineId, string[]>>;
  /** Cross-supplier fallback order (see AgentProfile.cliEngineOrder). Replaces the whole list. */
  cliEngineOrder?: CliEngineId[];
  activeHours?: ActiveHours;
  /** default answer/STT language (ISO code, e.g. "pt"); "" clears it */
  language?: string;
  /** Meeting attention trigger words/phrases; [] clears. */
  attentionTriggers?: string[];
  /** How often (hours) the background task rebuilds contact profiles. 0 = off. */
  contactProfileHours?: number;
  /** How often (minutes) inbound message channels are polled (Signal / iMessage / Overblast). 5–60. */
  pollMinutes?: number;
  /** Custom profile-extraction sections; [] resets to the default schema. */
  contactProfileTopics?: string[];
  /** Birthday-message hook instruction ("" clears it). */
  birthdayHook?: string;
  /** Toggle appending a signature line to every outgoing text message. */
  signMessages?: boolean;
  /** Browser (computer-use) session settings — see BrowserSettings. Replaces the whole object; `{}`
   *  clears back to the defaults (shared profile, headless). */
  browser?: BrowserSettings;
  /** Signature text ("" clears it). */
  signature?: string;
  /** Per-tool switches for the Overblast platform tools ({} clears back to "all on"). */
  overblastTools?: Record<string, boolean>;
  /** Whether this agent's local tasks and task templates sync with its workspace. See
   *  {@link EntitySyncMode}. */
  entitySync?: EntitySyncMode;
  /** What to do with THIS agent's sessions that a crash cut mid-turn. `"ask"` clears the override
   *  back to the machine-wide setting. See {@link ResumeInterruptedOverride}. */
  resumeInterrupted?: ResumeInterruptedPolicy;
}

/**
 * WHETHER AN AGENT'S OWN TASKS AND TEMPLATES TRAVEL, and it is a per-agent decision.
 *
 * An agent that has never been connected keeps its work in folders on this machine
 * (`docs/local-entities.md`). Connecting one used to leave those folders where they were, forever,
 * beside a workspace holding the same kind of record — two task lists, one operator, no relationship.
 *
 * Two modes, and the third state is not a mode:
 *
 * - **`linked`** — the default for an agent that holds its workspace's link. Local entities and
 *   workspace entities are ONE record: pushed up as they change, pulled down as they change there.
 * - **`local-only`** — the agent may be fully connected, use every platform tool, answer on every
 *   channel, and its own tasks still never leave this machine. Not the same as "not connected": it
 *   is the operator saying that THIS agent's records are theirs. A consultant's own client list on a
 *   workspace shared with a team is the case that asks for it.
 *
 * The third state is an agent with no workspace at all, which is neither of these — nothing to sync
 * with, nothing to decide, and no setting shown. It is spelled as an ABSENT link rather than as a
 * third word here, because a word would have to be kept in step with a fact the platform owns.
 *
 * Absent means `linked`, and the default direction is deliberate: the whole point of the local store
 * was that the day these met, a sync would be a copy rather than a migration. An operator who
 * connects a workspace and finds their tasks did not follow has been given a store they have to
 * discover a second setting to escape.
 */
export type EntitySyncMode = "linked" | "local-only";

/**
 * WHAT HAPPENS TO A TURN THE PROCESS DIED IN THE MIDDLE OF.
 *
 * Not an error — an error already ends a turn, and the session says so. This is the other ending: the
 * Mac was shut, the app was quit, the engine was killed while an agent was mid-thought. Nothing
 * recorded a result because nothing got to; the only trace is the session's own transcript, stopping
 * mid-sentence.
 *
 * Three answers, and the machine-wide setting is allowed all three:
 *
 * - **`ask`** — the default. The next start lists what was cut off and asks. An operator who has not
 *   said otherwise should never come back to a Mac that quietly re-ran work while they were away.
 * - **`continue`** — send the literal word "continue" back into each of those sessions, in the SAME
 *   session, so the agent picks up with its own transcript as context.
 * - **`ignore`** — drop the records. The sessions stay exactly where they stopped.
 *
 * An AGENT may override the machine, and there `ask` is spelled as an ABSENT field rather than as a
 * stored word: absent means "whatever the machine says", which is what an operator who never opened
 * this setting meant. Writing `"ask"` through the profile API is how the override is CLEARED.
 */
export type ResumeInterruptedPolicy = "ask" | "continue" | "ignore";

/** The two answers an agent-level override can hold. Absent = inherit the machine's policy. */
export type ResumeInterruptedOverride = Exclude<ResumeInterruptedPolicy, "ask">;

export interface UpdateSignalSettingsRequest {
  autoReply?: boolean;
  pollMinutes?: number;
}

/**
 * A generated 8×8 pixel-art avatar for an agent. `rows` are 8 strings of 8 chars; each char is a key
 * into `colors` (hex). '.' (or any char missing from `colors`) is a transparent/off pixel.
 */
export interface AgentAvatar {
  rows: string[];
  colors: Record<string, string>;
}

/** Ask the engine to (re)generate an agent's pixel-art avatar, optionally guided by a request. */
export interface RegenerateAvatarRequest {
  request?: string;
}

export type AgentStatus =
  | "onboarding" // running the BOOTSTRAP interview
  | "ready" // onboarded and not currently busy
  | "thinking"
  | "running"
  | "awaiting-approval"
  | "reloading" // model/settings changed; session rebuilds on next message
  | "error";

/** Persisted per-agent profile (agents/<id>/profile.json). */
/** Per-agent model priority for media generation: ordered model ids, most-preferred first.
 *  Partial lists are fine — anything not listed keeps the engine's default order behind them,
 *  and ids that aren't installed/enabled are skipped at pick time. */
export interface MediaModelPrefs {
  image?: string[];
  video?: string[];
  music?: string[];
  /**
   * Which machines in the fleet THIS agent may borrow from, by peer id.
   *
   * Absent means every machine, which is the right default: the fleet is machines you already own
   * and had to add deliberately. The list exists for the case where that stops being obvious — a
   * server someone else's agent is meant to be using, or one you would rather a particular agent
   * left alone.
   */
  machines?: string[];
}

export interface AgentProfile {
  /** How long files handed to this agent live: composer attachments and arrivals from the outside
   *  world, separately, with an optional per-channel override. See agent-storage.ts. */
  commsStorage?: {
    internalDays?: number | "forever";
    externalDays?: number | "forever";
    perChannel?: Record<string, number | "forever">;
  };
  id: string;
  displayName: string;
  emoji: string;
  /** Generated 8×8 pixel-art avatar (from name/goal/request). Falls back to a tinted face if absent. */
  avatar?: AgentAvatar;
  /** Preferred generation models per modality (see MediaModelPrefs). */
  mediaPrefs?: MediaModelPrefs;
  /** Set while this agent is BURST to a cloud replica: local dispatch is refused and the UI shows
   *  the lease instead of the agent as available. Cleared when the lease ends (sync-back/reclaim). */
  leased?: { leaseId: string; mode: "full" | "paths"; paths?: string[]; since: string };
  /** Cloud SESSION runs in flight (experimental cloud agents). Unlike `leased`, these do NOT block
   *  local turns — the agent keeps working here while a copy runs a task in the cloud, and the
   *  result MERGES home (burst-merge). One entry per running lease; cleared as each lands. */
  cloudRuns?: { leaseId: string; paths?: string[]; since: string; prompt?: string }[];
  createdAt: string; // ISO
  /** The agent's accent color (hex). Absent = a deterministic per-id color. */
  color?: string;
  /** Muted: suppress this agent's notch messages AND macOS notifications, even when they're on at the
   *  app level. The in-app attention badge still shows — mute only silences push-style interruptions. */
  muted?: boolean;
  /** Meeting ATTENTION trigger words/phrases (distinct from the channel activation trigger). During a live
   *  meeting capture, if one is heard (fuzzy, case-insensitive) the notch anchors a mention with the
   *  surrounding sentences so the operator's attention is caught. */
  attentionTriggers?: string[];
  /** @deprecated Agent-wide finish condition. Kept so an existing profile still PARSES, but nothing
   *  reads it: "when is the work done" belongs to a piece of work, not to an agent, so it lives on the
   *  session now (see getSessionFinishCondition). Remove once profiles have been rewritten. */
  finishCondition?: string;
  /** Main model — used by the full (local web/Swift) agent. */
  model: ModelConfig;
  /** Model for the restricted public/DM ("light") agent. Falls back to `model`. */
  publicModel?: ModelConfig;
  /** Model for subagents spawned via spawn_subagent. Falls back to `model`. */
  subagentModel?: ModelConfig;
  /** Model for background/side tasks — contact-profile mining, session titles, and other cheap
   *  non-interactive work. Falls back to `model`. Pick a cheaper model here to cut background cost. */
  secondaryModel?: ModelConfig;
  /** Background/side tasks (session titles, contact-profile mining) run at all. Default true.
   *  false = skip them entirely — no secondary model is consulted and nothing is billed for them. */
  backgroundTasks?: boolean;
  /** Predict the operator's likely NEXT message after each turn and offer it in the composer. Default
   *  true. Effective only where a predictor is free or already paid for: on `secondaryModel` (the
   *  background brain — no fallback to the main model, since a guess is not worth frontier tokens), or
   *  natively on a claude-cli brain, which emits one with the turn. */
  nextSuggest?: boolean;
  /** Extra models the operator keeps within reach. `model` stays the default; these are the
   *  alternates the session composer offers, so switching mid-session is a shortlist rather than a
   *  scroll through a thousand ids. Not used unless the operator picks one. */
  altModels?: ModelConfig[];
  /** What runs the main agent (default "pi"). */
  engine?: AgentEngine;
  /** For a CLI engine (claude-cli): which model the CLI uses for the session — passed as `claude --model`.
   *  A short alias ("sonnet" | "opus" | "haiku") or a full model id; absent/"default" = the CLI's own
   *  default. Applies to new AND continued turns (claude --model works on --resume). */
  cliModel?: string;
  /** Registered CLI account ids this agent may run as, per engine, in preference order. The first
   *  usable (not rate-limited) account runs; on a usage limit the turn rotates to the next of the
   *  SAME list. undefined = not configured (engine-wide active account, and the UI may prompt);
   *  an empty array = the operator explicitly chose the default (don't prompt again). */
  cliAccounts?: Partial<Record<CliEngineId, string[]>>;
  /**
   * The order this agent falls THROUGH suppliers, when it holds accounts on more than one.
   *
   * Kept beside `cliAccounts` rather than inferred from its key order: that map goes through a zod
   * object on the way in, and zod rebuilds objects in SCHEMA key order — so the operator's arrangement
   * would silently become alphabetical-by-definition. First entry is the engine a turn starts on.
   */
  cliEngineOrder?: CliEngineId[];
  /** Operator-selected working folder RELATIVE to the workspace root ("" / undefined = root). Scopes the
   *  chat header's TODOS.md + derived actions (and where TODOS.md is maintained). Always inside the workspace. */
  workingFolder?: string;
  /**
   * Folders the operator pinned as PROJECTS — workspace-relative, same vocabulary as workingFolder.
   *
   * They are entry points, not state: each one renders as a row above the session list, and clicking
   * it starts a fresh session already working in that folder. Explicit only — nothing infers a pin
   * from use, because a list that reorders itself is a list you have to re-read every time.
   */
  pinnedFolders?: string[];
  /** When the agent may run autonomously (inbound/scheduled/dispatched). Default: always. */
  activeHours?: ActiveHours;
  capabilities: Capabilities;
  /** Installed comms channel ids (off by default — installed like skills). */
  installedChannels: string[];
  /** Human-readable Overblast workspace name this agent's key points at (for at-a-glance identification). */
  overblastWorkspace?: string;
  /** Which shared Overblast key (from the vault registry) this agent uses — resolves to the actual key. */
  overblastKeyId?: string;
  /** Connected Overblast platform ids (instagram, whatsapp, email, …) — drives the per-platform channels. */
  overblastPlatforms?: string[];
  /**
   * THE KEY'S SHAPE: true when the connected workspace key was minted by a MEMBER rather than the
   * workspace owner (`/api-keys/me` answers a card whose `role` is not `owner`).
   *
   * A flag rather than a re-read of the card below, because it is asked on every poll tick from
   * synchronous code and the card is a network answer. The two are written in the same breath and by
   * one function (`member-scope.ts`), so they cannot disagree.
   *
   * WHAT IT MEANS HERE: this agent is "you, in that workspace" — a shallow member agent. It keeps its
   * tasks in step and reads what its person may read; it does not answer the workspace's inbox, does
   * not hold its listener socket, and does not publish config the member's role may not write.
   */
  memberScoped?: boolean;
  /**
   * The identity card as of the last successful status read — WHO this key is over there.
   *
   * Re-read on every `/overblast/status`, and deliberately so: a member can be promoted, demoted,
   * moved between groups or have a capability taken away while the app is open, and a card cached at
   * connect time would render a surface the very next request refuses.
   */
  memberCard?: WorkspaceMemberCard;
  /** Set when the workspace answered `401 member_seat_revoked` — see {@link WorkspaceSeatRevoked}. */
  memberSeatRevoked?: WorkspaceSeatRevoked;
  /**
   * Per-tool switches for the platform tools the MAIN agent gets while its workspace is connected and
   * linked — the names in `OVERBLAST_TOOLS`.
   *
   * ABSENT means "all on" — the tools appear the moment a workspace is bound, and this map only ever
   * turns one OFF. That default matters: an operator who connects a workspace expects its tasks and
   * knowledge to be reachable, not a second opt-in list to discover.
   */
  overblastTools?: Record<string, boolean>;
  /** Do this agent's own tasks and task templates travel to its workspace? Absent = `linked`, the
   *  default. See {@link EntitySyncMode} for why that is the default and what the other word means. */
  entitySync?: EntitySyncMode;
  /** This agent's own answer for a turn a crash cut short. ABSENT = inherit the machine-wide policy,
   *  which is what an operator who never opened the setting meant. See {@link ResumeInterruptedPolicy}. */
  resumeInterrupted?: ResumeInterruptedOverride;
  /** Extra tools granted to the restricted public/DM (light) agent. Off by default. */
  publicExtras: PublicExtras;
  /** True until the BOOTSTRAP.md interview is completed. */
  onboarded: boolean;
  /** Signal: auto-reply to inbound DMs when polled. Off by default — always safe to just read. */
  signalAutoReply?: boolean;
  /** Signal: how often to check for unread conversations, in minutes. Default 15. */
  signalPollMinutes?: number;
  /** Per-channel + per-conversation auto-reply behavior (INBOUND light-agent replies). */
  autoReply?: AutoReplySettings;
  /** Group-chat engagement policy: reply to all group messages, or only when addressed (name/alias). */
  groupEngage?: GroupEngageSettings;
  /** How often (hours) the background task rebuilds contact profiles from history. Default 24; 0 = off. */
  contactProfileHours?: number;
  /** Sections to extract into a contact profile (order matters). Empty/absent = the default schema. */
  contactProfileTopics?: string[];
  /** Optional hook: on a 1:1 contact's birthday (during active hours) the agent runs this instruction to
   *  send them a message (respecting quarantine/auto-reply). Empty/undefined = off. */
  birthdayHook?: string;
  /** Per-channel + per-conversation policy for the main agent's OUTGOING messages. */
  outgoing?: OutgoingSettings;
  /** Append `signature` on a new line to every outgoing TEXT message (message/reply/comment) the agent
   *  sends. Use it to disclose the recipient is talking to an AI — required when targeting EU customers
   *  under the EU AI Act. Off by default. */
  signMessages?: boolean;
  /** The signature text appended when `signMessages` is on (e.g. "— sent by an AI assistant"). */
  signature?: string;
  /** How the agent's browser keeps cookies/localStorage between sessions. Absent = "shared". */
  browser?: BrowserSettings;
  /** Voice/meeting settings for `uc join --mode audio` — STT/TTS/voice, or a realtime S2S model. */
  voice?: VoiceConfig;
  /** Default language (ISO code, e.g. "pt", "en", "es"). When set, the agent answers in this language
   *  (text + meeting voice) and STT is forced to it. Absent = auto / follow the user. */
  language?: string;
  /**
   * Set while this agent's PUBLIC half is answering from the Overblast cloud rather than from here —
   * "the flip". Not a lease and not `leased`: the engine keeps polling, keeps its socket and keeps
   * serving every non-Overblast channel; only the local light agent's Overblast inbound is switched
   * off (`autoReply.channels[<overblast-*>] = "off"`) while the workspace's `auto_reply_rules` answer
   * instead.
   *
   * `previousAutoReply` is what makes the flip REVERSIBLE: the modes those channels had before are
   * stashed here, because "off" is also a mode an operator may have chosen on purpose, and coming back
   * to a default would silently switch someone's quarantine into direct sending.
   */
  hostedPublic?: HostedPublic;
  /** MOBILE CONNECT: may this agent be driven from the phone? Deny by default; set only on
   *  this machine. The platform reads it and can never write it. */
  mobileConnect?: boolean;
}

/** See `AgentProfile.hostedPublic`. */
export interface HostedPublic {
  /** ISO timestamp of the flip — what the UI shows as "answering from the cloud since …". */
  since: string;
  /** The Overblast workspace (computerId) now answering. */
  workspaceId: string;
  /** The `autoReply.channels` modes of the flipped channels, as they were before. Restored on the way
   *  back; a channel missing from here comes back as the "approve" default. */
  previousAutoReply?: Record<string, string>;
}

/**
 * Whether this agent's public half COULD be hosted by the Overblast cloud.
 *
 * Two conditions, both structural rather than about configuration state: the agent has a public agent
 * at all, and the model that public agent would run on is not one only this machine can reach. The
 * cloud runs its own managed model (`openrouter/auto` on platform credits) — so a local-provider public
 * model is not a thing to migrate, it is a thing that cannot follow.
 *
 * Deliberately NOT a check for "is a workspace linked": the UI greys the control on this, and an agent
 * with no workspace has nowhere to go for a reason the link badge right beside it already explains.
 */
export function cloudEligible(profile: Pick<AgentProfile, "engine" | "publicModel" | "model">): boolean {
  if (!publicAgentEnabled(profile)) return false;
  return !isLocalProviderId((profile.publicModel ?? profile.model)?.provider);
}

/**
 * Whether the restricted public/DM ("light") agent is active for this agent. It ALWAYS runs on Pi —
 * never the CLI, which would expose the full tool set + the private workspace to untrusted contacts.
 *
 * - Pi-brained main → on (uses `publicModel`, else inherits the main model), as before.
 * - CLI-brained main → OFF by default, since there's no main Pi model to safely inherit; it turns on
 *   only when the operator explicitly picks a Pi `publicModel` for it.
 */
export function publicAgentEnabled(profile: Pick<AgentProfile, "engine" | "publicModel">): boolean {
  const engine = profile.engine ?? "pi";
  if (engine === "pi") return true;
  return !!profile.publicModel;
}

/** Progress over an agent's TODOS.md checklist (markdown `- [ ]` / `- [x]` items). */
export interface TodoSummary {
  total: number;
  done: number;
  /** Text of the still-unchecked items (for the idle-nudge + the header tooltip). */
  open: string[];
  /** Every checklist item in file order, with its checked state (for the session todos panel). */
  items: { text: string; done: boolean }[];
}

/**
 * One chat-header action button. Derived by the ENGINE from the working folder's own runner files
 * (package.json scripts, Makefile targets, justfile recipes) — never declared by a client. A leaf has a
 * `run` command; a group has `sub` children (e.g. "npm" -> dev / build / test).
 */
export interface AgentAction {
  label: string;
  /** Shell command / script executed in the agent's working folder. Leaf actions have this. */
  run?: string;
  /** Optional one-line description shown as a tooltip. */
  hint?: string;
  /** Nested sub-actions (rendered as a dropdown under this one). */
  sub?: AgentAction[];
}

export interface AgentSummary {
  id: string;
  /** Set when this agent lives on a FEDERATED PEER engine (the peer's hostname) — absent for local
   *  agents. Purely informational for the UI; all API calls route through the hub transparently. */
  host?: string;
  /** The peer engine's origin (e.g. "http://192.168.1.100:4600") when `host` is set — lets the UI
   *  deep-link to pages that must run against the peer directly (the meeting-capture recorder). */
  hostUrl?: string;
  /** Set when the peer engine that owns this agent is currently unreachable — the agent is shown
   *  grayed/offline and inputs are disabled until the peer comes back (or its address is updated). */
  hostOffline?: boolean;
  /** The owning peer is reached over an SSH tunnel (a headless server) — UIs badge these "SSH" so the
   *  operator always knows which faces live on a server versus the LAN. */
  hostSsh?: boolean;
  displayName: string;
  emoji: string;
  avatar?: AgentAvatar;
  /** The agent's accent color (hex). Absent = a deterministic per-id color. */
  color?: string;
  createdAt: string; // ISO — for recency ordering (e.g. the home page's latest agents)
  status: AgentStatus;
  onboarded: boolean;
  /** Muted: this agent's notch messages + macOS notifications are silenced (per-agent, overrides the
   *  app-level on). The in-app attention badge still shows. */
  muted?: boolean;
  /** Mirrors AgentProfile.leased: the agent is running as a cloud replica; local turns are refused. */
  leased?: { leaseId: string; mode: "full" | "paths"; paths?: string[]; since: string };
  /** Mirrors AgentProfile.cloudRuns: cloud session runs in flight — local turns keep working. */
  cloudRuns?: { leaseId: string; paths?: string[]; since: string; prompt?: string }[];
  /** The PUBLIC-slot placement: set when this agent's public light agent is flipped to the
   *  worker-native cloud (config, not a lease — independent of where the MAIN agent lives). */
  hostedPublic?: HostedPublic;
  /** MOBILE CONNECT: may this agent be driven from the phone at all? Deny by default, flipped
   *  only here on this machine — the platform can read it and never set it, or the operator's
   *  second lock would belong to the relay. */
  mobileConnect?: boolean;
  /** Mirrors AgentProfile.overblastKeyId: which saved workspace key this agent is bound to —
   *  cloud runs land on (and bill) that workspace; absent = the shared/default one. */
  overblastKeyId?: string;
  /** Meeting attention trigger words/phrases (see AgentProfile.attentionTriggers). */
  attentionTriggers?: string[];
  model: ModelConfig;
  publicModel?: ModelConfig;
  subagentModel?: ModelConfig;
  secondaryModel?: ModelConfig;
  /** Alternates offered in the session composer; `model` remains the default. */
  altModels?: ModelConfig[];
  /** Background/side tasks enabled (default true when absent). */
  backgroundTasks?: boolean;
  /** Predicted-next-message suggestions in the composer (default true when absent). */
  nextSuggest?: boolean;
  engine: AgentEngine;
  /** claude-cli session model override ("sonnet" | "opus" | "haiku" | full id); absent = CLI default. */
  cliModel?: string;
  /** Per-agent generation-model priority (Settings → agent → media). */
  mediaPrefs?: MediaModelPrefs;
  /** Per-engine CLI account association (see AgentProfile.cliAccounts). */
  cliAccounts?: Partial<Record<CliEngineId, string[]>>;
  /** Cross-supplier fallback order (see AgentProfile.cliEngineOrder). */
  cliEngineOrder?: CliEngineId[];
  activeHours: ActiveHours;
  /** Whether the agent is inside its active hours right now. */
  activeNow: boolean;
  capabilities: Capabilities;
  installedChannels: string[];
  /** Human-readable Overblast workspace name this agent is connected to (empty if none). */
  overblastWorkspace?: string;
  /** True when this agent's workspace key is MEMBER-shaped. See `AgentProfile.memberScoped` — the UI
   *  reads it to hide whole surfaces the workspace would refuse anyway. */
  memberScoped?: boolean;
  /** Who this connection is over there, as of the last status read. See `AgentProfile.memberCard`. */
  memberCard?: WorkspaceMemberCard;
  /** Set while the workspace says this member's seat is gone. See {@link WorkspaceSeatRevoked}. */
  memberSeatRevoked?: WorkspaceSeatRevoked;
  /** Per-tool switches for the Overblast platform tools. ABSENT (and an absent key) = ON — the map only
   *  ever stores the OFF entries, so a tool added later defaults on for everyone. See
   *  `AgentProfile.overblastTools`. Surfaced here so the settings UI can show the current state. */
  overblastTools?: Record<string, boolean>;
  /** Whether this agent's own tasks and task templates travel to its workspace. Absent = `linked`,
   *  the default. See {@link EntitySyncMode}. */
  entitySync?: EntitySyncMode;
  /** This agent's override for interrupted-turn resume. Absent = follow the machine (see
   *  {@link ResumeInterruptedPolicy}) — surfaced so the settings panel can draw the current state. */
  resumeInterrupted?: ResumeInterruptedOverride;
  publicExtras: PublicExtras;
  signalAutoReply?: boolean;
  signalPollMinutes?: number;
  /** How often (hours) the background task rebuilds contact profiles. 0 = off; undefined = default (24). */
  contactProfileHours?: number;
  /** Custom profile-extraction sections (empty/absent = default schema). */
  contactProfileTopics?: string[];
  /** Birthday-message hook instruction (empty = off). */
  birthdayHook?: string;
  /** Browser session settings (see AgentProfile.browser) — the panel reads persistence from here to
   *  decide whether to warn that a login it's about to take will outlive the session. */
  browser?: BrowserSettings;
  /** Append a signature line to every outgoing text message (EU AI Act disclosure). */
  signMessages?: boolean;
  /** The signature text appended when `signMessages` is on. */
  signature?: string;
  /** Voice/meeting settings (STT/TTS/voice or a realtime S2S model). */
  voice?: VoiceConfig;
  /** Default language ISO code (agent answers + STT forced to it). */
  language?: string;
  /** True when this agent has something waiting on the owner (an escalation, a 00-ask, or a
   *  notify_owner ping) — drives the "@" mark in the activity list and the nav-rail badge. */
  needsAttention?: boolean;
  /** True when the owner has marked any of this agent's sessions/conversations "unread" to revisit. */
  hasUnread?: boolean;
}
