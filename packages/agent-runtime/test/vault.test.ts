import { describe, expect, it } from "vitest";
import {
  ARGON2ID_ITERATIONS,
  ARGON2ID_MEMORY_KIB,
  VAULT_IDLE_LOCK_MS,
  VAULT_PATH,
  VaultError,
  createVault,
  type Vault,
} from "../src/index.js";
import { MemoryFs } from "./memory-fs.js";

/** A clock the test moves by hand — the alternative is a test that waits thirty minutes. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function passwordVault(pw = "correct horse battery staple"): Promise<{ fs: MemoryFs; vault: Vault }> {
  const fs = new MemoryFs();
  const vault = createVault(fs);
  await vault.createWithPassword(pw);
  return { fs, vault };
}

describe("vault", () => {
  it("seals values under a password and gives them back once unlocked", async () => {
    const { fs, vault } = await passwordVault();
    await vault.set("OPENAI_API_KEY", "sk-real-value");
    vault.lock();
    expect(vault.unlocked).toBe(false);

    await vault.unlockWithPassword("correct horse battery staple");
    expect(await vault.get("OPENAI_API_KEY")).toBe("sk-real-value");

    // The file itself must not contain the value anywhere, in any encoding of it.
    const raw = fs.readSync(VAULT_PATH)!;
    expect(raw).not.toContain("sk-real-value");
    expect(raw).toContain("OPENAI_API_KEY"); // names ARE visible, by design
  });

  it("writes the stated Argon2id parameters into the file so a later raise cannot lock anyone out", async () => {
    const { fs } = await passwordVault();
    const file = JSON.parse(fs.readSync(VAULT_PATH)!);
    expect(file.kdf).toMatchObject({
      kind: "argon2id",
      memoryKiB: ARGON2ID_MEMORY_KIB,
      iterations: ARGON2ID_ITERATIONS,
      parallelism: 1,
    });
    expect(typeof file.kdf.salt).toBe("string");
    expect(file.kdf.salt.length).toBeGreaterThan(10);
  });

  it("refuses the wrong password by name and stays locked", async () => {
    const { vault } = await passwordVault("right");
    await vault.set("A", "1");
    vault.lock();
    await expect(vault.unlockWithPassword("wrong")).rejects.toMatchObject({ code: "vault_bad_password" });
    expect(vault.unlocked).toBe(false);
    await expect(vault.get("A")).rejects.toMatchObject({ code: "vault_locked" });
  });

  it("list() gives names and never values, locked or unlocked", async () => {
    const { vault } = await passwordVault();
    await vault.set("STRIPE_KEY", "sk_live_secret");
    await vault.set("GITHUB_TOKEN", "ghp_secret");
    expect(await vault.list()).toEqual(["GITHUB_TOKEN", "STRIPE_KEY"]);
    vault.lock();
    expect(await vault.list()).toEqual(["GITHUB_TOKEN", "STRIPE_KEY"]);
    const names = await vault.list();
    expect(names.join(" ")).not.toContain("secret");
  });

  it("locks itself after the idle window, on access as well as on the timer", async () => {
    const clock = fakeClock();
    const fs = new MemoryFs();
    const vault = createVault(fs, { now: clock.now });
    await vault.createWithPassword("pw");
    await vault.set("A", "1");
    expect(await vault.get("A")).toBe("1");

    clock.advance(VAULT_IDLE_LOCK_MS - 1);
    expect(await vault.get("A")).toBe("1"); // still inside the window, and this touches it

    clock.advance(VAULT_IDLE_LOCK_MS);
    expect(vault.unlocked).toBe(false);
    await expect(vault.get("A")).rejects.toMatchObject({ code: "vault_locked" });
  });

  it("uses an injected scheduler when one is given, and clears its timer on lock", async () => {
    const clock = fakeClock();
    let scheduled: (() => void) | null = null;
    let cleared = 0;
    const vault = createVault(new MemoryFs(), {
      now: clock.now,
      scheduler: {
        setTimeout: (fn) => {
          scheduled = fn;
          return 1;
        },
        clearTimeout: () => {
          cleared++;
        },
      },
    });
    await vault.createWithPassword("pw");
    expect(scheduled).not.toBeNull();
    clock.advance(VAULT_IDLE_LOCK_MS);
    scheduled!();
    expect(vault.unlocked).toBe(false);
    expect(cleared).toBeGreaterThan(0);
  });

  it("unlocks from a passkey PRF secret, and refuses one that is not the right 32 bytes", async () => {
    const fs = new MemoryFs();
    const prf = new Uint8Array(32).fill(7);
    const vault = createVault(fs);
    await vault.createWithPrf(prf);
    await vault.set("SSH_KEY", "-----BEGIN-----");
    vault.lock();

    await vault.unlockWithPrf(prf);
    expect(await vault.get("SSH_KEY")).toBe("-----BEGIN-----");

    vault.lock();
    await expect(vault.unlockWithPrf(new Uint8Array(32).fill(8))).rejects.toMatchObject({ code: "vault_bad_key" });
  });

  it("refuses to export a device-bound (PRF) vault, by name", async () => {
    const vault = createVault(new MemoryFs());
    await vault.createWithPrf(new Uint8Array(32).fill(3));
    await expect(vault.exportWrapped()).rejects.toMatchObject({ code: "vault_device_bound" });
    await expect(vault.exportWrapped()).rejects.toBeInstanceOf(VaultError);
  });

  it("exports a password-wrapped vault as the sealed bytes, with no plaintext in them", async () => {
    const { vault } = await passwordVault();
    await vault.set("TOKEN", "plaintext-should-not-appear");
    const bytes = await vault.exportWrapped();
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("plaintext-should-not-appear");
    expect(JSON.parse(text).kdf.kind).toBe("argon2id");
  });

  it("cross-refuses the wrong unlock kind, and says which kind it is", async () => {
    const vault = createVault(new MemoryFs());
    await vault.createWithPrf(new Uint8Array(32).fill(1));
    expect(await vault.kind()).toBe("prf");
    await expect(vault.unlockWithPassword("pw")).rejects.toMatchObject({ code: "vault_device_bound" });

    const other = createVault(new MemoryFs());
    await other.createWithPassword("pw");
    expect(await other.kind()).toBe("password");
    await expect(other.unlockWithPrf(new Uint8Array(32))).rejects.toMatchObject({ code: "vault_bad_key" });
  });

  it("answers honestly before there is a vault, and refuses a second one", async () => {
    const fs = new MemoryFs();
    const vault = createVault(fs);
    expect(await vault.exists()).toBe(false);
    expect(await vault.kind()).toBeNull();
    expect(await vault.list()).toEqual([]);
    await expect(vault.unlockWithPassword("pw")).rejects.toMatchObject({ code: "vault_missing" });

    await vault.createWithPassword("pw");
    expect(await vault.exists()).toBe(true);
    await expect(vault.createWithPassword("pw2")).rejects.toMatchObject({ code: "vault_exists" });
  });

  it("removes a secret and refuses an unknown name", async () => {
    const { vault } = await passwordVault();
    await vault.set("A", "1");
    await expect(vault.get("nope")).rejects.toMatchObject({ code: "vault_unknown_name" });
    await vault.remove("A");
    expect(await vault.list()).toEqual([]);
  });
});
