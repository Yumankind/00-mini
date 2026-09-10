/**
 * The editor's keyboard, as pure functions over (text, selection).
 *
 * WHY A TEXTAREA AND NOT CODEMIRROR. CodeMirror 6 is ~200 KB gzipped and a second scroll container,
 * a second selection model and a second theme to keep in step with the 00 tokens; the editor this
 * app needs is "open the file the agent just wrote, fix a line, save". A textarea gives that for
 * nothing, with the platform's own undo stack, its own IME and its own accessibility — and it costs
 * exactly three behaviours, which are the three below. The day someone wants syntax highlighting is
 * the day this becomes a real editor; until then the honest small thing beats the half-wired big one.
 *
 * They are here rather than in the component because a keystroke that silently eats a person's
 * selection is the kind of bug you only catch by asserting on offsets.
 */

/** Two spaces. The engine's own files are two-space, and a tab character in a workspace file is a diff. */
export const INDENT = "  ";

export interface EditState {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

function lineStartsIn(value: string, from: number, to: number): number[] {
  const starts: number[] = [];
  let index = value.lastIndexOf("\n", from - 1) + 1;
  starts.push(index);
  while (true) {
    const next = value.indexOf("\n", index);
    if (next === -1 || next >= to) break;
    index = next + 1;
    starts.push(index);
  }
  return starts;
}

/**
 * Tab. With no selection it inserts an indent; across a selection it indents every line it touches,
 * which is what makes a textarea usable for code at all. Shift+Tab outdents by up to one indent.
 */
export function indent(state: EditState, outdent = false): EditState {
  const { value, selectionStart, selectionEnd } = state;
  const oneLine = selectionStart === selectionEnd && !outdent;
  if (oneLine) {
    return {
      value: value.slice(0, selectionStart) + INDENT + value.slice(selectionEnd),
      selectionStart: selectionStart + INDENT.length,
      selectionEnd: selectionStart + INDENT.length,
    };
  }
  const starts = lineStartsIn(value, selectionStart, selectionEnd);
  let out = value;
  let shiftFirst = 0;
  let shiftTotal = 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    const at = starts[i]!;
    if (outdent) {
      const ahead = out.slice(at, at + INDENT.length);
      const removed = ahead === INDENT ? INDENT.length : ahead.startsWith(" ") ? 1 : 0;
      if (!removed) continue;
      out = out.slice(0, at) + out.slice(at + removed);
      shiftTotal -= removed;
      if (i === 0) shiftFirst = -removed;
      continue;
    }
    out = out.slice(0, at) + INDENT + out.slice(at);
    shiftTotal += INDENT.length;
    if (i === 0) shiftFirst = INDENT.length;
  }
  return {
    value: out,
    selectionStart: Math.max(starts[0] ?? 0, selectionStart + shiftFirst),
    selectionEnd: Math.max(starts[0] ?? 0, selectionEnd + shiftTotal),
  };
}

/** How many rows the gutter needs. A file with no trailing newline still has its last line. */
export function lineCount(text: string): number {
  if (text === "") return 1;
  return text.split("\n").length;
}

/** The gutter's own text — one string, so the gutter is one node that scrolls with the textarea. */
export function gutter(text: string): string {
  const total = lineCount(text);
  const out: string[] = [];
  for (let n = 1; n <= total; n++) out.push(String(n));
  return out.join("\n");
}

/**
 * Has the file changed under us? Compared on mtime AND size, because an adapter that cannot know an
 * mtime answers 0 for every file (the contract says so) and two writes of different lengths are then
 * the only signal left. Equal-and-unknown reads as "unchanged", which is the safe way round: the
 * person is warned about a real overwrite, not nagged about a phantom one.
 */
export function changedUnderneath(
  opened: { mtime: number; size: number } | null,
  current: { mtime: number; size: number } | null,
): boolean {
  if (!opened || !current) return false;
  if (opened.mtime && current.mtime) return current.mtime > opened.mtime;
  return current.size !== opened.size;
}
