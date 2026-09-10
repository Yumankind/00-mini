// @00/agent-runtime — see docs/HANDOFF-infinite-agent.md
//
// `api.ts` is the FROZEN contract (§2, §4) and stays first: everything below it is this package's
// own surface, added rather than substituted, so a PWA written against `api.ts` alone still compiles.
export * from "./api.js";

// The `@00/agent-models` types that appear IN this package's signatures, re-exported so a consumer
// can write against the runtime alone. `api.ts` imports them without re-exporting, and the PWA
// already reaches for `ChatMessage` from here (`loadSession` returns them) — a public method whose
// return type you cannot name is a contract with a hole in it.
export type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelInfo,
  ModelProvider,
  Role,
  ToolCall,
  ToolSchema,
  Usage,
} from "@00/agent-models";

export { createAgentRuntime, DEFAULT_MAX_STEPS, DEFAULT_WORKSPACE } from "./runtime.js";
export type { AgentRuntimeOptionsExt, RuntimeExtensions } from "./runtime.js";

export { ContextManager, IDENTITY_FILE_MAX_CHARS, MEMORY_INDEX_MAX_CHARS } from "./context.js";
export type { ContextManagerOptions } from "./context.js";

export { EventBus, EventRecorder, recordEvents } from "./events.js";
export type { AgentEventListener, RecordedEvent } from "./events.js";

export { ModelRouter } from "./model-router.js";
export type { RoutedModel } from "./model-router.js";

export { PermissionManager, PERMISSIONS_PATH } from "./permissions.js";
export type { PermissionOutcome, PermissionScope, PermissionSource, StoredAnswer } from "./permissions.js";

export {
  SessionManager,
  SESSIONS_DIR,
  SESSION_VERSION,
  assertValidSessionId,
  entriesToMessages,
  parseSessionEntries,
  uuidv7,
} from "./sessions.js";
export type { SessionFileEntry, SessionHeader, SessionMessageEntry, SessionSummary } from "./sessions.js";

export { ToolRegistry } from "./tool-registry.js";

export { LIGHT_TOOL_NAMES, fullTools, lightTools } from "./tools.js";
export type { FullToolsOptions, LightToolsOptions } from "./tools.js";
export {
  SeenFiles,
  editTool,
  findTool,
  grepTool,
  lsTool,
  readPublicTool,
  readTool,
  writeTool,
} from "./tools-fs.js";
export { NoShell, bashTool } from "./tools-shell.js";
export type { Shell, ShellResult, ShellRunOptions } from "./tools-shell.js";
export { gitTools } from "./tools-git.js";
export type { GitOps } from "./tools-git.js";
export { noteDate, rememberTool } from "./tools-memory.js";

export {
  IDENTITY_FILES,
  MEMORY_INDEX_FILE,
  PUBLIC_PERSONA_MAX,
  WORKSPACE_NOTES,
  buildFullRules,
  buildLightRules,
} from "./prompt-text.js";
export type { FullRulesOptions, LightRulesOptions } from "./prompt-text.js";

export { PathEscapeError, globToRegExp, normalizeSandbox, relativeToSandbox, resolveInSandbox } from "./sandbox.js";

export {
  FIND_DEFAULT_LIMIT,
  GREP_DEFAULT_LIMIT,
  GREP_MAX_LINE_CHARS,
  LS_DEFAULT_LIMIT,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_LINES,
  PUBLIC_READ_MAX_CHARS,
  capToolOutput,
  truncateHead,
  truncateLine,
} from "./truncate.js";
export type { Truncation } from "./truncate.js";

export {
  ARGON2ID_ITERATIONS,
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  KEY_BYTES,
  VAULT_IDLE_LOCK_MS,
  VAULT_PATH,
  VaultError,
  createVault,
} from "./vault.js";
export type { Vault, VaultErrorCode, VaultFile, VaultOptions, VaultStore } from "./vault.js";
