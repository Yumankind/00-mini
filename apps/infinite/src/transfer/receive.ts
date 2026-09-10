/**
 * Receive live — docs/HANDOFF-infinite-agent.md §7.1, the other end of send.ts.
 *
 * WHY THE REPLACE QUESTION IS ASKED HERE AND NOT EARLIER. This browser may already hold an agent
 * (the PWA scaffolds one on first visit, §4.1), and importing over it is destructive in the way the
 * Mac's import door treats as a decision rather than a flag: the agent that is here becomes the one
 * in the bundle, memory and sessions included. The question is therefore asked at the last moment,
 * when the bytes have arrived and their digest has been proven — so the person is answering "replace
 * this agent with THAT one", not "would you maybe replace something later".
 *
 * WHY THE ACK IS SENT AFTER THE IMPORT AND NOT BEFORE. It is the far side's licence to lock its own
 * copy (§7's one live residence). An ack sent on arrival would lock the sender while this device was
 * still deciding whether it could write the files at all.
 *
 * The code the person typed is used twice: to join the room, and — with the room's salt — to derive
 * the bundle's key. It is never stored and never put in a URL.
 */

import { deriveTransferKeys, receiveBundle, TransferAborted, type HelloFrame } from "@00/agent-fs";
import { isMoveCode } from "../lib/move.js";
import { joinRoom, type RoomService } from "./room-client.js";
import { openTransferChannel, type OpenChannelOptions, type OpenedChannel } from "./sfu.js";

export type ReceivePhase = "joining" | "waiting" | "receiving" | "importing" | "done";

export interface ReceiveHooks {
  /** The four characters to compare with the other screen, as soon as the room is known. */
  onConfirmation?(confirmation: string): void;
  onPhase?(phase: ReceivePhase): void;
  /** Name and size of what is coming, from the sender's `hello`. */
  onIncoming?(hello: HelloFrame): void;
  onProgress?(received: number, total: number): void;
}

export interface ReceiveDeps {
  /** Land the bundle — `importBundleInto` on the OPFS root, through `OwnedAgent.importBundleFile`. */
  importBundle(bytes: Uint8Array, secret: string): Promise<{ agentId: string }>;
  /** True when this browser already holds an agent, so replacing it is a decision. */
  hasAgent(): boolean | Promise<boolean>;
  /** Asked only when it is: the person's answer, in their own words on screen. */
  confirmReplace?(hello: HelloFrame): Promise<boolean>;
  rooms?: RoomService;
  open?(opts: OpenChannelOptions): Promise<OpenedChannel>;
}

export interface ReceiveResult {
  agentId: string;
  bytes: number;
  name: string;
}

export async function receiveLive(
  code: string,
  deps: ReceiveDeps,
  hooks: ReceiveHooks = {},
): Promise<ReceiveResult> {
  const typed = code.trim().toLowerCase();
  // The same shape the Mac validates and `newMoveCode` mints — refused here rather than at the
  // worker, so a mistyped word costs nothing and says so immediately.
  if (!isMoveCode(typed)) throw new Error("that is not a six-word code — check the words and the dashes");

  hooks.onPhase?.("joining");
  const room = await (deps.rooms?.join?.(typed) ?? joinRoom(typed));
  const keys = await deriveTransferKeys(typed, room.salt);
  hooks.onConfirmation?.(keys.confirmation);

  hooks.onPhase?.("waiting");
  const opened = await (deps.open ?? openTransferChannel)({ room, role: "receive" });
  try {
    const result = await receiveBundle(opened.channel, {
      fingerprint: keys.confirmation,
      onHello: (hello) => {
        hooks.onIncoming?.(hello);
        hooks.onPhase?.("receiving");
      },
      onProgress: (received, total) => hooks.onProgress?.(received, total),
      land: async (bytes, hello) => {
        if (await deps.hasAgent()) {
          const allowed = deps.confirmReplace ? await deps.confirmReplace(hello) : false;
          if (!allowed) throw new TransferAborted("refused", "this browser already holds an agent");
        }
        hooks.onPhase?.("importing");
        return deps.importBundle(bytes, keys.secret);
      },
    });
    hooks.onPhase?.("done");
    return { agentId: result.agentId, bytes: result.bytes, name: result.name };
  } finally {
    await opened.close();
  }
}
