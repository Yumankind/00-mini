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
// Entity sync — the local task/template folders ⇄ the workspace
// ---------------------------------------------------------------------------

/**
 * The families that travel. A new one is a row in the engine's kind table and a value here — see
 * `entity-sync.ts` and the P3 section of `docs/local-entities.md`.
 *
 * The two group families are here and their rows exist, but the workspace half of their doors does
 * NOT yet: until it ships, both routes answer 404, the loop parks the kind on its backoff ladder and
 * says so on the status route. That is the honest shape for a contract whose two sides land in
 * different repositories — the alternative is a row added later in a hurry, against a door nobody
 * wrote the local side for.
 *
 * They travel in OPPOSITE directions, and that asymmetry is the design rather than a limitation:
 *
 *   · `member-groups` — the GROUP comes DOWN only. A group id up there is an authorization principal
 *     (it feeds the session-token mint), and a local engine minting principals in somebody else's
 *     security domain is exactly what the "only the linked agent syncs" rule protects against. The
 *     workspace is the authority; this machine keeps a copy and MERGES it (`mergeMemberGroupDown`)
 *     rather than being overwritten by it, because the two sides do not describe the same object.
 *
 *     TWO MEMBER FIELDS GO UP, and nothing else does: a member's `role` and their `conversations`,
 *     PATCHed onto a roster row that already exists (`PATCH /team-members/:memberId` — the door that
 *     owns membership, so this is not a group push carrying a member list). They are facts the
 *     operator sets in a panel the workspace has no equivalent of, and before the roster learned the
 *     words for them they died on the next pull. A seat is a roster row with a non-empty email, and
 *     this path can neither create a row, delete one, nor write an address — so it cannot move that
 *     number.
 *   · `comms-groups` travels BOTH ways. An audience is nobody's principal — it grants nothing, costs
 *     no seat, and is the operator's own data — so the machine that has it offline is entitled to be
 *     the one that publishes it.
 */
export type EntitySyncKind = "tasks" | "task-templates" | "member-groups" | "comms-groups";

/** How many entities one side is holding, per kind. Used to decide whether connecting has to ask
 *  which side wins — the same shape and the same question as {@link OverblastKnowledgeSide}. */
export interface EntitySyncSide {
  tasks: number;
  taskTemplates: number;
}

/** Does this side hold anything worth losing? */
export function entitySideEmpty(side: EntitySyncSide): boolean {
  return side.tasks === 0 && side.taskTemplates === 0;
}

/**
 * `POST /api/overblast/connect` answered 409 because BOTH this agent's folders and the workspace hold
 * entities, and the first sync would otherwise decide silently which came out on top.
 *
 * The same shape as {@link OverblastKnowledgeConflict}, deliberately: the UI asks one question in one
 * step, and the answer travels back on the re-submit as `entities: 'push' | 'pull'`.
 *
 * What the two answers MEAN here is milder than for knowledge, and worth stating because it is why
 * the question can be answered casually: neither direction destroys anything. `push` sends the local
 * records up and then lets the ordinary two-way sync run; `pull` adopts the workspace's records
 * first. Both sides survive either way — the arbitration keeps a loser as a conflict sibling — so
 * this is a question about which copy is the STARTING POINT, not about which one is deleted.
 */
export interface OverblastEntityConflict {
  ok: false;
  status: "entity_conflict";
  remote: EntitySyncSide;
  local: EntitySyncSide;
}

/** One entity a sync could not move, and when it will be tried again. The entity-sync twin of
 *  `ParkedKnowledgeItem`. */
export interface ParkedEntityItem {
  kind: EntitySyncKind;
  id: string;
  failures: number;
  lastError: string;
  /** ISO — when it will be tried again. */
  nextAttemptAt: string;
}

/**
 * What `POST /overblast/disconnect { keepTasks: true }` copied onto this machine before it let go.
 *
 * Every number here exists because the alternative is a silence somebody discovers later. `skipped`
 * is a choice (the copy keeps a window — a month back, a quarter forward — not an archive);
 * `attachmentsLeft` is a limit (the documents come across, their bytes stay in the workspace's
 * storage behind the key being cleared); `failed` and `partial` are the honest half of an operation
 * run against a platform the operator may already be walking away from.
 *
 * A disconnect NEVER fails because of any of this. The copy is best-effort and the leaving is not.
 */
export interface OverblastKeptTasks {
  /** Rows written into this machine's folders. */
  copied: number;
  /** Rows the workspace holds that fall outside the kept window — not a failure, a choice. */
  skipped: number;
  /** Rows that could not be copied. Each one is named in `errors`. */
  failed: number;
  /** Attachments whose bytes stay in the workspace: the refs came across, the files did not. */
  attachmentsLeft: number;
  /** At most a handful, in the platform's own words. */
  errors: string[];
  /** True when the listing itself could not be completed — `copied` is then a floor, not a total. */
  partial: boolean;
}

/**
 * A local task row the sync has repeatedly failed to move up, named so somebody can act on it.
 *
 * WHY THIS IS A SHAPE AND NOT A LOG LINE. When an agent is linked, the workspace is the only task
 * store every surface reads — the `overblast_task` tool and the tasks panel both look up there. A
 * local row that will not sync is therefore invisible EVERYWHERE except one scrolling activity line
 * ("Not moved: tasks/…: Overblast 403: Insufficient permissions"), which nobody is watching at the
 * moment it scrolls past. The operator can lose real work without ever being told. This rides on the
 * local-tasks listing so the panel can say so, quietly and permanently, until it stops being true.
 *
 * `error` is the platform's own sentence, verbatim — see `StuckEntity.error` in the engine.
 */
export interface StuckTaskRow {
  taskId: string;
  /** The task's own title, or its id when it has none. */
  title: string;
  error: string;
  /** Consecutive attempts that ended in this same error. Two is the floor — one failure is weather. */
  attempts: number;
  /** ISO of the last attempt, when it is known. */
  lastTriedAt?: string;
}

/** `GET /api/agents/:id/entity-sync` — what the sync is doing for this agent right now. */
export interface EntitySyncStatus {
  /** `linked` unless the operator turned it off; see `EntitySyncMode`. */
  mode: "linked" | "local-only";
  /** True when this agent holds its workspace's 1:1 link. Holding a key is not enough. */
  linked: boolean;
  /** True when the loop is actually watching this agent — mode AND link AND a reachable workspace. */
  active: boolean;
  /** The workspace these entities are kept in step with, when there is one. */
  computerId?: string;
  lastSyncAt?: string;
  /** Per-kind counts of what this machine holds, tombstones excluded. */
  local: EntitySyncSide;
  /** Entities that keep failing and are serving a backoff. Empty in the healthy case. */
  parked: ParkedEntityItem[];
  /** Entities kept as conflict siblings and never yet looked at — see the arbitration rule. */
  conflicts: Array<{ kind: EntitySyncKind; id: string; at: string; path: string }>;
}

/** What one sync pass moved — the payload of the `overblast.entities` timeline event. */
export interface EntitySyncResult {
  /** Entities written to the workspace. */
  pushed: number;
  /** Entities written into this machine's folders. */
  pulled: number;
  /** Tombstones propagated, either direction. */
  deleted: number;
  /** Entities where both sides had changed; the loser was kept beside the winner, never dropped. */
  conflicts: number;
  /** Non-fatal failures; retried on a growing delay. */
  errors: string[];
  /** Ids left out of this pass because they keep failing. Absent when nothing is parked. */
  parked?: string[];
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

/**
 * The brain a cloud agent starts on unless the operator picks another — and, from here on, only the
 * FALLBACK for that: the live recommendation is a mark in the published model catalog (see
 * `resolveRecommendedModel`). This constant is what answers before the catalog has been read, and on
 * a machine whose catalog carries no mark at all.
 */
export const CLOUD_CREDIT_DEFAULT_MODEL = CLOUD_CREDIT_MODELS[0].id;

/**
 * WHICH MODEL A NEW AGENT SHOULD START ON, resolved rather than hard-coded.
 *
 * The recommendation used to be `CLOUD_CREDIT_MODELS[0]` and nothing else, which meant that the day a
 * stronger model shipped, recommending it took an app release — for a fact that is pure editorial and
 * changes far more often than the code around it does. So the recommendation became DATA: an entry in
 * `catalogs/llm-models.json` carries `recommended: true` (stamped from `scripts/llm-models-recommended.json`
 * during the catalog refresh), the doc is signed and published, and engines pick the change up on
 * their next verified read.
 *
 * The precedence, cheapest surprise first:
 *   1. a CATALOG-MARKED model this menu actually serves — the editorial answer, in marker order, so a
 *      list of marks is a fallback chain (mark the new model, keep the old one behind it, and machines
 *      whose proxy has not been given the new one yet still land somewhere sensible);
 *   2. what the PLATFORM said when it minted this brain, if it serves it — a workspace on a pinned
 *      model list gets its own opinion respected over ours;
 *   3. `CLOUD_CREDIT_DEFAULT_MODEL`, when served — the shipped answer, for a cold or unmarked catalog;
 *   4. whatever the menu does serve.
 *
 * Every branch is filtered through `served`, because the one failure this cannot have is recommending
 * a model the menu does not carry: that agent's first turn fails with a sentence about a model id,
 * which tells its owner nothing about what actually went wrong. Undefined only when the menu is empty.
 */
export function resolveRecommendedModel(input: {
  /** The model ids this menu can actually run — a workspace's proxy list, or the container's. */
  served: readonly string[];
  /** Ids the published catalog marks `recommended`, in the marker's own order. */
  marked?: readonly string[];
  /** What the platform recommended for this specific workspace, when it named one. */
  platformDefault?: string;
}): string | undefined {
  const served = input.served;
  if (!served.length) return undefined;
  const has = (id: string | undefined): id is string => !!id && served.includes(id);
  for (const id of input.marked ?? []) if (has(id)) return id;
  if (has(input.platformDefault)) return input.platformDefault;
  if (has(CLOUD_CREDIT_DEFAULT_MODEL)) return CLOUD_CREDIT_DEFAULT_MODEL;
  return served[0];
}

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

// ── The workspace's commerce, as the engine proxies it ───────────────────────────────────────────
//
// Everything below is money that belongs to the WORKSPACE and its customers — a spend the platform's
// queue holds, a payment somebody made, what a rail costs, what a task is owed. The engine reads these
// off the worker and hands them to a screen unchanged; the operator's OWN instruments (their cards,
// their crypto wallet) are a different subject and live in `money.ts`.
//
// SHAPES ARE PASSED THROUGH, NEVER RESHAPED — the snake_case ones especially. `SpendProposal` looks
// foreign here because it IS foreign: it is the worker's row, and renaming its columns on the way past
// would be a translation layer nobody asked for and one more place for the two repos to disagree.

/** One row of the payment approval queue, as the worker returns it (snake_case, its own store). */
export interface SpendProposal {
  id: string;
  computer_id: string;
  /** NULLABLE: the worker records the computer for certain and the agent when it knows one. A row filed
   *  by a surface that is not an agent has no agent id to give, and a client that assumed a string here
   *  would be rendering "null" at somebody. */
  agent_id: string | null;
  origin: string;
  task_id: string | null;
  conversation_id: string | null;
  payee: string;
  /** Integer minor units — never a float, because money is not a float. */
  amount_cents: number;
  currency: string;
  reason: string;
  /** JSON string of whatever the supplier needs to be paid ({iban, link, reference}), or null. A
   *  string, not an object: it is captured text the worker stores verbatim, so a reader parses it
   *  defensively rather than trusting a shape. */
  payment_details_json: string | null;
  status:
    | "proposed"
    | "approved"
    | "executing"
    | "paid"
    | "declined"
    | "cancelled"
    | "manual_required"
    | "manually_paid";
  proposed_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  settled_at: string | null;
  manual_receipt: string | null;
}

/**
 * WHAT KIND OF MONEY (worker migration 0089). One column, four meanings that were being conflated:
 *
 *   budget — an allowance: authority to propose a spend, no funds anywhere. The original meaning.
 *   real   — funds earmarked out of the workspace's OWN Stripe balance. The worker refuses an earmark
 *            larger than the account actually holds, which is what makes the word mean anything.
 *   credit — money owed TO the customer (goodwill, a deposit carried forward).
 *   refund — money returned to the customer, recorded against the task it came from.
 *
 * `budget` and `real` are spendable; `credit` and `refund` are the customer's side of the ledger and
 * never raise what a task may spend — a refund must not fund the next purchase.
 */
export type TaskMoneyKind = "budget" | "real" | "credit" | "refund";

/** How a payment ARRIVED. It decides how it can go back, so it is stored rather than inferred. */
export type TaskPaymentRail = "stripe-checkout" | "stripe-terminal" | "cash" | "transfer" | "other";

/**
 * One payment in the workspace's payer-keyed ledger (worker migration 0090).
 *
 * `taskId` is a LINK and may be null — a payment need not belong to a job, and the ones that do not are
 * exactly what no task page can show. `refundableCents` is the cap on giving it back.
 */
export interface CustomerPaymentRow {
  id: string;
  contactId: string | null;
  conversationId: string | null;
  channel: string | null;
  payerName: string | null;
  payerEmail: string | null;
  taskId: string | null;
  amountCents: number;
  refundedCents: number;
  refundableCents: number;
  currency: string;
  rail: TaskPaymentRail;
  paymentIntentId: string | null;
  note: string | null;
  recordedBy: string;
  paidAt: string;
}

/** One Stripe payment on a task, in cents, with what is still refundable on it. */
export interface TaskPaymentRecord {
  paymentIntentId: string;
  amountCents: number;
  refundedCents: number;
  /** amount − refunded, floored at 0. What a refund of THIS payment may be at most. */
  refundableCents: number;
  currency: string;
  paidAt?: string;
  refundedAt?: string;
}

/** One payer's running total, grouped by the worker over everything it holds. */
export interface PayerTotalRow {
  key: string | null;
  payerName: string | null;
  payments: number;
  paidCents: number;
  refundedCents: number;
  netCents: number;
  currency: string;
  lastPaidAt: string;
}

/** How money is meant to ARRIVE from one person: a link they open, a card they tap, cash in a hand, a
 *  bank transfer — or `null`, which is "nobody has said yet" and deliberately not a default. */
export type IncomingPaymentPref = "link" | "tap-to-pay" | "cash" | "transfer";

/**
 * ONE CONVERSATION'S COMMERCE RECORD — who to invoice, and how to pay them back.
 *
 * Scoped to the CONVERSATION and not to the person, because what somebody tells one conversation stays
 * in it (the same rule as saved-locations, and the reason contact-links are pointers rather than a
 * merge). An IBAN pasted into one thread is a fact that thread was told.
 *
 * TWO STORES ANSWER IN THIS SHAPE. On an Overblast channel the platform owns the record and the local
 * thread key IS its `conversationId`; on every other channel the engine owns a `commerce.json` in the
 * thread's own directory. Identical field names on purpose: the surfaces reading this must not be able
 * to tell the authorities apart except by the `source` the route stamps on the answer.
 *
 * Every field is optional and an absent one means UNSAID — a record is filled in over the life of a
 * conversation, so "no tax id" and "tax id we have not been told" are the same state and must render
 * the same way (as nothing). Delivery addresses are NOT here: saved-locations already owns those, also
 * per conversation.
 */
export interface ConversationCommerce {
  billingName?: string;
  billingLine1?: string;
  billingLine2?: string;
  billingCity?: string;
  billingPostalCode?: string;
  billingCountry?: string;
  taxId?: string;
  /** What KIND of tax id (`vat`, `nif`, `ein`…) — free text, because the world's list is not ours. */
  taxIdType?: string;
  incomingPref?: IncomingPaymentPref | null;
  /** THE PAYEE HALF: how to pay the person in this conversation, which is not always the billing name
   *  (a supplier invoices as a company and is paid into someone's account). */
  payeeName?: string;
  payeeIban?: string;
  payeePaymentLink?: string;
  /** What they asked to see on the transfer — an invoice number, a reference, a name to put on it. */
  payeeReference?: string;
  note?: string;
  /** Who last changed it. `operator` from this engine; the platform stamps its own writers. */
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * WHAT MOVING MONEY COSTS, as the worker prices it (`payment-fees.ts` over there) — asked, never
 * hardcoded on either side of the wire.
 *
 * One read, every rail. `manual` adds nothing (a person pays it themselves), `stripe-collect` takes the
 * platform's cut out of an incoming payment (so covering a 100.00 spend out of collected money takes
 * 106.00 present), and the two outgoing Stripe rails are UNAVAILABLE today — with the reason, and with
 * `unknownFees` set so no surface presents a total as final. A virtual card in particular needs Stripe
 * Issuing enabled AND a business cardholder created before it can exist at all.
 */
export type PaymentRail = "manual" | "stripe-collect" | "stripe-transfer" | "stripe-card";

export interface RailCost {
  rail: PaymentRail;
  direction: "in" | "out";
  amountCents: number;
  currency: string;
  feesCents: number;
  grossCents: number;
  netCents: number;
  fees: Array<{ label: string; cents: number }>;
  available: boolean;
  unavailable?: string;
  unknownFees?: boolean;
  /** What has to be ON the task for a payment of `amountCents` to happen over this rail. */
  funding: number;
}

/** One live-share link, as the platform mints it. `url` is the whole point — the thing to hand over. */
export interface TaskShare {
  shareId: string;
  token: string;
  url: string;
  expiresAt: string | null;
  permissions: { location: boolean; tracking: boolean; activity: boolean; tracker: boolean };
}

/** A link that already exists, as the listing reports it. No token: a listing is for deciding what to
 *  REVOKE, and re-handing an existing link is not something a list needs to enable. */
export interface TaskShareMeta {
  shareId: string;
  label?: string;
  todoTitle?: string;
  permissions: { location: boolean; tracking: boolean; activity: boolean; tracker: boolean };
  expiresAt?: string | null;
  createdAt?: string;
}

// ── Entity objects: the shape a task IS, wherever it lives ───────────────────────────────────────
//
// The worker mirrors every task and template into its bucket as a folder with an `object.json` at the
// top (`computers/{cid}/tasks/{taskId}/object.json`, see moltworker `entity-r2.ts`). The engine writes
// the SAME document into a local agent's workspace — `workspace/tasks/{uuid}/object.json` — for agents
// that have no Overblast workspace behind them. One shape, two homes.
//
// THE WORKER'S FIELD NAMES WIN, every one of them, including the ones that look redundant here
// (`assignedTo` beside `assignedToId` beside `assignedToIds`) and the ones a local agent will never
// fill (`taskPricing`, `paymentDeadlineAt`). A local task that spells a field its own way is a task
// that has to be TRANSLATED the day it syncs, and a translation layer is exactly the migration this
// design exists to avoid. Fields the local side does not use are simply absent, never renamed.
//
// TYPE names are prefixed (`TaskTemplateField`, not `Field`) because this module is re-exported from
// the package barrel and `Field` belongs to nobody. Property names are untouched.

/**
 * WHOSE JOB THIS IS — the client on a task, as a reference rather than a copy.
 *
 * Contact-first (the 2026-08-28 contract): `contactId` is the identity when there is one, and
 * everything else narrows it. `handle` carries the raw channel address for a client the agent has
 * never been introduced to properly (a phone number, an @name) — it is what a local agent usually
 * has, since minting contacts is not phase 1's job.
 *
 * `threadId` is the engine's own thread for this client. `conversationId` on the task is a DIFFERENT
 * field and stays where it is: that one is the platform's live link, the thread the task is attached
 * to right now and which an operator can re-target. This is who the client is; that is where the
 * conversation currently sits.
 *
 * `localOnly` marks a client the platform cannot reach — a Signal or iMessage correspondent, an agent
 * DM — so nothing downstream mistakes a local handle for something a workspace could message or bill.
 */
export interface TaskClientRef {
  platform: string;
  contactId?: string;
  handle?: string;
  threadId?: string;
  localOnly?: boolean;
}

/**
 * One file inside an entity folder.
 *
 * The two homes address the bytes differently and both spellings are kept rather than collapsed:
 * `kbUrl` is the worker's `kb://` sentinel (signed on read), `path` is the LOCAL relative
 * `files/{fileId}-{name}` under the entity folder. Relative on purpose — an object.json holding an
 * absolute `/Users/…` path stops being portable the moment the folder is copied, synced or restored,
 * which is the one thing this layout is for.
 */
export interface TaskFileRef {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** ISO-8601. */
  addedAt: string;
  addedBy: string;
  sourceMessageId?: string;
  /** Worker home: `kb://computers/{cid}/tasks/{taskId}/files/{fileId}-{filename}`. */
  kbUrl?: string;
  /** Local home: `files/{fileId}-{filename}`, relative to the task folder. */
  path?: string;
}

/** The template a task was filled from, frozen at the version it was filled at — so editing the
 *  template later never rewrites tasks already in flight. */
export interface TaskTemplateSnapshot {
  id: string;
  version: number;
  name: string;
  /** Raw form submission, unchanged from what was filled. */
  data: Record<string, unknown>;
  /** Flat captured leaves, so a reader can render "Buyer name: Alice" without replaying the
   *  template's visibility rules. */
  fields: Array<{ fieldId: string; label: string; type: string; value: unknown }>;
}

/**
 * A TASK, as stored in its folder's `object.json`.
 *
 * Every field is optional except `id` and `title`, because the two writers fill different halves and a
 * reader must never assume the other one ran. The worker fills the pricing/payment/assignment half
 * from a workspace; a local agent fills the half a person can type.
 *
 * `deletedAt` is how a task goes away. The folder is NEVER removed: a delete that leaves no trace is
 * indistinguishable from a task that never synced, and the day this store syncs it needs tombstones
 * to say "gone" rather than "not yet arrived". A vacuum that reclaims old tombstones is a later,
 * separate decision.
 */
export interface TaskObject {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  /** ISO-8601 start. */
  dateTime?: string | null;
  endDateTime?: string | null;
  /** ISO-8601 duration ("PT1H30M"). */
  duration?: string | null;
  location?: string | null;
  locationLatLng?: string | null;
  locationAddress?: string | null;
  locationName?: string | null;
  endLocationAddress?: string | null;
  endLocationName?: string | null;
  endLocationLatLng?: string | null;
  groupId?: string | null;
  groupTag?: string | null;
  assignedTo?: string | null;
  assignedToId?: string | null;
  assignedToIds?: string[];
  assignedAssets?: Array<{ assetId: string; assetName: string; units: number }>;
  /** Workspace-resolved pricing. Carried opaquely: a local agent has no catalog to resolve against,
   *  and inventing a second pricing model here would be the drift this shape exists to prevent. */
  taskPricing?: unknown;
  status?: string;
  priority?: string;
  contactId?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  platform?: string | null;
  /** The LIVE link — the conversation this task is attached to now. See {@link TaskClientRef}. */
  conversationId?: string | null;
  /** Where it was born. Stamped once, never rewritten. */
  originConversationId?: string | null;
  relativePosition?: string | null;
  templateSnapshot?: TaskTemplateSnapshot | null;
  paymentDeadlineAt?: string | null;
  paymentUpfrontPercent?: number | null;
  paymentUpfrontAmountCents?: number | null;
  paymentTermsSource?: string | null;
  recurrence?: unknown;
  recurrenceSeriesId?: string | null;
  attachments?: TaskFileRef[];
  /** The client, as a reference. Added by the 2026-08-28 contract; the flat `contact*` fields above
   *  stay for the worker's sake and the two agree when both are set. */
  client?: TaskClientRef;
  createdBy?: string;
  createdByName?: string;
  createdAt?: string;
  updatedAt?: string;
  /** ISO-8601 soft-delete tombstone. Present = gone. */
  deletedAt?: string | null;
}

/**
 * HOW LONG A TASK TAKES, in minutes — {@link TaskObject.duration} read rather than displayed.
 *
 * The store keeps a duration the way the platform writes it, as an ISO-8601 period ("PT1H30M"), and
 * every surface that wants to DRAW a task needs the same string as a number. Both halves of the app
 * ask: the engine projects it onto a workspace row, and the calendar turns it into the height of a
 * block. One parser, here beside the field it parses, because two would drift the first time one of
 * them learned about days.
 *
 * WHAT IT ACCEPTS is the calendar-shaped subset — weeks, days, hours, minutes, seconds. Not months
 * and not years: a task that takes "P1M" is not a task, and reading it would mean inventing a month
 * length. `null` for anything it cannot read, for a zero period, and for a negative one — a block
 * with no height is not a fact about a task, and a caller that gets `null` falls back to the minimum
 * block rather than drawing a lie.
 */
export function taskDurationMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    String(iso).trim().toUpperCase(),
  );
  if (!m) return null;
  const [, w, d, h, min, s] = m;
  if (!w && !d && !h && !min && !s) return null; // a bare "P"/"PT" states nothing
  const total =
    Number(w ?? 0) * 7 * 24 * 60 + Number(d ?? 0) * 24 * 60 + Number(h ?? 0) * 60 + Number(min ?? 0) + Number(s ?? 0) / 60;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.round(total);
}

/**
 * THE FIELD TYPES a task template may ask for — mirrored from the worker's `FIELD_TYPES`, in its
 * order, as a value so a runtime can check against it rather than trusting the compiler alone.
 *
 * ── WHY THIS LIST IS SHORTER THAN IT WAS (2026-08-28) ───────────────────────────────────────────
 *
 * Five entries left it and became ALIASES instead: `rich_text` → `textarea`, `pdf` → `file`,
 * `qr` → `barcode`, `rating` → `scale`, `table` → `repeatable_group`. Each pair was one behaviour
 * under two names — `rich_text` and `textarea` are validated by the identical branch, `pdf` is a
 * `file` with a mime hint, a QR code is a barcode, a rating is a bounded scale, and a table IS a
 * repeatable group drawn as a grid. Every renderer that drew them apart drew them the same, and every
 * validator that checked them apart checked them the same — so the second name was never a type, it
 * was a synonym that each new reader had to remember to list beside the first one. The ones that
 * forgot are the bugs this consolidation is about.
 *
 * NOTHING MIGRATES. A stored template keeps the exact word it was stored with, forever, and every one
 * of those words is still accepted at every door — they moved from the canon into
 * {@link TASK_TEMPLATE_FIELD_TYPE_ALIASES}, which is a promotion in tolerance, not a removal. What
 * shrank is the set a NEW template is authored against and the set a reader must branch on. Readers
 * get there by calling {@link normalizeTaskTemplateFieldType} on the way in — see the note on that
 * function for why every one of them must.
 */
export const TASK_TEMPLATE_FIELD_TYPES = [
  "text", "textarea", "email", "phone", "url",
  // `number` is the INTEGER one — a count, a quantity, a floor number. `decimal` is the one with a
  // fractional part. They are separate canonical types rather than one type with a flag because the
  // difference is what a renderer puts in `step` and what an extractor is allowed to round.
  "number", "decimal", "currency", "percentage",
  "date", "time", "datetime", "date_range", "duration", "recurrence",
  "options", "multi_options", "toggle", "scale", "tags",
  "file", "image", "video", "audio", "signature",
  "location",
  "team_member", "team_group", "asset", "contact", "catalog_item", "task_ref",
  "repeatable_group", "barcode", "color", "measurement",
] as const;

export type TaskTemplateFieldType = (typeof TASK_TEMPLATE_FIELD_TYPES)[number];

/** The words template authors reach for, mapped onto the ones the schema has. Same table the worker
 *  normalises with — a stored `select` would fall through every type switch forever.
 *
 *  The bottom half is the 2026-08-28 consolidation: five names that used to be canonical, kept
 *  accepted here forever so no stored template ever becomes unreadable. Plus `address`, which was
 *  never canonical and never should have needed to be — an author writing a field for a street
 *  address means `location`, whose value shape carries the address string. */
export const TASK_TEMPLATE_FIELD_TYPE_ALIASES: Readonly<Record<string, TaskTemplateFieldType>> = {
  select: "options",
  dropdown: "options",
  radio: "options",
  multiselect: "multi_options",
  multi_select: "multi_options",
  checkboxes: "multi_options",
  // Demoted 2026-08-28 — same behaviour, second name.
  rich_text: "textarea",
  pdf: "file",
  qr: "barcode",
  rating: "scale",
  table: "repeatable_group",
  // Author convenience, new in the same pass.
  address: "location",
};

/**
 * The canonical type for a caller-supplied `type`, or `null` when nothing sane maps to it.
 *
 * EVERY READER GOES THROUGH HERE, and after 2026-08-28 that stopped being advice. While the demoted
 * five were canonical, a reader could write `f.type === 'table'` and be right; now a stored `table`
 * and a stored `repeatable_group` are the same question spelled two ways, and a reader that compares
 * the raw string is right about only one of them. The rule is one line: normalise first, branch on
 * the answer.
 */
export function normalizeTaskTemplateFieldType(raw: unknown): TaskTemplateFieldType | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  if ((TASK_TEMPLATE_FIELD_TYPES as readonly string[]).includes(key)) return key as TaskTemplateFieldType;
  return TASK_TEMPLATE_FIELD_TYPE_ALIASES[key] ?? null;
}

/**
 * THE EXTRACTION CONTRACT — one line per canonical type saying what a VALUE for it looks like.
 *
 * Three different producers write template answers and they have to agree byte for byte, because one
 * validator reads all three: the worker's `template-eval.validateFieldValue`. The producers are
 *   · a language model extracting a task out of a sentence (engine `local-task-extract`, worker
 *     `template-reconstruct`),
 *   · a form a human fills in (the webchat widget's `collectTemplateData`, the local panel's
 *     answer collector),
 *   · and, since the same pass, a document template's variable fill.
 * Before this table each of them guessed, and they guessed differently: a model would answer a
 * `measurement` with the number `12`, the widget would answer it with `"12 kg"`, and the validator
 * wanted `{values: [12], unit: "kg"}`. Two of the three were silently wrong, and "silently" is the
 * part that mattered — an invalid value is a rejected submission, and a rejected submission is a task
 * that never existed.
 *
 * SO THE SHAPES BELOW ARE DESCRIPTIVE, NOT ASPIRATIONAL. Each one was read off the validator branch
 * that accepts it, not off what would be tidy. Two are worth flagging because the tidy guess is
 * wrong: `currency` is a plain NUMBER (the currency code belongs to the workspace, not to the answer),
 * and `measurement` carries `values` as an ARRAY — a measurement may have up to three axes, which is
 * how one type covers weight, capacity and W×H×D.
 *
 * Aliases are absent on purpose: a producer is told the canonical vocabulary, and a stored alias is
 * normalised before it ever reaches a lookup here.
 */
export const TASK_TEMPLATE_VALUE_SHAPES: Readonly<Record<TaskTemplateFieldType, string>> = {
  text: 'string — one line',
  textarea: 'string — may contain newlines',
  email: 'string — a valid email address',
  phone: 'string — digits with an optional leading "+", 8–15 digits',
  url: 'string — an http(s) URL; or {url, label?} when the link needs a name',
  number: 'number — a whole number (integer); no fractional part',
  decimal: 'number — may have a fractional part',
  currency: 'number — the amount in major units (e.g. 12.50). The currency itself is the workspace\'s, never part of the answer',
  percentage: 'number — 0–100, not 0–1',
  date: 'string — ISO-8601 date, "YYYY-MM-DD"',
  time: 'string — 24-hour "HH:MM"',
  datetime: 'string — full ISO-8601 timestamp',
  date_range: '{start, end} — both full ISO-8601 timestamps, end not before start',
  duration: 'string — ISO-8601 duration, e.g. "PT1H30M"',
  recurrence: '{freq, interval?, byWeekday?, byMonthDay?, byMonth?, endAt?, count?} — freq is required and is one of DAILY/WEEKLY/MONTHLY/YEARLY',
  options: 'string — exactly one of the field\'s option values (the value, never the label)',
  multi_options: 'string[] — each entry one of the field\'s option values',
  toggle: 'boolean — true or false, never "yes"',
  scale: 'number — within the field\'s min/max (this is what a star rating is)',
  tags: 'string[] — free-form short labels',
  file: 'array — one entry per file: a reference string, or {url, filename?, contentType?, size?} when the uploader knows them (that form is what `accept` / `maxFileSize` are checked against)',
  image: 'array — one entry per image: a reference string, or {url, filename?, contentType?, size?}',
  video: 'array — one entry per video: a reference string, or {url, filename?, contentType?, size?}',
  audio: 'array — one entry per clip: a reference string, or {url, filename?, contentType?, size?}',
  signature: 'array — a single signature, in a one-element list: a reference string or {url, filename?, contentType?, size?}',
  location: '{address?, lat?, lng?, name?} — an address string, coordinates, or both; at least one of address or lat+lng',
  team_member: 'string — a team member id (or string[] when the field pins several)',
  team_group: 'string — a team group id (or string[])',
  asset: 'string — an asset id (or string[])',
  contact: 'string — a contact id (or string[])',
  catalog_item: 'string — a catalog item id (or string[])',
  task_ref: 'string — a task id (or string[])',
  repeatable_group: 'object[] — one object per row, each keyed by the group\'s own nested field ids (this is what a table is)',
  barcode: 'string — the code\'s text content (this is what a QR code is)',
  color: 'string — a hex colour, "#RRGGBB" (or string[] when the field allows several)',
  measurement: '{values, unit} — values is an ARRAY of numbers, one per axis (1 for weight, 3 for W×H×D), unit is a string like "kg"',
};

/**
 * The contract as a block of prompt text — the exact lines an extraction prompt injects so a model
 * writes values the validator accepts. Pass the types actually present on the template so a five-field
 * form does not carry thirty-six lines of vocabulary it will never use.
 */
export function taskTemplateValueShapeLines(types: Iterable<string>): string {
  const seen = new Set<TaskTemplateFieldType>();
  for (const t of types) {
    const canonical = normalizeTaskTemplateFieldType(t);
    if (canonical) seen.add(canonical);
  }
  const wanted = TASK_TEMPLATE_FIELD_TYPES.filter((t) => seen.has(t));
  return wanted.map((t) => `- ${t}: ${TASK_TEMPLATE_VALUE_SHAPES[t]}`).join("\n");
}

/**
 * WHO A QUESTION IS FOR — the party filling the form, or the workspace behind it. The worker's
 * `FieldAudience`; the spelling there is authoritative and this is the twin.
 *
 * A template used to be one audience's form: everything on it went to whoever opened it, and
 * `visibility` decided who that was. That stops being true the moment ONE form is filled by more
 * than one party — a tenant answers half, the landlord answers the other half, and the operator's
 * own notes sit on the same sheet as both.
 *
 *   · `party`    (the default, and what an absent key means) — the surface's own filler answers it.
 *   · `internal` — the workspace answers it: never shown on a party surface, never accepted from
 *                  one, and never held against a party's submission.
 *
 * A section carries the same key and its fields inherit unless they override. NOT `visibility`:
 * that one is about the TEMPLATE (may a stranger file this form at all), this one about ONE QUESTION
 * on a form somebody is already allowed to file.
 */
export const TASK_TEMPLATE_FIELD_AUDIENCES = ["party", "internal"] as const;

export type TaskTemplateFieldAudience = (typeof TASK_TEMPLATE_FIELD_AUDIENCES)[number];

/** What an absent `audience` means, stated once so no reader re-decides it. */
export const DEFAULT_TASK_TEMPLATE_FIELD_AUDIENCE: TaskTemplateFieldAudience = "party";

/** The canonical audience for a caller-supplied value, or `null` when the word is not one of ours.
 *  For a gate that REFUSES; readers use {@link readTaskTemplateFieldAudience}. */
export function normalizeTaskTemplateFieldAudience(
  raw: unknown,
): TaskTemplateFieldAudience | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return (TASK_TEMPLATE_FIELD_AUDIENCES as readonly string[]).includes(key)
    ? (key as TaskTemplateFieldAudience)
    : null;
}

/**
 * The audience a field or section actually has — its own word, else the one it inherits, else
 * `party`. FAILS CLOSED on a word it does not know, exactly as the worker's `readFieldAudience`
 * does: an absent key is the default, a PRESENT key saying something else is read as `internal`,
 * because hiding a question by mistake can be corrected and showing a private one cannot.
 */
export function readTaskTemplateFieldAudience(
  raw: unknown,
  inherited: TaskTemplateFieldAudience = DEFAULT_TASK_TEMPLATE_FIELD_AUDIENCE,
): TaskTemplateFieldAudience {
  if (raw === undefined || raw === null || raw === "") return inherited;
  return normalizeTaskTemplateFieldAudience(raw) ?? "internal";
}

/**
 * THE SENTENCE AN AGENT AUTHORING A FORM IS GIVEN, generated rather than written.
 *
 * `create_template`'s `sections` parameter is where an agent learns what a task template may
 * contain, and it used to carry a HAND-COPIED list of field types. A hand-copied closed set is a set
 * that rots: that list still offered `rating`, `pdf` and `table` as types weeks after 2026-08-28
 * demoted them to aliases, and nothing anywhere would have said so if they had been deleted instead.
 *
 * So the vocabulary comes off the tables. The prose around it stays prose — "what min and max count"
 * is a judgement about the schema, not an enumeration of it — and the FULL reference (every value
 * shape, every save-time refusal, every output trigger and whether it fires) is generated on the
 * platform side and served at `GET /docs/task-templates`, which this points at rather than restates.
 */
export function taskTemplateSectionsHint(): string {
  return (
    "the form itself, as the platform's own template shape — an array of sections, each " +
    "{ id, label, description?, repeatable?, audience?, fields: [{ id, label, type, required?, " +
    "help?, options?, min?, max?, audience? }] }. Field types: " +
    TASK_TEMPLATE_FIELD_TYPES.join(", ") +
    " (older spellings such as " +
    Object.keys(TASK_TEMPLATE_FIELD_TYPE_ALIASES).slice(0, 4).join(", ") +
    " are accepted and rewritten). Ids are yours to choose and are what the answers come back keyed " +
    "by — slugs, stable, no spaces. `audience` says WHO answers a question: " +
    TASK_TEMPLATE_FIELD_AUDIENCES.join(" or ") +
    ' — "party" (the default) is the person filling the form in, "internal" is the workspace itself, ' +
    "which is never shown to a customer, never accepted from one, and never held against their " +
    "submission; put it on a section and its fields inherit it. `min`/`max` are ONE pair whose " +
    "meaning the type decides (characters for text, the value for numbers, entries for tags and " +
    "multi_options, FILES for uploads, rows for a repeatable) — dates and single-choice fields read " +
    "neither. An options or multi_options field MUST carry its `options`, and `min` above `max` is " +
    "refused. The platform validates all of this and answers with every problem it found, so send " +
    "your best attempt rather than a minimal one; its full generated reference is at " +
    "GET /docs/task-templates."
  );
}

/** One question on a template. Mirrors the worker's `Field`. */
export interface TaskTemplateField {
  id: string;
  label: string;
  type: TaskTemplateFieldType;
  help?: string;
  placeholder?: string;
  default?: unknown;
  required?: boolean;
  readOnly?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  options?: Array<{ value: string; label: string }>;
  accept?: string[];
  maxFileSize?: number;
  /** Workspace-linked binding, conditionals, and nested fields for composite types. Carried opaquely
   *  — a local template has no workspace to bind against, and dropping them on read would silently
   *  destroy a template that arrived from one. */
  bind?: unknown;
  visibleIf?: unknown;
  requiredIf?: unknown;
  /** Who answers this question — see {@link TaskTemplateFieldAudience}. Absent means the section's
   *  audience, and absent there too means `party`. */
  audience?: TaskTemplateFieldAudience;
  fields?: TaskTemplateField[];
}

/** One group of questions. Mirrors the worker's `Section`. */
export interface TaskTemplateSection {
  id: string;
  label: string;
  description?: string;
  repeatable?: boolean;
  min?: number;
  max?: number;
  visibleIf?: unknown;
  requiredIf?: unknown;
  /** Who answers the questions in this section — every field under it inherits unless it says
   *  otherwise. See {@link TaskTemplateFieldAudience}. */
  audience?: TaskTemplateFieldAudience;
  fields: TaskTemplateField[];
}

/**
 * A TASK TEMPLATE, as stored in its folder's `object.json`.
 *
 * `version` is the load-bearing field: it increments on every edit, and a task filled from this
 * template freezes the number it was filled at inside {@link TaskTemplateSnapshot}. Without it,
 * editing a template rewrites history for every task ever made from it.
 *
 * `visibility` defaults to `internal` on both sides, and that default is about consequences rather
 * than tidiness: `public` means an anonymous visitor can file tasks from this form. It is a decision
 * somebody has to make on purpose, never one they make by omitting a field.
 */
/**
 * ONE STATUS A RECIPE DECLARES FOR ITS OWN TASKS.
 *
 * A workspace's status vocabulary is one list for every task in it, which is the right shape for
 * `blocked` and the wrong shape for `awaiting parts` — a word that means something on a repair job
 * and nothing at all on an invoice. A template may therefore add words of its own, and only tasks
 * filed from that template offer them.
 *
 * `color` is CSS (`#4CAF50`), matching {@link TaskTemplateObject.color} beside it rather than the
 * ARGB integer the workspace's own status config holds — a local template is authored on this
 * machine, by a colour input that produces hex. Both spellings are read by one normaliser on the
 * client (`normalizeStatusColor`), so neither store has to convert for the other.
 *
 * Absent `color` is not black: it means nobody picked one, and the name's own stable swatch answers.
 */
export interface TaskTemplateStatus {
  id: string;
  label?: string;
  color?: string;
}

export interface TaskTemplateObject {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  visibility: "public" | "internal";
  sections: TaskTemplateSection[];
  /** The words THIS recipe adds to the status picker, on top of whatever the store publishes. Absent
   *  ⇒ this recipe adds none, which is every template written before the field existed. */
  statuses?: TaskTemplateStatus[];
  /** Catalog pricing, payment terms, release rules, task defaults — workspace concerns, carried
   *  opaquely so a synced template survives a round trip through a local agent unchanged. */
  pricing?: unknown;
  payment?: unknown;
  outputs?: unknown[];
  defaults?: unknown;
  /** Increments on every update. Tasks freeze the value they were filled at. */
  version: number;
  createdBy?: string;
  createdByName?: string;
  createdAt?: string;
  updatedAt?: string;
  /** ISO-8601 soft-delete tombstone. See {@link TaskObject.deletedAt}. */
  deletedAt?: string | null;
}
