// THE SERVICE WORKER CAN RECEIVE A PUSH — gap audit B15, docs/HANDOFF-infinite-agent.md §4.6, §5.7.
//
// A subscription was being taken and no `push` handler existed, so the first notification a browser
// delivered would have shown nothing — and a browser that catches a `userVisibleOnly` subscription
// showing nothing REVOKES it. The two decisions that can actually be wrong (a payload becomes a
// notification; a click becomes a url) are pure and are tested here; the plumbing that cannot be
// imported in node (`showNotification`, `matchAll`, `focus`, `openWindow`) is checked as source text,
// because the substitution that joins the two halves is a build step and a rename would be silent.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PUSH_DEFAULT_PATH,
  PUSH_FALLBACK_BODY,
  PUSH_FALLBACK_TITLE,
  clickTarget,
  clientToFocus,
  notificationFor,
  readPushPayload,
} from "../src/lib/push-notification.js";

const ORIGIN = "https://infinite-site.powerhouse.workers.dev";

/** Exactly what moltworker's `buildInboxNotification` sends (worker/src/infinite/push-send.ts). */
const REAL_PAYLOAD = JSON.stringify({
  kind: "inbox",
  appId: "app_abc123",
  count: 3,
  title: "3 new messages on shop.example",
  body: "Open your agent to read them.",
  url: "/?app=app_abc123",
});

describe("a payload becomes a notification", () => {
  it("shows the sender's own words", () => {
    const plan = notificationFor(REAL_PAYLOAD);
    expect(plan.title).toBe("3 new messages on shop.example");
    expect(plan.options.body).toBe("Open your agent to read them.");
    expect(plan.options.data.url).toBe("/?app=app_abc123");
    expect(plan.options.data.appId).toBe("app_abc123");
  });

  it("collapses onto one live notification per app, without buzzing again", () => {
    const first = notificationFor(REAL_PAYLOAD);
    const second = notificationFor(JSON.stringify({ kind: "inbox", appId: "app_abc123", count: 5, title: "5 new" }));
    const other = notificationFor(JSON.stringify({ kind: "inbox", appId: "app_other", title: "1 new" }));
    expect(second.options.tag).toBe(first.options.tag);
    expect(other.options.tag).not.toBe(first.options.tag);
    expect(first.options.renotify).toBe(false);
  });

  it("still shows something for an empty, unparseable or foreign payload", () => {
    for (const raw of ["", null, undefined, "not json", "[1,2,3]", "{}"]) {
      const plan = notificationFor(raw);
      expect(plan.title).toBe(PUSH_FALLBACK_TITLE);
      expect(plan.options.body).toBe(PUSH_FALLBACK_BODY);
      expect(plan.options.data.url).toBe(PUSH_DEFAULT_PATH);
      // The tag must still be a string, or two unreadable pushes stack up on top of each other.
      expect(plan.options.tag.length).toBeGreaterThan(0);
    }
  });

  it("reads a payload without ever throwing", () => {
    expect(readPushPayload("{bad")).toEqual({});
    expect(readPushPayload(JSON.stringify({ count: 2 }))).toEqual({ count: 2 });
  });
});

describe("a click becomes a url", () => {
  it("resolves the sender's relative url against this origin", () => {
    expect(clickTarget({ url: "/?app=app_abc123" }, ORIGIN)).toBe(`${ORIGIN}/?app=app_abc123`);
  });

  it("falls back to the shell when there is nothing to go on", () => {
    expect(clickTarget(undefined, ORIGIN)).toBe(`${ORIGIN}/`);
    expect(clickTarget({}, ORIGIN)).toBe(`${ORIGIN}/`);
    expect(clickTarget({ url: "   " }, ORIGIN)).toBe(`${ORIGIN}/`);
  });

  it("never leaves this origin", () => {
    // The payload is sealed end to end and cannot normally be tampered with — but a notification is a
    // click whose destination the person did not choose, so an absolute url elsewhere is dropped.
    expect(clickTarget({ url: "https://evil.example/steal" }, ORIGIN)).toBe(`${ORIGIN}/`);
    expect(clickTarget({ url: "javascript:alert(1)" }, ORIGIN)).toBe(`${ORIGIN}/`);
  });
});

describe("which window to focus", () => {
  const target = `${ORIGIN}/?app=app_abc123`;

  it("prefers the tab already on that page", () => {
    expect(clientToFocus([`${ORIGIN}/`, target], target)).toBe(1);
  });

  it("takes any tab on this origin, because the shell routes itself", () => {
    expect(clientToFocus([`${ORIGIN}/files`], target)).toBe(0);
  });

  it("opens a new one when nothing of ours is open", () => {
    expect(clientToFocus([], target)).toBe(-1);
    expect(clientToFocus(["https://elsewhere.example/"], target)).toBe(-1);
    expect(clientToFocus(["not a url"], target)).toBe(-1);
  });
});

describe("the worker source", () => {
  const sw = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");

  it("handles both events and keeps the shell precache", () => {
    expect(sw).toContain('self.addEventListener("push"');
    expect(sw).toContain('self.addEventListener("notificationclick"');
    // Untouched by this work, and the reason the app is offline-capable at all.
    expect(sw).toContain('self.addEventListener("install"');
    expect(sw).toContain('self.addEventListener("fetch"');
    expect(sw).toContain('"__PRECACHE__"');
  });

  it("calls the functions the build inlines, and carries the marker that inlines them", () => {
    expect(sw).toContain("//__PUSH_LIB__");
    for (const name of ["notificationFor", "clickTarget", "clientToFocus"]) {
      expect(sw, `sw.js no longer calls ${name}`).toContain(`${name}(`);
    }
  });
});

// ── The built worker, run ─────────────────────────────────────────────────────────────────────────
//
// The two halves above are pure and the source checks are text; what neither can catch is the JOIN —
// a substitution that produced something the browser cannot parse, or handlers wired to the wrong
// name. So the build's own `inlinePushLib` is imported and run over the real `public/sw.js`, and the
// result is executed in a fake worker global with the payload moltworker actually sends. This is the
// closest a node test gets to a browser receiving a push.

describe("the substituted worker", () => {
  const swSource = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
  const libFile = fileURLToPath(new URL("../src/lib/push-notification.ts", import.meta.url));

  interface Shown {
    title: string;
    options: { body: string; tag: string; data: { url: string } };
  }

  async function runWorker(): Promise<{
    push(payload: string): Promise<Shown[]>;
    click(data: unknown, openUrls: string[]): Promise<string[]>;
  }> {
    const { inlinePushLib } = await import("../vite.config.js");
    const code = await inlinePushLib(swSource, libFile);
    const handlers: Record<string, (event: never) => void> = {};
    const shown: Shown[] = [];
    const did: string[] = [];
    let clients: { url: string; focus(): Promise<void>; navigate(url: string): Promise<void> }[] = [];
    const fakeSelf = {
      addEventListener: (type: string, handler: (event: never) => void) => (handlers[type] = handler),
      registration: { showNotification: (title: string, options: Shown["options"]) => shown.push({ title, options }) },
      location: { origin: ORIGIN },
      clients: {
        matchAll: async () => clients,
        openWindow: async (url: string) => did.push(`open:${url}`),
        claim: async () => undefined,
      },
      skipWaiting: async () => undefined,
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("self", "caches", "clients", "console", code)(fakeSelf, {}, fakeSelf.clients, console);

    const drain = async (fn: (wait: (p: Promise<unknown>) => void) => void): Promise<void> => {
      const waits: Promise<unknown>[] = [];
      fn((p) => waits.push(p));
      await Promise.all(waits);
    };

    return {
      async push(payload) {
        shown.length = 0;
        await drain((wait) => {
          (handlers.push as unknown as (e: unknown) => void)({ data: { text: () => payload }, waitUntil: wait });
        });
        return shown;
      },
      async click(data, openUrls) {
        did.length = 0;
        clients = openUrls.map((url) => ({
          url,
          focus: async () => void did.push(`focus:${url}`),
          navigate: async (to: string) => void did.push(`navigate:${to}`),
        }));
        await drain((wait) => {
          (handlers.notificationclick as unknown as (e: unknown) => void)({
            notification: { close: () => undefined, data },
            waitUntil: wait,
          });
        });
        return did;
      },
    };
  }

  it("shows the worker's notification, and falls back when there is no payload", async () => {
    const worker = await runWorker();
    const [real] = await worker.push(REAL_PAYLOAD);
    expect(real.title).toBe("3 new messages on shop.example");
    expect(real.options.data.url).toBe("/?app=app_abc123");
    const [empty] = await worker.push("");
    expect(empty.title).toBe(PUSH_FALLBACK_TITLE);
  });

  it("focuses an open tab and routes it, or opens a window when there is none", async () => {
    const worker = await runWorker();
    expect(await worker.click({ url: "/?app=app_abc123" }, [`${ORIGIN}/`])).toEqual([
      `focus:${ORIGIN}/`,
      `navigate:${ORIGIN}/?app=app_abc123`,
    ]);
    expect(await worker.click({ url: "/?app=app_abc123" }, [])).toEqual([`open:${ORIGIN}/?app=app_abc123`]);
  });
}, 20_000);
