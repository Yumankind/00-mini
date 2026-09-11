# The compatibility corpus

767 cases ported from [macaly/almostnode](https://github.com/macaly/almostnode) (MIT, `6ab61f31`),
which adapted them in turn from Node's own `test/parallel`. They run against THIS package's modules;
`test/compat/LICENSE-almostnode` is their licence.

**663 passing, 104 skipped** (98 marked here, 6 already skipped upstream). Every skip is an
`it.skip` with a `// SKIP:` line above it naming the gap — `grep -c "// SKIP:" *.test.ts` is this
table. A skip that disappears is a shim that got better.

| Module | Ported | Passing | Skipped | The gap, in one line |
|---|---:|---:|---:|---|
| `path` | 223 | 219 | 4 | three cases where **almostnode differs from Node and we match Node** (`dirname('//a')` is `'//'`, `basename('/a/b.html','b.html')` is `'b.html'`, `format(parse(x))` drops a trailing slash) |
| `buffer` | 95 | 89 | 6 | the `buffer` package (6.0.3) has no **base64url** — Node added it in 15; plus `isBuffer(new Uint8Array())`, which is `false` in Node too |
| `fs` | 76 | 61 | 15 | no **file descriptors** (`open`/`read`/`write`/`close`, 6) and no `mkdtemp`; no exported `Dirent` class (3); 4 upstream-skipped callback cases. Every `xSync` case runs against `fs.promises.x` — see the file header |
| `url` | 67 | 63 | 4 | four **almostnode-vs-Node** disagreements in the legacy `url.format`/`parse` (`auth`, `href`, a string `query`, `host` beating `hostname`); we match Node on all four |
| `util` | 77 | 69 | 8 | `util.inspect` is the `util` package's, so a bigint prints `42n` and a symbol prints `Symbol(x)` (Node's spelling, not almostnode's); `deprecate` goes to a process warning, not `console.warn`; `util.types` has no legacy `isArray` family |
| `process` | 60 | 54 | 6 | a tab has **no environment and no resident set**: `env` is exactly what the host passed, `platform` is `"browser"`, `memoryUsage()` is zeros; `exit()` emits `exit` and throws an `ExitSignal` instead of calling an `onExit` option |
| `events` | 50 | 49 | 1 | a throwing listener propagates out of `emit` here, as it does in Node; almostnode swallows it |
| `crypto` | 66 | 49 | 17 | no **signing and no key objects** (`createSign`/`createVerify`/`createSecretKey`/`KeyObject`, 9) — WebCrypto's `subtle` is the road; sha384/sha512 have no synchronous digest, HMAC or PBKDF2 (they need 64-bit words) |
| `stream` | 53 | 10 | 43 | almostnode's `Readable`/`Writable` **run without a `_read`/`_write`**; readable-stream — which is Node's own stream code — throws `ERR_METHOD_NOT_IMPLEMENTED`, and so does Node itself. 43 cases construct a bare stream and would fail on Node too |
| **total** | **767** | **663** | **104** | |

## Read the stream row before drawing a conclusion from it

10/53 looks like the worst module here and is the opposite. Every one of the 43 skips is a case that
does `new Writable()` and then `.write("x")`, which throws `ERR_METHOD_NOT_IMPLEMENTED` in Node 24 —
verified, not assumed. `src/modules/core.ts` hands scripts **readable-stream v4**, which IS Node's
stream implementation published to npm, so the strictness is Node's. The corpus measures almostnode's
own shim there, and porting it honestly means skipping those cases rather than loosening ours.

The same pattern, smaller, is in `path` (3), `url` (4), `util` (3) and `events` (1): 11 more cases
where the expectation is almostnode's behaviour and ours is Node's. They are marked as such.

## What the port fixed on the way

Ten shim gaps this corpus found, fixed in `src/`:

1. **sha256 in JS** (`crypto.ts`) — `createHash("sha256").digest("hex")` is synchronous now, the way
   npm writes it. sha384/sha512 need 64-bit words and stay on WebCrypto.
2. **HMAC in JS** (`crypto.ts`) — RFC 2104 over md5/sha1/sha256, so `hmac.digest()` is synchronous
   for the three digests that have a synchronous hash. That is the sha256 half of every JWT library.
3. **PBKDF2 in JS** (`crypto.ts`) — `pbkdf2` and `pbkdf2Sync` over that HMAC, matching Node's output;
   they used to refuse by name, which stopped a package at import time.
4. **`createHmac("md5")`** — allowed now: HMAC is two hashes, and md5 is one of the JS ones.
5. **`crypto.getCiphers()`** — returns `[]` rather than being absent. There is no cipher here; that
   is the honest answer to the question, and `undefined` is not an answer at all.
6. **`events.on()` and `getEventListeners()`** (`core.ts`) — the `events` package (3.3.0) predates the
   async iterator, so `for await (const [x] of events.on(emitter, "tick"))` was a TypeError.
7. **The `stream` module is the `Stream` function** (`core.ts`) — Node's `require("stream")` is
   callable with `.prototype.pipe`, and packages subclass it; ours was a plain object.
8. **`util.format` `%i`/`%f` and `util.inspect` of bigint/symbol/Map/Set** (`core.ts`) — the package's
   `format` left `%i` in the output as text and its `inspect` rendered all four as `{}`.
9. **`url.parse(x, true)` and `url.format`** (`small.ts`) — the query object was missing entirely, and
   `format` silently dropped the `port` when given `hostname` + `port`, which rewrites the URL.
   `fileURLToPath` now throws Node's `TypeError` rather than a plain Error.
10. **`fs.rmdir` refuses a non-empty directory** (`fs/backend.ts`) with `ENOTEMPTY`, and every fs path
    accepts a `file:` URL (a `URL` object or a `file://…` string), which is how ESM reads a file
    beside itself.

## Re-running and re-scoring

```sh
pnpm --filter @00/agent-node test -- test/compat      # the corpus alone
grep -c "// SKIP:" test/compat/*.test.ts              # the skips, per module
```

When a shim improves, delete the `// SKIP:` line and the `.skip`, run it, and update the table above.
