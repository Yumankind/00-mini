/**
 * The two doors of §8.4/§8.5 as one small store, so the card is a view and nothing else.
 *
 * WHY A STORE AND NOT COMPONENT STATE. Both halves outlive a pane: the engine half polls every
 * fifteen seconds for as long as the tab is open, whichever screen the person is looking at, and the
 * client half holds a conversation that must survive switching to Files and back. Component state
 * would restart the poll on every mount and lose the exchange, which is exactly the failure §8.5
 * promises does not happen.
 *
 * WHERE THE RELAY TOKEN LIVES. In the vault, sealed, like every other credential in this app (§4.5):
 * "a key reaches the vault or it does not get stored at all". It is read fresh on every relay call —
 * `relay.ts` takes a function, not a string — so unlocking mid-session starts working without a
 * reload, and locking stops it without a stale copy sitting in a closure.
 */
import { computed, ref, shallowRef } from "vue";
import { SESSION_TTL_MS } from "@00/shared";
import { createBrowserEngine, type AnswerRuntime, type BrowserEngine, type EngineEvent } from "./answer.js";
import { createMacClient, readAnswerText, readSessionRows, type EngineRow, type HubRow, type MacClient, type MacSessionRow } from "./client.js";
import { clientIdentity, engineIdentity, forgetEngineIdentity } from "./keys.js";
import { createRelay, type Relay } from "./relay.js";
import { ed25519Available } from "./wire.js";

/** The name the relay token is sealed under. One string, named here so two modules cannot spell it
 *  differently and leave a person with a token the card cannot find. */
export const RELAY_TOKEN_SECRET = "mobileConnect.relayToken";

export interface MacDeps {
  agentId: string;
  displayName?: string;
  emoji?: string;
  /** The agent's own loop. Only the two calls the phone can reach — a narrow shape on purpose. */
  runtime: AnswerRuntime;
  vault: { readonly unlocked: boolean; get(name: string): Promise<string>; set(name: string, value: string): Promise<void> };
  /** Defaults to this page's origin; passed in so a test is not a browser. */
  origin?: string;
}

export interface ChatRow {
  id: string;
  who: "you" | "mac";
  text: string;
  at: number;
}

const deps = shallowRef<MacDeps | null>(null);
const token = ref<string | null>(null);
const client = shallowRef<MacClient | null>(null);
const engine = shallowRef<BrowserEngine | null>(null);

const busy = ref(false);
const problem = ref<string | null>(null);
const note = ref<string | null>(null);

// The client half
const dev = ref<string>("");
const engines = ref<EngineRow[]>([]);
const hubs = ref<HubRow[]>([]);
const chosenEngineFp = ref<string>("");
const chosenAgentId = ref<string>("");
const glance = ref<string | null>(null);
const rows = ref<ChatRow[]>([]);
const macSessions = ref<MacSessionRow[]>([]);
const targetSessionId = ref<string>("");

// The engine half
const answering = ref(false);
const engineSessionId = ref<string>("");
const engineGlance = ref<string | null>(null);
const engineExpiresAt = ref<number | null>(null);
const phones = ref<{ dev: string; label?: string }[]>([]);
const events = ref<EngineEvent[]>([]);

export const macReady = computed(() => deps.value !== null && ed25519Available());
export const macBusy = computed(() => busy.value);
export const macProblem = computed(() => problem.value);
export const macNote = computed(() => note.value);
export const macDev = computed(() => dev.value);
export const macEngines = computed(() => engines.value);
export const macHubs = computed(() => hubs.value);
export const macGlance = computed(() => glance.value);
export const macRows = computed(() => rows.value);
export const macSessionRows = computed(() => macSessions.value);
export const macTargetSession = computed(() => targetSessionId.value);
export const macAnswering = computed(() => answering.value);
export const macEngineSessionId = computed(() => engineSessionId.value);
export const macEngineGlance = computed(() => engineGlance.value);
export const macEngineExpiresAt = computed(() => engineExpiresAt.value);
export const macPhones = computed(() => phones.value);
export const macEvents = computed(() => events.value);
export const macTokenSet = computed(() => !!token.value);
export const macChosen = computed(() => ({ engineFp: chosenEngineFp.value, agentId: chosenAgentId.value }));

let rowSeq = 0;
const addRow = (who: ChatRow["who"], text: string): void => {
  rows.value = [...rows.value, { id: `r${++rowSeq}`, who, text, at: Date.now() }];
};

/**
 * THE ONE WIRING CALL. `bootstrap.ts` (or the card, which does it today) hands over the agent's loop
 * and its vault; nothing in this folder reaches back into the app's stores, so both halves stay
 * testable without a Vue tree.
 */
export function mountMac(next: MacDeps): void {
  deps.value = next;
}

export function macMounted(): boolean {
  return deps.value !== null;
}

/**
 * The same call, from an owned agent — ONE line for `runtime/bootstrap.ts` to add:
 *
 *     mountMacFromOwned(owned);
 *
 * Structurally typed rather than importing `OwnedAgent`, so this folder still depends on nothing in
 * the app and the boot file stays the place that constructs packages and nothing else. The narrowing
 * is the point: the phone reaches `run` and `listSessions`, and not one thing more.
 */
export function mountMacFromOwned(owned: {
  profile: { id: string; displayName: string; emoji: string };
  runtime: { run(o: { prompt: string; sessionId?: string }): Promise<{ text: string; sessionId: string }>; listSessions(): Promise<{ id: string; title: string; updatedAt: number }[]> };
  vault: MacDeps["vault"];
}): void {
  mountMac({
    agentId: owned.profile.id,
    displayName: owned.profile.displayName,
    emoji: owned.profile.emoji,
    runtime: {
      run: (o) => owned.runtime.run({ prompt: o.prompt, ...(o.sessionId ? { sessionId: o.sessionId } : {}) }),
      listSessions: () => owned.runtime.listSessions(),
    },
    vault: owned.vault,
  });
}

function relay(): Relay {
  return createRelay({ token: () => token.value });
}

async function guard<T>(what: () => Promise<T>): Promise<T | null> {
  busy.value = true;
  problem.value = null;
  try {
    return await what();
  } catch (err) {
    problem.value = err instanceof Error ? err.message : String(err);
    return null;
  } finally {
    busy.value = false;
  }
}

/** Read the sealed relay token, if the vault is open. A locked vault is not an error here — it is the
 *  ordinary state of a browser that has been idle, and the card says so. */
export async function loadRelayToken(): Promise<boolean> {
  const d = deps.value;
  if (!d?.vault.unlocked) return false;
  try {
    const value = (await d.vault.get(RELAY_TOKEN_SECRET))?.trim();
    token.value = value || null;
  } catch {
    token.value = null;
  }
  return !!token.value;
}

export async function saveRelayToken(value: string): Promise<void> {
  const d = deps.value;
  if (!d) return;
  if (!d.vault.unlocked) {
    problem.value = "Unlock your vault first — a relay key is only ever stored sealed.";
    return;
  }
  await d.vault.set(RELAY_TOKEN_SECRET, value.trim());
  token.value = value.trim() || null;
}

// ── The browser as a client ──────────────────────────────────────────────────────────────────────

/** Enrol this browser and list what the account can reach. The operator still has to admit it at the
 *  Mac — this is the only step the browser is allowed to take on its own. */
export async function connectAsClient(label?: string): Promise<void> {
  const d = deps.value;
  if (!d) return;
  await guard(async () => {
    const identity = await clientIdentity();
    dev.value = identity.dev;
    const c = createMacClient({ relay: relay(), identity });
    client.value = c;
    await c.enrol(label ?? "This browser");
    const listed = await c.listEngines();
    engines.value = listed.engines;
    hubs.value = listed.hubs;
    note.value =
      listed.engines.length === 0
        ? "Now open 00 on your Mac, start mobile connect for an agent, and admit this browser by name."
        : null;
    return null;
  });
}

export async function chooseMac(engineFp: string, agentId: string): Promise<void> {
  chosenEngineFp.value = engineFp;
  chosenAgentId.value = agentId;
  glance.value = null;
  const c = client.value;
  const row = engines.value.find((e) => e.engineFp === engineFp);
  if (!c || !row) return;
  // The session id IS the engine fingerprint: the Mac publishes one row per session under it.
  glance.value = await c.glanceFor(engineFp, row.deviceKey);
}

function chosen(): { sessionId: string; engineFp: string; agentId: string; engineDeviceKey: string } | null {
  const row = engines.value.find((e) => e.engineFp === chosenEngineFp.value);
  if (!row || !chosenAgentId.value) return null;
  return {
    sessionId: row.engineFp,
    engineFp: row.engineFp,
    agentId: chosenAgentId.value,
    engineDeviceKey: row.deviceKey,
  };
}

export async function sendToMac(text: string): Promise<void> {
  const c = client.value;
  const to = chosen();
  if (!c || !to || !text.trim()) return;
  addRow("you", text.trim());
  await guard(async () => {
    const sent = await c.prompt(to, text.trim(), targetSessionId.value || undefined);
    if (!sent.delivered) {
      addRow("mac", "Your Mac is not connected right now. It will get this when it wakes.");
    }
    const answer = await c.awaitResult({ ...to, frameId: sent.frameId });
    addRow("mac", answer.error ? `Refused: ${answer.error}` : readAnswerText(answer.result));
    return null;
  });
}

/** The agent's own sessions, for the picker — the Mac's list, as the operator sees it. */
export async function loadMacSessions(): Promise<void> {
  const c = client.value;
  const to = chosen();
  if (!c || !to) return;
  await guard(async () => {
    const sent = await c.listSessions(to);
    const answer = await c.awaitResult({ ...to, frameId: sent.frameId });
    if (answer.error) throw new Error(`Your Mac refused that: ${answer.error}`);
    macSessions.value = readSessionRows(answer.result);
    return null;
  });
}

export function chooseMacSession(id: string): void {
  targetSessionId.value = id;
}

export async function closeMacSession(): Promise<void> {
  const c = client.value;
  const to = chosen();
  if (!c || !to) return;
  await guard(async () => {
    await c.close(to);
    chosenEngineFp.value = "";
    chosenAgentId.value = "";
    glance.value = null;
    macSessions.value = [];
    targetSessionId.value = "";
    return null;
  });
}

// ── The browser as an engine ─────────────────────────────────────────────────────────────────────

/**
 * "Let my phone reach this agent."
 *
 * Turning it ON publishes the hub (so the phone's home screen lists this browser), enrols a
 * per-session key and opens a session slot; the phone is then ADMITTED here, by name, exactly as the
 * Mac admits one. Turning it off stops the poll and throws the session key away, which is what makes
 * a session the relay still remembers unanswerable rather than merely idle.
 */
export async function startAnswering(): Promise<void> {
  const d = deps.value;
  if (!d) return;
  await guard(async () => {
    const identity = await engineIdentity();
    const e = createBrowserEngine({
      relay: relay(),
      identity,
      agentId: d.agentId,
      displayName: d.displayName,
      emoji: d.emoji,
      origin: d.origin ?? globalThis.location?.origin ?? "",
      runtime: d.runtime,
      onEvent: (event) => {
        events.value = [...events.value.slice(-19), event];
      },
    });
    engine.value = e;
    engineSessionId.value = e.sessionId;
    await e.publishHub(d.displayName ? `${d.displayName} in this browser` : "This browser");
    await e.publishSession();
    await refreshPhones();
    answering.value = true;
    return null;
  });
}

/** The devices enrolled on this account, for the person to name one. Never auto-admitted, even when
 *  exactly one is enrolled: naming the phone is the decision, and it is what the glance code checks. */
export async function refreshPhones(): Promise<void> {
  const e = engine.value;
  if (!e) return;
  const r = await relay()("GET", `/api/engines/${encodeURIComponent(e.sessionId)}/devices`);
  const list = Array.isArray(r.json.devices) ? (r.json.devices as { dev?: string; label?: string }[]) : [];
  phones.value = list
    .filter((p): p is { dev: string; label?: string } => typeof p.dev === "string" && p.dev.length > 0)
    .map((p) => ({ dev: p.dev, ...(p.label ? { label: p.label } : {}) }));
}

export async function admitPhone(phoneDev: string, takeOver = false): Promise<void> {
  const e = engine.value;
  if (!e) return;
  await guard(async () => {
    const opened = await e.openSession(phoneDev, takeOver);
    if (!opened.ok) throw new Error(opened.error);
    engineGlance.value = await e.glance();
    engineExpiresAt.value = opened.startedAt + SESSION_TTL_MS;
    e.start();
    return null;
  });
}

export function stopAnswering(): void {
  engine.value?.stop();
  engine.value = null;
  answering.value = false;
  engineGlance.value = null;
  engineExpiresAt.value = null;
  phones.value = [];
  void forgetEngineIdentity();
}

/** Test seam, and only that: module state outlives a test file otherwise. */
export function __resetMacStateForTests(): void {
  deps.value = null;
  token.value = null;
  client.value = null;
  engine.value?.stop();
  engine.value = null;
  busy.value = false;
  problem.value = null;
  note.value = null;
  dev.value = "";
  engines.value = [];
  hubs.value = [];
  chosenEngineFp.value = "";
  chosenAgentId.value = "";
  glance.value = null;
  rows.value = [];
  macSessions.value = [];
  targetSessionId.value = "";
  answering.value = false;
  engineSessionId.value = "";
  engineGlance.value = null;
  engineExpiresAt.value = null;
  phones.value = [];
  events.value = [];
}
