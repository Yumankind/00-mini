/**
 * The shared picture plumbing: what a byte string really is, how big is too big, and the sentence a
 * brain that cannot see is given instead (src/image-parts.ts).
 *
 * The three rules of that module are each pinned here, because each one is a bug that has to be
 * found in a mapper rather than in a vendor's 400: the sniff beating the declared type, the cap
 * refusing by name, and a drop that is never silent.
 */
import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.js";
import {
  decodeImage,
  droppedImagesNote,
  fromBase64,
  hasImages,
  IMAGE_FALLBACK_MIME,
  IMAGE_MAX_BYTES,
  IMAGE_MIME_TYPES,
  imageBase64,
  imageDataUrl,
  imageTooLarge,
  NON_USER_IMAGE_REASON,
  NO_VISION_REASON,
  rowVision,
  sniffImageMime,
  withoutImages,
} from "../src/image-parts.js";
import type { ChatMessage, ImagePart, ModelInfo } from "../src/types.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const GIF87 = new Uint8Array([...new TextEncoder().encode("GIF87a"), 4]);
const GIF89 = new Uint8Array([...new TextEncoder().encode("GIF89a"), 4]);
const WEBP = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP"), 7]);

describe("the magic-byte sniff", () => {
  it("knows the four formats every vendor here documents", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(GIF87)).toBe("image/gif");
    expect(sniffImageMime(GIF89)).toBe("image/gif");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
    expect([...IMAGE_MIME_TYPES].sort()).toEqual(["image/gif", "image/jpeg", "image/png", "image/webp"]);
  });

  it("answers nothing for a format it does not know, and for a truncated file", () => {
    expect(sniffImageMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeUndefined();
    expect(sniffImageMime(new Uint8Array([0x89, 0x50]))).toBeUndefined();
    // A RIFF container that is not a WEBP — an audio file, say — is not an image.
    const wav = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WAVE")]);
    expect(sniffImageMime(wav)).toBeUndefined();
  });

  it("BEATS the declared type, because the bytes are not an opinion", () => {
    // A PNG announced as a JPEG is the bug this rule exists for: the vendor refuses it by a name
    // nobody recognises, minutes into a turn.
    expect(decodeImage({ mime: "image/jpeg", data: PNG }).mime).toBe("image/png");
  });

  it("falls back to what the producer said, and then to octet-stream", () => {
    const odd = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(decodeImage({ mime: "image/avif", data: odd }).mime).toBe("image/avif");
    expect(decodeImage({ mime: "  ", data: odd }).mime).toBe(IMAGE_FALLBACK_MIME);
  });
});

describe("bytes ⇄ base64", () => {
  it("reads bare base64, a data URL and whitespace-wrapped base64 as the same bytes", () => {
    const { data } = imageBase64({ mime: "image/png", data: PNG });
    expect(fromBase64(data)).toEqual(PNG);
    expect(fromBase64(`data:image/png;base64,${data}`)).toEqual(PNG);
    expect(fromBase64(`${data.slice(0, 4)}\n  ${data.slice(4)}`)).toEqual(PNG);
  });

  it("round-trips a string part as faithfully as a bytes part", () => {
    const asBytes = imageBase64({ mime: "image/png", data: PNG });
    const asString = imageBase64({ mime: "image/png", data: asBytes.data });
    const asDataUrl = imageBase64({ mime: "image/png", data: `data:image/png;base64,${asBytes.data}` });
    expect(asString).toEqual(asBytes);
    expect(asDataUrl).toEqual(asBytes);
  });

  it("builds the data URL an OpenAI image_url part carries", () => {
    expect(imageDataUrl({ mime: "image/jpeg", data: JPEG })).toBe(`data:image/jpeg;base64,${imageBase64({ mime: "x", data: JPEG }).data}`);
  });

  it("refuses something that is not base64 at all, as data rather than as a crash", () => {
    let error: unknown;
    try {
      decodeImage({ mime: "image/png", data: "not base64 ✱" }, { providerId: "byok:openai" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("bad_request");
    expect((error as ProviderError).vendorCode).toBe("image_unreadable");
    expect((error as ProviderError).providerId).toBe("byok:openai");
  });
});

describe("the four-megabyte cap", () => {
  it("refuses by name, with the size and the limit in the sentence", () => {
    const error = imageTooLarge(5_000_000, "overblast");
    expect(error.code).toBe("bad_request");
    expect(error.vendorCode).toBe("image_too_large");
    expect(error.providerId).toBe("overblast");
    expect(error.message).toContain("4096 KB");
  });

  it("is enforced on the way in, before any wire is touched", () => {
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    big.set(PNG.subarray(0, 8));
    expect(() => decodeImage({ mime: "image/png", data: big })).toThrow(/over the/);
    // The caller may tighten it; nothing may loosen it silently, because the default is the one
    // every provider gets.
    expect(() => decodeImage({ mime: "image/png", data: PNG }, { maxBytes: 4 })).toThrow(/over the/);
    expect(IMAGE_MAX_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe("dropping a picture out loud", () => {
  const shot: ImagePart = { mime: "image/png", data: PNG, source: "screenshot.png" };

  it("names one picture, several pictures, and where they came from", () => {
    expect(droppedImagesNote([shot])).toBe("[A picture was attached (screenshot.png), but this model cannot see pictures.]");
    expect(droppedImagesNote([{ mime: "image/png", data: PNG }])).toBe("[A picture was attached, but this model cannot see pictures.]");
    expect(droppedImagesNote([shot, shot])).toContain("2 pictures were attached");
    expect(droppedImagesNote([shot], NON_USER_IMAGE_REASON)).toContain(NON_USER_IMAGE_REASON);
    expect(NO_VISION_REASON).toBe("this model cannot see pictures");
  });

  it("removes the images and puts the note in the text, never one without the other", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "what is this?", images: [shot] },
    ];
    const out = withoutImages(messages);
    expect(out[1]?.images).toBeUndefined();
    expect(out[1]?.content).toBe("what is this?\n\n[A picture was attached (screenshot.png), but this model cannot see pictures.]");
    // The originals are untouched: the caller's history is not the provider's to edit.
    expect(messages[1]?.images).toHaveLength(1);
  });

  it("is the whole message when the picture came with no words", () => {
    expect(withoutImages([{ role: "user", content: "", images: [shot] }])[0]?.content).toMatch(/^\[A picture was attached/);
  });

  it("hands back the very same array when there is nothing to drop", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    expect(withoutImages(messages)).toBe(messages);
    expect(hasImages(messages)).toBe(false);
    expect(hasImages([{ role: "user", content: "", images: [] }])).toBe(false);
    expect(hasImages([{ role: "user", content: "", images: [shot] }])).toBe(true);
  });
});

describe("what the catalogue says about seeing", () => {
  const rows: ModelInfo[] = [
    { id: "sees", label: "Sees", class: "strong", local: false, supportsTools: true, vision: true },
    { id: "blind", label: "Blind", class: "small", local: false, supportsTools: true, vision: false },
    { id: "silent", label: "Silent", class: "small", local: false, supportsTools: true },
  ];

  it("is three-valued: yes, no, and nobody said", () => {
    expect(rowVision(rows, "sees")).toBe(true);
    expect(rowVision(rows, "blind")).toBe(false);
    // A row that exists and does not claim vision is text-only: the catalogue IS speaking about it.
    expect(rowVision(rows, "silent")).toBe(false);
    // The silence each provider reads its own way is an id NO row carries at all.
    expect(rowVision(rows, "never-heard-of-it")).toBeUndefined();
    expect(rowVision([], undefined)).toBeUndefined();
  });
});
