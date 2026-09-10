/**
 * What a person can now type: `node`, `npm run`, `serve`, `ports`, `kill`.
 *
 * The shell is the surface the AGENT gets too — `bash` runs this same table — so these are the
 * sentences both of them will read. The Worker underneath is the in-process one
 * (`createEvalWorker`), which runs the shipped prelude; the shell code being exercised is the
 * shipped one, flags and all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFs } from "@00/agent-fs";
import { BuiltinShell } from "../src/power/shell.js";
import { createEvalWorker } from "../src/power/js-runner.js";
import { handleVirtualRequest, listPorts, resetPorts } from "../src/power/virtual-ports.js";

let fs: MemoryFs;
let shell: BuiltinShell;

beforeEach(async () => {
  resetPorts();
  fs = new MemoryFs();
  await fs.mkdir("workspace/projects/site/public");
  await fs.writeFile("workspace/projects/site/app.js", "console.log('ran', process.argv.slice(2).join(','))\n");
  await fs.writeFile("workspace/projects/site/public/index.html", "<!doctype html><h1>static</h1>");
  await fs.writeFile(
    "workspace/projects/site/package.json",
    JSON.stringify({ name: "site", scripts: { build: "node app.js built", start: "serve ./public", loop: "npm run loop" } }),
  );
  shell = new BuiltinShell(fs, { createWorker: createEvalWorker, scriptTimeoutMs: 2_000 });
});
afterEach(() => resetPorts());

async function run(command: string): Promise<{ out: string; err: string; code: number }> {
  const result = await shell.exec(command, { cwd: "workspace" });
  return { out: result.stdout, err: result.stderr, code: result.exitCode };
}

describe("node", () => {
  it("runs a file with its arguments", async () => {
    const r = await run("cd projects/site && node app.js one two");
    expect(r.out).toContain("ran one,two");
    expect(r.code).toBe(0);
  });

  it("runs -e, and pipes like anything else in this shell", async () => {
    expect((await run(`node -e "console.log('a\\nb')" | wc -l`)).out.trim()).toBe("2");
  });

  it("carries a non-zero exit code out to the shell", async () => {
    const r = await run(`node -e "process.exit(4)"`);
    expect(r.code).toBe(4);
  });

  it("says there is no REPL, and what the flags are", async () => {
    expect((await run("node")).err).toContain("no REPL");
    expect((await run("node -e")).err).toContain("wants some code");
    expect((await run("node -p 1+1")).err).toContain("use -e");
    expect((await run("node --harmony x.js")).err).toContain("not a flag");
  });

  it("names the file it cannot find", async () => {
    expect((await run("node nope.js")).err).toContain("cannot find module 'nope.js'");
  });

  it("says what it is when asked for a version, rather than inventing one", async () => {
    expect((await run("node -v")).out).toContain("browser runtime");
  });

  it("writes into the workspace, where the tree sees it", async () => {
    await run(`cd projects/site && node -e "require('fs').writeFile('./made.txt', 'yes', () => {})"`);
    expect(await fs.readText("workspace/projects/site/made.txt")).toBe("yes");
  });
});

describe("npm run", () => {
  it("finds the script in package.json and runs it through this same shell", async () => {
    const r = await run("cd projects/site && npm run build");
    expect(r.out).toContain("> build");
    expect(r.out).toContain("> node app.js built");
    expect(r.out).toContain("ran built");
    expect(r.code).toBe(0);
  });

  it("takes `npm start` as the script of that name", async () => {
    const r = await run("cd projects/site && npm start");
    expect(r.out).toContain("serving /projects/site/public on port 3000");
    expect(listPorts()).toHaveLength(1);
  });

  it("says which scripts there are when the name is wrong", async () => {
    const r = await run("cd projects/site && npm run nope");
    expect(r.err).toContain('no script named "nope"');
    expect(r.err).toContain("build");
    expect(r.code).toBe(1);
  });

  it("says where package.json should have been", async () => {
    expect((await run("npm run build")).err).toContain("no package.json in /");
  });

  it("says so when package.json is not JSON", async () => {
    await fs.writeFile("workspace/package.json", "{ not json");
    expect((await run("npm run build")).err).toContain("not valid JSON");
  });

  it("stops a script that calls itself instead of spinning", async () => {
    const r = await run("cd projects/site && npm run loop");
    expect(r.err).toContain("something is calling itself");
  });

  it("still refuses to install", async () => {
    const r = await run("npm install left-pad");
    expect(r.code).toBe(127);
    expect(r.err).toContain("packages need your Mac");
  });
});

describe("serve, ports and kill", () => {
  it("serves a folder and prints the URL to open", async () => {
    const r = await run("cd projects/site && serve ./public");
    expect(r.out).toContain("serving /projects/site/public on port 3000");
    expect(r.out).toContain("/~/3000/");
    expect(r.out).toContain("only while this tab is open");
    const answer = await handleVirtualRequest({ kind: "port", port: 3000, subpath: "/" }, { method: "GET", url: "/", headers: {}, body: null });
    expect(new TextDecoder().decode(answer.body)).toContain("static");
  });

  it("takes a port, however it is spelled, and npx spells it too", async () => {
    // One shell, one working directory — the `cd` from the first line is still in force, which is
    // the whole reason a terminal feels like a terminal.
    expect((await run("cd projects/site && serve ./public -p 4000")).out).toContain("port 4000");
    expect((await run("serve ./public --port=4100")).out).toContain("port 4100");
    expect((await run("npx serve /projects/site/public -p 4200")).out).toContain("port 4200");
    expect(listPorts().map((p) => p.port)).toEqual([4000, 4100, 4200]);
  });

  it("refuses what it cannot serve, by name", async () => {
    expect((await run("serve ./nowhere")).err).toContain("not a folder here");
    expect((await run("serve . -p")).err).toContain("wants a port number");
    expect((await run("serve . --gzip")).err).toContain("not a flag");
    await run("serve .");
    expect((await run("serve .")).err).toContain("already in use");
  });

  it("lists what is listening, and kills it", async () => {
    expect((await run("ports")).out).toContain("nothing is listening");
    await run("cd projects/site && serve ./public -p 5050");
    const listed = await run("ports");
    expect(listed.out).toContain("5050");
    expect(listed.out).toContain("folder");
    expect(listed.out).toContain("/~/5050/");
    expect((await run("kill 5050")).out).toBe("5050 stopped\n");
    expect(listPorts()).toEqual([]);
    expect((await run("kill 5050")).err).toContain("nothing is listening on 5050");
    expect((await run("kill bash")).err).toContain("kills ports, not pids");
    expect((await run("kill")).err).toContain("which port");
  });

  it("hands the terminal back when a script starts a server, and says how to stop it", async () => {
    await fs.writeFile(
      "workspace/projects/site/server.js",
      "require('http').createServer((req, res) => res.end('hi ' + req.url)).listen(3300)\n",
    );
    const r = await run("cd projects/site && node server.js");
    expect(r.code).toBe(0);
    expect(r.out).toContain("listening on /~/3300/");
    expect(r.out).toContain("kill 3300");
    const answer = await handleVirtualRequest({ kind: "port", port: 3300, subpath: "/x" }, { method: "GET", url: "/x", headers: {}, body: null });
    expect(new TextDecoder().decode(answer.body)).toBe("hi /x");
    expect((await run("kill 3300")).code).toBe(0);
  });
});

describe("help and which", () => {
  it("names the new commands and keeps the refusals visible", async () => {
    const help = (await run("help")).out;
    expect(help).toContain("node file.js");
    expect(help).toContain("npm run <script>");
    expect(help).toContain("serve ./dir");
    expect(help).toContain("packages need your Mac");
    expect((await run("which node")).out).toBe("node: shell builtin\n");
    expect((await run("which pnpm")).err).toContain("no Node");
  });
});
