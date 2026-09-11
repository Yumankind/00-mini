import { beforeEach, describe, expect, it } from "vitest";
import { MemoryFs } from "@00/agent-fs";
import {
  childNames,
  filesUnder,
  findNode,
  insertNode,
  isEditablePath,
  isMarkdownPath,
  isPreviewablePath,
  nameProblem,
  parentOf,
  removeNode,
  renameNode,
  buildTree,
  EDITOR_MAX_BYTES,
} from "../src/lib/files-tree.js";
import { blocksOf, renderMarkdown, safeHref } from "../src/lib/markdown-lite.js";
import { collectRefs, ensureDocument, inlinePreview, mimeFor, resolveRelative } from "../src/lib/preview-resolve.js";
import { buildPreview } from "../src/power/preview.js";
import { changedUnderneath, gutter, indent, lineCount } from "../src/power/editor.js";
import { POWER_BREAKPOINT, layoutMode, resetLayout, setPower, setViewportWidth, mode, powerShell, showCentre, showPane, powerPane, centrePane, toggleTerminal, terminalVisible } from "../src/state/layout.js";
import { applyStatus, commitProblem, emptyGitState, projectRepos, selectRepo, splitStatus, statusLetter } from "../src/state/git.js";
import { appendRow, recall, rememberCommand } from "../src/state/terminal.js";
import { GIT_UNAVAILABLE, UNSTAGE_UNAVAILABLE, createPowerGit, gitUsable } from "../src/power/git-bridge.js";

/**
 * The pure halves of the power shell's panes. Everything here runs in a node runner because it was
 * split out of a component on purpose — see the module headers for which decision each one carries.
 */

describe("the files tree's mutations", () => {
  const tree = buildTree([
    { path: "workspace/AGENTS.md", stat: { size: 10 } },
    { path: "workspace/projects/site/index.html", stat: { size: 20 } },
    { path: "workspace/projects/site/app.js", stat: { size: 5 } },
  ]);

  it("finds a node and lists a folder's names", () => {
    expect(findNode(tree, "workspace/projects/site")?.kind).toBe("dir");
    expect(childNames(tree, "workspace/projects/site").sort()).toEqual(["app.js", "index.html"]);
    expect(childNames(tree, "")).toEqual(["workspace"]);
  });

  it("inserts into the right folder and keeps the folders-first order", () => {
    const next = insertNode(tree, "workspace/notes.md", "file", 3);
    const workspace = findNode(next, "workspace")!;
    expect(workspace.children!.map((c) => c.name)).toEqual(["projects", "AGENTS.md", "notes.md"]);
  });

  it("ignores an insert whose parent it has never seen, rather than inventing one", () => {
    expect(insertNode(tree, "elsewhere/deep/x.md", "file")).toBe(tree);
  });

  it("removes a node and everything under it", () => {
    const next = removeNode(tree, "workspace/projects/site");
    expect(findNode(next, "workspace/projects/site/app.js")).toBeNull();
    expect(findNode(next, "workspace/AGENTS.md")).not.toBeNull();
  });

  it("renames in place and rewrites the paths of the children", () => {
    const next = renameNode(tree, "workspace/projects/site", "shop");
    expect(findNode(next, "workspace/projects/shop/app.js")).not.toBeNull();
    expect(findNode(next, "workspace/projects/site")).toBeNull();
  });

  it("refuses the names a filesystem would refuse, before the write", () => {
    expect(nameProblem("")).toContain("needed");
    expect(nameProblem("a/b")).toContain("slashes");
    expect(nameProblem("..")).toContain("something else");
    expect(nameProblem("a.md", ["a.md"])).toContain("already");
    expect(nameProblem("fine.md", ["other.md"])).toBeNull();
  });

  it("knows what the editor will open and what the preview will render", () => {
    expect(isEditablePath("workspace/a.md", 10)).toBe(true);
    expect(isEditablePath("workspace/a.md", EDITOR_MAX_BYTES + 1)).toBe(false);
    expect(isEditablePath("workspace/a.png", 10)).toBe(false);
    expect(isMarkdownPath("a/b.MD")).toBe(true);
    expect(isPreviewablePath("a/b.html")).toBe(true);
    expect(isPreviewablePath("a/b.md")).toBe(false);
  });

  it("lists the files under a folder, for a download or a count", () => {
    expect(filesUnder(findNode(tree, "workspace/projects")!).sort()).toEqual([
      "workspace/projects/site/app.js",
      "workspace/projects/site/index.html",
    ]);
    expect(parentOf("a/b/c")).toBe("a/b");
    expect(parentOf("a")).toBe("");
  });
});

describe("markdown-lite", () => {
  it("escapes before it renders, so a file cannot inject markup", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops a javascript: href to #", () => {
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("./a.md")).toBe("./a.md");
  });

  it("renders the constructs an agent's own files contain", () => {
    const html = renderMarkdown("# Title\n\nsome **bold** and `code`\n\n- one\n- two\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
  });

  it("keeps a fenced block verbatim, emphasis and all", () => {
    // The source is coloured now (lib/highlight.ts), so the keyword sits in its own span and the
    // text is no longer one contiguous run. What must still hold is that NOTHING in a fence is read
    // as markdown: the asterisks survive as asterisks.
    const html = renderMarkdown("```js\nconst a = **not bold**;\n```");
    expect(html).toContain('<span class="tok-k">const</span>');
    expect(html).toContain("a = **not bold**;");
    expect(html).not.toContain("<strong>");
  });

  it("groups the blocks the way the renderer then walks them", () => {
    const kinds = blocksOf("# h\n\npara\n\n- a\n\n> q\n\n---\n\n1. x\n").map((b) => b.kind);
    expect(kinds).toEqual(["h", "p", "ul", "quote", "hr", "ol"]);
  });

  it("renders a table when the second row is the divider", () => {
    const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });
});

describe("the preview resolver", () => {
  const base = "workspace/projects/site/index.html";

  it("resolves relative and parent-relative references inside the workspace", () => {
    expect(resolveRelative(base, "./styles.css")).toBe("workspace/projects/site/styles.css");
    expect(resolveRelative(base, "../shared/a.css")).toBe("workspace/projects/shared/a.css");
    expect(resolveRelative(base, "img/logo.png")).toBe("workspace/projects/site/img/logo.png");
  });

  it("refuses a climb out of the agent's folder rather than clamping it", () => {
    expect(resolveRelative("index.html", "../../secret")).toBeNull();
  });

  it("leaves anything that is not ours alone", () => {
    for (const ref of ["https://cdn/x.css", "//cdn/x.css", "data:text/css,a{}", "#frag"]) {
      expect(resolveRelative(base, ref)).toBeNull();
    }
  });

  it("collects only the references it can inline", () => {
    const html = [
      '<link rel="stylesheet" href="a.css">',
      '<link rel="icon" href="favicon.ico">',
      '<script src="app.js"></script>',
      '<img src="logo.png" alt="x">',
    ].join("\n");
    const refs = collectRefs(html, base);
    expect(refs.map((r) => r.kind)).toEqual(["style", "script", "image"]);
  });

  it("inlines what it was given and leaves what it was not", () => {
    const html = '<link rel="stylesheet" href="a.css"><script src="app.js"></script><img src="logo.png">';
    const out = inlinePreview(
      html,
      base,
      new Map([
        ["workspace/projects/site/a.css", { text: "body{color:red}" }],
        ["workspace/projects/site/logo.png", { dataUrl: "data:image/png;base64,AAA" }],
      ]),
    );
    expect(out).toContain("<style data-from=\"a.css\">");
    expect(out).toContain("body{color:red}");
    expect(out).toContain('src="data:image/png;base64,AAA"');
    expect(out).toContain('<script src="app.js">'); // not loaded, so untouched
  });

  it("escapes a closing script tag inside an inlined script", () => {
    const out = inlinePreview(
      '<script src="a.js"></script>',
      base,
      new Map([["workspace/projects/site/a.js", { text: 'document.write("</script>")' }]]),
    );
    expect(out).toContain("<\\/script");
    expect(out.match(/<\/script/g)).toHaveLength(1);
  });

  it("wraps a fragment in a document, and leaves a whole one alone", () => {
    expect(ensureDocument("<p>hi</p>", "x.html")).toContain("<!doctype html>");
    expect(ensureDocument("<html><body>hi</body></html>", "x.html")).not.toContain("<!doctype html>");
  });

  it("knows the handful of MIME types a workspace page loads", () => {
    expect(mimeFor("a/b.css")).toBe("text/css");
    expect(mimeFor("a/b.png")).toBe("image/png");
    expect(mimeFor("a/b.bin")).toBe("application/octet-stream");
  });

  it("builds a whole page off a filesystem, and names what was not there", async () => {
    const fs = new MemoryFs();
    await fs.writeFile(
      "workspace/projects/site/index.html",
      '<html><head><link rel="stylesheet" href="a.css"></head><body><script src="gone.js"></script><img src="https://cdn/x.png"></body></html>',
    );
    await fs.writeFile("workspace/projects/site/a.css", "body{margin:0}");
    const built = await buildPreview(fs, "workspace/projects/site/index.html");
    expect(built.html).toContain("body{margin:0}");
    expect(built.missing).toEqual(["gone.js"]);
    expect(built.external).toEqual(["https://cdn/x.png"]);
  });
});

describe("the editor's keyboard", () => {
  it("inserts an indent at a bare caret", () => {
    expect(indent({ value: "ab", selectionStart: 1, selectionEnd: 1 })).toEqual({
      value: "a  b",
      selectionStart: 3,
      selectionEnd: 3,
    });
  });

  it("indents every line a selection touches", () => {
    const next = indent({ value: "a\nb\nc", selectionStart: 0, selectionEnd: 3 });
    expect(next.value).toBe("  a\n  b\nc");
  });

  it("outdents by up to one indent, and never past the margin", () => {
    const once = indent({ value: "    a\n  b", selectionStart: 0, selectionEnd: 9 }, true);
    expect(once.value).toBe("  a\nb");
    const twice = indent({ value: once.value, selectionStart: 0, selectionEnd: once.value.length }, true);
    expect(twice.value).toBe("a\nb");
  });

  it("counts the lines the gutter has to draw", () => {
    expect(lineCount("")).toBe(1);
    expect(lineCount("a\nb\n")).toBe(3);
    expect(gutter("a\nb")).toBe("1\n2");
  });

  it("notices a file that changed underneath, and does not cry wolf when it cannot know", () => {
    expect(changedUnderneath({ mtime: 10, size: 5 }, { mtime: 20, size: 5 })).toBe(true);
    expect(changedUnderneath({ mtime: 10, size: 5 }, { mtime: 10, size: 5 })).toBe(false);
    // An adapter with no clock answers 0; then only the size can say anything.
    expect(changedUnderneath({ mtime: 0, size: 5 }, { mtime: 0, size: 6 })).toBe(true);
    expect(changedUnderneath({ mtime: 0, size: 5 }, { mtime: 0, size: 5 })).toBe(false);
    expect(changedUnderneath(null, { mtime: 1, size: 1 })).toBe(false);
  });
});

describe("the layout rule", () => {
  beforeEach(() => resetLayout());

  it("is the simple shell whenever power is off, at every width", () => {
    for (const width of [320, 768, 1024, 1920]) expect(layoutMode(width, false)).toBe("simple");
  });

  it("is the IDE at and above 1024, and tabs below it", () => {
    expect(layoutMode(POWER_BREAKPOINT, true)).toBe("ide");
    expect(layoutMode(POWER_BREAKPOINT - 1, true)).toBe("tabs");
    expect(layoutMode(375, true)).toBe("tabs");
  });

  it("the store follows the same rule", () => {
    expect(mode.value).toBe("simple");
    setPower(true);
    setViewportWidth(1280);
    expect(powerShell.value).toBe(true);
    expect(mode.value).toBe("ide");
    setViewportWidth(800);
    expect(mode.value).toBe("tabs");
  });

  it("the centre is editor OR preview, and picking one is also picking the pane", () => {
    showCentre("preview");
    expect(centrePane.value).toBe("preview");
    expect(powerPane.value).toBe("preview");
    showPane("git");
    expect(centrePane.value).toBe("preview");
    expect(powerPane.value).toBe("git");
  });

  it("the terminal collapses", () => {
    expect(terminalVisible.value).toBe(true);
    toggleTerminal();
    expect(terminalVisible.value).toBe(false);
  });
});

describe("the git panel's reducer", () => {
  const tree = buildTree([
    { path: "workspace/projects/site/index.html", stat: { size: 1 } },
    { path: "workspace/projects/notes/a.md", stat: { size: 1 } },
    { path: "workspace/AGENTS.md", stat: { size: 1 } },
  ]);

  it("offers exactly the project folders, because a project is one folder", () => {
    expect(projectRepos(tree)).toEqual(["workspace/projects/notes", "workspace/projects/site"]);
    expect(projectRepos([])).toEqual([]);
  });

  it("splits the rows the two lists draw, and drops the unchanged", () => {
    const split = splitStatus([
      { path: "a", status: "modified", staged: false },
      { path: "b", status: "added", staged: true },
      { path: "c", status: "unmodified", staged: false },
    ]);
    expect(split.unstaged.map((e) => e.path)).toEqual(["a"]);
    expect(split.staged.map((e) => e.path)).toEqual(["b"]);
  });

  it("keeps a selected file's diff only while the file is still changed", () => {
    const start = { ...emptyGitState(), selected: "a", diff: "patch" };
    const still = applyStatus(start, { branch: "main", branches: ["main"], entries: [{ path: "a", status: "modified", staged: false }] });
    expect(still.diff).toBe("patch");
    const gone = applyStatus(start, { branch: "main", branches: ["main"], entries: [] });
    expect(gone.selected).toBeNull();
    expect(gone.diff).toBeNull();
  });

  it("clears everything when another repository is chosen, and nothing when the same one is", () => {
    const start = { ...emptyGitState(), repo: "workspace/projects/site", message: "why", log: [] };
    expect(selectRepo(start, "workspace/projects/site")).toBe(start);
    expect(selectRepo(start, "workspace/projects/notes").message).toBe("");
  });

  it("says why a commit cannot happen", () => {
    expect(commitProblem("", 0)).toBe("Nothing is staged.");
    expect(commitProblem("  ", 1)).toContain("needs a message");
    expect(commitProblem("why", 1)).toBeNull();
  });

  it("uses git's own letters", () => {
    expect(["modified", "added", "deleted", "untracked"].map(statusLetter)).toEqual(["M", "A", "D", "?"]);
  });
});

describe("the terminal's bookkeeping", () => {
  it("bounds the scrollback", () => {
    let rows = [] as ReturnType<typeof appendRow>;
    for (let i = 0; i < 5; i++) rows = appendRow(rows, { kind: "stdout", text: String(i) }, 3);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ kind: "stdout", text: "2" });
  });

  it("remembers a command once, never a blank, never a repeat", () => {
    let history = rememberCommand([], "ls");
    history = rememberCommand(history, "ls");
    history = rememberCommand(history, "   ");
    history = rememberCommand(history, "pwd");
    expect(history).toEqual(["ls", "pwd"]);
  });

  it("walks the history up and back to an empty line", () => {
    const history = ["a", "b", "c"];
    expect(recall(history, -1, -1)).toEqual({ index: 2, text: "c" });
    expect(recall(history, 2, -1)).toEqual({ index: 1, text: "b" });
    expect(recall(history, 0, -1)).toEqual({ index: 0, text: "a" });
    expect(recall(history, 2, 1)).toEqual({ index: -1, text: "" });
    expect(recall([], -1, -1)).toEqual({ index: -1, text: "" });
  });
});

describe("git's own availability", () => {
  it("refuses by name in a browser with no Buffer, instead of throwing isomorphic-git's error", async () => {
    const globals = globalThis as { Buffer?: unknown };
    const had = globals.Buffer;
    try {
      delete globals.Buffer;
      expect(gitUsable()).toBe(false);
      const git = createPowerGit(new MemoryFs());
      await expect(git.isRepo("workspace/projects/site")).rejects.toThrow(GIT_UNAVAILABLE);
      await expect(git.status("workspace/projects/site")).rejects.toThrow(GIT_UNAVAILABLE);
    } finally {
      globals.Buffer = had;
    }
    expect(gitUsable()).toBe(true);
  });

  it("unstaging is a named refusal, not a dead button", async () => {
    await expect(createPowerGit(new MemoryFs()).unstage("workspace", "a.md")).rejects.toThrow(UNSTAGE_UNAVAILABLE);
  });
});
