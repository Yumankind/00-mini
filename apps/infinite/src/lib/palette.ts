/**
 * THE COMMAND PALETTE'S MATCHING — ⌘K, and what a typed word is allowed to find.
 *
 * Subsequence matching rather than substring, because that is what a palette is for: `wsp` finds
 * "Open the workspace" and `idx` finds `workspace/site/index.html` without anybody having to
 * remember which words the label actually uses. Ranking is by how tight the match is and then by
 * where it starts, so an exact prefix always wins over a scatter of letters.
 *
 * Pure, so the component can be a list and nothing else.
 */

export interface PaletteItem {
  id: string;
  label: string;
  /** The group heading, and the second string a query may match ("File", "Theme"). */
  section: string;
  hint?: string;
  icon?: string;
}

/**
 * Every letter of `query`, in order, somewhere in `text`. Returns a score (lower is better) or null.
 * A run of adjacent letters costs nothing; a gap costs what it skipped.
 */
export function subsequenceScore(text: string, query: string): number | null {
  if (!query) return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let at = 0;
  let score = 0;
  for (const letter of needle) {
    const found = haystack.indexOf(letter, at);
    if (found === -1) return null;
    score += found - at;
    at = found + 1;
  }
  // An exact substring is the strongest signal there is; give it a floor nothing scattered can reach.
  if (haystack.includes(needle)) score -= 100 - Math.min(99, haystack.indexOf(needle));
  return score;
}

/** The matching items, best first. An empty query keeps the given order, which is the curated one. */
export function rankItems<T extends PaletteItem>(items: T[], query: string): T[] {
  const trimmed = query.trim();
  if (!trimmed) return items;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const label = subsequenceScore(item.label, trimmed);
    const section = subsequenceScore(`${item.section} ${item.label}`, trimmed);
    const best = label === null ? section : section === null ? label : Math.min(label, section);
    if (best !== null) scored.push({ item, score: best });
  }
  return scored.sort((a, b) => a.score - b.score || a.item.label.length - b.item.label.length).map((s) => s.item);
}

/** Wrap the index so arrow keys run round the list rather than stopping at its ends. */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}
