/**
 * The local model, in its OWN module — never in the loader.
 *
 * WHY it is a separate file: `@00/agent-models`'s WebLLM provider pulls `@mlc-ai/web-llm` in behind
 * it, which is 2.1 MB gzipped. The loader's whole budget is 60 KB (§10), and level 0 must work with
 * NO model at all (§5.2.3). So `e.js` never imports this; the "Load local AI" button does, at the
 * moment the visitor asks for it, and a site that is never asked never fetches a byte of it.
 */
export { WEBLLM_CATALOG, WEBLLM_DEFAULT_MODEL_ID, WebLLMProvider, webllmCatalogFor } from "@00/agent-models";
