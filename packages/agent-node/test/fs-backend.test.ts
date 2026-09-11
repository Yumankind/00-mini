import { describe, expect, it } from "vitest";
import { MemoryFs } from "@00/agent-fs";
import { NodeFsBackend } from "../src/fs/backend.js";
import { fsModule, makeStats } from "../src/modules/fs.js";
import { memoryBackend, text } from "./helpers.js";

const encoder = new TextEncoder();

describe("NodeFsBackend", () => {
  it("maps the virtual root onto the agent-relative folder and refuses to climb out of it", async () => {
    const { fs, backend } = await memoryBackend({ "/a.txt": "one" });
    expect(backend.agentPath("/a.txt")).toBe("workspace/a.txt");
    // `..` is COLLAPSED, as Node's path.resolve does, so the worst a climb reaches is the root.
    expect(backend.agentPath("/../../../etc/passwd")).toBe("workspace/etc/passwd");
    expect(text(await backend.readFile("/a.txt")).valueOf()).toBe("one");
    expect(await fs.readText("workspace/a.txt")).toBe("one");
  });

  it("covers the whole operation map", async () => {
    const { backend } = await memoryBackend({ "/a.txt": "one", "/dir/b.txt": "two" });
    expect(text((await backend.op("readFile", { path: "/a.txt" }, null)).data)).toBe("one");
    await backend.op("writeFile", { path: "/c.txt" }, encoder.encode("three"));
    await backend.op("appendFile", { path: "/c.txt" }, encoder.encode("!"));
    await backend.op("appendFile", { path: "/new.txt" }, encoder.encode("fresh"));
    expect(text((await backend.op("readFile", { path: "/c.txt" }, null)).data)).toBe("three!");
    expect(text((await backend.op("readFile", { path: "/new.txt" }, null)).data)).toBe("fresh");

    await backend.op("mkdir", { path: "/deep/er", recursive: true }, null);
    await backend.op("mkdir", { path: "/deep/er", recursive: true }, null); // idempotent when recursive
    await expect(backend.op("mkdir", { path: "/deep/er" }, null)).rejects.toThrow(/EEXIST/);
    await expect(backend.op("mkdir", { path: "/missing/child" }, null)).rejects.toThrow(/ENOENT/);
    await expect(backend.op("mkdir", { path: "/a.txt/child" }, null)).rejects.toThrow(/ENOTDIR|ENOENT/);
    await backend.op("mkdir", { path: "/plain" }, null);

    expect((await backend.op("readdir", { path: "/dir" }, null)).value).toEqual([{ name: "b.txt", kind: "file" }]);
    expect((await backend.op("stat", { path: "/dir" }, null)).value).toMatchObject({ kind: "dir" });
    expect((await backend.op("lstat", { path: "/a.txt" }, null)).value).toMatchObject({ kind: "file", size: 3 });
    expect((await backend.op("exists", { path: "/nope" }, null)).value).toBe(false);
    expect((await backend.op("realpath", { path: "/dir/../a.txt" }, null)).value).toBe("/a.txt");
    await backend.op("access", { path: "/a.txt" }, null);
    await expect(backend.op("access", { path: "/nope" }, null)).rejects.toThrow(/ENOENT/);

    await backend.op("copyFile", { path: "/a.txt", to: "/copy.txt" }, null);
    expect(text((await backend.op("readFile", { path: "/copy.txt" }, null)).data)).toBe("one");
    await backend.op("rename", { path: "/copy.txt", to: "/moved.txt" }, null);
    await expect(backend.op("rename", { path: "/gone.txt", to: "/x" }, null)).rejects.toThrow(/ENOENT/);

    await backend.op("truncate", { path: "/moved.txt", len: 2 }, null);
    expect(text((await backend.op("readFile", { path: "/moved.txt" }, null)).data)).toBe("on");
    await backend.op("truncate", { path: "/moved.txt", len: 5 }, null);
    expect((await backend.op("stat", { path: "/moved.txt" }, null)).value).toMatchObject({ size: 5 });
    await expect(backend.op("truncate", { path: "/gone" }, null)).rejects.toThrow(/ENOENT/);

    await backend.op("unlink", { path: "/moved.txt" }, null);
    await expect(backend.op("unlink", { path: "/moved.txt" }, null)).rejects.toThrow(/ENOENT/);
    await expect(backend.op("unlink", { path: "/dir" }, null)).rejects.toThrow(/EISDIR/);
    await expect(backend.op("rmdir", { path: "/a.txt" }, null)).rejects.toThrow(/ENOTDIR/);
    await expect(backend.op("rmdir", { path: "/gone" }, null)).rejects.toThrow(/ENOENT/);
    await backend.op("rmdir", { path: "/plain" }, null);
    await expect(backend.op("rm", { path: "/dir" }, null)).rejects.toThrow(/is a directory/);
    await backend.op("rm", { path: "/dir", recursive: true }, null);
    await backend.op("rm", { path: "/dir", force: true }, null);
    await expect(backend.op("rm", { path: "/dir" }, null)).rejects.toThrow(/ENOENT/);

    for (const name of ["chmod", "chown", "utimes", "lutimes"]) {
      expect(await backend.op(name, { path: "/a.txt" }, null)).toEqual({});
    }
    for (const name of ["symlink", "readlink", "link"]) {
      await expect(backend.op(name, { path: "/a.txt", to: "/b" }, null)).rejects.toThrow(/no symbolic links/);
    }
    await expect(backend.op("teleport", { path: "/a" }, null)).rejects.toThrow(/not one of the operations/);
    await expect(backend.op("readFile", { path: "/" }, null)).rejects.toThrow(/EISDIR/);
    await expect(backend.op("readFile", { path: "/gone" }, null)).rejects.toThrow(/ENOENT/);
  });

  it("has the small helpers the layers above lean on", async () => {
    const { backend } = await memoryBackend();
    await backend.mkdirp("/x/y");
    await backend.writeFile("/x/y/z.txt", "hello");
    expect(text(await backend.readFile("/x/y/z.txt"))).toBe("hello");
    expect(await backend.statOrNull("/x/y/z.txt")).toMatchObject({ kind: "file", size: 5 });
    expect(await backend.statOrNull("/nope")).toBeNull();
    expect(backend.hasSync).toBe(false);
  });

  it("`call` is the same map, which is what the sync channel serves", async () => {
    const { backend } = await memoryBackend({ "/a.txt": "one" });
    expect(text((await backend.call("readFile", { path: "/a.txt" }, null)).data)).toBe("one");
  });

  it("defaults the root to the agent root when none is given", async () => {
    const fs = new MemoryFs();
    const backend = new NodeFsBackend({ fs });
    await backend.writeFile("/top.txt", "x");
    expect(await fs.readText("top.txt")).toBe("x");
  });
});

describe("the fs module's three faces", () => {
  it("promises: reads, writes, dirents and stats", async () => {
    const { backend } = await memoryBackend({ "/a.txt": "one", "/dir/b.txt": "two" });
    const { fs, promises } = fsModule(backend);
    const api = promises as Record<string, (...a: never[]) => Promise<unknown>>;
    expect(await api.readFile("/a.txt" as never, "utf8" as never)).toBe("one");
    expect(await api.readFile("/a.txt" as never)).toBeInstanceOf(Uint8Array);
    expect(await api.readFile("/a.txt" as never, { encoding: "utf8" } as never)).toBe("one");
    expect(await api.readFile("/a.txt" as never, "hex" as never)).toBe("6f6e65");
    expect(await api.readFile("/a.txt" as never, "buffer" as never)).toBeInstanceOf(Uint8Array);

    await api.writeFile("/w.txt" as never, "written" as never);
    await api.appendFile("/w.txt" as never, "!" as never);
    expect(await api.readFile("/w.txt" as never, "utf8" as never)).toBe("written!");

    expect(await api.mkdir("/m/n" as never, { recursive: true } as never)).toBe("/m/n");
    expect(await api.mkdir("/single" as never)).toBeUndefined();
    expect(await api.readdir("/dir" as never)).toEqual(["b.txt"]);
    const dirents = (await api.readdir("/dir" as never, { withFileTypes: true } as never)) as { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }[];
    expect(dirents[0]?.name).toBe("b.txt");
    expect(dirents[0]?.isFile()).toBe(true);
    expect(dirents[0]?.isDirectory()).toBe(false);
    expect(dirents[0]?.isSymbolicLink()).toBe(false);

    const stat = (await api.stat("/a.txt" as never)) as { isFile(): boolean; size: number; mtime: Date };
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(3);
    expect(stat.mtime).toBeInstanceOf(Date);
    expect(((await api.lstat("/dir" as never)) as { isDirectory(): boolean }).isDirectory()).toBe(true);

    await api.copyFile("/a.txt" as never, "/copied.txt" as never);
    await api.rename("/copied.txt" as never, "/renamed.txt" as never);
    await api.truncate("/renamed.txt" as never, 1 as never);
    expect(await api.realpath("/dir/../a.txt" as never)).toBe("/a.txt");
    await api.access("/a.txt" as never);
    await api.unlink("/renamed.txt" as never);
    await api.mkdir("/empty" as never);
    await api.rmdir("/empty" as never);
    await api.rm("/dir" as never, { recursive: true } as never);
    expect(await api.chmod()).toBeUndefined();
    expect(await api.chown()).toBeUndefined();
    expect(await api.utimes()).toBeUndefined();
    await expect(api.symlink("/a" as never, "/b" as never)).rejects.toThrow(/no symbolic links/);
    await expect(api.readlink("/a.txt" as never)).rejects.toThrow(/no symbolic links/);
    expect((fs as { promises: unknown }).promises).toBe(promises);
  });

  it("promises.cp copies a file and a whole tree, and says so when it needs recursive", async () => {
    const { backend } = await memoryBackend({ "/src/a.txt": "a", "/src/deep/b.txt": "b" });
    const { promises } = fsModule(backend);
    const api = promises as Record<string, (...a: never[]) => Promise<unknown>>;
    await api.cp("/src/a.txt" as never, "/one.txt" as never);
    expect(await api.readFile("/one.txt" as never, "utf8" as never)).toBe("a");
    await expect(api.cp("/src" as never, "/copy" as never)).rejects.toThrow(/recursive/);
    await api.cp("/src" as never, "/copy" as never, { recursive: true } as never);
    expect(await api.readFile("/copy/deep/b.txt" as never, "utf8" as never)).toBe("b");
  });

  it("callbacks: the (err, value) shape, including exists' error-less one", async () => {
    const { backend } = await memoryBackend({ "/a.txt": "one" });
    const { fs } = fsModule(backend);
    const api = fs as Record<string, (...a: unknown[]) => void>;
    const read = await new Promise<string>((resolve) => api.readFile("/a.txt", "utf8", (_e: unknown, v: unknown) => resolve(v as string)));
    expect(read).toBe("one");
    const failed = await new Promise<unknown>((resolve) => api.readFile("/gone", (e: unknown) => resolve(e)));
    expect((failed as { code: string }).code).toBe("ENOENT");
    expect(await new Promise((resolve) => api.exists("/a.txt", resolve))).toBe(true);
    expect(await new Promise((resolve) => api.exists("/gone", resolve))).toBe(false);
    await new Promise<void>((resolve) => api.writeFile("/b.txt", "x", () => resolve()));
    expect(await new Promise((resolve) => api.readFile("/b.txt", "utf8", (_e: unknown, v: unknown) => resolve(v)))).toBe("x");
  });

  it("sync: every one of them refuses with the isolation sentence when there is no channel", async () => {
    const { backend } = await memoryBackend({ "/a.txt": "one" });
    const { fs } = fsModule(backend);
    const api = fs as Record<string, (...a: unknown[]) => unknown>;
    const names = [
      "readFileSync",
      "writeFileSync",
      "appendFileSync",
      "mkdirSync",
      "readdirSync",
      "statSync",
      "lstatSync",
      "existsSync",
      "accessSync",
      "unlinkSync",
      "rmdirSync",
      "rmSync",
      "renameSync",
      "copyFileSync",
      "truncateSync",
      "realpathSync",
    ];
    for (const name of names) {
      expect(() => api[name]!("/a.txt", "x"), name).toThrow(/cross-origin isolation/);
    }
    expect(api.chmodSync!()).toBeUndefined();
    expect(api.chownSync!()).toBeUndefined();
    expect(api.utimesSync!()).toBeUndefined();
  });

  it("names what it does not have: descriptors, watching, and a constructible Stats", async () => {
    const { backend } = await memoryBackend();
    const { fs } = fsModule(backend);
    const api = fs as Record<string, (...a: unknown[]) => unknown>;
    expect(() => api.open!()).toThrow(/no file descriptors/);
    expect(() => api.openSync!()).toThrow(/no file descriptors/);
    expect(() => api.watch!()).toThrow(/file_changed/);
    expect(() => api.watchFile!()).toThrow(/file_changed/);
    expect(() => (api.Stats as unknown as () => unknown)()).toThrow(/not a constructor/);
    expect((api.constants as unknown as { F_OK: number }).F_OK).toBe(0);
  });

  it("the streams read and write whole files, which is what their header promises", async () => {
    const { backend } = await memoryBackend({ "/a.txt": "streamed" });
    const { fs } = fsModule(backend);
    const api = fs as Record<string, (...a: unknown[]) => { on(n: string, f: (v?: unknown) => void): unknown; write?(c: unknown): void; end?(): void }>;
    const read = api.createReadStream!("/a.txt");
    const chunks: Uint8Array[] = [];
    await new Promise<void>((resolve) => {
      read.on("data", (c) => chunks.push(c as Uint8Array));
      read.on("end", () => resolve());
    });
    expect(text(chunks[0])).toBe("streamed");

    const write = api.createWriteStream!("/out.txt");
    write.write!("half ");
    write.write!(new TextEncoder().encode("and half"));
    await new Promise<void>((resolve) => {
      write.on("finish", () => resolve());
      write.end!();
    });
    expect(text(await backend.readFile("/out.txt"))).toBe("half and half");

    const missing = api.createReadStream!("/gone.txt");
    const error = await new Promise<unknown>((resolve) => missing.on("error", resolve));
    expect((error as { code: string }).code).toBe("ENOENT");
  });

  it("makeStats answers every kind question a script asks", () => {
    const stats = makeStats({ size: 4, mtimeMs: 1000, kind: "file" }, "/a") as Record<string, () => boolean> & { blocks: number; mode: number };
    expect(stats.isFile()).toBe(true);
    expect(stats.isDirectory()).toBe(false);
    expect(stats.isBlockDevice()).toBe(false);
    expect(stats.isCharacterDevice()).toBe(false);
    expect(stats.isFIFO()).toBe(false);
    expect(stats.isSocket()).toBe(false);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.blocks).toBe(1);
    expect(makeStats({ size: 0, mtimeMs: 0, kind: "dir" }, "/d").mode).toBe(0o040755);
  });
});
