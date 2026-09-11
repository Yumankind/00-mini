/**
 * A fenced block's colours — four classes, no dependency, and the escaping is this module's own.
 *
 * WHY NOT HIGHLIGHT.JS OR SHIKI. The app's promise is "no install, offline, works with nothing".
 * highlight.js is 40 KB gzipped before a language pack and Shiki ships a WASM grammar engine; what a
 * person reading an agent's answer needs is keywords, strings, comments and numbers told apart at a
 * glance. That is four classes and one scanner, and it is here.
 *
 * WHY IT ESCAPES ITS OWN OUTPUT. This runs on text a model wrote, which came from a page somebody
 * else wrote. Every character that reaches the output goes through `escapeHtml` at the moment it is
 * emitted, and the only tags this module ever writes are the four `<span class="tok-…">` it builds
 * itself — so a fenced block containing `</span><img onerror=…>` is four escaped characters and not
 * a hole. `markdown-lite.ts` has the same rule for the same reason; neither one may be relaxed.
 */
import { escapeHtml } from "./markdown-lite.js";

/** The languages that get colours. Anything else is escaped and left plain, which is not a failure. */
export type Lang = "js" | "ts" | "json" | "sh" | "html" | "css" | "py" | "md" | "";

const ALIASES: Record<string, Lang> = {
  js: "js",
  javascript: "js",
  mjs: "js",
  cjs: "js",
  jsx: "js",
  node: "js",
  ts: "ts",
  typescript: "ts",
  tsx: "ts",
  json: "json",
  jsonc: "json",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  shell: "sh",
  console: "sh",
  html: "html",
  vue: "html",
  xml: "html",
  svg: "html",
  css: "css",
  scss: "css",
  py: "py",
  python: "py",
  md: "md",
  markdown: "md",
};

/** `Bash` and `bash` and `sh` are one language; an unknown word is the empty language. */
export function normalizeLang(raw: string): Lang {
  return ALIASES[raw.trim().toLowerCase()] ?? "";
}

const JS_WORDS =
  "as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while yield";
const TS_EXTRA = "abstract any asserts bigint boolean declare infer is keyof module namespace never number object override string symbol unique unknown";
const PY_WORDS =
  "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield";
const SH_WORDS =
  "case do done elif else esac export fi for function if in local read return set shift then time until while alias cd echo exit source sudo npm npx node pnpm git";

const KEYWORDS: Record<Lang, Set<string>> = {
  js: new Set(JS_WORDS.split(" ")),
  ts: new Set(`${JS_WORDS} ${TS_EXTRA}`.split(" ")),
  json: new Set(["true", "false", "null"]),
  sh: new Set(SH_WORDS.split(" ")),
  py: new Set(PY_WORDS.split(" ")),
  html: new Set(),
  css: new Set(),
  md: new Set(),
  "": new Set(),
};

function span(cls: string, text: string): string {
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

const WORD_START = /[A-Za-z_$@]/;
const WORD_REST = /[A-Za-z0-9_$-]/;

/**
 * The curly-brace family and the two that read like it (`sh`, `py`): comments, strings, numbers,
 * words. One scanner rather than one per language, because the only differences are which comment
 * opener and which quotes the language admits, and those are two small tables.
 */
function scanCode(code: string, lang: Lang): string {
  const words = KEYWORDS[lang];
  const lineComment = lang === "sh" || lang === "py" ? "#" : "//";
  const blockComments = lang === "js" || lang === "ts" || lang === "css";
  const quotes = lang === "json" ? `"` : lang === "py" ? `"'` : `"'\``;
  const out: string[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) {
      out.push(escapeHtml(plain));
      plain = "";
    }
  };

  let i = 0;
  while (i < code.length) {
    const ch = code[i]!;
    const two = code.slice(i, i + 2);

    if (lang !== "json" && two === lineComment) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      flush();
      out.push(span("tok-c", code.slice(i, stop)));
      i = stop;
      continue;
    }
    if (lang !== "json" && lineComment === "#" && ch === "#") {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      flush();
      out.push(span("tok-c", code.slice(i, stop)));
      i = stop;
      continue;
    }
    if (blockComments && two === "/*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      flush();
      out.push(span("tok-c", code.slice(i, stop)));
      i = stop;
      continue;
    }
    if (quotes.includes(ch)) {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === ch) {
          j += 1;
          break;
        }
        // A quote that never closes ends at its line, so one stray apostrophe cannot paint the
        // rest of the block green.
        if (code[j] === "\n" && ch !== "`") break;
        j += 1;
      }
      flush();
      out.push(span("tok-s", code.slice(i, j)));
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) && !WORD_REST.test(code[i - 1] ?? " ")) {
      let j = i;
      while (j < code.length && /[0-9a-fA-FxX._]/.test(code[j]!)) j += 1;
      flush();
      out.push(span("tok-n", code.slice(i, j)));
      i = j;
      continue;
    }
    if (WORD_START.test(ch)) {
      let j = i;
      while (j < code.length && WORD_REST.test(code[j]!)) j += 1;
      const word = code.slice(i, j);
      if (words.has(word)) {
        flush();
        out.push(span("tok-k", word));
      } else {
        plain += word;
      }
      i = j;
      continue;
    }
    plain += ch;
    i += 1;
  }
  flush();
  return out.join("");
}

/** Tags are the keywords of a document, quoted attribute values are its strings. */
function scanHtml(code: string): string {
  const out: string[] = [];
  let i = 0;
  let plain = "";
  const flush = (): void => {
    if (plain) {
      out.push(escapeHtml(plain));
      plain = "";
    }
  };
  while (i < code.length) {
    if (code.startsWith("<!--", i)) {
      const end = code.indexOf("-->", i);
      const stop = end === -1 ? code.length : end + 3;
      flush();
      out.push(span("tok-c", code.slice(i, stop)));
      i = stop;
      continue;
    }
    if (code[i] === "<") {
      const end = code.indexOf(">", i);
      const stop = end === -1 ? code.length : end + 1;
      const tag = code.slice(i, stop);
      flush();
      // Inside the tag, the quoted halves are strings and everything else is the tag itself.
      let rest = "";
      let quoted: RegExpExecArray | null;
      const parts = /("[^"]*"|'[^']*')/g;
      let last = 0;
      while ((quoted = parts.exec(tag))) {
        rest += span("tok-k", tag.slice(last, quoted.index));
        rest += span("tok-s", quoted[0]);
        last = quoted.index + quoted[0].length;
      }
      rest += span("tok-k", tag.slice(last));
      out.push(rest);
      i = stop;
      continue;
    }
    plain += code[i];
    i += 1;
  }
  flush();
  return out.join("");
}

/** A property name before its colon, and an at-rule, are what a stylesheet's keywords are. */
function scanCss(code: string): string {
  const base = scanCode(code, "css");
  // `scanCode` already took the comments, strings and numbers; what is left to mark is the property
  // names, and they are the only words followed by a colon in what remains.
  return base.replace(/(^|[;{\s])([-a-zA-Z@][-a-zA-Z0-9_]*)(\s*:)/g, (_all, before: string, word: string, after: string) =>
    `${before}<span class="tok-k">${word}</span>${after}`,
  );
}

/** Markdown inside markdown: headings read as structure, backticks as code, quotes as asides. */
function scanMarkdown(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      if (/^\s*#{1,6}\s/.test(line)) return span("tok-k", line);
      if (/^\s*>/.test(line)) return span("tok-c", line);
      const parts = line.split(/(`[^`]*`)/g);
      return parts.map((part) => (part.startsWith("`") && part.length > 1 ? span("tok-s", part) : escapeHtml(part))).join("");
    })
    .join("\n");
}

/**
 * Source → HTML, ready for `<code>`. An unknown language is escaped and returned plain: colours are
 * a help, and a wrong colour is worse than none.
 */
export function highlight(code: string, rawLang: string): string {
  const lang = normalizeLang(rawLang);
  switch (lang) {
    case "":
      return escapeHtml(code);
    case "html":
      return scanHtml(code);
    case "css":
      return scanCss(code);
    case "md":
      return scanMarkdown(code);
    default:
      return scanCode(code, lang);
  }
}
