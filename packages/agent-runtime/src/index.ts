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
  ModelClass,
  ModelInfo,
  ModelProvider,
  Readiness,
  ReadinessProgress,
  Role,
  ToolCall,
  ToolSchema,
  Usage,
} from "@00/agent-models";

export { createAgentRuntime, DEFAULT_MAX_STEPS, DEFAULT_WORKSPACE, OWN_TOOLS_FOOTER, providerOffersTools } from "./runtime.js";
export type { AgentRuntimeOptionsExt, RuntimeExtensions } from "./runtime.js";

export { ContextManager, IDENTITY_FILE_MAX_CHARS, MEMORY_INDEX_MAX_CHARS } from "./context.js";
export type { ContextManagerOptions } from "./context.js";

export { EventBus, EventRecorder, recordEvents } from "./events.js";
export type { AgentEventListener, RecordedEvent } from "./events.js";

export { ModelRouter } from "./model-router.js";
export type { RoutedModel } from "./model-router.js";

export { READ_ONLY_TOOL_NAMES, SHORT_PROMPT_CHARS, classifyCall, isReadOnlyTool } from "./brain-class.js";
export type { BrainCallContext } from "./brain-class.js";

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
  IMAGE_MAX_BYTES,
  IMAGE_MIME,
  SeenFiles,
  copyTool,
  deleteTool,
  editTool,
  findTool,
  grepTool,
  lsTool,
  moveTool,
  readPublicTool,
  readTool,
  statTool,
  writeTool,
} from "./tools-fs.js";
export { NoShell, bashTool } from "./tools-shell.js";
export type { Shell, ShellResult, ShellRunOptions } from "./tools-shell.js";
export { gitTools } from "./tools-git.js";
export type { GitOps } from "./tools-git.js";
export { noteDate, rememberTool } from "./tools-memory.js";

// The gap-audit round of 2026-09-10 (B9–B17): the vault reaching tools, retrieval with no model,
// the first network policy, the first-run interview, and the honest tool set.
export { HTTP_GET_MAX_BYTES, hostAllowed, httpGetTool } from "./tools-net.js";
export type { HttpGetOptions } from "./tools-net.js";
export { listSecretsTool } from "./tools-secrets.js";
export { placeholderFor, redact, resolveSecretArgs, secretNamesIn } from "./secrets.js";
export type { ResolvedArgs } from "./secrets.js";
export { BOOTSTRAP_FILE, PROFILE_PATH, finishOnboardingTool, onboardingState } from "./tools-onboarding.js";
export type { OnboardingState, OnboardingToolOptions } from "./tools-onboarding.js";
export { searchWorkspaceTool } from "./tools-search.js";
export { Bm25Index, tokens } from "./retrieval/bm25.js";
export type { Bm25Document, Bm25Result } from "./retrieval/bm25.js";
export {
  INDEX_MAX_FILES,
  INDEX_MAX_FILE_BYTES,
  createWorkspaceIndex,
} from "./retrieval/workspace-index.js";
export type {
  WorkspaceChunk,
  WorkspaceHit,
  WorkspaceIndex,
  WorkspaceIndexOptions,
  WorkspaceIndexStats,
} from "./retrieval/workspace-index.js";

export {
  IDENTITY_FILES,
  MEMORY_INDEX_FILE,
  PUBLIC_PERSONA_MAX,
  WORKSPACE_NOTES,
  buildFullRules,
  buildLightRules,
  buildOnboardingRule,
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
