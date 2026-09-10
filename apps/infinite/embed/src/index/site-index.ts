/**
 * The per-site index: what is known about this website, in this browser, for this ref.
 *
 * WHY one class over the store, the BM25 and the purge: those three have to agree about a single
 * question — is this entry still allowed to exist — and the answer depends on the session, the TTL
 * and the owner's config all at once. One owner of that question is one place to read it.
 *
 * Staleness, per §5.2.1:
 *   · every entry carries `crawledAt`; past the owner's TTL (default 7 days) it is re-fetched in
 *     the background under the on-load bounds, home page and sitemap `lastmod` first;
 *   · an entry whose `lastmod`/ETag changed is re-fetched whatever its age;
 *   · an entry that no longer answers 200 is dropped (the crawler reports it, `drop()` applies it);
 *   · an entry crawled in a different `authState` than the visitor's current one is re-fetched;
 *   · a whole index older than 30 days with no successful refresh is REBUILT from scratch rather
 *     than patched.
 */

import type { AuthState, PageEntry, SearchHit, SiteMapLine } from "../types.js";
import type { SiteConfig } from "../site-config.js";
import { Bm25Index, chunkPage, toHit } from "./bm25.js";
import { persistable, purgeEntries, type PurgeReason } from "./session.js";
import type { Store } from "./store.js";

export const INDEX_FORMAT = 1;
export const REBUILD_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface StoredIndex {
  format: number;
  origin: string;
  ref: string;
  /** The `site.json` version the index was built under; a change purges it (§5.2.1). */
  siteVersion: number;
  createdAt: number;
  updatedAt: number;
  pages: PageEntry[];
}

export interface SiteIndexOptions {
  origin: string;
  ref: string;
  store: Store;
  config: SiteConfig;
  now?: () => number;
}

export interface LoadOutcome {
  /** The index was too old to patch and was thrown away (§5.2.1, 30 days). */
  rebuilt: boolean;
  /** Entries a purge removed while loading — a site.json version change is the usual cause. */
  purged: number;
  loaded: number;
}

export class SiteIndex {
  private entries = new Map<string, PageEntry>();
  private bm25: Bm25Index | null = null;
  private createdAt = 0;
  private loadedVersion = 0;

  constructor(private readonly opts: SiteIndexOptions) {
    this.createdAt = this.now();
  }

  /** IndexedDB is keyed by `origin + ref`: one site's index is never another site's, or another app's. */
  static key(origin: string, ref: string): string {
    return `index:${origin}|${ref}`;
  }

  private get key(): string {
    return SiteIndex.key(this.opts.origin, this.opts.ref);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async load(): Promise<LoadOutcome> {
    const stored = await this.opts.store.get<StoredIndex>(this.key);
    if (!stored || stored.format !== INDEX_FORMAT) return { rebuilt: !!stored, purged: 0, loaded: 0 };

    if (this.now() - stored.createdAt > REBUILD_AFTER_MS) {
      await this.opts.store.del(this.key);
      this.createdAt = this.now();
      return { rebuilt: true, purged: stored.pages.length, loaded: 0 };
    }

    this.createdAt = stored.createdAt;
    this.loadedVersion = stored.siteVersion;

    let pages = stored.pages;
    let purged = 0;
    if (stored.siteVersion !== this.opts.config.version) {
      const out = purgeEntries(pages, "site-config-version-changed");
      pages = out.kept;
      purged = out.removed.length;
    }
    this.replace(pages);
    if (purged) await this.save();
    return { rebuilt: false, purged, loaded: pages.length };
  }

  private replace(pages: PageEntry[]): void {
    this.entries = new Map(pages.map((p) => [p.url, p]));
    this.bm25 = null;
  }

  /** Newly crawled pages win over what is held; the index is a picture of now, not a history. */
  merge(pages: PageEntry[]): void {
    for (const p of pages) this.entries.set(p.url, p);
    this.bm25 = null;
  }

  /** An entry that no longer answers 200 is dropped rather than kept as a promise the site broke. */
  drop(urls: string[]): void {
    for (const u of urls) this.entries.delete(u);
    this.bm25 = null;
  }

  async save(): Promise<void> {
    const record: StoredIndex = {
      format: INDEX_FORMAT,
      origin: this.opts.origin,
      ref: this.opts.ref,
      siteVersion: this.opts.config.version,
      createdAt: this.createdAt,
      updatedAt: this.now(),
      // Rule 3 of the purge: under a `temporary` session, authed entries never reach disk.
      pages: persistable([...this.entries.values()], this.opts.config.session.kind),
    };
    await this.opts.store.set(this.key, record);
    this.loadedVersion = record.siteVersion;
  }

  /** The purge. Runs for a logout, for "clear memory", and for a site.json version change. */
  async purge(reason: PurgeReason): Promise<number> {
    const out = purgeEntries([...this.entries.values()], reason);
    this.replace(out.kept);
    await this.save();
    return out.removed.length;
  }

  /** "Clear memory" in the panel footer: the purge, and then nothing of this site's index remains. */
  async clearAll(): Promise<void> {
    this.replace([]);
    await this.opts.store.del(this.key);
    this.createdAt = this.now();
  }

  pages(): PageEntry[] {
    return [...this.entries.values()];
  }

  get(url: string): PageEntry | undefined {
    return this.entries.get(url);
  }

  size(): number {
    return this.entries.size;
  }

  siteVersionOnDisk(): number {
    return this.loadedVersion;
  }

  /** The site map the agent gets at the top of its context: one line per page (§5.2.2). */
  map(filter?: string): SiteMapLine[] {
    const needle = filter?.trim().toLowerCase() ?? "";
    const lines: SiteMapLine[] = [];
    for (const p of this.entries.values()) {
      const path = pathOf(p.url);
      if (needle) {
        const isPrefix = needle.startsWith("/");
        const hay = `${path} ${p.title} ${p.description}`.toLowerCase();
        if (isPrefix ? !path.toLowerCase().startsWith(needle) : !hay.includes(needle)) continue;
      }
      lines.push({
        path,
        title: p.title,
        description: p.description.slice(0, 160),
        authState: p.authState,
        depth: p.depth,
      });
    }
    return lines.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  }

  /** One hit per PAGE: the same page listed three times is a worse answer than three pages. */
  search(query: string, k = 5): SearchHit[] {
    this.bm25 ??= new Bm25Index([...this.entries.values()].flatMap((p) => chunkPage(p)));
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const { chunk, score } of this.bm25.search(query, k * 4)) {
      if (seen.has(chunk.url)) continue;
      seen.add(chunk.url);
      hits.push(toHit(chunk, score, this.entries.get(chunk.url)?.title ?? "", query));
      if (hits.length >= k) break;
    }
    return hits;
  }

  /** Literal or regex, over the indexed text AND the landmarks (§5.2.2's `site_grep`). */
  grep(pattern: string, paths?: string[]): { url: string; where: string; line: string }[] {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const out: { url: string; where: string; line: string }[] = [];
    for (const p of this.entries.values()) {
      const path = pathOf(p.url);
      if (paths?.length && !paths.some((prefix) => path.startsWith(prefix))) continue;
      for (const line of p.text.split(/\n+/)) {
        const trimmed = line.trim();
        if (trimmed && re.test(trimmed)) out.push({ url: p.url, where: "text", line: trimmed.slice(0, 240) });
        if (out.length >= 60) return out;
      }
      for (const l of p.landmarks) {
        if (re.test(l.name)) out.push({ url: p.url, where: `${l.role}`, line: l.name });
        if (out.length >= 60) return out;
      }
    }
    return out;
  }

  /**
   * What to re-fetch on this open, most-deserving first: the home page and anything the sitemap
   * says changed, then entries crawled in another session state, then whatever is past the TTL.
   */
  staleUrls(authState: AuthState, sitemapLastmod?: Map<string, string | undefined>): string[] {
    const ttlMs = this.opts.config.ttlDays * 24 * 60 * 60 * 1000;
    const now = this.now();
    const scored: { url: string; rank: number }[] = [];
    for (const p of this.entries.values()) {
      const changed = sitemapLastmod?.has(p.url) && sitemapLastmod.get(p.url) !== p.lastmod;
      const wrongSession = p.authState !== authState && !(p.authState === "anon" && authState === "unknown");
      const old = now - p.crawledAt > ttlMs;
      if (!changed && !wrongSession && !old) continue;
      const isHome = pathOf(p.url) === "/";
      scored.push({ url: p.url, rank: isHome ? 0 : changed ? 1 : wrongSession ? 2 : 3 });
    }
    return scored.sort((a, b) => a.rank - b.rank).map((s) => s.url);
  }
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname || "/") + (u.search || "");
  } catch {
    return url;
  }
}
