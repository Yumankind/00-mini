/**
 * `remember` — one tool, two files, so the index never drifts from the notes.
 *
 * The layout is the engine's (docs/agent-layout.md): `MEMORY.md` is the INDEX and `memory/YYYY-MM-DD.md`
 * are the dated notes it links out to. An agent doing that by hand with `write` gets it right the
 * first ten times and then writes a note without an index line — after which the note is invisible,
 * because the context injects the index and nothing else (see ContextManager). One tool that appends
 * the note AND ensures the index line is the only way that stays true.
 *
 * It is `confirm` rather than `safe` for the same reason `write` is: it changes the agent's own
 * identity surface, which travels in every bundle mode (`identity` class), so a memory written on a
 * whim in a browser follows the person to every host they own.
 */
import type { Tool } from "./api.js";
import { relativeToSandbox, resolveInSandbox } from "./sandbox.js";

/** The heading the index groups dated notes under; created on first use, never duplicated. */
const INDEX_HEADING = "## Dated notes";

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2026-09-10` in the agent's own clock. Dates are the note's filename, so they are local, not UTC. */
export function noteDate(now: Date): string {
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

export function rememberTool(opts: { now?: () => Date } = {}): Tool {
  const now = opts.now ?? (() => new Date());
  return {
    tier: "confirm",
    schema: {
      name: "remember",
      description:
        "Write something down for good. Appends a dated note under memory/YYYY-MM-DD.md and keeps MEMORY.md's index in step. Use it for durable facts about the person, decisions taken, and what you learned — session context does not persist, and this is the only thing that does.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "The note itself. Write it so it makes sense months from now." },
          title: { type: "string", description: "Optional short heading for this note." },
        },
        required: ["note"],
      },
    },
    async run(args, ctx) {
      const note = typeof args.note === "string" ? args.note.trim() : "";
      if (!note) return { output: "A note needs some text.", isError: true };
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const at = now();
      const date = noteDate(at);
      const time = `${two(at.getHours())}:${two(at.getMinutes())}`;

      const notePath = resolveInSandbox(ctx.sandbox, `memory/${date}.md`);
      await ctx.fs.mkdir(resolveInSandbox(ctx.sandbox, "memory"));
      const existing = (await ctx.fs.stat(notePath)) ? await ctx.fs.readText(notePath) : "";
      // The same words twice on one day is a model repeating itself, not a second fact (a stuck
      // Gemma wrote "waiting for the correct path" forty times on 2026-09-11). Said, not written.
      if (existing.includes(`\n${note}\n`)) {
        return { output: `Already remembered today, in ${relativeToSandbox(ctx.sandbox, notePath)} — nothing added.` };
      }
      const head = existing || `# ${date}\n`;
      const entry = `\n## ${time}${title ? ` — ${title}` : ""}\n\n${note}\n`;
      await ctx.fs.writeFile(notePath, `${head.replace(/\n*$/, "\n")}${entry}`);
      ctx.emit({ type: "file_changed", path: notePath, op: "write" });

      const indexPath = resolveInSandbox(ctx.sandbox, "MEMORY.md");
      const link = `- [${date}](memory/${date}.md)`;
      const index = (await ctx.fs.stat(indexPath)) ? await ctx.fs.readText(indexPath) : "";
      if (!index.includes(`memory/${date}.md`)) {
        const withHeading = index.includes(INDEX_HEADING)
          ? index.replace(INDEX_HEADING, `${INDEX_HEADING}\n${link}`)
          : `${index ? `${index.replace(/\n*$/, "\n")}\n` : "# MEMORY\n\nThe index of what I know. Notes live in memory/.\n\n"}${INDEX_HEADING}\n${link}\n`;
        await ctx.fs.writeFile(indexPath, withHeading);
        ctx.emit({ type: "file_changed", path: indexPath, op: "write" });
      }
      return {
        output: `Remembered in ${relativeToSandbox(ctx.sandbox, notePath)}${
          index.includes(`memory/${date}.md`) ? "" : " (and linked from MEMORY.md)"
        }.`,
      };
    },
  };
}
