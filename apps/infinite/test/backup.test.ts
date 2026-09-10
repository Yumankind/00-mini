import { describe, expect, it } from "vitest";
import {
  agentIdFromFilename,
  backupFilename,
  isBundleFilename,
  passphraseMismatch,
  passphraseProblem,
  slugName,
} from "../src/lib/backup.js";

const AGENT = { id: "V1StGXR8_Z5j", displayName: "Zero" };

describe("the backup filename rule", () => {
  it("is name, id and a UTC stamp, in that order", () => {
    expect(backupFilename(AGENT, new Date("2026-09-10T14:07:00Z"))).toBe("zero-V1StGXR8_Z5j-20260910-1407.00agent");
  });

  it("uses UTC, so two devices in two timezones agree", () => {
    // 23:30 in Lisbon in September is 22:30 UTC — the same file either side.
    const at = new Date("2026-09-10T22:30:00Z");
    expect(backupFilename(AGENT, at)).toBe("zero-V1StGXR8_Z5j-20260910-2230.00agent");
  });

  it("zero-pads every field so the names sort lexicographically", () => {
    expect(backupFilename(AGENT, new Date("2026-01-02T03:04:00Z"))).toBe("zero-V1StGXR8_Z5j-20260102-0304.00agent");
  });

  it("slugs a display name a person chose", () => {
    expect(slugName("Zero")).toBe("zero");
    expect(slugName("Ana Lúcia")).toBe("ana-lucia");
    expect(slugName("  spaced   out  ")).toBe("spaced-out");
    expect(slugName("emoji 🟢 agent")).toBe("emoji-agent");
    expect(slugName("!!!")).toBe("agent");
    expect(slugName("")).toBe("agent");
  });

  it("caps the slug without leaving a trailing hyphen", () => {
    const long = slugName("a".repeat(40));
    expect(long).toHaveLength(32);
    const awkward = slugName(`${"a".repeat(31)} tail`);
    expect(awkward.endsWith("-")).toBe(false);
  });

  it("recognises its own files, and reads the id back out", () => {
    const name = backupFilename(AGENT, new Date("2026-09-10T14:07:00Z"));
    expect(isBundleFilename(name)).toBe(true);
    expect(isBundleFilename("holiday.jpg")).toBe(false);
    expect(agentIdFromFilename(name)).toBe(AGENT.id);
    expect(agentIdFromFilename("renamed-by-a-share-sheet.00agent")).toBeNull();
  });

  it("holds a floor under the passphrase and says why", () => {
    expect(passphraseProblem("")).toMatch(/required/);
    expect(passphraseProblem("short")).toBe("At least 8 characters.");
    expect(passphraseProblem("        ")).toMatch(/Spaces only/);
    expect(passphraseProblem("correct horse")).toBeNull();
  });

  it("catches a typo in the confirmation", () => {
    expect(passphraseMismatch("one two three", "one two three")).toBeNull();
    expect(passphraseMismatch("one two three", "one two four")).toMatch(/do not match/);
  });
});
