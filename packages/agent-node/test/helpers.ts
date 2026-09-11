import { MemoryFs } from "@00/agent-fs";
import { NodeFsBackend } from "../src/fs/backend.js";
import { snapshotLoaderFs, type LoaderFs } from "../src/loader/index.js";

const encoder = new TextEncoder();

export function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

/** A virtual-path → bytes map, the shape `snapshotLoaderFs` takes. */
export function snap(files: Record<string, string | Uint8Array>): LoaderFs {
  const out: Record<string, Uint8Array> = {};
  for (const [path, value] of Object.entries(files)) out[path] = bytes(value);
  return snapshotLoaderFs(out);
}

/** A MemoryFs with the given files written into it, plus a backend rooted at the workspace. */
export async function memoryBackend(
  files: Record<string, string | Uint8Array> = {},
  root = "workspace",
): Promise<{ fs: MemoryFs; backend: NodeFsBackend; cwd: () => string }> {
  const fs = new MemoryFs();
  await fs.mkdir(root);
  for (const [path, value] of Object.entries(files)) {
    await fs.writeFile(`${root}${path.startsWith("/") ? path : `/${path}`}`, bytes(value));
  }
  let cwd = "/";
  const backend = new NodeFsBackend({ fs, root, cwd: () => cwd });
  return { fs, backend, cwd: () => cwd };
}

export function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value);
}
