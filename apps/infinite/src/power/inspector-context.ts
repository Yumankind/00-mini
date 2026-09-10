/**
 * A PICKED ELEMENT → SOMETHING THE AGENT CAN READ.
 *
 * WHY IT IS PREPENDED TO THE PROMPT RATHER THAN PASSED AS CONTEXT. It was checked first:
 * `RunOptions` in `packages/agent-runtime/src/api.ts` carries `prompt`, `workspace`, `model`,
 * `brain`, `tools`, `maxSteps`, `sessionId` and `signal` — and no context of any kind. The runtime's
 * only other door is `createAgentRuntime({ context })`, which is spread once per turn from the
 * embed's site map and belongs to the WHOLE runtime, not to one message; hanging a per-message
 * selection off it would leak the last thing anyone clicked into every later turn of the session.
 * Extending the frozen surface for this is a contract change, and this feature does not need one.
 *
 * So the selection goes in as text, at the TOP of the message, in a fence with a name. That is
 * honest in three ways a hidden channel would not be: the person can see in the transcript exactly
 * what the agent was told, a session reopened later still carries it, and a local brain with no
 * function calling (every local brain today — see §6 finding 1) reads it as well as a strong one.
 *
 * WHAT IT DELIBERATELY DOES NOT SEND. The whole page, the whole stylesheet, or a screenshot. The
 * element, its selector, its accessible name, a trimmed `outerHTML`, its box, six computed styles and
 * the file it came from is what a person means by "this button" — and it fits in a few hundred
 * tokens, which matters when the brain answering is two gigabytes running on a laptop.
 */
import type { PickedElement } from "../lib/pick.js";

/** The fence tag. Named rather than bare so the agent can tell it from a code block in the message. */
export const SELECTION_FENCE = "00-selected-element";

/** The line under the composer that says what will be sent. */
export const SELECTION_NOTE = "Sent with your next message, as a block at the top of it.";

function line(label: string, value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text ? `${label.padEnd(10)}${text}` : null;
}

/** The block, on its own — what the chip's tooltip shows and what `withSelection` prepends. */
export function selectionBlock(pick: PickedElement): string {
  const styles = Object.entries(pick.styles ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
  const box = pick.box
    ? `${pick.box.width}×${pick.box.height} at (${pick.box.x}, ${pick.box.y})`
    : "";
  const head = [
    line("selector:", pick.selector),
    line("role:", pick.role === pick.tag ? pick.tag : `${pick.role} (<${pick.tag}>)`),
    line("name:", pick.name),
    line("text:", pick.text && pick.text !== pick.name ? pick.text : ""),
    line("file:", pick.source),
    line("url:", pick.source ? "" : pick.url),
    line("box:", box),
    line("styles:", styles),
  ].filter((l): l is string => l !== null);
  const body = pick.html ? `\nhtml:\n${pick.html}` : "";
  return ["```" + SELECTION_FENCE, head.join("\n") + body, "```"].join("\n");
}

/**
 * The message the runtime actually gets.
 *
 * The block goes FIRST and the person's own words last, because the words are the instruction and the
 * block is the subject: a model that reads the instruction last acts on the whole of what came before
 * it. An empty prompt still sends the block — "this one" with nothing else is a reasonable thing for
 * a person to type once they have clicked something, and the agent can ask what about it.
 */
export function withSelection(prompt: string, pick: PickedElement | null): string {
  if (!pick) return prompt;
  const text = prompt.trim();
  return text ? `${selectionBlock(pick)}\n\n${text}` : selectionBlock(pick);
}
