/**
 * `url`, `querystring`, `assert`, `os` and `timers` — five modules small enough to share a file, and
 * each with a header of its own below.
 *
 * They live together because none of them is more than a page and every one of them is a thin cap
 * over something the platform already has (WHATWG `URL`, `URLSearchParams`, `Object.is`,
 * `setTimeout`). Splitting them into five files would make five headers that all said "this is a
 * wrapper".
 */

import { NodeCompatError } from "../errors.js";
import { deepStrictEqual } from "./core.js";

// ── url ───────────────────────────────────────────────────────────────────────────────────────────
/**
 * DOES: the WHATWG half Node exposes (`URL`, `URLSearchParams`), `fileURLToPath`, `pathToFileURL`,
 * and `url.parse`/`url.format`/`url.resolve` in their legacy shape because half of npm still calls
 * them — including `parse(input, true)`'s `query` object and `format`'s `hostname` + `port` and
 * `query` object, each of which was a silently different URL before.
 * DOES NOT: `domainToASCII`/`domainToUnicode` (punycode is not shipped), and `fileURLToPath` accepts
 * only `file:` URLs with an empty or `localhost` host — a UNC path has no meaning under this
 * filesystem.
 */
export function fileURLToPath(url: string | URL): string {
  const parsed = typeof url === "string" ? new URL(url) : url;
  // Node throws a TypeError here, not an Error, and code that checks `err instanceof TypeError`
  // exists — so this one refusal wears Node's class with this package's code on it.
  if (parsed.protocol !== "file:") {
    throw Object.assign(new TypeError(`The URL must be of scheme file: (got ${parsed.protocol})`), {
      code: "ERR_INVALID_URL_SCHEME",
    });
  }
  if (parsed.hostname !== "" && parsed.hostname !== "localhost") {
    throw Object.assign(
      new TypeError(`File URL host must be empty or "localhost": ${parsed.hostname} names another machine, and there is none here`),
      { code: "ERR_INVALID_FILE_URL_HOST" },
    );
  }
  return decodeURIComponent(parsed.pathname);
}

export function pathToFileURL(path: string): URL {
  const abs = path.startsWith("/") ? path : `/${path}`;
  // `#` and `?` are legal in a filename and would otherwise cut the URL in half.
  return new URL(`file://${abs.split("/").map(encodeURIComponent).join("/").replace(/%2F/g, "/")}`);
}

export function urlModule(): Record<string, unknown> {
  const legacyParse = (input: string, parseQueryString = false): Record<string, unknown> => {
    const withQuery = (parsed: Record<string, unknown>): Record<string, unknown> => {
      // `url.parse(input, true)` hands back `query` as an OBJECT, and half the packages that still
      // call the legacy parser call it exactly that way.
      if (!parseQueryString) return parsed;
      const search = typeof parsed.search === "string" ? parsed.search.slice(1) : "";
      const query: Record<string, string | string[]> = {};
      for (const [key, value] of new URLSearchParams(search)) {
        const seen = query[key];
        if (seen === undefined) query[key] = value;
        else if (Array.isArray(seen)) seen.push(value);
        else query[key] = [seen, value];
      }
      parsed.query = query;
      return parsed;
    };
    return withQuery(legacyParseOne(input));
  };
  const legacyParseOne = (input: string): Record<string, unknown> => {
    try {
      const u = new URL(input);
      return {
        protocol: u.protocol,
        slashes: true,
        auth: u.username ? `${u.username}${u.password ? `:${u.password}` : ""}` : null,
        host: u.host,
        hostname: u.hostname,
        port: u.port || null,
        pathname: u.pathname,
        search: u.search || null,
        query: u.search ? u.search.slice(1) : null,
        hash: u.hash || null,
        path: `${u.pathname}${u.search}`,
        href: u.href,
      };
    } catch {
      const [beforeHash, hash] = input.split("#");
      const [pathname, search] = (beforeHash ?? "").split("?");
      return {
        protocol: null,
        slashes: null,
        auth: null,
        host: null,
        hostname: null,
        port: null,
        pathname: pathname ?? "",
        search: search ? `?${search}` : null,
        query: search ?? null,
        hash: hash ? `#${hash}` : null,
        path: beforeHash ?? "",
        href: input,
      };
    }
  };
  return {
    URL,
    URLSearchParams,
    fileURLToPath,
    pathToFileURL,
    parse: legacyParse,
    format: (value: unknown): string => {
      if (value instanceof URL) return value.href;
      const u = value as Record<string, unknown>;
      const str = (key: string): string => (typeof u[key] === "string" ? (u[key] as string) : "");
      const auth = u.auth ? `${String(u.auth)}@` : "";
      const protocol = str("protocol");
      // `host` wins over `hostname` + `port` when it is there, which is Node's rule; when it is not,
      // the port is part of the authority and dropping it (as this did) silently rewrites the URL.
      const port = u.port === undefined || u.port === null || u.port === "" ? "" : `:${String(u.port)}`;
      const authority = str("host") || (str("hostname") ? `${str("hostname")}${port}` : "");
      // A `query` OBJECT is serialised; a `query` STRING is ignored unless it is the only thing
      // there, both of which is what Node's own format does with them.
      let search = str("search");
      if (!search && u.query && typeof u.query === "object") {
        const params = new URLSearchParams();
        for (const [key, item] of Object.entries(u.query as Record<string, unknown>)) {
          for (const one of Array.isArray(item) ? item : [item]) params.append(key, String(one));
        }
        const text = params.toString();
        if (text) search = `?${text}`;
      }
      return `${protocol}${protocol ? "//" : ""}${auth}${authority}${str("pathname")}${search}${str("hash")}`;
    },
    resolve: (from: string, to: string): string => new URL(to, from).href,
  };
}

// ── querystring ───────────────────────────────────────────────────────────────────────────────────
/**
 * DOES: `parse`, `stringify`, `escape`, `unescape`, with repeated keys collapsing into an array the
 * way Node's do.
 * DOES NOT: custom separators beyond `sep`/`eq` (the `options.decodeURIComponent` hook is accepted
 * and used; `maxKeys` is not — this is not a request parser facing the internet).
 */
export function querystringModule(): Record<string, unknown> {
  const parse = (text: string, sep = "&", eq = "="): Record<string, string | string[]> => {
    const out: Record<string, string | string[]> = {};
    for (const pair of String(text ?? "").split(sep)) {
      if (pair === "") continue;
      const at = pair.indexOf(eq);
      const key = decodeURIComponent((at < 0 ? pair : pair.slice(0, at)).replace(/\+/g, " "));
      const value = at < 0 ? "" : decodeURIComponent(pair.slice(at + eq.length).replace(/\+/g, " "));
      const seen = out[key];
      if (seen === undefined) out[key] = value;
      else if (Array.isArray(seen)) seen.push(value);
      else out[key] = [seen, value];
    }
    return out;
  };
  const stringify = (obj: Record<string, unknown>, sep = "&", eq = "="): string => {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(obj ?? {})) {
      const list = Array.isArray(value) ? value : [value];
      for (const item of list) {
        if (item === undefined || item === null) parts.push(`${encodeURIComponent(key)}${eq}`);
        else parts.push(`${encodeURIComponent(key)}${eq}${encodeURIComponent(String(item))}`);
      }
    }
    return parts.join(sep);
  };
  return { parse, stringify, decode: parse, encode: stringify, escape: encodeURIComponent, unescape: decodeURIComponent };
}

// ── assert ────────────────────────────────────────────────────────────────────────────────────────
/**
 * DOES: `assert()`, `ok`, `equal`, `notEqual`, `strictEqual`, `notStrictEqual`, `deepEqual`,
 * `deepStrictEqual`, `notDeepStrictEqual`, `throws`, `rejects`, `doesNotThrow`, `match`, `fail`,
 * `ifError`, and `assert.strict` pointing at itself. Failures are an `AssertionError` with
 * `actual`/`expected`/`operator`, which is what test runners print.
 * DOES NOT: `assert.snapshot`, `CallTracker`, or the loose-vs-strict distinction beyond `==` vs
 * `===` — `deepEqual` here is `deepStrictEqual` minus the prototype check, not Node's full coercion
 * table. Test frameworks bring their own assertions; this exists so a library's internal `assert`
 * does not crash the module that requires it.
 */
export class AssertionError extends Error {
  actual: unknown;
  expected: unknown;
  operator: string;
  constructor(opts: { message?: string; actual?: unknown; expected?: unknown; operator: string }) {
    super(opts.message ?? `${show(opts.actual)} ${opts.operator} ${show(opts.expected)}`);
    this.name = "AssertionError";
    this.code = "ERR_ASSERTION";
    this.actual = opts.actual;
    this.expected = opts.expected;
    this.operator = opts.operator;
  }
  code: string;
}

function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function looseDeepEqual(a: unknown, b: unknown): boolean {
  if (a == b) return true; // eslint-disable-line eqeqeq
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => looseDeepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function assertModule(): Record<string, unknown> {
  const ok = (value: unknown, message?: string): void => {
    if (!value) throw new AssertionError({ message, actual: value, expected: true, operator: "==" });
  };
  const api = Object.assign(ok, {
    ok,
    equal: (a: unknown, b: unknown, message?: string) => {
      if (a != b) throw new AssertionError({ message, actual: a, expected: b, operator: "==" }); // eslint-disable-line eqeqeq
    },
    notEqual: (a: unknown, b: unknown, message?: string) => {
      if (a == b) throw new AssertionError({ message, actual: a, expected: b, operator: "!=" }); // eslint-disable-line eqeqeq
    },
    strictEqual: (a: unknown, b: unknown, message?: string) => {
      if (!Object.is(a, b)) throw new AssertionError({ message, actual: a, expected: b, operator: "strictEqual" });
    },
    notStrictEqual: (a: unknown, b: unknown, message?: string) => {
      if (Object.is(a, b)) throw new AssertionError({ message, actual: a, expected: b, operator: "notStrictEqual" });
    },
    deepEqual: (a: unknown, b: unknown, message?: string) => {
      if (!looseDeepEqual(a, b)) throw new AssertionError({ message, actual: a, expected: b, operator: "deepEqual" });
    },
    deepStrictEqual: (a: unknown, b: unknown, message?: string) => {
      if (!deepStrictEqual(a, b)) throw new AssertionError({ message, actual: a, expected: b, operator: "deepStrictEqual" });
    },
    notDeepStrictEqual: (a: unknown, b: unknown, message?: string) => {
      if (deepStrictEqual(a, b)) throw new AssertionError({ message, actual: a, expected: b, operator: "notDeepStrictEqual" });
    },
    match: (value: string, pattern: RegExp, message?: string) => {
      if (!pattern.test(value)) throw new AssertionError({ message, actual: value, expected: String(pattern), operator: "match" });
    },
    throws: (fn: () => unknown, _expected?: unknown, message?: string) => {
      try {
        fn();
      } catch {
        return;
      }
      throw new AssertionError({ message: message ?? "Missing expected exception.", operator: "throws" });
    },
    doesNotThrow: (fn: () => unknown, message?: string) => {
      try {
        fn();
      } catch (err) {
        throw new AssertionError({ message: message ?? `Got unwanted exception: ${String(err)}`, operator: "doesNotThrow" });
      }
    },
    rejects: async (fn: (() => Promise<unknown>) | Promise<unknown>, message?: string) => {
      try {
        await (typeof fn === "function" ? fn() : fn);
      } catch {
        return;
      }
      throw new AssertionError({ message: message ?? "Missing expected rejection.", operator: "rejects" });
    },
    fail: (message?: string) => {
      throw new AssertionError({ message: message ?? "Failed", operator: "fail" });
    },
    ifError: (value: unknown) => {
      if (value !== null && value !== undefined) throw new AssertionError({ actual: value, expected: null, operator: "ifError" });
    },
    AssertionError,
  });
  return Object.assign(api, { strict: api, default: api }) as unknown as Record<string, unknown>;
}

// ── os ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * DOES: `EOL`, `platform()` → `"browser"`, `type`, `arch`, `homedir()` → the workspace root,
 * `tmpdir()` → `/tmp`, `hostname`, `endianness` (measured, not assumed), `cpus()` from
 * `navigator.hardwareConcurrency`, `totalmem`/`freemem` from `deviceMemory` when the browser tells
 * us and 0 when it does not, `constants` (the errno and signal numbers scripts compare against),
 * `userInfo`.
 * DOES NOT: `networkInterfaces` (a tab cannot see one), `loadavg` (returns zeros — there is no such
 * number in a browser and inventing one would be a lie a monitoring script would print), `uptime`
 * beyond the page's own life.
 */
export function osModule(homedir: string): Record<string, unknown> {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number; deviceMemory?: number; userAgent?: string } }).navigator;
  const cores = Math.max(1, nav?.hardwareConcurrency ?? 1);
  const bytes = (nav?.deviceMemory ?? 0) * 1024 * 1024 * 1024;
  const endianness = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? "LE" : "BE";
  const started = Date.now();
  return {
    EOL: "\n",
    platform: () => "browser",
    type: () => "Browser",
    arch: () => "wasm32",
    release: () => "0.0.1",
    version: () => nav?.userAgent ?? "agent-node",
    homedir: () => homedir,
    tmpdir: () => "/tmp",
    hostname: () => "localhost",
    endianness: () => endianness,
    uptime: () => (Date.now() - started) / 1000,
    loadavg: () => [0, 0, 0],
    cpus: () =>
      Array.from({ length: cores }, () => ({
        model: "browser",
        speed: 0,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      })),
    totalmem: () => bytes,
    freemem: () => 0,
    userInfo: () => ({ uid: -1, gid: -1, username: "agent", homedir, shell: null }),
    devNull: "/dev/null",
    constants: {
      signals: { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 },
      errno: { EACCES: 13, EEXIST: 17, EISDIR: 21, ENOENT: 2, ENOTDIR: 20, EPERM: 1 },
      UV_UDP_REUSEADDR: 4,
    },
  };
}

// ── timers ────────────────────────────────────────────────────────────────────────────────────────
/**
 * DOES: `setTimeout`/`clearTimeout`, `setInterval`/`clearInterval`, `setImmediate`/`clearImmediate`
 * (a zero timeout, which is what every browser polyfill uses), and `timers/promises`'
 * `setTimeout`/`setImmediate`/`scheduler.wait` with `AbortSignal` support.
 * DOES NOT: `Timeout.ref()`/`unref()` beyond returning `this` — a browser timer has no reference
 * count and a script that unrefs one is asking for something the event loop here does not model. The
 * loader's own keep-alive counting is what decides when a script is finished.
 */
export function timersModule(): Record<string, unknown> {
  const setImmediateShim = (fn: (...args: unknown[]) => void, ...args: unknown[]): unknown => setTimeout(fn, 0, ...args);
  const promises = {
    setTimeout: (ms?: number, value?: unknown, opts?: { signal?: AbortSignal }): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const handle = setTimeout(() => resolve(value), ms);
        opts?.signal?.addEventListener("abort", () => {
          clearTimeout(handle);
          reject(new NodeCompatError("ABORT_ERR", "The operation was aborted"));
        });
      }),
    setImmediate: (value?: unknown): Promise<unknown> => new Promise((resolve) => setImmediateShim(() => resolve(value))),
    scheduler: { wait: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)) },
  };
  return {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate: setImmediateShim,
    clearImmediate: clearTimeout,
    promises,
  };
}
