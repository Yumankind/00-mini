/** A saved Overblast API key in the shared vault registry — metadata only (never the raw key). Agents
 *  bind to one by id (AgentProfile.overblastKeyId), so several agents can share one workspace key. */
export interface OverblastKeyMeta {
  id: string;
  /** Human-readable workspace name this key points at. */
  workspaceName: string;
  /** Last 4 chars of the key, for disambiguation in the picker. */
  last4: string;
  /** Overblast account id the key is scoped to (used to dedupe re-adds of the same key). */
  accountId?: string;
}

// ── The 1:1 agent ⇄ workspace link ────────────────────────────────────────────────────────────────
// Invariant (enforced on the PLATFORM, not here): one Overblast workspace = one 00 agent. The engine
// claims the link when an agent connects; a second agent claiming the same workspace is answered with
// `already_linked` and has to explicitly replace the first one.

/** The 00 agent an Overblast workspace is currently linked to, as the platform reports it. */
export interface OverblastAgentLink {
  /** The 00 agent id holding the link (opaque to the platform). */
  agentId: string;
  /** Human-readable "<agent> · <machine>", so the operator can recognize a link made elsewhere. NULL
   *  when the link was claimed without one — display code must fall back to `agentId`. */
  label: string | null;
  /** Epoch ms (or ISO — the platform's shape is passed through untouched). */
  linkedAt: number | string;
  updatedAt: number | string;
}

/** `GET /agent-link/computers/:cid` — who holds the link, and when the engine last checked in. */
export interface OverblastLinkStatus {
  link: OverblastAgentLink | null;
  /** Freshness of the workspace's 00 engine (KV `enginePing:{cid}`). Null = never seen. */
  lastEnginePingAt: number | null;
}

/** Which way knowledge moves when an agent takes over a workspace that already had one. */
export type OverblastKnowledgeDirection = "push" | "pull";

/** What a knowledge push/pull actually moved — the payload of the `overblast.knowledge` timeline event. */
export interface OverblastKnowledgeResult {
  direction: OverblastKnowledgeDirection;
  /** PERSONA.md ⇄ system-prompt.md moved. */
  persona: boolean;
  /** BUSINESS.md ⇄ business-info.md moved. */
  business: boolean;
  /** KB files uploaded (push) or downloaded (pull). */
  files: number;
  /** KB files removed remotely because they were deleted locally (push only). */
  deleted: number;
  /** Sub-directories of workspace/public/ that were skipped (the KB is flat — see overblast-knowledge.ts). */
  skippedDirs: string[];
  /** Non-fatal failures; the batch is retried on the next sync tick. */
  errors: string[];
  /** Names left out of this batch because they keep failing and are serving a backoff (push only —
   *  see overblast-knowledge-sync.ts). Absent when nothing is parked. */
  parked?: string[];
  /** Where the pre-pull copy of workspace/public/ was written (pull only). */
  backupDir?: string;
}

/** `POST /api/overblast/connect` answered 409 because the workspace belongs to another 00 agent.
 *  Not an error state — the UI turns it into the "replace connection?" step. */
export interface OverblastAlreadyLinked {
  ok: false;
  status: "already_linked";
  current: OverblastAgentLink;
  lastEnginePingAt: number | null;
}

/** How much of a brain one side of the connection is holding. Used to decide whether connecting has to
 *  ask which side wins — see the decision matrix in overblast-knowledge.ts. */
export interface OverblastKnowledgeSide {
  /** PERSONA.md / system-prompt.md, ignoring whitespace-only content. */
  hasPersona: boolean;
  /** BUSINESS.md / business-info.md, same. */
  hasBusinessInfo: boolean;
  /** Files in workspace/public/ (local) or the `00-public` KB folder (remote), excluding those two. */
  kbFiles: number;
}

/** `POST /api/overblast/connect` answered 409 because BOTH sides already hold knowledge and only one
 *  can survive. Same shape of answer as `already_linked`, and the UI asks the same question: upload or
 *  download. Nothing is bound (and no link is held) until the direction comes back. */
export interface OverblastKnowledgeConflict {
  ok: false;
  status: "knowledge_conflict";
  remote: OverblastKnowledgeSide;
  local: OverblastKnowledgeSide;
}

// ---------------------------------------------------------------------------
// The flip: where the public agent runs
// ---------------------------------------------------------------------------

/** Which side is answering strangers. See `AgentProfile.hostedPublic`. */
export type OverblastPlacement = "cloud" | "local";

/** `GET /api/agents/:id/overblast/hosting` — where this agent's public half runs, and whether the
 *  other placement is even available. `reasons` is what the UI shows instead of a disabled control
 *  with no explanation. */
export interface OverblastHostingState {
  hosted: boolean;
  since?: string;
  workspaceId?: string;
  /** `cloudEligible(profile)` AND a linked workspace — i.e. the flip to the cloud can be attempted. */
  eligible: boolean;
  /** Human-readable reasons the flip is unavailable (empty when `eligible`). */
  reasons: string[];
  /** Installed Overblast channels this agent serves — what the flip would move. */
  channels: string[];
  /** Installed non-Overblast channels — machine-bound, they stay local in both placements. */
  localOnlyChannels: string[];
}

/** One step of a flip, as it landed. `ok:false` is a degradation that is reported, never swallowed. */
export interface OverblastHostingStep {
  step: string;
  ok: boolean;
  detail: string;
}

/** `POST /api/agents/:id/overblast/hosting` — the flip ran. */
export interface OverblastHostingResult {
  ok: true;
  direction: OverblastPlacement;
  steps: OverblastHostingStep[];
  /** Contact memories moved (up on the way to the cloud, down on the way back). */
  memories: number;
  /** Local contact memories with no platform `contactId` recorded — nothing to map them onto. */
  memoriesUnmapped: number;
  /** auto_reply_rules created/activated (cloud) or deactivated/removed (local). */
  rules: number;
  /** Conversations stamped into the seen ledger so the returning light agent does not re-answer them. */
  seenRebuilt: number;
  /** Channels whose autoReply mode this flip changed. */
  channels: string[];
  /** Things the operator should know but that did not stop the flip (non-Overblast channels stay
   *  local; a knowledge file failed; a memory could not be mapped). */
  warnings: string[];
}

/** The flip cannot proceed as asked and the UI has to ask one more question first. */
export interface OverblastHostingNeedsConfirm {
  ok: false;
  needsConfirm: "modes";
  /** Overblast channels whose auto-reply is NOT on "send" — the cloud has no quarantine step, so
   *  hosting them means they start sending directly. */
  channels: { channel: string; mode: string }[];
  warnings: string[];
}

/** The flip cannot proceed at all. */
export interface OverblastHostingRefused {
  ok: false;
  error: string;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// The backup: a dated copy of what the platform holds
// ---------------------------------------------------------------------------

/** One family of workspace data the backup could not read. Recorded rather than thrown: a task list
 *  the platform refused must not cost the operator the contact memories that came back fine. */
export interface OverblastBackupSkip {
  /** The file that is missing from the archive ("tasks.json", "contacts-memories/abc.md"). */
  what: string;
  /** Why, in the platform's own words. */
  error: string;
}

/** `POST /api/agents/:id/overblast/backup` — an on-demand, dated archive of the workspace's data.
 *
 *  Never read back by the engine (docs/cloud-public-agent.md, "Overblast keeps its data"): the
 *  platform stays the source of truth and this is a copy an operator can keep, read or hand over. */
export interface OverblastBackupResult {
  ok: true;
  /** Absolute path of the folder that was written. */
  dir: string;
  /** The workspace (computer) id the archive came from. */
  workspaceId: string;
  exportedAt: string;
  /** Rows per family, as written. A family that failed is absent here and present in `skipped`. */
  counts: Record<string, number>;
  skipped: OverblastBackupSkip[];
}

/** The backup could not start at all — no key, or no workspace behind it. Nothing was written. */
export interface OverblastBackupRefused {
  ok: false;
  error: string;
  reasons: string[];
}

/**
 * What the CONTAINER's 00-Cloud-credits brain can run (contract: no-BYOK mode). The container has
 * no local runtime and no vendor keys of its own — the platform's proxy is the only way it thinks —
 * so this is the whole menu, strongest first, and the first entry is what a new cloud agent gets.
 * The worker can still pin a different set at boot (OPENROUTER_PROXY_MODELS); this is the list the
 * app offers and the engine defaults to, kept in one place so the two can't drift.
 */
export const CLOUD_CREDIT_MODELS: { id: string; label: string; note: string }[] = [
  { id: "anthropic/claude-opus-5", label: "Claude Opus 5", note: "strongest" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", note: "balanced" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", note: "fastest, cheapest" },
];

/** The brain a cloud agent starts on unless the operator picks another. */
export const CLOUD_CREDIT_DEFAULT_MODEL = CLOUD_CREDIT_MODELS[0].id;

/**
 * IMAGE models the same workspace credits can buy — the shortlist image_generate offers by name.
 *
 * Deliberately a SHORTLIST rather than the proxy's whole image catalogue: this list is printed into a
 * tool description an agent reads on every turn, and a hundred ids there is not a menu. Anything else
 * the proxy serves is still reachable by passing its exact OpenRouter id as `model` — the proxy bills
 * any id truthfully, so the shortlist is about what gets RECOMMENDED, never about what is permitted.
 *
 * First entry is the default a bare prompt lands on: the cheap flash-image class, because an image
 * nobody named a model for should cost cents, not dollars.
 *
 * `edits` = the model takes reference images (everything here does today; the field exists so a
 * generate-only model can join the list without silently accepting an edit it will ignore).
 */
export const CLOUD_CREDIT_IMAGE_MODELS: { id: string; label: string; note: string; edits: boolean }[] = [
  { id: "google/gemini-3.1-flash-image", label: "Nano Banana 2 (Gemini Flash Image)", note: "cheap default — text→image and editing", edits: true },
  { id: "google/gemini-3-pro-image", label: "Nano Banana Pro (Gemini Pro Image)", note: "best at rendering text inside the picture", edits: true },
  { id: "openai/gpt-image-2", label: "GPT Image 2", note: "fine typography, detailed edits", edits: true },
  { id: "black-forest-labs/flux.2-pro", label: "FLUX.2 Pro", note: "photoreal generation", edits: true },
  { id: "bytedance-seed/seedream-4.5", label: "Seedream 4.5", note: "stylized generation", edits: true },
  { id: "x-ai/grok-imagine-image-2.0", label: "Grok Imagine 2.0", note: "bold, stylized", edits: true },
];

/** What a credits image generation runs on when nobody named a model. */
export const CLOUD_CREDIT_IMAGE_DEFAULT_MODEL = CLOUD_CREDIT_IMAGE_MODELS[0].id;

/**
 * OpenRouter bills a generated image as OUTPUT TOKENS — ≈1290 of them for a standard image — so a
 * per-token completion price × this lands on the real per-image rate. Shared because two surfaces
 * price the same picture: the media store's cards and the credits catalogue.
 */
export const TOKENS_PER_IMAGE = 1290;

/**
 * VIDEO models the same workspace credits can buy — the shortlist `video_generate` offers by name.
 *
 * A SHORTLIST, for the same reason the image one is: this list is printed into a tool description an
 * agent reads on every turn. Anything else the platform serves is still reachable by passing its id
 * as `model` — the door owns that catalogue, refuses an id it cannot price BY NAME, and answers with
 * the full menu when it does.
 *
 * NO PRICES HERE, and that is the important omission. A video's price lives in ONE table, on the
 * worker, keyed to a pinned quality tier (see `social/video-catalog.ts` in the platform repo); the
 * engine fetches it for display and never mirrors it. A second copy in this file would be right until
 * a provider moved, and then quietly wrong on the one surface a customer reads before spending.
 *
 * First entry is the default a bare prompt lands on. `seedance-1-lite` because it is the cheapest
 * thing on the menu that is still a real clip — a 4-second generation costs about 14¢ of credits, it
 * takes both a prompt and a start frame, and it does any length up to 12s. The same reasoning that
 * put a flash-image model at the head of the image list: a video nobody named a model for should cost
 * cents, not dollars.
 */
export const CLOUD_CREDIT_VIDEO_MODELS: { id: string; label: string; note: string; needsImage: boolean }[] = [
  { id: "seedance-1-lite", label: "Seedance 1 Lite", note: "cheap default — 4–12s, prompt or start frame", needsImage: false },
  { id: "fal-ltx", label: "LTX Video", note: "the cheapest clip there is — fixed length, silent", needsImage: false },
  { id: "kling-v2.5-turbo-pro", label: "Kling 2.5 Turbo Pro", note: "fast and sharp — 5s or 10s, start+end frame", needsImage: false },
  { id: "ltx-2-fast", label: "LTX-2 Fast", note: "long-form — up to 20s at 1080p, with sound", needsImage: false },
  { id: "veo-3.1-fast", label: "Google Veo 3.1 Fast", note: "premium motion at the fast tier — 4/6/8s", needsImage: false },
  { id: "wan-2.7-i2v", label: "Wan 2.7 (animate a picture)", note: "first+last frame control — needs a start image", needsImage: true },
];

/** What a credits video generation runs on when nobody named a model. */
export const CLOUD_CREDIT_VIDEO_DEFAULT_MODEL = CLOUD_CREDIT_VIDEO_MODELS[0].id;

/**
 * The MAIN agent's Overblast platform tools: the catalog, in registration order.
 *
 * Here rather than in the engine because BOTH sides need it and neither may be the one that knows: the
 * engine builds the tools from it, and the settings UI renders one switch per entry. A tool the UI has
 * never heard of is a tool the operator cannot turn off — which is how a per-tool switch quietly becomes
 * a lie — so the list is one thing in one place.
 *
 * `label`/`hint` are operator-facing ("what does this let my agent do"), NOT the model-facing tool
 * descriptions, which are far longer and live with each tool.
 */
export const OVERBLAST_TOOLS = [
  {
    name: "overblast_task",
    label: "tasks",
    hint:
      "Read, create and edit the workspace's tasks — appointments, orders, bookings — request a change " +
      "or cancellation on someone's behalf, attach files to a task, and read its task templates.",
  },
  {
    name: "overblast_generate_document",
    label: "documents",
    hint: "Fill one of the workspace's document templates and render it to PDF/HTML.",
  },
  {
    name: "ask_human",
    label: "ask a teammate",
    hint: "Push a question or an escalation to the workspace's team in the Overblast app.",
  },
  {
    name: "list_team",
    label: "team directory",
    hint: "Look up teammates and role groups so an escalation or an assignment reaches the right person.",
  },
  {
    name: "search_kb",
    label: "knowledge search",
    hint: "Semantic search over the workspace knowledge base, private folders included.",
  },
  {
    name: "propose_payment",
    label: "propose payments",
    hint:
      "Ask for money to move: adds a payment to the workspace's approval queue. Nothing is paid " +
      "until you approve it — here or in the app.",
  },
  {
    name: "overblast_leg",
    label: "run task legs",
    hint:
      "Let the agent run the counterparty side of a task: create its legs, bind them to threads, move " +
      "one to a new state, and release or discard the messages a playbook parked for you. Approving " +
      "sends the parked text to the counterparty exactly as it was written.",
  },
  {
    name: "publish_playbook",
    label: "publish playbooks",
    hint:
      "Publish a `*.playbook.json` file from the agent's workspace as a conversation program the " +
      "workspace can run. Each publish mints a new version; work already running keeps its own.",
  },
  {
    name: "list_playbooks",
    label: "playbook list",
    hint: "Read which conversation programs this workspace has, and the latest version of each.",
  },
] as const;

export type OverblastToolName = (typeof OVERBLAST_TOOLS)[number]["name"];

/** Whether a named platform tool is on. Absent map, or absent key, means ON — see `overblastTools`. */
export function overblastToolOn(tools: Record<string, boolean> | undefined, name: string): boolean {
  return tools?.[name] !== false;
}
