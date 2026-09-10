/**
 * THE TWIN TEST. Four implementations of `00mc` exist; two of them are in this repository, and this
 * file is what stops those two from drifting.
 *
 * It does not assert that the browser's wire "looks like" the engine's. It imports BOTH — the shared
 * module and `apps/00d/src/mobile-connect-wire.ts` itself — and then makes them talk: a frame signed
 * with WebCrypto here is verified with `@noble/curves` there, and one signed there is verified here.
 * A vector produced by the engine's own implementation is the only assertion that cannot be satisfied
 * by two copies of the same mistake.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_PAYLOAD_HASH,
  FRAME_KINDS,
  MOBILE_CONNECT_VERSION,
  SUPPORTED_VERSIONS,
  WIRE_FIELD_RE,
  signingString,
  type Frame,
} from "@00/shared";
import * as engineWire from "../../00d/src/mobile-connect-wire.js";
import {
  b64u,
  b64uDecode,
  createIdentity,
  devIdForPublicKey,
  glanceCode,
  mintFrameId,
  parseWireFrame,
  payloadHash,
  signFrame,
  toWireFrame,
  verifyFrame,
} from "../src/mac/wire.js";

const NOW = 1_700_000_000_000;

const frame = (over: Partial<Frame> = {}): Frame => ({
  dir: "req",
  dev: "ph-0011223344ab",
  sessionId: "mc-aabbccddeeff",
  frameId: "f-0102030405060708090a0b0c",
  engineFp: "mc-aabbccddeeff",
  agentId: "agent-01",
  kind: "prompt",
  ts: NOW,
  ...over,
});

/**
 * A WebCrypto keypair the ENGINE can also sign with.
 *
 * An Ed25519 PKCS#8 blob is a 16-byte header and then the 32-byte seed, which is exactly what
 * `@noble`'s `sign` takes. Extracting it here is the only way to have ONE key that both stacks hold,
 * and it is what makes the round trip below a real cross-implementation vector rather than two
 * independent self-consistency checks. (The app itself never does this: its keys are generated
 * non-extractable and cannot be exported at all.)
 */
async function sharedKey(): Promise<{ privateKey: CryptoKey; seed: Uint8Array; publicRaw: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, seed: pkcs8.slice(-32), publicRaw };
}

describe("the engine's wire and the shared wire are the same wire", () => {
  it("re-exports the same constants, not a second copy of them", () => {
    expect(engineWire.MOBILE_CONNECT_VERSION).toBe(MOBILE_CONNECT_VERSION);
    expect(engineWire.SUPPORTED_VERSIONS).toEqual(SUPPORTED_VERSIONS);
    expect([...engineWire.FRAME_KINDS]).toEqual([...FRAME_KINDS]);
    expect(engineWire.SESSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(engineWire.EMPTY_PAYLOAD_HASH).toBe(EMPTY_PAYLOAD_HASH);
  });

  it("uses one field charset, character for character", () => {
    expect(engineWire.WIRE_FIELD_RE.source).toBe(WIRE_FIELD_RE.source);
    expect(engineWire.WIRE_FIELD_RE.flags).toBe(WIRE_FIELD_RE.flags);
    // The anchors are load-bearing: an LF inside a field of an LF-joined string lets a sender choose
    // where the boundaries fall, which is how two different frames sign identical bytes.
    expect(WIRE_FIELD_RE.test("prompt\ninjected")).toBe(false);
  });

  it("builds byte-identical signing strings, including for an older version", () => {
    const hash = engineWire.payloadHash("hello");
    expect(engineWire.signingString(frame(), hash)).toBe(signingString(frame(), hash));
    expect(engineWire.signingString(frame(), hash, "00mc/1")).toBe(signingString(frame(), hash, "00mc/1"));
  });

  it("hashes payloads the same way, WebCrypto against @noble", async () => {
    for (const payload of ["hello", "", JSON.stringify({ text: "olá — ✓" }), "a".repeat(5000)]) {
      expect(await payloadHash(payload)).toBe(engineWire.payloadHash(payload || undefined));
    }
    expect(await payloadHash(undefined)).toBe(EMPTY_PAYLOAD_HASH);
    // The constant is pinned against a real sha256 rather than trusted: `@00/shared` holds no hash
    // function, so the literal there is only as good as something that checks it.
    expect(EMPTY_PAYLOAD_HASH).toBe(await payloadHash(new Uint8Array()));
  });

  it("derives the same glance code, and never sends it", async () => {
    const code = await glanceCode("mc-aabbccddeeff", "ENGINEKEY", "PHONEKEY");
    expect(code).toBe(engineWire.glanceCode("mc-aabbccddeeff", "ENGINEKEY", "PHONEKEY"));
    expect(code).toMatch(/^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
  });
});

describe("a signature crosses the two implementations", () => {
  it("browser signs, engine verifies", async () => {
    const key = await sharedKey();
    const f = frame();
    const sig = await signFrame(f, "hello", key.privateKey);
    expect(
      engineWire.verifyFrame({
        frame: f,
        payload: "hello",
        signatureB64u: sig,
        senderPublicKey: key.publicRaw,
        now: NOW,
        seen: false,
        session: { active: true, startedAt: NOW - 60_000 },
      }),
    ).toBeNull();
  });

  it("engine signs, browser verifies", async () => {
    const key = await sharedKey();
    const f = frame({ dir: "res" });
    const sig = engineWire.signFrame(f, "hello", key.seed);
    expect(
      await verifyFrame({
        frame: f,
        payload: "hello",
        signatureB64u: sig,
        senderPublicKey: key.publicRaw,
        now: NOW,
        seen: false,
        session: { active: true, startedAt: NOW - 60_000 },
      }),
    ).toBeNull();
  });

  it("names the same refusals in the same order", async () => {
    const key = await sharedKey();
    const f = frame();
    const sig = await signFrame(f, "hello", key.privateKey);
    const base = {
      frame: f,
      payload: "hello" as string | undefined,
      signatureB64u: sig,
      senderPublicKey: key.publicRaw as Uint8Array | undefined,
      now: NOW,
      seen: false,
      session: { active: true, startedAt: NOW - 60_000 } as { active: boolean; startedAt: number } | undefined,
    };
    const both = async (over: Partial<typeof base>) => {
      const mine = await verifyFrame({ ...base, ...over });
      const theirs = engineWire.verifyFrame({ ...base, ...over });
      expect(mine).toBe(theirs);
      return mine;
    };
    expect(await both({ frame: frame({ dev: "bad dev" }) })).toBe("fields");
    expect(await both({ senderPublicKey: undefined })).toBe("unknown-device");
    // A rewritten payload fails as a SIGNATURE, because the hash is inside the signed string — that
    // is the property, not an accident of ordering.
    expect(await both({ payload: "hell0" })).toBe("signature");
    expect(await both({ now: NOW + 200_000 })).toBe("stale");
    expect(await both({ seen: true })).toBe("replay");
    expect(await both({ session: undefined })).toBe("session-gone");
    expect(await both({ session: { active: false, startedAt: NOW } })).toBe("session-gone");
    expect(await both({ now: NOW, session: { active: true, startedAt: NOW - 25 * 60 * 60_000 } })).toBe(
      "session-expired",
    );
  });
});

describe("the browser's own encodings", () => {
  it("round-trips base64url without padding, and reads padded input too", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const encoded = b64u(bytes);
    expect(encoded).not.toContain("=");
    expect([...b64uDecode(encoded)]).toEqual([...bytes]);
    expect([...b64uDecode(`${encoded}==`.slice(0, encoded.length + 1))]).toEqual([...bytes]);
  });

  it("mints a dev from the key's own bytes, with the prefix the far side reads", async () => {
    const { identity } = await createIdentity("ph");
    expect(identity.dev).toMatch(/^ph-[0-9a-f]{12}$/);
    expect(identity.dev).toBe(devIdForPublicKey(identity.publicKey, "ph"));
    expect(WIRE_FIELD_RE.test(identity.dev)).toBe(true);
    // The private half is generated non-extractable: there is no seed to leak because there is no
    // way to ask for one.
    expect(identity.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", identity.privateKey)).rejects.toThrow();
  });

  it("refuses a key that is not 32 bytes rather than truncating one", () => {
    expect(() => devIdForPublicKey(new Uint8Array(16), "mc")).toThrow(/32 bytes/);
  });

  it("mints frame ids the far side accepts", () => {
    const id = mintFrameId();
    expect(id).toMatch(/^f-[0-9a-f]{24}$/);
    expect(WIRE_FIELD_RE.test(id)).toBe(true);
    expect(mintFrameId()).not.toBe(id);
  });

  it("puts the version and the payload hash on the wire, and empty bytes as the empty string", async () => {
    const { identity } = await createIdentity("mc");
    const empty = await toWireFrame(frame({ kind: "session.close" }), undefined, identity.privateKey);
    expect(empty.payloadB64u).toBe("");
    expect(empty.frame.v).toBe(MOBILE_CONNECT_VERSION);
    expect(empty.frame.payloadSha256).toBe(EMPTY_PAYLOAD_HASH);
    const full = await toWireFrame(frame(), "hello", identity.privateKey);
    expect(full.frame.payloadSha256).toBe(await payloadHash("hello"));
  });

  it("shapes a frame off the wire without repairing one", () => {
    expect(parseWireFrame(null)).toBeNull();
    expect(parseWireFrame({ ts: "no" })).toBeNull();
    expect(parseWireFrame({ ts: 1, sig: "x", dir: "sideways" })?.dir).toBe("req");
    const parsed = parseWireFrame({ ...frame(), v: "00mc/1", payloadSha256: EMPTY_PAYLOAD_HASH, sig: "s" });
    expect(parsed?.v).toBe("00mc/1");
    expect(parsed?.dev).toBe("ph-0011223344ab");
  });
});
