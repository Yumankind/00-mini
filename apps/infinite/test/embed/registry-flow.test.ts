/**
 * The three flows Phase 3 adds to the embed, each tested where its rule actually lives:
 *
 *   · the state this browser keeps per origin + ref (`registry/state.ts`);
 *   · confirm-then-post — nothing leaves the device unasked (`registry/send.ts`);
 *   · the 30-second reply poll, and when it runs (`registry/poll.ts`);
 *   · the admin flow's branches: dev, unclaimed, claimed, ref_registered (`panel/setup-model.ts`).
 *
 * None of these needs a DOM, which is why the loader hands each one to a module that does not have
 * one: the panel is the view, and the rules are here.
 */

import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../embed/src/index/store.js";
import { createRegistryState, registryKey, toState } from "../../embed/src/registry/state.js";
import { createOwnerOutbox, CONFIRM_QUESTION } from "../../embed/src/registry/send.js";
import { POLL_INTERVAL_MS, createReplyPoller } from "../../embed/src/registry/poll.js";
import { describeClaimNonce, describeRegistration } from "../../embed/src/panel/setup-model.js";
import type {
  ClaimNonceResult,
  InboxResult,
  MessagesResult,
  RegisterResult,
  VisitorMessage,
} from "../../embed/src/registry/client.js";

const ORIGIN = "https://shop.example";
const REF = "ia_ktb4qz_abcdefghijkl";

describe("what this browser remembers about this app (§5.3)", () => {
  it("persists under origin + ref, and reads back what it wrote", async () => {
    const store = new MemoryStore();
    const state = createRegistryState({ store, origin: ORIGIN, ref: REF, now: () => 1000 });
    expect((await state.read()).appId).toBeNull();

    await state.write({ appId: "iaa_shop", status: "unclaimed", claimNonce: "n1" });
    expect(state.current().at).toBe(1000);
    expect(await store.keys("registry:")).toEqual([registryKey(ORIGIN, REF)]);

    const second = createRegistryState({ store, origin: ORIGIN, ref: REF });
    const read = await second.read();
    expect(read.appId).toBe("iaa_shop");
    expect(read.claimNonce).toBe("n1");
    expect(read.deviceId).toBeNull();
  });

  it("keeps two sites apart, because a device is a customer and never a person", async () => {
    const store = new MemoryStore();
    const here = createRegistryState({ store, origin: ORIGIN, ref: REF });
    const there = createRegistryState({ store, origin: "https://other.example", ref: REF });
    await here.write({ appId: "iaa_shop", deviceId: "iad_here" });
    await there.write({ appId: "iaa_other", deviceId: "iad_there" });
    expect((await here.read()).deviceId).toBe("iad_here");
    expect((await there.read()).deviceId).toBe("iad_there");
  });

  it("re-types whatever was in storage, and treats nonsense as nothing known", () => {
    expect(toState(null).appId).toBeNull();
    expect(toState("a string").status).toBeNull();
    expect(
      toState({ appId: "not-an-app-id", status: "president", deviceId: "iad_ok", hasPublicBundle: "yes", claimOrigin: "shop.example" }),
    ).toEqual({
      appId: null,
      status: null,
      claimNonce: null,
      // A claim origin goes into a link and is then signed, so a bare word is nothing known.
      claimOrigin: null,
      deviceId: "iad_ok",
      originStanding: "unknown",
      hasPublicBundle: false,
      at: 0,
    });
    expect(toState({ claimOrigin: "https://shop.example" }).claimOrigin).toBe("https://shop.example");
  });

  it("forgets on demand", async () => {
    const store = new MemoryStore();
    const state = createRegistryState({ store, origin: ORIGIN, ref: REF });
    await state.write({ appId: "iaa_shop" });
    await state.clear();
    expect(state.current().appId).toBeNull();
    expect(await store.keys("registry:")).toEqual([]);
  });
});

describe("confirm, then post (§5.6)", () => {
  const posted = (): { calls: unknown[]; post: (i: unknown) => Promise<InboxResult> } => {
    const calls: unknown[] = [];
    return {
      calls,
      post: async (input) => {
        calls.push(input);
        return { ok: true, mid: "iam_1", createdAt: "t0" };
      },
    };
  };

  it("asks with the visitor's own words, then posts", async () => {
    const sink = posted();
    const asked: { question: string; detail: string }[] = [];
    const outbox = createOwnerOutbox({
      post: sink.post,
      confirm: async (question, detail) => {
        asked.push({ question, detail });
        return true;
      },
    });
    const permission = await outbox.askPermission({ name: "send_to_owner", args: { text: "call me back" } });
    expect(permission.allowed).toBe(true);
    expect(asked[0]).toEqual({ question: CONFIRM_QUESTION, detail: "call me back" });
    expect(sink.calls, "the question is asked BEFORE anything is posted").toEqual([]);

    const sent = await outbox.send("lead", "call me back", "a@b.c");
    expect(sent.ok).toBe(true);
    expect(sink.calls).toEqual([{ kind: "lead", text: "call me back", contact: "a@b.c" }]);
    // Asked once, for one message: the permission gate's yes is what `send` spends.
    expect(asked).toHaveLength(1);
  });

  it("posts nothing when the visitor says no", async () => {
    const sink = posted();
    const outbox = createOwnerOutbox({ post: sink.post, confirm: async () => false });
    expect((await outbox.askPermission({ name: "send_to_owner", args: { text: "no thanks" } })).allowed).toBe(false);
    const sent = await outbox.send("message", "no thanks");
    expect(sent).toEqual({ ok: false, message: "Nothing was sent." });
    expect(sink.calls).toEqual([]);
  });

  it("asks again for text nobody confirmed, so no path reaches the wire silently", async () => {
    const sink = posted();
    let asks = 0;
    const outbox = createOwnerOutbox({
      post: sink.post,
      confirm: async () => {
        asks += 1;
        return true;
      },
    });
    await outbox.send("message", "straight to send");
    expect(asks).toBe(1);
    // A yes is spent when it is used: the same words sent twice are asked twice.
    await outbox.send("message", "straight to send");
    expect(asks).toBe(2);
    expect(sink.calls).toHaveLength(2);
  });

  it("answers no for every tool that is not send_to_owner, and for an empty message", async () => {
    const sink = posted();
    const outbox = createOwnerOutbox({ post: sink.post, confirm: async () => true });
    expect((await outbox.askPermission({ name: "page_open", args: {} })).allowed).toBe(false);
    expect((await outbox.askPermission({ name: "send_to_owner", args: { text: "   " } })).allowed).toBe(false);
    expect(await outbox.send("message", "  ")).toEqual({ ok: false, message: "There was nothing to send." });
    expect(sink.calls).toEqual([]);
  });

  it("hands the registry's refusal back untouched, and starts nothing", async () => {
    const started: string[] = [];
    const outbox = createOwnerOutbox({
      post: async () => ({ ok: false, code: "inbox_full", message: "This agent’s mailbox is full." }),
      confirm: async () => true,
      onSent: (mid) => started.push(mid),
    });
    const sent = await outbox.send("message", "hello");
    expect(sent).toEqual({ ok: false, message: "This agent’s mailbox is full." });
    expect(started).toEqual([]);
  });

  it("reads an unknown kind as a message rather than refusing the visitor's words", async () => {
    const sink = posted();
    const outbox = createOwnerOutbox({ post: sink.post, confirm: async () => true });
    await outbox.send("URGENT", "hello");
    expect((sink.calls[0] as { kind: string }).kind).toBe("message");
  });
});

describe("the reply poll (§5.6)", () => {
  const message = (mid: string, reply: string | null): VisitorMessage => ({
    mid,
    kind: "message",
    text: "hello",
    createdAt: "t0",
    reply,
    repliedAt: reply ? "t1" : null,
  });

  it("polls on the plan's 30-second cadence, and only while it is running", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const poller = createReplyPoller({
        poll: async (): Promise<MessagesResult> => {
          polls += 1;
          return { ok: true, messages: [] };
        },
        onReply: () => {},
      });
      expect(POLL_INTERVAL_MS).toBe(30_000);

      poller.start();
      // Nothing on the way in: the caller has just done whatever prompted this.
      expect(polls).toBe(0);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(polls).toBe(0);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(polls).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(polls).toBe(2);

      poller.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(polls).toBe(2);
      expect(poller.running()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts once, however many times it is asked to", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const poller = createReplyPoller({
        poll: async () => {
          polls += 1;
          return { ok: true, messages: [] };
        },
        onReply: () => {},
      });
      poller.start();
      poller.start();
      poller.start();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(polls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows each reply once, oldest first, and never an unanswered item", async () => {
    const shown: string[] = [];
    let round = 0;
    const poller = createReplyPoller({
      // The worker answers newest-first; a conversation reads the other way.
      poll: async (): Promise<MessagesResult> =>
        round++ === 0
          ? { ok: true, messages: [message("iam_2", "second"), message("iam_1", "first"), message("iam_0", null)] }
          : { ok: true, messages: [message("iam_2", "second"), message("iam_1", "first"), message("iam_0", "third")] },
      onReply: (m) => shown.push(m.reply ?? ""),
    });
    await poller.tick();
    expect(shown).toEqual(["first", "second"]);
    await poller.tick();
    expect(shown).toEqual(["first", "second", "third"]);
    expect(poller.seen()).toEqual(["iam_1", "iam_2", "iam_0"]);
  });

  it("says a refusal once, not twice a minute", async () => {
    const said: string[] = [];
    const poller = createReplyPoller({
      poll: async (): Promise<MessagesResult> => ({ ok: false, code: "network", message: "The registry could not be reached." }),
      onReply: () => {},
      onRefusal: (code) => said.push(code),
    });
    await poller.tick();
    await poller.tick();
    await poller.tick();
    expect(said).toEqual(["network"]);
  });
});

describe("the admin flow's branches (§5.3, §5.4)", () => {
  const ok = (status: "dev" | "unclaimed" | "claimed"): RegisterResult => ({
    ok: true,
    appId: "iaa_shop",
    status,
    claimNonce: status === "dev" ? null : "n1",
    originStanding: "allowed",
    fresh: true,
  });
  const CLAIM = "https://infinite.test/?claim=iaa_shop&nonce=n1&origin=https%3A%2F%2Fshop.example";

  it("says dev mode on a local origin, and offers a claim code it has not got", () => {
    const view = describeRegistration(ok("dev"), null);
    expect(view.state).toBe("dev");
    expect(view.detail).toContain("development app");
    expect(view.action).toBeNull();
    // A dev app has not been claimed either, and the worker answers it a code like any other.
    expect(view.reissue).toBe(true);
  });

  it("offers the ONE button that opens the owned agent, when unclaimed", () => {
    const view = describeRegistration(ok("unclaimed"), CLAIM);
    expect(view.state).toBe("unclaimed");
    expect(view.action).toEqual({ label: "Claim it in your agent", url: CLAIM });
    // A browser that HOLDS a code is not offered another: a second would replace this one.
    expect(view.reissue).toBe(false);
  });

  it("says where the claim link went, and offers a fresh one, when this browser is not the one that registered", () => {
    const registered: RegisterResult = { ok: true, appId: "iaa_shop", status: "unclaimed", claimNonce: null, originStanding: "allowed", fresh: false };
    const view = describeRegistration(registered, null);
    expect(view.state).toBe("unclaimed");
    expect(view.action).toBeNull();
    expect(view.detail).toContain("browser that first registered");
    expect(view.reissue).toBe(true);
  });

  it("says claimed, and stops asking", () => {
    const view = describeRegistration(ok("claimed"), CLAIM);
    expect(view.state).toBe("claimed");
    expect(view.action).toBeNull();
    expect(view.reissue).toBe(false);
  });

  it("shows the requested state when another site holds the ref", () => {
    const view = describeRegistration(
      { ok: false, code: "ref_registered", message: "already registered", appId: "iaa_other" },
      null,
    );
    expect(view.state).toBe("requested");
    expect(view.detail).toContain("requested");
    expect(view.action).toBeNull();
  });

  it("says 'not connected yet' rather than showing a spinner that cannot end", () => {
    const view = describeRegistration({ ok: false, code: "not_connected", message: "no registry" }, null);
    expect(view.state).toBe("refused");
    expect(view.headline).toBe("Not connected yet");
  });

  it("asks for the agent key when the snippet carries none", () => {
    const view = describeRegistration({ ok: false, code: "no_link_pub", message: "no key" }, null);
    expect(view.headline).toContain("agent key");
  });

  it("turns the address cap into hours a person can act on", () => {
    const view = describeRegistration(
      { ok: false, code: "ip_limited", message: "This address has already registered an agent today.", retryAfter: 86400 },
      null,
    );
    expect(view.detail).toContain("24 hour");
  });

  it("shows any other refusal in the registry's own words", () => {
    const view = describeRegistration({ ok: false, code: "unexpected", message: "The moon is wrong." }, null);
    expect(view.state).toBe("refused");
    expect(view.detail).toBe("The moon is wrong.");
    expect(view.reissue).toBe(false);
  });
});

describe("the re-issued claim code (§5.4)", () => {
  const CLAIM = "https://infinite.test/?claim=iaa_shop&nonce=fresh-1&origin=https%3A%2F%2Fshop.example";
  const issued: ClaimNonceResult = {
    ok: true,
    appId: "iaa_shop",
    status: "unclaimed",
    claimNonce: "fresh-1",
    origin: "https://shop.example",
  };

  it("shows the button, and warns that an older link has just died", () => {
    const view = describeClaimNonce(issued, CLAIM);
    expect(view.state).toBe("unclaimed");
    expect(view.action).toEqual({ label: "Claim it in your agent", url: CLAIM });
    // The worker keeps ONE nonce per app, so re-issuing is not free: a link already sent stops
    // verifying, and a person who has one open in another tab needs telling.
    expect(view.detail).toContain("replaces any earlier claim link");
    expect(view.reissue).toBe(false);
  });

  it("shows no button when the code arrived but no link could be built", () => {
    const view = describeClaimNonce(issued, null);
    expect(view.action).toBeNull();
    expect(view.reissue).toBe(false);
  });

  it("reads `already_claimed` as the job being done, not as an error", () => {
    const view = describeClaimNonce({ ok: false, code: "already_claimed", message: "already claimed" }, null);
    expect(view.state).toBe("claimed");
    expect(view.action).toBeNull();
    expect(view.reissue).toBe(false);
  });

  it("sends an origin the agent does not answer to the owner's panel, which is the only door", () => {
    const view = describeClaimNonce({ ok: false, code: "origin_not_allowed", message: "not allowed" }, null);
    expect(view.state).toBe("refused");
    expect(view.headline).toContain("not on the agent's list");
    expect(view.detail).toContain("owner's panel");
    expect(view.reissue).toBe(false);
  });

  it("turns the address cap into minutes, and keeps the button for when they pass", () => {
    const view = describeClaimNonce(
      { ok: false, code: "rate_limited", message: "Five claim codes an hour from one address.", retryAfter: 900 },
      null,
    );
    expect(view.state).toBe("refused");
    expect(view.detail).toContain("15 minute(s)");
    expect(view.reissue).toBe(true);
  });

  it("shows any other refusal in the registry's own words, and lets them try again", () => {
    const view = describeClaimNonce({ ok: false, code: "network", message: "The registry could not be reached." }, null);
    expect(view.state).toBe("refused");
    expect(view.detail).toBe("The registry could not be reached.");
    expect(view.reissue).toBe(true);
  });
});
