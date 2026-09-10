import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_ID_KEY, MOVE_RECEIPT_KEY, kvDelete, kvGet, kvSet } from "../src/lib/kv.js";
import {
  bringingBack,
  closeBringBack,
  confirmMoved,
  downloadMove,
  forgetMoveReceipt,
  loadMoveReceipt,
  moveBusy,
  moveCode,
  moveDeepLink,
  moveError,
  moveFileName,
  moveReceipt,
  moveStep,
  movedAway,
  openBringBack,
  releaseAfterRestore,
  resetMove,
  toCodeStep,
  twoLiveCopies,
  unlockAnyway,
} from "../src/state/move.js";
import { MOVE_CODE_RE } from "../src/lib/move.js";

/**
 * The store, in a node runner and therefore with no IndexedDB and no agent booted — which is exactly
 * the shape of a browser that refuses storage, and the shape every one of these calls has to survive.
 * The steps, the reducer wiring and the refusals are what is pinned here; the two calls that touch a
 * document (`downloadMove`'s anchor, `openIn00`'s navigation) are covered by their refusal path only,
 * because a test that needed a document would have stopped testing the flow.
 */

beforeEach(async () => {
  resetMove();
  closeBringBack();
  await forgetMoveReceipt();
});

describe("the key/value store with no IndexedDB", () => {
  it("answers `not remembered` instead of throwing", async () => {
    await expect(kvGet(AGENT_ID_KEY)).resolves.toBeNull();
    await expect(kvSet(MOVE_RECEIPT_KEY, { a: 1 })).resolves.toBeUndefined();
    await expect(kvDelete(MOVE_RECEIPT_KEY)).resolves.toBeUndefined();
    await expect(kvGet(MOVE_RECEIPT_KEY)).resolves.toBeNull();
  });

  it("names its keys once, so two modules cannot spell them differently", () => {
    expect(AGENT_ID_KEY).toBe("agentId");
    expect(MOVE_RECEIPT_KEY).toBe("moveReceipt");
  });
});

describe("the move flow's state", () => {
  it("starts on the explanation with no secret in memory", () => {
    expect(moveStep.value).toBe("explain");
    expect(moveCode.value).toBe("");
    expect(moveFileName.value).toBe("");
    expect(moveDeepLink.value).toBe("");
    expect(moveBusy.value).toBe(false);
    expect(moveError.value).toBeNull();
  });

  it("mints a code on the way to step two", () => {
    const code = toCodeStep();
    expect(moveStep.value).toBe("code");
    expect(moveCode.value).toBe(code);
    expect(MOVE_CODE_RE.test(code)).toBe(true);
  });

  it("mints a different one when the person asks again", () => {
    const first = toCodeStep();
    const second = toCodeStep();
    expect(second).not.toBe(first);
    expect(moveCode.value).toBe(second);
  });

  it("drops the code when the panel closes", () => {
    toCodeStep();
    resetMove();
    expect(moveCode.value).toBe("");
    expect(moveStep.value).toBe("explain");
  });

  it("cannot export without an agent, and says so instead of pretending", async () => {
    toCodeStep();
    await expect(downloadMove()).resolves.toBeNull();
    expect(moveStep.value).toBe("code");
    expect(moveBusy.value).toBe(false);
  });

  it("has no deep link until there is a file to name", () => {
    expect(moveDeepLink.value).toBe("");
  });
});

describe("the receipt, through the store", () => {
  it("is nothing at all until a move is confirmed", async () => {
    await expect(loadMoveReceipt()).resolves.toBeNull();
    expect(movedAway.value).toBe(false);
    expect(twoLiveCopies.value).toBe(false);
  });

  it("refuses to write one with no agent and no file behind it", async () => {
    await confirmMoved();
    expect(moveReceipt.value).toBeNull();
    expect(movedAway.value).toBe(false);
  });

  it("has nothing to release when there is no receipt", async () => {
    await releaseAfterRestore();
    expect(moveReceipt.value).toBeNull();
    await unlockAnyway();
    expect(moveReceipt.value).toBeNull();
    expect(twoLiveCopies.value).toBe(false);
  });

  it("opens and closes the bring-back form without touching the lock", () => {
    expect(bringingBack.value).toBe(false);
    openBringBack();
    expect(bringingBack.value).toBe(true);
    expect(movedAway.value).toBe(false);
    closeBringBack();
    expect(bringingBack.value).toBe(false);
  });
});
