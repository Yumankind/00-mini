// tar, both ways — the one format in this package with no library behind it, because the reader on
// the other side is `bsdtar` on a Mac and `tar` in a Debian container, not our code.
//
// So the rules are the interoperable ones, not the convenient ones. WRITE: plain ustar headers,
// with a PAX extended header (`typeflag 'x'`, one `path=` record) whenever a name will not fit the
// 100-byte field — never the GNU longname extension, which bsdtar reads but writes differently, and
// never the split `prefix` field, which is a puzzle every writer solves in its own way. The ustar
// header that follows a PAX one still carries a legal truncated name, so a reader that ignores PAX
// entirely gets a file with a short name rather than an error. READ: ustar, PAX (`x` and `g`), and
// GNU longname (`L`/`K`), because bundles we accept are written by tools we do not control.
//
// The path check lives HERE, in the reader, rather than in whatever calls it: a tar entry naming
// `/etc/…` or `../…` is a directory-traversal attack in a file the person was told was their agent,
// and there must be no path through this package that reads a tar without refusing one.

import { concat, fromUtf8, utf8, utf8Length } from "./bytes.js";
import { failUnsafePath } from "./errors.js";

export const BLOCK = 512;

export interface TarEntry {
  /** Payload-relative, POSIX, no leading `/` and no `..`. */
  path: string;
  kind: "file" | "dir";
  data: Uint8Array;
  /** Seconds since epoch. Defaults to 0 so a bundle of the same tree is byte-identical. */
  mtime?: number;
  mode?: number;
}

const EMPTY = new Uint8Array(0);

// ── Writing ──────────────────────────────────────────────────────────────────────────────────────

function putString(block: Uint8Array, offset: number, len: number, value: string): void {
  const bytes = utf8.encode(value);
  block.set(bytes.subarray(0, len), offset);
}

/** Octal, NUL-terminated, zero-padded — the ustar convention for every numeric field but chksum. */
function putOctal(block: Uint8Array, offset: number, len: number, value: number): void {
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(len - 1, "0");
  putString(block, offset, len, `${text}\0`);
}

function header(opts: { name: string; size: number; typeflag: string; mtime: number; mode: number }): Uint8Array {
  const block = new Uint8Array(BLOCK);
  putString(block, 0, 100, opts.name);
  putOctal(block, 100, 8, opts.mode);
  putOctal(block, 108, 8, 0); // uid — a bundle carries no ownership; the far side is another machine
  putOctal(block, 116, 8, 0); // gid
  putOctal(block, 124, 12, opts.size);
  putOctal(block, 136, 12, opts.mtime);
  block.fill(0x20, 148, 156); // checksum field counts as spaces while the sum is taken
  putString(block, 156, 1, opts.typeflag);
  putString(block, 257, 6, "ustar\0");
  putString(block, 263, 2, "00");
  // uname/gname stay empty: a bundle carries no ownership, and an empty pair keeps the archive
  // byte-identical whoever exported it.
  let sum = 0;
  for (const b of block) sum += b;
  // Six octal digits, NUL, space — the layout GNU tar and bsdtar both accept without complaint.
  putString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function padding(size: number): Uint8Array {
  const rem = size % BLOCK;
  return rem === 0 ? EMPTY : new Uint8Array(BLOCK - rem);
}

/**
 * One PAX record: `"<len> <key>=<value>\n"` where `<len>` counts its own digits. The loop is the
 * standard fixed point — adding the digits can push the length across a power of ten.
 */
export function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  const base = utf8Length(rest);
  let digits = 1;
  for (;;) {
    const total = base + digits;
    if (String(total).length === digits) return `${total}${rest}`;
    digits = String(total).length;
  }
}

function lastSegment(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** ustar's name field is 100 BYTES, so the fallback name is truncated on a byte boundary. */
function truncateName(path: string): string {
  let name = lastSegment(path) || "long-name";
  while (utf8Length(name) > 100) name = name.slice(0, -1);
  return name;
}

/** Pack entries into a tar archive. Entries are written in the order given. */
export function tarPack(entries: TarEntry[]): Uint8Array {
  const out: Uint8Array[] = [];
  for (const e of entries) {
    const isDir = e.kind === "dir";
    const name = isDir ? `${e.path.replace(/\/+$/, "")}/` : e.path;
    const data = isDir ? EMPTY : e.data;
    const mode = e.mode ?? (isDir ? 0o755 : 0o644);
    const mtime = e.mtime ?? 0;
    if (utf8Length(name) > 100) {
      const pax = utf8.encode(paxRecord("path", name));
      out.push(header({ name: `PaxHeaders.0/${truncateName(name)}`, size: pax.byteLength, typeflag: "x", mtime, mode: 0o644 }));
      out.push(pax, padding(pax.byteLength));
      out.push(header({ name: truncateName(name), size: data.byteLength, typeflag: isDir ? "5" : "0", mtime, mode }));
    } else {
      out.push(header({ name, size: data.byteLength, typeflag: isDir ? "5" : "0", mtime, mode }));
    }
    if (data.byteLength > 0) out.push(data, padding(data.byteLength));
  }
  // Two zero blocks end an archive; GNU tar warns about anything shorter.
  out.push(new Uint8Array(BLOCK * 2));
  return concat(out);
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────

function getString(block: Uint8Array, offset: number, len: number): string {
  const raw = block.subarray(offset, offset + len);
  let end = raw.indexOf(0);
  if (end < 0) end = raw.length;
  return fromUtf8.decode(raw.subarray(0, end)).replace(/\s+$/, "");
}

function getNumber(block: Uint8Array, offset: number, len: number): number {
  const raw = block.subarray(offset, offset + len);
  // GNU base-256: the high bit of the first byte marks a binary size (files past 8 GB). Rare, but a
  // silent 0 here would truncate a file instead of failing.
  if ((raw[0] ?? 0) & 0x80) {
    let value = 0;
    for (let i = 1; i < raw.length; i++) value = value * 256 + (raw[i] as number);
    return value;
  }
  const text = getString(block, offset, len).trim();
  const parsed = Number.parseInt(text, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const b of block) if (b !== 0) return false;
  return true;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  const text = fromUtf8.decode(data);
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space < 0) break;
    const len = Number.parseInt(text.slice(at, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(at, at + len);
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(record.indexOf(" ") + 1, eq)] = record.slice(eq + 1).replace(/\n$/, "");
    at += len;
  }
  return out;
}

/**
 * `./a/b` → `a/b`; an absolute path or one containing `..` is REFUSED, never sanitised — a bundle
 * that tried is not a bundle to half-trust.
 */
export function normalizeTarPath(raw: string): string {
  let p = raw.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (p === "." || p === "") return "";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) failUnsafePath(raw);
  const parts = p.replace(/\/+$/, "").split("/");
  if (parts.some((s) => s === "..")) failUnsafePath(raw);
  return parts.filter((s) => s !== "." && s !== "").join("/");
}

export interface ReadTarEntry {
  path: string;
  kind: "file" | "dir";
  data: Uint8Array;
  mtime: number;
}

/**
 * Every entry of an (uncompressed) tar, in order. Directories are yielded too, so an import can
 * recreate the empty ones a scaffolded agent has. Links, devices and fifos are skipped: a link
 * resolves to somebody else's file on the other machine.
 */
export function* readTar(bytes: Uint8Array): Generator<ReadTarEntry> {
  let at = 0;
  let longName: string | undefined;
  let pax: Record<string, string> = {};
  while (at + BLOCK <= bytes.byteLength) {
    const block = bytes.subarray(at, at + BLOCK);
    at += BLOCK;
    if (isZeroBlock(block)) {
      // Two in a row is the end; a single one in the middle is padding some writers emit.
      if (at + BLOCK > bytes.byteLength || isZeroBlock(bytes.subarray(at, at + BLOCK))) return;
      continue;
    }
    const rawName = getString(block, 0, 100);
    const prefix = getString(block, 345, 155);
    let size = getNumber(block, 124, 12);
    const mtime = getNumber(block, 136, 12);
    const typeflag = String.fromCharCode(block[156] ?? 0).trim() || "0";
    // A PAX `size` record describes the entry that FOLLOWS its header, and it has to be applied
    // before the archive is advanced — a file past 8 GB carries 0 in the header's size field, and
    // seeking by that would land the reader in the middle of the data.
    if (pax.size !== undefined && typeflag !== "x" && typeflag !== "X" && typeflag !== "g") {
      const n = Number.parseInt(pax.size, 10);
      if (Number.isFinite(n)) size = n;
    }
    const dataStart = at;
    at += Math.ceil(size / BLOCK) * BLOCK;
    const data = bytes.subarray(dataStart, dataStart + size);

    if (typeflag === "x" || typeflag === "X") {
      pax = { ...pax, ...parsePax(data) };
      continue;
    }
    if (typeflag === "g") continue; // a global header applies to the whole archive; we need none of it
    if (typeflag === "L") {
      longName = fromUtf8.decode(data).replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "K") continue; // GNU long LINK name — links are skipped anyway

    const paxPath = pax.path;
    const name = longName ?? paxPath ?? (prefix ? `${prefix}/${rawName}` : rawName);
    longName = undefined;
    pax = {};

    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5" && typeflag !== "7") continue;
    const path = normalizeTarPath(name);
    if (!path) continue;
    const kind: "file" | "dir" = typeflag === "5" || name.endsWith("/") ? "dir" : "file";
    yield { path, kind, data: kind === "dir" ? EMPTY : bytes.slice(dataStart, dataStart + size), mtime };
  }
}
