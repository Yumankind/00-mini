import { describe, expect, it } from "vitest";
import {
  MOVE_CODE_RE,
  MOVE_CODE_WORDS,
  MOVE_STEPS,
  MOVE_WORDS,
  codeEntropyBits,
  importDeepLink,
  isLocked,
  isMoveCode,
  isSecondCopy,
  moveFilename,
  moveReceiptReducer,
  newMoveCode,
  nextMoveStep,
  receiptLine,
  type MoveReceipt,
} from "../src/lib/move.js";

const PROFILE = { id: "V1StGXR8_Z5j", displayName: "Zero", emoji: "🟢" };

/** A random that hands back exactly the bytes a test wants, so a pick is a fact and not a sample. */
function bytes(...values: number[]): (n: number) => Uint8Array {
  return (n) => Uint8Array.from({ length: n }, (_, i) => values[i % values.length]);
}

describe("the six-word transfer code", () => {
  it("is a list of 256 short, unique, lowercase words", () => {
    expect(MOVE_WORDS).toHaveLength(256);
    expect(new Set(MOVE_WORDS).size).toBe(256);
    for (const word of MOVE_WORDS) expect(word).toMatch(/^[a-z]{3,6}$/);
  });

  it("carries more than the 40 bits the transfer asks for", () => {
    expect(MOVE_CODE_WORDS).toBe(6);
    expect(codeEntropyBits()).toBe(48);
    expect(codeEntropyBits()).toBeGreaterThanOrEqual(40);
    // The floor is what matters, so it is stated against a hypothetical shorter list too.
    expect(codeEntropyBits(64, 6)).toBe(36);
  });

  it("is six words joined by dashes, matching the Mac app's regex", () => {
    for (let i = 0; i < 50; i++) {
      const code = newMoveCode();
      expect(code.split("-")).toHaveLength(6);
      expect(MOVE_CODE_RE.test(code)).toBe(true);
      expect(isMoveCode(code)).toBe(true);
    }
  });

  it("refuses the shapes the Mac would refuse", () => {
    expect(isMoveCode("able-acid-acorn-actor-after")).toBe(false);
    expect(isMoveCode("able-acid-acorn-actor-after-agent-album")).toBe(false);
    expect(isMoveCode("Able-acid-acorn-actor-after-agent")).toBe(false);
    expect(isMoveCode("able acid acorn actor after agent")).toBe(false);
    expect(isMoveCode("able-acid-acorn-actor-after-agent1")).toBe(false);
    expect(isMoveCode("")).toBe(false);
  });

  it("takes one whole byte per word, so every draw is used and none is biased", () => {
    // 256 words and a 256-value byte: the mask is the identity, so byte 0 is word 0 and 255 is 255.
    expect(newMoveCode(bytes(0))).toBe([MOVE_WORDS[0]].concat(Array(5).fill(MOVE_WORDS[0])).join("-"));
    expect(newMoveCode(bytes(255))).toBe(Array(6).fill(MOVE_WORDS[255]).join("-"));
    expect(newMoveCode(bytes(0, 1, 2, 3, 4, 5))).toBe(MOVE_WORDS.slice(0, 6).join("-"));
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newMoveCode()));
    expect(seen.size).toBe(200);
  });
});

describe("the move filename rule", () => {
  it("is the agent's slug and the UTC day", () => {
    expect(moveFilename("Zero", new Date("2026-09-10T14:07:00Z"))).toBe("zero-2026-09-10.00agent");
    expect(moveFilename("Ana Lúcia", new Date("2026-01-02T03:04:00Z"))).toBe("ana-lucia-2026-01-02.00agent");
  });

  it("uses UTC, so the browser and the Mac name the same day", () => {
    expect(moveFilename("Zero", new Date("2026-09-10T23:30:00Z"))).toBe("zero-2026-09-10.00agent");
  });

  it("survives a display name that is not a filename", () => {
    expect(moveFilename("!!!", new Date("2026-09-10T00:00:00Z"))).toBe("agent-2026-09-10.00agent");
    expect(moveFilename("emoji 🟢 agent", new Date("2026-09-10T00:00:00Z"))).toBe("emoji-agent-2026-09-10.00agent");
  });
});

describe("the deep link", () => {
  it("hands the Mac the file name and nothing else", () => {
    expect(importDeepLink("zero-2026-09-10.00agent")).toBe("zerozero://agent/import?name=zero-2026-09-10.00agent");
  });

  it("percent-encodes a name a share sheet may have mangled", () => {
    expect(importDeepLink("my agent (1).00agent")).toBe("zerozero://agent/import?name=my%20agent%20(1).00agent");
    expect(importDeepLink("a&b=c#d.00agent")).toBe("zerozero://agent/import?name=a%26b%3Dc%23d.00agent");
    expect(importDeepLink("ana lúcia.00agent")).toBe("zerozero://agent/import?name=ana%20l%C3%BAcia.00agent");
  });

  it("never carries the code, whatever the file is called", () => {
    // The whole point: a URL is written to history and to an OS prompt, and the bundle key is not.
    const code = newMoveCode();
    const href = importDeepLink(moveFilename("Zero", new Date("2026-09-10T00:00:00Z")));
    expect(href).not.toContain(code);
    expect(href).not.toContain("code");
    expect(href).not.toContain("secret");
    for (const word of code.split("-")) expect(href.includes(`=${word}`)).toBe(false);
  });
});

describe("the receipt", () => {
  const movedAt = new Date("2026-09-10T14:07:00Z");

  it("starts locked when the person says the Mac has it", () => {
    const receipt = moveReceiptReducer(null, {
      type: "moved",
      profile: PROFILE,
      fileName: "zero-2026-09-10.00agent",
      at: movedAt,
    });
    expect(receipt).toMatchObject({
      agentId: PROFILE.id,
      displayName: "Zero",
      emoji: "🟢",
      fileName: "zero-2026-09-10.00agent",
      releasedAt: null,
      releasedBy: null,
    });
    expect(isLocked(receipt)).toBe(true);
    expect(isSecondCopy(receipt)).toBe(false);
    expect(receiptLine(receipt!)).toBe("Moved to your Mac on 2026-09-10.");
  });

  it("carries nothing that could open the file", () => {
    const receipt = moveReceiptReducer(null, {
      type: "moved",
      profile: PROFILE,
      fileName: "zero-2026-09-10.00agent",
      at: movedAt,
    })!;
    expect(Object.keys(receipt).sort()).toEqual(
      ["agentId", "displayName", "emoji", "fileName", "movedAt", "releasedAt", "releasedBy"].sort(),
    );
  });

  it("unlocks when the agent is brought back", () => {
    const locked = moveReceiptReducer(null, {
      type: "moved",
      profile: PROFILE,
      fileName: "zero-2026-09-10.00agent",
      at: movedAt,
    });
    const back = moveReceiptReducer(locked, { type: "brought-back", at: new Date("2026-09-12T09:00:00Z") });
    expect(isLocked(back)).toBe(false);
    expect(isSecondCopy(back)).toBe(false);
    expect(back).toMatchObject({ releasedBy: "restore", releasedAt: "2026-09-12T09:00:00.000Z" });
    expect(receiptLine(back!)).toBe("Brought back on 2026-09-12.");
  });

  it("unlocks on an override, and says so from then on", () => {
    const locked = moveReceiptReducer(null, {
      type: "moved",
      profile: PROFILE,
      fileName: "zero-2026-09-10.00agent",
      at: movedAt,
    });
    const forced = moveReceiptReducer(locked, { type: "unlock-anyway", at: new Date("2026-09-11T08:00:00Z") });
    expect(isLocked(forced)).toBe(false);
    expect(isSecondCopy(forced)).toBe(true);
    expect(receiptLine(forced!)).toMatch(/Unlocked here on 2026-09-11 — your Mac may still be running a copy\./);
  });

  it("is dropped only when it is cleared", () => {
    const locked = moveReceiptReducer(null, {
      type: "moved",
      profile: PROFILE,
      fileName: "zero-2026-09-10.00agent",
      at: movedAt,
    });
    expect(moveReceiptReducer(locked, { type: "cleared" })).toBeNull();
    expect(isLocked(null)).toBe(false);
    expect(isSecondCopy(null)).toBe(false);
  });

  it("has nothing to release when there is no receipt", () => {
    expect(moveReceiptReducer(null, { type: "brought-back", at: movedAt })).toBeNull();
    expect(moveReceiptReducer(null, { type: "unlock-anyway", at: movedAt })).toBeNull();
  });

  it("says something rather than NaN when a stored date is unreadable", () => {
    const damaged: MoveReceipt = {
      agentId: "x",
      displayName: "Zero",
      emoji: "🟢",
      movedAt: "not a date",
      fileName: "zero.00agent",
      releasedAt: null,
      releasedBy: null,
    };
    expect(receiptLine(damaged)).toBe("Moved to your Mac on an unknown day.");
    expect(receiptLine({ ...damaged, releasedBy: "restore", releasedAt: null })).toBe(
      "Brought back on an unknown day.",
    );
  });
});

describe("the five steps", () => {
  it("are §7's sequence, in order", () => {
    expect(MOVE_STEPS).toEqual(["explain", "code", "download", "open", "confirm"]);
  });

  it("advance one at a time and stop at the end", () => {
    expect(nextMoveStep("explain")).toBe("code");
    expect(nextMoveStep("open")).toBe("confirm");
    expect(nextMoveStep("confirm")).toBe("confirm");
  });
});
