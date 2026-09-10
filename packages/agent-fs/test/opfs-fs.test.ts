// OpfsFs cannot run in node, so what is tested here is the translation it actually owns: one
// relative path onto a chain of directory handles, the async write path, and the sync fast path
// with its fallback. The fakes below implement the same structural interfaces the adapter declares,
// which is why they are declared structurally in the first place.

import { describe, expect, it } from "vitest";
import {
  OpfsFs,
  type OpfsDirectoryHandle,
  type OpfsFileHandle,
  type OpfsFileLike,
  type OpfsSyncAccessHandle,
  type OpfsWritable,
} from "../src/opfs-fs.js";

class FakeFile implements OpfsFileHandle {
  readonly kind = "file" as const;
  data = new Uint8Array(0);
  lastModified = 1_700_000_000_000;
  syncCalls = 0;
  constructor(
    readonly name: string,
    private readonly sync: "ok" | "throws" | "absent" = "absent",
  ) {
    if (sync === "absent") delete (this as { createSyncAccessHandle?: unknown }).createSyncAccessHandle;
  }
  async getFile(): Promise<OpfsFileLike> {
    const data = this.data;
    const lastModified = this.lastModified;
    return { size: data.byteLength, lastModified, arrayBuffer: async () => data.slice().buffer };
  }
  async createWritable(): Promise<OpfsWritable> {
    return {
      write: async (d: Uint8Array) => {
        this.data = d.slice();
      },
      close: async () => {},
    };
  }
  createSyncAccessHandle = async (): Promise<OpfsSyncAccessHandle> => {
    this.syncCalls++;
    if (this.sync !== "ok") throw new Error("not in a worker");
    return {
      read: (buf: Uint8Array) => {
        buf.set(this.data.subarray(0, buf.byteLength));
        return Math.min(buf.byteLength, this.data.byteLength);
      },
      write: (buf: Uint8Array) => {
        this.data = buf.slice();
        return buf.byteLength;
      },
      truncate: (size: number) => {
        this.data = this.data.slice(0, size);
      },
      getSize: () => this.data.byteLength,
      flush: () => {},
      close: () => {},
    };
  };
}

class FakeDir implements OpfsDirectoryHandle {
  readonly kind = "directory" as const;
  entries = new Map<string, FakeDir | FakeFile>();
  constructor(
    readonly name: string,
    private readonly sync: "ok" | "throws" | "absent" = "absent",
  ) {}
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle> {
    const found = this.entries.get(name);
    if (found instanceof FakeFile) return found;
    if (found) throw new Error("TypeMismatchError");
    if (!opts?.create) throw new Error("NotFoundError");
    const file = new FakeFile(name, this.sync);
    this.entries.set(name, file);
    return file;
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsDirectoryHandle> {
    const found = this.entries.get(name);
    if (found instanceof FakeDir) return found;
    if (found) throw new Error("TypeMismatchError");
    if (!opts?.create) throw new Error("NotFoundError");
    const dir = new FakeDir(name, this.sync);
    this.entries.set(name, dir);
    return dir;
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.entries.delete(name)) throw new Error("NotFoundError");
  }
  async *values(): AsyncIterable<OpfsFileHandle | OpfsDirectoryHandle> {
    for (const v of this.entries.values()) yield v;
  }
}

describe("OpfsFs", () => {
  it("writes and reads through the async API when there is no sync handle", async () => {
    const fs = new OpfsFs(new FakeDir("root"));
    await fs.writeFile("workspace/AGENTS.md", "rules");
    expect(await fs.readText("workspace/AGENTS.md")).toBe("rules");
    expect((await fs.stat("workspace/AGENTS.md"))?.size).toBe(5);
    expect((await fs.stat("workspace"))?.kind).toBe("dir");
    expect(await fs.stat("workspace/missing.md")).toBeNull();
    expect((await fs.stat(""))?.kind).toBe("dir");
  });

  it("uses the sync access handle when one is available", async () => {
    const root = new FakeDir("root", "ok");
    const fs = new OpfsFs(root);
    await fs.writeFile("a.bin", new Uint8Array([7, 8, 9]));
    expect([...(await fs.readFile("a.bin"))]).toEqual([7, 8, 9]);
    expect((root.entries.get("a.bin") as FakeFile).syncCalls).toBe(2);
  });

  it("falls back to the async API when the sync handle refuses", async () => {
    const root = new FakeDir("root", "throws");
    const fs = new OpfsFs(root, {});
    await fs.writeFile("a.bin", new Uint8Array([1, 2]));
    expect([...(await fs.readFile("a.bin"))]).toEqual([1, 2]);
    expect((root.entries.get("a.bin") as FakeFile).syncCalls).toBe(2);
  });

  it("skips the sync path entirely when told to", async () => {
    const root = new FakeDir("root", "ok");
    const fs = new OpfsFs(root, { sync: false });
    await fs.writeFile("a.bin", new Uint8Array([3]));
    expect((root.entries.get("a.bin") as FakeFile).syncCalls).toBe(0);
  });

  it("lists, walks, removes and renames", async () => {
    const fs = new OpfsFs(new FakeDir("root"));
    await fs.writeFile("workspace/memory/a.md", "a");
    await fs.writeFile("workspace/memory/b.md", "b");
    await fs.mkdir("workspace/projects");
    expect((await fs.readdir("workspace")).map((e) => `${e.name}:${e.kind}`).sort()).toEqual([
      "memory:dir",
      "projects:dir",
    ]);
    const walked: string[] = [];
    for await (const e of fs.walk("")) walked.push(e.path);
    expect(walked).toEqual(["workspace/memory/a.md", "workspace/memory/b.md"]);
    await fs.rename("workspace/memory", "workspace/notes");
    expect(await fs.readText("workspace/notes/b.md")).toBe("b");
    expect(await fs.stat("workspace/memory")).toBeNull();
    await fs.rename("workspace/notes/a.md", "workspace/a.md");
    expect(await fs.readText("workspace/a.md")).toBe("a");
    await fs.remove("workspace/notes");
    expect(await fs.stat("workspace/notes")).toBeNull();
    await fs.remove("workspace/gone");
    await fs.remove("nowhere/at/all");
  });

  it("refuses a path that escapes, and reports a missing directory", async () => {
    const fs = new OpfsFs(new FakeDir("root"));
    await expect(fs.readFile("../escape")).rejects.toThrow(/invalid path/);
    await expect(fs.readFile("missing.txt")).rejects.toThrow(/ENOENT/);
    await expect(fs.readdir("nope")).rejects.toThrow(/ENOENT/);
    await expect(fs.rename("nope", "other")).rejects.toThrow(/ENOENT/);
  });

  it("mounts at agents/<id> off a storage manager", async () => {
    const root = new FakeDir("opfs");
    const fs = await OpfsFs.atAgentRoot({ getDirectory: async () => root }, "agent-1");
    await fs.writeFile("profile.json", "{}");
    const agents = root.entries.get("agents") as FakeDir;
    const agent = agents.entries.get("agent-1") as FakeDir;
    expect(agent.entries.has("profile.json")).toBe(true);
  });
});
