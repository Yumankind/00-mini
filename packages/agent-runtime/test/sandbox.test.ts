import { describe, expect, it } from "vitest";
import { PathEscapeError, globToRegExp, normalizeSandbox, relativeToSandbox, resolveInSandbox } from "../src/index.js";

describe("resolveInSandbox", () => {
  it("maps a tool-relative path onto the agent root", () => {
    expect(resolveInSandbox("workspace", "AGENTS.md")).toBe("workspace/AGENTS.md");
    expect(resolveInSandbox("workspace", "memory/2026-09-10.md")).toBe("workspace/memory/2026-09-10.md");
    expect(resolveInSandbox("threads-fs/telegram/42", "conversation.md")).toBe("threads-fs/telegram/42/conversation.md");
  });

  it("treats an absent or dot path as the sandbox root — which is what `ls` with no argument means", () => {
    expect(resolveInSandbox("workspace")).toBe("workspace");
    expect(resolveInSandbox("workspace", "")).toBe("workspace");
    expect(resolveInSandbox("workspace", ".")).toBe("workspace");
    expect(resolveInSandbox("workspace", "./projects/")).toBe("workspace/projects");
  });

  it("resolves . and .. before checking containment, and refuses anything that climbs out", () => {
    expect(resolveInSandbox("workspace", "projects/../files/a.png")).toBe("workspace/files/a.png");
    for (const attempt of ["../vault.json", "../../etc/passwd", "projects/../../sessions", ".."]) {
      expect(() => resolveInSandbox("workspace", attempt)).toThrow(PathEscapeError);
    }
  });

  it("reads a leading slash as agent-root-absolute, so pi-style absolute paths still land inside", () => {
    expect(resolveInSandbox("workspace", "/workspace/SOUL.md")).toBe("workspace/SOUL.md");
    expect(() => resolveInSandbox("workspace", "/vault.json")).toThrow(PathEscapeError);
    expect(() => resolveInSandbox("workspace", "/workspaces/other")).toThrow(PathEscapeError);
  });

  it("refuses a NUL byte rather than handing it to an adapter", () => {
    expect(() => resolveInSandbox("workspace", "a\0b")).toThrow(PathEscapeError);
  });

  it("never lets one sandbox reach another", () => {
    expect(() => resolveInSandbox("threads-fs/telegram/42", "../43/conversation.md")).toThrow(PathEscapeError);
    expect(() => resolveInSandbox("threads-fs/telegram/42", "/workspace/MEMORY.md")).toThrow(PathEscapeError);
  });

  it("normalises the sandbox itself and refuses a nonsense one", () => {
    expect(normalizeSandbox("workspace/")).toBe("workspace");
    expect(normalizeSandbox("./workspace")).toBe("workspace");
    expect(() => normalizeSandbox("..")).toThrow();
    expect(() => normalizeSandbox("")).toThrow();
  });

  it("relativeToSandbox is the inverse the model reads", () => {
    expect(relativeToSandbox("workspace", "workspace/memory/a.md")).toBe("memory/a.md");
    expect(relativeToSandbox("workspace", "workspace")).toBe(".");
    expect(relativeToSandbox("workspace", "elsewhere/x")).toBe("elsewhere/x");
  });
});

describe("globToRegExp", () => {
  it("matches a bare pattern against the basename at any depth, like fd does", () => {
    const re = globToRegExp("*.md");
    expect(re.test("MEMORY.md")).toBe(true);
    expect(re.test("memory/2026-09-10.md")).toBe(true);
    expect(re.test("notes.txt")).toBe(false);
  });

  it("anchors a pattern that contains a slash", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/deep/index.ts")).toBe(false);
    expect(re.test("other/src/index.ts")).toBe(false);
  });

  it("lets ** cross directories, including zero of them", () => {
    const re = globToRegExp("**/*.spec.ts");
    expect(re.test("a.spec.ts")).toBe(true);
    expect(re.test("src/deep/a.spec.ts")).toBe(true);
    expect(re.test("src/a.ts")).toBe(false);
  });

  it("handles ? and escapes regex metacharacters in literal parts", () => {
    expect(globToRegExp("a?c.md").test("abc.md")).toBe(true);
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("v[0-9].md").test("v2.md")).toBe(true);
  });
});
