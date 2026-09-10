/**
 * PICTURES, IN ONE PLACE — the bytes ⇄ base64 conversions the four providers share, and the
 * sentence a brain that cannot see is told instead of the picture (gap B10 of
 * docs/HANDOFF-infinite-agent.md: "no image reaches any brain").
 *
 * WHY THIS IS A MODULE AND NOT FOUR PRIVATE HELPERS. `ImagePart` (types.ts, added 2026-09-10) is
 * deliberately loose — `data` is raw bytes, or base64, or a whole `data:` URL — because the thing
 * that produced it has its own idea of what an image is: a file read out of OPFS is bytes, a paste
 * is a data URL, a bundle that travelled is base64. Every provider then has to answer the same three
 * questions before it can put the picture on a wire: how big is it really, what format is it really,
 * and what happens when this brain cannot see. Four answers to that is four bugs, and the third one
 * is the one a person notices.
 *
 * THE THREE RULES:
 *
 * 1. THE MAGIC BYTES WIN OVER THE DECLARED TYPE. `ImagePart.mime` is what the producer THOUGHT it
 *    had. A JPEG announced as `image/png` is a 400 from Anthropic and a silently ignored block from
 *    some OpenAI-compatible hosts, and neither error names the cause. The first bytes of a file are
 *    not an opinion, so they are read first and `mime` is the fallback for a format this sniff does
 *    not know (avif, heic — a vendor may well accept them, so they are passed through rather than
 *    refused here).
 *
 * 2. FOUR MEGABYTES, REFUSED BY NAME. Base64 inflates by a third, so a 4 MB picture is a ~5.3 MB
 *    JSON body from a browser — and a local model rescales whatever it is given to a few hundred
 *    pixels anyway, so the megabytes buy nothing but a slow request and a vendor-side limit hit in
 *    the middle of a turn. The cap is enforced HERE, once, and the refusal is a `ProviderError` with
 *    `vendorCode: "image_too_large"` naming the size and the limit, because "400 bad request" from a
 *    vendor tells a person nothing they can act on.
 *
 * 3. A PICTURE IS NEVER DROPPED IN SILENCE. A text-only brain does not get the images and DOES get
 *    one line of text saying a picture was attached that it cannot see. Without that line the model
 *    answers "I don't see any image" to a person who is looking at one they definitely attached, and
 *    the agent looks broken rather than limited. `withoutImages()` is the only way images leave a
 *    transcript in this package.
 */

import { toBase64 } from "./device-key.js";
import { ProviderError } from "./errors.js";
import type { ChatMessage, ImagePart, ModelInfo } from "./types.js";

/** The cap, in bytes of the ORIGINAL image (rule 2). */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** The formats the magic-byte sniff knows, which are also the four every vendor here documents. */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** What a picture is called when neither the bytes nor the producer say. */
export const IMAGE_FALLBACK_MIME = "application/octet-stream";

/** The clause the note ends with when the brain itself cannot see. */
export const NO_VISION_REASON = "this model cannot see pictures";

/**
 * The clause for a picture the WIRE cannot carry where it sits.
 *
 * Both cloud wires take a picture in a person's own turn and nowhere else: an assistant turn is
 * something the model wrote, and moving the picture into an invented user turn would put a message
 * in the transcript that nobody sent. Distinct from `NO_VISION_REASON` because the two are different
 * facts and a person reading the note deserves the right one.
 */
export const NON_USER_IMAGE_REASON = "only a person's own turn can carry a picture to this model";

function ascii(bytes: Uint8Array, at: number, length: number): string {
  if (bytes.length < at + length) return "";
  let out = "";
  for (let i = at; i < at + length; i += 1) out += String.fromCharCode(bytes[i] as number);
  return out;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;

/** The format the FILE says it is, or `undefined` for one this sniff does not know. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, PNG_MAGIC)) return "image/png";
  if (startsWith(bytes, JPEG_MAGIC)) return "image/jpeg";
  // RIFF containers name their form at byte 8; only `WEBP` is an image.
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  return undefined;
}

/** The named refusal of rule 2. `bad_request` because no retry and no other peer fixes it. */
export function imageTooLarge(bytes: number, providerId?: string, maxBytes: number = IMAGE_MAX_BYTES): ProviderError {
  return new ProviderError({
    status: 0,
    code: "bad_request",
    message: `That picture is ${Math.round(bytes / 1024)} KB, over the ${Math.round(maxBytes / 1024)} KB an agent will send to a model.`,
    providerId,
    vendorCode: "image_too_large",
  });
}

/** base64 (bare, or the tail of a `data:` URL) → bytes. Whitespace, which a wrapped string carries, is dropped. */
export function fromBase64(value: string): Uint8Array {
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  const body = (comma === -1 ? value : value.slice(comma + 1)).replace(/\s+/g, "");
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export interface ImageBytesOptions {
  /** Named in the refusal, so a person is told WHICH brain refused the picture. */
  providerId?: string;
  maxBytes?: number;
}

export interface DecodedImage {
  bytes: Uint8Array;
  /** Sniffed first, declared second (rule 1). */
  mime: string;
}

/**
 * An `ImagePart` as bytes and a trustworthy MIME type, with the cap enforced.
 *
 * The decode happens even when `data` is already base64: the size is not knowable from the encoded
 * length alone once whitespace and padding are in it, and the sniff needs real bytes. A picture that
 * is not decodable at all is `bad_request` rather than a crash — it came from a tool result or a
 * paste, so it is data, not a programming error.
 */
export function decodeImage(image: ImagePart, options: ImageBytesOptions = {}): DecodedImage {
  const max = options.maxBytes ?? IMAGE_MAX_BYTES;
  let bytes: Uint8Array;
  if (typeof image.data === "string") {
    try {
      bytes = fromBase64(image.data);
    } catch (err) {
      throw new ProviderError({
        status: 0,
        code: "bad_request",
        message: "That picture is not base64 and could not be read.",
        providerId: options.providerId,
        vendorCode: "image_unreadable",
        cause: err,
      });
    }
  } else {
    bytes = image.data;
  }
  if (bytes.byteLength > max) throw imageTooLarge(bytes.byteLength, options.providerId, max);
  const declared = image.mime?.trim();
  return { bytes, mime: sniffImageMime(bytes) ?? (declared || IMAGE_FALLBACK_MIME) };
}

/** The same, as base64 — the shape both cloud wires want. */
export function imageBase64(image: ImagePart, options: ImageBytesOptions = {}): { data: string; mime: string } {
  const decoded = decodeImage(image, options);
  return { data: toBase64(decoded.bytes), mime: decoded.mime };
}

/** `data:<mime>;base64,<data>` — what an OpenAI `image_url` part carries when there is no URL. */
export function imageDataUrl(image: ImagePart, options: ImageBytesOptions = {}): string {
  const { data, mime } = imageBase64(image, options);
  return `data:${mime};base64,${data}`;
}

// ── Dropping a picture out loud ─────────────────────────────────────────────────────────────────

export function hasImages(messages: readonly ChatMessage[]): boolean {
  return messages.some((m) => Boolean(m.images?.length));
}

/** The one line of rule 3. `reason` is the clause after the comma; a wire that cannot carry a picture passes its own. */
export function droppedImagesNote(images: readonly ImagePart[], reason: string = NO_VISION_REASON): string {
  const what = images.length === 1 ? "A picture was" : `${images.length} pictures were`;
  const named = images.map((i) => i.source).filter((s): s is string => Boolean(s));
  const from = named.length ? ` (${named.join(", ")})` : "";
  return `[${what} attached${from}, but ${reason}.]`;
}

/**
 * The transcript with every picture removed and every removal stated in the text.
 *
 * The array is returned unchanged when there was nothing to drop, so a text-only provider can call
 * this on every turn without allocating a second copy of a long history.
 */
export function withoutImages(messages: ChatMessage[], reason: string = NO_VISION_REASON): ChatMessage[] {
  if (!hasImages(messages)) return messages;
  return messages.map((message) => {
    const images = message.images;
    if (!images?.length) return message;
    const { images: _dropped, ...rest } = message;
    const note = droppedImagesNote(images, reason);
    return { ...rest, content: rest.content ? `${rest.content}\n\n${note}` : note };
  });
}

/**
 * Does the catalogue say this model can see? THREE-VALUED on purpose.
 *
 * A row that exists is the catalogue SPEAKING: `true` when it claims vision and `false` when it does
 * not, because `ModelInfo.vision` is documented as "absent means text-only" and a provider is not
 * free to reinterpret the frozen contract. `undefined` is the different case — NO ROW AT ALL, an id
 * nobody listed — and each provider reads that silence its own way: an OpenAI-compatible base may be
 * any host on earth, so silence there means text-only, while Anthropic's `/v1/messages` takes image
 * blocks on every model it currently serves, so silence there means send them.
 */
export function rowVision(rows: readonly ModelInfo[], modelId: string | undefined): boolean | undefined {
  const row = rows.find((r) => r.id === modelId);
  return row ? row.vision === true : undefined;
}
