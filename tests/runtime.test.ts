import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneEntrypointFor } from "../src/actions.js";
import { DEFAULTS } from "../src/config.js";
import { dispatch } from "../src/runtime.js";
import { ReviewIndex } from "../src/index-store.js";
import { HunkProtocolError, HunkUnavailableError } from "../src/hunk.js";

function runtime(over: Record<string, any> = {}) {
  const rt: Record<string, any> = {
    cfg: DEFAULTS,
    ctx: { worktree: "/wt/x", agentName: "reviewer", paneId: "w1:p1" },
    pluginRoot: "/plugin",
    index: new ReviewIndex(mkdtempSync(join(tmpdir(), "rt-"))),
    herdr: {
      notify: vi.fn(),
      promptAgent: vi.fn(() => true),
      openPane: vi.fn(() => "w1:p7"),
      closePane: vi.fn(() => true),
    },
    hunk: {
      listComments: vi.fn(async () => []),
      removeComment: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    },
    target: { worktree: "/wt/x", mode: "working" as const },
    ...over,
  };
  rt.targetFor ??= (mode?: string, ref?: string) =>
    mode === undefined ? rt.target : { ...rt.target, mode, ref };
  return rt;
}

describe("dispatch", () => {
  it("opens a review pane for the resolved worktree", async () => {
    const rt = runtime();
    expect(await dispatch("review", rt as any)).toBe(0);
    expect(rt.herdr.openPane).toHaveBeenCalledWith({
      entrypoint: paneEntrypointFor("review"),
      cwd: "/wt/x",
      placement: "split",
    });
  });

  // Asserted through paneEntrypointFor rather than a literal, because the entrypoint is
  // platform-dependent: Windows opens the `cmd` twin of each pane, under its own id.
  it.each(["review", "review:staged", "review:branch", "review:commit", "review:stash"] as const)(
    "opens the %s action's own pane entrypoint",
    async (actionId) => {
      const rt = runtime({ target: { worktree: "/wt/y", mode: "working" as const } });
      expect(await dispatch(actionId, rt as any)).toBe(0);
      expect(rt.herdr.openPane).toHaveBeenCalledWith({
        entrypoint: paneEntrypointFor(actionId),
        cwd: "/wt/y",
        placement: "split",
      });
      expect(rt.index.get("/wt/y")?.agentName).toBe("reviewer");
      expect(rt.index.get("/wt/y")?.paneId).toBe("w1:p7");
    },
  );

  it("opens the review with the configured placement", async () => {
    const rt = runtime({
      cfg: { ...DEFAULTS, review: { ...DEFAULTS.review, placement: "zoomed" as const } },
    });
    await dispatch("review", rt as any);
    expect(rt.herdr.openPane).toHaveBeenCalledWith({
      entrypoint: paneEntrypointFor("review"),
      cwd: "/wt/x",
      placement: "zoomed",
    });
  });

  it("notifies instead of prompting when there are no comments to send", async () => {
    const rt = runtime();
    expect(await dispatch("send-review", rt as any)).toBe(0);
    expect(rt.herdr.promptAgent).not.toHaveBeenCalled();
    expect(rt.herdr.notify).toHaveBeenCalled();
  });

  it("sends unsent comments to the owning agent's PANE with the rendered text and records them", async () => {
    const rt = runtime({
      ctx: { worktree: "/wt/x", agentName: "claude", paneId: "w1:p1" },
      hunk: {
        listComments: vi.fn(async () => [
          { noteId: "c1", filePath: "src/a.ts", newRange: [3, 3], body: "Fix" },
        ]),
        removeComment: vi.fn(async () => {}),
        reload: vi.fn(async () => {}),
      },
    });
    expect(await dispatch("send-review", rt as any)).toBe(0);
    expect(rt.herdr.promptAgent).toHaveBeenCalledTimes(1);
    const [agentArg, textArg] = rt.herdr.promptAgent.mock.calls[0];
    expect(agentArg).toBe("w1:p1");
    expect(agentArg).not.toBe("claude");
    expect(textArg).toContain("src/a.ts:3 — Fix");
    expect(textArg).toContain("/wt/x");
    expect(rt.index.sentIds("/wt/x")).toEqual(["c1"]);
    expect(rt.hunk.removeComment).toHaveBeenCalledWith("/wt/x", "c1");
  });

  it("prompts the recorded agent pane when the invoking context has no agent of its own", async () => {
    const rt = runtime({
      ctx: { worktree: "/wt/x", paneId: "w1:p9" },
      hunk: {
        listComments: vi.fn(async () => [
          { noteId: "c1", filePath: "src/a.ts", newRange: [3, 3], body: "Fix" },
        ]),
        removeComment: vi.fn(async () => {}),
        reload: vi.fn(async () => {}),
      },
    });
    rt.index.upsert({
      worktree: "/wt/x",
      agentName: "claude",
      agentPaneId: "w1:p1",
      sent: [],
    });
    expect(await dispatch("send-review", rt as any)).toBe(0);
    expect(rt.herdr.promptAgent).toHaveBeenCalledWith(
      "w1:p1",
      expect.stringContaining("src/a.ts:3"),
    );
  });

  it("records the agent's pane as the delivery target when a review is opened", async () => {
    const rt = runtime({ ctx: { worktree: "/wt/x", agentName: "claude", paneId: "w1:p1" } });
    expect(await dispatch("review", rt as any)).toBe(0);
    const entry = rt.index.get("/wt/x");
    expect(entry?.agentPaneId).toBe("w1:p1");
    expect(entry?.paneId).toBe("w1:p7");
  });

  it("does not record a non-agent pane as the delivery target", async () => {
    const rt = runtime({ ctx: { worktree: "/wt/x", paneId: "w1:p9" } });
    expect(await dispatch("review", rt as any)).toBe(0);
    expect(rt.index.get("/wt/x")?.agentPaneId).toBeUndefined();
  });

  it("does not resend a comment already delivered", async () => {
    const rt = runtime({
      hunk: {
        listComments: vi.fn(async () => [
          { noteId: "c1", filePath: "src/a.ts", newRange: [3, 3], body: "Fix" },
        ]),
        removeComment: vi.fn(async () => {}),
        reload: vi.fn(async () => {}),
      },
    });
    rt.index.markSent("/wt/x", ["c1"]);
    await dispatch("send-review", rt as any);
    expect(rt.herdr.promptAgent).not.toHaveBeenCalled();
  });

  it("notifies with the hunk-unavailable message and exits 1 when listComments throws", async () => {
    const unavailable = new HunkUnavailableError("no-session", "No active hunk session.");
    const rt = runtime({
      hunk: {
        listComments: vi.fn(async () => {
          throw unavailable;
        }),
        removeComment: vi.fn(async () => {}),
        reload: vi.fn(async () => {}),
      },
    });
    expect(await dispatch("send-review", rt as any)).toBe(1);
    expect(rt.herdr.notify).toHaveBeenCalledWith("No active hunk session.");
    expect(rt.herdr.promptAgent).not.toHaveBeenCalled();
  });

  it("notifies with a generic message and exits 1 on a non-HunkUnavailableError failure", async () => {
    const rt = runtime({
      hunk: {
        listComments: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
        removeComment: vi.fn(async () => {}),
        reload: vi.fn(async () => {}),
      },
    });
    expect(await dispatch("send-review", rt as any)).toBe(1);
    expect(rt.herdr.notify).toHaveBeenCalledWith("hunk session unavailable.");
  });

  it("does not prompt when hunk returns comments without stable ids", async () => {
    const rt = runtime({
      hunk: {
        listComments: vi.fn(async () => {
          throw new HunkProtocolError(
            "hunk returned an invalid comment at position 1; comments were not sent.",
          );
        }),
        removeComment: vi.fn(async () => {}),
        reload: vi.fn(async () => {}),
      },
    });
    expect(await dispatch("send-review", rt as any)).toBe(1);
    expect(rt.herdr.promptAgent).not.toHaveBeenCalled();
    expect(rt.herdr.notify).toHaveBeenCalledWith(expect.stringContaining("comments were not sent"));
  });

  it("notifies that no agent is associated with the worktree and exits 1", async () => {
    const rt = runtime({
      ctx: { worktree: "/wt/x" },
      hunk: {
        listComments: vi.fn(async () => [
          { noteId: "c1", filePath: "src/a.ts", newRange: [3, 3], body: "Fix" },
        ]),
        removeComment: vi.fn(async () => {}),
        reload: vi.fn(async () => {}),
      },
    });
    expect(await dispatch("send-review", rt as any)).toBe(1);
    expect(rt.herdr.notify).toHaveBeenCalledWith(
      "No agent is associated with this worktree; comments kept.",
    );
    expect(rt.herdr.promptAgent).not.toHaveBeenCalled();
    expect(rt.index.sentIds("/wt/x")).toEqual([]);
  });

  it("notifies that the agent could not be prompted and exits 1, without marking sent", async () => {
    const rt = runtime({
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => false),
        openPane: vi.fn(() => "w1:p7"),
        closePane: vi.fn(() => true),
      },
      hunk: {
        listComments: vi.fn(async () => [
          { noteId: "c1", filePath: "src/a.ts", newRange: [3, 3], body: "Fix" },
        ]),
        removeComment: vi.fn(async () => {}),
        reload: vi.fn(async () => {}),
      },
    });
    expect(await dispatch("send-review", rt as any)).toBe(1);
    expect(rt.herdr.notify).toHaveBeenCalledWith(
      'Could not prompt agent "reviewer"; comments kept.',
    );
    expect(rt.index.sentIds("/wt/x")).toEqual([]);
  });

  it("notifies but does not throw when removeComment fails after a successful send", async () => {
    const rt = runtime({
      hunk: {
        listComments: vi.fn(async () => [
          { noteId: "c1", filePath: "src/a.ts", newRange: [3, 3], body: "Fix" },
        ]),
        removeComment: vi.fn(async () => {
          throw new Error("rpc timeout");
        }),
        reload: vi.fn(async () => {}),
      },
    });
    expect(await dispatch("send-review", rt as any)).toBe(0);
    expect(rt.index.sentIds("/wt/x")).toEqual(["c1"]);
    expect(rt.herdr.notify).toHaveBeenCalledWith(
      "Sent comment c1 to reviewer, but could not remove it from hunk; it will stay visible.",
    );
  });

  it("reloads the session for the resolved target", async () => {
    const rt = runtime();
    expect(await dispatch("reload", rt as any)).toBe(0);
    expect(rt.hunk.reload).toHaveBeenCalledWith("/wt/x", rt.target, rt.cfg);
  });

  it("closes the pane when the index has a stored paneId", async () => {
    const rt = runtime();
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    expect(await dispatch("close-review", rt as any)).toBe(0);
    expect(rt.herdr.closePane).toHaveBeenCalledWith("w1:p7");
  });

  it("does not attempt to close a pane when the index has no stored paneId", async () => {
    const rt = runtime();
    rt.index.upsert({ worktree: "/wt/x", sent: [] });
    expect(await dispatch("close-review", rt as any)).toBe(0);
    expect(rt.herdr.closePane).not.toHaveBeenCalled();
  });

  it("says there is nothing to close rather than reporting a silent success", async () => {
    const rt = runtime();
    rt.index.upsert({ worktree: "/wt/x", sent: [] });
    await dispatch("close-review", rt as any);
    expect(rt.herdr.notify).toHaveBeenCalledWith(expect.stringMatching(/no review pane is open/i));
  });

  it("returns a non-zero code for an unknown action", async () => {
    expect(await dispatch("nope", runtime() as any)).toBe(2);
  });
});
