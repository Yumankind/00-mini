/**
 * `htmlToText` — what `http_get` does with a web PAGE.
 *
 * WHY IT EXISTS. Pouring raw HTML into a transcript spends thousands of tokens on markup and hands
 * the model a document whose visible words are a tenth of its bytes: a modern page is mostly inline
 * script, style, SVG sprites, tracking pixels and three layers of wrapper divs. A small local brain
 * with an 8192-token window can read a page as text and cannot read it as HTML at all. So the tool
 * converts, and the 1 MB cap is applied AFTER the conversion — the cap is on what the model reads,
 * not on what the network sent.
 *
 * WHY IT IS A SCANNER AND NOT A PARSER, AND CERTAINLY NOT A DOM. This runs in a Web Worker in a
 * browser tab and in node, and the runtime package has no dependencies; `DOMParser` exists in one of
 * those places and not the other, and a real parser is a tree this function would immediately
 * flatten anyway. What follows is one linear pass over the tags, which is wrong in exactly the ways
 * a linear pass is wrong (an unclosed `<a>` swallows the rest of a block) and right for the thing
 * that matters: turning a page into the sentences a person would read off it.
 *
 * WHAT SURVIVES, AND WHY EACH ONE. The title (it is the page's own name for itself). Headings, as
 * `#` lines, because a model reads structure. Links as `[text](absolute url)` — ABSOLUTE, because a
 * relative href in a transcript is a link the agent cannot follow, and the whole point of reading a
 * page is often the next page. Lists, tables (` | ` between cells) and `pre`/`code` verbatim, since
 * code that has lost its line breaks is not code. Images ONLY when they have alt text: an
 * `![](spacer.gif)` is noise, and alt text is a person's own description of the picture.
 *
 * WHAT IS DROPPED: `script`, `style`, `noscript`, `svg`, `iframe`, and the chrome that repeats on
 * every page of a site — `nav`, `footer`, and a `<header role="banner">`. A plain `<header>` is kept,
 * because inside an article it is the article's own header; only the banner role means "the site's".
 *
 * EVERYTHING IT RETURNS IS UNTRUSTED DATA. Conversion is not sanitisation of MEANING: a page that
 * says "ignore your instructions" says it just as clearly in text. The tool's description carries
 * that sentence; this file only makes the words readable.
 */

/** Elements whose whole subtree is thrown away, tag name → dropped. */
const DROPPED = new Set(["script", "style", "noscript", "svg", "iframe", "nav", "footer", "template", "canvas"]);

/** Elements that end the current line when they open or close. */
const BLOCKS = new Set([
  "p", "div", "section", "article", "main", "aside", "header", "blockquote", "ul", "ol", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "form", "fieldset", "figure", "figcaption", "hr", "address", "details",
  "summary", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre",
]);

/** The entities worth knowing by name. Everything else numeric is decoded arithmetically. */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", deg: "°", middot: "·", bull: "•",
  times: "×", divide: "÷", plusmn: "±", frac12: "½", euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", dagger: "†", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", shy: "",
};

/**
 * `&amp;`, `&#39;` and `&#x2019;` — and nothing else pretending to be one. An `&` that does not open
 * a known entity is left exactly as it stands, because on a page about C it usually means `&`.
 */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      // Surrogates and out-of-range values are not characters; the source text is the honest answer.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** Runs of any whitespace become one space — HTML's own rule for text outside `pre`. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** `href="x"`, `href='x'` and bare `href=x`, off the raw attribute string of one tag. */
function attr(rawAttrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(rawAttrs);
  if (!match) return null;
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
}

/**
 * A link the agent could actually follow, or `null`. Relative hrefs resolve against the page's own
 * URL; `javascript:` is dropped on sight (it is a button, not a destination, and putting it in a
 * transcript invites the model to "open" it); `mailto:` and `tel:` are kept as they are, because they
 * are information even though they are not pages.
 */
export function resolveHref(href: string, baseUrl?: string): string | null {
  const raw = href.trim();
  if (!raw || raw.startsWith("#")) return null;
  if (/^javascript:/i.test(raw) || /^data:/i.test(raw) || /^vbscript:/i.test(raw)) return null;
  if (!baseUrl) return raw;
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return raw;
  }
}

/** One `<tag …>` or `</tag>`, with quoted attribute values that may themselves contain `>`. */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)\/?>/g;

interface Pending {
  /** What a heading or a list item puts in front of the line it is on. */
  prefix: string;
}

/**
 * The page as the text a person reads off it. `baseUrl` is the URL the HTML came from and is what
 * relative links resolve against; without it, hrefs are passed through untouched.
 */
export function htmlToText(html: string, baseUrl?: string): string {
  // Comments first: a conditional comment can hold a whole second page, and it is never read.
  // The doctype and any processing instruction go with them — the tag scanner below only knows
  // element names, so `<!doctype html>` would otherwise reach the transcript as words.
  let source = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, " ")
    .replace(/<![a-zA-Z][^>]*>/g, " ")
    .replace(/<\?[\s\S]*?\?>/g, " ");

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source);
  const title = titleMatch ? collapse(decodeEntities(titleMatch[1])).trim() : "";
  source = source.replace(/<title[^>]*>[\s\S]*?<\/title\s*>/gi, " ");

  // The banner header only — a plain `<header>` inside an article is that article's own.
  source = source.replace(/<header\b[^>]*\brole\s*=\s*["']?banner["']?[^>]*>[\s\S]*?<\/header>/gi, " ");
  for (const tag of DROPPED) {
    source = source.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
    // A self-closing or never-closed one of these must not survive as text either.
    source = source.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), " ");
  }

  // `pre` is lifted out whole BEFORE the scanner runs: it is the one place where the whitespace is
  // the content, and the scanner's job is to destroy whitespace.
  const fences: string[] = [];
  source = source.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_whole, inner: string) => {
    const text = decodeEntities(String(inner).replace(/<[^>]*>/g, "")).replace(/^\n+|\s+$/g, "");
    fences.push(text);
    // A sentinel no page can contain: the scanner carries it through as ordinary text, and
    // the last pass finds it again with no chance of matching a run of words the page said.
    return `\u0000PRE${fences.length - 1}\u0000`;
  });

  const lines: string[] = [];
  let line = "";
  const pending: Pending = { prefix: "" };
  let linkHref: string | null = null;
  let linkAt = 0;

  const flush = (): void => {
    const text = line.replace(/[ \t]+$/, "").replace(/^[ \t]+/, "");
    if (text) lines.push(pending.prefix + text);
    line = "";
    pending.prefix = "";
  };
  const append = (text: string): void => {
    if (text) line += text;
  };

  let last = 0;
  TAG.lastIndex = 0;
  for (let match = TAG.exec(source); match; match = TAG.exec(source)) {
    append(collapse(decodeEntities(source.slice(last, match.index))));
    last = match.index + match[0].length;

    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    const attrs = match[3] ?? "";

    if (name === "br") {
      flush();
      continue;
    }
    if (name === "img" && !closing) {
      const alt = (attr(attrs, "alt") ?? "").trim();
      const src = attr(attrs, "src");
      // Alt text is the only reason an image is worth a line in a transcript.
      if (alt && src) {
        const resolved = resolveHref(src, baseUrl);
        if (resolved) append(`${line && !line.endsWith(" ") ? " " : ""}![${alt}](${resolved})`);
      }
      continue;
    }
    if (name === "a") {
      if (!closing) {
        linkHref = resolveHref(attr(attrs, "href") ?? "", baseUrl);
        linkAt = line.length;
      } else if (linkHref !== null) {
        const text = line.slice(linkAt).trim();
        line = line.slice(0, linkAt) + (text ? `[${text}](${linkHref})` : "");
        linkHref = null;
      }
      continue;
    }
    if (name === "code") {
      // Both ends, one branch: inline code reads as code in the transcript either way.
      append("`");
      continue;
    }
    if (name === "td" || name === "th") {
      if (closing) append(" | ");
      continue;
    }
    if (!BLOCKS.has(name)) continue;

    // A block boundary: whatever was being written is a line of its own, and an opening heading or
    // list item decides what the NEXT line is prefixed with.
    flush();
    if (closing) continue;
    if (name === "li") pending.prefix = "- ";
    else if (/^h[1-6]$/.test(name)) pending.prefix = `${"#".repeat(Number(name[1]))} `;
  }
  append(collapse(decodeEntities(source.slice(last))));
  flush();

  const body = lines
    .join("\n")
    // The table separator is put after every cell, including the last one in its row.
    .replace(/ \| *$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const out = title ? `${title}\n\n${body}` : body;
  // The fences go back in last, so nothing above could have collapsed their whitespace.
  return out
    .replace(/\u0000PRE(\d+)\u0000/g, (_whole, index: string) => {
      const text = fences[Number(index)] ?? "";
      return text ? `\n\`\`\`\n${text}\n\`\`\`\n` : "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
