/**
 * The passkey half of the vault — docs/HANDOFF-infinite-agent.md §4.5.
 *
 * WHY PRF AND NOT "A PASSKEY LOGIN". A passkey normally proves who you are to a server. Here there is
 * no server and nothing to prove: what the vault needs is a SECRET, and the WebAuthn PRF extension is
 * the only browser API that gives the same 32 bytes back from the same authenticator and the same
 * salt, every time, without ever exposing them to storage. Face or fingerprint each time the person
 * enters, device-bound by construction — which is also why §4.5 says a passkey-wrapped vault cannot
 * travel: those bytes never leave that authenticator, so no bundle can carry them.
 *
 * Everything here feature-detects and returns null rather than throwing on an authenticator that will
 * not do PRF, because the fallback (a password) is a first-class option and not an error path.
 *
 * The KEY DERIVATION is NOT here. `createVault` in @00/agent-runtime takes the raw PRF bytes and does
 * the HKDF itself, so the wrapping key is derived in the same module that seals the file — this one
 * only performs the ceremony a package with no DOM cannot.
 */

/** The DOM lib does not type the PRF extension yet; these are its shapes, kept local and narrow. */
interface PrfInputs {
  prf?: { eval?: { first: BufferSource; second?: BufferSource } };
}
interface PrfResults {
  prf?: { enabled?: boolean; results?: { first: ArrayBuffer; second?: ArrayBuffer } };
}

export interface PrfCredential {
  /** base64url of the credential's raw id; stored beside the sealed vault, not secret. */
  credentialId: string;
}

export function webauthnAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of view) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The salt is fixed and public: PRF derives per-CREDENTIAL, so the same salt on a different
 * authenticator gives different bytes. Changing it would orphan every existing vault.
 */
export const PRF_SALT = new TextEncoder().encode("00.infinite.vault.v1");

/** Creates a resident credential on this device and reports whether it will actually do PRF. */
export async function createPrfCredential(displayName: string): Promise<PrfCredential | null> {
  if (!webauthnAvailable()) return null;
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge,
      // No server, so the relying party IS this origin and the name is the product's.
      rp: { name: "Infinite Agent", id: location.hostname },
      user: { id: userId, name: displayName || "owner", displayName: displayName || "owner" },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      timeout: 60_000,
      extensions: { prf: {} } as PrfInputs as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) return null;
  const results = cred.getClientExtensionResults() as PrfResults;
  // `enabled: false` means the authenticator made a credential but will never hand back a secret —
  // useless for a vault, and better refused now than at the first unlock.
  if (results.prf?.enabled === false) return null;
  return { credentialId: base64url(cred.rawId) };
}

/** The 32 bytes for this credential and salt. Null when the authenticator declines or has no PRF. */
export async function getPrfSecret(credentialId: string): Promise<Uint8Array | null> {
  if (!webauthnAvailable()) return null;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: fromBase64url(credentialId) as BufferSource }],
      userVerification: "required",
      timeout: 60_000,
      extensions: { prf: { eval: { first: PRF_SALT as BufferSource } } } as PrfInputs as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) return null;
  const results = assertion.getClientExtensionResults() as PrfResults;
  const first = results.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}
