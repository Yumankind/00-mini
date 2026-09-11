/**
 * The QR road's URL half — `parseReceiveLink` / `receiveFromLocation` in src/state/move.ts.
 *
 * THE STAKE IS THE SECRET. The six words in `#code=` are the bundle key, and the rule this app has
 * kept since lib/move.ts was written is that the key is never in a URL. A FRAGMENT is the exception
 * the QR road takes, and it is only defensible while two things hold: a fragment is never sent to a
 * server, and this app takes it out of the address bar (and out of the history entry) the instant it
 * reads it. The second half is code, so it is pinned here — including for a link whose code is
 * malformed, where something shaped like a secret must still not be left lying in the URL.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearReceiveWanted,
  parseReceiveLink,
  prefilledCode,
  receiveFromLocation,
  receiveRequested,
  receiveWanted,
} from "../src/state/move.js";

const CODE = "amber-canyon-pixel-forest-cider-lantern";

beforeEach(() => clearReceiveWanted());

describe("parseReceiveLink", () => {
  it("reads the code out of the fragment and hands back a URL with both halves gone", () => {
    const parsed = parseReceiveLink(`https://0-0.chat/?receive#code=${CODE}`);
    expect(parsed).toEqual({ receive: true, code: CODE, url: "https://0-0.chat/" });
  });

  it("accepts `receive=` with a value, a percent-encoded code, and other query keys beside it", () => {
    const parsed = parseReceiveLink(`https://0-0.chat/app?receive=1&theme=dark#code=${encodeURIComponent(CODE)}`);
    expect(parsed.code).toBe(CODE);
    // Only `receive` is taken out; a person's other query keys are not this function's to delete.
    expect(parsed.url).toBe("https://0-0.chat/app?theme=dark");
  });

  it("strips the link even when the code is not one, so nothing secret-shaped is left in the URL", () => {
    for (const bad of ["", "not-a-code", "one-two-three", `${CODE}-seventh`, "%E0%A4%A"]) {
      const parsed = parseReceiveLink(`https://0-0.chat/?receive#code=${bad}`);
      expect(parsed.receive).toBe(true);
      expect(parsed.code).toBeNull();
      expect(parsed.url).toBe("https://0-0.chat/");
    }
  });

  it("takes an uppercase or padded code as the code it plainly is", () => {
    expect(parseReceiveLink(`https://0-0.chat/?receive#code=${CODE.toUpperCase()}`).code).toBe(CODE);
    expect(parseReceiveLink(`https://0-0.chat/?receive#code=${CODE}%20`).code).toBe(CODE);
  });

  it("leaves a URL that is not a receive link completely alone", () => {
    for (const href of [
      `https://0-0.chat/#code=${CODE}`, // a fragment with no ?receive is not this flow's
      "https://0-0.chat/?other=1#code=x",
      "https://0-0.chat/?receivewell#code=x",
      "not a url at all",
    ]) {
      expect(parseReceiveLink(href)).toEqual({ receive: false, code: null, url: href });
    }
  });

  it("answers the receive request even when the link brought no code at all", () => {
    expect(parseReceiveLink("https://0-0.chat/?receive")).toEqual({
      receive: true,
      code: null,
      url: "https://0-0.chat/",
    });
  });
});

describe("receiveFromLocation", () => {
  /** A `location` and a `history` the size of what the function actually touches. */
  function withLocation(href: string): { href: () => string; replaced: number } {
    const state = { href, replaced: 0 };
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        get href() {
          return state.href;
        },
      },
    });
    Object.defineProperty(globalThis, "history", {
      configurable: true,
      value: {
        state: null,
        replaceState: (_s: unknown, _t: string, url: string) => {
          state.href = url;
          state.replaced++;
        },
      },
    });
    return { href: () => state.href, replaced: state.replaced };
  }

  it("prefills the code, asks for the receive screen, and erases the link from the address bar", () => {
    const page = withLocation(`https://0-0.chat/?receive#code=${CODE}`);
    expect(receiveFromLocation()).toBe(CODE);
    expect(page.href()).toBe("https://0-0.chat/");
    expect(prefilledCode.value).toBe(CODE);
    expect(receiveWanted.value).toBe(true);
    // The shell reads THIS to open the Move pane — `receiveWanted` alone cannot, because its only
    // reader is MovePanel, which is not mounted until the pane is already open.
    expect(receiveRequested.value).toBe(true);
  });

  it("opens the receive screen with an empty field when the code was malformed", () => {
    const page = withLocation("https://0-0.chat/?receive#code=nonsense");
    expect(receiveFromLocation()).toBeNull();
    expect(page.href()).toBe("https://0-0.chat/");
    expect(prefilledCode.value).toBeNull();
    expect(receiveRequested.value).toBe(true);
  });

  it("does nothing at all, and rewrites nothing, for an ordinary visit", () => {
    const page = withLocation("https://0-0.chat/app");
    expect(receiveFromLocation()).toBeNull();
    expect(page.href()).toBe("https://0-0.chat/app");
    expect(receiveRequested.value).toBe(false);
    expect(receiveWanted.value).toBe(false);
  });

  it("keeps nothing once the screen has taken it", () => {
    withLocation(`https://0-0.chat/?receive#code=${CODE}`);
    receiveFromLocation();
    clearReceiveWanted();
    expect(prefilledCode.value).toBeNull();
    expect(receiveRequested.value).toBe(false);
    expect(receiveWanted.value).toBe(false);
  });

  it("answers null where there is no page at all, rather than reaching for a global that is not there", () => {
    Reflect.deleteProperty(globalThis, "location");
    Reflect.deleteProperty(globalThis, "history");
    expect(receiveFromLocation()).toBeNull();
  });
});
