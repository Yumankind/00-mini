/**
 * The registry client: abbreviated metadata, version selection, tarballs, integrity.
 *
 * WHY THE PUBLIC REGISTRY DIRECTLY AND NOT A PROXY. Because it answers a browser. `registry.npmjs.org`
 * sends `Access-Control-Allow-Origin: *` on both metadata and tarballs, so a page can install a
 * package with nothing between it and npm — no server of ours, no token, no CORS proxy to trust.
 * That is the single fact this whole layer rests on, so there is a test that proves it against the
 * real registry (`test/registry-live.test.ts`, skipped cleanly when offline).
 *
 * DOES: `application/vnd.npm.install-v1+json` (the abbreviated packument — a tenth of the bytes of
 * the full one, and it carries everything an install needs: versions, `dependencies`,
 * `dist.tarball`, `dist.integrity`, `bin`, `engines`, `hasInstallScript`); dist-tags; semver range
 * selection with the installed `semver`; tarball download; `dist.integrity` verification as
 * `sha512-<base64>` through WebCrypto, with a fall back to the legacy `dist.shasum` (sha1) for the
 * old packages that carry no integrity; a per-name packument cache so a wide tree is one request
 * per package.
 *
 * DOES NOT: authentication (no `_authToken`, no private registries — a token in a page is a token
 * for everyone), scopes with their own registry, `npm audit`, provenance/attestation checks,
 * `git+ssh:` / `file:` / `http:` dependency specifiers (each refuses by name), `overrides`,
 * `resolutions`, or the full packument (which carries READMEs and would multiply the bytes).
 */

import semver from "semver";
import { NodeCompatError } from "../errors.js";
import { base64ToBytes, bytesToBase64, bytesToHex, sha1 } from "../modules/crypto.js";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
export const ABBREVIATED_ACCEPT = "application/vnd.npm.install-v1+json";

export type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export interface DistInfo {
  tarball: string;
  integrity?: string;
  shasum?: string;
}

export interface PackageVersion {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bundleDependencies?: string[];
  dist: DistInfo;
  bin?: string | Record<string, string>;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  deprecated?: string;
  hasInstallScript?: boolean;
  scripts?: Record<string, string>;
}

export interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, PackageVersion>;
}

export interface RegistryOptions {
  registry?: string;
  fetch?: FetchLike;
}

/** Specifiers this client will not resolve, each with the reason in its own words. */
const UNSUPPORTED: { test: RegExp; why: string }[] = [
  { test: /^git(\+|:)/, why: "a git dependency needs a git clone over a transport a browser cannot open" },
  { test: /^github:|^[\w.-]+\/[\w.-]+#/, why: "a GitHub shorthand resolves to a git clone, which needs a transport a browser cannot open" },
  { test: /^file:/, why: "a file: dependency points outside the workspace" },
  { test: /^link:/, why: "a link: dependency is a symlink, and this filesystem has none" },
  { test: /^https?:/, why: "a URL dependency is a tarball fetched from an arbitrary origin, which needs that origin's CORS — fetch it yourself and vendor it" },
  { test: /^workspace:/, why: "workspace: protocol belongs to a monorepo tool, not to the registry" },
];

export class RegistryClient {
  readonly registry: string;
  private readonly doFetch: FetchLike;
  private readonly cache = new Map<string, Promise<Packument>>();

  constructor(opts: RegistryOptions = {}) {
    this.registry = (opts.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
    const fallback = (globalThis as { fetch?: FetchLike }).fetch;
    if (!opts.fetch && !fallback) {
      throw new NodeCompatError("ERR_NO_FETCH", "the npm client needs a fetch implementation and this environment has none — pass one in");
    }
    this.doFetch = opts.fetch ?? ((input, init) => (fallback as FetchLike)(input, init));
  }

  /** `@scope/name` is `@scope%2fname` on the wire; every other name goes through unchanged. */
  packumentUrl(name: string): string {
    return `${this.registry}/${name.replace(/^@/, "@").replace("/", "%2f")}`;
  }

  async packument(name: string): Promise<Packument> {
    const existing = this.cache.get(name);
    if (existing) return await existing;
    const request = (async (): Promise<Packument> => {
      const response = await this.doFetch(this.packumentUrl(name), { headers: { accept: ABBREVIATED_ACCEPT } });
      if (response.status === 404) {
        throw new NodeCompatError("ERR_PACKAGE_NOT_FOUND", `404 Not Found - GET ${this.packumentUrl(name)} — '${name}' is not published on ${this.registry}`);
      }
      if (!response.ok) {
        throw new NodeCompatError("ERR_REGISTRY", `${response.status} ${response.statusText} - GET ${this.packumentUrl(name)}`);
      }
      return (await response.json()) as Packument;
    })();
    this.cache.set(name, request);
    return await request;
  }

  async tarball(url: string): Promise<Uint8Array> {
    const response = await this.doFetch(url);
    if (!response.ok) {
      throw new NodeCompatError("ERR_TARBALL", `${response.status} ${response.statusText} - GET ${url}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /** The version a range selects, by npm's rules: a dist-tag first, then the highest that satisfies. */
  async resolveVersion(name: string, range: string): Promise<PackageVersion> {
    assertSupportedRange(name, range);
    const packument = await this.packument(name);
    const wanted = range === "" || range === "*" || range === "latest" ? (packument["dist-tags"]?.latest ?? "") : range;
    const tagged = packument["dist-tags"]?.[wanted];
    const exact = tagged ?? (semver.valid(wanted) ? wanted : null);
    if (exact && packument.versions[exact]) return packument.versions[exact];
    const picked = semver.maxSatisfying(Object.keys(packument.versions), wanted, { includePrerelease: false });
    if (!picked) {
      throw new NodeCompatError(
        "ERR_NO_MATCHING_VERSION",
        `No matching version found for ${name}@${range} — ${this.registry} has ${Object.keys(packument.versions).length} versions and none satisfies it`,
      );
    }
    return packument.versions[picked] as PackageVersion;
  }
}

export function assertSupportedRange(name: string, range: string): void {
  for (const { test, why } of UNSUPPORTED) {
    if (test.test(range)) {
      throw new NodeCompatError(
        "ERR_UNSUPPORTED_SPECIFIER",
        `${name}@${range}: this runtime installs from the npm registry only — ${why}`,
      );
    }
  }
  if (range.startsWith("npm:")) {
    throw new NodeCompatError(
      "ERR_UNSUPPORTED_SPECIFIER",
      `${name}@${range}: aliased dependencies (npm:) are not resolved here — depend on the real name`,
    );
  }
}

/** `sha512-<base64>`, as `dist.integrity` spells it. */
export async function verifyIntegrity(bytes: Uint8Array, integrity: string): Promise<void> {
  const [algorithm, expected] = integrity.split("-", 2) as [string, string];
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  const names: Record<string, string> = { sha512: "SHA-512", sha384: "SHA-384", sha256: "SHA-256" };
  if (algorithm === "sha1") {
    const actual = bytesToBase64(sha1(bytes));
    if (actual !== expected) throw integrityError(integrity, `sha1-${actual}`);
    return;
  }
  const subtleName = names[algorithm];
  if (!subtleName || !subtle) {
    throw new NodeCompatError(
      "ERR_INTEGRITY_UNSUPPORTED",
      `integrity '${integrity}' uses ${algorithm}, which this runtime cannot verify — it will not install a tarball it cannot check`,
    );
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await subtle.digest(subtleName, copy.buffer));
  const actual = bytesToBase64(digest);
  if (actual !== expected) throw integrityError(integrity, `${algorithm}-${actual}`);
}

/** The old packages carry only `dist.shasum`, a hex sha1. Checked rather than skipped. */
export function verifyShasum(bytes: Uint8Array, shasum: string): void {
  const actual = bytesToHex(sha1(bytes));
  if (actual !== shasum.toLowerCase()) {
    throw new NodeCompatError("ERR_INTEGRITY", `the tarball's sha1 is ${actual}, and the registry said ${shasum} — refusing to unpack it`);
  }
}

function integrityError(expected: string, actual: string): NodeCompatError {
  return new NodeCompatError(
    "ERR_INTEGRITY",
    `the tarball's integrity is ${actual}, and the registry said ${expected} — refusing to unpack it`,
  );
}

/** Round-trips an integrity string, so a lockfile's value can be compared without re-hashing. */
export function integrityBytes(integrity: string): Uint8Array {
  return base64ToBytes(integrity.slice(integrity.indexOf("-") + 1));
}
