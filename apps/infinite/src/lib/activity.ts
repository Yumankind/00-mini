/**
 * WHAT THE AGENT DID, IN ONE LINE — the thread's activity card.
 *
 * `lib/conversation.ts` already folds repeated calls of the SAME tool into one row ("read ×7").
 * That is the right grouping for the reducer and the wrong one for a reader: a turn that reads three
 * files, greps the workspace and writes one back is five rows of tool names where a person wanted
 * one sentence — "Read 3 files", and the rest behind a disclosure.
 *
 * So this is a SECOND fold, over the rows rather than over the events: consecutive tool rows become
 * one card, and the card is named after what the tools in it have in common. It is pure and it is
 * tested, because the naming is the whole of the feature — the component only draws the label it is
 * given and the rows behind it.
 */
import type { Row } from "./conversation.js";

export type ToolRow = Row & { kind: "tool" };

export interface ActivityRow {
  kind: "activity";
  id: string;
  /** "Read 3 files", "Ran a command" — the sentence on the closed card. */
  label: string;
  state: "running" | "failed" | "done";
  /** Wall time of everything in the card. */
  ms: number;
  /** Every tool row folded in, in order, for the open card. */
  tools: ToolRow[];
}

/** What the thread draws: the reducer's rows, with runs of tool rows replaced by one card. */
export type ThreadRow = Exclude<Row, { kind: "tool" }> | ActivityRow;

type Family = "read" | "search" | "edit" | "run" | "fetch" | "git" | "memory" | "secrets" | "other";

const FAMILY: Record<string, Family> = {
  read: "read",
  read_public: "read",
  stat: "read",
  ls: "read",
  find: "search",
  grep: "search",
  search_workspace: "search",
  write: "edit",
  edit: "edit",
  copy: "edit",
  move: "edit",
  delete: "edit",
  bash: "run",
  http_get: "fetch",
  remember: "memory",
  list_secrets: "secrets",
};

export function familyOf(name: string): Family {
  if (name.startsWith("git_")) return "git";
  return FAMILY[name] ?? "other";
}

/** `1 file` / `3 files` — the one place a count meets its noun, so no caller writes an "s". */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The sentence on a closed card. It says what was DONE, never which tool did it: "read ×3" is the
 * runtime's vocabulary and "Read 3 files" is a person's.
 */
export function activityLabel(tools: ToolRow[]): string {
  if (!tools.length) return "Worked";
  const calls = tools.reduce((sum, row) => sum + row.calls, 0);
  const families = new Set(tools.map((row) => familyOf(row.name)));
  if (families.size > 1) return `Worked on ${count(families.size, "thing")}`;
  const [family] = [...families];
  switch (family) {
    case "read":
      return `Read ${count(calls, "file")}`;
    case "search":
      return "Searched the workspace";
    case "edit":
      return `Edited ${count(calls, "file")}`;
    case "run":
      return `Ran ${count(calls, "command")}`;
    case "fetch":
      return `Fetched ${count(calls, "page")}`;
    case "git":
      return "Worked with Git";
    case "memory":
      return "Wrote to its memory";
    case "secrets":
      return "Looked in the vault";
    default:
      // An unknown tool is named rather than described — a wrong verb is worse than a bare name.
      return tools.length === 1 && tools[0]!.calls === 1
        ? tools[0]!.name
        : tools.map((row) => (row.calls > 1 ? `${row.name} ×${row.calls}` : row.name)).join(", ");
  }
}

export function activityState(tools: ToolRow[]): ActivityRow["state"] {
  if (tools.some((row) => row.running > 0)) return "running";
  return tools.some((row) => row.failed > 0) ? "failed" : "done";
}

/** Rows in, rows to draw out. Anything that is not a tool row passes through untouched. */
export function foldActivity(rows: Row[]): ThreadRow[] {
  const out: ThreadRow[] = [];
  let run: ToolRow[] = [];
  const flush = (): void => {
    if (!run.length) return;
    out.push({
      kind: "activity",
      // The first row's id, so a card keeps its identity (and its open/closed state) while the run
      // it belongs to is still growing.
      id: `a${run[0]!.id}`,
      label: activityLabel(run),
      state: activityState(run),
      ms: run.reduce((sum, row) => sum + row.ms, 0),
      tools: run,
    });
    run = [];
  };
  for (const row of rows) {
    if (row.kind === "tool") {
      run.push(row);
      continue;
    }
    flush();
    out.push(row);
  }
  flush();
  return out;
}

/** `1.4s`, `240ms` — a duration a person reads at a glance rather than counts the digits of. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}
