/**
 * The Worker half on its own: the pieces `serveNodeProcess` wires, tested where they are decided.
 *
 * The end-to-end road (a script, a require, a port) is test/js-runner.test.ts and
 * test/sync-fs.test.ts, which run this same module through the real process wire. What is here is
 * the four decisions that have a branch in them and would otherwise only be exercised by accident:
 * which synchronous filesystem the loader gets, what a `#!` line does to the CommonJS wrapper, what
 * `node -e`'s file is, and which hosts the outbound door opens for.
 */
import { describe, expect, it } from "vitest";
import { MemoryFs } from "@00/agent-fs";
import { NodeFsBackend, snapshotLoaderFs } from "@00/agent-node";
import { evalOverlay, guardedNetwork, remoteAgentFs, shebangSafe } from "../src/power/node-runtime-worker.js";
import { answerFs } from "../src/power/js-runner.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The two halves of the RPC, joined without a worker: the Worker's `op` straight into the page's. */
function joined(fs: MemoryFs, cwd = "/projects/site"): (op: string, args: Record<string, unknown>, data?: Uint8Array | null) => Promise<{ value?: unknown; data?: Uint8Array }> {
  return async (op, args, data) => {
    let reply: Record<string, unknown> = {};
    await answerFs(fs, cwd, { id: 1, op, args, data }, (message) => (reply = message as Record<string, unknown>));
    if (!reply.ok) {
      const err = new Error(String(reply.error)) as Error & { code?: string };
      err.code = reply.code as string | undefined;
      throw err;
    }
    return { value: reply.value, data: reply.data as Uint8Array | undefined };
  };
}

describe("the filesystem the Worker sees", () => {
  it("is an AgentFs whose every call is the page doing the work", async () => {
    const fs = new MemoryFs();
    await fs.mkdir("workspace/projects/site/lib");
    await fs.writeFile("workspace/projects/site/lib/a.js", "module.exports = 1;");
    const remote = remoteAgentFs(joined(fs));

    expect(await remote.stat("projects/site/lib/a.js")).toMatchObject({ kind: "file" });
    expect(await remote.stat("projects/site/nope.js")).toBeNull();
    expect(await remote.readText("projects/site/lib/a.js")).toBe("module.exports = 1;");
    expect((await remote.readdir("projects/site/lib")).map((e) => e.name)).toEqual(["a.js"]);

    await remote.writeFile("projects/site/made.txt", "by the worker");
    expect(await fs.readText("workspace/projects/site/made.txt")).toBe("by the worker");
    await remote.mkdir("projects/site/sub/deeper");
    expect(await fs.stat("workspace/projects/site/sub/deeper")).not.toBeNull();
    await remote.rename("projects/site/made.txt", "projects/site/moved.txt");
    expect(await fs.stat("workspace/projects/site/made.txt")).toBeNull();
    await remote.remove("projects/site/moved.txt");
    expect(await fs.stat("workspace/projects/site/moved.txt")).toBeNull();

    const walked: string[] = [];
    for await (const entry of remote.walk("/projects/site/lib")) walked.push(entry.path);
    expect(walked).toEqual(["projects/site/lib/a.js"]);
  });

  it("goes through a NodeFsBackend on both sides, so the sandbox is enforced where the files are", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("vault.json", '{"secret":true}');
    await fs.mkdir("workspace/projects/site");
    const backend = new NodeFsBackend({ fs: remoteAgentFs(joined(fs)), root: "", cwd: () => "/projects/site" });
    // The climb collapses at the workspace root — twice, once at each end.
    await expect(backend.readFile("../../../vault.json")).rejects.toThrow(/ENOENT/);
    await backend.writeFile("./here.txt", "safe");
    expect(await fs.readText("workspace/projects/site/here.txt")).toBe("safe");
    expect(backend.absolute("./here.txt")).toBe("/projects/site/here.txt");
    expect(backend.hasSync).toBe(false);
  });
});

describe("the loader's synchronous view", () => {
  it("drops a shebang, because a function body has no hashbang grammar", () => {
    const base = snapshotLoaderFs({
      "/bin/tool": encoder.encode("#!/usr/bin/env node\nmodule.exports = 'ran';\n"),
      "/plain.js": encoder.encode("module.exports = 1;\n"),
      "/only-shebang": encoder.encode("#!/usr/bin/env node"),
    });
    const safe = shebangSafe(base);
    expect(decoder.decode(safe.readFileSync("/bin/tool"))).toBe("\nmodule.exports = 'ran';\n");
    expect(decoder.decode(safe.readFileSync("/plain.js"))).toBe("module.exports = 1;\n");
    expect(decoder.decode(safe.readFileSync("/only-shebang"))).toBe("");
    expect(safe.statSync("/plain.js")?.isFile()).toBe(true);
    expect(safe.statSync("/nope")).toBeNull();
  });

  it("gives `node -e` a file to be, and leaves every other path to the real one", () => {
    const base = snapshotLoaderFs({ "/app.js": encoder.encode("module.exports = 'file';") });
    const overlaid = evalOverlay(base, "/[eval]", "console.log(1)");
    expect(decoder.decode(overlaid.readFileSync("/[eval]"))).toBe("console.log(1)");
    expect(overlaid.statSync("/[eval]")).toMatchObject({ isFile: expect.any(Function) });
    expect(overlaid.statSync("/[eval]")?.isFile()).toBe(true);
    expect(overlaid.statSync("/[eval]")?.isDirectory()).toBe(false);
    expect(decoder.decode(overlaid.readFileSync("/app.js"))).toBe("module.exports = 'file';");
    expect(overlaid.statSync("/nope")).toBeNull();
  });
});

describe("the outbound door", () => {
  it("opens for a host on the list and names the one that is not", async () => {
    const asked: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response("ok");
    }) as typeof globalThis.fetch;
    try {
      const open = guardedNetwork({ allow: ["example.com"] });
      expect(await (await open.fetch("https://api.example.com/x")).text()).toBe("ok");
      expect(asked).toEqual(["https://api.example.com/x"]);

      await expect(open.fetch("https://elsewhere.test/x")).rejects.toThrow(/elsewhere.test is not on this agent's network allow list/);
      // Nothing was sent: the refusal is before the fetch, not after it.
      expect(asked).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("denies everything when there is no list, and refuses the schemes that read this machine", async () => {
    const closed = guardedNetwork(null);
    await expect(closed.fetch("https://example.com")).rejects.toThrow(/not on this agent's network allow list/);
    await expect(closed.fetch("file:///etc/passwd")).rejects.toThrow(/only http and https leave this tab/);
    await expect(closed.fetch("/relative")).rejects.toThrow(/absolute http\(s\) URL/);
  });
});
