/**
 * The filesystem half of the preview: read an `.html` file and the assets it names, hand back one
 * document. The RULES are in `src/lib/preview-resolve.ts`, which is pure and tested; this is the
 * part that awaits.
 *
 * WHY IT REFUSES TO GO DEEP. Only the references in the page itself are followed — a stylesheet's
 * own `@import` and `url()` are not. That is a real limit, said out loud in `missing`, and it is
 * deliberate: following them means a resolver that walks CSS, and a page that pulls in a hundred
 * sprites would then block the pane on a hundred OPFS reads. One level covers the pages an agent
 * actually writes into `projects/<name>/`.
 */
import type { AgentFs } from "@00/agent-fs";
import {
  collectRefs,
  ensureDocument,
  inlinePreview,
  mimeFor,
  type LoadedAsset,
} from "../lib/preview-resolve.js";

/** Above this an asset is skipped rather than turned into a megabyte of base64 in a string. */
export const MAX_INLINE_BYTES = 2_000_000;

export interface PreviewBuild {
  /** The document, ready for `srcdoc`. */
  html: string;
  /** References that could not be inlined, as written in the page, so the pane can say which. */
  missing: string[];
  /** External URLs left alone — the page will try to fetch them, and inside the sandbox it may. */
  external: string[];
}

/** Base64 without a Buffer: the browser's own encoder, over a binary string built in chunks. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function buildPreview(fs: AgentFs, path: string): Promise<PreviewBuild> {
  const source = await fs.readText(path);
  const refs = collectRefs(source, path);
  const assets = new Map<string, LoadedAsset>();
  const missing: string[] = [];
  const external: string[] = [];

  for (const ref of refs) {
    if (!ref.path) {
      external.push(ref.ref);
      continue;
    }
    if (assets.has(ref.path)) continue;
    const stat = await fs.stat(ref.path);
    if (!stat || stat.kind !== "file" || stat.size > MAX_INLINE_BYTES) {
      missing.push(ref.ref);
      continue;
    }
    try {
      if (ref.kind === "image") {
        assets.set(ref.path, { dataUrl: `data:${mimeFor(ref.path)};base64,${toBase64(await fs.readFile(ref.path))}` });
      } else {
        assets.set(ref.path, { text: await fs.readText(ref.path) });
      }
    } catch {
      missing.push(ref.ref);
    }
  }

  return {
    html: ensureDocument(inlinePreview(source, path, assets), path.slice(path.lastIndexOf("/") + 1)),
    missing,
    external,
  };
}
