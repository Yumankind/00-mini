/**
 * AN INBOX ITEM BECOMES AN ESCALATION — the same folder, the same shape, the same answer door (§5.6).
 *
 * "The owned agent shows them as `escalations/` (the existing folder) and answers through the same
 * approve-before-send door." That is not a metaphor: `escalations/<id>.json` is the engine's own
 * store (`apps/00d/src/escalations.ts`, one file per item beside `quarantine/`), the shape is
 * `@00/shared`'s `Escalation`, and `docs/agent-layout.md` lists the folder in the `record` class.
 * A browser agent that invented `inbox/` instead would be a second store for the same fact — and
 * the agent could then be moved to a Mac where the messages it was asked about simply are not there.
 *
 * ── THE MAPPING, FIELD BY FIELD, AND THE ONE ADDITION ──────────────────────────────────────────
 *
 *   `id`        the worker's `mid` (`iam_…`) — NOT a fresh nanoid, because the reply route is keyed
 *               on it and a second name for one message is a message that gets answered twice.
 *   `channel`   `"infinite"` — the channel vocabulary is open (the engine's is "uniform across every
 *               inbound channel: Signal, email, Overblast, …"), and this is one more.
 *   `threadId`  the visitor's `deviceId`, which is the only thread there is: a device polls
 *               `devices/me/messages` and sees its own items and their replies.
 *   `from`      the contact the visitor typed, or the device id when they gave none. Never invented.
 *   `question`  the item's text, verbatim and never truncated — the worker refuses long text rather
 *               than clipping it, precisely so this field is what somebody actually wrote.
 *   `status`    `answered` once the worker says `repliedAt`, `pending` until then.
 *   `kind`      THE ONE FIELD `Escalation` DOES NOT HAVE. `message` / `lead` / `task` is the wire's
 *               own distinction and losing it would make a sales lead look like a hello. It is added
 *               additively, the way `remote` was: a reader that does not know it ignores it, and the
 *               engine's `readJsonSafe` keeps unknown fields on the round trip.
 *
 * Nothing here sends anything. Filing an item is a write to the agent's own folder; the reply goes
 * out through `client.reply` only when a person presses the button, which is the approve-before-send
 * door the plan names.
 */
import type { AgentFs } from "@00/agent-fs";
import type { Escalation } from "@00/shared";
import type { InboxItem } from "./client.js";

/** The engine's folder name, from docs/agent-layout.md. Not `workspace/escalations`: it is agent state. */
export const ESCALATIONS_DIR = "escalations";

/** `Escalation` plus the wire's `kind`, which the shared type has no field for. */
export type InboxEscalation = Escalation & { kind: InboxItem["kind"] };

export function escalationPath(mid: string): string {
  return `${ESCALATIONS_DIR}/${mid}.json`;
}

/** The pure half: one inbox item as one escalation record. No filesystem, so a test can read it. */
export function escalationFor(agentId: string, item: InboxItem): InboxEscalation {
  return {
    id: item.mid,
    agentId,
    channel: "infinite",
    threadId: item.deviceId,
    from: item.contact ?? item.deviceId,
    question: item.text,
    status: item.repliedAt ? "answered" : "pending",
    kind: item.kind,
    createdAt: item.createdAt,
    ...(item.reply ? { answer: item.reply } : {}),
    ...(item.repliedAt ? { answeredAt: item.repliedAt } : {}),
  };
}

/**
 * Write one, creating the folder the browser scaffold does not make.
 *
 * `escalations/` is not in `SCAFFOLD_DIRS` — the browser agent had no inbound channel until now —
 * and `mkdir` creates parents and is not an error on an existing directory, so this is the cheapest
 * correct thing rather than a scaffold change that every existing agent would have missed anyway.
 */
export async function fileEscalation(fs: AgentFs, agentId: string, item: InboxItem): Promise<InboxEscalation> {
  const record = escalationFor(agentId, item);
  await fs.mkdir(ESCALATIONS_DIR);
  await fs.writeFile(escalationPath(item.mid), JSON.stringify(record, null, 2) + "\n");
  return record;
}

/** Read one back, or null. A file that will not parse is a file that is not there, as in the engine. */
export async function readEscalation(fs: AgentFs, mid: string): Promise<InboxEscalation | null> {
  try {
    return JSON.parse(await fs.readText(escalationPath(mid))) as InboxEscalation;
  } catch {
    return null;
  }
}

/** Mark the answer the owner just sent, so the folder and the panel say the same thing after a reload. */
export async function recordReply(fs: AgentFs, mid: string, reply: string, repliedAt: string): Promise<void> {
  const existing = await readEscalation(fs, mid);
  if (!existing) return;
  const next: InboxEscalation = { ...existing, status: "answered", answer: reply, answeredAt: repliedAt };
  await fs.writeFile(escalationPath(mid), JSON.stringify(next, null, 2) + "\n");
}
