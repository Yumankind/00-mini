/**
 * The live transfer, mounted — docs/HANDOFF-infinite-agent.md §7.1.
 *
 * WHY `mountTransfer(deps)` AND NOT AN IMPORT OF THE AGENT. `runtime/bootstrap.ts` is THE place the
 * packages are constructed, and this folder deliberately does not reach into it: it takes the two
 * operations a transfer needs — seal the agent with a secret, land a bundle with a secret — and knows
 * nothing else about how the agent is built. That is what makes the whole flow testable in node
 * against a MemoryFs, and what keeps a second `new OpfsFs(...)` from appearing outside the one file
 * that is allowed to have one.
 *
 * The store (`state/move.ts`) mounts this from the booted agent, so bootstrap.ts needs no edit at
 * all. If it should ever hand the transfer out itself, the one line is:
 *
 *     transfer: mountTransfer({
 *       exportBundle: (secret) => exportBundle(fs, { secret, host: "browser" }),
 *       importBundle: async (bytes, secret) =>
 *         ({ agentId: (await importBundleInto(fs, bytes, { secret })).manifest.agentId }),
 *       profile: () => profile,
 *       hasAgent: () => true,
 *     }),
 */

import { sendLive, type SendDeps, type SendOptions, type SendResult } from "./send.js";
import { receiveLive, type ReceiveDeps, type ReceiveHooks, type ReceiveResult } from "./receive.js";

export * from "./config.js";
export * from "./room-client.js";
export * from "./sfu.js";
export * from "./send.js";
export * from "./receive.js";
export * from "./wire.js";
export * from "./crypto.js";

/** Everything the two roads need, in one object the store can build from the booted agent. */
export type TransferDeps = SendDeps & ReceiveDeps;

export interface TransferApi {
  send(opts?: SendOptions): Promise<SendResult>;
  receive(code: string, hooks?: ReceiveHooks): Promise<ReceiveResult>;
}

export function mountTransfer(deps: TransferDeps): TransferApi {
  return {
    send: (opts) => sendLive(deps, opts),
    receive: (code, hooks) => receiveLive(code, deps, hooks),
  };
}
