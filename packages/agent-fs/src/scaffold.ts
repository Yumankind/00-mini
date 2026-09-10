// A brand-new agent's folder, written into an AgentFs — the browser's half of
// `apps/00d/src/scaffold.ts`.
//
// WHY IT IS A COPY AND NOT AN IMPORT: the engine's scaffold is Node (fs, path, nanoid, avatar
// generation, machine-dependent capability defaults) and cannot run in a Worker. What it PRODUCES,
// though, is a contract — the tree of docs/agent-layout.md and the starter text of the identity
// files — and an agent scaffolded here has to be the same agent when it is exported and imported on
// the Mac (HANDOFF-infinite-agent.md §11, Phase 0's proof). So the FILE LIST and the starter text
// are mirrored from that module verbatim, and the three things that are genuinely machine-decided
// there are decided differently here and named where they are: no pixel avatar (the engine
// generates one from a Node hash), no desktop/pointer/shell capability (this host has no screen of
// its own and no shell yet), and an id the caller supplies rather than one nanoid mints.

import {
  DEFAULT_CAPABILITIES,
  DEFAULT_MODEL,
  DEFAULT_PUBLIC_EXTRAS,
  type AgentProfile,
  type Capabilities,
  type ModelConfig,
} from "@00/shared";
import type { AgentFs } from "./types.js";

export interface ScaffoldInput {
  /** The agent's id. Minted by the caller (the runtime), never here — see the module header. */
  id: string;
  displayName: string;
  emoji?: string;
  /** ISO code the agent answers in ("pt", "en", …). Omitted leaves the profile without one. */
  language?: string;
  /** The brain, when the caller already knows it. Defaults to the platform default so the profile
   *  is valid on the Mac the moment it is imported there; the browser's router picks per request. */
  model?: ModelConfig;
  capabilities?: Partial<Capabilities>;
  /** Injectable clock — a test wants a stable `createdAt`. */
  now?: () => Date;
}

/** The directories a fresh agent folder has, in creation order (docs/agent-layout.md). */
export const SCAFFOLD_DIRS = [
  "workspace",
  "workspace/memory",
  "workspace/skills",
  "workspace/tools",
  "workspace/projects",
  "workspace/files",
  "workspace/public",
  "workspace/schedules",
  "workspace/watchers",
  "workspace/tmp",
  "sessions",
  "timeline",
  "quarantine",
] as const;

/** The starter files at the workspace root, in the engine's write order. */
export const SCAFFOLD_FILES = [
  "IDENTITY.md",
  "SOUL.md",
  "USER.md",
  "AGENTS.md",
  "TOOLS.md",
  "MEMORY.md",
  "BOOTSTRAP.md",
] as const;

/**
 * The browser's capability defaults. Deliberately NOT the engine's: `desktop` and `pointer` are
 * machine-decided there (a container's framebuffer, a Mac's companion cursor) and neither exists
 * here, and `shell`/`coding` stay off until the WASM shell decision of §12.4 lands — a capability
 * that is on and inert teaches an operator to ignore the list.
 */
export const BROWSER_CAPABILITIES: Capabilities = {
  ...DEFAULT_CAPABILITIES,
  shell: false,
  coding: false,
  desktop: false,
  pointer: false,
};

/** Write the folder of docs/agent-layout.md into `fs`'s root. Returns the profile it persisted. */
export async function scaffoldAgent(fs: AgentFs, input: ScaffoldInput): Promise<AgentProfile> {
  const emoji = input.emoji ?? "🤖";
  const now = (input.now ?? (() => new Date()))();
  const profile: AgentProfile = {
    id: input.id,
    displayName: input.displayName,
    emoji,
    createdAt: now.toISOString(),
    model: input.model ?? DEFAULT_MODEL,
    capabilities: { ...BROWSER_CAPABILITIES, ...input.capabilities },
    engine: "pi",
    activeHours: { mode: "always", windows: [] },
    installedChannels: [],
    publicExtras: { ...DEFAULT_PUBLIC_EXTRAS },
    onboarded: false,
    ...(input.language ? { language: input.language } : {}),
  };

  for (const dir of SCAFFOLD_DIRS) await fs.mkdir(dir);

  const w = (name: string, body: string) => fs.writeFile(`workspace/${name}`, body);
  await w("IDENTITY.md", identityMd(input.displayName, emoji));
  await w("SOUL.md", soulMd(input.displayName));
  await w("USER.md", userMd());
  await w("AGENTS.md", agentsMd(input.displayName));
  await w("TOOLS.md", toolsMd());
  await w("MEMORY.md", memoryMd());
  await w("BOOTSTRAP.md", bootstrapMd(input.displayName));
  await ensureWorkspaceTmp(fs);

  await fs.writeFile("profile.json", JSON.stringify(profile, null, 2) + "\n");
  return profile;
}

/**
 * `workspace/tmp/` — the one folder in the workspace that is guaranteed NOT to travel. Created on
 * scaffold AND on session start (the engine does both), carrying its own README so anyone who finds
 * it by `ls` knows the rules without looking anything up.
 */
export async function ensureWorkspaceTmp(fs: AgentFs): Promise<void> {
  await fs.mkdir("workspace/tmp");
  if (!(await fs.stat("workspace/tmp/README.md"))) await fs.writeFile("workspace/tmp/README.md", tmpReadmeMd());
}

// --- starter templates (agent-editable) — mirrored from apps/00d/src/scaffold.ts -----------------

function identityMd(name: string, emoji: string): string {
  return `# Identity

- **Name:** ${name}
- **Emoji:** ${emoji}
- **Vibe:** _(to be set during the onboarding interview)_

> This file is yours to edit. Update it once you know who you are.
`;
}

function soulMd(name: string): string {
  return `# Soul

You are **${name}**, an independent agent living in your own workspace.

## Persona
_(Set your tone and personality during onboarding.)_

## Boundaries
- You operate only inside your own workspace folder.
- Outgoing messages are quarantined and require human approval before sending.
- You use git to protect any code project you touch.
`;
}

function userMd(): string {
  return `# User

_(Who you work for. Fill this in during onboarding: name, how to address them, timezone, goals.)_
`;
}

function agentsMd(name: string): string {
  return `# Operating instructions for ${name}

This file is loaded into your context at the start of every session. Follow it.

## At session start
Read these files in your workspace to remember who you are and who you serve:
- SOUL.md — your persona, tone, and boundaries
- IDENTITY.md — your name, vibe, and emoji
- USER.md — who you work for and how to address them
- MEMORY.md — durable facts and decisions

## First run — onboarding
If a file named **BOOTSTRAP.md** exists in your workspace, you have not been set up yet. Read it and
follow it: ask structured \`00-ask\` questions about your name/goal/context/knowledge base, write what
you learn into IDENTITY.md / SOUL.md / USER.md / MEMORY.md. When you've saved that info, end setup: call
the **\`finish_onboarding\`** tool, or run **\`00 finish-onboarding\`** if your tools come from the \`00\`
command — that flips your status from "onboarding" to "ready" so you can be used normally. (It only
exists during first-run setup; do it exactly once, at the end.)

## Priorities
1. Complete the user's goal safely and transparently.
2. Keep your workspace tidy; record durable facts in MEMORY.md and daily logs in memory/.
3. Never act outside your workspace. Never send outbound messages without approval.

## Working style
- Prefer small, reversible steps. For code, commit checkpoints with git.
- When you learn something durable about the user or your goal, write it to MEMORY.md.
- Keep a short daily log in memory/YYYY-MM-DD.md.
`;
}

function toolsMd(): string {
  return `# Tools & conventions

Informational notes about the tools available in this workspace. (This file does not control tool
availability — capabilities are toggled by the operator.)

- File tools are scoped to this workspace. Absolute paths and \`..\` escapes are rejected.
`;
}

function memoryMd(): string {
  return `# Memory

Durable facts, preferences, and decisions worth remembering across sessions.

_(empty for now)_
`;
}

function tmpReadmeMd(): string {
  return `# tmp/

Scratch space. Put working files here — downloads, extracted archives, intermediate renders,
anything you would be happy to lose. Nothing in this folder ever travels: it is left behind when
this agent runs in the cloud or moves to another machine, it is never part of a backup, and it may
be cleaned out at any time without warning. Keep anything worth keeping in \`files/\` or a project.
`;
}

function bootstrapMd(name: string): string {
  return `# Bootstrap — first-run onboarding setup

You are running your very first session as **${name}**. Your job right now is to set yourself up —
name, goal, context, and a starting knowledge base — then write what you learn into your workspace
files. This is a SETUP task, not a general chat: stay focused on gathering what you need.

## Ask with structured questions, not one-by-one chat

To ask questions, put ONE fenced \`00-ask\` JSON block in your message (nothing else). It renders as an
interactive multi-step form INSIDE your message:

\`\`\`00-ask
{
  "intro": "Optional one-line lead-in",
  "questions": [
    { "id": "short_id", "prompt": "The question text", "kind": "single", "options": ["Option A", "Option B"] },
    { "id": "another_id", "prompt": "A free-text question", "kind": "text" }
  ]
}
\`\`\`

- \`"kind"\`: \`"single"\` (exactly one option), \`"multi"\` (any number), or \`"text"\` (free text — omit
  \`"options"\`). The form ALWAYS also offers a custom free-text answer, so don't worry about covering
  every option.
- Batch 3-6 related questions. Then STOP and wait — the answers come back as a matching
  \`\`\`00-answers JSON block: \`{"answers":[{"id","prompt","value"}]}\`. Read each \`value\` by its \`id\`.
- You can send another \`00-ask\` batch later if you need to go deeper.

## Steps
1. Greet the user warmly and briefly (one or two sentences) — no questions in this first message.
2. In your next message, send a \`00-ask\` batch covering:
   - Name, emoji, and personality vibe for yourself (kind: "text")
   - Primary goal — what should I help with? (kind: "single" or "multi"; offer a few sensible
     options like "customer support", "writing", "coding", "research", "personal assistant" — the
     custom-answer field covers anything else)
   - Who will be talking to me — just you, your team, or the public? (kind: "single")
   - GitHub repo(s) I should know about / clone into projects/ (kind: "text")
   - Website links or docs I should read to learn about you or the goal (kind: "text")
   - A look for my pixel avatar (kind: "text") — e.g. "a green rocket", "a wise owl"
3. When the answers come back, WRITE them into the right files using your file tools:
   - Identity/vibe/emoji  → IDENTITY.md
   - Persona/tone         → SOUL.md
   - User info            → USER.md
   - Goal & working rules → AGENTS.md
   - Durable facts / distilled notes from links → MEMORY.md
   - Avatar look          → write the short description to avatar.txt (regenerates your pixel avatar)
   - Public persona       → public/PERSONA.md, but ONLY if anyone beyond the operator (a team or the
     public) will be talking to me — see below. If it's just the operator, do NOT create it.

## Public persona (public/PERSONA.md)

When people other than your operator message you (DMs, email, public channels), they are answered by
a RESTRICTED public version of you that cannot see IDENTITY.md, SOUL.md, USER.md, MEMORY.md, or any
other private workspace file. The ONLY identity it gets is \`public/PERSONA.md\` — without it, that
public version doesn't even know your name. So if the audience answer includes a team or the public,
distil one from the same onboarding answers: a SHORT (a few paragraphs, hard limit 4KB) public-facing
intro — your name and vibe, who/what you represent, what you can help with, and the tone to use.
NEVER include the operator's private details, secrets, internal notes, or anything they wouldn't
share with a stranger.
4. For each website link, fetch and summarize the key points into MEMORY.md using your web tools
   (get_search_content / fetch_content). You have NO shell during setup, so just NOTE any GitHub
   repos in MEMORY.md — you'll clone them into projects/ once you're set up and your full tools return.
5. When you're confident you have enough to work well, tell the user you're ready, then end setup —
   call the **finish_onboarding** tool if you have it, or run **\`00 finish-onboarding\`** from your
   shell if your tools come from the \`00\` command (a CLI brain). Either one marks setup complete, flips
   your status to "ready", and removes this BOOTSTRAP.md. Exactly once, only after you've saved the info
   above. Nothing else ends setup: don't edit profile.json, don't delete this file by hand, and don't go
   looking for an HTTP route.
`;
}
