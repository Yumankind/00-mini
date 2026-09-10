/**
 * The transfer's key — re-exported from `@00/agent-fs`, for the reason wire.ts states.
 *
 * Worth repeating where the PWA can see it: **DTLS ends at the SFU**. The edge terminates the
 * transport encryption and relays the payload, so the thing that protects the agent is the bundle's
 * own AES-256-GCM key, derived here with HKDF-SHA256 from the six-word code and the room's salt. The
 * four-character confirmation comes out of the same derivation, which is why two devices that agree
 * on it are two devices that will agree on the key.
 */
export {
  CONFIRM_ALPHABET,
  CONFIRM_INFO,
  CONFIRM_LENGTH,
  SECRET_INFO,
  deriveTransferKeys,
  equalStrings,
  fromBase64Url,
  sha256Hex,
  toBase64Url,
} from "@00/agent-fs";
export type { TransferKeys } from "@00/agent-fs";
