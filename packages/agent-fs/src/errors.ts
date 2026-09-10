// Named failures, because every one of these crosses a boundary where "something went wrong" is not
// an answer: the runtime shows the person a sentence, and a caller (the transfer flow, the engine's
// import door) branches on the code. One place, so a code is never spelled two ways.

export class AgentFsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentFsError";
  }
}

export function fail(code: string, message: string): never {
  throw new AgentFsError(code, message);
}

/** A tar entry naming an absolute path or climbing out of the payload. Refused before any write. */
export function failUnsafePath(path: string): never {
  fail("unsafe_bundle_path", `refused a bundle entry that escapes the payload: ${JSON.stringify(path)}`);
}

/** A secret has to be a non-empty string: an empty one derives a valid key and silently protects
 *  nothing, which is worse than a refusal. */
export function assertSecret(secret: string): string {
  if (typeof secret !== "string" || secret.length === 0) fail("bundle_secret_required", "a bundle secret is required");
  return secret;
}
