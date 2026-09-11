/**
 * `dist/embed/m/brain.js` — the brain module, fetched only when somebody asks for a brain.
 *
 * WAS `m/m.js`, which carried the local model alone. It carries the LOOP as well now, because the
 * two are asked for at the same instant and by the same press: there is no path in the embed that
 * wants `@00/agent-runtime` without a provider, or a provider without something to run it. One
 * module is one request.
 *
 * What is in here, and why none of it may be in `e.js`: the agent runtime and its prompt text, the
 * in-memory agent-fs, `@mediapipe/tasks-genai` and `@mlc-ai/web-llm` (megabytes of WebGPU runtime).
 * The loader's whole budget is 60 KB gz (§10) and level 0 must work with NO model at all (§5.2.3).
 */

export { createBrain, threadFs } from "../brain-impl.js";
export { pickLocalProvider, progressLine } from "../model-entry.js";
export type { Brain, BrainOptions, BrainModule } from "../brain.js";
