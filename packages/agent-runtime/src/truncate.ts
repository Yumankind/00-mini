/**
 * Output caps, kept in one place because they are a CONTRACT with the model, not a detail.
 *
 * Every number here is pi's (`core/tools/truncate.js` in @earendil-works/pi-coding-agent, and the
 * per-tool defaults in read/ls/grep/find), so a skill written against the Mac agent — "read it in
 * pages of 2000 lines", "grep gives me 100 matches" — behaves the same in a browser tab.
 *
 * ONE DELIBERATE DIFFERENCE: pi counts BYTES (`Buffer.byteLength`) and this counts UTF-16 CHARS.
 * There is no Buffer in a Worker, and `TextEncoder` on every line of every file is a real cost for a
 * bound that exists to stop a 40 MB paste, not to be exact. For ASCII the two agree; for CJK this
 * one is more generous by up to 3×. Stated here rather than discovered later.
 */

/** pi: DEFAULT_MAX_LINES. */
export const MAX_OUTPUT_LINES = 2000;
/** pi: DEFAULT_MAX_BYTES (50 KB), counted here in chars — see the header. */
export const MAX_OUTPUT_CHARS = 50 * 1024;
/** pi: GREP_MAX_LINE_LENGTH. */
export const GREP_MAX_LINE_CHARS = 500;
/** pi's per-tool defaults. */
export const LS_DEFAULT_LIMIT = 500;
export const GREP_DEFAULT_LIMIT = 100;
export const FIND_DEFAULT_LIMIT = 1000;
/** The engine's read_public cap (apps/00d/src/light-tools.ts). */
export const PUBLIC_READ_MAX_CHARS = 20000;

export interface Truncation {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "chars" | null;
  totalLines: number;
  outputLines: number;
  totalChars: number;
}

function countLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * Keep the FIRST complete lines that fit both limits. Never returns a partial line — a model handed
 * half a line of JSON will confidently parse the half.
 */
export function truncateHead(
  content: string,
  opts: { maxLines?: number; maxChars?: number } = {},
): Truncation {
  const maxLines = opts.maxLines ?? MAX_OUTPUT_LINES;
  const maxChars = opts.maxChars ?? MAX_OUTPUT_CHARS;
  const lines = countLines(content);
  const totalLines = lines.length;
  const totalChars = content.length;
  if (totalLines <= maxLines && totalChars <= maxChars) {
    return { content, truncated: false, truncatedBy: null, totalLines, outputLines: totalLines, totalChars };
  }
  const kept: string[] = [];
  let chars = 0;
  let truncatedBy: "lines" | "chars" = "lines";
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const cost = lines[i].length + (i > 0 ? 1 : 0);
    if (chars + cost > maxChars) {
      truncatedBy = "chars";
      break;
    }
    kept.push(lines[i]);
    chars += cost;
  }
  if (kept.length >= maxLines && chars <= maxChars) truncatedBy = "lines";
  return {
    content: kept.join("\n"),
    truncated: true,
    truncatedBy,
    totalLines,
    outputLines: kept.length,
    totalChars,
  };
}

/**
 * The cap the RUNTIME applies to whatever a tool returned, after the tool's own limits.
 *
 * A tool can be a custom one, or a `bash` answering from a machine that does not know pi's numbers;
 * the loop still has to guarantee that one tool result cannot eat the context window. The note is
 * appended rather than replacing the output, and it says how to get the rest, because a truncated
 * answer with no way forward is how a model starts guessing.
 */
export function capToolOutput(output: string, maxChars: number = MAX_OUTPUT_CHARS): string {
  if (output.length <= maxChars) return output;
  const head = truncateHead(output, { maxChars, maxLines: Number.MAX_SAFE_INTEGER });
  const shown = head.content.length > 0 ? head.content : output.slice(0, maxChars);
  return `${shown}\n\n[Output truncated: ${shown.length} of ${output.length} characters shown. Narrow the request (a path, a pattern, offset/limit) to see the rest.]`;
}

/** pi's grep line cap, same wording. */
export function truncateLine(line: string, maxChars: number = GREP_MAX_LINE_CHARS): string {
  return line.length <= maxChars ? line : `${line.slice(0, maxChars)}... [truncated]`;
}
