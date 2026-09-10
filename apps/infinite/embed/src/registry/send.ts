/**
 * CONFIRM, THEN POST — the one door out of the visitor's device (§5.6, §5.2.2).
 *
 * WHY THIS IS ITS OWN FILE AND NOT THREE LINES IN THE LOADER: it is the only place in the whole
 * embed where something a person typed leaves their browser, and the rule it enforces has to be
 * readable and testable in one screen. The rule is:
 *
 *     nothing is posted that the visitor has not just said yes to, with their own words in front
 *     of them.
 *
 * The runtime already gates `confirm` tools through `askPermission`, so in the normal path the
 * question is asked before the tool ever runs. This file holds BOTH halves anyway — it remembers
 * the text that was confirmed, and `send` asks again if it is handed something that was not — so
 * that a future caller that reaches `send` directly (a panel button, a form, a different runtime)
 * cannot post silently by taking a path the gate does not cover. A yes is spent when it is used: the
 * same text sent twice is asked twice, because the second one is a second thing the person is saying.
 */

import type { InboxInput, InboxResult } from "./client.js";

export interface OutboxDeps {
  post: (input: InboxInput) => Promise<InboxResult>;
  /** The panel's own dialog: the question, and the text about to be sent. Never `window.confirm`. */
  confirm: (question: string, detail: string) => Promise<boolean>;
  /** Called after a message is accepted — the loader starts the reply poll here. */
  onSent?: (mid: string) => void;
}

export interface OwnerOutbox {
  /** For `RuntimeExtensions.askPermission`: answers only for `send_to_owner`, and no for everything else. */
  askPermission: (req: { name: string; args: Record<string, unknown> }) => Promise<{ allowed: boolean }>;
  /** For `ToolDeps.sendToOwner`. */
  send: (kind: string, text: string, contact?: string) => Promise<{ ok: boolean; message: string }>;
}

export const CONFIRM_QUESTION = "Send this to the site owner?";

/** The plan's three kinds, and the safe reading of anything else. */
const asKind = (kind: string): InboxInput["kind"] => (kind === "lead" || kind === "task" ? kind : "message");

export function createOwnerOutbox(deps: OutboxDeps): OwnerOutbox {
  /** Texts the visitor has said yes to and that have not been spent yet. */
  const confirmed = new Set<string>();

  const ask = async (text: string): Promise<boolean> => {
    // The message itself is the detail, trimmed to something a bubble can hold: a confirmation that
    // does not show what is being sent is not a confirmation.
    const yes = await deps.confirm(CONFIRM_QUESTION, text.slice(0, 300));
    if (yes) confirmed.add(text);
    return yes;
  };

  return {
    async askPermission(req) {
      if (req.name !== "send_to_owner") return { allowed: false };
      const text = typeof req.args.text === "string" ? req.args.text.trim() : "";
      if (!text) return { allowed: false };
      return { allowed: await ask(text) };
    },

    async send(kind, text, contact) {
      const message = text.trim();
      if (!message) return { ok: false, message: "There was nothing to send." };
      if (!confirmed.has(message) && !(await ask(message))) {
        return { ok: false, message: "Nothing was sent." };
      }
      confirmed.delete(message);
      const sent = await deps.post({ kind: asKind(kind), text: message, ...(contact ? { contact } : {}) });
      if (!sent.ok) return { ok: false, message: sent.message };
      deps.onSent?.(sent.mid);
      return { ok: true, message: "Sent. The owner sees it in their agent; a reply appears here." };
    },
  };
}
