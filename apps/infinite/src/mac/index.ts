/**
 * The 00 Mac and the 00 phone, both doors, one import.
 *
 * `mountMac(deps)` is the ONE wiring call — see `state.ts` for what it hands over and why nothing in
 * this folder reaches back into the app's stores.
 */
export { mountMac, mountMacFromOwned, macMounted, type MacDeps, type ChatRow, RELAY_TOKEN_SECRET } from "./state.js";
export { createMacClient, readAnswerText, readSessionRows, MacClientError, type MacClient, type EngineRow, type HubRow } from "./client.js";
export { createBrowserEngine, browserMachineFp, MacRefusal, KIND_UNSUPPORTED, UNSUPPORTED_KINDS, type BrowserEngine, type AnswerRuntime, type EngineEvent } from "./answer.js";
export { createRelay, type Relay, type RelayResponse } from "./relay.js";
export { clientIdentity, engineIdentity, forgetClientIdentity, forgetEngineIdentity } from "./keys.js";
export { ed25519Available, Ed25519Unavailable, type WireIdentity } from "./wire.js";
export { MAC_POLL_MS, RELAY_ORIGIN, relayOrigin } from "./config.js";
