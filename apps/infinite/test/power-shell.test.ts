import { beforeEach, describe, expect, it } from "vitest";
import { MemoryFs } from "@00/agent-fs";
import {
  BuiltinShell,
  GIT_REMOTE_LINE,
  NO_NODE_LINE,
  expandSet,
  parse,
  rangeToNumbers,
  strftime,
  tokenize,
  type ShellGit,
} from "../src/power/shell.js";

/**
 * The browser shell, against the in-memory filesystem — which is the same `AgentFs` the OPFS adapter
 * implements, so everything asserted here is true of a real tab. The three things worth more than
 * the command coverage are at the bottom: the sandbox cannot be left, a refusal is named rather than
 * silent, and a pipeline is a pipeline.
 */

let fs: MemoryFs;
let shell: BuiltinShell;

async function seed(): Promise<void> {
  fs = new MemoryFs();
  await fs.mkdir("workspace");
  await fs.writeFile("workspace/AGENTS.md", "# Agents\nbe useful\n");
  await fs.writeFile("workspace/notes.txt", "beta\nalpha\nalpha\ngamma\n");
  await fs.writeFile("workspace/.hidden", "secret-ish\n");
  await fs.mkdir("workspace/projects/site");
  await fs.writeFile("workspace/projects/site/index.html", "<h1>hi</h1>\n");
  await fs.writeFile("workspace/projects/site/app.js", "console.log(1)\n");
  // Outside the sandbox on purpose: the agent's own record, which nothing here may reach.
  await fs.writeFile("vault.json", '{"secret":true}');
  shell = new BuiltinShell(fs, { now: () => new Date("2026-09-10T11:22:33Z") });
}

async function run(command: string): Promise<{ out: string; err: string; code: number }> {
  const result = await shell.exec(command, { cwd: "workspace" });
  return { out: result.stdout, err: result.stderr, code: result.exitCode };
}

beforeEach(seed);

describe("lexing and parsing", () => {
  it("keeps quoted whitespace in one word and remembers it was quoted", () => {
    expect(tokenize(`echo "two words" 'and more'`)).toEqual([
      { kind: "word", text: "echo", quoted: false },
      { kind: "word", text: "two words", quoted: true },
      { kind: "word", text: "and more", quoted: true },
    ]);
  });

  it("reads the operators, including the doubled ones", () => {
    expect(tokenize("a | b && c || d ; e > f >> g < h").filter((t) => t.kind === "op")).toEqual([
      { kind: "op", op: "|" },
      { kind: "op", op: "&&" },
      { kind: "op", op: "||" },
      { kind: "op", op: ";" },
      { kind: "op", op: ">" },
      { kind: "op", op: ">>" },
      { kind: "op", op: "<" },
    ]);
  });

  it("escapes a character outside quotes and stops at a comment", () => {
    expect(tokenize("echo a\\ b # trailing")).toEqual([
      { kind: "word", text: "echo", quoted: false },
      { kind: "word", text: "a b", quoted: true },
    ]);
  });

  it("groups a pipeline under the connector that reached it", () => {
    const stages = parse(tokenize("ls | wc -l && echo ok"));
    expect(stages).toHaveLength(2);
    expect(stages[0]!.pipeline).toHaveLength(2);
    expect(stages[1]!.connector).toBe("&&");
  });

  it("refuses a redirect with nothing after it, rather than writing to nowhere", async () => {
    const r = await run("echo hi >");
    expect(r.code).toBe(2);
    expect(r.err).toContain("syntax error");
  });
});

describe("moving around", () => {
  it("starts at the sandbox root and says so", async () => {
    expect((await run("pwd")).out).toBe("/\n");
  });

  it("cd remembers where it is between calls, which is what makes it a terminal", async () => {
    await run("cd projects/site");
    expect(shell.cwd).toBe("/projects/site");
    expect((await run("pwd")).out).toBe("/projects/site\n");
    expect((await run("ls")).out).toBe("app.js\nindex.html\n");
  });

  it("cd - goes back", async () => {
    await run("cd projects");
    await run("cd site");
    await run("cd -");
    expect(shell.cwd).toBe("/projects");
  });

  it("cd into a file is Not a directory; cd into nothing is No such file", async () => {
    expect((await run("cd AGENTS.md")).err).toContain("Not a directory");
    expect((await run("cd nowhere")).err).toContain("No such file");
  });

  it("re-roots and forgets its cwd when the sandbox itself changes", async () => {
    await run("cd projects");
    const again = await shell.exec("pwd", { cwd: "workspace/projects" });
    expect(again.stdout).toBe("/\n");
  });
});

describe("the sandbox", () => {
  it("cannot climb out with `..`", async () => {
    const r = await run("cat ../vault.json");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("cannot leave it");
    expect(r.out).not.toContain("secret");
  });

  it("cannot climb out with cd either", async () => {
    const r = await run("cd ..");
    expect(r.err).toContain("cannot leave it");
    expect(shell.cwd).toBe("/");
  });

  it("treats a leading slash as the WORKSPACE root, not the agent root", async () => {
    expect((await run("cat /AGENTS.md")).out).toContain("be useful");
    expect((await run("cat /vault.json")).code).not.toBe(0);
  });

  it("refuses a redirect that would write outside", async () => {
    const r = await run("echo x > ../escaped.txt");
    expect(r.code).not.toBe(0);
    expect(await fs.stat("escaped.txt")).toBeNull();
  });
});

describe("the file commands", () => {
  it("ls hides dotfiles until -a, and marks directories", async () => {
    expect((await run("ls")).out).toBe("AGENTS.md\nnotes.txt\nprojects/\n");
    expect((await run("ls -a")).out).toContain(".hidden");
  });

  it("ls -l carries the size", async () => {
    expect((await run("ls -l AGENTS.md")).out).toMatch(/^-\s+19 /);
  });

  it("cat joins its arguments and names the one it could not read", async () => {
    const r = await run("cat AGENTS.md missing.md");
    expect(r.out).toContain("be useful");
    expect(r.err).toContain("missing.md: No such file");
    expect(r.code).toBe(1);
  });

  it("echo -n leaves the newline off", async () => {
    expect((await run("echo -n hi")).out).toBe("hi");
    expect((await run("echo hi there")).out).toBe("hi there\n");
  });

  it("mkdir makes parents, and says so when it is already there", async () => {
    expect((await run("mkdir a/b/c")).code).toBe(0);
    expect((await fs.stat("workspace/a/b/c"))?.kind).toBe("dir");
    expect((await run("mkdir a")).err).toContain("File exists");
    expect((await run("mkdir -p a")).code).toBe(0);
  });

  it("rm refuses a directory until -r, and -f forgives what is not there", async () => {
    expect((await run("rm projects")).err).toContain("use -r");
    expect((await run("rm nothing.txt")).code).toBe(1);
    expect((await run("rm -f nothing.txt")).code).toBe(0);
    expect((await run("rm -r projects")).code).toBe(0);
    expect(await fs.stat("workspace/projects/site/app.js")).toBeNull();
  });

  it("mv renames, and moves into a directory when the target is one", async () => {
    await run("mv notes.txt renamed.txt");
    expect(await fs.stat("workspace/notes.txt")).toBeNull();
    await run("mv renamed.txt projects");
    expect(await fs.stat("workspace/projects/renamed.txt")).not.toBeNull();
  });

  it("cp copies a file, and a tree with -r", async () => {
    await run("cp AGENTS.md copy.md");
    expect(await fs.readText("workspace/copy.md")).toContain("be useful");
    expect((await run("cp projects backup")).err).toContain("use -r");
    await run("cp -r projects backup");
    expect(await fs.readText("workspace/backup/site/app.js")).toContain("console.log");
  });

  it("touch creates what is missing and leaves what is there", async () => {
    await run("touch fresh.txt");
    expect(await fs.readText("workspace/fresh.txt")).toBe("");
    await run("touch AGENTS.md");
    expect(await fs.readText("workspace/AGENTS.md")).toContain("be useful");
  });

  it("head and tail take -n", async () => {
    expect((await run("head -n 2 notes.txt")).out).toBe("beta\nalpha\n");
    expect((await run("tail -n 1 notes.txt")).out).toBe("gamma\n");
  });

  it("wc counts three things, or the one asked for", async () => {
    expect((await run("wc notes.txt")).out).toBe("4 4 23 notes.txt\n");
    expect((await run("wc -l notes.txt")).out).toBe("4 notes.txt\n");
  });
});

describe("text", () => {
  it("grep finds lines, numbers them and inverts", async () => {
    expect((await run("grep alpha notes.txt")).out).toBe("alpha\nalpha\n");
    expect((await run("grep -n gamma notes.txt")).out).toBe("4:gamma\n");
    expect((await run("grep -v alpha notes.txt")).out).toBe("beta\ngamma\n");
  });

  it("grep -i is case-insensitive and a miss exits 1", async () => {
    expect((await run("grep -i BETA notes.txt")).code).toBe(0);
    expect((await run("grep zzz notes.txt")).code).toBe(1);
  });

  it("grep -r walks, and names the file it found each line in", async () => {
    const r = await run("grep -r console projects");
    expect(r.out).toContain("/projects/site/app.js:console.log(1)");
  });

  it("grep refuses a directory without -r rather than reading nothing", async () => {
    expect((await run("grep x projects")).err).toContain("Is a directory");
  });

  it("find matches a glob on the basename and filters by type", async () => {
    expect((await run("find . -name '*.md'")).out).toBe("/AGENTS.md\n");
    const dirs = (await run("find . -type d")).out;
    expect(dirs).toContain("/projects");
    expect(dirs).not.toContain("AGENTS.md");
  });

  it("sort, uniq, tr and cut do the four things they are reached for", async () => {
    expect((await run("sort notes.txt")).out).toBe("alpha\nalpha\nbeta\ngamma\n");
    expect((await run("sort -u notes.txt")).out).toBe("alpha\nbeta\ngamma\n");
    expect((await run("sort notes.txt | uniq -c")).out).toContain("   2 alpha");
    expect((await run("echo abc | tr a-z A-Z")).out).toBe("ABC\n");
    expect((await run("echo a,b,c | cut -d , -f 2")).out).toBe("b\n");
  });

  it("expandSet and rangeToNumbers are the two little parsers behind tr and cut", () => {
    expect(expandSet("a-e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(rangeToNumbers("2-4")).toEqual([2, 3, 4]);
    expect(rangeToNumbers("3")).toEqual([3]);
  });
});

describe("pipes and redirects", () => {
  it("pipes the left side's stdout into the right side's stdin", async () => {
    expect((await run("cat notes.txt | grep alpha | wc -l")).out).toBe("2\n");
  });

  it("> writes and truncates; >> appends", async () => {
    await run("echo one > out.txt");
    expect(await fs.readText("workspace/out.txt")).toBe("one\n");
    await run("echo two >> out.txt");
    expect(await fs.readText("workspace/out.txt")).toBe("one\ntwo\n");
    await run("echo three > out.txt");
    expect(await fs.readText("workspace/out.txt")).toBe("three\n");
  });

  it("< feeds a file in as stdin", async () => {
    expect((await run("grep alpha < notes.txt")).out).toBe("alpha\nalpha\n");
  });

  it("tee passes through and writes", async () => {
    const r = await run("echo hello | tee greeting.txt");
    expect(r.out).toBe("hello\n");
    expect(await fs.readText("workspace/greeting.txt")).toBe("hello\n");
  });

  it("a redirect takes the output out of the pipeline, as a shell does", async () => {
    const r = await run("echo hidden > out.txt");
    expect(r.out).toBe("");
  });

  it("&& stops on failure and || only runs on it", async () => {
    expect((await run("false && echo never")).out).toBe("");
    expect((await run("false || echo rescued")).out).toBe("rescued\n");
    expect((await run("true && echo yes")).out).toBe("yes\n");
    expect((await run("echo a ; echo b")).out).toBe("a\nb\n");
  });

  it("globs one level, and leaves a pattern that matches nothing alone", async () => {
    expect((await run("ls *.md")).out).toBe("AGENTS.md\n");
    expect((await run("ls projects/site/*.js")).out).toBe("projects/site/app.js\n");
    expect((await run("ls *.zzz")).err).toContain("*.zzz: No such file");
  });

  it("does not glob a quoted pattern", async () => {
    expect((await run(`echo "*.md"`)).out).toBe("*.md\n");
  });
});

describe("the small ones", () => {
  it("env, date, true, false and which", async () => {
    expect((await run("env")).out).toContain("SHELL=browser shell");
    expect((await run("date")).out.trim()).toBe("2026-09-10T11:22:33.000Z");
    expect((await run("date +%Y-%m-%d")).out.trim()).toBe("2026-09-10");
    expect((await run("true")).code).toBe(0);
    expect((await run("false")).code).toBe(1);
    expect((await run("which grep")).out).toContain("shell builtin");
  });

  it("strftime covers the six fields a filename uses", () => {
    expect(strftime(new Date("2026-01-02T03:04:05Z"), "%Y%m%d-%H%M%S")).toBe("20260102-030405");
  });

  it("$VAR expands, and $PWD follows the cd", async () => {
    await run("cd projects");
    expect((await run("echo $PWD")).out).toBe("/projects\n");
    expect((await run("echo ${SHELL}")).out).toBe("browser shell\n");
  });

  it("help names what it has and what it refuses", async () => {
    const help = (await run("help")).out;
    expect(help).toContain("browser shell");
    expect(help).toContain("git");
    expect(help).toContain("node");
  });
});

describe("refusals, by name", () => {
  it("node and npm say where they can run", async () => {
    for (const command of ["node -e 'console.log(1)'", "npm install", "pnpm build", "npx vite"]) {
      const r = await run(command);
      expect(r.code).toBe(127);
      expect(r.err).toContain(NO_NODE_LINE);
    }
  });

  it("python, curl and ssh get their own sentence, not `command not found`", async () => {
    expect((await run("python x.py")).err).toContain("no Python");
    expect((await run("curl https://example.com")).err).toContain("CORS-open");
    expect((await run("ssh box")).err).toContain("no SSH");
  });

  it("something genuinely unknown is still `command not found`", async () => {
    const r = await run("flurb");
    expect(r.code).toBe(127);
    expect(r.err).toContain("flurb: command not found");
  });

  it("the shell says it is available and names itself, which the prompt repeats", () => {
    expect(shell.available).toBe(true);
    expect(shell.label).toBe("browser shell");
  });

  it("run() folds the two streams into the one string a tool result is", async () => {
    const result = await shell.run("cat nope.txt", { cwd: "workspace", signal: new AbortController().signal });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No such file");
  });

  it("caps a runaway so a tab cannot be filled by one command", async () => {
    const small = new BuiltinShell(fs, { maxOutputChars: 20 });
    const r = await small.exec("cat notes.txt", { cwd: "workspace" });
    expect(r.stdout).toContain("truncated at 20");
  });
});

describe("git, delegated", () => {
  const calls: string[] = [];
  const fake: ShellGit = {
    async init(dir) {
      calls.push(`init ${dir}`);
    },
    async status() {
      return [
        { path: "a.md", status: "modified", staged: false },
        { path: "b.md", status: "untracked", staged: false },
      ];
    },
    async log() {
      return [{ oid: "abcdef1234", message: "first\nbody", timestamp: 1_700_000_000, author: "t" }];
    },
    async add(dir, paths) {
      calls.push(`add ${paths.join(",")}`);
    },
    async commit() {
      return "0123456789";
    },
    async diffNames() {
      return ["a.md"];
    },
    async branches() {
      return { current: "main", branches: ["main", "side"] };
    },
    async checkout(_dir, ref, opts) {
      calls.push(`checkout ${ref}${opts?.create ? " -b" : ""}`);
    },
  };

  beforeEach(async () => {
    await seed();
    calls.length = 0;
    shell = new BuiltinShell(fs, { git: fake });
  });

  it("status names the branch and the rows", async () => {
    const r = await run("git status");
    expect(r.out).toContain("On branch main");
    expect(r.out).toContain("a.md");
  });

  it("log shortens the oid and takes the first line of the message", async () => {
    expect((await run("git log")).out).toBe("abcdef1 2023-11-14 first\n");
  });

  it("diff falls back to names when the package has no textual diff", async () => {
    const r = await run("git diff");
    expect(r.out).toContain("a.md");
    expect(r.out).toContain("names only");
  });

  it("uses a real diff when there is one", async () => {
    shell = new BuiltinShell(fs, { git: { ...fake, diff: async () => "diff --git a/a.md b/a.md\n" } });
    expect((await run("git diff")).out).toContain("diff --git");
  });

  it("add and commit reach the backend; a commit with no message is refused", async () => {
    await run("git add .");
    expect(calls).toContain("add .");
    expect((await run("git commit")).err).toContain("needs a message");
    expect((await run('git commit -m "why"')).out).toContain("[0123456] why");
  });

  it("branch lists with a star, and creates when named", async () => {
    expect((await run("git branch")).out).toBe("* main\n  side\n");
    await run("git branch feature");
    expect(calls).toContain("checkout feature -b");
  });

  it("checkout switches, and -b creates", async () => {
    await run("git checkout side");
    expect(calls).toContain("checkout side");
    await run("git switch -c other");
    expect(calls).toContain("checkout other -b");
  });

  it("clone, push and pull are refused with the sentence, not silence", async () => {
    for (const sub of ["clone https://x", "push", "pull", "fetch"]) {
      const r = await run(`git ${sub}`);
      expect(r.code).toBe(127);
      expect(r.err).toContain(GIT_REMOTE_LINE);
    }
  });

  it("a subcommand this shell does not know says so", async () => {
    expect((await run("git rebase")).err).toContain("not a subcommand");
  });

  it("without a backend, git says there is none rather than throwing", async () => {
    const bare = new BuiltinShell(fs);
    const r = await bare.exec("git status", { cwd: "workspace" });
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toContain("no git backend");
  });
});
