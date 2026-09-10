import { describe, expect, it } from "vitest";
import {
  headerLine,
  initialNetState,
  isRemoteProvider,
  netReducer,
  offlineCapabilities,
  remoteBlockedReason,
} from "../src/lib/offline.js";

describe("the offline reducer", () => {
  it("takes its first reading as the transition", () => {
    expect(initialNetState(true, 1000)).toEqual({ online: true, changedAt: 1000 });
    expect(initialNetState(false, 1000)).toEqual({ online: false, changedAt: 1000 });
  });

  it("moves `changedAt` on a real flip", () => {
    const start = initialNetState(true, 1000);
    const dropped = netReducer(start, { type: "offline", at: 2000 });
    expect(dropped).toEqual({ online: false, changedAt: 2000 });
    expect(netReducer(dropped, { type: "online", at: 3000 })).toEqual({ online: true, changedAt: 3000 });
  });

  it("ignores a repeat, because browsers fire `online` more than once per reconnection", () => {
    const start = initialNetState(true, 1000);
    const again = netReducer(start, { type: "online", at: 5000 });
    expect(again).toBe(start);
    expect(again.changedAt).toBe(1000);
  });

  it("ignores a repeated offline too", () => {
    const down = initialNetState(false, 1000);
    expect(netReducer(down, { type: "offline", at: 9000 })).toBe(down);
  });

  it("says §4.4's header line, verbatim", () => {
    expect(headerLine({ online: false, changedAt: 0 })).toBe("Offline · local agent available");
    expect(headerLine({ online: true, changedAt: 0 })).toBe("Online");
  });

  it("knows which peers need a connection", () => {
    expect(isRemoteProvider("local")).toBe(false);
    expect(isRemoteProvider("sponsored")).toBe(true);
    expect(isRemoteProvider("overblast")).toBe(true);
    expect(isRemoteProvider("byok:anthropic")).toBe(true);
  });

  it("greys a remote card with one line, and never the local one", () => {
    const off = { online: false, changedAt: 0 };
    expect(remoteBlockedReason("sponsored", off)).toBe("Needs a connection — your local agent keeps working.");
    expect(remoteBlockedReason("local", off)).toBeNull();
  });

  it("takes nothing away while online", () => {
    const on = { online: true, changedAt: 0 };
    for (const id of ["local", "sponsored", "overblast", "byok:openai"]) {
      expect(remoteBlockedReason(id, on)).toBeNull();
    }
  });

  it("names what offline keeps rather than what it loses", () => {
    expect(offlineCapabilities()).toMatch(/local brain/);
  });
});
