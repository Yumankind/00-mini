/**
 * BM25, and nothing else — the retrieval that works with NO MODEL AT ALL.
 *
 * §4.1 says the owned agent's search works before any brain is downloaded, and until now only the
 * EMBED had an index (gap B14): the agent you own could not find a note in its own memory without a
 * model to grep on its behalf. This is that index, and it is deliberately the same algorithm, ported
 * from `apps/infinite/embed/src/index/bm25.ts` rather than shared with it — the embed indexes CRAWLED
 * PAGES (url, heading, passage) and this indexes FILES (path, line, span), so the chunk type is
 * different and the twenty lines of scoring are not worth a package to hold them. When one changes
 * the other is a `git grep` away.
 *
 * WHY BM25 rather than embeddings, restated for this side: it needs no download, it is instant on a
 * phone, and it ranks a person's own notes — short documents, exact words, names and dates — better
 * than a cosine over a small embedding model would. An agent asked "what did I decide about the
 * pricing page" needs the note that says "pricing", and BM25 is very good at exactly that.
 *
 * Pure and dependency-free: no clock, no I/O, no state between calls. The filesystem half lives in
 * workspace-index.ts.
 */

/** Saturation and length-normalisation. Robertson's defaults, which is what "BM25" means unqualified. */
const K1 = 1.2;
const B = 0.75;

export interface Bm25Document {
  /** Whatever the caller uses to find this text again — a path, a path plus a line range. */
  id: string;
  /** Weighted the same as the body; a file's path is often the best word in it. */
  title?: string;
  text: string;
}

export interface Bm25Result<T extends Bm25Document = Bm25Document> {
  doc: T;
  score: number;
}

/**
 * Words, lowercased and stripped of accents. One-character tokens go (they are noise in every
 * language this ships in) and 32+-character ones go too (a base64 blob is not a search term).
 */
export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && t.length < 32);
}

interface Posting {
  doc: number;
  tf: number;
}

/** An immutable index: adding documents means building a new one, which is cheap at this scale. */
export class Bm25Index<T extends Bm25Document = Bm25Document> {
  private readonly postings = new Map<string, Posting[]>();
  private readonly lengths: number[] = [];
  private readonly avgLength: number;

  constructor(readonly docs: T[]) {
    for (const [i, doc] of docs.entries()) {
      const terms = tokens(`${doc.title ?? ""} ${doc.text}`);
      this.lengths[i] = terms.length;
      const counts = new Map<string, number>();
      for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const [t, tf] of counts) {
        const list = this.postings.get(t);
        if (list) list.push({ doc: i, tf });
        else this.postings.set(t, [{ doc: i, tf }]);
      }
    }
    this.avgLength = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length);
  }

  get size(): number {
    return this.docs.length;
  }

  search(query: string, k = 5): Bm25Result<T>[] {
    const terms = tokens(query);
    if (!terms.length || !this.docs.length) return [];
    const n = this.docs.length;
    const scores = new Map<number, number>();

    for (const term of new Set(terms)) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const { doc, tf } of list) {
        const len = this.lengths[doc] || 1;
        const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / (this.avgLength || 1)));
        scores.set(doc, (scores.get(doc) ?? 0) + idf * norm);
      }
    }

    return [...scores]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, k)
      .map(([i, score]) => ({ doc: this.docs[i]!, score: Math.round(score * 1000) / 1000 }));
  }
}
