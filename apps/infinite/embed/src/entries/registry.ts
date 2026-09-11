/**
 * `dist/embed/m/registry.js` — the registry client, fetched the first time a registered site
 * actually needs the registry (§5.3–§5.6).
 *
 * WHY IT IS NOT IN `e.js`. Read the client's own header: "NOT ONE BYTE BEFORE IT IS REACHED FOR."
 * That was true of the CALLS and it is now true of the CODE. There are exactly three doors, and each
 * is a person doing something — the first `send_to_owner`, the owner's Register card, the reply poll
 * after a message has been sent — and a site whose owner never registered goes through none of them.
 * Until then it was 45 KB of source (the client, the ed25519 device key, the bundle reader) sitting
 * in a script that every page load of every site fetches.
 *
 * WHAT STAYED IN THE LOADER, and why: `registry/gate.ts` holds the two things level 0 genuinely
 * reads — the persisted state and the cached public bundle, both of them IndexedDB reads with no
 * network — plus `api-base.ts`, which answers "is this build pointed at a registry at all?". The
 * gate builds THIS module's client on first need and hands it the state store it has already read,
 * so nothing is read twice.
 */

export { createRegistryClient } from "../registry/client.js";
export type { RegistryClient, ClientOptions } from "../registry/client.js";
