import { describe, expect, it } from "vitest";
import {
  brainLabel,
  downloadPercent,
  isUsable,
  readinessPhrase,
  statusLine,
  statusTone,
} from "../src/lib/readiness.js";

describe("readiness → status line", () => {
  it("labels the four peers of §6.1", () => {
    expect(brainLabel("local")).toBe("Local AI");
    expect(brainLabel("sponsored")).toBe("Sponsored");
    expect(brainLabel("overblast")).toBe("Overblast");
    expect(brainLabel("byok:openai")).toBe("Your key · openai");
    expect(brainLabel("byok:")).toBe("Your key");
    // The card exists before a vendor is chosen; "byok" is jargon on a screen that carries none.
    expect(brainLabel("byok")).toBe("Your key");
    expect(brainLabel("something-else")).toBe("something-else");
  });

  it("says the three lines §4.1 asks for, verbatim", () => {
    expect(statusLine("local", { ready: true })).toBe("Local AI · ready");
    expect(statusLine("local", { ready: false, reason: "download", detail: "42%" })).toBe(
      "Local AI · downloading 42%",
    );
    expect(statusLine("local", { ready: false, reason: "unsupported" })).toBe("Local AI · unsupported here");
  });

  it("drops the percentage rather than inventing one", () => {
    expect(readinessPhrase({ ready: false, reason: "download" })).toBe("downloading");
    expect(readinessPhrase({ ready: false, reason: "download", detail: "fetching shards" })).toBe("downloading");
  });

  it("reads a percentage out of whatever a provider put in `detail`", () => {
    expect(downloadPercent("42%")).toBe(42);
    expect(downloadPercent("loading 42.5%")).toBe(43);
    expect(downloadPercent("  7 ")).toBe(7);
    expect(downloadPercent("0%")).toBe(0);
    expect(downloadPercent("100%")).toBe(100);
  });

  it("refuses a percentage it cannot believe", () => {
    expect(downloadPercent(undefined)).toBeNull();
    expect(downloadPercent("")).toBeNull();
    expect(downloadPercent("soon")).toBeNull();
    expect(downloadPercent("101%")).toBeNull();
    expect(downloadPercent("-5")).toBeNull();
  });

  it("prefers a provider's own words for a missing credential", () => {
    expect(readinessPhrase({ ready: false, reason: "credential" })).toBe("needs a sign-in");
    expect(readinessPhrase({ ready: false, reason: "credential", detail: "needs a device token" })).toBe(
      "needs a device token",
    );
    expect(readinessPhrase({ ready: false, reason: "credential", detail: "   " })).toBe("needs a sign-in");
  });

  it("says offline when that is the reason", () => {
    expect(statusLine("overblast", { ready: false, reason: "offline" })).toBe("Overblast · offline");
  });

  it("tones a card by what is missing", () => {
    expect(statusTone({ ready: true })).toBe("ok");
    expect(statusTone({ ready: false, reason: "download" })).toBe("busy");
    expect(statusTone({ ready: false, reason: "credential" })).toBe("warn");
    expect(statusTone({ ready: false, reason: "offline" })).toBe("warn");
    expect(statusTone({ ready: false, reason: "unsupported" })).toBe("off");
  });

  it("only calls a provider usable when it says it is ready", () => {
    expect(isUsable({ ready: true })).toBe(true);
    expect(isUsable({ ready: false, reason: "download", detail: "99%" })).toBe(false);
  });
});
