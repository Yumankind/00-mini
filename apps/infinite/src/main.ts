// isomorphic-git's browser build reads a global `Buffer` (122 references) that browsers do not have.
// The shim is installed once, first thing, before any module can touch git; the power shell's
// `gitUsable()` checks for exactly this global and refuses by name when it is absent.
import { Buffer } from "buffer";
if (!(globalThis as { Buffer?: unknown }).Buffer) (globalThis as { Buffer?: unknown }).Buffer = Buffer;

/**
 * The owned agent PWA — docs/HANDOFF-infinite-agent.md §4.
 *
 * The service worker is registered AFTER the app has mounted, not before. Registering first delays
 * the first paint behind a worker install for no benefit: the shell this load needs is already in
 * flight, and the worker's job is the NEXT load — the offline one. `agent` is unused here on purpose;
 * `App.vue` boots it, because the boot is something the person watches.
 */
import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

createApp(App).mount("#app");

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((err) => {
      // An origin without a worker still runs; it just has no offline shell, and saying so in the
      // console is more useful than an unhandled rejection.
      console.warn("[infinite] the service worker did not register — no offline shell", err);
    });
  });
}
