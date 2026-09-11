/**
 * The gear, and what is behind it — `m/setup.js`, fetched on the first press (§5.2.4).
 *
 * WHY THE WIZARD IS NOT IN THE LOADER. It is the OWNER's flow: five screens, a live preview, the
 * carrier documents they save, the Register card of §5.3. A visitor never opens it, and a visitor is
 * who `e.js` is for — one edge-cached request that answers a question about a website. So the gear
 * is a button in the loader and the wizard is a module behind it.
 *
 * THE PRESS IS A PERSON, so a request at that moment is honest in a way that a request on load never
 * is. The panel shows a line while it comes and a plain sentence if it does not — an owner opening
 * the gear on a plane is told what happened, not left with a gear that does nothing.
 */

import { SETUP_MODULE, loadModule } from "../modules.js";
import type { SetupHandle, SetupOptions } from "./setup.js";

/** The shape `m/setup.js` exposes. */
export interface SetupModule {
  renderSetup(container: HTMLElement, opts: SetupOptions): SetupHandle;
}

/** The one line the panel shows while the wizard is on its way. */
export const SETUP_LOADING = "Opening setup…";
/** And the one it shows instead when it never arrives. Plain, and about what to do next. */
export const SETUP_FAILED = "Setup could not be opened — this needs a connection the first time. Try again.";

export function loadSetupModule(
  productHost: string,
  onError?: (message: string) => void,
): Promise<SetupModule | null> {
  return loadModule<SetupModule>(productHost, SETUP_MODULE, () => onError?.(SETUP_FAILED));
}
