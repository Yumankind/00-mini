import { describe, expect, it } from "vitest";
import {
  BOOT_STEP_ORDER,
  bootFailed,
  bootProgress,
  initialBootSteps,
  setStep,
  shellReady,
  stepLine,
} from "../src/lib/boot-steps.js";
import {
  BRAIN_PEERS,
  BYOK_VENDORS,
  byokProblem,
  byokSecretName,
  overblastTokenProblem,
  peer,
  peerIdForProvider,
} from "../src/lib/brains.js";
import { ancestors, buildTree, formatSize, isTextPath, sortTree } from "../src/lib/files-tree.js";
import {
  IDLE_LOCK_MS,
  canCarrySecrets,
  emptyVaultState,
  idleLine,
  idleRemainingMs,
  kindLabel,
  maskSecretValue,
  passwordProblem,
  shouldLock,
  travelNote,
  unlockPrompt,
} from "../src/lib/vault-policy.js";

describe("the boot sequence", () => {
  it("is §4.1's four milestones, in order", () => {
    expect(BOOT_STEP_ORDER).toEqual(["shell", "workspace", "runtime", "local-ai"]);
    expect(initialBootSteps().every((s) => s.state === "pending")).toBe(true);
  });

  it("moves one step without touching the others", () => {
    const next = setStep(initialBootSteps(), "workspace", "active", "mounting");
    expect(next.find((s) => s.id === "workspace")).toMatchObject({ state: "active", detail: "mounting" });
    expect(next.filter((s) => s.state === "pending")).toHaveLength(3);
  });

  it("counts a failed step as settled, because it will not finish later", () => {
    let steps = initialBootSteps();
    expect(bootProgress(steps)).toBe(0);
    steps = setStep(steps, "shell", "done");
    steps = setStep(steps, "local-ai", "failed", "unsupported here");
    expect(bootProgress(steps)).toBe(0.5);
  });

  it("opens the shell without the local brain — retrieval works with no model at all", () => {
    let steps = initialBootSteps();
    for (const id of ["shell", "workspace", "runtime"] as const) steps = setStep(steps, id, "done");
    expect(shellReady(steps)).toBe(true);
    expect(bootFailed(steps)).toBeNull();
    expect(shellReady(setStep(steps, "local-ai", "failed"))).toBe(true);
  });

  it("does not open the shell when a blocking step failed", () => {
    const steps = setStep(initialBootSteps(), "workspace", "failed", "no OPFS");
    expect(shellReady(steps)).toBe(false);
    expect(bootFailed(steps)).toMatchObject({ id: "workspace" });
  });

  it("prints a step as `Label · detail`, or just the label", () => {
    expect(stepLine({ id: "local-ai", label: "Local AI", state: "done", detail: "ready" })).toBe("Local AI · ready");
    expect(stepLine({ id: "shell", label: "Shell", state: "done" })).toBe("Shell");
  });
});

describe("the brain peers", () => {
  it("is §6.1's table, levels and all, with §8.4's Mac last", () => {
    expect(BRAIN_PEERS.map((p) => p.id)).toEqual(["local", "sponsored", "overblast", "byok", "remote"]);
    expect(BRAIN_PEERS.map((p) => p.level)).toEqual([0, 1, 2, 3, 4]);
    // `remote` needs the relay, so offline takes it away exactly as it takes the other three.
    expect(BRAIN_PEERS.filter((p) => !p.remote).map((p) => p.id)).toEqual(["local"]);
  });

  it("names no price, plan or tier — the worker owns those", () => {
    const text = JSON.stringify(BRAIN_PEERS).toLowerCase();
    for (const forbidden of ["$", "€", "per month", "free tier", "pro plan"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("maps a contract provider id back to its card", () => {
    expect(peerIdForProvider("byok:anthropic")).toBe("byok");
    expect(peerIdForProvider("local")).toBe("local");
    expect(peerIdForProvider("remote-mac")).toBe("remote");
    expect(peerIdForProvider("nonsense")).toBeNull();
    expect(peer("overblast").level).toBe(2);
    expect(() => peer("nope" as never)).toThrow();
  });

  it("offers vendors as labels only — @00/agent-models owns the endpoints", () => {
    expect(BYOK_VENDORS.map((v) => v.id)).toEqual(["openai", "anthropic", "openrouter", "custom"]);
    for (const v of BYOK_VENDORS) expect(Object.keys(v)).toEqual(["id", "label"]);
  });

  it("names a BYOK secret per vendor, so two keys never collide", () => {
    expect(byokSecretName("openai")).toBe("byok.openai.apiKey");
    expect(byokSecretName("custom")).not.toBe(byokSecretName("openai"));
  });

  it("refuses an incomplete BYOK card by naming what is missing", () => {
    expect(byokProblem("", "k", "")).toMatch(/vendor/);
    expect(byokProblem("openai", "  ", "")).toMatch(/Paste the key/);
    expect(byokProblem("custom", "k", "http://example.com")).toMatch(/https/);
    expect(byokProblem("custom", "k", "https://example.com/v1")).toBeNull();
    expect(byokProblem("openai", "sk-live", "")).toBeNull();
  });

  it("checks an Overblast token is the device kind", () => {
    expect(overblastTokenProblem("")).toMatch(/Paste or mint/);
    expect(overblastTokenProblem("sk-live-abc")).toMatch(/sk-obd/);
    expect(overblastTokenProblem("sk-obd-x")).toMatch(/truncated/);
    expect(overblastTokenProblem("sk-obd-abcdefghijkl.mn")).toBeNull();
  });
});

describe("the files tree", () => {
  const files = [
    { path: "profile.json", stat: { size: 100 } },
    { path: "workspace/AGENTS.md", stat: { size: 200 } },
    { path: "workspace/memory/2026-09-10.md", stat: { size: 50 } },
    { path: "workspace/projects/site/index.html", stat: { size: 400 } },
  ];

  it("folds a flat walk into folders", () => {
    const tree = buildTree(files);
    expect(tree.map((n) => n.name)).toEqual(["workspace", "profile.json"]);
    const workspace = tree[0];
    expect(workspace.kind).toBe("dir");
    expect(workspace.children?.map((n) => n.name)).toEqual(["memory", "projects", "AGENTS.md"]);
  });

  it("rolls sizes up so a folder can say what it costs", () => {
    const tree = buildTree(files);
    expect(tree[0].size).toBe(650);
    expect(tree[0].children?.find((n) => n.name === "projects")?.size).toBe(400);
  });

  it("keeps paths agent-root-relative, which is what every AgentFs call wants", () => {
    const tree = buildTree(files);
    const projects = tree[0].children?.find((n) => n.name === "projects");
    expect(projects?.children?.[0].path).toBe("workspace/projects/site");
  });

  it("sorts folders before files, alphabetically, at every level", () => {
    const sorted = sortTree([
      { name: "b.md", path: "b.md", kind: "file", size: 0 },
      { name: "a.md", path: "a.md", kind: "file", size: 0 },
      { name: "zed", path: "zed", kind: "dir", size: 0, children: [] },
    ]);
    expect(sorted.map((n) => n.name)).toEqual(["zed", "a.md", "b.md"]);
  });

  it("handles an empty walk", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("knows what the read-only viewer can honestly render", () => {
    expect(isTextPath("workspace/AGENTS.md")).toBe(true);
    expect(isTextPath("workspace/.00ignore")).toBe(true);
    expect(isTextPath("sessions/1234_abc.jsonl")).toBe(true);
    expect(isTextPath("workspace/files/photo.png")).toBe(false);
    expect(isTextPath("workspace/files/clip.webm")).toBe(false);
  });

  it("formats a size the way a person reads one", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1024 * 1024 * 5)).toBe("5.0 MB");
    expect(formatSize(1024 * 1024 * 40)).toBe("40 MB");
    expect(formatSize(-1)).toBe("—");
  });

  it("lists every ancestor, so opening a file can reveal it", () => {
    expect(ancestors("workspace/projects/site/index.html")).toEqual([
      "workspace",
      "workspace/projects",
      "workspace/projects/site",
    ]);
    expect(ancestors("profile.json")).toEqual([]);
  });
});

describe("the vault policy", () => {
  const unlocked = { ...emptyVaultState(), exists: true, unlocked: true, kind: "password" as const, lastActivity: 1000 };

  it("states §4.5's thirty minutes once", () => {
    expect(IDLE_LOCK_MS).toBe(30 * 60 * 1000);
  });

  it("locks at the boundary, not a millisecond later", () => {
    expect(shouldLock(unlocked, 1000 + IDLE_LOCK_MS - 1)).toBe(false);
    expect(shouldLock(unlocked, 1000 + IDLE_LOCK_MS)).toBe(true);
  });

  it("never locks something already locked", () => {
    expect(shouldLock({ ...unlocked, unlocked: false }, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(idleRemainingMs({ ...unlocked, unlocked: false }, 0)).toBe(0);
  });

  it("warns only in the last five minutes, so there is no half-hour countdown", () => {
    expect(idleLine(unlocked, 1000)).toBeNull();
    expect(idleLine(unlocked, 1000 + IDLE_LOCK_MS - 4 * 60_000)).toBe("Locks in 4 minutes unless you do something.");
    expect(idleLine(unlocked, 1000 + IDLE_LOCK_MS - 30_000)).toBe("Locks in 1 minute unless you do something.");
    expect(idleLine(unlocked, 1000 + IDLE_LOCK_MS)).toBe("Locked — idle.");
    expect(idleLine({ ...unlocked, unlocked: false }, 0)).toBeNull();
  });

  it("asks the right question for the kind it is", () => {
    expect(unlockPrompt("passkey")).toMatch(/passkey/);
    expect(unlockPrompt("password")).toMatch(/password/);
    expect(unlockPrompt(null)).toMatch(/password/);
    expect(kindLabel("passkey")).toMatch(/this device only/);
    expect(kindLabel(null)).toBe("No vault yet");
  });

  it("says out loud that a passkey vault cannot travel", () => {
    expect(canCarrySecrets("password")).toBe(true);
    expect(canCarrySecrets("passkey")).toBe(false);
    expect(canCarrySecrets(null)).toBe(false);
    expect(travelNote("passkey")).toMatch(/cannot travel/);
    expect(travelNote("password")).toMatch(/carry my secrets/);
    expect(travelNote(null)).toMatch(/No secrets/);
  });

  it("holds the same floor under a vault password as under a bundle passphrase", () => {
    expect(passwordProblem("")).toMatch(/required/);
    expect(passwordProblem("1234567")).toBe("At least 8 characters.");
    expect(passwordProblem("12345678")).toBeNull();
  });

  it("never shows more than the last four characters of a value", () => {
    expect(maskSecretValue("sk-live-abcdefgh")).toBe("••••efgh");
    expect(maskSecretValue("ab")).toBe("••••");
  });
});
