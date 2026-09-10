/**
 * The shapes the embed's three halves agree on — crawler, index, tools.
 *
 * WHY here and not in `@00/shared`: none of this leaves the visitor's browser. A `PageEntry` is
 * what one same-origin GET produced on THIS person's device in THIS session, and §5.2.1 is explicit
 * that it is never uploaded anywhere. Keeping the shape local to `embed/` is the reminder.
 *
 * See docs/HANDOFF-infinite-agent.md §5.2.1.
 */

/** The session the page was seen in. Every entry carries it, because the purge is keyed on it. */
export type AuthState = "anon" | "authed" | "unknown";

/** How a URL entered the frontier. `hint` means a targeted round (§5.2.1, "deeper on demand"). */
export type CrawlSource = "sitemap" | "link" | "hint";

/** A form as the crawler is allowed to see it: labels and the action path, never a value. */
export interface FormSummary {
  /** The form's accessible name, or its action path when it has none. */
  name: string;
  /** Same-origin action path, or "" when the form posts to itself. */
  action: string;
  method: string;
  /** Field LABELS only. §13: the embed never fills, submits or reads a field's value. */
  fields: string[];
}

/** A thing a visitor can operate: a button, a link that acts like one, a menu, a search box. */
export interface Landmark {
  role: string;
  /** Accessible name (aria-label, labelled-by text, or trimmed text content). */
  name: string;
  /** Stable-ish CSS selector the page tools can resolve again. */
  selector: string;
}

export interface LinkOut {
  url: string;
  text: string;
}

/** One crawled page. The field list is §5.2.1's, in its order. */
export interface PageEntry {
  url: string;
  title: string;
  /** meta description, or the first 200 characters of the extracted text. */
  description: string;
  headings: string[];
  /** Readability-style text: scripts, nav and footer stripped. Capped at `maxTextBytes`. */
  text: string;
  /** Same-origin URLs this page links to. */
  linksIn: string[];
  /** Off-origin links, recorded so the agent can mention them. Never fetched (§5.2.1). */
  linksOut: LinkOut[];
  forms: FormSummary[];
  landmarks: Landmark[];
  authState: AuthState;
  /** True when the page answered with a login form; not retried in this session. */
  requiresAuth?: boolean;
  lastmod?: string;
  etag?: string;
  crawledAt: number;
  depth: number;
  source: CrawlSource;
}

/** One line of the site map the agent gets at the top of its context (§5.2.2). */
export interface SiteMapLine {
  path: string;
  title: string;
  description: string;
  authState: AuthState;
  depth: number;
}

/** A BM25 unit: a slice of one page's text, kept with the heading it sat under. */
export interface Chunk {
  url: string;
  heading: string;
  text: string;
}

/** A search hit, with enough to quote it and to open the page it came from. */
export interface SearchHit {
  url: string;
  title: string;
  heading: string;
  passage: string;
  score: number;
}
