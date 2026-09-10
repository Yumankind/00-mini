import { beforeEach, describe, expect, it } from "vitest";
import {
  allowAlways,
  allowOnce,
  askPermission,
  current,
  pending,
  refuse,
  refuseAll,
  resetApprovals,
  waiting,
} from "../src/state/approvals.js";
import { applyNetEvent, blockedReason, net, netHeadline, online, setOnline } from "../src/state/offline.js";
import { dayLabel } from "../src/state/sessions.js";

/**
 * The stores are Vue refs, which is why they can be tested in a node runner at all: `ref`/`computed`
 * are @vue/reactivity and need no DOM. Anything in a store that DOES need a document lives behind a
 * `start*()` the app calls at mount and a test never does — that boundary is what keeps this rig at
 * `environment: "node"` (packages/web-vue/vitest.config.ts explains the same rule at length).
 */

describe("the approvals queue", () => {
  beforeEach(() => resetApprovals());

  it("holds the loop until someone answers", async () => {
    const decision = askPermission({ name: "write", tier: "confirm", args: { path: "a.md" } });
    expect(waiting.value).toBe(1);
    expect(current.value).toMatchObject({ name: "write", tier: "confirm" });
    allowOnce(current.value!.id);
    await expect(decision).resolves.toEqual({ allowed: true });
    expect(waiting.value).toBe(0);
  });

  it("carries `always` back to the runtime, which is what persists it", async () => {
    const decision = askPermission({ name: "bash", tier: "high-risk", args: {} });
    allowAlways(current.value!.id);
    await expect(decision).resolves.toEqual({ allowed: true, remember: "always" });
  });

  it("refuses without a `remember`, so a no is not made permanent by accident", async () => {
    const decision = askPermission({ name: "write", tier: "confirm", args: {} });
    refuse(current.value!.id);
    await expect(decision).resolves.toEqual({ allowed: false });
  });

  it("queues a second request behind the first instead of swapping the dialog", async () => {
    const first = askPermission({ name: "write", tier: "confirm", args: { n: 1 } });
    const second = askPermission({ name: "write", tier: "confirm", args: { n: 2 } });
    expect(waiting.value).toBe(2);
    expect(current.value!.args).toEqual({ n: 1 });

    allowOnce(current.value!.id);
    await expect(first).resolves.toEqual({ allowed: true });
    expect(current.value!.args).toEqual({ n: 2 });
    refuse(current.value!.id);
    await expect(second).resolves.toEqual({ allowed: false });
  });

  it("answers every waiter when the shell goes away, or the loop hangs forever", async () => {
    const a = askPermission({ name: "write", tier: "confirm", args: {} });
    const b = askPermission({ name: "bash", tier: "high-risk", args: {} });
    refuseAll();
    await expect(Promise.all([a, b])).resolves.toEqual([{ allowed: false }, { allowed: false }]);
    expect(pending.value).toHaveLength(0);
  });

  it("ignores an answer for a request that is already gone", async () => {
    const decision = askPermission({ name: "write", tier: "confirm", args: {} });
    const id = current.value!.id;
    allowOnce(id);
    await decision;
    expect(() => allowOnce(id)).not.toThrow();
    expect(waiting.value).toBe(0);
  });
});

describe("the offline store", () => {
  beforeEach(() => setOnline(true, 0));

  it("wraps the reducer, repeats and all", () => {
    applyNetEvent({ type: "offline", at: 100 });
    expect(online.value).toBe(false);
    expect(net.value.changedAt).toBe(100);
    applyNetEvent({ type: "offline", at: 200 });
    expect(net.value.changedAt).toBe(100);
  });

  it("drives the header line and the remote cards from one state", () => {
    expect(netHeadline.value).toBe("Online");
    expect(blockedReason("overblast")).toBeNull();
    applyNetEvent({ type: "offline", at: 1 });
    expect(netHeadline.value).toBe("Offline · local agent available");
    expect(blockedReason("overblast")).toMatch(/Needs a connection/);
    expect(blockedReason("local")).toBeNull();
  });
});

describe("the sessions store's day label", () => {
  const noon = new Date("2026-09-10T12:00:00Z").getTime();

  it("names today and yesterday rather than dating them", () => {
    expect(dayLabel(noon, noon)).toBe("Today");
    expect(dayLabel(noon - 24 * 60 * 60 * 1000, noon)).toBe("Yesterday");
  });

  it("dates anything older", () => {
    expect(dayLabel(noon - 8 * 24 * 60 * 60 * 1000, noon)).not.toMatch(/Today|Yesterday/);
  });
});
