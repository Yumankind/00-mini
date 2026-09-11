/**
 * The crawl's progress as a bar and a sentence — pure, so a test can pin the words.
 *
 * WHY THE DENOMINATOR IS THE BOUND. A crawl cannot know a site's size before it has walked it: the
 * frontier grows as pages are read. The one number fixed before a round starts is its page bound
 * (60 on load, 40 on a hint), so that is what the bar is drawn against, and the sentence counts
 * pages rather than promising a percentage of "the site". A round that ends early — the site was
 * smaller than the bound — jumps to full and says how many pages it read, which is the truth.
 */
import type { CrawlProgress } from "../crawl/crawler.js";

export interface CrawlBarState {
  /** 0–100 for the bar's width. */
  percent: number;
  /** "Reading this site · 12 of 60 pages", "Read 23 pages". */
  line: string;
  /** True for the moment the bar should stay visible after finishing, false when nothing is running. */
  visible: boolean;
  finished: boolean;
}

const PHASE_WORDS = {
  load: "Reading this site",
  refresh: "Re-reading pages that may have changed",
  hint: "Looking further into this site",
} as const;

export function crawlBarState(p: CrawlProgress | null): CrawlBarState {
  if (!p) return { percent: 0, line: "", visible: false, finished: false };
  const max = Math.max(1, p.max);
  if (p.finished) {
    const n = p.done;
    return {
      percent: 100,
      line: n === 0 ? "Nothing new to read" : `Read ${n} page${n === 1 ? "" : "s"}`,
      visible: true,
      finished: true,
    };
  }
  // The frontier may hold more than the bound; the bar never runs past what the round will do.
  const total = Math.min(max, Math.max(p.done + p.queued, 1));
  const percent = Math.max(2, Math.min(99, Math.round((p.done / total) * 100)));
  return {
    percent,
    line: `${PHASE_WORDS[p.phase]} · ${p.done} of ${total} page${total === 1 ? "" : "s"}`,
    visible: true,
    finished: false,
  };
}

/** How long the finished bar stays before it slides away. */
export const CRAWL_BAR_LINGER_MS = 1800;
