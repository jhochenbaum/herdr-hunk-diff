import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.js";
import { handleEvent, parseEvent } from "../src/events.js";
import { ReviewIndex } from "../src/index-store.js";
import { dispatch } from "../src/runtime.js";

function harness(over: Record<string, any> = {}) {
  const index = new ReviewIndex(mkdtempSync(join(tmpdir(), "rtrip-")));
  const herdr = {
    notify: vi.fn(),
    promptAgent: vi.fn(() => true),
    openPane: vi.fn(() => "w1:p7"),
    closePane: vi.fn(() => true),
  };
  const hunk = {
    listComments: vi.fn(async () => [
      { noteId: "c1", filePath: "src/a.ts", newRange: [3, 3], body: "Fix" },
    ]),
    removeComment: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}),
  };

  const runtime = (ctx: Record<string, any>, cfg = DEFAULTS) => {
    const target = { worktree: "/wt/x", mode: "working" as const };
    return {
      cfg,
      ctx,
      pluginRoot: "/plugin",
      stateDir: mkdtempSync(join(tmpdir(), "rtrip-state-")),
      index,
      herdr,
      hunk,
      target,
      targetFor: (mode?: string, ref?: string) =>
        mode === undefined ? target : { ...target, mode, ref },
      ...over,
    } as any;
  };

  const eventDeps = {
    cfg: DEFAULTS,
    index,
    herdr,
    worktreeForPane: () => "/wt/x",
    reloadReview: (worktree: string) =>
      hunk.reload(worktree, { worktree, mode: "working" }, DEFAULTS),
  } as any;

  const deliver = (payload: unknown) =>
    handleEvent(parseEvent(undefined, JSON.stringify(payload))!, eventDeps);

  return { index, herdr, hunk, runtime, deliver };
}

const agentDone = {
  event: "pane_agent_status_changed",
  data: {
    type: "pane_agent_status_changed",
    pane_id: "w1:p3",
    workspace_id: "w1",
    agent_status: "idle",
    agent: "reviewer",
  },
};

const paneExited = (pane_id: string) => ({
  event: "pane_exited",
  data: { type: "pane_exited", pane_id },
});

const worktreeRemoved = (path: string) => ({
  event: "worktree_removed",
  data: { type: "worktree_removed", worktree: { path } },
});

describe("agent finishes, human reviews, comments go back to the agent", () => {
  it("still knows the agent after a review invoked from workspace context", async () => {
    const h = harness();

    await h.deliver(agentDone);
    expect(h.index.get("/wt/x")?.agentName).toBe("reviewer");
    expect(h.index.get("/wt/x")?.agentPaneId).toBe("w1:p3");

    expect(await dispatch("review", h.runtime({ worktree: "/wt/x" }))).toBe(0);
    expect(h.index.get("/wt/x")?.agentName).toBe("reviewer");
    expect(h.index.get("/wt/x")?.agentPaneId).toBe("w1:p3");

    expect(await dispatch("send-review", h.runtime({ worktree: "/wt/x" }))).toBe(0);
    expect(h.herdr.promptAgent).toHaveBeenCalledWith(
      "w1:p3",
      expect.stringContaining("src/a.ts:3"),
    );
    expect(h.index.sentIds("/wt/x")).toEqual(["c1"]);
  });

  it("keeps the pane id recorded by the review action when a later event carries none", async () => {
    const h = harness();
    await dispatch("review", h.runtime({ worktree: "/wt/x", agentName: "reviewer" }));
    expect(h.index.get("/wt/x")?.paneId).toBe("w1:p7");

    await h.deliver(agentDone);
    expect(h.index.get("/wt/x")?.paneId).toBe("w1:p7");
  });

  it("does not re-send already-delivered comments after the review pane is closed and reopened", async () => {
    const cfg = { ...DEFAULTS, roundtrip: { ...DEFAULTS.roundtrip, clear_after_send: false } };
    const h = harness();

    await h.deliver(agentDone);
    await dispatch("review", h.runtime({ worktree: "/wt/x" }, cfg));
    expect(await dispatch("send-review", h.runtime({ worktree: "/wt/x" }, cfg))).toBe(0);
    expect(h.herdr.promptAgent).toHaveBeenCalledTimes(1);

    await h.deliver(paneExited("w1:p7"));
    await dispatch("review", h.runtime({ worktree: "/wt/x" }, cfg));
    expect(await dispatch("send-review", h.runtime({ worktree: "/wt/x" }, cfg))).toBe(0);

    expect(h.herdr.promptAgent).toHaveBeenCalledTimes(1);
    expect(h.herdr.notify).toHaveBeenCalledWith("No new review comments to send.");
  });

  it("forgets everything once the worktree itself is gone", async () => {
    const h = harness();
    await h.deliver(agentDone);
    await dispatch("review", h.runtime({ worktree: "/wt/x" }));
    await h.deliver(worktreeRemoved("/wt/x"));
    expect(h.index.get("/wt/x")).toBeUndefined();
  });
});
