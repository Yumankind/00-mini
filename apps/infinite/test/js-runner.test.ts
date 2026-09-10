/**
 * `node` in a browser tab — the runner, its prelude, and the RPC between them.
 *
 * WHAT MAKES THESE REAL. `createEvalWorker` runs the SHIPPED prelude source (the same string a Blob
 * URL Worker would be built from) in this process, so a script here goes through the real
 * `require`, the real `process`, the real fs RPC and the real `http.createServer`. Only the thread
 * is missing. The one thing node cannot check is that a browser accepts the Blob and the Worker,
 * which is a manual check in a real browser (see the commit and the header of js-runner.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFs } from "@00/agent-fs";
import {
  EXIT_ABORTED,
  EXIT_TIMEOUT,
  agentPath,
  answerFs,
  createEvalWorker,
  runScript,
  snapshotFolder,
  virtualPath,
  workerSource,
} from "../src/power/js-runner.js";
import { handleVirtualRequest, listPorts, resetPorts, unregister } from "../src/power/virtual-ports.js";

let fs: MemoryFs;

async function seed(): Promise<void> {
  fs = new MemoryFs();
  await fs.mkdir("workspace/projects/site");
  await fs.writeFile("workspace/projects/site/package.json", JSON.stringify({ name: "site", scripts: { hello: "echo hi" } }));
  await fs.writeFile("workspace/projects/site/data.json", '{"who":"world"}');
  await fs.writeFile("workspace/projects/site/lib.js", "let calls = 0;\nmodule.exports = () => ++calls;\n");
  await fs.mkdir("workspace/projects/site/deep");
  await fs.writeFile("workspace/projects/site/deep/index.js", 'module.exports = "from index";\n');
  // Outside the workspace: the agent's own record, which no script may reach.
  await fs.writeFile("vault.json", '{"secret":true}');
}

beforeEach(seed);
afterEach(() => resetPorts());

interface Run {
  out: string;
  err: string;
  code: number;
  listening: number[];
}

async function run(code: string, opts: Parameters<typeof runScript>[1] = {}): Promise<Run> {
  let out = "";
  let err = "";
  const result = await runScript(fs, {
    code,
    cwd: "/projects/site",
    createWorker: createEvalWorker,
    onStdout: (t) => (out += t),
    onStderr: (t) => (err += t),
    ...opts,
  });
  return { out, err, code: result.exitCode, listening: result.listening };
}

describe("a script runs", () => {
  it("prints, and exits 0", async () => {
    const r = await run("console.log('hello', 1 + 1)");
    expect(r.out).toBe("hello 2\n");
    expect(r.code).toBe(0);
  });

  it("gets a Node-shaped process, and says out loud that it is a browser", async () => {
    const r = await run("console.log(JSON.stringify([process.argv.slice(2), process.platform, process.cwd(), process.env.NAME]))", {
      argv: ["a", "b"],
      env: { NAME: "bruno" },
    });
    expect(JSON.parse(r.out)).toEqual([["a", "b"], "browser", "/projects/site", "bruno"]);
  });

  it("writes to stdout and stderr separately", async () => {
    const r = await run("process.stdout.write('out'); process.stderr.write('err'); console.error('bad')");
    expect(r.out).toBe("out");
    expect(r.err).toBe("errbad\n");
  });

  it("honours process.exit, code and all", async () => {
    const r = await run("console.log('before'); process.exit(3); console.log('never')");
    expect(r.out).toBe("before\n");
    expect(r.code).toBe(3);
  });

  it("reports a throw the way node does — the stack, then exit 1", async () => {
    const r = await run("throw new Error('boom')");
    expect(r.err).toContain("boom");
    expect(r.code).toBe(1);
  });

  it("runs a file from the workspace, with __filename and __dirname", async () => {
    await fs.writeFile("workspace/projects/site/app.js", "console.log(__filename, __dirname)\n");
    let out = "";
    const result = await runScript(fs, {
      entry: "app.js",
      cwd: "/projects/site",
      createWorker: createEvalWorker,
      onStdout: (t) => (out += t),
    });
    expect(out.trim()).toBe("/projects/site/app.js /projects/site");
    expect(result.exitCode).toBe(0);
  });

  it("says which file it could not find", async () => {
    await expect(
      runScript(fs, { entry: "nope.js", cwd: "/projects/site", createWorker: createEvalWorker }),
    ).rejects.toThrow(/cannot find module 'nope.js'/);
  });

  it("waits for the work a script starts after its last line", async () => {
    const r = await run("setTimeout(() => console.log('later'), 5); console.log('now')");
    expect(r.out).toBe("now\nlater\n");
  });
});

describe("require", () => {
  it("loads a relative file, a .json, and a folder's index.js", async () => {
    const r = await run(
      "const bump = require('./lib.js'); const data = require('./data.json'); const deep = require('./deep');" +
        "console.log(bump(), data.who, deep)",
    );
    expect(r.out).toBe("1 world from index\n");
  });

  it("resolves without the extension, and caches the module", async () => {
    // Two requires, one module instance: the counter keeps counting rather than starting again.
    const r = await run("const a = require('./lib'); const b = require('./lib'); a(); console.log(b(), a === b)");
    expect(r.out).toBe("2 true\n");
  });

  it("refuses a package by name, and says why there is none", async () => {
    const r = await run("require('express')");
    expect(r.err).toContain("Cannot find module 'express'");
    expect(r.err).toContain("no node_modules in a browser tab");
    expect(r.err).toContain("packages need your Mac");
    expect(r.code).toBe(1);
  });

  it("names a relative file that is not there", async () => {
    const r = await run("require('./missing.js')");
    expect(r.err).toContain("Cannot find module './missing.js'");
  });

  it("hands out the built-ins, node: prefix included", async () => {
    const r = await run(
      "const path = require('node:path'); const { EventEmitter } = require('events'); const util = require('util');" +
        "const e = new EventEmitter(); e.on('x', (v) => console.log('got', v)); e.emit('x', 1);" +
        "console.log(path.join('/a/b', '../c'), path.extname('x.tar.gz'), util.format('%s', 'n'))",
    );
    expect(r.out).toBe("got 1\n/a/c .gz %s n\n");
  });
});

describe("the filesystem", () => {
  it("writes into the real workspace, where the agent and the tree can see it", async () => {
    const r = await run(
      "const fs = require('fs/promises');" +
        "(async () => { await fs.writeFile('./out.txt', 'from a script'); console.log(await fs.readFile('./out.txt', 'utf8')); })()",
    );
    expect(r.out).toBe("from a script\n");
    expect(await fs.readText("workspace/projects/site/out.txt")).toBe("from a script");
  });

  it("reads, lists and stats through the callback forms too", async () => {
    const r = await run(
      "const fs = require('fs');" +
        "fs.readdir('.', (err, names) => console.log(names.includes('lib.js')));" +
        "fs.stat('./data.json', (err, s) => console.log(s.isFile(), s.size > 0));",
    );
    expect(r.out).toContain("true");
    expect(r.out).toContain("true true");
  });

  it("cannot climb out of the workspace", async () => {
    const r = await run(
      "const fs = require('fs/promises');" +
        "fs.readFile('../../../vault.json', 'utf8').then((t) => console.log('READ IT', t), (e) => console.log('refused:', e.message))",
    );
    expect(r.out).toContain("refused:");
    expect(r.out).not.toContain("READ IT");
  });

  it("serves the sync READS from the snapshot", async () => {
    const r = await run(
      "const fs = require('fs');" +
        "console.log(fs.readFileSync('./data.json', 'utf8'), fs.existsSync('./lib.js'), fs.readdirSync('.').includes('deep'))",
    );
    expect(r.out).toBe('{"who":"world"} true true\n');
  });

  it("refuses a sync WRITE by name, and says what to use instead", async () => {
    const r = await run("require('fs').writeFileSync('./x.txt', 'no')");
    expect(r.err).toContain("SyncUnsupportedError");
    expect(r.err).toContain("cross-origin isolation");
    expect(r.err).toContain("fs.promises.writeFile");
    expect(await fs.stat("workspace/projects/site/x.txt")).toBeNull();
  });

  it("explains a sync read of a file the snapshot never had", async () => {
    const r = await run("require('fs').readFileSync('./written-later.txt', 'utf8')");
    expect(r.err).toContain("snapshot of your working folder");
  });
});

describe("the fs RPC, framed", () => {
  /** The page half on its own: a message in, a reply out, with no worker of any kind. */
  async function ask(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const replies: Record<string, unknown>[] = [];
    await answerFs(fs, "/projects/site", { id: 7, op, args }, (m) => replies.push(m as Record<string, unknown>));
    return replies[0]!;
  }

  it("answers with the id it was asked with", async () => {
    const reply = await ask("readFile", { path: "./data.json" });
    expect(reply.t).toBe("fs-reply");
    expect(reply.id).toBe(7);
    expect(reply.ok).toBe(true);
    expect(new TextDecoder().decode((reply.value as { bytes: Uint8Array }).bytes)).toBe('{"who":"world"}');
  });

  it("fails by name rather than throwing at the worker", async () => {
    const missing = await ask("stat", { path: "./nope" });
    expect(missing.ok).toBe(false);
    expect(String(missing.error)).toContain("ENOENT");
    const escaped = await ask("readFile", { path: "/../vault.json" });
    expect(escaped.ok).toBe(false);
    expect(String(escaped.error)).toContain("outside your workspace");
    const unknown = await ask("chmod", { path: "./data.json" });
    expect(unknown.ok).toBe(false);
    expect(String(unknown.error)).toContain("not one of the operations");
  });

  it("appends, renames and removes", async () => {
    await ask("writeFile", { path: "./a.txt", data: new TextEncoder().encode("one") });
    await ask("appendFile", { path: "./a.txt", data: new TextEncoder().encode("-two") });
    expect(await fs.readText("workspace/projects/site/a.txt")).toBe("one-two");
    await ask("rename", { path: "./a.txt", to: "./b.txt" });
    expect(await fs.stat("workspace/projects/site/a.txt")).toBeNull();
    await ask("unlink", { path: "./b.txt" });
    expect(await fs.stat("workspace/projects/site/b.txt")).toBeNull();
  });
});

describe("the snapshot", () => {
  it("names files the way the script will ask for them", async () => {
    const snapshot = await snapshotFolder(fs, "/projects/site");
    expect(Object.keys(snapshot.files)).toContain("/projects/site/lib.js");
    expect(snapshot.truncated).toBe(false);
  });

  it("stops at the caps and says it did", async () => {
    const snapshot = await snapshotFolder(fs, "/projects/site", { maxFiles: 2 });
    expect(Object.keys(snapshot.files)).toHaveLength(2);
    expect(snapshot.truncated).toBe(true);
    expect((await snapshotFolder(fs, "/projects/site", { maxBytes: 1 })).truncated).toBe(true);
  });

  it("leaves .git and node_modules out of the budget", async () => {
    await fs.mkdir("workspace/projects/site/node_modules/thing");
    await fs.writeFile("workspace/projects/site/node_modules/thing/index.js", "module.exports = 1");
    await fs.writeFile("workspace/projects/site/.git/HEAD", "ref: refs/heads/main");
    const snapshot = await snapshotFolder(fs, "/projects/site");
    expect(Object.keys(snapshot.files).some((p) => p.includes("node_modules") || p.includes(".git"))).toBe(false);
  });

  it("maps a workspace path both ways", () => {
    expect(agentPath("/projects/site")).toBe("workspace/projects/site");
    expect(agentPath("projects/site")).toBe("workspace/projects/site");
    expect(virtualPath("workspace/projects/site/app.js")).toBe("/projects/site/app.js");
    expect(() => agentPath("../../etc")).toThrow();
  });
});

describe("the limits", () => {
  it("stops a script that will not stop, and says a browser tab is not the place", async () => {
    const r = await run("setInterval(() => {}, 5)", { timeoutMs: 60 });
    expect(r.code).toBe(EXIT_TIMEOUT);
    expect(r.err).toContain("will not run a script forever");
  });

  it("stops on a signal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const r = await run("setInterval(() => {}, 5)", { signal: controller.signal, timeoutMs: 5_000 });
    expect(r.code).toBe(EXIT_ABORTED);
  });

  it("never starts when the signal is already spent", async () => {
    const r = await run("console.log('should not run')", { signal: AbortSignal.abort() });
    expect(r.code).toBe(EXIT_ABORTED);
    expect(r.out).toBe("");
  });
});

describe("a server", () => {
  const SOURCE = `
    const http = require('http');
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += new TextDecoder().decode(chunk); });
        req.on('end', () => { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ got: body })); });
        return;
      }
      res.setHeader('x-from', 'the worker');
      res.end('<!doctype html><h1>' + req.url + '</h1>');
    });
    server.listen(3000, () => console.log('up on ' + server.address().port));
  `;

  const request = (method: string, url: string, body?: string) => ({
    method,
    url,
    headers: {},
    body: body ? new TextEncoder().encode(body) : null,
  });

  it("registers a port, hands the terminal back, and answers", async () => {
    const r = await run(SOURCE);
    expect(r.code).toBe(0);
    expect(r.out).toContain("up on 3000");
    expect(r.listening).toEqual([3000]);
    expect(listPorts()[0]).toMatchObject({ port: 3000, kind: "script" });

    const answer = await handleVirtualRequest({ kind: "port", port: 3000, subpath: "/hello" }, request("GET", "/hello"));
    expect(answer.status).toBe(200);
    expect(new TextDecoder().decode(answer.body)).toContain("<h1>/hello</h1>");
    expect(answer.headers["x-from"]).toBe("the worker");
    // A guess is made only when the handler set none, and never a guess that lets a browser sniff.
    expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(answer.headers["cache-control"]).toBe("no-store");
  });

  it("gets the body of a POST, both as a stream and whole", async () => {
    await run(SOURCE);
    const answer = await handleVirtualRequest(
      { kind: "port", port: 3000, subpath: "/save" },
      request("POST", "/save", "a=1"),
    );
    expect(answer.status).toBe(201);
    expect(JSON.parse(new TextDecoder().decode(answer.body))).toEqual({ got: "a=1" });
  });

  it("is gone when the port is killed", async () => {
    await run(SOURCE);
    expect(unregister(3000)).toBe(true);
    expect(listPorts()).toEqual([]);
    const answer = await handleVirtualRequest({ kind: "port", port: 3000, subpath: "/" }, request("GET", "/"));
    expect(answer.status).toBe(502);
  });

  it("says EADDRINUSE in words when the port is taken", async () => {
    await run(SOURCE);
    const second = await run(SOURCE);
    expect(second.err).toContain("already in use");
    expect(listPorts()).toHaveLength(1);
  });

  it("answers 500 when the handler throws, rather than nothing at all", async () => {
    await run("require('http').createServer(() => { throw new Error('handler bug'); }).listen(3100)");
    const answer = await handleVirtualRequest({ kind: "port", port: 3100, subpath: "/" }, request("GET", "/"));
    expect(answer.status).toBe(500);
    expect(new TextDecoder().decode(answer.body)).toContain("handler bug");
  });
});

describe("the prelude source", () => {
  it("carries no reference to this module's scope", () => {
    // The closure does not travel into a Worker: a slip here is a ReferenceError in the browser and
    // nowhere else. Running it in an empty scope is the check.
    const source = workerSource();
    expect(source.startsWith("(function")).toBe(true);
    expect(() => createEvalWorker(source)).not.toThrow();
    for (const outside of ["NO_PACKAGES_LINE", "SNAPSHOT_MAX", "resolveInSandbox", "FILES_ROOT", "registerPort"]) {
      expect(source, `the prelude reaches for ${outside}`).not.toContain(outside);
    }
  });
});
