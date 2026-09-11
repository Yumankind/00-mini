// The Node globals two libraries read at load time (`Buffer`, `process`) — installed by the FIRST
// import, because a module's imports evaluate before its body does. See src/shims.ts for why.
import "./shims.js";

/**
 * The owned agent PWA — docs/HANDOFF-infinite-agent.md §4.
 *
 * The service worker is registered AFTER the app has mounted, not before. Registering first delays
 * the first paint behind a worker install for no benefit: the shell this load needs is already in
 * flight, and the worker's job is the NEXT load — the offline one. The agent is booted by whichever
 * of the two screens is showing (`Root.vue`), because the boot is something the person watches.
 */
import { createApp } from "vue";
import Root from "./Root.vue";
import "./style.css";

// `Root` and not `App`: this origin serves two screens — the landing page with the agent floating
// over it at `/`, and the app itself at `/app` and every deep link it already answers. `src/mini/nav.ts`
// owns which is which; `Root.vue` owns the swap and the boot when `App.vue` is not the one mounted.
createApp(Root).mount("#app");

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((err) => {
      // An origin without a worker still runs; it just has no offline shell, and saying so in the
      // console is more useful than an unhandled rejection.
      console.warn("[infinite] the service worker did not register — no offline shell", err);
    });
  });
}
