/**
 * The filesystem service Worker's body, driven against a fake OPFS.
 *
 * WHY A FAKE AND NOT A BROWSER. The File System Access API is the one thing node has none of, so the
 * trick here is the one `packages/agent-fs/test/opfs-fs.test.ts` plays on `OpfsFs`: the service only
 * ever calls six methods on a handle, and a pair of in-memory objects implementing those six is
 * enough to run the REAL body — the real path resolution, the real sync-access fast path, the real
 * fallbacks, the real sentences. What a browser adds is that the handles are the browser's, which is
 * the live check recorded in apps/infinite-site/README.md and not something node can stand in for.
 *
 * BOTH PATHS ARE RUN. Every read and write is tried through `createSyncAccessHandle` first and falls
 * back when that is missing or throws (a second handle open on the same file is the real case), so
 * the suite runs the whole set twice: once with a fake that offers sync handles and once with one
 * that does not.
 */
import { describe, expect, it } from "vitest";
import { fsServiceMain } from "../src/power/fs-service.js";
import type { SyncRequest, SyncResponse } from "../src/power/sync-channel.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Node {
  kind: "directory" | "file";
  name: string;
  children?: Map<string, Node>;
  bytes?: Uint8Array;
}

const dir = (name: string): Node => ({ kind: "directory", name, children: new Map() });

function notFound(name: string): Error {
  const err = new Error(`NotFoundError: ${name}`);
  err.name = "NotFoundError";
  return err;
}

/** The six methods the service calls, over a tree of plain objects. */
function handles(node: Node, sync: boolean): Record<string, unknown> {
  if (node.kind === "file") {
    const fileHandle: Record<string, unknown> = {
      kind: "file",
      name: node.name,
      getFile: async () => ({
        size: node.bytes!.byteLength,
        lastModified: 1_700_000_000_000,
        arrayBuffer: async () => node.bytes!.slice().buffer,
      }),
      createWritable: async () => {
        const parts: Uint8Array[] = [];
        return {
          write: async (data: Uint8Array) => void parts.push(data),
          close: async () => {
            let total = 0;
            for (const part of parts) total += part.byteLength;
            const out = new Uint8Array(total);
            let at = 0;
            for (const part of parts) {
              out.set(part, at);
              at += part.byteLength;
            }
            node.bytes = out;
          },
        };
      },
    };
    if (sync) {
      fileHandle.createSyncAccessHandle = async () => ({
        getSize: () => node.bytes!.byteLength,
        read: (buffer: Uint8Array, opts?: { at?: number }) => {
          const at = opts?.at ?? 0;
          const slice = node.bytes!.subarray(at, at + buffer.byteLength);
          buffer.set(slice, 0);
          return slice.byteLength;
        },
        write: (buffer: Uint8Array, opts?: { at?: number }) => {
          const at = opts?.at ?? 0;
          const next = new Uint8Array(Math.max(node.bytes!.byteLength, at + buffer.byteLength));
          next.set(node.bytes!, 0);
          next.set(buffer, at);
          node.bytes = next;
          return buffer.byteLength;
        },
        truncate: (size: number) => {
          node.bytes = node.bytes!.slice(0, size);
        },
        flush: () => undefined,
        close: () => undefined,
      });
    }
    return fileHandle;
  }
  return {
    kind: "directory",
    name: node.name,
    getDirectoryHandle: async (name: string, opts?: { create?: boolean }) => {
      let child = node.children!.get(name);
      if (!child) {
        if (!opts?.create) throw notFound(name);
        child = dir(name);
        node.children!.set(name, child);
      }
      if (child.kind !== "directory") throw new Error("TypeMismatchError");
      return handles(child, sync);
    },
    getFileHandle: async (name: string, opts?: { create?: boolean }) => {
      let child = node.children!.get(name);
      if (!child) {
        if (!opts?.create) throw notFound(name);
        child = { kind: "file", name, bytes: new Uint8Array(0) };
        node.children!.set(name, child);
      }
      if (child.kind !== "file") throw new Error("TypeMismatchError");
      return handles(child, sync);
    },
    removeEntry: async (name: string) => {
      if (!node.children!.delete(name)) throw notFound(name);
    },
    values: async function* () {
      for (const child of [...node.children!.values()]) yield handles(child, sync);
    },
  };
}

/** An OPFS root laid out the way bootstrap.ts lays it out: `agents/<id>/workspace/…`. */
function opfs(agentIds: string[], seed: Record<string, string> = {}): Node {
  const root = dir("");
  const agents = dir("agents");
  root.children!.set("agents", agents);
  for (const id of agentIds) {
    const agent = dir(id);
    agent.children!.set("workspace", dir("workspace"));
    agents.children!.set(id, agent);
  }
  const workspace = agents.children!.get(agentIds[0] ?? "")?.children!.get("workspace");
  for (const [path, text] of Object.entries(seed)) {
    let cursor = workspace!;
    const segments = path.split("/").filter(Boolean);
    for (const segment of segments.slice(0, -1)) {
      if (!cursor.children!.has(segment)) cursor.children!.set(segment, dir(segment));
      cursor = cursor.children!.get(segment)!;
    }
    cursor.children!.set(segments[segments.length - 1]!, {
      kind: "file",
      name: segments[segments.length - 1]!,
      bytes: encoder.encode(text),
    });
  }
  return root;
}

interface Service {
  ask(op: string, args?: Record<string, unknown>, data?: Uint8Array): Promise<SyncResponse>;
  replies: { t?: string; ok?: boolean; agentId?: string; error?: string }[];
  root: Node;
}

/** Boot the real service body over the fake tree and hand back the op handler it serves with. */
async function service(root: Node, sync: boolean, agentId = ""): Promise<Service> {
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  const replies: Service["replies"] = [];
  let answer: ((request: SyncRequest) => Promise<SyncResponse>) | undefined;
  const scope = {
    navigator: { storage: { getDirectory: async () => handles(root, sync) } },
    addEventListener: (type: string, handler: (event: { data: unknown }) => void) => {
      if (type === "message") onMessage = handler;
    },
    postMessage: (message: unknown) => void replies.push(message as Service["replies"][number]),
    __00SyncChannel: (_sab: unknown, _layout: unknown, _role: string, handler: typeof answer) => {
      answer = handler;
      return { serve: async () => undefined };
    },
    __00SyncChannelLayout: {},
  };
  fsServiceMain(scope as unknown as Parameters<typeof fsServiceMain>[0]);
  onMessage!({ data: { t: "open", agentId, filesRoot: "workspace" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  onMessage!({ data: { t: "serve", sab: new SharedArrayBuffer(64) } });
  return {
    replies,
    root,
    ask: async (op, args = {}, data) => (answer ? await answer({ op, args, data }) : { ok: false, error: "no handler" }),
  };
}

for (const sync of [true, false]) {
  describe(`the filesystem service (${sync ? "with" : "without"} sync access handles)`, () => {
    it("finds the one agent in this browser without being told which", async () => {
      const svc = await service(opfs(["agent-one"]), sync);
      expect(svc.replies[0]).toMatchObject({ t: "open-reply", ok: true, agentId: "agent-one" });
    });

    it("reads and writes, and an append lands after what was there", async () => {
      const svc = await service(opfs(["a"], { "notes/todo.md": "first" }), sync);
      expect(decoder.decode((await svc.ask("readFile", { path: "/notes/todo.md" })).data!)).toBe("first");
      expect((await svc.ask("writeFile", { path: "/notes/todo.md" }, encoder.encode("second"))).ok).toBe(true);
      await svc.ask("appendFile", { path: "/notes/todo.md" }, encoder.encode("-third"));
      expect(decoder.decode((await svc.ask("readFile", { path: "/notes/todo.md" })).data!)).toBe("second-third");
      // A write to a path whose folders do not exist yet makes them, as `fs.writeFileSync` does not —
      // but as every script that writes into a project folder expects.
      await svc.ask("writeFile", { path: "/deep/er/still.txt" }, encoder.encode("ok"));
      expect(decoder.decode((await svc.ask("readFile", { path: "/deep/er/still.txt" })).data!)).toBe("ok");
    });

    it("truncates on write rather than leaving the tail of a longer file", async () => {
      const svc = await service(opfs(["a"], { "x.txt": "a very long line indeed" }), sync);
      await svc.ask("writeFile", { path: "/x.txt" }, encoder.encode("short"));
      expect(decoder.decode((await svc.ask("readFile", { path: "/x.txt" })).data!)).toBe("short");
    });

    it("stats, lists and answers exists for both a file and a folder", async () => {
      const svc = await service(opfs(["a"], { "src/one.js": "1", "src/two.js": "22" }), sync);
      // The shapes are `NodeFsBackend`'s, because this service is the far end of its sync face:
      // a `kind` rather than two booleans, and dirents rather than names.
      const file = (await svc.ask("stat", { path: "/src/two.js" })).value as { size: number; kind: string };
      expect(file).toMatchObject({ size: 2, kind: "file" });
      expect((await svc.ask("stat", { path: "/src" })).value).toMatchObject({ kind: "dir" });
      expect((await svc.ask("readdir", { path: "/src" })).value).toEqual([
        { name: "one.js", kind: "file" },
        { name: "two.js", kind: "file" },
      ]);
      expect((await svc.ask("readdir", { path: "/" })).value).toEqual([{ name: "src", kind: "dir" }]);
      expect((await svc.ask("exists", { path: "/src/one.js" })).value).toBe(true);
      expect((await svc.ask("exists", { path: "/src" })).value).toBe(true);
      expect((await svc.ask("exists", { path: "/nope" })).value).toBe(false);
    });

    it("says ENOENT in the sentence the async RPC says it in", async () => {
      const svc = await service(opfs(["a"]), sync);
      expect((await svc.ask("readFile", { path: "/nope.txt" })).error).toBe(
        "ENOENT: no such file or directory, open '/nope.txt'",
      );
      expect((await svc.ask("stat", { path: "/nope" })).error).toContain("ENOENT");
      expect((await svc.ask("readdir", { path: "/nope" })).error).toContain("ENOENT");
      expect((await svc.ask("fchmod", { path: "/x" })).error).toContain("not one of the operations");
      // `chmod` is accepted and ignored, exactly as NodeFsBackend accepts it: a tarball sets a mode
      // on every file it writes, and refusing would fail an install over something OPFS cannot hold.
      expect((await svc.ask("chmod", { path: "/x" })).ok).toBe(true);
    });

    it("removes a file, a folder, and something that was already gone", async () => {
      const svc = await service(opfs(["a"], { "junk/one.txt": "1" }), sync);
      expect((await svc.ask("unlink", { path: "/junk/one.txt" })).ok).toBe(true);
      expect((await svc.ask("unlink", { path: "/junk/one.txt" })).ok).toBe(true); // already gone is not an error
      expect((await svc.ask("rm", { path: "/junk" })).ok).toBe(true);
      expect((await svc.ask("exists", { path: "/junk" })).value).toBe(false);
      expect((await svc.ask("rm", { path: "/" })).error).toContain("cannot be removed");
    });

    it("renames a file and a whole folder", async () => {
      const svc = await service(opfs(["a"], { "old.txt": "keep", "kit/a/deep.js": "x" }), sync);
      expect((await svc.ask("rename", { path: "/old.txt", to: "/new.txt" })).ok).toBe(true);
      expect(decoder.decode((await svc.ask("readFile", { path: "/new.txt" })).data!)).toBe("keep");
      expect((await svc.ask("exists", { path: "/old.txt" })).value).toBe(false);

      expect((await svc.ask("rename", { path: "/kit", to: "/tools" })).ok).toBe(true);
      expect(decoder.decode((await svc.ask("readFile", { path: "/tools/a/deep.js" })).data!)).toBe("x");
      expect((await svc.ask("exists", { path: "/kit" })).value).toBe(false);
      expect((await svc.ask("rename", { path: "/gone", to: "/wherever" })).error).toContain("ENOENT");
    });

    it("cannot be walked out of the workspace, because the walk starts inside it", async () => {
      // `..` pops with a floor at the workspace handle. There is no path a script can type that
      // reaches `agents/<id>/vault.json`, and this is why: the service never holds a handle above it.
      const svc = await service(opfs(["a"], { "inside.txt": "safe" }), sync);
      expect(decoder.decode((await svc.ask("readFile", { path: "/../../inside.txt" })).data!)).toBe("safe");
      expect((await svc.ask("readFile", { path: "/../vault.json" })).error).toContain("open '/vault.json'");
      await svc.ask("writeFile", { path: "/../../escaped.txt" }, encoder.encode("no"));
      const workspace = svc.root.children!.get("agents")!.children!.get("a")!.children!.get("workspace")!;
      expect([...workspace.children!.keys()]).toContain("escaped.txt");
      expect([...svc.root.children!.keys()]).toEqual(["agents"]);
    });

    it("mkdir makes the whole chain and says so", async () => {
      const svc = await service(opfs(["a"]), sync);
      expect((await svc.ask("mkdir", { path: "/one/two/three" })).ok).toBe(true);
      expect((await svc.ask("stat", { path: "/one/two/three" })).value).toMatchObject({ kind: "dir" });
    });
  });
}

describe("the filesystem service, when it cannot open a workspace", () => {
  it("names the browser with no agent yet", async () => {
    const svc = await service(opfs([]), true);
    expect(svc.replies[0]).toMatchObject({ t: "open-reply", ok: false });
    expect(String(svc.replies[0]!.error)).toContain("no agent folder yet");
  });

  it("refuses to guess between two agents", async () => {
    const svc = await service(opfs(["one", "two"]), true);
    expect(String(svc.replies[0]!.error)).toContain("more than one agent");
  });

  it("opens the one it was told about when there are several", async () => {
    const svc = await service(opfs(["one", "two"]), true, "two");
    expect(svc.replies[0]).toMatchObject({ ok: true, agentId: "two" });
  });

  it("says so rather than throwing on a browser with no OPFS", async () => {
    let onMessage: ((event: { data: unknown }) => void) | undefined;
    const replies: { error?: string }[] = [];
    fsServiceMain({
      navigator: {},
      addEventListener: (type: string, handler: (event: { data: unknown }) => void) => {
        if (type === "message") onMessage = handler;
      },
      postMessage: (message: unknown) => void replies.push(message as { error?: string }),
    } as unknown as Parameters<typeof fsServiceMain>[0]);
    onMessage!({ data: { t: "open" } });
    onMessage!({ data: { t: "nonsense" } });
    onMessage!({ data: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(String(replies[0]!.error)).toContain("no OPFS");
  });

  it("answers every op with one sentence while no workspace is open", async () => {
    let onMessage: ((event: { data: unknown }) => void) | undefined;
    let answer: ((request: SyncRequest) => Promise<SyncResponse>) | undefined;
    fsServiceMain({
      addEventListener: (type: string, handler: (event: { data: unknown }) => void) => {
        if (type === "message") onMessage = handler;
      },
      postMessage: () => undefined,
      __00SyncChannel: (_s: unknown, _l: unknown, _r: string, handler: typeof answer) => {
        answer = handler;
        return { serve: async () => undefined };
      },
    } as unknown as Parameters<typeof fsServiceMain>[0]);
    onMessage!({ data: { t: "serve", sab: new SharedArrayBuffer(64) } });
    expect((await answer!({ op: "readFile", args: { path: "/x" } })).error).toContain("no workspace open");
  });
});
