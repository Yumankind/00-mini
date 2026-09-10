/**
 * The panel with no model behind it (§5.2.3).
 *
 * WHY a rule-based helper and not "please load a model": without a brain the embed is still a site
 * search that can point at things, and that is genuinely useful — instant, offline, and the same
 * answer a good site search would give. So a handful of question shapes are recognised literally,
 * and each one becomes a short plan over the SAME tools the agent would use. No model is consulted,
 * nothing is invented: every line the visitor reads comes from the index or from the page.
 *
 * Pure on purpose — a plan in, no DOM, no fetch — so the shapes are unit-tested.
 */

import { tokens } from "../index/bm25.js";

export type Intent = "where" | "open" | "how" | "search";

export interface PlanStep {
  tool: "site_search" | "site_pages" | "site_crawl" | "page_highlight" | "page_open";
  args: Record<string, unknown>;
}

export interface Plan {
  intent: Intent;
  /** The subject, with the question words removed: "where is the pricing" → "pricing". */
  subject: string;
  steps: PlanStep[];
  /** The one line shown while the plan runs. */
  status: string;
}

const WHERE = /^\s*(where\s+(is|are|can\s+i|do\s+i)|find|show\s+me\s+where)\b/i;
const OPEN = /^\s*(open|go\s+to|take\s+me\s+to|show\s+me)\b/i;
const HOW = /^\s*(how\s+(do|can)\s+i|how\s+to)\b/i;

/** Strip the question shell so the index is searched for the subject, not for "where is". */
export function subjectOf(query: string): string {
  return query
    .replace(WHERE, "")
    .replace(OPEN, "")
    .replace(HOW, "")
    .replace(/^\s*(the|a|an|my|your)\b/i, "")
    .replace(/[?.!]+\s*$/, "")
    .trim();
}

export function planNoBrainReply(query: string): Plan {
  const subject = subjectOf(query) || query.trim();

  if (WHERE.test(query)) {
    // "where is X" → find the passage, then POINT at the control that matches (§5.2.2's example).
    return {
      intent: "where",
      subject,
      steps: [
        { tool: "site_search", args: { query: subject, k: 3 } },
        { tool: "page_highlight", args: { target: subject, note: subject } },
      ],
      status: `looking for ${subject}…`,
    };
  }

  if (OPEN.test(query)) {
    return {
      intent: "open",
      subject,
      steps: [
        { tool: "site_search", args: { query: subject, k: 3 } },
        { tool: "page_open", args: { url: "" } },
      ],
      status: `finding the ${subject} page…`,
    };
  }

  if (HOW.test(query)) {
    // A "how do I" that the index cannot answer is exactly the case a targeted round is for.
    return {
      intent: "how",
      subject,
      steps: [
        { tool: "site_search", args: { query: subject, k: 5 } },
        { tool: "site_crawl", args: { hint: subject } },
      ],
      status: `looking through the ${topicOf(subject)} pages…`,
    };
  }

  return {
    intent: "search",
    subject,
    steps: [{ tool: "site_search", args: { query: subject, k: 5 } }],
    status: "searching this site…",
  };
}

function topicOf(subject: string): string {
  const t = tokens(subject);
  return t.length ? t.slice(0, 2).join(" ") : "site";
}

/**
 * Which landmark on the current page a subject means. Used to turn a search hit into a
 * `page_highlight` target without a model: the best-matching accessible name wins, and a weak match
 * wins nothing, because pointing at the wrong button is worse than pointing at nothing.
 */
export function matchLandmark(
  subject: string,
  landmarks: { name: string; selector?: string; ref?: string }[],
): { target: string; name: string } | null {
  const terms = new Set(tokens(subject));
  if (!terms.size) return null;
  let best: { target: string; name: string; score: number } | null = null;
  for (const l of landmarks) {
    const words = tokens(l.name);
    if (!words.length) continue;
    const overlap = words.filter((w) => terms.has(w)).length;
    if (!overlap) continue;
    // Normalised so "Search" beats "Search our whole catalogue of products" for the word "search".
    const score = overlap / Math.sqrt(words.length);
    const target = l.ref ?? l.selector;
    if (target && (!best || score > best.score)) best = { target, name: l.name, score };
  }
  return best && best.score >= 0.5 ? { target: best.target, name: best.name } : null;
}
