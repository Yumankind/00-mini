/**
 * A registry in a Map: real abbreviated packuments, real gzipped tarballs, real sha512 integrity.
 *
 * WHY BUILD THE TARBALLS RATHER THAN STUB THE EXTRACTION. Because the install path's whole job is
 * fetch → verify → gunzip → untar → write, and a stub at any of those four would test nothing. These
 * are made with `@00/agent-fs`'s own tar writer and the platform's CompressionStream, so what the
 * client unpacks in the tests is the same shape npm sends: a `package/` prefix, a `package.json` at
 * the top, and a sha512 the client has to agree with.
 */
import { gzip, tarPack, type TarEntry } from "@00/agent-fs";
import { bytesToBase64 } from "../src/modules/crypto.js";
import type { FetchLike, Packument, PackageVersion } from "../src/npm/registry.js";

const encoder = new TextEncoder();

export interface FakePackage {
  name: string;
  version: string;
  files?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  deprecated?: string;
  native?: boolean;
  /** Break the integrity on purpose. */
  corrupt?: boolean;
}

export interface FakeRegistry {
  fetch: FetchLike;
  calls: string[];
  tarballs: Map<string, Uint8Array>;
}

async function buildTarball(spec: FakePackage): Promise<Uint8Array> {
  const manifest: Record<string, unknown> = {
    name: spec.name,
    version: spec.version,
    main: "index.js",
    dependencies: spec.dependencies,
    scripts: spec.scripts,
    bin: spec.bin,
  };
  const entries: TarEntry[] = [
    { path: "package/package.json", kind: "file", data: encoder.encode(JSON.stringify(manifest, null, 2)) },
    { path: "package/index.js", kind: "file", data: encoder.encode(`module.exports = ${JSON.stringify(`${spec.name}@${spec.version}`)};\n`) },
    { path: "package/lib", kind: "dir", data: new Uint8Array(0) },
  ];
  for (const [path, body] of Object.entries(spec.files ?? {})) {
    entries.push({ path: `package/${path}`, kind: "file", data: encoder.encode(body) });
  }
  if (spec.native) {
    entries.push({ path: "package/binding.gyp", kind: "file", data: encoder.encode("{ 'targets': [] }") });
    entries.push({ path: "package/build/Release/thing.node", kind: "file", data: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]) });
  }
  // A stray file at the archive root, which `stripTarballPrefix` must drop rather than mis-place.
  entries.push({ path: "pax_global_header", kind: "file", data: encoder.encode("ignored") });
  return await gzip(tarPack(entries));
}

async function integrityOf(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-512", copy.buffer);
  return `sha512-${bytesToBase64(new Uint8Array(digest))}`;
}

/** A registry whose every answer is real bytes; `fetch` records what was asked for. */
export async function fakeRegistry(packages: FakePackage[], base = "https://registry.test"): Promise<FakeRegistry> {
  const packuments = new Map<string, Packument>();
  const tarballs = new Map<string, Uint8Array>();
  const calls: string[] = [];

  for (const spec of packages) {
    const tarball = await buildTarball(spec);
    const url = `${base}/${spec.name}/-/${spec.name.replace(/^@[^/]+\//, "")}-${spec.version}.tgz`;
    tarballs.set(url, tarball);
    const version: PackageVersion = {
      name: spec.name,
      version: spec.version,
      dependencies: spec.dependencies,
      devDependencies: spec.devDependencies,
      optionalDependencies: spec.optionalDependencies,
      peerDependencies: spec.peerDependencies,
      peerDependenciesMeta: spec.peerDependenciesMeta,
      bin: spec.bin,
      scripts: spec.scripts,
      deprecated: spec.deprecated,
      dist: {
        tarball: url,
        integrity: spec.corrupt ? await integrityOf(encoder.encode("not this")) : await integrityOf(tarball),
      },
    };
    const existing = packuments.get(spec.name) ?? { name: spec.name, "dist-tags": {}, versions: {} };
    existing.versions[spec.version] = version;
    existing["dist-tags"].latest = Object.keys(existing.versions).sort().at(-1) as string;
    packuments.set(spec.name, existing);
  }

  const fetch: FetchLike = async (input) => {
    calls.push(input);
    const tarball = tarballs.get(input);
    if (tarball) {
      const copy = new Uint8Array(tarball.byteLength);
      copy.set(tarball);
      return new Response(copy, { status: 200 });
    }
    const name = decodeURIComponent(input.slice(base.length + 1));
    const packument = packuments.get(name);
    if (!packument) return new Response("not found", { status: 404, statusText: "Not Found" });
    return new Response(JSON.stringify(packument), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls, tarballs };
}
