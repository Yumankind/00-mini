/**
 * Markdown, small enough to read in one sitting — the editor's preview toggle and nothing else.
 *
 * WHY NOT A DEPENDENCY. The app's promise is "no install, offline, works with nothing"; marked and
 * markdown-it are 30–60 KB gzipped for a feature that renders the six constructs an agent's own
 * `AGENTS.md`, `MEMORY.md` and notes actually contain. This is those six, plus tables, in 150 lines.
 *
 * WHY IT ESCAPES FIRST AND ALWAYS. The text being rendered is a file the AGENT wrote, and the agent
 * has read web pages. So every character of input is HTML-escaped BEFORE any markup is added, and no
 * rule ever emits an attribute it did not build itself: a link's href is checked against a scheme
 * allowlist (`javascript:` is dropped to `#`), and raw HTML in the source stays visible as text
 * rather than becoming markup. That makes this renderer safe to put in the app's own document — the
 * PREVIEW pane, which renders untrusted HTML on purpose, is a sandboxed iframe instead, and the two
 * must not be confused.
 */

const SAFE_SCHEME = /^(?:https?:|mailto:|#|\/|\.{0,2}\/)/i;

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

/** Inline rules, applied to already-escaped text: code, bold, italic, strikethrough, links, images. */
export function renderInline(escaped: string): string {
  let out = escaped;
  // Code first: what is inside a backtick span must not then be read as emphasis.
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_all, body: string) => {
    codes.push(body);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, alt: string, src: string) =>
    `<img src="${safeHref(src)}" alt="${alt}" />`,
  );
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_all, label: string, href: string) =>
    `<a href="${safeHref(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`,
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

/** Group the lines into blocks. Split out so a test can pin the grouping without reading HTML. */
export function blocksOf(markdown: string): Block[] {
  const out: Block[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const rows: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) rows.push(lines[i++]!);
      i++; // the closing fence, or the end of the file
      out.push({ kind: "code", lang: fence[1] || "", rows });
      continue;
    }
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
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
    if (/^\s*[-*+]\s+/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) rows.push(lines[i++]!.replace(/^\s*[-*+]\s+/, ""));
      out.push({ kind: "ul", rows });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) rows.push(lines[i++]!.replace(/^\s*\d+[.)]\s+/, ""));
      out.push({ kind: "ol", rows });
      continue;
    }
    const rows: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]!) && !/^(#{1,6}\s|```|\s*[-*+]\s|\s*>\s?|\s*\d+[.)]\s)/.test(lines[i]!)) {
      rows.push(lines[i++]!);
    }
    out.push({ kind: "p", rows });
  }
  return out;
}

function tableCells(row: string): string[] {
  return row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

/** Markdown → HTML, safe to put in the app's own document (see the module header). */
export function renderMarkdown(markdown: string): string {
  const out: string[] = [];
  for (const block of blocksOf(markdown)) {
    const inline = (text: string): string => renderInline(escapeHtml(text));
    switch (block.kind) {
      case "code":
        out.push(`<pre class="md-code"><code>${escapeHtml(block.rows.join("\n"))}</code></pre>`);
        break;
      case "h":
        out.push(`<h${block.level}>${inline(block.rows[0] ?? "")}</h${block.level}>`);
        break;
      case "hr":
        out.push("<hr />");
        break;
      case "ul":
        out.push(`<ul>${block.rows.map((r) => `<li>${inline(r)}</li>`).join("")}</ul>`);
        break;
      case "ol":
        out.push(`<ol>${block.rows.map((r) => `<li>${inline(r)}</li>`).join("")}</ol>`);
        break;
      case "quote":
        out.push(`<blockquote>${inline(block.rows.join(" "))}</blockquote>`);
        break;
      case "table": {
        const [head, , ...body] = block.rows;
        const headCells = tableCells(head ?? "").map((c) => `<th>${inline(c)}</th>`).join("");
        const bodyRows = body
          .map((row) => `<tr>${tableCells(row).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
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
