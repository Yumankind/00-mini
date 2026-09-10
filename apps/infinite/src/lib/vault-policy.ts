/**
 * When the vault locks, and what it will and will not do — docs/HANDOFF-infinite-agent.md §4.5.
 *
 * WHY THE POLICY IS SEPARATE FROM THE CRYPTO. §4.5 makes four promises that are policy, not
 * cryptography: the password is asked EVERY time the person enters, unlocked material dies on tab
 * close / lock / 30 minutes idle, `Lock now` is always one click away, and a passkey-wrapped vault
 * cannot travel because the PRF secret never leaves that authenticator. Those are the rules a person
 * relies on, so they are stated once, here, where a test can hold them — and the WebAuthn and AES
 * work sits in webauthn-prf.ts and in the vault the runtime package owns.
 *
 * ── THE FIFTH PROMISE, ADDED 2026-09-10 (gap audit A2): THE VAULT DOES NOT TRAVEL SILENTLY ───────
 *
 * `vault.json` sits at the AGENT ROOT and `@00/shared`'s `classify()` calls it `record` — the class
 * that travels in a full move. That classification is right for the Mac, where a burst bundle goes
 * from one of the owner's machines to another over a channel the owner controls; it is wrong as a
 * DEFAULT for a file a person downloads to a shared laptop, mails to themselves, or hands to someone
 * at a Mac. So the class is left alone (`@00/shared` is the engine's contract and is not this app's
 * to redefine) and the EXPORT decides instead: every export path in this app passes an `include`
 * predicate that drops `vault.json` unless the person ticked *carry my secrets*.
 *
 * WHAT TRAVELS WHEN THE TICK IS ON is §4.5's rule, unchanged and deliberately not re-encrypted: a
 * password-wrapped vault travels AS IT IS, because its own password is what opens it on the far side
 * — re-wrapping it under the transfer secret would make the six-word code, which is read out loud and
 * dies with the flow, the only key to a person's API keys. A passkey-wrapped vault never travels at
 * all: the PRF secret cannot leave the authenticator, so those bytes would be dead weight the far
 * side can never open. Hence `canCarrySecrets()` gates the tick, and a passkey vault is shown the
 * reason instead of a control that cannot help it.
 */

/**
 * The vault's file name at the agent root — `VAULT_PATH` in @00/agent-runtime, spelled here so the
 * export predicates stay a pure string comparison with no package import. `test/vault-travel.test.ts`
 * pins the two together, because a rename in the package that this file did not follow would silently
 * put the vault back into every bundle.
 */
export const VAULT_FILE = "vault.json";

export type VaultKind = "password" | "passkey";

export interface VaultState {
  /** A vault has been created on this origin. */
  exists: boolean;
  unlocked: boolean;
  kind: VaultKind | null;
  /** Epoch ms of the last thing the person did; the idle clock runs from here. */
  lastActivity: number;
}

/** §4.5, stated as a number in one place. */
export const IDLE_LOCK_MS = 30 * 60 * 1000;

export function emptyVaultState(): VaultState {
  return { exists: false, unlocked: false, kind: null, lastActivity: 0 };
}

export function shouldLock(state: VaultState, now: number, idleMs = IDLE_LOCK_MS): boolean {
  if (!state.unlocked) return false;
  return now - state.lastActivity >= idleMs;
}

export function idleRemainingMs(state: VaultState, now: number, idleMs = IDLE_LOCK_MS): number {
  if (!state.unlocked) return 0;
  return Math.max(0, state.lastActivity + idleMs - now);
}

/** The line the shell surfaces so the idle lock is never a surprise. */
export function idleLine(state: VaultState, now: number, idleMs = IDLE_LOCK_MS): string | null {
  if (!state.unlocked) return null;
  const left = idleRemainingMs(state, now, idleMs);
  if (left === 0) return "Locked — idle.";
  const minutes = Math.ceil(left / 60000);
  if (minutes > 5) return null; // nobody needs a countdown for half an hour
  return `Locks in ${minutes} minute${minutes === 1 ? "" : "s"} unless you do something.`;
}

export function unlockPrompt(kind: VaultKind | null): string {
  if (kind === "passkey") return "Unlock with your passkey";
  return "Unlock with your password";
}

export function kindLabel(kind: VaultKind | null): string {
  if (kind === "passkey") return "Passkey (this device only)";
  if (kind === "password") return "Password";
  return "No vault yet";
}

/**
 * The travel rule of §4.5, as the sentence the export flow shows. A password-wrapped vault may ride
 * inside a `.00agent`; a passkey-wrapped one cannot, and the honest answer is to re-wrap or re-enter.
 */
export function travelNote(kind: VaultKind | null): string {
  if (kind === "passkey") {
    return "Your vault is held by this device's passkey, so it cannot travel. Re-wrap it under a password to carry it, or re-enter the keys on the far side.";
  }
  if (kind === "password") {
    return "Your vault can travel inside the file if you tick carry my secrets — the bundle is then encrypted twice.";
  }
  return "No secrets are stored yet, so nothing travels.";
}

export function canCarrySecrets(kind: VaultKind | null): boolean {
  return kind === "password";
}

// ── What an export carries, and what it says afterwards ───────────────────────────────────────────

/**
 * The `include` predicate every export in this app passes to `exportBundle`.
 *
 * It WRAPS the caller's base rule rather than replacing it (`fullModeInclude` from @00/agent-fs, which
 * already applies the four classes and the person's `.00ignore`), because the vault is one file and
 * the rest of the travel policy is not this app's to re-decide. One line, one exception, and the
 * exception is off by default.
 */
export function includeForExport(
  base: (relPath: string) => boolean,
  carrySecrets: boolean,
): (relPath: string) => boolean {
  return (rel) => {
    if (rel === VAULT_FILE && !carrySecrets) return false;
    return base(rel);
  };
}

/** Whether the tick may be offered at all, and the sentence to show when it may not. */
export interface CarryOffer {
  /** The tick is shown exactly when a password-wrapped vault exists to carry. */
  offered: boolean;
  label: string;
  /** Non-null when there IS a vault but it cannot travel — §4.5's passkey rule, in one line. */
  reason: string | null;
}

export function carryOffer(kind: VaultKind | null, secretCount: number): CarryOffer {
  const label = `Carry my secrets (${secretCount} sealed)`;
  if (kind === null || secretCount === 0) return { offered: false, label, reason: null };
  if (!canCarrySecrets(kind)) return { offered: false, label, reason: travelNote(kind) };
  return { offered: true, label, reason: null };
}

/** The standing rule, said where the vault is managed rather than only where a bundle is made. */
export function exportDefaultLine(): string {
  return "Backups and moves leave the vault behind unless you tick carry my secrets on the screen that makes them.";
}

/** What the export says it did, so "silently" is never true in either direction. */
export function carriedLine(carried: boolean): string {
  return carried
    ? "Your sealed secrets travelled with it — the same password opens them on the far side."
    : "Your sealed secrets stayed in this browser.";
}

/** What a restore or a live receive reports about the bundle it just opened. */
export function arrivedLine(vaultPresent: boolean): string {
  return vaultPresent
    ? "It brought a sealed vault — unlock it with the password it was sealed under."
    : "No vault came with it, so any keys have to be entered again here.";
}

/** Same floor as the bundle passphrase, and for the same reason: it is the only key. */
export function passwordProblem(password: string): string | null {
  if (!password) return "A password is required.";
  if (password.length < 8) return "At least 8 characters.";
  return null;
}

/** The agent sees NAMES only; values resolve at use. This is what the settings list may show. */
export function maskSecretValue(value: string): string {
  const v = value.trim();
  if (v.length <= 4) return "••••";
  return `••••${v.slice(-4)}`;
}
