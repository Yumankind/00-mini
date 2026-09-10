/**
 * Move live, the sending half — docs/HANDOFF-infinite-agent.md §7.1.
 *
 * WHY THE LOCAL COPY IS LOCKED LAST, AND ONLY ON AN ACK. §7's rule is one live residence, and the
 * failure it is trying to avoid is not "two copies" but "no copy": a browser that locked itself when
 * it finished SENDING would strand the person the moment the far side's import failed, on a device
 * that no longer opens its own agent. So this function does not touch the receipt at all — it
 * resolves with what the far side acknowledged, and the store writes the receipt from that. The
 * whole of the one-live-residence rule is therefore `await`.
 *
 * WHY THE CODE IS SHOWN BEFORE THE BUNDLE IS PACKED. Packing a real agent takes seconds (tar, gzip,
 * AES over the whole tree) and the person on the other device is waiting to type something. The room
 * exists first, the six words go on the screen, and the packing happens while they walk to the other
 * machine.
 *
 * NOTHING HERE LOGS THE CODE OR THE KEY. The code reaches the UI through `onCode` and dies with the
 * flow; the derived secret never leaves this function's scope.
 */

import { deriveTransferKeys, sendBundle, type TransferChannel } from "@00/agent-fs";
import { moveFilename } from "../lib/move.js";
import { createRoom, type RoomService } from "./room-client.js";
import { openTransferChannel, type OpenChannelOptions, type OpenedChannel } from "./sfu.js";

/** What the screen is showing, in the order it shows it. */
export type SendPhase = "opening" | "packing" | "waiting" | "sending" | "landing" | "done";

export interface SendHooks {
  /** The six words, the moment the room exists. Shown large; never logged, never in a URL. */
  onCode?(code: string): void;
  /** The four characters, once the far side is on the channel — §7.1's confirmation on both screens. */
  onConfirmation?(confirmation: string): void;
  onPhase?(phase: SendPhase): void;
  onProgress?(sent: number, total: number): void;
}

export interface SendDeps {
  /** The agent, sealed with the derived secret — `OwnedAgent.exportBundleFile` in the app. */
  exportBundle(secret: string): Promise<Uint8Array>;
  /** Whose agent it is: the name goes into the file name the far side shows. */
  profile(): { id: string; displayName: string; emoji: string } | null;
  rooms?: RoomService;
  open?(opts: OpenChannelOptions): Promise<OpenedChannel>;
  now?(): Date;
}

export interface SendResult {
  /** What the far side says it imported. */
  agentId: string;
  /** The name the bundle travelled under — the receipt shows it, as the file road's receipt does. */
  fileName: string;
  sha256: string;
  movedAt: Date;
}

export interface SendOptions {
  hooks?: SendHooks;
  /** Polled between chunks; the person pressing Cancel is the only thing that sets it. */
  cancelled?(): boolean;
}

export async function sendLive(deps: SendDeps, opts: SendOptions = {}): Promise<SendResult> {
  const hooks = opts.hooks ?? {};
  const profile = deps.profile();
  if (!profile) throw new Error("there is no agent in this browser to move");
  const now = deps.now?.() ?? new Date();

  hooks.onPhase?.("opening");
  const room = await (deps.rooms?.create?.() ?? createRoom());
  hooks.onCode?.(room.code);

  const keys = await deriveTransferKeys(room.code, room.salt);

  hooks.onPhase?.("packing");
  const bytes = await deps.exportBundle(keys.secret);
  const fileName = moveFilename(profile.displayName, now);

  hooks.onPhase?.("waiting");
  const opened = await (deps.open ?? openTransferChannel)({ room, role: "send" });
  try {
    const sent = await sendBundle(opened.channel as TransferChannel, {
      bytes,
      name: fileName,
      fingerprint: keys.confirmation,
      cancelled: opts.cancelled,
      onPeer: () => {
        hooks.onConfirmation?.(keys.confirmation);
        hooks.onPhase?.("sending");
      },
      onProgress: (n, total) => {
        hooks.onProgress?.(n, total);
        // The last chunk is not the end: the far side still has to prove the digest and import.
        // Saying so is the difference between a bar that sticks at 100% and a screen that explains.
        if (n >= total) hooks.onPhase?.("landing");
      },
    });
    hooks.onPhase?.("done");
    return { agentId: sent.agentId, fileName, sha256: sent.sha256, movedAt: now };
  } finally {
    await opened.close();
  }
}
