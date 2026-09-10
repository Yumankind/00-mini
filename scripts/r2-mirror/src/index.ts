/**
 * r2-mirror — copy one URL into R2 at the edge, streaming, with a sha256 proof.
 *
 * WHY THIS EXISTS. `wrangler r2 object put` refuses anything over 300 MiB, and the browser-ready
 * LiteRT models (docs/HANDOFF-infinite-agent.md §12.7) run from 250 MB to 6 GB. The Mac that
 * publishes them has less free disk than the largest file, and an S3 multipart client would need a
 * second credential to mint and keep. So the copy happens where the bucket is: this Worker fetches
 * the source, feeds the bytes into an R2 multipart upload in fixed 32 MiB parts (R2 wants every part
 * but the last the same size, ≥ 5 MiB, ≤ 10 000 parts — 6 GB is 192 of them), and hashes the same
 * bytes through `crypto.DigestStream` so the caller learns the sha256 of what actually landed. A
 * mismatch deletes the object; nothing half-right stays public.
 *
 * It is a TOOL, not a product surface: deployed by scripts/publish-litert-models.sh for the length of
 * a publish and deleted after, gated by a per-deploy token, POST only, no listing, no reads. The
 * token is a `--var` at deploy time; there is no way to call this without it.
 *
 * The response streams one progress line per part, so a 6 GB copy is not one silent request that a
 * proxy on the way might give up on.
 */

interface Env {
  BUCKET: R2Bucket;
  MIRROR_TOKEN: string;
}

interface MirrorRequest {
  url: string;
  key: string;
  sha256: string;
  bytes: number;
  contentType?: string;
  /** Full `Authorization` header value for the source (a gated Hub repo). Never logged. */
  auth?: string;
}

const PART_BYTES = 32 * 1024 * 1024;
const MAX_PARTS = 10_000;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/;

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== "POST") return new Response("POST only", { status: 405 });
    const token = req.headers.get("x-mirror-token") ?? "";
    if (!env.MIRROR_TOKEN || token.length !== env.MIRROR_TOKEN.length || token !== env.MIRROR_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }
    let body: MirrorRequest;
    try {
      body = (await req.json()) as MirrorRequest;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const { url, key, sha256, bytes } = body;
    if (typeof url !== "string" || !/^https:\/\/huggingface\.co\//.test(url)) return new Response("url must be a huggingface.co https url", { status: 400 });
    if (typeof key !== "string" || !KEY_RE.test(key) || key.includes("..")) return new Response("bad key", { status: 400 });
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return new Response("bad sha256", { status: 400 });
    if (!Number.isInteger(bytes) || bytes <= 0 || bytes > PART_BYTES * MAX_PARTS) return new Response("bad bytes", { status: 400 });

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const out = writable.getWriter();
    const enc = new TextEncoder();
    const say = (line: string) => out.write(enc.encode(line + "\n")).catch(() => {});

    const work = (async () => {
      let upload: R2MultipartUpload | null = null;
      try {
        const src = await fetch(url, { headers: body.auth ? { authorization: body.auth } : {} });
        if (!src.ok || !src.body) {
          await say(`error source answered ${src.status}`);
          return;
        }
        const declared = Number(src.headers.get("content-length") ?? "0");
        if (declared && declared !== bytes) {
          await say(`error source is ${declared} bytes, expected ${bytes}`);
          return;
        }
        upload = await env.BUCKET.createMultipartUpload(key, {
          httpMetadata: {
            contentType: body.contentType ?? "application/octet-stream",
            cacheControl: "public, max-age=31536000, immutable",
          },
        });
        // No tee(): the upload branch waits on R2 for every part while a hashing branch would run
        // ahead, and the runtime buffers the gap until it gives up ("tee() buffer limit exceeded",
        // seen on the first 2 GB copy). One loop reads each chunk once and hands it to the digest
        // AND the part buffer, so the two consumers can never drift apart.
        const digest = new crypto.DigestStream("SHA-256");
        const hasher = digest.getWriter();

        const parts: R2UploadedPart[] = [];
        const reader = src.body.getReader();
        let buf = new Uint8Array(PART_BYTES);
        let fill = 0;
        let total = 0;
        const flush = async (last: boolean) => {
          if (fill === 0 && !last) return;
          if (fill === 0 && last && parts.length > 0) return;
          const chunk = buf.subarray(0, fill);
          const n = parts.length + 1;
          parts.push(await upload!.uploadPart(n, chunk));
          total += fill;
          fill = 0;
          await say(`part ${n} ${total}/${bytes}`);
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await hasher.write(value);
          let off = 0;
          while (off < value.length) {
            const take = Math.min(PART_BYTES - fill, value.length - off);
            buf.set(value.subarray(off, off + take), fill);
            fill += take;
            off += take;
            if (fill === PART_BYTES) await flush(false);
          }
        }
        await flush(true);
        await hasher.close();
        const got = hex(await digest.digest);
        if (total !== bytes) {
          await upload.abort();
          upload = null;
          await say(`error received ${total} bytes, expected ${bytes}`);
          return;
        }
        if (got !== sha256) {
          await upload.abort();
          upload = null;
          await say(`error sha256 ${got} != ${sha256}`);
          return;
        }
        await upload.complete(parts);
        upload = null;
        await say(`ok ${key} ${total} ${got}`);
      } catch (err) {
        if (upload) await upload.abort().catch(() => {});
        await say(`error ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await out.close().catch(() => {});
      }
    })();

    // The copy outlives the moment the response headers go out; waitUntil is what keeps it running
    // for as long as it takes, whether or not the caller keeps reading the progress lines.
    ctx.waitUntil(work);
    return new Response(readable, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
