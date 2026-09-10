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
