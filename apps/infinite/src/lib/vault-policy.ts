/**
 * When the vault locks, and what it will and will not do — docs/HANDOFF-infinite-agent.md §4.5.
 *
 * WHY THE POLICY IS SEPARATE FROM THE CRYPTO. §4.5 makes four promises that are policy, not
 * cryptography: the password is asked EVERY time the person enters, unlocked material dies on tab
 * close / lock / 30 minutes idle, `Lock now` is always one click away, and a passkey-wrapped vault
 * cannot travel because the PRF secret never leaves that authenticator. Those are the rules a person
 * relies on, so they are stated once, here, where a test can hold them — and the WebAuthn and AES
 * work sits in webauthn-prf.ts and in the vault the runtime package owns.
 */

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
