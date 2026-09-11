/**
 * What the rest of the app — and `runtime/bootstrap.ts` — reaches for.
 *
 * ONE LINE FOR THE BOOTSTRAP. The engine's full agent gets a real shell; in a browser tab that shell
 * is `BuiltinShell`, and wiring it is a single argument to `fullTools`:
 *
 *     const tools: Tool[] = fullTools({ shell: createBrowserShell(fs) });
 *
 * That also flips `bash`'s answer from `NoShell`'s "wakes on your Mac" to a command that actually
 * ran, which is gap-audit item A5: today the prompt says the agent can run bash and every call
 * returns 127. The git tools come with it (`fullTools({ git: … })`) and are gap B8's, not this
 * module's, so they are exported rather than assumed.
 */
import type { AgentFs } from "@00/agent-fs";
import { BuiltinShell, type BuiltinShellOptions } from "./shell.js";
import { createPowerGit } from "./git-bridge.js";

export { BuiltinShell, GIT_REMOTE_LINE, NO_NODE_LINE, expandSet, lsLong, parse, rangeToNumbers, strftime, tokenize } from "./shell.js";
export type { ExecResult, ShellGit, BuiltinShellOptions, OutputSink, ParsedCommand, ParsedStage, Token } from "./shell.js";
export { GIT_UNAVAILABLE, UNSTAGE_UNAVAILABLE, createPowerGit, gitUsable } from "./git-bridge.js";
export type { PowerGit, RepoCommit, RepoStatus } from "./git-bridge.js";
export { MAX_INLINE_BYTES, buildPortPreview, buildPreview, toBase64 } from "./preview.js";
export type { PreviewBuild } from "./preview.js";
/** `node`, `npm` and the ports they open — the terminal row of §4.2, in a browser tab. */
export { DEFAULT_TIMEOUT_MS, NO_PACKAGES_LINE, answerFs, runScript, snapshotFolder } from "./js-runner.js";
export type { RunScriptOptions, RunScriptResult, Snapshot } from "./js-runner.js";
/** The Worker a process becomes, and the in-process twin the node suite drives it with. */
export { createBrowserNodeWorker, createInlineNodeWorker, serveNodeProcess } from "./node-runtime-worker.js";
export type { BootMessage, SyncCallable } from "./node-runtime-worker.js";
export {
  DEFAULT_SERVE_PORT,
  FILES_ROOT,
  PortInUseError,
  answerBridgeMessage,
  folderHandler,
  handleVirtualRequest,
  installServiceWorkerBridge,
  listPorts,
  onPortsChanged,
  portUrl,
  registerPort,
  resetPorts,
  serveFolder,
  setWorkspaceFs,
  unregister,
} from "./virtual-ports.js";
export type { PortEntry, PortHandler, VirtualRequest, VirtualResponse } from "./virtual-ports.js";
export { INDENT, changedUnderneath, gutter, indent, lineCount } from "./editor.js";
export type { EditState } from "./editor.js";

/**
 * The shell the agent's `bash` runs in, with git behind its `git` subcommand.
 *
 * NO NETWORK BY DEFAULT. A script the AGENT starts reaches no host at all unless a caller passes the
 * person's own allow list here — the terminal does (`src/state/terminal.ts`), and until the bootstrap
 * does too, `fetch` inside a script the agent wrote refuses by host name. That direction is the safe
 * one: the agent's `http_get` already asks before it dials, and a script is not a place to lose that.
 */
export function createBrowserShell(fs: AgentFs, opts: Pick<BuiltinShellOptions, "network" | "npm"> = {}): BuiltinShell {
  return new BuiltinShell(fs, { git: createPowerGit(fs), ...opts });
}
