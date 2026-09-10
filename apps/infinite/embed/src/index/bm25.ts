/**
 * BM25 over the crawled text (§5.2.1, "text is chunked and BM25-indexed").
 *
 * WHY BM25 and not embeddings: level 0 must work with NO model at all — retrieval is the product
 * before a brain is anywhere near it, and it has to be instant on a phone and rebuildable from a
 * few hundred KB of text. BM25 is thirty lines, needs no download, and ranks a site's own pages
 * better than a cosine over a 20 MB model would.
 *
 * Chunks are cut at paragraph boundaries and carry the heading they sat under, so a hit can be
 * quoted with a place ("Refunds, on /help/returns") rather than as a floating sentence.
 */

import type { Chunk, PageEntry, SearchHit } from "../types.js";

const K1 = 1.2;
const B = 0.75;
export const CHUNK_CHARS = 600;

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && t.length < 32);
}

/** Cut one page into chunks, attributing each to the last heading seen above it. */
export function chunkPage(entry: PageEntry, maxChars = CHUNK_CHARS): Chunk[] {
  const headings = new Set(entry.headings.map((h) => h.trim()));
  const out: Chunk[] = [];
  let heading = entry.title;
  let buffer = "";

  const flush = (): void => {
    const text = buffer.trim();
    if (text.length > 1) out.push({ url: entry.url, heading, text });
    buffer = "";
  };

  for (const rawLine of entry.text.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (headings.has(line) && line.length < 120) {
      flush();
      heading = line;
      continue;
    }
    if (buffer.length + line.length > maxChars) flush();
    buffer += (buffer ? "\n" : "") + line;
  }
  flush();
  return out;
}

interface Posting {
  chunk: number;
  tf: number;
}

/** An immutable index; rebuilding is cheap enough that adding pages just rebuilds. */
export class Bm25Index {
  private readonly postings = new Map<string, Posting[]>();
  private readonly lengths: number[] = [];
  private avgLength = 0;

  constructor(readonly chunks: Chunk[]) {
    for (const [i, chunk] of chunks.entries()) {
      const terms = tokens(`${chunk.heading} ${chunk.text}`);
      this.lengths[i] = terms.length;
      const counts = new Map<string, number>();
      for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const [t, tf] of counts) {
        const list = this.postings.get(t);
        if (list) list.push({ chunk: i, tf });
        else this.postings.set(t, [{ chunk: i, tf }]);
      }
    }
    this.avgLength = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length);
  }

  search(query: string, k = 5): { chunk: Chunk; score: number }[] {
    const terms = tokens(query);
    if (!terms.length || !this.chunks.length) return [];
    const n = this.chunks.length;
    const scores = new Map<number, number>();

    for (const term of new Set(terms)) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const { chunk, tf } of list) {
        const len = this.lengths[chunk] || 1;
        const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / (this.avgLength || 1)));
        scores.set(chunk, (scores.get(chunk) ?? 0) + idf * norm);
      }
    }

    return [...scores]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([i, score]) => ({ chunk: this.chunks[i]!, score: Math.round(score * 1000) / 1000 }));
  }
}

/** A hit, trimmed to the sentence-ish window around the first query term. */
export function toHit(chunk: Chunk, score: number, title: string, query: string): SearchHit {
  const terms = tokens(query);
  const lower = chunk.text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, chunk.text.lastIndexOf(" ", Math.max(0, at - 90)) + 1);
  const passage = chunk.text.slice(start, start + 260).trim();
  return {
    url: chunk.url,
    title,
    heading: chunk.heading,
    passage: (start > 0 ? "…" : "") + passage + (start + 260 < chunk.text.length ? "…" : ""),
    score,
  };
}
