/**
 * The `Transformer` seam — the one place this package admits it cannot parse TypeScript.
 *
 * WHY A SEAM AND NOT A DEPENDENCY. `src/loader/esm.ts` is a scanner, and a scanner can rewrite
 * `import x from "y"` because that shape is regular. It cannot strip types: `a < b > (c)` is a
 * generic call in TypeScript and two comparisons in JavaScript, and no amount of masking decides
 * between them. That needs a parser, and the only parser small enough to want is one the HOST
 * already has — esbuild-wasm, 12.2 MB of it. So the loader takes one from the outside, a host that
 * never runs TypeScript never pays for it, and a `.ts` file without one refuses BY NAME
 * (`ERR_TRANSFORM_UNAVAILABLE`) rather than being handed to `new Function` to die on a type
 * annotation.
 *
 * WHY THE INTERFACE IS ASYNCHRONOUS AND `require` IS NOT. Because esbuild-wasm's browser build has
 * no synchronous transform — `transformSync` throws "only works in node" there, and it must, since
 * the wasm lives in another Worker. So a transform can only happen BEFORE the synchronous
 * `require` that needs it, and the loader's answer is `warmup()`: an async pass that walks the
 * require graph from an entry, transforms every `.ts`/`.tsx`/`.jsx` it finds, and fills this cache.
 * `runMainAsync` is `warmup` + `runMain`. A `require` that reaches an untransformed file after that
 * (a path built at runtime, a `require.cache` delete) throws `ERR_TRANSFORM_PENDING` naming the
 * file, because the alternative is a runtime that sometimes returns a promise from `require`.
 *
 * A `Transformer` MAY also offer `transformSync` — esbuild-wasm's NODE build has one, which is what
 * the test suite uses — and then `require` transforms on demand and `warmup` is unnecessary.
 *
 * WHICH FILES. Extension-based, on purpose: `.ts` `.mts` `.cts` → the `ts` loader, `.tsx` → `tsx`,
 * `.jsx` → `jsx`. A `.js` file containing JSX is NOT transformed. Node does not run one either, the
 * heuristics for "is this JSX or is it a comparison" are exactly the ones a scanner gets wrong, and
 * a package that ships JSX in a `.js` file is a package that expects a bundler. Rename it `.jsx`.
 */

import { NodeCompatError } from "../errors.js";
import { sha256, bytesToHex } from "../modules/crypto.js";

/** esbuild's loader names, restricted to the three this package sends. */
export type TransformLoaderName = "ts" | "tsx" | "jsx";

export interface TransformRequest {
  /** The absolute virtual path of the file, for error messages and source maps. */
  path: string;
  loader: TransformLoaderName;
  /** Always `"cjs"`: the loader's module wrapper IS a CommonJS wrapper. See the note below. */
  format: "cjs";
  /**
   * Which JSX runtime. The LOADER decides this (it is the side holding a filesystem): `automatic`
   * when the nearest `package.json` depends on react, `transform` — the classic
   * `React.createElement` runtime — otherwise. Optional so a host can implement `Transformer`
   * without caring.
   */
  jsx?: "automatic" | "transform";
  /** With `jsx: "automatic"`, the package the runtime is imported from. Defaults to `react`. */
  jsxImportSource?: string;
}

export interface TransformOutput {
  code: string;
  /** A source map, when the transformer was asked for one. Inline maps arrive inside `code`. */
  map?: string;
}

/**
 * WHY `format: "cjs"` AND NOT "LET OUR OWN REWRITER RUN". Because for a file that goes through a
 * real parser, esbuild's CommonJS output is strictly better than `src/loader/esm.ts`'s: imported
 * bindings are live (getters through `__toESM`), imports hoist, `export *` is a live re-export, and
 * the regex/division heuristic cannot be wrong because there is no heuristic. Asking esbuild for
 * `esm` and then running our scanner over it would take a correct module and put it back through
 * the eight limits in `esm.ts`'s header for no gain. The two limits that survive are the ones that
 * are ours structurally, not the scanner's: top-level await (a CommonJS body is a synchronous
 * function — esbuild refuses it for `cjs` too, and we re-throw that as `ERR_TOP_LEVEL_AWAIT`) and
 * `import.meta`, which the esbuild transformer supplies by `define` because it knows the path.
 */
export interface Transformer {
  transform(source: string, opts: TransformRequest): Promise<TransformOutput>;
  /** The synchronous twin, where the implementation has one. esbuild-wasm has it in Node only. */
  transformSync?(source: string, opts: TransformRequest): TransformOutput;
}

/** Extension → esbuild loader. The whole "which files" policy, in one table. */
export const TRANSFORM_EXTENSIONS: Record<string, TransformLoaderName> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".jsx": "jsx",
};

/** The extensions the resolver tries AFTER `.js`/`.cjs`/`.mjs`/`.json`, in this order. */
export const TRANSFORM_EXTENSION_ORDER = [".ts", ".tsx", ".mts", ".cts", ".jsx"] as const;

/** Which loader `path` needs, or `null` when it is plain JavaScript (or JSON). */
export function transformLoaderFor(path: string): TransformLoaderName | null {
  const at = path.lastIndexOf(".");
  if (at < 0) return null;
  return TRANSFORM_EXTENSIONS[path.slice(at)] ?? null;
}

/** Is this a `.d.ts`? Type-only, no runtime, and a package's `types` field points at one. */
export function isDeclarationFile(path: string): boolean {
  return path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts");
}

export function failTransformUnavailable(path: string): never {
  throw new NodeCompatError(
    "ERR_TRANSFORM_UNAVAILABLE",
    `${path}: the host did not provide a TypeScript transform — this runtime's loader is a scanner, ` +
      `not a parser, and stripping types needs one. Pass \`transformer: createEsbuildTransformer({ wasmURL })\` ` +
      `to createLoader (@00/agent-node's src/transform/esbuild.ts), or ship this file as JavaScript.`,
  );
}

export function failTransformPending(path: string): never {
  throw new NodeCompatError(
    "ERR_TRANSFORM_PENDING",
    `${path}: this file needs an asynchronous transform and has not had one yet — \`require\` is ` +
      `synchronous and cannot await. Call \`await loader.warmup(entry)\` (or \`loader.runMainAsync(entry)\`, ` +
      `which does it for you) before requiring it, or give the loader a transformer with a transformSync.`,
  );
}

const encoder = new TextEncoder();

/**
 * Transformed output, keyed by path AND the sha256 of the source that produced it. The hash is what
 * makes the cache correct across a save: the same path with new bytes is a different key, so a file
 * edited between two runs is never served stale. sha256 comes from `src/modules/crypto.ts`, written
 * out in JS there precisely because this lookup happens inside a synchronous `require`.
 */
export class TransformCache {
  private readonly entries = new Map<string, TransformOutput>();

  static key(path: string, source: string): string {
    return `${path}\0${bytesToHex(sha256(encoder.encode(source)))}`;
  }

  get(path: string, source: string): TransformOutput | undefined {
    return this.entries.get(TransformCache.key(path, source));
  }

  set(path: string, source: string, output: TransformOutput): TransformOutput {
    this.entries.set(TransformCache.key(path, source), output);
    return output;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
