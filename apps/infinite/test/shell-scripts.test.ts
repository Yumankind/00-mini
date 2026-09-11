/**
 * What a person can now type: `node`, `npm install`, `npm run`, `npx`, `serve`, `ports`, `kill`.
 *
 * The shell is the surface the AGENT gets too — `bash` runs this same table — so these are the
 * sentences both of them will read. The Worker underneath is the in-process one
 * (`createInlineNodeWorker`), which runs the shipped runtime module; the shell code being exercised
 * is the shipped one, flags and all.
 *
 * THE REGISTRY IS A FAKE, AND THE TARBALLS ARE NOT. `packages/agent-node/test/npm-fixtures.ts` builds
 * real gzipped tarballs with agent-fs's tar writer and real sha512 integrity, so `npm install` here
 * runs the whole road it runs against registry.npmjs.org: fetch, verify, gunzip, untar, write,
 * shim, lockfile. It is imported BY PATH because that package exports only its root, and a fixture
 * is not part of a package's public face.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFs } from "@00/agent-fs";
import { fakeRegistry, type FakePackage } from "../../../packages/agent-node/test/npm-fixtures.js";
import { BuiltinShell, type OutputSink } from "../src/power/shell.js";
import { createInlineNodeWorker } from "../src/power/node-runtime-worker.js";
import { handleVirtualRequest, listPorts, resetPorts } from "../src/power/virtual-ports.js";

const REGISTRY = "https://registry.test";

let fs: MemoryFs;
let shell: BuiltinShell;

async function shellWith(packages: FakePackage[] = []): Promise<BuiltinShell> {
  const registry = await fakeRegistry(packages, REGISTRY);
  return new BuiltinShell(fs, {
    createWorker: () => createInlineNodeWorker(),
    scriptTimeoutMs: 2_000,
    npm: { registry: REGISTRY, fetch: registry.fetch },
  });
}

beforeEach(async () => {
  resetPorts();
  fs = new MemoryFs();
  await fs.mkdir("workspace/projects/site/public");
  await fs.writeFile("workspace/projects/site/app.js", "console.log('ran', process.argv.slice(2).join(','))\n");
  await fs.writeFile("workspace/projects/site/public/index.html", "<!doctype html><h1>static</h1>");
  await fs.writeFile(
    "workspace/projects/site/package.json",
    JSON.stringify({
      name: "site",
      version: "1.0.0",
      scripts: { build: "node app.js built", start: "serve ./public", loop: "npm run loop", prebuild: "echo first" },
    }),
  );
  shell = await shellWith();
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

  it("streams to a sink as it runs, and then leaves it out of the result", async () => {
    const seen: { stream: string; text: string }[] = [];
    const onOutput: OutputSink = (chunk) => seen.push(chunk);
    const result = await shell.exec("cd projects/site && node app.js live", { cwd: "workspace", onOutput });
    expect(seen.map((c) => c.text).join("")).toContain("ran live");
    expect(result.stdout).toBe("");
  });

  it("keeps the order of a chain, whether a stage streamed or not", async () => {
    const seen: string[] = [];
    await shell.exec(`cd projects/site && echo first && node app.js second && echo third`, {
      cwd: "workspace",
      onOutput: (c) => seen.push(c.text),
    });
    expect(seen.join("")).toBe("first\nran second\nthird\n");
  });

  it("does not stream what is being piped or redirected, because something else is reading it", async () => {
    const seen: string[] = [];
    const result = await shell.exec(`cd projects/site && node app.js piped > out.txt`, {
      cwd: "workspace",
      onOutput: (c) => seen.push(c.text),
    });
    expect(seen.join("")).toBe("");
    expect(result.stdout).toBe("");
    expect(await fs.readText("workspace/projects/site/out.txt")).toContain("ran piped");
  });
});

describe("npm install", () => {
  it("fetches a package, writes node_modules, and requires it in the next command", async () => {
    shell = await shellWith([{ name: "is-number", version: "7.0.0" }]);
    const installed = await run("cd projects/site && npm install is-number@7");
    expect(installed.code).toBe(0);
    expect(installed.out).toContain("resolved is-number@7.0.0");
    expect(installed.out).toContain("added 1 package");
    // package.json was saved, exactly as npm's own --save default does.
    expect(JSON.parse(await fs.readText("workspace/projects/site/package.json")).dependencies).toEqual({
      "is-number": "^7.0.0",
    });
    expect(await fs.stat("workspace/projects/site/node_modules/is-number/package.json")).not.toBeNull();
    expect(await fs.stat("workspace/projects/site/package-lock.json")).not.toBeNull();

    const used = await run(`node -e "console.log(require('is-number'))"`);
    expect(used.out).toBe("is-number@7.0.0\n");
  });

  it("names the install scripts and the native code it did NOT run", async () => {
    shell = await shellWith([
      { name: "sharpish", version: "2.0.0", native: true, scripts: { postinstall: "node-gyp rebuild" } },
    ]);
    const r = await run("cd projects/site && npm i sharpish");
    expect(r.out).toContain("install scripts NOT run");
    expect(r.out).toContain("sharpish@2.0.0 (postinstall)");
    expect(r.out).toContain("native addons NOT built");
  });

  it("installs what package.json already asks for when it is given no names", async () => {
    shell = await shellWith([{ name: "left-pad", version: "1.3.0" }]);
    await fs.writeFile(
      "workspace/projects/site/package.json",
      JSON.stringify({ name: "site", version: "1.0.0", dependencies: { "left-pad": "^1.0.0" } }),
    );
    const r = await run("cd projects/site && npm install");
    expect(r.out).toContain("added 1 package");
    expect(await fs.stat("workspace/projects/site/node_modules/left-pad/index.js")).not.toBeNull();
  });

  it("says where package.json should have been, and what a person can type", async () => {
    const r = await run("npm install is-number");
    expect(r.err).toContain("no package.json in /");
    expect(r.err).toContain("package.json");
    expect(r.code).toBe(1);
  });

  it("names a package the registry does not have", async () => {
    const r = await run("cd projects/site && npm install not-a-real-package");
    expect(r.err).toContain("not-a-real-package");
    expect(r.code).toBe(1);
  });

  it("lists what is on disk with npm ls, and the unmet dependency", async () => {
    shell = await shellWith([{ name: "is-number", version: "7.0.0" }]);
    await run("cd projects/site && npm install is-number@7");
    const listed = await run("npm ls");
    expect(listed.out).toContain("site@1.0.0");
    expect(listed.out).toContain("is-number@7.0.0");

    await fs.writeFile(
      "workspace/projects/site/package.json",
      JSON.stringify({ name: "site", version: "1.0.0", dependencies: { "is-number": "^7.0.0", missing: "^1.0.0" } }),
    );
    expect((await run("npm ls")).out).toContain("UNMET DEPENDENCY missing");
  });
});

describe("npm run", () => {
  it("runs the pre hook and the script, in npm's order, through this same shell", async () => {
    const r = await run("cd projects/site && npm run build");
    expect(r.out).toContain("> prebuild");
    expect(r.out).toContain("> build");
    expect(r.out).toContain("> node app.js built");
    expect(r.out).toContain("ran built");
    expect(r.code).toBe(0);
  });

  it("puts npm's own environment in front of the script", async () => {
    await fs.writeFile(
      "workspace/projects/site/package.json",
      JSON.stringify({ name: "site", version: "2.1.0", scripts: { say: "echo $npm_package_name@$npm_package_version" } }),
    );
    expect((await run("cd projects/site && npm run say")).out).toContain("site@2.1.0");
  });

  it("runs a tool from node_modules/.bin, which is what npm's PATH does", async () => {
    shell = await shellWith([
      {
        name: "greeter",
        version: "1.0.0",
        bin: { greet: "cli.js" },
        files: { "cli.js": "console.log('hi from ' + (process.argv[2] || 'greet'));" },
      },
    ]);
    await run("cd projects/site && npm install greeter");
    await fs.writeFile(
      "workspace/projects/site/package.json",
      JSON.stringify({
        name: "site",
        version: "1.0.0",
        dependencies: { greeter: "^1.0.0" },
        scripts: { hello: "greet the-script" },
      }),
    );
    const r = await run("npm run hello");
    expect(r.out).toContain("hi from the-script");
    expect(r.code).toBe(0);
    // …and the same shim by hand, through npx.
    expect((await run("npx greet by-npx")).out).toContain("hi from by-npx");
    // …and as a bare command, because `.bin` is this shell's PATH.
    expect((await run("greet bare")).out).toContain("hi from bare");
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
    expect((await run("npm run build")).err).toContain("no package.json in");
  });

  it("says so when package.json is not JSON", async () => {
    await fs.writeFile("workspace/package.json", "{ not json");
    expect((await run("npm run build")).err).toContain("not valid JSON");
  });

  it("stops a script that calls itself instead of spinning", async () => {
    const r = await run("cd projects/site && npm run loop");
    expect(r.err).toContain("something is calling itself");
  });
});

describe("npx, and the clients that are not npm", () => {
  it("says what it will not fetch, rather than fetching it", async () => {
    const r = await run("cd projects/site && npx cowsay hello");
    expect(r.err).toContain("no cowsay in node_modules/.bin");
    expect(r.err).toContain("npm install cowsay");
    expect(r.code).toBe(127);
  });

  it("names npm as the one client in this tab", async () => {
    for (const command of ["pnpm install", "yarn add x", "bun install", "deno run x.ts"]) {
      const r = await run(command);
      expect(r.code, command).toBe(127);
      expect(r.err, command).toContain("npm is the one package client in this tab");
    }
  });

  it("still refuses the toolchains a browser has no answer for", async () => {
    for (const command of ["tsc", "vite build", "webpack"]) {
      expect((await run(command)).err, command).toContain("no Node");
    }
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

  it("hands the terminal back when a script starts a server, and kills the process with the port", async () => {
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
    // The Worker went with the port: nothing answers there any more.
    const gone = await handleVirtualRequest({ kind: "port", port: 3300, subpath: "/x" }, { method: "GET", url: "/x", headers: {}, body: null });
    expect(gone.status).toBe(502);
  });
});

describe("help and which", () => {
  it("names the new commands and keeps the refusals visible", async () => {
    const help = (await run("help")).out;
    expect(help).toContain("node file.js");
    expect(help).toContain("npm run <script>");
    expect(help).toContain("npm install");
    expect(help).toContain("serve ./dir");
    expect((await run("which node")).out).toBe("node: shell builtin\n");
    expect((await run("which pnpm")).err).toContain("one package client");
  });
});
