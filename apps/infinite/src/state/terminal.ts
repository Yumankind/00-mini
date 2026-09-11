/**
 * The terminal pane's state: a scrollback, a history, and one `BuiltinShell`.
 *
 * ITS OWN SHELL INSTANCE, over the SAME filesystem. The agent's `bash` gets a shell too
 * (`fullTools({ shell })` in the bootstrap), and it would be tempting to share one — but a shell
 * carries a working directory, and an agent that `cd`s into `projects/site` mid-turn would move the
 * cursor under the person's hands. Same files, same guard, two cwds: which is exactly what two
 * terminals on a Mac are.
 *
 * OUTPUT ARRIVES WHILE IT RUNS. `node` and `npm install` have a real process behind them now
 * (src/power/js-runner.ts over `@00/agent-node`), so the shell streams their chunks to an
 * `OutputSink` and this store turns them into rows line by line — a long install prints as it
 * fetches instead of appearing all at once at the end. The agent's `bash` passes no sink and still
 * gets the two strings a tool result is.
 *
 * THE AGENT'S OWN COMMANDS APPEAR HERE. `command_started` / `command_completed` are on the contract's
 * event bus, so when the agent runs something the person sees the line in the same scrollback, marked
 * as the agent's. A terminal that showed only what YOU typed would be a worse answer to "what did it
 * just do?" than the chat already gives.
 */
import { computed, ref } from "vue";
import type { AgentEvent } from "@00/agent-runtime";
import { BuiltinShell } from "../power/shell.js";
import { createPowerGit } from "../power/git-bridge.js";
import { agent } from "./agent.js";
import { companionGitRemote } from "./companion.js";
import { refreshFiles } from "./files.js";
import { ensurePortRuntime } from "./ports.js";

export type TerminalRow =
  | { kind: "input"; cwd: string; text: string }
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "exit"; code: number }
  | { kind: "agent"; text: string; code?: number }
  | { kind: "note"; text: string };

/** Rows past this fall off the top. A browser tab's memory is the person's whole session. */
export const SCROLLBACK_MAX = 500;
export const HISTORY_MAX = 200;

const rowsRef = ref<TerminalRow[]>([]);
const historyRef = ref<string[]>([]);
const cursor = ref(-1);
const busyRef = ref(false);
const cwdRef = ref("/");
let shell: BuiltinShell | null = null;
let detach: (() => void) | null = null;
let controller: AbortController | null = null;

export const terminalRows = computed(() => rowsRef.value);
export const terminalBusy = computed(() => busyRef.value);
export const terminalCwd = computed(() => cwdRef.value);
export const terminalHistory = computed(() => historyRef.value);

// ── The pure parts (the ones a test can hold still) ───────────────────────────────────────────────

/** Append, and keep the scrollback bounded. */
export function appendRow(rows: TerminalRow[], row: TerminalRow, max = SCROLLBACK_MAX): TerminalRow[] {
  const next = [...rows, row];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Bash's rule: a repeat of the last line is not remembered twice, and blanks never are. */
export function rememberCommand(history: string[], command: string, max = HISTORY_MAX): string[] {
  const text = command.trim();
  if (!text || history[history.length - 1] === text) return history;
  const next = [...history, text];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Up/down through the history. `index` is -1 for "nothing recalled yet"; walking past the newest end
 * returns to -1 and an empty line, which is what every shell does and what a person expects when
 * they press Down once too often.
 */
export function recall(history: string[], index: number, direction: -1 | 1): { index: number; text: string } {
  if (!history.length) return { index: -1, text: "" };
  if (index === -1) {
    return direction === -1 ? { index: history.length - 1, text: history[history.length - 1]! } : { index: -1, text: "" };
  }
  const next = index + (direction === -1 ? -1 : 1);
  if (next < 0) return { index: 0, text: history[0]! };
  if (next >= history.length) return { index: -1, text: "" };
  return { index: next, text: history[next]! };
}

// ── The store ─────────────────────────────────────────────────────────────────────────────────────

function push(row: TerminalRow): void {
  rowsRef.value = appendRow(rowsRef.value, row);
}

/** The shell, built on first use so a browser that never opens the terminal never builds one. */
export function terminal(): BuiltinShell | null {
  const owned = agent.value;
  if (!owned) return null;
  if (!shell) {
    // The network policy travels: a script `node` runs reaches exactly the hosts the person put on
    // the agent's own list, and nothing else (src/power/node-runtime-worker.ts, `hostAllowed`).
    shell = new BuiltinShell(owned.fs, {
      // The person's own terminal gets the same road out as the agent's `bash` (§14): `git push`
      // works here exactly when the companion is paired, and says why when it is not.
      git: createPowerGit(owned.fs, "workspace", { remote: companionGitRemote }),
      network: owned.settings().network ?? null,
    });
    cwdRef.value = shell.cwd;
    // `serve` and `node`'s `listen` register virtual ports the moment they are typed, and the service
    // worker must already have somebody to ask. One idempotent call, here, is the whole wiring.
    ensurePortRuntime();
  }
  return shell;
}

/** Subscribe to the agent's own commands. Idempotent; the teardown is for a test and for a Restore. */
export function watchAgentCommands(): () => void {
  const owned = agent.value;
  if (!owned || detach) return () => undefined;
  const onEvent = (event: AgentEvent): void => {
    if (event.type === "command_started") push({ kind: "agent", text: event.command });
    else if (event.type === "command_completed") {
      const last = rowsRef.value[rowsRef.value.length - 1];
      if (last?.kind === "agent" && last.code === undefined && last.text === event.command) {
        rowsRef.value = [...rowsRef.value.slice(0, -1), { ...last, code: event.exitCode }];
      } else push({ kind: "agent", text: event.command, code: event.exitCode });
    }
  };
  detach = owned.runtime.on(onEvent);
  return () => {
    detach?.();
    detach = null;
  };
}

/** What the pane shows the first time it opens — the shell naming itself, as a real one does. */
export function greet(): void {
  if (rowsRef.value.length) return;
  const sh = terminal();
  push({
    kind: "note",
    text: sh
      ? `${sh.label} — your workspace is /, and there is no way out of it. \`help\` lists what it knows.`
      : "no agent yet",
  });
}

export async function runCommand(command: string): Promise<void> {
  const text = command.trim();
  const sh = terminal();
  if (!sh || busyRef.value) return;
  push({ kind: "input", cwd: cwdRef.value, text: command });
  historyRef.value = rememberCommand(historyRef.value, command);
  cursor.value = -1;
  if (!text) return;

  busyRef.value = true;
  controller = new AbortController();
  // LIVE OUTPUT, BY LINE. `node` and `npm install` hand over chunks as they are written
  // (src/power/shell.ts, `OutputSink`), and a chunk is not a line — a script can write half of one
  // and finish it a second later. So the partial tail is held per stream and only whole lines become
  // rows; whatever is left when the command ends is flushed as the last one. Text that arrives this
  // way is NOT in the result, so nothing is printed twice.
  const partial: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  const stream = (kind: "stdout" | "stderr", text: string): void => {
    const all = partial[kind] + text;
    const rows = all.split("\n");
    partial[kind] = rows.pop() ?? "";
    for (const row of rows) push({ kind, text: row });
  };
  const flush = (): void => {
    for (const kind of ["stdout", "stderr"] as const) {
      if (partial[kind]) push({ kind, text: partial[kind] });
      partial[kind] = "";
    }
  };
  try {
    const result = await sh.exec(text, {
      cwd: "workspace",
      signal: controller.signal,
      onOutput: (chunk) => stream(chunk.stream, chunk.text),
    });
    flush();
    if (result.stdout) push({ kind: "stdout", text: result.stdout.replace(/\n$/, "") });
    if (result.stderr) push({ kind: "stderr", text: result.stderr.replace(/\n$/, "") });
    if (result.exitCode !== 0) push({ kind: "exit", code: result.exitCode });
    cwdRef.value = sh.cwd;
    // A command that writes is the same event the agent's writes are; the tree must not lag behind.
    // `node` and `npm run` are in the list because a script's `fs.promises.writeFile` lands in the
    // same workspace through the runner's RPC (src/power/js-runner.ts).
    if (/\b(rm|mv|cp|mkdir|touch|tee|git|node|npm|npx)\b|>/.test(text)) await refreshFiles();
  } catch (err) {
    flush();
    push({ kind: "stderr", text: err instanceof Error ? err.message : String(err) });
  } finally {
    busyRef.value = false;
    controller = null;
  }
}

export function abortCommand(): void {
  controller?.abort();
}

/** Up/down at the prompt. Returns the line the input should now hold. */
export function historyStep(direction: -1 | 1): string {
  const next = recall(historyRef.value, cursor.value, direction);
  cursor.value = next.index;
  return next.text;
}

export function clearTerminal(): void {
  rowsRef.value = [];
}

/** Test seam, and what a Restore calls: a new filesystem needs a new shell. */
export function resetTerminal(): void {
  rowsRef.value = [];
  historyRef.value = [];
  cursor.value = -1;
  busyRef.value = false;
  cwdRef.value = "/";
  shell = null;
  detach?.();
  detach = null;
}
