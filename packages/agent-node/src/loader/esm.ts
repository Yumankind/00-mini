/**
 * ESM → CommonJS, by hand, and honest about where the hand stops.
 *
 * WHY BY HAND. The alternative is a parser — acorn, or esbuild-wasm — and both are bigger than this
 * entire package. What actually needs transforming in a workspace is the syntax people write:
 * `import x from "y"`, `export const`, `export default`, `import.meta.url`, and `await import()`.
 * That is a scanner's job, not a parser's, PROVIDED the scanner is honest. So this one masks strings,
 * template literals, regexes and comments first (so a `"import x from y"` inside a string is never
 * mistaken for one), rewrites only statements at the top level, and refuses by name the two things a
 * scanner genuinely cannot do.
 *
 * DOES:
 *   import "m" · import d from "m" · import * as ns from "m" · import { a, b as c } from "m"
 *   import d, { a } from "m" · import d, * as ns from "m"
 *   export default <anything> · export const/let/var/function/class/async function
 *   export { a, b as c } · export { a } from "m" · export * from "m" · export * as ns from "m"
 *   import.meta.url / .filename / .dirname / .resolve() · dynamic import() (→ a resolved promise)
 *   Exported LOCAL bindings are live: they are installed as getters in a prologue, so a function
 *   exported before it is assigned reads correctly, and a cycle sees the binding rather than a copy.
 *
 * DOES NOT — the limits, in full, because a transform that hides them is a trap:
 *   1. **Imported bindings are a snapshot, not live.** `import { count } from "./m.js"` becomes a
 *      `const`; if `m.js` later reassigns `count`, this module does not see it. Real ESM would.
 *   2. **Imports are not hoisted.** They run where they are written, so a module that calls an
 *      imported function from a top-level statement ABOVE its import line will fail here and work in
 *      Node. Move the import up. (Function declarations that merely *reference* one are fine.)
 *   3. **No top-level await.** The CommonJS wrapper is a synchronous function; there is nowhere to
 *      await. A file with one throws `ERR_TOP_LEVEL_AWAIT` naming itself rather than producing
 *      something that silently returns a promise.
 *   4. **No import attributes** (`with { type: "json" }`). JSON is loaded by extension instead.
 *   5. **`export * from` copies own enumerable keys at the moment it runs**, so a key the source
 *      module adds later is missed. Named re-exports (`export { a } from`) ARE live.
 *   6. **`export { x as "a string" }`** (arbitrary module export names) is not parsed.
 *   7. **The regex/division heuristic** is the classic one: a `/` after `)` is division, elsewhere a
 *      regex. `if (a) /re/.test(b)` is the case it gets wrong, and it gets it wrong the same way
 *      every non-parsing tool does.
 *   8. **Nothing is renamed.** A module that declares its own `require`, `exports` or `__esm_*`
 *      identifier will collide. The prefix is deliberately ugly for that reason.
 */

import { NodeCompatError } from "../errors.js";

const ID = "[A-Za-z_$][A-Za-z0-9_$]*";

/**
 * A copy of `src` with the CONTENTS of strings, template literals, regexes and comments replaced by
 * spaces, delimiters kept, and every newline preserved so indexes and line numbers still line up.
 */
export function maskSource(src: string): string {
  const out = src.split("");
  let i = 0;
  let prevSignificant = "";
  const blank = (at: number): void => {
    if (out[at] !== "\n") out[at] = " ";
  };
  const templateStack: number[] = [];
  while (i < src.length) {
    const ch = src[i] as string;
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") blank(i++);
      continue;
    }
    if (ch === "/" && next === "*") {
      blank(i++);
      blank(i++);
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) blank(i++);
      blank(i++);
      blank(i++);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") blank(i++);
        blank(i++);
      }
      i += 1;
      prevSignificant = ch;
      continue;
    }
    if (ch === "`") {
      i += 1;
      templateStack.push(0);
      while (i < src.length && templateStack.length > 0) {
        if (src[i] === "\\") {
          blank(i++);
          blank(i++);
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          blank(i++);
          blank(i++);
          let depth = 1;
          // The expression inside `${…}` is real code; it is scanned, not blanked, so an
          // `import()` inside a template string's expression is still found.
          while (i < src.length && depth > 0) {
            if (src[i] === "{") depth += 1;
            else if (src[i] === "}") depth -= 1;
            if (depth === 0) break;
            i += 1;
          }
          i += 1;
          continue;
        }
        if (src[i] === "`") {
          templateStack.pop();
          i += 1;
          break;
        }
        blank(i++);
      }
      prevSignificant = "`";
      continue;
    }
    if (ch === "/" && !")]}".includes(prevSignificant) && !/[A-Za-z0-9_$]/.test(prevSignificant)) {
      // A regex literal. Its body is blanked so a `/` inside a character class cannot end it early.
      const start = i;
      i += 1;
      let inClass = false;
      while (i < src.length) {
        const c = src[i];
        if (c === "\\") {
          blank(i++);
          blank(i++);
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (c === "\n") {
          // Not a regex after all (they cannot span lines): put it back and move on.
          i = start + 1;
          prevSignificant = "/";
          break;
        }
        blank(i++);
      }
      if (src[i] === "/") i += 1;
      while (i < src.length && /[a-z]/.test(src[i] as string)) i += 1;
      prevSignificant = "/";
      continue;
    }
    if (!/\s/.test(ch)) prevSignificant = ch;
    i += 1;
  }
  return out.join("");
}

/** Is `at` the start of a statement? Only a `;`, `}`, `{`, `)` or nothing may precede one. */
function atStatementStart(mask: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i--) {
    const ch = mask[i] as string;
    if (/\s/.test(ch)) continue;
    return ch === ";" || ch === "}" || ch === "{" || ch === ")";
  }
  return true;
}

/** True when the source uses module syntax at the top level. `.mjs` skips the question entirely. */
export function hasEsmSyntax(src: string): boolean {
  const mask = maskSource(src);
  if (/\bimport\s*\.\s*meta\b/.test(mask)) return true;
  const pattern = /\b(import|export)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(mask))) {
    const at = match.index;
    if (!atStatementStart(mask, at)) continue;
    const after = mask.slice(at + (match[1] as string).length);
    // `import(` at a statement start is a dynamic import in a CommonJS file, not module syntax.
    if (match[1] === "import" && /^\s*\(/.test(after)) continue;
    return true;
  }
  return false;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function identifiersIn(pattern: string): string[] {
  const out: string[] = [];
  // Object patterns key on the LEFT of a colon and bind on the right; array patterns bind directly.
  const cleaned = pattern.replace(/\.\.\./g, " ");
  const re = new RegExp(`(${ID})\\s*(:)?`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    if (m[2]) continue; // `a:` is a key, not a binding
    const before = cleaned.slice(0, m.index).trimEnd();
    if (before.endsWith(".")) continue;
    out.push(m[1] as string);
  }
  return out;
}

/** The index just past the statement starting at `from`: the first `;` at depth 0, else end of line. */
function statementEnd(mask: string, from: number): number {
  let depth = 0;
  for (let i = from; i < mask.length; i++) {
    const ch = mask[i] as string;
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (ch === ";" && depth === 0) return i + 1;
    else if (ch === "\n" && depth === 0) {
      const rest = mask.slice(i + 1).trimStart();
      if (rest === "" || /^[A-Za-z_$}]/.test(rest)) return i;
    }
  }
  return mask.length;
}

/** The module specifier that follows `from` (or `import`), read out of the ORIGINAL source. */
function readSpecifier(src: string, mask: string, from: number): { value: string; end: number } | null {
  for (let i = from; i < mask.length; i++) {
    const ch = mask[i] as string;
    if (/\s/.test(ch)) continue;
    if (ch !== '"' && ch !== "'") return null;
    const close = mask.indexOf(ch, i + 1);
    if (close < 0) return null;
    return { value: src.slice(i + 1, close), end: close + 1 };
  }
  return null;
}

let counter = 0;

export interface TransformResult {
  code: string;
  /** The module specifiers this file pulls in, in source order. Useful to a caller pre-warming a cache. */
  requires: string[];
  transformed: boolean;
}

/**
 * Rewrite ESM to CommonJS. `filename` becomes `import.meta.url`; `url` overrides it when the host
 * has a better one.
 */
export function transformEsm(src: string, filename: string): TransformResult {
  if (!hasEsmSyntax(src)) return { code: src, requires: [], transformed: false };
  const mask = maskSource(src);

  const topLevelAwait = /(^|[^.\w$])await\s/g;
  let awaitMatch: RegExpExecArray | null;
  while ((awaitMatch = topLevelAwait.exec(mask))) {
    let depth = 0;
    for (let i = 0; i < awaitMatch.index; i++) {
      const ch = mask[i] as string;
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (depth === 0) {
      throw new NodeCompatError(
        "ERR_TOP_LEVEL_AWAIT",
        `${filename}: top-level await is not supported here — a CommonJS module body is a synchronous function and there is nowhere to await. Wrap the work in an async function and call it, or move it into the entry file's main().`,
      );
    }
  }

  const tag = `__esm${++counter}`;
  const edits: Edit[] = [];
  const getters: string[] = [];
  const requires: string[] = [];

  const addGetter = (exported: string, expression: string): void => {
    getters.push(
      `Object.defineProperty(exports, ${JSON.stringify(exported)}, { enumerable: true, configurable: true, get: function () { return ${expression}; } });`,
    );
  };

  // ── import statements ──
  const importPattern = /\bimport\b/g;
  let m: RegExpExecArray | null;
  while ((m = importPattern.exec(mask))) {
    const at = m.index;
    const after = mask.slice(at + 6);
    if (/^\s*\(/.test(after)) continue; // dynamic import, handled below
    if (/^\s*\.\s*meta\b/.test(after)) continue; // import.meta, handled below
    if (!atStatementStart(mask, at)) continue;

    const bare = readSpecifier(src, mask, at + 6);
    if (bare) {
      requires.push(bare.value);
      edits.push({ start: at, end: bare.end, text: `require(${JSON.stringify(bare.value)})` });
      continue;
    }
    const fromAt = mask.slice(at).search(/\bfrom\b/);
    if (fromAt < 0) continue;
    // The MASKED source, not the original: a comment inside the specifier list would otherwise end
    // up spliced into the generated `const` declarations.
    const clause = mask.slice(at + 6, at + fromAt).trim();
    const spec = readSpecifier(src, mask, at + fromAt + 4);
    if (!spec) continue;
    requires.push(spec.value);
    const local = `${tag}_${edits.length}`;
    const lines = [`const ${local} = ${tag}ns(require(${JSON.stringify(spec.value)}));`];
    const starMatch = clause.match(new RegExp(`\\*\\s+as\\s+(${ID})`));
    if (starMatch) lines.push(`const ${starMatch[1]} = ${local};`);
    const bracesAt = clause.indexOf("{");
    const head = (bracesAt < 0 ? clause : clause.slice(0, bracesAt)).replace(/\*\s+as\s+[A-Za-z0-9_$]+/, "").replace(/,/g, " ").trim();
    if (head) lines.push(`const ${head} = ${local}.default;`);
    if (bracesAt >= 0) {
      const inner = clause.slice(bracesAt + 1, clause.lastIndexOf("}"));
      for (const piece of inner.split(",")) {
        const name = piece.trim();
        if (!name) continue;
        const asMatch = name.match(new RegExp(`^(${ID})\\s+as\\s+(${ID})$`));
        if (asMatch) lines.push(`const ${asMatch[2]} = ${local}.${asMatch[1]};`);
        else lines.push(`const ${name} = ${local}.${name};`);
      }
    }
    edits.push({ start: at, end: spec.end, text: lines.join(" ") });
  }

  // ── export statements ──
  const exportPattern = /\bexport\b/g;
  while ((m = exportPattern.exec(mask))) {
    const at = m.index;
    if (!atStatementStart(mask, at)) continue;
    const rest = mask.slice(at + 6);

    if (/^\s*default\b/.test(rest)) {
      const defaultAt = at + 6 + (rest.indexOf("default") as number);
      edits.push({ start: at, end: defaultAt + 7, text: `exports.default =` });
      continue;
    }

    if (/^\s*\*/.test(rest)) {
      const nsMatch = rest.match(new RegExp(`^\\s*\\*\\s+as\\s+(${ID})`));
      const fromAt = mask.slice(at).search(/\bfrom\b/);
      const spec = fromAt < 0 ? null : readSpecifier(src, mask, at + fromAt + 4);
      if (!spec) continue;
      requires.push(spec.value);
      const local = `${tag}_${edits.length}`;
      if (nsMatch) {
        edits.push({ start: at, end: spec.end, text: `const ${local} = ${tag}ns(require(${JSON.stringify(spec.value)}));` });
        addGetter(nsMatch[1] as string, local);
      } else {
        edits.push({ start: at, end: spec.end, text: `${tag}star(exports, require(${JSON.stringify(spec.value)}));` });
      }
      continue;
    }

    if (/^\s*\{/.test(rest)) {
      const open = at + 6 + rest.indexOf("{");
      const close = mask.indexOf("}", open);
      if (close < 0) continue;
      const inner = mask.slice(open + 1, close);
      const fromAfter = mask.slice(close).match(/^\s*\}\s*from\b/);
      let source: string | null = null;
      let end = close + 1;
      let local = "";
      if (fromAfter) {
        const spec = readSpecifier(src, mask, close + (fromAfter[0] as string).length);
        if (!spec) continue;
        source = spec.value;
        end = spec.end;
        requires.push(source);
        local = `${tag}_${edits.length}`;
      }
      for (const piece of inner.split(",")) {
        const name = piece.trim();
        if (!name) continue;
        const asMatch = name.match(new RegExp(`^(${ID})\\s+as\\s+(${ID})$`));
        const from = asMatch ? (asMatch[1] as string) : name;
        const to = asMatch ? (asMatch[2] as string) : name;
        addGetter(to, source ? `${local}.${from}` : from);
      }
      edits.push({ start: at, end, text: source ? `const ${local} = ${tag}ns(require(${JSON.stringify(source)}));` : "" });
      continue;
    }

    const declMatch = rest.match(new RegExp(`^\\s*(async\\s+function\\s*\\*?|function\\s*\\*?|class|const|let|var)\\s+`));
    if (!declMatch) continue;
    const keyword = (declMatch[1] as string).trim();
    const declStart = at + 6 + (declMatch[0] as string).length;
    if (keyword.endsWith("function") || keyword.endsWith("*") || keyword === "class") {
      const nameMatch = src.slice(declStart).match(new RegExp(`^\\s*(${ID})`));
      if (nameMatch) addGetter(nameMatch[1] as string, nameMatch[1] as string);
    } else {
      const end = statementEnd(mask, declStart);
      const body = src.slice(declStart, end);
      let depth = 0;
      let current = "";
      const declarators: string[] = [];
      for (const ch of body) {
        if ("([{".includes(ch)) depth += 1;
        else if (")]}".includes(ch)) depth -= 1;
        if (ch === "," && depth === 0) {
          declarators.push(current);
          current = "";
          continue;
        }
        current += ch;
      }
      declarators.push(current);
      for (const declarator of declarators) {
        let d = 0;
        let target = declarator;
        for (let i = 0; i < declarator.length; i++) {
          const ch = declarator[i] as string;
          if ("([{".includes(ch)) d += 1;
          else if (")]}".includes(ch)) d -= 1;
          else if (ch === "=" && d === 0 && declarator[i + 1] !== "=") {
            target = declarator.slice(0, i);
            break;
          }
        }
        for (const name of identifiersIn(target)) addGetter(name, name);
      }
    }
    // The declaration itself is untouched, so hoisting and TDZ behave exactly as they did.
    edits.push({ start: at, end: at + 6, text: "" });
  }

  // ── import.meta and dynamic import() ──
  const metaPattern = /\bimport\s*\.\s*meta\b/g;
  while ((m = metaPattern.exec(mask))) {
    edits.push({ start: m.index, end: m.index + (m[0] as string).length, text: `${tag}meta` });
  }
  const dynamicPattern = /\bimport\s*\(/g;
  while ((m = dynamicPattern.exec(mask))) {
    edits.push({ start: m.index, end: m.index + (m[0] as string).length - 1, text: `${tag}dyn` });
  }

  edits.sort((a, b) => a.start - b.start);
  let code = "";
  let at = 0;
  for (const edit of edits) {
    if (edit.start < at) continue; // an overlap: the outer edit already covered it
    code += src.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  code += src.slice(at);

  const dir = filename.slice(0, Math.max(1, filename.lastIndexOf("/")));
  const prologue = [
    `Object.defineProperty(exports, "__esModule", { value: true });`,
    `function ${tag}ns(mod) { if (mod && mod.__esModule) return mod; var ns = {}; if (mod != null) { for (var k in mod) { if (Object.prototype.hasOwnProperty.call(mod, k)) ns[k] = mod[k]; } } ns.default = mod; return ns; }`,
    `function ${tag}star(target, mod) { if (mod == null) return; for (var k in mod) { if (k !== "default" && k !== "__esModule" && !Object.prototype.hasOwnProperty.call(target, k)) { (function (key) { Object.defineProperty(target, key, { enumerable: true, configurable: true, get: function () { return mod[key]; } }); })(k); } } }`,
    `function ${tag}dyn(request) { return Promise.resolve().then(function () { return ${tag}ns(require(request)); }); }`,
    `var ${tag}meta = { url: ${JSON.stringify(`file://${filename}`)}, filename: ${JSON.stringify(filename)}, dirname: ${JSON.stringify(dir)}, resolve: function (r) { return require.resolve(r); } };`,
    ...getters,
  ].join("\n");

  return { code: `${prologue}\n${code}`, requires, transformed: true };
}
