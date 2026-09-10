// INTEROP IS THE POINT OF THIS FILE. A `.00agent` written here is opened by `tar` and by the Mac
// engine, and one written by the engine is opened here — so the tests below deliberately do NOT use
// this package to check this package: they decrypt with node:crypto against the key rule as
// written down, gunzip with node:zlib, list with the system `tar`, and build the engine's side of
// the round trip with `tar -czf` exactly as apps/00d/src/burst-bundle.ts does.

import { afterAll, describe, expect, it } from "vitest";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFs } from "../src/memory-fs.js";
import { NodeDirFs } from "../src/node-dir-fs.js";
import { scaffoldAgent } from "../src/scaffold.js";
import { exportBundle, importBundle, importBundleInto, ignoreMatcherFor, fullModeInclude } from "../src/bundle.js";
import { tarPack } from "../src/tar.js";
import { gzip } from "../src/gzip.js";

const SECRET = "six-word-code-for-this-move";
const utf8 = new TextEncoder();
const text = new TextDecoder();

const temps: string[] = [];
afterAll(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

async function temp(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `agent-fs-${label}-`));
  temps.push(dir);
  return dir;
}

/** The key rule of the container spec, re-derived here on purpose: sha256(utf8(secret + ":enc")). */
function keyFor(secret: string): Buffer {
  return createHash("sha256").update(`${secret}:enc`).digest();
}

function decryptTheEngineWay(bytes: Uint8Array, secret: string): Buffer {
  const raw = Buffer.from(bytes);
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

function encryptTheEngineWay(plain: Buffer, secret: string): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, enc, cipher.getAuthTag()]));
}

async function scaffoldedOnDisk(): Promise<{ fs: NodeDirFs; root: string }> {
  const root = await temp("export");
  const fs = new NodeDirFs(root);
  await scaffoldAgent(fs, { id: "ia-export-1", displayName: "Ada", now: () => new Date("2026-09-10T12:00:00.000Z") });
  await fs.writeFile("workspace/projects/site/index.html", "<h1>hi</h1>");
  await fs.writeFile("workspace/memory/2026-09-10.md", "learned a thing");
  await fs.writeFile("sessions/2026-09-10_abc.jsonl", '{"role":"user"}\n');
  // Ephemeral, every one of them: they must not appear in the archive.
  await fs.writeFile("workspace/tmp/half-download.bin", "junk");
  await fs.writeFile("workspace/projects/site/node_modules/left/index.js", "module.exports={}");
  await fs.writeFile("workspace/docs/index.md", "copied from the repo each session");
  await fs.writeFile("workspace/files/meetings/standup.webm", "audio");
  await fs.writeFile("workspace/run.log", "noise");
  await fs.writeFile("workspace.lock", "1234");
  return { fs, root };
}

describe("exportBundle → the system tar", () => {
  it("produces a gzip tar the system tar lists, with burst.json at the root", async () => {
    const { fs } = await scaffoldedOnDisk();
    const bundle = await exportBundle(fs, { secret: SECRET, host: "browser" });

    const targz = decryptTheEngineWay(bundle, SECRET);
    const stage = await temp("list");
    const file = join(stage, "bundle.tar.gz");
    await writeFile(file, targz);
    const listing = execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).trim().split("\n");

    expect(listing[0]).toBe("burst.json");
    expect(listing).toContain("agent/profile.json");
    expect(listing).toContain("agent/workspace/AGENTS.md");
    expect(listing).toContain("agent/workspace/memory/2026-09-10.md");
    expect(listing).toContain("agent/workspace/projects/site/index.html");
    expect(listing).toContain("agent/sessions/2026-09-10_abc.jsonl");
    // Empty identity folders travel as directory entries, so the far side is not missing folders.
    expect(listing).toContain("agent/workspace/schedules/");
    expect(listing).toContain("agent/workspace/watchers/");
    // The ephemeral class, in full.
    expect(listing.some((l) => l.includes("/tmp/"))).toBe(false);
    expect(listing.some((l) => l.includes("node_modules"))).toBe(false);
    expect(listing.some((l) => l.includes("workspace/docs"))).toBe(false);
    expect(listing.some((l) => l.endsWith(".webm"))).toBe(false);
    expect(listing.some((l) => l.endsWith(".log"))).toBe(false);
    expect(listing).not.toContain("agent/workspace.lock");
  });

  it("extracts with the system tar, long PAX names and all", async () => {
    const { fs } = await scaffoldedOnDisk();
    const long = `workspace/projects/site/${"nested/".repeat(18)}deep-file.md`;
    expect(long.length).toBeGreaterThan(100);
    await fs.writeFile(long, "a name no ustar header can hold");
    const bundle = await exportBundle(fs, { secret: SECRET, host: "browser" });

    const stage = await temp("extract");
    const file = join(stage, "bundle.tar.gz");
    await writeFile(file, decryptTheEngineWay(bundle, SECRET));
    const out = join(stage, "out");
    await mkdir(out, { recursive: true });
    execFileSync("tar", ["-xzf", file, "-C", out]);
    expect((await readFile(join(out, "agent", long))).toString("utf8")).toBe("a name no ustar header can hold");
    expect((await readFile(join(out, "agent", "workspace", "AGENTS.md"))).toString("utf8")).toBe(
      await fs.readText("workspace/AGENTS.md"),
    );
    expect(JSON.parse((await readFile(join(out, "burst.json"))).toString("utf8")).mode).toBe("full");
  });

  it("gunzips with node:zlib and carries the manifest the shared contract describes", async () => {
    const { fs } = await scaffoldedOnDisk();
    const bundle = await exportBundle(fs, {
      secret: SECRET,
      host: "browser",
      createdAt: new Date("2026-09-10T12:34:56.000Z"),
    });
    const tar = gunzipSync(decryptTheEngineWay(bundle, SECRET));
    const at = tar.indexOf(Buffer.from("burst.json"));
    expect(at).toBe(0);
    const size = Number.parseInt(tar.subarray(124, 135).toString("utf8"), 8);
    const manifest = JSON.parse(tar.subarray(512, 512 + size).toString("utf8")) as Record<string, unknown>;
    expect(manifest).toEqual({
      version: 1,
      agentId: "ia-export-1",
      mode: "full",
      createdAt: "2026-09-10T12:34:56.000Z",
      host: "browser",
    });
  });

  it("honours workspace/.00ignore, including a ! that brings a file back", async () => {
    const { fs } = await scaffoldedOnDisk();
    await fs.writeFile("workspace/.00ignore", "# mine\nprojects/site/secret.txt\n!run.log\n");
    await fs.writeFile("workspace/projects/site/secret.txt", "shh");
    const matcher = await ignoreMatcherFor(fs);
    expect(matcher.ignores("projects/site/secret.txt")).toBe(true);
    expect(matcher.ignores("run.log")).toBe(false);
    const include = fullModeInclude(matcher);
    expect(include("workspace/projects/site/secret.txt")).toBe(false);
    expect(include("workspace/run.log")).toBe(true);
    expect(include("workspace/.00ignore")).toBe(true);

    const bundle = await exportBundle(fs, { secret: SECRET, host: "browser" });
    const into = new MemoryFs();
    const { written } = await importBundleInto(into, bundle, { secret: SECRET });
    expect(written).not.toContain("workspace/projects/site/secret.txt");
    expect(written).toContain("workspace/run.log");
    expect(written).toContain("workspace/.00ignore");
  });

  it("takes a caller's include predicate instead of the default", async () => {
    const { fs } = await scaffoldedOnDisk();
    const bundle = await exportBundle(fs, {
      secret: SECRET,
      host: "browser",
      include: (rel) => rel === "profile.json" || rel === "workspace" || rel === "workspace/AGENTS.md",
    });
    const into = new MemoryFs();
    const { written } = await importBundleInto(into, bundle, { secret: SECRET });
    expect(written).toEqual(["profile.json", "workspace/AGENTS.md"]);
  });

  it("refuses to invent an agent id", async () => {
    const empty = new MemoryFs();
    await expect(exportBundle(empty, { secret: SECRET, host: "browser" })).rejects.toThrow(/no readable profile\.json/);
    await expect(exportBundle(empty, { secret: SECRET, host: "browser", agentId: "given" })).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("a bundle built the engine's way → importBundleInto", () => {
  async function engineBundle(secret: string): Promise<{ bytes: Uint8Array; files: Record<string, string> }> {
    const payload = await temp("payload");
    const files: Record<string, string> = {
      "workspace/AGENTS.md": "# Operating instructions for Ada\n",
      "workspace/memory/2026-09-09.md": "a memory\n",
      "workspace/projects/site/index.html": "<h1>hi</h1>\n",
      "profile.json": JSON.stringify({ id: "ia-engine-1", displayName: "Ada" }, null, 2),
    };
    for (const [rel, body] of Object.entries(files)) {
      const dest = join(payload, "agent", rel);
      await mkdir(join(dest, ".."), { recursive: true });
      await writeFile(dest, body);
    }
    await mkdir(join(payload, "agent", "workspace", "watchers"), { recursive: true });
    await writeFile(
      join(payload, "burst.json"),
      JSON.stringify({ version: 1, agentId: "ia-engine-1", mode: "full", createdAt: "2026-09-09T10:00:00.000Z" }, null, 2),
    );
    const targz = join(payload, "..", "engine-bundle.tar.gz");
    execFileSync("tar", ["-czf", targz, "-C", payload, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const bytes = encryptTheEngineWay(await readFile(targz), secret);
    await rm(targz, { force: true });
    return { bytes, files };
  }

  it("round-trips every file byte-exact, manifest included", async () => {
    const { bytes, files } = await engineBundle(SECRET);
    const fs = new MemoryFs();
    const result = await importBundleInto(fs, bytes, { secret: SECRET });
    expect(result.manifest).toEqual({
      version: 1,
      agentId: "ia-engine-1",
      mode: "full",
      createdAt: "2026-09-09T10:00:00.000Z",
    });
    for (const [rel, body] of Object.entries(files)) {
      expect(await fs.readText(rel)).toBe(body);
    }
    expect(result.written.sort()).toEqual(Object.keys(files).sort());
    // The engine's `tar -C payload .` names everything `./…`; the empty folder still arrives.
    expect(result.dirs).toContain("workspace/watchers");
    expect(result.skipped).toEqual([]);
  });

  it("hands the same bytes out of importBundle as a lazy iterable", async () => {
    const { bytes } = await engineBundle(SECRET);
    const { manifest, files } = await importBundle(bytes, { secret: SECRET });
    expect(manifest.agentId).toBe("ia-engine-1");
    const seen: string[] = [];
    for await (const f of files) seen.push(f.path);
    expect(seen).toContain("agent/workspace/AGENTS.md");
    expect(seen).not.toContain("burst.json");
  });

  it("survives a browser → engine-shape → browser round trip", async () => {
    const { fs: source } = await scaffoldedOnDisk();
    const bundle = await exportBundle(source, { secret: SECRET, host: "browser" });
    const landed = new MemoryFs();
    await importBundleInto(landed, bundle, { secret: SECRET });
    const again = await exportBundle(landed, { secret: "another-secret", host: "browser" });
    const final = new MemoryFs();
    await importBundleInto(final, again, { secret: "another-secret" });
    expect(final.snapshot()).toEqual(landed.snapshot());
    expect(await final.readText("workspace/AGENTS.md")).toBe(await source.readText("workspace/AGENTS.md"));
    expect(await final.readText("workspace/projects/site/index.html")).toBe("<h1>hi</h1>");
  });
});

describe("a bundle that should be refused", () => {
  it("fails cleanly on the wrong secret", async () => {
    const { fs } = await scaffoldedOnDisk();
    const bundle = await exportBundle(fs, { secret: SECRET, host: "browser" });
    await expect(importBundle(bundle, { secret: "not-the-code" })).rejects.toMatchObject({ code: "bundle_decrypt_failed" });
    const into = new MemoryFs();
    await expect(importBundleInto(into, bundle, { secret: "not-the-code" })).rejects.toThrow(/wrong secret/);
    expect(into.snapshot()).toEqual([]);
  });

  it("fails cleanly on a truncated file and on an empty secret", async () => {
    await expect(importBundle(new Uint8Array(10), { secret: SECRET })).rejects.toMatchObject({ code: "bundle_too_short" });
    const { fs } = await scaffoldedOnDisk();
    await expect(exportBundle(fs, { secret: "", host: "browser" })).rejects.toMatchObject({ code: "bundle_secret_required" });
  });

  it("refuses a tar entry naming .. or an absolute path", async () => {
    for (const evil of ["../../etc/passwd", "/etc/passwd"]) {
      const tar = tarPack([
        { path: "burst.json", kind: "file", data: utf8.encode(JSON.stringify({ version: 1, agentId: "x", mode: "full", createdAt: "now" })) },
        { path: "agent/ok.txt", kind: "file", data: utf8.encode("ok") },
      ]);
      // Overwrite the SECOND header's name field with the escaping path.
      tar.fill(0, 1024, 1124);
      tar.set(utf8.encode(evil), 1024);
      const bytes = encryptTheEngineWay(Buffer.from(await gzip(tar)), SECRET);
      const fs = new MemoryFs();
      await expect(importBundleInto(fs, bytes, { secret: SECRET })).rejects.toMatchObject({ code: "unsafe_bundle_path" });
      expect(fs.snapshot()).toEqual([]);
    }
  });

  it("refuses a bundle with no manifest, an unreadable one, or an unknown version", async () => {
    const cases: [Uint8Array, RegExp][] = [
      [tarPack([{ path: "agent/x.txt", kind: "file", data: utf8.encode("x") }]), /no burst\.json/],
      [tarPack([{ path: "burst.json", kind: "file", data: utf8.encode("not json") }]), /not JSON/],
      [
        tarPack([{ path: "burst.json", kind: "file", data: utf8.encode(JSON.stringify({ version: 9, agentId: "x", mode: "full" })) }]),
        /unknown bundle version 9/,
      ],
    ];
    for (const [tar, message] of cases) {
      const bytes = encryptTheEngineWay(Buffer.from(await gzip(tar)), SECRET);
      await expect(importBundle(bytes, { secret: SECRET })).rejects.toThrow(message);
    }
  });

  it("refuses a mode this host does not write, and names what it left behind", async () => {
    const manifest = { version: 2, agentId: "x", mode: "session", createdAt: "now" };
    const tar = tarPack([
      { path: "burst.json", kind: "file", data: utf8.encode(JSON.stringify(manifest)) },
      { path: "workspace/AGENTS.md", kind: "file", data: utf8.encode("session payload") },
    ]);
    const bytes = encryptTheEngineWay(Buffer.from(await gzip(tar)), SECRET);
    await expect(importBundleInto(new MemoryFs(), bytes, { secret: SECRET })).rejects.toMatchObject({
      code: "bundle_mode_unsupported",
    });
    const { manifest: read } = await importBundle(bytes, { secret: SECRET });
    expect(read.mode).toBe("session");
  });

  it("drops macOS resource forks a pre-COPYFILE_DISABLE mac hub packed", async () => {
    const tar = tarPack([
      { path: "burst.json", kind: "file", data: utf8.encode(JSON.stringify({ version: 1, agentId: "x", mode: "full", createdAt: "now" })) },
      { path: "agent/workspace/._AGENTS.md", kind: "file", data: utf8.encode("Mac OS X resource fork") },
      { path: "agent/workspace/AGENTS.md", kind: "file", data: utf8.encode("rules") },
      { path: "secrets.json", kind: "file", data: utf8.encode("{}") },
    ]);
    const bytes = encryptTheEngineWay(Buffer.from(await gzip(tar)), SECRET);
    const fs = new MemoryFs();
    const result = await importBundleInto(fs, bytes, { secret: SECRET });
    expect(result.written).toEqual(["workspace/AGENTS.md"]);
    expect(result.skipped).toEqual(["secrets.json"]);
    expect(text.decode(await fs.readFile("workspace/AGENTS.md"))).toBe("rules");
  });
});
