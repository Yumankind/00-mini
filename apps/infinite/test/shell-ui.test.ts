import { beforeEach, describe, expect, it } from "vitest";
import { activityLabel, activityState, familyOf, foldActivity, formatMs, type ToolRow } from "../src/lib/activity.js";
import { rankItems, stepIndex, subsequenceScore } from "../src/lib/palette.js";
import {
  attachmentPath,
  fitWithin,
  safeFileName,
  visionNote,
  withAttachments,
  MAX_EDGE,
} from "../src/lib/attachments.js";
import { groupLabel, groupSessions, matchSessions, type SessionRow } from "../src/state/sessions.js";
import {
  resetLayout,
  setSidebarRail,
  sidebarRail,
  toggleSidebarRail,
  toggleWorkspace,
  workspaceOpen,
  WORKSPACE_PANES,
} from "../src/state/layout.js";
import { emptyConversation, pushUser } from "../src/lib/conversation.js";

/**
 * The pure halves of the 2026-09-11 shell: what an activity card is called, what ⌘K matches, where
 * an attached picture goes, and how the thread list is grouped. Everything here was split out of a
 * component on purpose — a node runner can pin all four, and a browser is needed for none of them.
 */

function tool(name: string, over: Partial<ToolRow> = {}): ToolRow {
  return { kind: "tool", id: `r${name}`, name, calls: 1, running: 0, failed: 0, ms: 0, ...over };
}

describe("the activity card's name", () => {
  it("puts a tool in its family, git by prefix", () => {
    expect(familyOf("read")).toBe("read");
    expect(familyOf("git_commit")).toBe("git");
    expect(familyOf("something_new")).toBe("other");
  });

  it("says what was done, with the count and the right noun", () => {
    expect(activityLabel([tool("read", { calls: 3 })])).toBe("Read 3 files");
    expect(activityLabel([tool("read")])).toBe("Read 1 file");
    expect(activityLabel([tool("grep")])).toBe("Searched the workspace");
    expect(activityLabel([tool("write"), tool("edit")])).toBe("Edited 2 files");
    expect(activityLabel([tool("bash")])).toBe("Ran 1 command");
    expect(activityLabel([tool("http_get")])).toBe("Fetched 1 page");
    expect(activityLabel([tool("git_status")])).toBe("Worked with Git");
    expect(activityLabel([tool("remember")])).toBe("Wrote to its memory");
  });

  it("falls back to the tool's own name when nothing is known about it", () => {
    expect(activityLabel([tool("teleport")])).toBe("teleport");
    expect(activityLabel([tool("teleport", { calls: 2 })])).toBe("teleport ×2");
  });

  it("counts the families when a run mixes them", () => {
    expect(activityLabel([tool("read"), tool("bash")])).toBe("Worked on 2 things");
  });

  it("is running while anything runs, failed if anything failed", () => {
    expect(activityState([tool("read", { running: 1 }), tool("bash", { failed: 1 })])).toBe("running");
    expect(activityState([tool("read"), tool("bash", { failed: 1 })])).toBe("failed");
    expect(activityState([tool("read")])).toBe("done");
  });
});

describe("folding the thread's rows", () => {
  it("turns each run of consecutive tool rows into one card and leaves the rest alone", () => {
    const state = pushUser(emptyConversation(), "hello");
    const rows = [
      ...state.rows,
      tool("read", { id: "r2", ms: 30 }),
      tool("grep", { id: "r3", ms: 12 }),
      { kind: "agent" as const, id: "r4", text: "done", streaming: false },
      tool("bash", { id: "r5", ms: 400 }),
    ];
    const folded = foldActivity(rows);
    expect(folded.map((row) => row.kind)).toEqual(["user", "activity", "agent", "activity"]);
    const first = folded[1]!;
    expect(first.kind === "activity" && first.tools).toHaveLength(2);
    expect(first.kind === "activity" && first.ms).toBe(42);
    // The card keeps the first row's identity, so it does not close itself as the run grows.
    expect(first.id).toBe("ar2");
  });

  it("returns the rows untouched when there are no tools at all", () => {
    const rows = pushUser(emptyConversation(), "hi").rows;
    expect(foldActivity(rows)).toEqual(rows);
  });

  it("reads a duration at a glance", () => {
    expect(formatMs(240)).toBe("240ms");
    expect(formatMs(1400)).toBe("1.4s");
    expect(formatMs(95_000)).toBe("1m 35s");
  });
});

describe("the command palette's matching", () => {
  const items = [
    { id: "a", label: "New thread", section: "Thread" },
    { id: "b", label: "Show the workspace", section: "Workspace" },
    { id: "c", label: "workspace/site/index.html", section: "File" },
  ];

  it("matches letters in order, not only substrings", () => {
    expect(subsequenceScore("Show the workspace", "wsp")).not.toBeNull();
    expect(subsequenceScore("Show the workspace", "zzz")).toBeNull();
    expect(subsequenceScore("anything", "")).toBe(0);
  });

  it("ranks a real substring above a scattered match", () => {
    const ranked = rankItems(items, "index");
    expect(ranked[0]!.id).toBe("c");
  });

  it("keeps the curated order when nothing has been typed", () => {
    expect(rankItems(items, "  ").map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("can match on the section as well as the label", () => {
    expect(rankItems(items, "thread").map((i) => i.id)).toContain("a");
  });

  it("runs the cursor round the list rather than off its end", () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});

describe("attaching a picture", () => {
  it("fits inside the long edge without stretching a smaller picture", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: MAX_EDGE, height: 1176 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(0, 0)).toEqual({ width: 0, height: 0 });
  });

  it("makes a name a filesystem will take", () => {
    expect(safeFileName("a photo (1).PNG")).toBe("a-photo-1.PNG");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("")).toBe("image.jpg");
  });

  it("stamps the path so two pastes do not overwrite one another", () => {
    const path = attachmentPath("shot.png", Date.UTC(2026, 8, 11, 9, 30, 0));
    expect(path).toBe("workspace/uploads/2026-09-11T09-30-00-shot.png");
  });

  it("names the paths in the person's own message, above what they typed", () => {
    const message = withAttachments("what is this?", ["workspace/uploads/a.jpg"]);
    expect(message).toContain("workspace/uploads/a.jpg");
    expect(message).toContain("`read`");
    expect(message.endsWith("what is this?")).toBe(true);
    expect(withAttachments("only text", [])).toBe("only text");
  });

  it("warns only when the brain is KNOWN not to see pictures", () => {
    expect(visionNote("Gemma 3 270m", false)).toContain("cannot see pictures");
    expect(visionNote("Claude", true)).toBeNull();
    expect(visionNote("Claude", null)).toBeNull();
  });
});

describe("the thread list's grouping", () => {
  const now = Date.UTC(2026, 8, 11, 12, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  const rows: SessionRow[] = [
    { id: "1", title: "Landing page", updatedAt: now - 60_000 },
    { id: "2", title: "Yesterday's chat", updatedAt: now - day },
    { id: "3", title: "Old one", updatedAt: now - 9 * day },
  ];

  it("names the three groups", () => {
    expect(groupLabel(now, now)).toBe("Today");
    expect(groupLabel(now - day, now)).toBe("Yesterday");
    expect(groupLabel(now - 9 * day, now)).toBe("Earlier");
  });

  it("groups newest first and drops the empty groups", () => {
    const groups = groupSessions(rows, now);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Earlier"]);
    expect(groupSessions([rows[0]!], now).map((g) => g.label)).toEqual(["Today"]);
    expect(groupSessions([], now)).toEqual([]);
  });

  it("filters on every word of the query", () => {
    expect(matchSessions(rows, "landing").map((r) => r.id)).toEqual(["1"]);
    expect(matchSessions(rows, "old one").map((r) => r.id)).toEqual(["3"]);
    expect(matchSessions(rows, "")).toHaveLength(3);
    expect(matchSessions(rows, "nothing here")).toHaveLength(0);
  });
});

describe("the shell's two remembered switches", () => {
  beforeEach(() => resetLayout());

  it("the workspace panel is the power flag under its new name", () => {
    expect(workspaceOpen.value).toBe(false);
    toggleWorkspace();
    expect(workspaceOpen.value).toBe(true);
  });

  it("the sidebar narrows to its rail and back", () => {
    expect(sidebarRail.value).toBe(false);
    toggleSidebarRail();
    expect(sidebarRail.value).toBe(true);
    setSidebarRail(false);
    expect(sidebarRail.value).toBe(false);
  });

  it("the workspace's tabs are the panes without the thread", () => {
    expect(WORKSPACE_PANES.map((p) => p.id)).toEqual(["files", "editor", "preview", "git", "terminal"]);
  });
});
