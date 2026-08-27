/**
 * What runs the MAIN agent: the embedded Pi harness (default), or an installed CLI (Claude Code /
 * Codex / Gemini CLI) using the CLI's own authenticated user. The public/DM light agent always runs on Pi.
 */
export type AgentEngine = "pi" | CliEngineId;

/** The CLI brains, as one name — every per-engine map and union below is keyed by this. */
export type CliEngineId = "claude-cli" | "codex-cli" | "gemini-cli" | "antigravity-cli";

/**
 * Every CLI brain, in the order they should be OFFERED.
 *
 * Antigravity sits above Gemini deliberately: Google moved individual accounts off the Gemini CLI onto
 * Antigravity in June 2026, so for most people gemini-cli is now the one that cannot run. It stays —
 * an enterprise Code Assist licence or an API key still works — but it is the legacy option, and the UI
 * folds it away rather than offering it as an equal.
 */
export const CLI_ENGINES: CliEngineId[] = ["claude-cli", "codex-cli", "antigravity-cli", "gemini-cli"];

/** Engines the UI hides behind a "show legacy" toggle instead of listing up front. */
export const LEGACY_CLI_ENGINES: CliEngineId[] = ["gemini-cli"];

/** Is this engine one of the CLI brains? The guard every "CLI or pi?" branch should use, so adding an
 *  engine doesn't mean hunting down a dozen two-armed `=== "claude-cli" || === "codex-cli"` tests. */
export function isCliEngine(engine: string | undefined | null): engine is CliEngineId {
  return (
    engine === "claude-cli" || engine === "codex-cli" || engine === "gemini-cli" || engine === "antigravity-cli"
  );
}

/** Human name for an engine, as the operator sees it. */
export function cliEngineLabel(engine: string | undefined | null): string {
  return engine === "claude-cli"
    ? "Claude Code"
    : engine === "codex-cli"
      ? "Codex"
      : engine === "gemini-cli"
        ? "Gemini CLI"
        : engine === "antigravity-cli"
          ? "Antigravity"
          : "Pi";
}

/** Which account a CLI engine is currently authenticated as (one login per CLI, like the CLI itself). */
export interface CliAccountStatus {
  cli: CliEngineId;
  installed: boolean;
  loggedIn: boolean;
  email?: string;
  authMethod?: string;
  subscriptionType?: string;
  /** Raw human-readable status text when we can't parse structured fields (e.g. codex login status). */
  raw?: string;
}

/**
 * A registered CLI login the engine can switch between, so hitting a usage limit on one account can
 * fall through to another of the SAME engine before falling back to the other CLI.
 * - claude-cli: `tokenSecret` names a vault entry holding a `CLAUDE_CODE_OAUTH_TOKEN`
 *   (from `claude setup-token`). Absent ⇒ the CLI's own default keychain login.
 * - codex-cli: `codexHome` is a dedicated `CODEX_HOME` directory (each `codex login`-ed once).
 *   Absent ⇒ the default `~/.codex`.
 * - gemini-cli: `geminiHome` is a dedicated `GEMINI_CLI_HOME` directory (each logged in once, with a
 *   Google account or a Gemini API key). Absent ⇒ the default `~/.gemini`.
 * - antigravity-cli: `agyHome` is a dedicated HOME the `agy` binary reads its login from (it keeps no
 *   env override of its own, so the whole HOME is redirected). Absent ⇒ this machine's own login.
 */
export interface CliAccount {
  id: string;
  engine: CliEngineId;
  label: string;
  tokenSecret?: string;
  codexHome?: string;
  geminiHome?: string;
  /** antigravity-cli: a HOME directory holding this account's `agy` login. */
  agyHome?: string;
  /**
   * Which account this is, as the operator told us at login. `claude auth status` reports NO email
   * for setup-token logins (authMethod "oauth_token"), so there is nothing to read back off the CLI —
   * without this, several saved logins are distinguishable only by the nickname someone typed.
   * Display-only, and never a substitute for the CLI's own reported email when it has one.
   */
  email?: string;
  /** ISO time this account was captured/added (display only). */
  savedAt?: string;
  /** claude-cli: setup-token expiry decoded from the token JWT (if it is one). */
  tokenExpiresAt?: string;
  /**
   * ISO time this account's usage limit resets, parsed from the CLI's limit notice (claude emits
   * `…usage limit reached|<epoch>`). Set when a turn hits the limit; while it's in the future the
   * account is shown as rate-limited. Cleared once a turn on this account succeeds.
   */
  rateLimitedUntil?: string;
  /** ISO time we last saw this account hit a usage limit (shown when no reset time was parseable). */
  lastLimitAt?: string;
  /**
   * Why this account can't run, even though its login is valid — set when the vendor REFUSES it for a
   * reason no retry will fix. Google, for one, now rejects the free "Gemini Code Assist for individuals"
   * tier from the CLI (IneligibleTierError / UNSUPPORTED_CLIENT): the Google login succeeds and every
   * turn then fails. Cleared the moment a turn on this account succeeds.
   */
  unusableReason?: string;
}

/** Freshness of an account's underlying token, so the UI can warn before it lapses. */
export interface CliTokenInfo {
  /** ISO expiry of the access/setup token, when known. */
  expiresAt?: string;
  /** ms until expiry (negative if already expired). */
  expiresInMs?: number;
  expired: boolean;
  /** codex: ISO of the last token refresh — evidence it's being kept alive. */
  lastRefresh?: string;
  /** "ChatGPT" / "API key" (codex) — how the login authenticates. */
  authMethod?: string;
  /** true when the engine keeps this fresh automatically (codex, on use); false = manual re-auth (claude). */
  autoRefresh: boolean;
}

/** The registered CLI accounts plus which one is active per engine. */
export interface CliAccountsState {
  accounts: CliAccount[];
  /** Active account id per engine (unset ⇒ the CLI's ambient/default login). */
  active: Partial<Record<CliEngineId, string>>;
}

/** A registered account paired with a live logged-in probe (+ whether it's the active one). */
export interface CliAccountView extends CliAccount {
  activeForEngine: boolean;
  status: CliAccountStatus;
  /** Token freshness (codex reads its auth.json; claude decodes the setup-token). */
  token?: CliTokenInfo;
}
