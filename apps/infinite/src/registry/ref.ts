/**
 * THE REF — this agent's public name on every website it runs on (§5.1).
 *
 * `ia_<base32 unix-seconds>_<12 base32>`, minted HERE, in this browser, OFFLINE, with no server call
 * of any kind. That is the whole point: the ref is what a site owner pastes into their page, it is
 * public by design, and a ref GRANTS NOTHING. Everything an owner may actually do — claim, publish,
 * drain, reply, subscribe — is a signature under the link key of `link-key.ts`, which never leaves
 * this browser. Public ref in the page, private key at home.
 *
 * ── THE GRAMMAR IS A CROSS-REPO CONTRACT ───────────────────────────────────────────────────────
 *
 * The worker refuses a ref that does not match its own `REF_RE` with `bad_ref` before it looks at
 * anything else (moltworker `worker/src/infinite/refs.ts`). So the alphabet (RFC 4648 lower case),
 * the seconds field (6–9 digits, which covers 1971 to the year 3000) and the random field (exactly
 * 12 characters, 60 bits) are copied from that file rather than re-invented: a ref this app mints
 * and the worker will not take is a ref a person pasted into their site for nothing.
 *
 * ── ONE REF PER AGENT, REMEMBERED BESIDE THE AGENT ID ──────────────────────────────────────────
 *
 * It lives in `lib/kv.ts` next to `agentId`, because it is the same kind of fact: which agent lives
 * on this origin, and what it is called out there. Minting a second ref for an agent that already
 * has one would orphan every snippet already pasted into a website, so `ownRef()` reads before it
 * mints and writes what it minted immediately.
 */
import { REGISTRY_APP_KEY, REGISTRY_REF_KEY, kvGet, kvSet } from "../lib/kv.js";

/** RFC 4648 lower case — the worker's `BASE32_ALPHABET`, character for character. */
export const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export type RandomBytes = (n: number) => Uint8Array;

const cryptoRandom: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/** A non-negative integer in base 32. `0` is `'a'`. 256/32 is exact, so `% 32` over a random byte is unbiased. */
export function base32Number(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new RangeError("base32Number takes a non-negative integer");
  let v = Math.floor(n);
  if (v === 0) return BASE32_ALPHABET[0];
  let out = "";
  while (v > 0) {
    out = BASE32_ALPHABET[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

/** The inverse, or null when a character is not in the alphabet. */
export function unbase32Number(text: string): number | null {
  if (!text) return null;
  let v = 0;
  for (const ch of text) {
    const i = BASE32_ALPHABET.indexOf(ch);
    if (i < 0) return null;
    v = v * 32 + i;
  }
  return v;
}

/** The worker's `REF_RE`, verbatim. Anything else is refused there with `bad_ref`. */
export const REF_RE = /^ia_[a-z2-7]{6,9}_[a-z2-7]{12}$/;

export function isRef(value: unknown): value is string {
  return typeof value === "string" && REF_RE.test(value);
}

export function newRef(atMs: number = Date.now(), random: RandomBytes = cryptoRandom): string {
  const bytes = random(12);
  let tail = "";
  for (const b of bytes) tail += BASE32_ALPHABET[b % 32];
  return `ia_${base32Number(Math.floor(atMs / 1000))}_${tail}`;
}

/** The unix-seconds the ref names, or null when the grammar does not hold. Informational only. */
export function refMintedAtSeconds(ref: string): number | null {
  if (!isRef(ref)) return null;
  return unbase32Number(ref.split("_")[1]);
}

/**
 * The snippet a site owner pastes, for this ref (§5.1).
 *
 * The product origin is THIS app's own origin, because the site Worker serves `/e/<ref>.js` from the
 * same place the PWA is served from (§9.1: "the loader and the PWA are static; they ship from their
 * own Worker site"). Hard-coding a host here would produce a snippet that works on production and
 * silently points a developer's localhost build at production too.
 */
export function embedSnippet(ref: string, origin: string): string {
  return `<script async src="${origin.replace(/\/+$/, "")}/e/${ref}.js"><\/script>`;
}

/** Read the ref this agent already has, or mint one and remember it. Never mints twice. */
export async function ownRef(mint: () => string = () => newRef()): Promise<string> {
  const stored = await kvGet<string>(REGISTRY_REF_KEY);
  if (isRef(stored)) return stored;
  const ref = mint();
  await kvSet(REGISTRY_REF_KEY, ref);
  return ref;
}

/** What this origin remembers about the app its ref became, once a site registered it. */
export interface RegistryAppMemo {
  appId: string;
  /** `dev` | `unclaimed` | `claimed` — the worker's word, never this app's guess. */
  status: string;
  /** The origin the site registered from, as the claim named it. */
  origin: string | null;
  claimedAt: string | null;
}

export async function readAppMemo(): Promise<RegistryAppMemo | null> {
  return kvGet<RegistryAppMemo>(REGISTRY_APP_KEY);
}

export async function writeAppMemo(memo: RegistryAppMemo): Promise<void> {
  await kvSet(REGISTRY_APP_KEY, memo);
}
