/**
 * Markdown, small enough to read in one sitting — the thread's answers and the editor's preview.
 *
 * WHY NOT A DEPENDENCY. The app's promise is "no install, offline, works with nothing"; marked and
 * markdown-it are 30–60 KB gzipped for a feature that renders what an agent actually writes: prose,
 * lists, tables, quotes, links, pictures and fenced code. This is those, nested lists and task lists
 * included, in one file with no imports.
 *
 * WHY IT ESCAPES FIRST AND ALWAYS. The text being rendered is what a MODEL wrote, and the model has
 * read web pages. So every character of input is HTML-escaped BEFORE any markup is added, and no
 * rule ever emits an attribute it did not build itself: a link's href is checked against a scheme
 * allowlist (`javascript:` is dropped to `#`), an image that is not http(s) is emitted with NO `src`
 * at all (see `MarkdownBlock.vue`, which fills one in from the agent's own filesystem), and raw HTML
 * in the source stays visible as text rather than becoming markup. That makes this renderer safe to
 * put in the app's own document — the PREVIEW pane, which renders untrusted HTML on purpose, is a
 * sandboxed iframe instead, and the two must not be confused.
 *
 * WHAT IT DOES NOT DO ITSELF. The copy button in a fenced block's header is emitted here but WIRED
 * by the component, through one delegated listener: a renderer that returned live handlers would be
 * a renderer that had to be trusted with the document, and this one only ever returns a string.
 */
import { highlight } from "./highlight.js";

const SAFE_SCHEME = /^(?:https?:|mailto:|#|\/|\.{0,2}\/)/i;
/** `blob:` and `data:` are ours — `MarkdownBlock.vue` writes them after it has read the bytes. */
const IMG_SCHEME = /^(?:https?:|blob:|data:image\/)/i;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A link target we are willing to put in an `href`. Anything else becomes `#`. */
export function safeHref(href: string): string {
  const trimmed = href.trim();
  return SAFE_SCHEME.test(trimmed) ? trimmed : "#";
}

/**
 * An image's two answers: a web picture keeps its URL, and anything else (`shot.png`,
 * `workspace/projects/site/logo.svg`) is a WORKSPACE PATH that only the agent's filesystem can
 * resolve. The second kind is emitted without a `src`, so the browser never fires a request for a
 * path it cannot reach, and `data-md-src` carries the path to whoever can.
 */
export function imageSrc(src: string): { src: string | null; path: string | null } {
  const trimmed = src.trim();
  if (IMG_SCHEME.test(trimmed)) return { src: trimmed, path: null };
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return { src: null, path: null }; // some other scheme: neither
  return { src: null, path: trimmed.replace(/^\.\//, "") };
}

/** Inline rules, applied to already-escaped text: code, bold, italic, strikethrough, links, images. */
export function renderInline(escaped: string): string {
  let out = escaped;
  // Code first: what is inside a backtick span must not then be read as emphasis.
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_all, body: string) => {
    codes.push(body);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, alt: string, src: string) => {
    const resolved = imageSrc(src);
    if (resolved.src) return `<img src="${resolved.src}" alt="${alt}" loading="lazy" />`;
    if (resolved.path) return `<img data-md-src="${resolved.path}" alt="${alt}" loading="lazy" />`;
    return `<img alt="${alt}" />`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_all, label: string, href: string) =>
    `<a href="${safeHref(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  // A bare URL on its own is a link too — an agent writes them constantly and a blue word is easier
  // to reach than a copied line. Only http(s), and never inside an `href` we have just written.
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>")]+)/g, (_all, before: string, url: string) =>
    `${before}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return out.replace(/\u0000CODE(\d+)\u0000/g, (_all, i: string) => `<code>${codes[Number(i)]}</code>`);
}

interface Block {
  kind: "p" | "h" | "ul" | "ol" | "code" | "quote" | "hr" | "table";
  level?: number;
  lang?: string;
  rows: string[];
}

const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HR = /^(-{3,}|\*{3,}|_{3,})\s*$/;

/** Group the lines into blocks. Split out so a test can pin the grouping without reading HTML. */
export function blocksOf(markdown: string): Block[] {
  const out: Block[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      const rows: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) rows.push(lines[i++]!);
      i++; // the closing fence, or the end of the file
      out.push({ kind: "code", lang: fence[1] || "", rows });
      continue;
    }
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ kind: "hr", rows: [] });
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push({ kind: "h", level: heading[1]!.length, rows: [heading[2]!] });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(lines[i++]!);
      out.push({ kind: "table", rows });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) rows.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", rows });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      // The WHOLE list, indentation kept: nesting is read from the leading spaces in `renderList`,
      // not from the grouping, so one block is one list however deep it goes.
      const rows: string[] = [];
      while (i < lines.length) {
        const next = lines[i]!;
        if (ITEM.test(next) && !HR.test(next)) {
          rows.push(next);
          i++;
          continue;
        }
        // A continuation line: indented, not blank, not a new block. It belongs to the item above.
        if (/^\s{2,}\S/.test(next) && !/^\s*```/.test(next)) {
          rows.push(next);
          i++;
          continue;
        }
        break;
      }
      out.push({ kind: /^\d/.test(item[2]!) ? "ol" : "ul", rows });
      continue;
    }
    const rows: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]!) &&
      !/^(#{1,6}\s|\s*```|\s*[-*+]\s|\s*>\s?|\s*\d+[.)]\s|\s*\|)/.test(lines[i]!) &&
      !HR.test(lines[i]!)
    ) {
      rows.push(lines[i++]!);
    }
    // A paragraph that swallowed nothing would loop forever; the line is its own paragraph instead.
    if (!rows.length) rows.push(lines[i++]!);
    out.push({ kind: "p", rows });
  }
  return out;
}

function tableCells(row: string): string[] {
  return row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

interface Item {
  indent: number;
  ordered: boolean;
  text: string;
  /** `null` when the item is not a task; the checkbox state otherwise. */
  done: boolean | null;
  children: Item[];
}

/** Rows with their leading spaces → a tree of items. Two spaces of indent is one level. */
export function listItems(rows: string[]): Item[] {
  const flat: Item[] = [];
  for (const row of rows) {
    const match = ITEM.exec(row);
    if (!match) {
      // A continuation line: more of the item above, joined with a space.
      const last = flat[flat.length - 1];
      if (last) last.text = `${last.text} ${row.trim()}`;
      continue;
    }
    const text = match[3]!;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    flat.push({
      indent: match[1]!.length,
      ordered: /^\d/.test(match[2]!),
      text: task ? task[2]! : text,
      done: task ? task[1]!.toLowerCase() === "x" : null,
      children: [],
    });
  }
  const roots: Item[] = [];
  const stack: Item[] = [];
  for (const item of flat) {
    while (stack.length && stack[stack.length - 1]!.indent >= item.indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(item);
    else roots.push(item);
    stack.push(item);
  }
  return roots;
}

function renderItems(items: Item[], ordered: boolean): string {
  const tasks = items.some((item) => item.done !== null);
  const tag = ordered ? "ol" : "ul";
  const body = items
    .map((item) => {
      const inner = renderInline(escapeHtml(item.text));
      const nested = item.children.length ? renderItems(item.children, item.children[0]!.ordered) : "";
      if (item.done === null) return `<li>${inner}${nested}</li>`;
      // `disabled` because the box is a picture of the file's state, not a control over it: a click
      // that ticked it would change nothing on disk and would be a lie about having done so.
      const box = `<input type="checkbox" disabled${item.done ? " checked" : ""} />`;
      return `<li class="md-task${item.done ? " is-done" : ""}">${box}<span>${inner}${nested}</span></li>`;
    })
    .join("");
  return `<${tag}${tasks ? ' class="md-tasks"' : ""}>${body}</${tag}>`;
}

/**
 * A fenced block: the language on a header line, a copy button beside it, and the source coloured by
 * `lib/highlight.ts` — which escapes every character it emits, as this file does.
 */
function renderCode(lang: string, source: string): string {
  const label = lang ? escapeHtml(lang) : "code";
  const attr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
  const head = `<div class="md-code-head"><span class="md-lang">${label}</span><button type="button" class="md-copy">Copy</button></div>`;
  return `<div class="md-code"${attr}>${head}<pre${attr}><code>${highlight(source, lang)}</code></pre></div>`;
}

/** Markdown → HTML, safe to put in the app's own document (see the module header). */
export function renderMarkdown(markdown: string): string {
  const out: string[] = [];
  for (const block of blocksOf(markdown)) {
    const inline = (text: string): string => renderInline(escapeHtml(text));
    switch (block.kind) {
      case "code":
        out.push(renderCode(block.lang ?? "", block.rows.join("\n")));
        break;
      case "h":
        out.push(`<h${block.level}>${inline(block.rows[0] ?? "")}</h${block.level}>`);
        break;
      case "hr":
        out.push("<hr />");
        break;
      case "ul":
      case "ol":
        out.push(renderItems(listItems(block.rows), block.kind === "ol"));
        break;
      case "quote":
        // A quote can hold blocks of its own — a list in an aside is ordinary in an agent's notes.
        out.push(`<blockquote>${renderMarkdown(block.rows.join("\n"))}</blockquote>`);
        break;
      case "table": {
        const [head, divider, ...body] = block.rows;
        // `:---`, `:---:` and `---:` are the three alignments a table row may ask for.
        const aligns = tableCells(divider ?? "").map((cell) => {
          const left = cell.startsWith(":");
          const right = cell.endsWith(":");
          return left && right ? "center" : right ? "right" : left ? "left" : "";
        });
        const attr = (i: number): string => (aligns[i] ? ` style="text-align:${aligns[i]}"` : "");
        const headCells = tableCells(head ?? "").map((c, i) => `<th${attr(i)}>${inline(c)}</th>`).join("");
        const bodyRows = body
          .map((row) => `<tr>${tableCells(row).map((c, i) => `<td${attr(i)}>${inline(c)}</td>`).join("")}</tr>`)
          .join("");
        out.push(`<table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table>`);
        break;
      }
      default:
        out.push(`<p>${inline(block.rows.join("\n")).replace(/\n/g, "<br />")}</p>`);
    }
  }
  return out.join("\n");
}
