// THE ROAD OUT OF THE TAB, PINNED AT THE PLUMBING (§14 of docs/HANDOFF-infinite-agent.md).
//
// What a test in this package CAN prove about remote git is the wiring: that the four operations
// reach the injected http client at all, that every smart-HTTP call is rewritten onto the caller's
// `corsProxy` in the shape isomorphic-git spells (`<corsProxy>/<host>/<path>`, query kept), and that
// the wrapper's own headers ride along — which is how the browser's signature reaches the companion.
//
// What it deliberately does NOT prove is a real clone: answering `git-upload-pack` needs a pack file
// and a side-band protocol, and a fake one would test the fake. So the client answers 404 and the
// assertion is on the REQUEST — the last thing this package controls before the bytes leave.

import { describe, expect, it } from "vitest";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import { MemoryFs } from "../src/memory-fs.js";
import { cloneSummary, createGitOps, fetchSummary, pullSummary, pushSummary } from "../src/git-ops.js";
import { gitAdd, gitClone, gitCommit, gitFetch, gitInit, gitPull, gitPush, gitRemotes } from "../src/git.js";

const REPO = "workspace/projects/app";
const CORS_PROXY = "http://127.0.0.1:4600/api/companion/git";
const HEADERS = { "x-00-dev": "abc123", "x-00-sig": "sig" };

interface Recorder {
  http: HttpClient;
  calls: GitHttpRequest[];
}

/** An `HttpClient` that records and refuses. `statusCode` is what every call answers. */
function recorder(statusCode = 404): Recorder {
  const calls: GitHttpRequest[] = [];
  const http: HttpClient = {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      calls.push(req);
      return {
        url: req.url,
        method: req.method ?? "GET",
        statusCode,
        statusMessage: statusCode === 404 ? "Not Found" : "Bad",
        body: [new Uint8Array()][Symbol.iterator]() as unknown as AsyncIterableIterator<Uint8Array>,
        headers: {},
      };
    },
  };
  return { http, calls };
}

async function repoWithCommit(): Promise<MemoryFs> {
  const fs = new MemoryFs();
  await gitInit(fs, REPO);
  await fs.writeFile(`${REPO}/a.txt`, "one\n");
  await gitAdd(fs, REPO, ".");
  await gitCommit(fs, REPO, { message: "first", timestamp: 1_757_500_000_000 });
  return fs;
}

describe("the injected remote", () => {
  it("sends a clone's first call to <corsProxy>/<host>/<path>, query intact", async () => {
    const fs = new MemoryFs();
    const { http, calls } = recorder();
    await expect(
      gitClone(fs, REPO, { url: "https://github.com/owner/repo.git", remote: { http, corsProxy: CORS_PROXY } }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `${CORS_PROXY}/github.com/owner/repo.git/info/refs?service=git-upload-pack`,
    );
    expect(calls[0].method).toBe("GET");
  });

  it("carries the wrapper's headers on the request — the browser's signature rides here", async () => {
    const fs = new MemoryFs();
    const { http, calls } = recorder();
    await expect(
      gitClone(fs, REPO, {
        url: "https://github.com/owner/repo.git",
        remote: { http, corsProxy: CORS_PROXY, headers: HEADERS },
      }),
    ).rejects.toThrow();
    expect(calls[0].headers).toMatchObject(HEADERS);
  });

  it("asks for git-receive-pack on a push and git-upload-pack on a fetch", async () => {
    const fs = await repoWithCommit();
    const push = recorder();
    await expect(
      gitPush(fs, REPO, { url: "https://gitlab.com/o/r.git", remote: { http: push.http, corsProxy: CORS_PROXY } }),
    ).rejects.toThrow();
    expect(push.calls[0].url).toBe(`${CORS_PROXY}/gitlab.com/o/r.git/info/refs?service=git-receive-pack`);

    const fetched = recorder();
    await expect(
      gitFetch(fs, REPO, { url: "https://gitlab.com/o/r.git", remote: { http: fetched.http, corsProxy: CORS_PROXY } }),
    ).rejects.toThrow();
    expect(fetched.calls[0].url).toBe(`${CORS_PROXY}/gitlab.com/o/r.git/info/refs?service=git-upload-pack`);
  });

  it("pulls through the same road, and a pull needs no author from the caller", async () => {
    const fs = await repoWithCommit();
    const { http, calls } = recorder();
    await expect(
      gitPull(fs, REPO, { url: "https://codeberg.org/o/r.git", remote: { http, corsProxy: CORS_PROXY } }),
    ).rejects.toThrow();
    expect(calls[0].url).toBe(`${CORS_PROXY}/codeberg.org/o/r.git/info/refs?service=git-upload-pack`);
  });

  it("takes a branch, a remote name and an author through to the call", async () => {
    // The optional arguments are passed as plain fields (isomorphic-git's own destructuring defaults
    // take the absent ones), so what a test can show is that naming them changes nothing about the
    // road: same proxy, same service, still refused by the fake.
    const fs = await repoWithCommit();
    const { http, calls } = recorder();
    await expect(
      gitPull(fs, REPO, {
        url: "https://bitbucket.org/o/r.git",
        remote: { http, corsProxy: CORS_PROXY },
        remoteName: "upstream",
        branch: "main",
        author: { name: "A", email: "a@b.c" },
      }),
    ).rejects.toThrow();
    expect(calls[0].url).toBe(`${CORS_PROXY}/bitbucket.org/o/r.git/info/refs?service=git-upload-pack`);
  });

  it("lists the remotes a repository knows", async () => {
    const fs = await repoWithCommit();
    expect(await gitRemotes(fs, REPO)).toEqual([]);
  });
});

describe("createGitOps with a remote", () => {
  it("dials the same client the caller handed in, through the same proxy", async () => {
    const fs = new MemoryFs();
    const { http, calls } = recorder();
    const ops = createGitOps(fs, "workspace", { remote: { http, corsProxy: CORS_PROXY, headers: HEADERS } });
    await expect(
      ops.gitClone({ url: "https://github.com/owner/repo.git", dir: "workspace/projects/repo" }),
    ).rejects.toThrow();
    expect(calls[0].url).toBe(`${CORS_PROXY}/github.com/owner/repo.git/info/refs?service=git-upload-pack`);
    expect(calls[0].headers).toMatchObject(HEADERS);
  });

  it("keeps containment on the remote methods too — a clone outside the workspace is refused", async () => {
    const { http } = recorder();
    const ops = createGitOps(new MemoryFs(), "workspace", { remote: { http, corsProxy: CORS_PROXY } });
    await expect(ops.gitClone({ url: "https://github.com/o/r.git", dir: "sessions/r" })).rejects.toMatchObject({
      code: "git_outside_workspace",
    });
    await expect(ops.gitPush({ dir: "../elsewhere" })).rejects.toBeTruthy();
  });

  it("reads the road at CALL time, so a companion that arrives mid-session is used", async () => {
    // The host that wires this holds ONE ops object for the life of the tab (the git tools were
    // built with it), and the companion comes and goes. So the object it was constructed with is
    // mutated rather than rebuilt, and the next call must take the new road.
    const fs = new MemoryFs();
    const late = recorder();
    const options: Parameters<typeof createGitOps>[2] = {};
    const ops = createGitOps(fs, "workspace", options);
    await expect(ops.gitFetch({ dir: "workspace/projects/app" })).rejects.toMatchObject({
      code: "git_remote_not_available",
    });
    options.remote = { http: late.http, corsProxy: CORS_PROXY };
    await expect(
      ops.gitClone({ url: "https://github.com/o/r.git", dir: "workspace/projects/r" }),
    ).rejects.toThrow();
    expect(late.calls[0].url).toBe(`${CORS_PROXY}/github.com/o/r.git/info/refs?service=git-upload-pack`);
  });
});

describe("what a remote operation says", () => {
  it("names a push the far side refused, which resolves rather than throwing", () => {
    expect(pushSummary({ ok: true, refs: { "refs/heads/main": { ok: true } } }, "origin", "main")).toBe(
      "Pushed main to origin.",
    );
    expect(
      pushSummary({ ok: false, refs: { "refs/heads/main": { ok: false, error: "non-fast-forward" } } }, "origin"),
    ).toBe("origin refused the push — refs/heads/main: non-fast-forward");
    // A ref that failed without saying why, and a call-level error, both still produce a sentence.
    expect(pushSummary({ error: "auth required", refs: { "refs/heads/x": { ok: false } } }, "upstream")).toBe(
      "upstream refused the push — auth required; refs/heads/x: refused",
    );
    expect(pushSummary({}, "origin")).toBe("Pushed the current branch to origin.");
  });

  it("says when a fetch moved nothing, and shortens the head when it did", () => {
    expect(fetchSummary("0123456789abcdef0123456789abcdef01234567", "origin", "main")).toBe(
      "Fetched origin/main — 0123456.",
    );
    expect(fetchSummary(null, "origin")).toBe("Fetched origin; nothing new.");
  });

  it("names where a clone landed and what a pull landed on", () => {
    expect(cloneSummary("https://github.com/o/r.git", "workspace/projects/r", "main")).toBe(
      "Cloned https://github.com/o/r.git into workspace/projects/r on branch main.",
    );
    expect(cloneSummary("https://github.com/o/r.git", "workspace/projects/r", null)).toBe(
      "Cloned https://github.com/o/r.git into workspace/projects/r.",
    );
    expect(pullSummary("origin", "main", "main", "https://github.com/o/r.git")).toBe(
      "Pulled origin/main into main (https://github.com/o/r.git).",
    );
    expect(pullSummary("origin", undefined, null)).toBe("Pulled origin into HEAD.");
  });
});
