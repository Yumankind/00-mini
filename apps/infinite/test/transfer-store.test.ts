// The live road as STATE — what the panel binds to, and the receipt it leaves behind.
//
// The agent is mocked (there is no OPFS in node) but the transfer is not: the store's own room and
// channel seams are given a fake room and a pair of loop channels, and a real `receiveBundle` runs on
// the other end. So what is asserted here is the thing that matters — the receipt is written ONLY
// after the far side acknowledged the import, and it says the agent left by the live road.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import { deriveTransferKeys, receiveBundle, sendBundle, toBase64Url, type TransferChannel } from "@00/agent-fs";

const CODE = "acorn-basil-cedar-dawn-ember-falcon";
const SALT = toBase64Url(new Uint8Array(16).fill(2));

const exported = new Uint8Array(30 * 1024).fill(6);
const fakeAgent = {
  profile: { id: "ag_1", displayName: "Zero", emoji: "🟢" },
  exportBundleFile: vi.fn(async () => new Blob([exported.slice().buffer as ArrayBuffer])),
  importBundleFile: vi.fn(async (_file: Blob, _secret: string) => ({ agentId: "ag_arrived" })),
};

vi.mock("../src/state/agent.js", () => ({ agent: shallowRef(fakeAgent) }));

const {
  answerReplace,
  forgetMoveReceipt,
  liveConfirmation,
  liveError,
  liveNeedsReplace,
  livePhase,
  liveProgress,
  moveReceipt,
  movedAway,
  resetLive,
  startLiveMove,
  startLiveReceive,
  askForReceive,
  clearReceiveWanted,
  receiveWanted,
} = await import("../src/state/move.js");

class LoopChannel implements TransferChannel {
  peer!: LoopChannel;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  private readonly handlers = new Set<(d: string | Uint8Array) => void>();
  private readonly pending: (string | Uint8Array)[] = [];

  send(data: string | Uint8Array): void {
    queueMicrotask(() => this.peer.deliver(data));
  }
  private deliver(data: string | Uint8Array): void {
    if (this.handlers.size === 0) {
      this.pending.push(data);
      return;
    }
    for (const h of [...this.handlers]) h(data);
  }
  onMessage(handler: (d: string | Uint8Array) => void): () => void {
    this.handlers.add(handler);
    for (const data of this.pending.splice(0)) handler(data);
    return () => this.handlers.delete(handler);
  }
  onBufferedAmountLow(): () => void {
    return () => {};
  }
  onClose(): () => void {
    return () => {};
  }
  close(): void {}
}

function loop(): [LoopChannel, LoopChannel] {
  const a = new LoopChannel();
  const b = new LoopChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

const room = {
  code: CODE,
  roomId: "rm_1",
  channel: "room-rm_1",
  salt: SALT,
  expiresAt: "",
  sfu: { sessionId: "s", token: "t", apiBase: "https://rtc.test/v1/apps/a" },
  publisherSessionId: "s",
};

beforeEach(async () => {
  resetLive();
  clearReceiveWanted();
  await forgetMoveReceipt();
  fakeAgent.exportBundleFile.mockClear();
  fakeAgent.importBundleFile.mockClear();
});

describe("moving live, as state", () => {
  it("writes the receipt only on the far side's ack, and stamps it `live`", async () => {
    const [mine, theirs] = loop();
    const keys = await deriveTransferKeys(CODE, SALT);
    let landed = false;

    const [ok] = await Promise.all([
      startLiveMove({
        rooms: { create: async () => room },
        open: async () => ({ channel: mine, close: async () => {} }),
      }),
      receiveBundle(theirs, {
        fingerprint: keys.confirmation,
        land: async (bytes) => {
          // The receipt cannot exist yet: this is the moment BEFORE the ack.
          expect(moveReceipt.value).toBeNull();
          expect(bytes).toEqual(exported);
          landed = true;
          return { agentId: "ag_1" };
        },
      }),
    ]);

    expect(ok).toBe(true);
    expect(landed).toBe(true);
    expect(fakeAgent.exportBundleFile).toHaveBeenCalledWith(keys.secret);
    expect(moveReceipt.value).toMatchObject({
      agentId: "ag_1",
      displayName: "Zero",
      via: "live",
      releasedAt: null,
    });
    expect(moveReceipt.value?.fileName).toMatch(/^zero-\d{4}-\d{2}-\d{2}\.00agent$/);
    // §7: the shell paints the receipt instead of the agent from here on.
    expect(movedAway.value).toBe(true);
    expect(livePhase.value).toBe("done");
    expect(liveProgress.value).toBe(100);
    expect(liveConfirmation.value).toBe(keys.confirmation);
  });

  it("leaves the agent live when the transfer fails, and says why", async () => {
    const [mine, theirs] = loop();
    const ok = await Promise.all([
      startLiveMove({
        rooms: { create: async () => room },
        open: async () => ({ channel: mine, close: async () => {} }),
      }),
      (async () => {
        // A peer that typed a different code derives a different fingerprint.
        theirs.send(JSON.stringify({ t: "ready", fp: "ZZZZ" }));
      })(),
    ]);
    expect(ok[0]).toBe(false);
    expect(moveReceipt.value).toBeNull();
    expect(movedAway.value).toBe(false);
    expect(livePhase.value).toBe("failed");
    expect(liveError.value).toMatch(/different key/);
  });

  it("keeps nothing in memory once the panel closes", async () => {
    resetLive();
    expect(liveConfirmation.value).toBe("");
    expect(livePhase.value).toBe("idle");
    expect(liveProgress.value).toBeNull();
  });
});

describe("receiving live, as state", () => {
  it("asks before replacing the agent that is here, then imports and reports", async () => {
    const [mine, theirs] = loop();
    const keys = await deriveTransferKeys(CODE, SALT);
    const bundle = new Uint8Array(20 * 1024).fill(3);

    const receiving = startLiveReceive(CODE, {
      rooms: { join: async () => room },
      open: async () => ({ channel: mine, close: async () => {} }),
    });
    const sending = sendBundle(theirs, { bytes: bundle, name: "zero.00agent", fingerprint: keys.confirmation });

    // The question appears only once the bytes are here and proven; answering it lets the import run.
    await vi.waitFor(() => expect(liveNeedsReplace.value).toBe(true));
    expect(fakeAgent.importBundleFile).not.toHaveBeenCalled();
    answerReplace(true);

    const [ok, sent] = await Promise.all([receiving, sending]);
    expect(ok).toBe(true);
    expect(sent.agentId).toBe("ag_arrived");
    expect(fakeAgent.importBundleFile).toHaveBeenCalledOnce();
    expect(fakeAgent.importBundleFile.mock.calls[0][1]).toBe(keys.secret);
    // Receiving is not moving away: this browser is the residence now.
    expect(moveReceipt.value).toBeNull();
  });

  it("refuses when the person says no, and writes nothing", async () => {
    const [mine, theirs] = loop();
    const keys = await deriveTransferKeys(CODE, SALT);
    const receiving = startLiveReceive(CODE, {
      rooms: { join: async () => room },
      open: async () => ({ channel: mine, close: async () => {} }),
    });
    const sending = sendBundle(theirs, {
      bytes: new Uint8Array(2048).fill(1),
      name: "n",
      fingerprint: keys.confirmation,
    });
    await vi.waitFor(() => expect(liveNeedsReplace.value).toBe(true));
    answerReplace(false);
    const [ok, sendResult] = await Promise.allSettled([receiving, sending]);
    expect(ok.status === "fulfilled" && ok.value).toBe(false);
    expect(sendResult.status).toBe("rejected");
    expect(fakeAgent.importBundleFile).not.toHaveBeenCalled();
    expect(livePhase.value).toBe("failed");
  });

  it("refuses a code that is not six words, without a room", async () => {
    const join = vi.fn();
    expect(await startLiveReceive("nope", { rooms: { join } })).toBe(false);
    expect(join).not.toHaveBeenCalled();
    expect(liveError.value).toMatch(/six-word code/);
  });
});

describe("the Connections door", () => {
  it("opens the Move pane already on the receiving road, once", () => {
    expect(receiveWanted.value).toBe(false);
    askForReceive();
    expect(receiveWanted.value).toBe(true);
    clearReceiveWanted();
    expect(receiveWanted.value).toBe(false);
  });
});
