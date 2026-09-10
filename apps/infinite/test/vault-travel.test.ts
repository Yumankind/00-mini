// THE VAULT DOES NOT TRAVEL UNLESS SOMEBODY SAID SO — gap audit A2, docs/HANDOFF-infinite-agent.md §4.5.
//
// `vault.json` classifies `record`, so the default full-mode export puts it in every `.00agent` — a
// file a person downloads to a shared laptop, mails to themselves, or hands to a stranger at a Mac.
// The classification is the engine's and is left alone; the EXPORT is what changed. Three layers are
// pinned here: the predicate (pure), the bundle it produces (a real round trip through
// @00/agent-fs, which is the only thing that can prove bytes did not travel), and the two stores that
// pass the tick down.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import {
  MemoryFs,
  exportBundle,
  fullModeInclude,
  ignoreMatcherFor,
  importBundleInto,
  scaffoldAgent,
} from "@00/agent-fs";
import { VAULT_PATH } from "@00/agent-runtime";
import {
  VAULT_FILE,
  arrivedLine,
  canCarrySecrets,
  carriedLine,
  carryOffer,
  exportDefaultLine,
  includeForExport,
} from "../src/lib/vault-policy.js";

const SECRET = "acorn-basil-cedar-dawn-ember-falcon";

/** A scaffolded agent with a sealed vault beside it — the shape every export in this app starts from. */
async function agentWithVault(): Promise<MemoryFs> {
  const fs = new MemoryFs();
  await scaffoldAgent(fs, { id: "ag_travel1", displayName: "Zero", emoji: "🟢" });
  await fs.writeFile(VAULT_FILE, JSON.stringify({ v: 1, salt: "…", entries: { "byok.anthropic": "sealed" } }));
  return fs;
}

async function exportWith(fs: MemoryFs, carrySecrets: boolean | null): Promise<string[]> {
  const base = fullModeInclude(await ignoreMatcherFor(fs));
  const bytes = await exportBundle(fs, {
    secret: SECRET,
    host: "browser",
    // `null` = what the app did before this fix: no predicate at all, the package's default.
    ...(carrySecrets === null ? {} : { include: includeForExport(base, carrySecrets) }),
  });
  const landing = new MemoryFs();
  const result = await importBundleInto(landing, bytes, { secret: SECRET });
  return result.written;
}

describe("the vault's file name", () => {
  it("is the one @00/agent-runtime actually writes", () => {
    // The twin-guard the module header promises: a rename in the package that this app did not follow
    // would put the vault back into every bundle, silently, and every other test here would pass.
    expect(VAULT_FILE).toBe(VAULT_PATH);
  });
});

describe("the export predicate", () => {
  it("drops the vault by default and keeps everything else", () => {
    const include = includeForExport(() => true, false);
    expect(include(VAULT_FILE)).toBe(false);
    expect(include("workspace/AGENTS.md")).toBe(true);
    expect(include("sessions/2026-09-10.jsonl")).toBe(true);
  });

  it("keeps the vault when the tick is on", () => {
    expect(includeForExport(() => true, true)(VAULT_FILE)).toBe(true);
  });

  it("never widens what the base rule refused", () => {
    // It is a filter on top of the travel classes, not a replacement for them: an ephemeral path the
    // base said no to stays out whichever way the tick is set.
    for (const carry of [true, false]) {
      expect(includeForExport(() => false, carry)("workspace/tmp/scratch")).toBe(false);
    }
  });
});

describe("a real .00agent", () => {
  it("does not contain vault.json unless it was asked for", async () => {
    const written = await exportWith(await agentWithVault(), false);
    expect(written).not.toContain(VAULT_FILE);
    // The rest of the agent is untouched — this is a one-file exception, not a narrowed export.
    expect(written).toContain("profile.json");
    expect(written).toContain("workspace/AGENTS.md");
  });

  it("contains it when the person ticked carry my secrets", async () => {
    const written = await exportWith(await agentWithVault(), true);
    expect(written).toContain(VAULT_FILE);
  });

  it("is the regression: the package's own default carries it", async () => {
    // Pinned deliberately. If @00/agent-fs ever changes its mind, this test fails and somebody reads
    // §4.5 again rather than discovering the change through a vault that stopped arriving.
    expect(await exportWith(await agentWithVault(), null)).toContain(VAULT_FILE);
  });
});

describe("what the person is told", () => {
  it("offers the tick only for a password vault that has something in it", () => {
    expect(carryOffer("password", 2)).toMatchObject({ offered: true, reason: null });
    expect(carryOffer("password", 0).offered).toBe(false);
    expect(carryOffer(null, 0).offered).toBe(false);
  });

  it("gives a passkey vault the reason instead of a control", () => {
    const offer = carryOffer("passkey", 3);
    expect(offer.offered).toBe(false);
    expect(offer.reason).toMatch(/cannot travel/i);
    expect(canCarrySecrets("passkey")).toBe(false);
  });

  it("says what travelled, and what arrived", () => {
    expect(carriedLine(true)).not.toBe(carriedLine(false));
    expect(arrivedLine(true)).toMatch(/sealed vault/i);
    expect(arrivedLine(false)).toMatch(/entered again/i);
    expect(exportDefaultLine()).toMatch(/carry my secrets/i);
  });
});

// ── The two stores, which are the only callers that can get this wrong ────────────────────────────

const calls: { secret: string; choices: unknown }[] = [];
const fakeAgent = {
  profile: { id: "ag_travel1", displayName: "Zero", emoji: "🟢" },
  exportBundleFile: vi.fn(async (secret: string, choices?: unknown) => {
    calls.push({ secret, choices });
    return new Blob([new Uint8Array([1, 2, 3]).buffer]);
  }),
  importBundleFile: vi.fn(async () => ({ agentId: "ag_arrived", vaultTravelled: true })),
};

vi.mock("../src/state/agent.js", () => ({
  agent: shallowRef(fakeAgent),
  forgetAgent: () => undefined,
}));

const { exportBackup, importBackup, backupNote } = await import("../src/state/backup.js");
const { downloadMove, resetMove, setCarrySecrets, toCodeStep } = await import("../src/state/move.js");

describe("the stores pass the tick down", () => {
  beforeEach(() => {
    calls.length = 0;
    resetMove();
    // The download path needs a document; a move is a click and a Blob URL, neither of which node has.
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    vi.stubGlobal("document", { createElement: () => ({ click: () => undefined, href: "", download: "" }) });
  });

  it("backs up without the vault unless asked", async () => {
    await exportBackup("passphrase-please");
    expect(calls[0].choices).toEqual({ carrySecrets: false });
    await exportBackup("passphrase-please", true);
    expect(calls[1].choices).toEqual({ carrySecrets: true });
  });

  it("moves without the vault unless the tick was set, and forgets the tick on reset", async () => {
    toCodeStep();
    setCarrySecrets(true);
    await downloadMove();
    expect(calls[0].choices).toEqual({ carrySecrets: true });

    resetMove();
    toCodeStep();
    await downloadMove();
    expect(calls[1].choices).toEqual({ carrySecrets: false });
  });

  it("refuses the tick when the vault cannot travel at all", async () => {
    toCodeStep();
    setCarrySecrets(true, false); // a passkey vault: the screen may not tick it on
    await downloadMove();
    expect(calls[0].choices).toEqual({ carrySecrets: false });
  });

  it("reports what a restored bundle brought", async () => {
    await importBackup(new File([], "x.00agent"), "passphrase-please");
    expect(backupNote.value).toContain("sealed vault");
  });
});
