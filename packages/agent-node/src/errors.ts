/**
 * Named failures for the Node layer — one code, one sentence, one place.
 *
 * WHY. Everything in this package is a thing that "works in Node" and might not work here, and the
 * difference between a runtime people trust and one they don't is whether the refusal names itself.
 * `Cannot find module 'express'` is a Node sentence a person already knows how to act on;
 * `undefined is not a function` two frames deeper is not. So every edge of this package throws a
 * `NodeCompatError` with a `code` a caller can branch on and a message that says what is missing and
 * where the real thing lives.
 *
 * The codes deliberately borrow Node's spelling where Node has one (`ERR_MODULE_NOT_FOUND`,
 * `ENOENT`) so a script's own `err.code === "ENOENT"` check keeps working, and invent one only where
 * Node has no equivalent because Node has no such limit (`ERR_SYNC_FS_UNAVAILABLE`,
 * `ERR_NO_SOCKETS`).
 */

export class NodeCompatError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NodeCompatError";
  }
}

export function fail(code: string, message: string): never {
  throw new NodeCompatError(code, message);
}

/** The one sentence about cross-origin isolation, written once and quoted by every sync entry point. */
export const ISOLATION_SENTENCE =
  "a synchronous filesystem needs a shared-memory channel to the fs service, which a page only gets " +
  "under cross-origin isolation (COOP+COEP, so SharedArrayBuffer and Atomics.wait exist) — use the " +
  "async form (fs.promises.*) or serve this app with the isolation headers";

export function failSyncFs(what: string): never {
  fail("ERR_SYNC_FS_UNAVAILABLE", `${what}: ${ISOLATION_SENTENCE}`);
}

/** Sockets: there is no TCP in a tab, and no polyfill can invent one. */
export const NO_SOCKETS_SENTENCE =
  "a browser tab has no TCP sockets and no polyfill can invent one — outbound traffic goes through " +
  "fetch() (subject to the other origin's CORS), and an inbound port is a virtual port the host " +
  "routes for you";

export function failNoSockets(what: string): never {
  fail("ERR_NO_SOCKETS", `${what}: ${NO_SOCKETS_SENTENCE}`);
}

/** `require("x")` when nothing resolved — Node's own code, so a script's try/catch still works. */
export function failModuleNotFound(request: string, from: string): never {
  const err = new NodeCompatError(
    "MODULE_NOT_FOUND",
    `Cannot find module '${request}' from '${from}'`,
  );
  throw err;
}

export function enoent(op: string, path: string): NodeCompatError {
  return new NodeCompatError("ENOENT", `ENOENT: no such file or directory, ${op} '${path}'`);
}

export function enotdir(op: string, path: string): NodeCompatError {
  return new NodeCompatError("ENOTDIR", `ENOTDIR: not a directory, ${op} '${path}'`);
}

export function eisdir(op: string, path: string): NodeCompatError {
  return new NodeCompatError("EISDIR", `EISDIR: illegal operation on a directory, ${op} '${path}'`);
}
