// The barrel IS the contract with @00/agent-runtime and apps/infinite: a name that stops being
// exported is a broken import in another package, found at their build rather than at ours.

import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("@00/agent-fs public surface", () => {
  it("exports the adapters, the scaffold, the bundle and git", () => {
    for (const name of [
      "assertRelativePath",
      "AgentFsError",
      "MemoryFs",
      "NodeDirFs",
      "OpfsFs",
      "walkFs",
      "DEFAULT_MAX_ENTRIES",
      "scaffoldAgent",
      "ensureWorkspaceTmp",
      "SCAFFOLD_DIRS",
      "SCAFFOLD_FILES",
      "BROWSER_CAPABILITIES",
      "exportBundle",
      "importBundle",
      "importBundleInto",
      "ignoreMatcherFor",
      "fullModeInclude",
      "MANIFEST_NAME",
      "PAYLOAD_AGENT_DIR",
      "bundleKey",
      "encryptBundle",
      "decryptBundle",
      "gzip",
      "gunzip",
      "tarPack",
      "readTar",
      "normalizeTarPath",
      "gitFs",
      "repoDir",
      "gitInit",
      "gitAdd",
      "gitCommit",
      "gitLog",
      "gitStatus",
      "gitDiffNames",
      "gitClone",
      "gitPush",
      "gitPull",
      "GitRemoteUnavailableError",
      // The live transfer of §7.1 — imported by the PWA and by the 00 web UI, so the barrel is its
      // contract too.
      "CHUNK_BYTES",
      "ChunkAssembler",
      "WireError",
      "encodeControl",
      "decodeControl",
      "encodeChunk",
      "decodeChunk",
      "readFrame",
      "sendChunks",
      "deriveTransferKeys",
      "sha256Hex",
      "equalStrings",
      "sendBundle",
      "receiveBundle",
      "TransferAborted",
    ]) {
      expect(api, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("scaffolds and exports through the barrel alone", async () => {
    const fs = new api.MemoryFs();
    await api.scaffoldAgent(fs, { id: "ia-barrel", displayName: "Ada" });
    const bundle = await api.exportBundle(fs, { secret: "code", host: "browser" });
    const landed = new api.MemoryFs();
    const { manifest } = await api.importBundleInto(landed, bundle, { secret: "code" });
    expect(manifest.agentId).toBe("ia-barrel");
    expect(await landed.readText("workspace/IDENTITY.md")).toContain("Ada");
  });
});
