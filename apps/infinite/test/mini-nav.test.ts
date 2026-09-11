/**
 * WHICH SCREEN A URL MEANS. The landing page is the default, so the danger is one-sided: a deep link
 * that lands on marketing copy instead of the flow it was minted for. All three of them are pinned.
 */
import { describe, expect, it } from "vitest";
import { APP_PATH, isAppUrl } from "../src/mini/nav.js";

describe("isAppUrl", () => {
  it("sends the bare origin to the landing page", () => {
    expect(isAppUrl("/")).toBe(false);
    expect(isAppUrl("/?utm_source=x")).toBe(false);
    expect(isAppUrl("/#brains")).toBe(false);
  });

  it("sends /app to the app, with or without a trailing slash", () => {
    expect(isAppUrl(APP_PATH)).toBe(true);
    expect(isAppUrl("/app/")).toBe(true);
    expect(isAppUrl("/app?anything=1")).toBe(true);
  });

  it("keeps the app's own deep links, whatever path they arrive on", () => {
    // §5.4's one-time grant, minted by the admin flow on somebody's site.
    expect(isAppUrl("/?claim=app_123&nonce=abc&origin=https://example.com")).toBe(true);
    // The QR move: `${origin}/?receive#code=<six words>`.
    expect(isAppUrl("/?receive#code=one two three four five six")).toBe(true);
    expect(isAppUrl("/#receive")).toBe(true);
  });

  it("is not fooled by a section that merely mentions one of them", () => {
    expect(isAppUrl("/#receiver")).toBe(false);
    expect(isAppUrl("/#qr")).toBe(false);
  });

  it("answers rather than throwing for something that is not a URL at all", () => {
    expect(isAppUrl("http://[")).toBe(false);
  });
});
