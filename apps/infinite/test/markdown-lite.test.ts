import { describe, expect, it } from "vitest";
import { blocksOf, escapeHtml, imageSrc, listItems, renderInline, renderMarkdown, safeHref } from "../src/lib/markdown-lite.js";
import { highlight, normalizeLang } from "../src/lib/highlight.js";

/**
 * The renderer the thread reads answers through. The safety half is pinned in `power-panes.test.ts`
 * (it was written with the renderer and stays with the panes it was written for); this file is the
 * constructs the 2026-09-11 redesign added, and the rule that every one of them escapes first.
 */

describe("markdown-lite: the constructs an answer contains", () => {
  it("nests a list by its indentation", () => {
    const html = renderMarkdown("- one\n  - deep\n  - deeper\n- two\n");
    expect(html).toBe("<ul><li>one<ul><li>deep</li><li>deeper</li></ul></li><li>two</li></ul>");
  });

  it("reads an ordered list nested inside an unordered one", () => {
    const items = listItems(["- steps", "  1. first", "  2. second"]);
    expect(items).toHaveLength(1);
    expect(items[0]!.children.map((c) => c.ordered)).toEqual([true, true]);
    expect(renderMarkdown("- steps\n  1. first\n")).toContain("<ol>");
  });

  it("joins a continuation line onto the item above it", () => {
    const html = renderMarkdown("- one line\n  and its wrap\n");
    expect(html).toBe("<ul><li>one line and its wrap</li></ul>");
  });

  it("renders a task list with disabled boxes and a done class", () => {
    const html = renderMarkdown("- [x] done\n- [ ] not yet\n");
    expect(html).toContain('<ul class="md-tasks">');
    expect(html).toContain('<li class="md-task is-done"><input type="checkbox" disabled checked />');
    expect(html).toContain('<li class="md-task"><input type="checkbox" disabled />');
  });

  it("keeps a table's alignment row", () => {
    const html = renderMarkdown("| a | b |\n| :-- | --: |\n| 1 | 2 |\n");
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<th style="text-align:right">b</th>');
    expect(html).toContain('<td style="text-align:right">2</td>');
  });

  it("renders blocks inside a quote, not one flat line", () => {
    const html = renderMarkdown("> a note\n> - with a list\n");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<ul><li>with a list</li></ul>");
  });

  it("draws a rule for each of the three spellings", () => {
    for (const rule of ["---", "***", "___"]) expect(renderMarkdown(rule)).toBe("<hr />");
  });

  it("opens links in a new tab and never trusts their scheme", () => {
    expect(renderMarkdown("[x](https://a.example)")).toContain('target="_blank" rel="noopener noreferrer"');
    expect(renderMarkdown("[x](javascript:alert(1))")).toContain('href="#"');
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
  });

  it("links a bare URL without swallowing one it has already linked", () => {
    const once = renderMarkdown("see https://a.example/x for more");
    expect(once.match(/<a /g)).toHaveLength(1);
    const twice = renderMarkdown("[label](https://a.example/x)");
    expect(twice.match(/<a /g)).toHaveLength(1);
  });

  it("splits a web picture from a workspace path", () => {
    expect(imageSrc("https://a.example/x.png")).toEqual({ src: "https://a.example/x.png", path: null });
    expect(imageSrc("./shot.png")).toEqual({ src: null, path: "shot.png" });
    expect(imageSrc("workspace/p/logo.svg")).toEqual({ src: null, path: "workspace/p/logo.svg" });
    // Anything with another scheme is neither: no `src`, and nothing for the filesystem to look up.
    expect(imageSrc("javascript:alert(1)")).toEqual({ src: null, path: null });
  });

  it("emits a workspace picture with no src at all, so nothing is requested", () => {
    const html = renderMarkdown("![a shot](workspace/shot.png)");
    expect(html).toContain('<img data-md-src="workspace/shot.png" alt="a shot" loading="lazy" />');
    expect(html).not.toMatch(/\ssrc=/);
  });

  it("gives a fenced block its language, a copy button and coloured source", () => {
    const html = renderMarkdown("```ts\nconst x: string = \"hi\";\n```");
    expect(html).toContain('<div class="md-code" data-lang="ts">');
    expect(html).toContain('<button type="button" class="md-copy">Copy</button>');
    expect(html).toContain('<span class="tok-k">const</span>');
    expect(html).toContain('<span class="tok-s">&quot;hi&quot;</span>');
  });

  it("labels an unlabelled fence without inventing a language", () => {
    const html = renderMarkdown("```\nplain\n```");
    expect(html).toContain('<div class="md-code">');
    expect(html).toContain(">code</span>");
    expect(html).not.toContain("tok-");
  });

  it("still escapes before anything else, in every new construct", () => {
    expect(renderMarkdown("- <img src=x onerror=alert(1)>")).toContain("&lt;img");
    expect(renderMarkdown("| <b>a</b> |\n| --- |\n| x |")).toContain("&lt;b&gt;");
    expect(renderMarkdown("> <script>x</script>")).not.toContain("<script>");
    expect(renderMarkdown("```\n</code></pre><script>x</script>\n```")).not.toContain("<script>");
    expect(escapeHtml("a&b'c")).toBe("a&amp;b&#39;c");
  });

  it("keeps code spans out of the emphasis rules", () => {
    expect(renderInline(escapeHtml("`**not bold**` and **bold**"))).toBe(
      "<code>**not bold**</code> and <strong>bold</strong>",
    );
  });

  it("groups the blocks the way the renderer then walks them", () => {
    const kinds = blocksOf("# h\n\npara\n\n- a\n\n> q\n\n---\n\n1. x\n\n| a |\n| --- |\n| 1 |\n").map((b) => b.kind);
    expect(kinds).toEqual(["h", "p", "ul", "quote", "hr", "ol", "table"]);
  });
});

describe("the fenced block's highlighter", () => {
  it("folds a language's aliases into one", () => {
    expect(normalizeLang("Bash")).toBe("sh");
    expect(normalizeLang("TypeScript")).toBe("ts");
    expect(normalizeLang("brainfuck")).toBe("");
  });

  it("colours keywords, strings, comments and numbers in js", () => {
    const html = highlight('const n = 42; // why\nlet s = "x";', "js");
    expect(html).toContain('<span class="tok-k">const</span>');
    expect(html).toContain('<span class="tok-n">42</span>');
    expect(html).toContain('<span class="tok-c">// why</span>');
    expect(html).toContain('<span class="tok-s">&quot;x&quot;</span>');
  });

  it("reads a shell comment with # and a python keyword", () => {
    expect(highlight("# a note\nls -l", "bash")).toContain('<span class="tok-c"># a note</span>');
    expect(highlight("def f():\n    return 1", "python")).toContain('<span class="tok-k">def</span>');
  });

  it("marks json's three literals and nothing else", () => {
    const html = highlight('{"on": true, "n": 3}', "json");
    expect(html).toContain('<span class="tok-k">true</span>');
    expect(html).toContain('<span class="tok-s">&quot;on&quot;</span>');
  });

  it("treats an html tag as the keyword and its attribute value as a string", () => {
    const html = highlight('<a href="x">hi</a><!-- c -->', "html");
    expect(html).toContain('<span class="tok-k">&lt;a href=</span>');
    expect(html).toContain('<span class="tok-s">&quot;x&quot;</span>');
    expect(html).toContain('<span class="tok-c">&lt;!-- c --&gt;</span>');
  });

  it("marks a css property and a markdown heading", () => {
    expect(highlight("a { color: red; }", "css")).toContain('<span class="tok-k">color</span>');
    expect(highlight("# title\n> quote\nsome `code`", "md")).toContain('<span class="tok-k"># title</span>');
    expect(highlight("# title\n> quote\nsome `code`", "md")).toContain('<span class="tok-s">`code`</span>');
  });

  it("escapes everything it emits, including inside a string", () => {
    const html = highlight('const a = "</span><img onerror=x>";', "js");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("does not let one stray quote paint the rest of the block", () => {
    const html = highlight("it's fine\nconst a = 1;", "js");
    expect(html).toContain('<span class="tok-k">const</span>');
  });
});
