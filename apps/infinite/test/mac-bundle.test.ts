import { describe, expect, it } from "vitest";
import {
  MANIFEST_NAME,
  MemoryFs,
  PAYLOAD_AGENT_DIR,
  encryptBundle,
  exportBundle,
  gzip,
  importBundleInto,
  scaffoldAgent,
  tarPack,
  type TarEntry,
} from "@00/agent-fs";
import { newMoveCode } from "../src/lib/move.js";

/**
 * Restore has to open what the MAC wrote — docs/HANDOFF-infinite-agent.md §3.2 and §7.
 *
 * The PWA's Restore is `importBundleInto`, and the engine's export is the same container with
 * `host: "mac"`. This suite is the browser side of the round trip the Status section says Phase 0
 * still lacks: it cannot run the engine, so it builds exactly what the engine builds — a version 1,
 * full-mode manifest that says `mac`, plus the payload-root entries (`secrets.json`, `cli.json`) an
 * engine export carries and a browser has no vault door for. Those must be REPORTED and skipped, not
 * fatal: a person moving an agent back from their Mac must not be told their file is broken because
 * it had a secrets file in it.
 */

const SECRET = "correct horse battery staple";

async function macBundle(entries: TarEntry[], manifest: Record<string, unknown>): Promise<Uint8Array> {
  const all: TarEntry[] = [
    {
      path: MANIFEST_NAME,
      kind: "file",
      data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      mtime: 0,
    },
    ...entries,
  ];
  return encryptBundle(await gzip(tarPack(all)), SECRET);
}

function file(path: string, text: string): TarEntry {
  return { path, kind: "file", data: new TextEncoder().encode(text), mtime: 0 };
}

describe("a bundle the Mac wrote", () => {
  it("imports with host \"mac\" and version 1", async () => {
    const bytes = await macBundle(
      [
        { path: PAYLOAD_AGENT_DIR, kind: "dir", data: new Uint8Array(0), mtime: 0 },
        file(`${PAYLOAD_AGENT_DIR}/profile.json`, JSON.stringify({ id: "MacAgent1234", displayName: "Zero" })),
        { path: `${PAYLOAD_AGENT_DIR}/workspace`, kind: "dir", data: new Uint8Array(0), mtime: 0 },
        file(`${PAYLOAD_AGENT_DIR}/workspace/AGENTS.md`, "# Zero\n"),
      ],
      { version: 1, agentId: "MacAgent1234", mode: "full", createdAt: "2026-09-10T14:07:00.000Z", host: "mac" },
    );

    const fs = new MemoryFs();
    const result = await importBundleInto(fs, bytes, { secret: SECRET });

    expect(result.manifest.host).toBe("mac");
    expect(result.manifest.version).toBe(1);
    expect(result.manifest.mode).toBe("full");
    expect(result.written).toContain("profile.json");
    expect(result.written).toContain("workspace/AGENTS.md");
    expect(result.dirs).toContain("workspace");
    expect(await fs.readText("workspace/AGENTS.md")).toBe("# Zero\n");
  });

  it("reports the engine's payload-root entries instead of failing on them", async () => {
    const bytes = await macBundle(
      [
        file(`${PAYLOAD_AGENT_DIR}/profile.json`, JSON.stringify({ id: "MacAgent1234" })),
        file("secrets.json", '{"sealed":"…"}'),
        file("cli.json", "{}"),
      ],
      { version: 1, agentId: "MacAgent1234", mode: "full", createdAt: "2026-09-10T14:07:00.000Z", host: "mac" },
    );

    const fs = new MemoryFs();
    const result = await importBundleInto(fs, bytes, { secret: SECRET });

    expect(result.written).toEqual(["profile.json"]);
    expect(result.skipped).toEqual(["secrets.json", "cli.json"]);
    // Reported, not thrown, and not silently written into the agent tree either.
    expect(await fs.stat("secrets.json")).toBeNull();
  });

  it("refuses the wrong secret loudly rather than importing half an agent", async () => {
    const bytes = await macBundle(
      [file(`${PAYLOAD_AGENT_DIR}/profile.json`, "{}")],
      { version: 1, agentId: "MacAgent1234", mode: "full", createdAt: "2026-09-10T14:07:00.000Z", host: "mac" },
    );
    const fs = new MemoryFs();
    await expect(importBundleInto(fs, bytes, { secret: "not the secret" })).rejects.toThrow(/decrypt/i);
    expect(await fs.stat("profile.json")).toBeNull();
  });
});

describe("a move code as the bundle key", () => {
  it("round-trips a whole browser agent, which is what the Mac will be typing it for", async () => {
    const source = new MemoryFs();
    await scaffoldAgent(source, { id: "V1StGXR8_Z5j", displayName: "Zero", emoji: "🟢" });
    const code = newMoveCode();

    const bytes = await exportBundle(source, { secret: code, host: "browser" });
    const target = new MemoryFs();
    const result = await importBundleInto(target, bytes, { secret: code });

    expect(result.manifest.host).toBe("browser");
    expect(result.manifest.agentId).toBe("V1StGXR8_Z5j");
    expect(result.written).toContain("profile.json");
    expect(JSON.parse(await target.readText("profile.json"))).toMatchObject({ id: "V1StGXR8_Z5j" });
  });

  it("is the only key — one wrong word and the file is noise", async () => {
    const source = new MemoryFs();
    await scaffoldAgent(source, { id: "V1StGXR8_Z5j", displayName: "Zero", emoji: "🟢" });
    const code = newMoveCode();
    const wrong = ["able", ...code.split("-").slice(1)].join("-");
    const bytes = await exportBundle(source, { secret: code, host: "browser" });
    if (wrong !== code) {
      await expect(importBundleInto(new MemoryFs(), bytes, { secret: wrong })).rejects.toThrow();
    }
  });
});
