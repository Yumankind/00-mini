/**
 * `read_public` — the owner's own words, served by the owner's own site.
 *
 * WHY it is capped and same-origin: this is the embed's copy of the Mac agent's `workspace/public/`
 * boundary (§5.5). The owner names a few text files in `site.json`; the embed may read those and
 * nothing else. A path that leaves the origin is not fetched, a non-text answer is dropped, and the
 * whole set is capped at 256 KB (§5.2.4) so a knowledge base cannot become a download.
 *
 * With this in place, an owner has a persona and an FAQ on their embed with no account, no
 * registration and no server of ours (§5.2.4, closing note).
 */

import { normalisePath } from "./site-config.js";

export const KNOWLEDGE_BUDGET_BYTES = 256 * 1024;

export interface KnowledgeReader {
  /** The paths the owner declared, already validated. */
  list(): string[];
  read(path: string): Promise<string | null>;
}

export interface KnowledgeOptions {
  origin: string;
  paths: string[];
  fetchImpl: typeof fetch;
}

export function createKnowledgeReader(opts: KnowledgeOptions): KnowledgeReader {
  const allowed = opts.paths.map((p) => normalisePath(p)).filter((p): p is string => !!p);
  const cache = new Map<string, string>();
  let spent = 0;

  return {
    list: () => [...allowed],
    async read(path: string): Promise<string | null> {
      const wanted = normalisePath(path);
      // Only what the owner declared. An arbitrary path would turn `read_public` into a same-origin
      // reader of the whole site — which is the crawler's job, under the crawler's guards.
      if (!wanted || !allowed.includes(wanted)) return null;
      const hit = cache.get(wanted);
      if (hit !== undefined) return hit;
      if (spent >= KNOWLEDGE_BUDGET_BYTES) return null;

      try {
        const res = await opts.fetchImpl(new URL(wanted, opts.origin).toString(), {
          method: "GET",
          credentials: "same-origin",
        });
        if (!res.ok) return null;
        const type = res.headers.get("content-type") ?? "";
        if (type && !/^text\/|json|markdown/i.test(type)) return null;
        const body = (await res.text()).slice(0, KNOWLEDGE_BUDGET_BYTES - spent);
        spent += body.length;
        cache.set(wanted, body);
        return body;
      } catch {
        return null;
      }
    },
  };
}
