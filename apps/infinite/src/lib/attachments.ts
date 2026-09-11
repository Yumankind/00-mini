/**
 * PICTURES ON A MESSAGE — how they are shrunk, where they are put, and what the message then says.
 *
 * THE ONE THING THE FROZEN CONTRACT DOES NOT CARRY. `RunOptions` (packages/agent-runtime/src/api.ts)
 * is `prompt: string` and no more: there is no field for images on the turn a person sends, and that
 * file is frozen for the runtime's owners. `ChatMessage.images` exists one layer down and the `read`
 * tool already uses it — `tools-fs.ts` hands back `{ output: "[image …]", images: [part] }`, and the
 * loop carries those bytes to the brain on the tool result (gap B10).
 *
 * So an attached picture takes the road that exists: it is WRITTEN INTO THE WORKSPACE, and the
 * message names the path. The agent reads it with the tool it already has, a vision brain sees the
 * bytes, and a text-only brain is told in one line that a picture it cannot see was attached
 * (`droppedImagesNote`, image-parts.ts rule 3). Nothing is invented and nothing is silent. The day
 * the contract grows an `images` field on `RunOptions`, `send()` passes the parts straight through
 * and this module keeps only the shrinking.
 *
 * WHY THEY ARE SHRUNK FIRST. A phone camera writes 12 MP; the cap every vendor here enforces is 4 MB
 * of original bytes (`IMAGE_MAX_BYTES`) and a local model rescales to a few hundred pixels anyway.
 * 1568px on the longest side at JPEG 0.85 is the size that survives all four wires — and it is done
 * before the file is written, so the workspace does not fill with megapixels either.
 */

/** The longest side, in pixels, after shrinking. */
export const MAX_EDGE = 1568;
/** JPEG quality for the re-encode. Enough for a screenshot of code to stay readable. */
export const JPEG_QUALITY = 0.85;
/** Where an attached picture lands. One folder, so a person can find and delete them. */
export const UPLOAD_DIR = "workspace/uploads";

export interface Attachment {
  id: string;
  /** The file name as written into the workspace (not the path). */
  name: string;
  mime: string;
  bytes: Uint8Array;
  /** A `blob:`/`data:` URL for the thumbnail in the composer and in the sent row. */
  url: string;
  width: number;
  height: number;
}

/** Fit a picture inside a square without stretching it. Smaller pictures are left alone. */
export function fitWithin(width: number, height: number, max = MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max || longest === 0) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A name a filesystem will take: no slashes, no spaces to quote, and never empty. */
export function safeFileName(name: string, fallback = "image.jpg"): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned.slice(0, 64) : fallback;
}

/**
 * The path an attachment is written to. Stamped with the minute so two screenshots pasted in a row
 * do not overwrite one another, and so the folder reads in the order things were attached.
 */
export function attachmentPath(name: string, at = Date.now(), dir = UPLOAD_DIR): string {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${dir}/${stamp}-${safeFileName(name)}`;
}

/**
 * What the agent is told. The paths go at the TOP and in the person's own message, not in a side
 * channel, for the same reason the preview's selection does (power/inspector-context.ts): the
 * transcript has to show exactly what the agent was given, live and after a reload alike.
 */
export function withAttachments(text: string, paths: string[]): string {
  if (!paths.length) return text;
  const lines = paths.map((path) => `- ${path}`).join("\n");
  const note = `I attached ${paths.length === 1 ? "a picture" : `${paths.length} pictures`}, saved in this workspace:\n${lines}\n\nRead ${paths.length === 1 ? "it" : "them"} with the \`read\` tool to see ${paths.length === 1 ? "it" : "them"}.`;
  return text.trim() ? `${note}\n\n${text.trim()}` : note;
}

/** The quiet line under the composer when the brain that answers next cannot see pictures. */
export function visionNote(brainName: string, sees: boolean | null): string | null {
  if (sees !== false) return null;
  return `${brainName} cannot see pictures. It is told one was attached, and it can still read the file.`;
}

// ── The browser half ───────────────────────────────────────────────────────────────────────────────

/**
 * A `File` or `Blob` → an attachment, shrunk. Uses `createImageBitmap` and a canvas, both of which
 * every browser this app runs in has; a picture the browser cannot decode is refused by name rather
 * than attached as bytes nothing can look at.
 */
export async function readAttachment(file: File | Blob, name?: string): Promise<Attachment> {
  const label = safeFileName(name ?? (file instanceof File ? file.name : "pasted.png"), "pasted.png");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`${label} is not a picture this browser can read.`);
  });
  const size = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser would not give the picture a canvas to be resized on.");
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("The picture could not be re-encoded.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    // Re-encoded as JPEG, so the name says JPEG: a `.png` holding JPEG bytes is the exact confusion
    // `sniffImageMime` exists to undo one layer down.
    name: label.replace(/\.[A-Za-z0-9]+$/, "") + ".jpg",
    mime: "image/jpeg",
    bytes,
    url: URL.createObjectURL(blob),
    width: size.width,
    height: size.height,
  };
}

/** Every picture in a drop or a paste, in the order the browser listed them. */
export function imageFilesOf(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (!entry) continue;
    const file = "getAsFile" in entry ? entry.getAsFile() : entry;
    if (file && file.type.startsWith("image/")) out.push(file);
  }
  return out;
}
