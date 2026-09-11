/**
 * THE TWO NODE GLOBALS THE BROWSER LACKS, installed before any other module evaluates.
 *
 * WHY A MODULE OF ITS OWN AND NOT THE FIRST LINES OF main.ts: ES modules evaluate their imports
 * BEFORE their own body, depth-first in source order. A shim written in main.ts's body therefore runs
 * after App.vue's whole graph has evaluated — and two libraries in that graph read a global at load
 * time: isomorphic-git's browser build reads `Buffer` (122 references), and the `util` polyfill that
 * `readable-stream` pulls in (a dependency of `@00/agent-node`'s Node surface) reads
 * `process.env.NODE_DEBUG` at the top of its module. In the production bundle rollup happens to hoist
 * things so that neither is touched first; in `vite dev` the prebundled `util` is evaluated as a
 * separate module and threw `process is not defined` before the app painted (seen 2026-09-11).
 * Importing THIS module first in main.ts makes it the first thing to evaluate, whatever the bundler.
 *
 * The `process` here is the smallest object those polyfills read — an empty env, a browser flag, a
 * microtask `nextTick`. It is not a Node process and `@00/agent-node` builds its own, real one per
 * script; this global exists only so a library's load-time `if (process.env.X)` has something to ask.
 * Both are guarded: a host that already has them (a test under node) keeps its own.
 */
import { Buffer } from "buffer";

// `unknown`, deliberately: `@types/node` types `globalThis.process` as the real thing, and the point
// of this object is that it is not one.
const g = globalThis as unknown as { Buffer?: unknown; process?: unknown };

if (!g.Buffer) g.Buffer = Buffer;
if (!g.process) {
  g.process = {
    env: {},
    browser: true,
    platform: "browser",
    version: "",
    versions: {},
    argv: [],
    cwd: () => "/",
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
  };
}
