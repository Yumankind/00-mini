/**
 * The claim link, read as data — and the two sentences the notifications card is allowed to say.
 *
 * `/?claim=…&nonce=…&origin=…` is opened by a page on SOMEBODY ELSE'S SITE. Everything in it is a
 * stranger's string, and the origin in particular is about to be shown to a person as the site they
 * are handing an agent to and then signed. So it is parsed, not trusted: a scheme that is not http
 * or https, a missing half, a bare word — all of them are `null` here rather than a confirmation
 * screen naming something that is not a website.
 */
import { describe, expect, it } from "vitest";
import { claimRequestFromQuery } from "../src/state/registry.js";
import { decodeVapidKey, pushPossible, pushRefusal, vapidPublicKey } from "../src/registry/push.js";

describe("the claim link", () => {
  it("takes all three halves and normalises the origin the way the worker stores it", () => {
    expect(claimRequestFromQuery("?claim=iaa_abc&nonce=N1&origin=HTTPS%3A%2F%2FShop.Example%2Fadmin%3Fx%3D1")).toEqual({
      appId: "iaa_abc",
      nonce: "N1",
      // Lower-cased, path and query gone: `normaliseOrigin` stores `scheme://host[:port]` and the
      // signature has to be over the string the worker holds.
      origin: "https://shop.example",
    });
  });

  it("keeps a port, because an origin with one is a different origin", () => {
    expect(claimRequestFromQuery("?claim=a&nonce=b&origin=http%3A%2F%2Flocalhost%3A5173")?.origin).toBe("http://localhost:5173");
  });

  it.each([
    ["?nonce=b&origin=https%3A%2F%2Fx.example", "no app id"],
    ["?claim=a&origin=https%3A%2F%2Fx.example", "no nonce"],
    ["?claim=a&nonce=b", "no origin"],
    ["?claim=a&nonce=b&origin=javascript%3Aalert(1)", "a scheme that is not the web"],
    ["?claim=a&nonce=b&origin=shop.example", "a bare word"],
    ["", "nothing at all"],
  ])("refuses %s (%s)", (search) => {
    expect(claimRequestFromQuery(search)).toBeNull();
  });
});

describe("notifications: where the key comes from, and why the button is off", () => {
  it("has no key at all in this build, so the card says so rather than showing a dead control", () => {
    // `undefined` is "no card read, and no env var in this build" — the state every test runs in.
    expect(vapidPublicKey()).toBeNull();
    expect(pushPossible()).toBe(false);
    expect(pushRefusal()).toContain("later worker round");
  });

  it("prefers the app card's key, which is the registry actually being talked to", () => {
    expect(vapidPublicKey("BCardKey-_9w")).toBe("BCardKey-_9w");
    // A subscription is minted AGAINST the key, so the wrong registry's key is worse than none:
    // every row taken under it is unsendable. The one the registry named wins.
    expect(pushRefusal("BCardKey-_9w")).toContain("Home Screen");
  });

  it("treats an explicit `null` on the card as 'this host publishes none', not as 'ask the build'", () => {
    // The worker sends the field with a null rather than omitting it precisely so a loader can tell
    // "no key here" from "old worker" — only the second is allowed to fall back to the env var.
    expect(vapidPublicKey(null)).toBeNull();
    expect(pushPossible(null)).toBe(false);
    expect(pushRefusal(null)).toContain("later worker round");
  });

  it("reads whitespace as unset, on either carrier", () => {
    expect(vapidPublicKey("   ")).toBeNull();
  });

  it("says the iPhone sentence once a key exists, because that is then the only thing missing", () => {
    // Node has a `navigator`, and no `serviceWorker` on it — the same shape as a browser that
    // cannot do Web Push, which on iOS means a tab that was never added to the Home Screen.
    expect(pushRefusal("BCardKey-_9w")).toContain("installed app");
  });

  it("decodes a base64url key into the bytes applicationServerKey wants", () => {
    // 65 bytes is an uncompressed P-256 point, which is what a VAPID public key is.
    const bytes = decodeVapidKey("BOTest-_9w");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(7);
  });

  it("translates `-_` and restores the padding, which plain atob would refuse", () => {
    // `-_8` is base64url for two bytes; as base64 it is `+/8=`, and without the `=` atob throws.
    expect([...decodeVapidKey("-_8")]).toEqual([251, 255]);
  });
});
