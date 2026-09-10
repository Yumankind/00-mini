import { describe, expect, it } from "vitest";
import { PERMISSIONS_PATH, PermissionManager, type PermissionScope } from "../src/index.js";
import { MemoryFs } from "./memory-fs.js";

const scope = (over: Partial<PermissionScope> = {}): PermissionScope => ({
  tool: "write",
  origin: "https://agent.example",
  workspace: "workspace",
  sessionId: "s1",
  ...over,
});

const yes = async () => ({ allowed: true });
const no = async () => ({ allowed: false });

describe("PermissionManager tiers", () => {
  it("never asks about a `safe` tool", async () => {
    const pm = new PermissionManager(new MemoryFs());
    let asked = 0;
    const outcome = await pm.decide(scope({ tool: "read" }), "safe", async () => {
      asked++;
      return { allowed: true };
    });
    expect(outcome).toEqual({ allowed: true, source: "safe" });
    expect(asked).toBe(0);
  });

  it("asks about a `confirm` tool and carries the answer back", async () => {
    const pm = new PermissionManager(new MemoryFs());
    expect(await pm.decide(scope(), "confirm", yes)).toMatchObject({ allowed: true, source: "asked" });
    expect(await pm.decide(scope(), "confirm", no)).toMatchObject({ allowed: false, source: "asked" });
  });

  it("asks EVERY time about a `high-risk` tool, even when told to remember", async () => {
    const fs = new MemoryFs();
    const pm = new PermissionManager(fs);
    const risky = scope({ tool: "publish" });
    let asked = 0;
    const ask = async () => {
      asked++;
      return { allowed: true, remember: "always" as const };
    };
    for (let i = 0; i < 3; i++) {
      const outcome = await pm.decide(risky, "high-risk", ask);
      expect(outcome).toEqual({ allowed: true, source: "asked", remember: undefined });
    }
    expect(asked).toBe(3);
    expect(pm.list()).toEqual([]);
    expect(fs.readSync(PERMISSIONS_PATH)).toBeUndefined(); // nothing was even written
  });
});

describe("standing answers and their scope", () => {
  it('remember "session" answers again within the session and asks again in the next one', async () => {
    const pm = new PermissionManager(new MemoryFs());
    let asked = 0;
    const ask = async () => {
      asked++;
      return { allowed: true, remember: "session" as const };
    };
    await pm.decide(scope(), "confirm", ask);
    expect(await pm.decide(scope(), "confirm", ask)).toMatchObject({ source: "standing-session", allowed: true });
    expect(asked).toBe(1);

    expect(await pm.decide(scope({ sessionId: "s2" }), "confirm", ask)).toMatchObject({ source: "asked" });
    expect(asked).toBe(2);
  });

  it('remember "always" survives a new manager, because it is on disk', async () => {
    const fs = new MemoryFs();
    const first = new PermissionManager(fs, { now: () => 1234 });
    await first.decide(scope(), "confirm", async () => ({ allowed: true, remember: "always" }));

    const file = JSON.parse(fs.readSync(PERMISSIONS_PATH)!);
    expect(file).toEqual({
      version: 1,
      answers: [
        { tool: "write", origin: "https://agent.example", workspace: "workspace", tier: "confirm", allowed: true, decidedAt: 1234 },
      ],
    });

    const second = new PermissionManager(fs);
    let asked = 0;
    const outcome = await second.decide(scope({ sessionId: "much-later" }), "confirm", async () => {
      asked++;
      return { allowed: true };
    });
    expect(outcome).toMatchObject({ allowed: true, source: "standing-always", remember: "always" });
    expect(asked).toBe(0);
  });

  it("a standing NO is remembered too, and denies without asking", async () => {
    const fs = new MemoryFs();
    const pm = new PermissionManager(fs);
    await pm.decide(scope(), "confirm", async () => ({ allowed: false, remember: "always" }));
    let asked = 0;
    const outcome = await pm.decide(scope({ sessionId: "s9" }), "confirm", async () => {
      asked++;
      return { allowed: true };
    });
    expect(outcome.allowed).toBe(false);
    expect(asked).toBe(0);
  });

  it("the scope is tool × origin × workspace: change any one of them and it asks again", async () => {
    const pm = new PermissionManager(new MemoryFs());
    await pm.decide(scope(), "confirm", async () => ({ allowed: true, remember: "always" }));

    for (const changed of [
      scope({ tool: "edit" }),
      scope({ origin: "https://someone-else.example" }),
      scope({ workspace: "threads-fs/web/42" }),
    ]) {
      let asked = 0;
      await pm.decide(changed, "confirm", async () => {
        asked++;
        return { allowed: true };
      });
      expect(asked, JSON.stringify(changed)).toBe(1);
    }
  });

  it("a session answer beats an older always answer — it is the more recent word", async () => {
    const pm = new PermissionManager(new MemoryFs());
    await pm.decide(scope(), "confirm", async () => ({ allowed: true, remember: "always" }));
    await pm.remember(scope(), "confirm", { allowed: false, remember: "session" });
    expect(pm.standing(scope())).toMatchObject({ allowed: false, source: "standing-session" });
  });

  it("an answer with no `remember` is not stored at all", async () => {
    const fs = new MemoryFs();
    const pm = new PermissionManager(fs);
    await pm.decide(scope(), "confirm", yes);
    expect(pm.list()).toEqual([]);
    expect(pm.standing(scope())).toBeUndefined();
  });

  it("forget() withdraws one standing answer, and endSession() drops that session's", async () => {
    const fs = new MemoryFs();
    const pm = new PermissionManager(fs);
    await pm.decide(scope(), "confirm", async () => ({ allowed: true, remember: "always" }));
    await pm.forget(scope());
    expect(pm.list()).toEqual([]);
    expect(JSON.parse(fs.readSync(PERMISSIONS_PATH)!).answers).toEqual([]);

    await pm.remember(scope(), "confirm", { allowed: true, remember: "session" });
    pm.endSession("s1");
    expect(pm.standing(scope())).toBeUndefined();
  });
});

describe("the permissions file itself", () => {
  it("a missing or corrupt file is an empty book, not a crash", async () => {
    const fs = new MemoryFs({ [PERMISSIONS_PATH]: "{ not json" });
    const pm = new PermissionManager(fs);
    await pm.load();
    expect(pm.list()).toEqual([]);
    expect(await pm.decide(scope(), "confirm", yes)).toMatchObject({ allowed: true });
  });

  it("a high-risk answer someone hand-edited into the file is ignored on load", async () => {
    const fs = new MemoryFs({
      [PERMISSIONS_PATH]: JSON.stringify({
        version: 1,
        answers: [
          { tool: "pay", origin: "https://agent.example", workspace: "workspace", tier: "high-risk", allowed: true, decidedAt: 1 },
          { tool: "write", origin: "https://agent.example", workspace: "workspace", tier: "confirm", allowed: true, decidedAt: 1 },
        ],
      }),
    });
    const pm = new PermissionManager(fs);
    await pm.load();
    expect(pm.list().map((a) => a.tool)).toEqual(["write"]);
  });

  it("lives at the AGENT ROOT, outside the workspace, so no file tool can reach it", () => {
    expect(PERMISSIONS_PATH).toBe("permissions.json");
    expect(PERMISSIONS_PATH.startsWith("workspace/")).toBe(false);
  });
});
