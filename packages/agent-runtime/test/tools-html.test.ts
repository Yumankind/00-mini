// A web page as the text a person reads off it (tools-html.ts): what survives, what is dropped, and
// what a link turns into. Every case here is a page shape that actually exists in the wild.

import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText, resolveHref } from "../src/index.js";

const BASE = "https://example.com/docs/guide.html";

describe("entities", () => {
  it("decodes the named ones, the numeric ones and the hex ones", () => {
    expect(decodeEntities("a &amp; b")).toBe("a & b");
    expect(decodeEntities("&lt;div&gt; &quot;x&quot; &apos;y&apos;")).toBe(`<div> "x" 'y'`);
    expect(decodeEntities("caf&#233; &#x2014; open")).toBe("café — open");
    expect(decodeEntities("&nbsp;&mdash;&hellip;&rsquo;")).toBe(" —…’");
    expect(decodeEntities("&COPY;")).toBe("©");
  });

  it("leaves alone anything that only looks like one", () => {
    // A page about C says `a & b` and `&notarealentity;` means nothing; inventing a character for
    // either would corrupt the text the model reads.
    expect(decodeEntities("a & b")).toBe("a & b");
    expect(decodeEntities("&notanentity;")).toBe("&notanentity;");
    expect(decodeEntities("&#0; &#xD800; &#1114112;")).toBe("&#0; &#xD800; &#1114112;");
    expect(decodeEntities("no ampersand here")).toBe("no ampersand here");
  });
});

describe("links", () => {
  it("resolves against the page it came from", () => {
    expect(resolveHref("../api/index.html", BASE)).toBe("https://example.com/api/index.html");
    expect(resolveHref("/about", BASE)).toBe("https://example.com/about");
    expect(resolveHref("https://other.test/x", BASE)).toBe("https://other.test/x");
  });

  it("drops the ones that are not destinations", () => {
    expect(resolveHref("javascript:alert(1)", BASE)).toBeNull();
    expect(resolveHref("JavaScript:void(0)", BASE)).toBeNull();
    expect(resolveHref("data:text/html,<b>x</b>", BASE)).toBeNull();
    expect(resolveHref("#section", BASE)).toBeNull();
    expect(resolveHref("   ", BASE)).toBeNull();
  });

  it("passes an href through untouched when there is no page URL to resolve against", () => {
    expect(resolveHref("/about")).toBe("/about");
    expect(resolveHref("../up", "not a url")).toBe("../up");
  });
});

describe("htmlToText", () => {
  it("keeps the title, the headings, the paragraphs and the lists", () => {
    const text = htmlToText(
      `<html><head><title>The Guide</title></head><body>
        <h1>Getting started</h1>
        <p>Install it, then run it.</p>
        <h2>Notes</h2>
        <ul><li>One</li><li>Two</li></ul>
      </body></html>`,
      BASE,
    );
    expect(text).toBe(
      ["The Guide", "", "# Getting started", "Install it, then run it.", "## Notes", "- One", "- Two"].join("\n"),
    );
  });

  it("turns a link into [text](absolute url) and an image into ![alt](src), alt-less images aside", () => {
    const text = htmlToText(
      `<p>See the <a href="../api/index.html">API reference</a> for more.</p>
       <p><img src="/img/logo.png" alt="The logo"><img src="/img/spacer.gif" alt=""><img src="/img/x.png"></p>`,
      BASE,
    );
    expect(text).toContain("See the [API reference](https://example.com/api/index.html) for more.");
    expect(text).toContain("![The logo](https://example.com/img/logo.png)");
    expect(text).not.toContain("spacer.gif");
    expect(text).not.toContain("x.png");
  });

  it("keeps a javascript: link's words and throws the link away", () => {
    const text = htmlToText(`<p><a href="javascript:pay()">Buy now</a> today</p>`, BASE);
    expect(text).toBe("Buy now today");
  });

  it("drops an empty link rather than leaving brackets behind", () => {
    expect(htmlToText(`<p>before<a href="/x"></a>after</p>`, BASE)).toBe("beforeafter");
  });

  it("drops script, style, noscript, svg, nav, footer, iframe and a banner header", () => {
    const text = htmlToText(
      `<header role="banner"><p>Site name</p></header>
       <nav><a href="/a">Home</a></nav>
       <script>var secret = "tracking";</script>
       <style>.x{color:red}</style>
       <noscript>Turn on JavaScript</noscript>
       <svg><path d="M0 0"/></svg>
       <iframe src="https://ads.test/x"></iframe>
       <main><p>The actual article.</p></main>
       <footer><p>Copyright 2026</p></footer>`,
      BASE,
    );
    expect(text).toBe("The actual article.");
  });

  it("keeps a plain <header>, which inside an article is the article's own", () => {
    const text = htmlToText(`<article><header><h1>A title</h1></header><p>Body.</p></article>`, BASE);
    expect(text).toBe("# A title\nBody.");
  });

  it("preserves a <pre> block's own whitespace and fences it", () => {
    const text = htmlToText(
      `<p>Run this:</p><pre><code>if (a) {\n  b();\n}</code></pre><p>Then reload.</p>`,
      BASE,
    );
    expect(text).toContain("```\nif (a) {\n  b();\n}\n```");
    expect(text.startsWith("Run this:")).toBe(true);
    expect(text.endsWith("Then reload.")).toBe(true);
  });

  it("drops an empty <pre> instead of fencing nothing, and backticks inline code", () => {
    expect(htmlToText(`<p>a</p><pre></pre><p>b</p>`, BASE)).toBe("a\n\nb");
    expect(htmlToText(`<p>Call <code>run()</code> twice.</p>`, BASE)).toBe("Call `run()` twice.");
  });

  it("separates table cells with a pipe and ends the row with the row", () => {
    const text = htmlToText(
      `<table><tr><th>Name</th><th>Size</th></tr><tr><td>gemma</td><td>2 GB</td></tr></table>`,
      BASE,
    );
    expect(text).toBe("Name | Size\ngemma | 2 GB");
  });

  it("collapses whitespace, breaks on <br>, and never leaves three blank lines", () => {
    const text = htmlToText(`<p>one      two\n\n   three</p><p>four<br>five</p>`, BASE);
    expect(text).toBe("one two three\nfour\nfive");
  });

  it("reads a page with no title, no base URL and unclosed tags without throwing", () => {
    // An `<a>` that is never closed keeps its words and loses its href — the honest outcome of one
    // linear pass, and the one the module's header names.
    expect(htmlToText(`<p>first<p>second<a href="/x">link`)).toBe("first\nsecondlink");
    expect(htmlToText("")).toBe("");
    expect(htmlToText("just words, no tags at all")).toBe("just words, no tags at all");
  });

  it("throws away comments, including a conditional one carrying a whole page", () => {
    expect(htmlToText(`<p>real</p><!-- <p>hidden</p> -->`, BASE)).toBe("real");
  });

  it("reads an attribute quoted three ways, and one that is not there", () => {
    const text = htmlToText(`<a href='/one'>one</a> <a href=/two>two</a> <a>three</a>`, BASE);
    expect(text).toContain("[one](https://example.com/one)");
    expect(text).toContain("[two](https://example.com/two)");
    expect(text).toContain("three");
    expect(text).not.toContain("[three]");
  });
});
