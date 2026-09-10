/**
 * THE PUBLIC BUNDLE'S BOUNDARY AND ITS CEILING, and an inbox item becoming an escalation.
 *
 * Two things are worth pinning about the bundle and they are both about what it does NOT contain:
 * nothing from outside `workspace/public/`, and nothing at all when the result would be over 256 KB.
 * The second is the one that would be tempting to soften — trimming to fit publishes a persona
 * missing its last paragraph and tells nobody — so the refusal is checked by name and the file list
 * that comes back with it is checked too, because it is what a person needs in order to choose.
 *
 * And the escalation, because `escalations/<id>.json` is the ENGINE'S folder: an agent filed here
 * and then moved to a Mac must find its messages where the Mac looks for them.
 */
import { MemoryFs, scaffoldAgent } from "@00/agent-fs";
import { describe, expect, it } from "vitest";
import { buildPublicBundle, looksTextual, PUBLIC_BUNDLE_MAX_BYTES } from "../src/registry/public-bundle.js";
import { ESCALATIONS_DIR, escalationFor, escalationPath, fileEscalation, readEscalation, recordReply } from "../src/registry/escalations.js";
import type { InboxItem } from "../src/registry/client.js";

const REF = "ia_abcdef_abcdefghijkl";

async function agentFs(): Promise<MemoryFs> {
  const fs = new MemoryFs();
  await scaffoldAgent(fs, { id: "agent-01", displayName: "Ada" });
  return fs;
}

describe("what travels", () => {
  it("refuses an empty public folder by name rather than publishing nothing", async () => {
    const fs = await agentFs();
    const built = await buildPublicBundle(fs, { ref: REF });
    expect(built.ok).toBe(false);
    expect(!built.ok && built.code).toBe("empty");
  });

  it("carries workspace/public and NOTHING else", async () => {
    const fs = await agentFs();
    await fs.writeFile("workspace/public/PERSONA.md", "I answer questions about shipping.");
    await fs.mkdir("workspace/public/faq");
    await fs.writeFile("workspace/public/faq/returns.md", "Thirty days.");
    // Everything below is private and must never appear in a published bundle.
    await fs.writeFile("workspace/MEMORY.md", "the operator's bank is …");
    await fs.writeFile("workspace/files/invoice.md", "private");

    const built = await buildPublicBundle(fs, { ref: REF, now: new Date("2026-09-10T00:00:00.000Z") });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.bundle.files.map((f) => f.path)).toEqual(["PERSONA.md", "faq/returns.md"]);
    expect(built.bundle.ref).toBe(REF);
    expect(built.bundle.version).toBe(1);
    expect(built.bundle.publishedAt).toBe("2026-09-10T00:00:00.000Z");
    const text = new TextDecoder().decode(built.bytes);
    expect(text).not.toContain("bank");
    expect(text).not.toContain("invoice");
  });

  it("leaves out dotfiles at any depth and anything that is not text", async () => {
    const fs = await agentFs();
    await fs.writeFile("workspace/public/PERSONA.md", "hello");
    await fs.writeFile("workspace/public/.DS_Store", "junk");
    await fs.mkdir("workspace/public/.git");
    await fs.writeFile("workspace/public/.git/HEAD", "ref: refs/heads/main");
    await fs.writeFile("workspace/public/logo.png", "PNG");
    const built = await buildPublicBundle(fs, { ref: REF });
    expect(built.ok && built.bundle.files.map((f) => f.path)).toEqual(["PERSONA.md"]);
    expect(looksTextual("logo.png")).toBe(false);
    expect(looksTextual("FAQ.MD")).toBe(true);
  });

  it("refuses over the ceiling BY NAME and hands back every file with its size", async () => {
    const fs = await agentFs();
    await fs.writeFile("workspace/public/PERSONA.md", "a".repeat(200 * 1024));
    await fs.writeFile("workspace/public/faq.md", "b".repeat(100 * 1024));
    const built = await buildPublicBundle(fs, { ref: REF });
    expect(built.ok).toBe(false);
    if (built.ok || built.code !== "too_large") throw new Error("expected too_large");
    expect(built.maxBytes).toBe(PUBLIC_BUNDLE_MAX_BYTES);
    expect(built.bytes).toBeGreaterThan(PUBLIC_BUNDLE_MAX_BYTES);
    // The list survives the refusal: a person cannot choose what to remove from an error message.
    expect(built.files.map((f) => f.path)).toEqual(["PERSONA.md", "faq.md"]);
    expect(built.files[0].bytes).toBe(200 * 1024);
  });

  it("accepts a bundle exactly at the ceiling", async () => {
    const fs = await agentFs();
    const overhead = new TextEncoder().encode(
      JSON.stringify({ version: 1, ref: REF, publishedAt: "2026-09-10T00:00:00.000Z", files: [{ path: "PERSONA.md", text: "" }] }),
    ).length;
    await fs.writeFile("workspace/public/PERSONA.md", "a".repeat(PUBLIC_BUNDLE_MAX_BYTES - overhead));
    const built = await buildPublicBundle(fs, { ref: REF, now: new Date("2026-09-10T00:00:00.000Z") });
    expect(built.ok).toBe(true);
    expect(built.ok && built.bytes.length).toBe(PUBLIC_BUNDLE_MAX_BYTES);
  });
});

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  mid: "iam_aaaabbbbccccdddd",
  deviceId: "iad_1111222233334444",
  kind: "lead",
  text: "Do you ship to Portugal?",
  contact: "ana@example.com",
  createdAt: "2026-09-10T09:00:00.000Z",
  drainedAt: "2026-09-10T09:01:00.000Z",
  repliedAt: null,
  reply: null,
  ...over,
});

describe("an inbox item as an escalation", () => {
  it("keeps the worker's mid as the id, so a reply cannot address a second name", () => {
    const record = escalationFor("agent-01", item());
    expect(record.id).toBe("iam_aaaabbbbccccdddd");
    expect(record.agentId).toBe("agent-01");
    expect(record.channel).toBe("infinite");
    expect(record.threadId).toBe("iad_1111222233334444");
    expect(record.from).toBe("ana@example.com");
    expect(record.question).toBe("Do you ship to Portugal?");
    expect(record.status).toBe("pending");
    expect(record.kind).toBe("lead");
    expect(record.createdAt).toBe("2026-09-10T09:00:00.000Z");
    expect(record.answer).toBeUndefined();
  });

  it("falls back to the device id when the visitor gave no contact, and never invents one", () => {
    expect(escalationFor("agent-01", item({ contact: null })).from).toBe("iad_1111222233334444");
  });

  it("is already answered when the worker sent a reply back with it", () => {
    const record = escalationFor("agent-01", item({ reply: "We do.", repliedAt: "2026-09-10T10:00:00.000Z" }));
    expect(record.status).toBe("answered");
    expect(record.answer).toBe("We do.");
    expect(record.answeredAt).toBe("2026-09-10T10:00:00.000Z");
  });

  it("lands in escalations/<mid>.json — the engine's own folder, created if the scaffold had none", async () => {
    const fs = await agentFs();
    expect(await fs.stat(ESCALATIONS_DIR)).toBeNull();
    await fileEscalation(fs, "agent-01", item());
    expect(escalationPath("iam_aaaabbbbccccdddd")).toBe("escalations/iam_aaaabbbbccccdddd.json");
    const onDisk = JSON.parse(await fs.readText("escalations/iam_aaaabbbbccccdddd.json"));
    expect(onDisk.id).toBe("iam_aaaabbbbccccdddd");
    expect(onDisk.status).toBe("pending");
    expect(await readEscalation(fs, "iam_aaaabbbbccccdddd")).toEqual(onDisk);
  });

  it("records the answer the owner sent, so the folder and the screen agree after a reload", async () => {
    const fs = await agentFs();
    await fileEscalation(fs, "agent-01", item());
    await recordReply(fs, "iam_aaaabbbbccccdddd", "Yes, three days.", "2026-09-10T11:00:00.000Z");
    const after = await readEscalation(fs, "iam_aaaabbbbccccdddd");
    expect(after?.status).toBe("answered");
    expect(after?.answer).toBe("Yes, three days.");
    expect(after?.answeredAt).toBe("2026-09-10T11:00:00.000Z");
  });

  it("reads a missing or corrupt escalation as absent rather than throwing", async () => {
    const fs = await agentFs();
    expect(await readEscalation(fs, "iam_nope")).toBeNull();
    await fs.mkdir(ESCALATIONS_DIR);
    await fs.writeFile("escalations/iam_bad.json", "{ truncated");
    expect(await readEscalation(fs, "iam_bad")).toBeNull();
    // And a reply to something unreadable does not create a file out of nowhere.
    await recordReply(fs, "iam_nope", "x", "t");
    expect(await fs.stat("escalations/iam_nope.json")).toBeNull();
  });
});
