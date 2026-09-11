import { describe, expect, it } from "vitest";
import { ABBREVIATED_ACCEPT, DEFAULT_REGISTRY, RegistryClient, verifyIntegrity } from "../src/npm/registry.js";
import { install } from "../src/npm/install.js";
import { createLoader, snapshotLoaderFs } from "../src/loader/index.js";
import { MemoryFs } from "@00/agent-fs";

/**
 * ONE real, read-only exchange with registry.npmjs.org — the fact this whole npm layer rests on.
 *
 * THE CLAIM BEING PROVEN: the public registry answers a BROWSER. It sends
 * `Access-Control-Allow-Origin: *` on both the abbreviated metadata and the tarball, so a page can
 * install a package with nothing between it and npm: no proxy of ours, no token, no CORS shim. If
 * that ever stops being true, this test is where it shows up, and the answer is a worker in front —
 * which is a different product decision and should not be discovered in production.
 *
 * It is read-only (two GETs), it downloads one of the smallest packages on the registry
 * (`is-number`, ~2 KB, zero dependencies, no install script), and it SKIPS CLEANLY when the machine
 * is offline or when `NO_NETWORK_TESTS=1` — CI is allowed to be air-gapped, and a suite that fails
 * because a laptop is on a plane is a suite people learn to ignore.
 */

const LIVE = "is-number";
const TIMEOUT = 30_000;

async function online(): Promise<boolean> {
  if (process.env.NO_NETWORK_TESTS === "1") return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${DEFAULT_REGISTRY}/${LIVE}`, {
      method: "HEAD",
      headers: { accept: ABBREVIATED_ACCEPT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

const reachable = await online();
const when = reachable ? describe : describe.skip;

when("the real npm registry", () => {
  it(
    "answers a browser with CORS open on metadata and tarball, and the tarball installs and requires",
    async () => {
      const client = new RegistryClient();
      expect(client.registry).toBe(DEFAULT_REGISTRY);

      // 1. The metadata, with the abbreviated accept header, and CORS open on the response.
      const metadata = await fetch(client.packumentUrl(LIVE), { headers: { accept: ABBREVIATED_ACCEPT } });
      expect(metadata.ok).toBe(true);
      expect(metadata.headers.get("access-control-allow-origin")).toBe("*");
      expect(metadata.headers.get("content-type")).toContain("json");

      const version = await client.resolveVersion(LIVE, "^7.0.0");
      expect(version.name).toBe(LIVE);
      expect(version.version).toMatch(/^7\./);
      expect(version.dist.tarball).toContain("registry.npmjs.org");
      expect(version.dist.integrity ?? version.dist.shasum).toBeTruthy();

      // 2. The tarball, from the same origin, also CORS-open — this is the half people assume fails.
      const tarball = await fetch(version.dist.tarball);
      expect(tarball.ok).toBe(true);
      expect(tarball.headers.get("access-control-allow-origin")).toBe("*");
      const bytes = new Uint8Array(await tarball.arrayBuffer());
      expect(bytes[0]).toBe(0x1f);
      expect(bytes[1]).toBe(0x8b);
      if (version.dist.integrity) await verifyIntegrity(bytes, version.dist.integrity);

      // 3. End to end: install it into a MemoryFs and require it through the loader.
      const fs = new MemoryFs();
      await fs.writeFile(
        "proj/package.json",
        new TextEncoder().encode(JSON.stringify({ name: "live", version: "1.0.0", dependencies: { [LIVE]: "^7.0.0" } })),
      );
      await fs.writeFile("proj/app.js", new TextEncoder().encode(`module.exports = require("${LIVE}")(42);`));
      const result = await install(fs, "proj");
      expect(result.installed.map((i) => i.name)).toEqual([LIVE]);
      expect(result.skippedScripts).toEqual([]);
      expect(result.nativePackages).toEqual([]);

      const files: Record<string, Uint8Array> = {};
      for await (const entry of fs.walk("proj")) files[`/${entry.path.slice("proj/".length)}`] = await fs.readFile(entry.path);
      const loader = createLoader({ fs: snapshotLoaderFs(files), cwd: "/", root: "/" });
      expect(loader.require("/app.js")).toBe(true);
    },
    TIMEOUT,
  );
});

describe("the offline guard", () => {
  it("is a real check, so an air-gapped machine skips rather than fails", () => {
    expect(typeof reachable).toBe("boolean");
  });
});
