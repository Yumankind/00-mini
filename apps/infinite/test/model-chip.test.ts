import { describe, expect, it } from "vitest";
import {
  answeredByLine,
  autoPick,
  autoSentence,
  brainName,
  brainShortName,
  canAnswer,
  chipLabel,
  compactBytes,
  downloadLine,
  noBrainReason,
  pendingDownloadNote,
  runStatusLine,
  type ChipBrain,
} from "../src/lib/model-chip.js";
import type { Readiness } from "../src/lib/readiness.js";

const ready: Readiness = { ready: true };
const downloading = (loadedBytes: number, totalBytes?: number): Readiness => ({
  ready: false,
  reason: "download",
  progress: { loadedBytes, totalBytes },
});

function brain(over: Partial<ChipBrain> = {}): ChipBrain {
  return { id: "local", peer: "local", readiness: ready, ...over };
}

const LOCAL = brain();
const SPONSORED = brain({ id: "sponsored", peer: "sponsored", readiness: { ready: false, reason: "credential" } });
const BYOK = brain({ id: "byok:anthropic", peer: "byok", readiness: ready });

describe("naming the brain that answers next", () => {
  it("says the model, then where it runs", () => {
    expect(brainName(LOCAL, { localModel: "Gemma 4 E2B" })).toBe("Gemma 4 E2B · local");
    expect(brainName(BYOK, { byokVendor: "anthropic" })).toBe("Claude · your key");
    expect(brainName(brain({ id: "overblast", peer: "overblast" }))).toBe("Overblast · credits");
    // "Sponsored · sponsored" says nothing twice.
    expect(brainName(SPONSORED)).toBe("Sponsored");
  });

  it("falls back to the vendor in the provider id when the settings have not said", () => {
    expect(brainShortName(brain({ id: "byok:openai", peer: "byok" }))).toBe("OpenAI");
    expect(brainShortName(brain({ id: "byok:groq", peer: "byok" }))).toBe("groq");
  });

  it("names the local brain generically until a row has been chosen", () => {
    expect(brainName(LOCAL)).toBe("Local AI · local");
  });

  it("names the Mac's own agent, and says where the thinking happens (§8.4)", () => {
    const mac = brain({ id: "remote-mac", peer: "remote" });
    expect(brainName(mac, { macAgent: "Claude Code" })).toBe("Claude Code · via my Mac");
    // Until this browser has been admitted at a Mac there is no name to use, so it says the truth.
    expect(brainName(mac)).toBe("Your Mac's agent · via my Mac");
    expect(brainShortName(mac, { macAgent: "  " })).toBe("Your Mac's agent");
  });
});

describe("the chip's label rule", () => {
  it("shows the chosen brain, matched by provider id or by peer", () => {
    expect(chipLabel({ selected: "byok:anthropic", brains: [LOCAL, BYOK], byokVendor: "anthropic" })).toMatchObject({
      text: "Claude · your key",
      tone: "ok",
      auto: false,
    });
    expect(chipLabel({ selected: "local", brains: [LOCAL, BYOK], localModel: "Gemma 3 270m" }).text).toBe(
      "Gemma 3 270m · local",
    );
  });

  it("names what Automatic would pick, because that is the brain answering next", () => {
    const label = chipLabel({
      selected: "auto",
      brains: [brain({ readiness: downloading(1) }), BYOK],
      byokVendor: "anthropic",
      localModel: "Gemma 4 E2B",
    });
    // The ready one wins over the one still arriving — that is what the router does.
    expect(label).toMatchObject({ text: "Automatic · Claude", tone: "ok", auto: true });
  });

  it("takes a downloading brain when nothing is ready, and says so in its tone", () => {
    const label = chipLabel({ selected: "auto", brains: [brain({ readiness: downloading(1, 2) }), SPONSORED] });
    expect(label).toMatchObject({ text: "Automatic · Local AI", tone: "busy" });
  });

  it("admits when nothing at all can answer", () => {
    expect(chipLabel({ selected: "auto", brains: [SPONSORED] })).toMatchObject({
      text: "Automatic · nothing ready",
      tone: "warn",
      brain: null,
    });
  });

  it("asks rather than invents when the chosen brain is not in the list", () => {
    expect(chipLabel({ selected: "byok:openai", brains: [LOCAL] }).text).toBe("Choose a brain");
  });

  it("says out loud what Automatic would do", () => {
    expect(autoSentence([LOCAL], { localModel: "Gemma 4 E2B" })).toBe("Would use Gemma 4 E2B.");
    expect(autoSentence([brain({ readiness: downloading(1) })])).toBe("Would use Local AI, once it has downloaded.");
    expect(autoSentence([SPONSORED])).toBe("Nothing is ready yet — set up a brain below.");
    expect(autoPick([SPONSORED])).toBeNull();
  });
});

describe("the download line", () => {
  it("writes the shared unit once", () => {
    expect(compactBytes({ loadedBytes: 103_000_000, totalBytes: 250_000_000 })).toBe("103 of 250 MB");
    expect(compactBytes({ loadedBytes: 1_400_000_000, totalBytes: 2_000_000_000 })).toBe("1.4 of 2.0 GB");
  });

  it("keeps both units when they differ, and gives what it has when the host said no total", () => {
    expect(compactBytes({ loadedBytes: 980_000_000, totalBytes: 2_000_000_000 })).toBe("980 MB of 2.0 GB");
    expect(compactBytes({ loadedBytes: 103_000_000 })).toBe("103 MB");
    expect(compactBytes(undefined)).toBeNull();
    expect(compactBytes({ loadedBytes: 0 })).toBeNull();
  });

  it("is the sentence A6 asks for", () => {
    expect(downloadLine("Gemma 3 270m", downloading(103_000_000, 250_000_000))).toBe(
      "Downloading Gemma 3 270m · 41% · 103 of 250 MB",
    );
  });

  it("drops the percent when nothing can honestly compute one", () => {
    expect(downloadLine("Gemma 3 270m", downloading(103_000_000))).toBe("Downloading Gemma 3 270m · 103 MB");
  });

  it("says nothing at all until bytes move — a zero bar is not a download", () => {
    const notHereYet = { ready: false, reason: "download" } as const;
    expect(downloadLine("Gemma 4 E2B", notHereYet)).toBeNull();
    // The chip keeps naming the brain, and this is the note beside it.
    expect(pendingDownloadNote("Gemma 4 E2B", notHereYet)).toBe("Gemma 4 E2B downloads with your next message");
    expect(pendingDownloadNote("Gemma 3 270m", downloading(1, 2))).toBeNull();
  });

  it("inside a run, says the download is starting rather than going blank", () => {
    expect(runStatusLine("Gemma 4 E2B", { ready: false, reason: "download" })).toBe("Downloading Gemma 4 E2B…");
    expect(runStatusLine("Gemma 3 270m", downloading(103_000_000, 250_000_000))).toBe(
      "Downloading Gemma 3 270m · 41% · 103 of 250 MB",
    );
    expect(runStatusLine("Claude", { ready: true })).toBeNull();
  });

  it("has nothing to say about a brain that is ready or that needs a key", () => {
    expect(downloadLine("Gemma 4 E2B", ready)).toBeNull();
    expect(downloadLine("Claude", { ready: false, reason: "credential" })).toBeNull();
  });
});

describe("which brain answered (B20)", () => {
  it("names the peer, the model and the class it answered in", () => {
    expect(answeredByLine({ providerId: "local", model: "gemma3-270m-it-q4_0-web", brainClass: "small" })).toBe(
      "Local AI · gemma3-270m-it-q4_0-web · small",
    );
    expect(answeredByLine({ providerId: "byok:openai", model: "gpt-4o-mini" })).toBe("Your key · openai · gpt-4o-mini");
  });

  it("says only what the event carried", () => {
    expect(answeredByLine({ providerId: "sponsored" })).toBe("Sponsored");
    // A provider whose model id IS its own id would otherwise say the same word twice.
    expect(answeredByLine({ providerId: "overblast", model: "overblast" })).toBe("Overblast");
  });
});

describe("refusing to start a run, by name", () => {
  it("lets a run start on a brain that is merely downloading", () => {
    expect(canAnswer(downloading(1))).toBe(true);
    expect(noBrainReason([brain({ readiness: downloading(1) }), SPONSORED])).toBeNull();
  });

  it("names every peer's own reason when none of them can", () => {
    const reason = noBrainReason(
      [
        brain({ readiness: { ready: false, reason: "unsupported", detail: "no WebGPU in this browser" } }),
        brain({ id: "byok:openai", peer: "byok", readiness: { ready: false, reason: "credential", detail: "needs a key" } }),
        brain({ id: "overblast", peer: "overblast", readiness: { ready: false, reason: "offline" } }),
      ],
      { byokVendor: "openai" },
    );
    expect(reason).toBe(
      "No brain can answer yet — Local AI no WebGPU in this browser, OpenAI needs a key, Overblast is offline.",
    );
  });

  it("says something when there are no brains at all", () => {
    expect(noBrainReason([])).toBe("No brain is set up yet. Choose one to answer with.");
  });
});

describe("the load phase line", () => {
  it("says loading, not a download stuck at 100 %, and draws no bar", async () => {
    const { downloadPercent } = await import("../src/lib/readiness.js");
    const loading = {
      ready: false as const,
      reason: "download" as const,
      detail: "Loading x into the GPU…",
      progress: { loadedBytes: 4, totalBytes: 4, percent: 100, phase: "load" as const },
    };
    expect(downloadLine("Gemma 4 E2B", loading)).toBe("Loading Gemma 4 E2B into the GPU…");
    expect(downloadPercent(loading)).toBeNull();
  });
});


describe("the paused phase line", () => {
  it("says how far a stopped download got and that it resumes", () => {
    const paused = {
      ready: false as const,
      reason: "download" as const,
      detail: "x is 44 % downloaded — it resumes with your next message.",
      progress: { loadedBytes: 4, totalBytes: 9, percent: 44, phase: "paused" as const },
    };
    expect(downloadLine("Gemma 4 E2B", paused)).toBe("Gemma 4 E2B · 44% downloaded · resumes with your next message");
  });
});
