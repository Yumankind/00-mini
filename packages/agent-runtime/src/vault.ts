/**
 * The owner's vault (docs/HANDOFF-infinite-agent.md §4.5) — secrets sealed under a key THE PERSON
 * holds, never under one the browser holds for them.
 *
 * The whole design follows from that sentence. There is no "remember me": a wrapping key derived
 * from a password the person types, or from a passkey's PRF secret their authenticator returns, is
 * the only thing that opens the file, and neither is stored. `vault.json` on a stolen laptop is
 * noise. What IS stored is the salt, the KDF parameters and the sealed bytes — everything needed to
 * try again, nothing that shortens the try.
 *
 * Names are visible, values are sealed (the engine's rule, `secret-store.ts`): the agent sees a list
 * of names in its prompt, and a tool resolves a value at the moment it uses it. So `list()` works
 * whether or not the vault is unlocked, and `get()` does not.
 *
 * TWO UNLOCK KINDS, AND ONE ASYMMETRY THAT IS A FEATURE:
 *   password → Argon2id → wrapping key. Travels: a password-wrapped vault can ride inside a
 *              `.00agent` if the person ticks *carry my secrets*.
 *   passkey  → the authenticator's per-credential PRF secret → HKDF-SHA256 → wrapping key. The
 *              WebAuthn ceremony belongs to the app (this package has no DOM); it hands the runtime
 *              the 32 bytes it got back. DEVICE-BOUND BY CONSTRUCTION: the PRF secret never leaves
 *              that authenticator, so `exportWrapped()` refuses by name (`vault_device_bound`) and
 *              the flow's answer is to re-wrap under a password, or re-enter the secrets on the far
 *              side. A vault that could be exported off the device it is bound to was never bound.
 *
 * Unlocked material lives in this module's memory only, and is dropped on `lock()`, on idle
 * (30 minutes, the clock injectable so a test does not wait half an hour), and with the Worker.
 */
import { argon2id } from "hash-wasm";

export const VAULT_PATH = "vault.json";

/**
 * ARGON2ID PARAMETERS, and why each number.
 *
 * OWASP's 2024 password-storage guidance for Argon2id is m=46–64 MiB, t=2–3, p=1; this takes the top
 * of that range because the thing being protected is every key the person owns, and the unlock
 * happens once per visit rather than once per request.
 *
 * `parallelism: 1` is not a compromise for the browser — it is what hash-wasm gives: the wasm build
 * is single-threaded, so a higher p costs the defender time without costing an attacker with real
 * cores anything. `memorySize` is the parameter that actually hurts a GPU attack, so that is the one
 * pushed. 64 MiB also allocates on a mid-range phone, which a 256 MiB setting does not.
 *
 * They are STORED IN THE FILE alongside the salt: raising them later must not lock out a vault
 * written under the old ones, so the file's numbers win over these on unlock, and these are what a
 * NEW vault is written with.
 */
export const ARGON2ID_MEMORY_KIB = 65536; // 64 MiB
export const ARGON2ID_ITERATIONS = 3;
export const ARGON2ID_PARALLELISM = 1;
export const KEY_BYTES = 32; // AES-256
const SALT_BYTES = 16;
const IV_BYTES = 12; // AES-GCM's nominal nonce size

/** §4.5: "wiped … after 30 minutes idle". */
export const VAULT_IDLE_LOCK_MS = 30 * 60 * 1000;

/** What a caller can catch by name rather than by message. */
export type VaultErrorCode =
  | "vault_locked"
  | "vault_bad_password"
  | "vault_bad_key"
  | "vault_device_bound"
  | "vault_exists"
  | "vault_missing"
  | "vault_unknown_name";

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
  }
}

interface Sealed {
  iv: string;
  ct: string;
}

interface PasswordKdf {
  kind: "argon2id";
  salt: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}
interface PrfKdf {
  kind: "hkdf-sha256";
  salt: string;
  info: string;
}

export interface VaultFile {
  version: 1;
  /** How the WRAPPING key is derived — and therefore whether this vault can travel. */
  kdf: PasswordKdf | PrfKdf;
  /** The vault key, sealed under the wrapping key. Wrong password ⇒ this fails to open. */
  wrapped: Sealed;
  /** name → value, each sealed under the vault key. Names are plaintext, by design. */
  items: Record<string, Sealed>;
}

/** The minimum of `AgentFs` the vault needs — so a caller can hand it anything that stores bytes. */
export interface VaultStore {
  readText(path: string): Promise<string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  stat(path: string): Promise<{ kind: "file" | "dir" } | null>;
}

export interface VaultOptions {
  path?: string;
  now?: () => number;
  idleMs?: number;
  /** For a test, or for a host with its own timer wheel. */
  scheduler?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

const HKDF_INFO = "00-infinite-agent/vault/v1";

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(key: CryptoKey, plaintext: Uint8Array): Promise<Sealed> {
  const iv = randomBytes(IV_BYTES);
  const ct = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource);
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function open(key: CryptoKey, sealed: Sealed): Promise<Uint8Array> {
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(sealed.iv) as BufferSource },
    key,
    unb64(sealed.ct) as BufferSource,
  );
  return new Uint8Array(plain);
}

async function derivePassword(password: string, kdf: PasswordKdf): Promise<Uint8Array> {
  return argon2id({
    password,
    salt: unb64(kdf.salt),
    memorySize: kdf.memoryKiB,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
    hashLength: KEY_BYTES,
    outputType: "binary",
  });
}

/**
 * HKDF-SHA256 over the authenticator's PRF secret.
 *
 * No Argon2 here on purpose: the PRF secret is already 32 bytes of authenticator-held entropy, so
 * stretching it buys nothing and would cost the person a visible pause behind their fingerprint.
 */
async function derivePrf(secret: Uint8Array, kdf: PrfKdf): Promise<Uint8Array> {
  const base = await globalThis.crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: unb64(kdf.salt) as BufferSource, info: enc.encode(kdf.info) as BufferSource },
    base,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export interface Vault {
  exists(): Promise<boolean>;
  /** True while the vault key is in memory. */
  readonly unlocked: boolean;
  /** How this vault is wrapped, without unlocking it — the UI needs it to ask the right question. */
  kind(): Promise<"password" | "prf" | null>;
  createWithPassword(password: string): Promise<void>;
  createWithPrf(prfSecret: Uint8Array): Promise<void>;
  unlockWithPassword(password: string): Promise<void>;
  unlockWithPrf(prfSecret: Uint8Array): Promise<void>;
  lock(): void;
  /** Names only. Works locked — that is the rule, not a leak. */
  list(): Promise<string[]>;
  get(name: string): Promise<string>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** The password-wrapped file's bytes, for *carry my secrets*. Refuses on a PRF vault. */
  exportWrapped(): Promise<Uint8Array>;
  /** Lock now if the idle window has passed. Called on every access; exposed for a host's own timer. */
  sweep(): void;
}

export function createVault(store: VaultStore, opts: VaultOptions = {}): Vault {
  const path = opts.path ?? VAULT_PATH;
  const now = opts.now ?? (() => Date.now());
  const idleMs = opts.idleMs ?? VAULT_IDLE_LOCK_MS;
  const scheduler = opts.scheduler;

  let vaultKey: CryptoKey | null = null;
  let lastUsed = 0;
  let timer: unknown;

  function touch(): void {
    lastUsed = now();
    if (!scheduler) return;
    if (timer !== undefined) scheduler.clearTimeout(timer);
    timer = scheduler.setTimeout(() => sweep(), idleMs);
  }

  /**
   * The idle lock is checked on ACCESS as well as on a timer. A timer alone is a lie in a browser:
   * a background tab's timers are throttled or stopped, so a laptop asleep for an hour would come
   * back with the vault still open. Checking the clock at the moment of use cannot be throttled.
   */
  function sweep(): void {
    if (vaultKey && now() - lastUsed >= idleMs) lock();
  }

  function lock(): void {
    vaultKey = null;
    lastUsed = 0;
    if (scheduler && timer !== undefined) {
      scheduler.clearTimeout(timer);
      timer = undefined;
    }
  }

  async function read(): Promise<VaultFile | null> {
    try {
      const parsed = JSON.parse(await store.readText(path)) as VaultFile;
      return parsed?.version === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  async function write(file: VaultFile): Promise<void> {
    await store.writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
  }

  async function mustRead(): Promise<VaultFile> {
    const file = await read();
    if (!file) throw new VaultError("vault_missing", "there is no vault yet on this device");
    return file;
  }

  function requireUnlocked(): CryptoKey {
    sweep();
    if (!vaultKey) throw new VaultError("vault_locked", "the vault is locked — unlock it first");
    touch();
    return vaultKey;
  }

  async function create(kdf: PasswordKdf | PrfKdf, wrappingRaw: Uint8Array): Promise<void> {
    if (await read()) throw new VaultError("vault_exists", "this device already has a vault");
    const wrappingKey = await importAesKey(wrappingRaw);
    const raw = randomBytes(KEY_BYTES);
    const file: VaultFile = { version: 1, kdf, wrapped: await seal(wrappingKey, raw), items: {} };
    await write(file);
    vaultKey = await importAesKey(raw);
    touch();
  }

  async function unwrap(file: VaultFile, wrappingRaw: Uint8Array, code: VaultErrorCode): Promise<void> {
    const wrappingKey = await importAesKey(wrappingRaw);
    let raw: Uint8Array;
    try {
      raw = await open(wrappingKey, file.wrapped);
    } catch {
      // AES-GCM's tag check IS the password check: there is no separate verifier to leak from, and a
      // wrong password is indistinguishable from a corrupt file, which is the correct amount to say.
      throw new VaultError(code, code === "vault_bad_password" ? "wrong password" : "that key does not open this vault");
    }
    vaultKey = await importAesKey(raw);
    touch();
  }

  return {
    get unlocked() {
      sweep();
      return vaultKey !== null;
    },

    async exists() {
      return (await read()) !== null;
    },

    async kind() {
      const file = await read();
      if (!file) return null;
      return file.kdf.kind === "argon2id" ? "password" : "prf";
    },

    async createWithPassword(password) {
      const kdf: PasswordKdf = {
        kind: "argon2id",
        salt: b64(randomBytes(SALT_BYTES)),
        memoryKiB: ARGON2ID_MEMORY_KIB,
        iterations: ARGON2ID_ITERATIONS,
        parallelism: ARGON2ID_PARALLELISM,
      };
      await create(kdf, await derivePassword(password, kdf));
    },

    async createWithPrf(prfSecret) {
      const kdf: PrfKdf = { kind: "hkdf-sha256", salt: b64(randomBytes(SALT_BYTES)), info: HKDF_INFO };
      await create(kdf, await derivePrf(prfSecret, kdf));
    },

    async unlockWithPassword(password) {
      const file = await mustRead();
      if (file.kdf.kind !== "argon2id") {
        throw new VaultError("vault_device_bound", "this vault is bound to a passkey, not a password");
      }
      await unwrap(file, await derivePassword(password, file.kdf), "vault_bad_password");
    },

    async unlockWithPrf(prfSecret) {
      const file = await mustRead();
      if (file.kdf.kind !== "hkdf-sha256") {
        throw new VaultError("vault_bad_key", "this vault is wrapped under a password, not a passkey");
      }
      await unwrap(file, await derivePrf(prfSecret, file.kdf), "vault_bad_key");
    },

    lock,
    sweep,

    async list() {
      const file = await read();
      return file ? Object.keys(file.items).sort() : [];
    },

    async get(name) {
      const key = requireUnlocked();
      const file = await mustRead();
      const sealed = file.items[name];
      if (!sealed) throw new VaultError("vault_unknown_name", `no secret named "${name}"`);
      return dec.decode(await open(key, sealed));
    },

    async set(name, value) {
      const key = requireUnlocked();
      const file = await mustRead();
      file.items[name] = await seal(key, enc.encode(value));
      await write(file);
    },

    async remove(name) {
      requireUnlocked();
      const file = await mustRead();
      delete file.items[name];
      await write(file);
    },

    async exportWrapped() {
      const file = await mustRead();
      if (file.kdf.kind !== "argon2id") {
        throw new VaultError(
          "vault_device_bound",
          "this vault is wrapped by a passkey, whose secret never leaves that authenticator — re-wrap it under a password to carry it, or re-enter the secrets on the other device",
        );
      }
      // The bytes as they sit on disk: still sealed. Nothing is decrypted to export, so *carry my
      // secrets* never puts a plaintext key in a bundle even for the instant it is being written.
      return enc.encode(await store.readText(path));
    },
  };
}
