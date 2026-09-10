/**
 * `search_workspace` — ask a question, get the passages, no model required.
 *
 * It sits beside `grep`, not instead of it, and the descriptions say which is which because a model
 * choosing wrongly here wastes a whole turn: `grep` when you know the exact string, this when you
 * know what you MEAN. The prompt already tells the agent to reach into `memory/` by searching rather
 * than by loading the folder (context.ts); this is the tool that makes that instruction cheap.
 *
 * `safe`: it reads inside the sandbox and returns passages, which is what `grep` and `read` already
 * do without asking.
 */
import type { Tool } from "./api.js";
import type { WorkspaceIndex } from "./retrieval/workspace-index.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export function searchWorkspaceTool(index: WorkspaceIndex): Tool {
  return {
    tier: "safe",
    schema: {
      name: "search_workspace",
      description:
        "Search everything you have written — notes, memory, projects, skills — by MEANING rather than by exact string, and get back the best passages with their file and line numbers. Use this when you remember roughly what something said; use grep when you know the exact text to look for. Then read the file for the full context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you are looking for, in your own words." },
          limit: { type: "number", description: `Maximum passages to return (default: ${DEFAULT_LIMIT})` },
        },
        required: ["query"],
      },
    },
    async run(args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { output: "A query is required.", isError: true };
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_LIMIT),
      );
      const hits = await index.search(query, { limit });
      if (!hits.length) {
        const stats = await index.stats();
        return {
          output: stats.chunks
            ? `Nothing matched "${query}" in ${stats.files} indexed file${stats.files === 1 ? "" : "s"}. Try other words, or grep for an exact string.`
            : "There is nothing to search yet — no text files in this workspace.",
        };
      }
      const stats = await index.stats();
      const body = hits
        .map((hit) => `${hit.path}:${hit.fromLine}-${hit.toLine}  (score ${hit.score})\n${hit.passage}`)
        .join("\n\n");
      // The truncation notice is part of the ANSWER, not a log line: an agent that searched half a
      // workspace and said "there is nothing about that" would be lying without knowing it.
      return {
        output: stats.truncated
          ? `${body}\n\n[Only the first ${stats.files} files are indexed — this workspace has more.]`
          : body,
      };
    },
  };
}
