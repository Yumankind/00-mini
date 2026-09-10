/**
 * Turning one HTML response into one `PageEntry`'s worth of facts.
 *
 * WHY this is an interface and not a function: there is no DOM in the node test runner (see
 * apps/infinite/vitest.config.ts, which says so on purpose), and the crawler — its guards, its
 * bounds, its ranking, its purge — is the part that must be tested. So the crawler takes an
 * `HtmlExtractor` and never sees HTML itself; the browser gets `createDomExtractor()` on
 * `DOMParser`, and a test gets a twenty-line double that returns whatever the case needs.
 *
 * The extraction rule of §5.2.1: readability-style text with scripts, nav and footer stripped;
 * forms and their actions as LABELS only; interactive landmarks with their accessible names.
 * Nothing here reads a field's value, and nothing here executes: `DOMParser` builds an inert
 * document — no script runs, no image loads, no fetch fires.
 */

export interface ExtractedLink {
  url: string;
  text: string;
  /** `rel=nofollow` — recorded and honoured (§5.2.1). */
  nofollow: boolean;
}

export interface ExtractedForm {
  name: string;
  action: string;
  method: string;
  fields: string[];
  hasPassword: boolean;
}

export interface ExtractedLandmark {
  role: string;
  name: string;
  selector: string;
}

export interface ExtractedPage {
  title: string;
  description: string;
  headings: string[];
  text: string;
  links: ExtractedLink[];
  forms: ExtractedForm[];
  landmarks: ExtractedLandmark[];
  /** `<meta name="robots">` on this page. */
  meta: { noindex: boolean; nofollow: boolean };
  /** True when the page answered with a login form — recorded as `requiresAuth` (§5.2.1). */
  hasLoginForm: boolean;
  canonical?: string;
}

export interface HtmlExtractor {
  /** `baseUrl` resolves relative hrefs; the extractor never fetches anything itself. */
  extract(html: string, baseUrl: string): ExtractedPage;
}

/** Containers whose text is chrome, not content. Removed whole before the text is read. */
const STRIPPED = "script,style,noscript,template,svg,nav,header,footer,aside,form,iframe,object,canvas";

/** The elements a visitor can operate, and the role each reports as. */
const LANDMARK_SELECTORS: [string, string][] = [
  ["button", "button"],
  ["[role=button]", "button"],
  ["a[href]", "link"],
  ["input[type=submit]", "button"],
  ["input[type=button]", "button"],
  ["input[type=search]", "searchbox"],
  ["[role=search]", "search"],
  ["select", "menu"],
  ["[role=menu]", "menu"],
  ["summary", "disclosure"],
];

/** The browser implementation. Only ever constructed inside a page; the crawler holds the interface. */
export function createDomExtractor(): HtmlExtractor {
  return {
    extract(html: string, baseUrl: string): ExtractedPage {
      const doc = new DOMParser().parseFromString(html, "text/html");

      const meta = (name: string): string =>
        doc.querySelector(`meta[name="${name}" i]`)?.getAttribute("content")?.trim() ?? "";
      const robots = `${meta("robots")} ${meta("infiniteagent")}`.toLowerCase();

      const title = (doc.querySelector("title")?.textContent ?? "").trim().slice(0, 200);
      const headings = [...doc.querySelectorAll("h1,h2,h3")]
        .map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 60);

      // Links come from the ORIGINAL document: navigation is exactly where a site's map lives, so
      // links are read before the chrome is stripped, and only the TEXT loses the chrome.
      const links: ExtractedLink[] = [];
      for (const a of doc.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") ?? "";
        if (!href || href.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(href)) continue;
        let abs: string;
        try {
          abs = new URL(href, baseUrl).toString();
        } catch {
          continue;
        }
        const rel = (a.getAttribute("rel") ?? "").toLowerCase();
        links.push({
          url: abs,
          text: (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
          nofollow: rel.split(/\s+/).includes("nofollow"),
        });
        if (links.length >= 500) break;
      }

      const forms: ExtractedForm[] = [];
      for (const f of doc.querySelectorAll("form")) {
        const fields: string[] = [];
        let hasPassword = false;
        for (const el of f.querySelectorAll("input,select,textarea")) {
          const type = (el.getAttribute("type") ?? "text").toLowerCase();
          if (type === "hidden") continue;
          if (type === "password") hasPassword = true;
          // LABELS ONLY. A value is never read, here or anywhere (§13).
          const label =
            el.getAttribute("aria-label") ||
            labelTextFor(doc, el.getAttribute("id")) ||
            el.getAttribute("placeholder") ||
            el.getAttribute("name") ||
            type;
          if (label) fields.push(label.replace(/\s+/g, " ").trim().slice(0, 80));
          if (fields.length >= 30) break;
        }
        const action = f.getAttribute("action") ?? "";
        forms.push({
          name: (f.getAttribute("aria-label") || f.getAttribute("name") || action || "form").slice(0, 80),
          action: action.slice(0, 256),
          method: (f.getAttribute("method") ?? "get").toLowerCase(),
          fields,
          hasPassword,
        });
        if (forms.length >= 20) break;
      }

      const landmarks: ExtractedLandmark[] = [];
      const seen = new Set<string>();
      for (const [selector, role] of LANDMARK_SELECTORS) {
        for (const el of doc.querySelectorAll(selector)) {
          const name = accessibleName(el);
          if (!name) continue;
          const sel = stableSelector(el);
          const key = `${role}:${name}:${sel}`;
          if (seen.has(key)) continue;
          seen.add(key);
          landmarks.push({ role, name: name.slice(0, 120), selector: sel });
          if (landmarks.length >= 120) break;
        }
        if (landmarks.length >= 120) break;
      }

      for (const el of doc.querySelectorAll(STRIPPED)) el.remove();
      const main = doc.querySelector("main,[role=main],article") ?? doc.body;
      const text = blockText(main).replace(/[ \t\u00a0]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

      const description = meta("description") || meta("og:description") || text.slice(0, 200);
      const canonical = doc.querySelector('link[rel="canonical" i]')?.getAttribute("href") ?? undefined;

      return {
        title,
        description: description.slice(0, 400),
        headings,
        text,
        links,
        forms,
        landmarks,
        meta: { noindex: robots.includes("noindex"), nofollow: robots.includes("nofollow") },
        hasLoginForm: forms.some((f) => f.hasPassword),
        ...(canonical ? { canonical } : {}),
      };
    },
  };
}

/**
 * `textContent` runs every block together — "HomeWe sell shoes" — which loses the one thing the
 * index needs most: a heading on a line of its own, so a chunk can be attributed to it (bm25.ts).
 * So blocks are joined with newlines, inline runs are not.
 */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION",
  "FIGURE", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "MAIN", "OL", "P", "PRE", "SECTION",
  "TABLE", "TD", "TH", "TR", "UL",
]);

function blockText(node: Node | null): string {
  if (!node) return "";
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  let out = "";
  for (const child of el.childNodes) out += blockText(child);
  return BLOCK_TAGS.has(el.tagName) ? `\n${out}\n` : out;
}

function labelTextFor(doc: Document, id: string | null): string {
  if (!id) return "";
  const escaped = id.replace(/["\\]/g, "\\$&");
  return (doc.querySelector(`label[for="${escaped}"]`)?.textContent ?? "").trim();
}

function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (parts) return parts.replace(/\s+/g, " ");
  }
  const value = el.getAttribute("value");
  if (value?.trim() && el.tagName === "INPUT") return value.trim();
  const placeholder = el.getAttribute("placeholder");
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return text || placeholder?.trim() || el.getAttribute("title")?.trim() || "";
}

/** `#id` when there is one, else a nth-of-type path — enough for page_scroll_to to find it again. */
function stableSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  let hops = 0;
  while (node && node.nodeType === 1 && hops < 6) {
    const tag = node.tagName.toLowerCase();
    if (tag === "html" || tag === "body") break;
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const siblings = [...parent.children].filter((c) => c.tagName === node!.tagName);
    const idx = siblings.indexOf(node) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
    node = parent;
    hops += 1;
  }
  return parts.join(" > ") || el.tagName.toLowerCase();
}
