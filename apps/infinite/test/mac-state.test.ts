/**
 * The store's one rule that is not a rendering detail: A RELAY KEY REACHES THE VAULT OR IT IS NOT
 * STORED AT ALL (§4.5, and the same line `state/connections.ts` holds for BYOK keys).
 *
 * The rest of `src/mac/state.ts` is IndexedDB and a browser origin and is exercised by the app; what
 * is worth a test in node is the door, because "unlock your vault first" quietly becoming "stored it
 * in a variable" is the kind of regression that looks like a working feature.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  RELAY_TOKEN_SECRET,
  __resetMacStateForTests,
  loadRelayToken,
  macMounted,
  macProblem,
  macTokenSet,
  mountMac,
  saveRelayToken,
} from "../src/mac/state.js";

function fakeVault(unlocked: boolean, seed: Record<string, string> = {}) {
  const store = { ...seed };
  return {
    get unlocked() {
      return unlocked;
    },
    get: async (name: string) => store[name] ?? "",
    set: async (name: string, value: string) => {
      store[name] = value;
    },
    store,
  };
}

const deps = (vault: ReturnType<typeof fakeVault>) => ({
  agentId: "agent-01",
  displayName: "Zero",
  runtime: { run: async () => ({ text: "", sessionId: "s" }), listSessions: async () => [] },
  vault,
  origin: "https://app.example",
});

beforeEach(() => __resetMacStateForTests());

describe("mounting", () => {
  it("does nothing until it is handed the agent's loop and vault", () => {
    expect(macMounted()).toBe(false);
    mountMac(deps(fakeVault(true)));
    expect(macMounted()).toBe(true);
  });
});

describe("the relay key", () => {
  it("refuses to hold one while the vault is locked, and says which thing to do", async () => {
    mountMac(deps(fakeVault(false)));
    await saveRelayToken("ob_live_secret");
    expect(macTokenSet.value).toBe(false);
    expect(macProblem.value).toMatch(/Unlock your vault/);
  });

  it("seals one under a single agreed name when the vault is open", async () => {
    const vault = fakeVault(true);
    mountMac(deps(vault));
    await saveRelayToken("  ob_live_secret  ");
    expect(vault.store[RELAY_TOKEN_SECRET]).toBe("ob_live_secret");
    expect(macTokenSet.value).toBe(true);
  });

  it("reads a sealed one back, and treats a locked vault as ordinary rather than broken", async () => {
    mountMac(deps(fakeVault(true, { [RELAY_TOKEN_SECRET]: "ob_live_secret" })));
    expect(await loadRelayToken()).toBe(true);
    expect(macProblem.value).toBeNull();

    __resetMacStateForTests();
    mountMac(deps(fakeVault(false, { [RELAY_TOKEN_SECRET]: "ob_live_secret" })));
    expect(await loadRelayToken()).toBe(false);
    expect(macProblem.value).toBeNull();
  });
});
