import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneEntrypointFor } from "../src/actions.js";
import { DEFAULTS } from "../src/config.js";
import { dispatch } from "../src/runtime.js";
import { ReviewIndex } from "../src/index-store.js";
import { worktreeKey } from "../src/worktree.js";

function runtime(over: Record<string, any> = {}) {
  const requests: Array<{ mode?: string; ref?: string }> = [];
  const rt: Record<string, any> = {
    cfg: DEFAULTS,
    ctx: { worktree: "/wt/x", agentName: "reviewer", paneId: "w1:p1" },
    pluginRoot: "/plugin",
    stateDir: mkdtempSync(join(tmpdir(), "rrm-state-")),
    index: new ReviewIndex(mkdtempSync(join(tmpdir(), "rrm-"))),
    herdr: {
      notify: vi.fn(),
      promptAgent: vi.fn(() => true),
      openPane: vi.fn(() => "w1:p7"),
      closePane: vi.fn(() => true),
    },
    commitExists: vi.fn(() => true),
    hunk: {
      listComments: vi.fn(async () => []),
      removeComment: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
      navigate: vi.fn(async () => {}),
    },
    ...over,
  };
  rt.requests = requests;
  rt.targetFor ??= (mode?: string, ref?: string) => {
    requests.push({ mode, ref });
    return { worktree: "/wt/x", mode: mode === undefined ? "working" : mode, ref };
  };
  rt.target ??= rt.targetFor();
  requests.length = 0;
  return rt;
}

describe("requested review mode reaches target resolution", () => {
  it.each([
    ["review", undefined],
    ["review:staged", "staged"],
    ["review:branch", "branch"],
    ["review:commit", "commit"],
    ["review:stash", "stash"],
  ])("%s asks the resolver for mode %s", async (actionId, mode) => {
    const rt = runtime();
    expect(await dispatch(actionId, rt as any)).toBe(0);
    expect(rt.requests).toEqual([{ mode, ref: undefined }]);
  });

  it("reloads a reused pane with the requested mode, not the config default", async () => {
    const rt = runtime();
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    await dispatch("review:staged", rt as any);
    expect(rt.hunk.reload).toHaveBeenCalledWith(
      "/wt/x",
      expect.objectContaining({ mode: "staged" }),
      rt.cfg,
    );
  });

  it("opens a fresh pane for a stash review instead of reloading, which hunk cannot do", async () => {
    const rt = runtime();
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    await dispatch("review:stash", rt as any);
    expect(rt.hunk.reload).not.toHaveBeenCalled();
    expect(rt.herdr.openPane).toHaveBeenCalledWith({
      entrypoint: paneEntrypointFor("review:stash"),
      cwd: "/wt/x",
      placement: "split",
    });
  });
});

describe("reload honours the mode its pane was opened with", () => {
  it("reloads a review:staged pane as staged, not as the config default", async () => {
    const rt = runtime({
      cfg: { ...DEFAULTS, review: { ...DEFAULTS.review, default_target: "working" } },
    });
    expect(await dispatch("review:staged", rt as any)).toBe(0);
    expect(await dispatch("reload", rt as any)).toBe(0);
    expect(rt.hunk.reload).toHaveBeenCalledWith(
      "/wt/x",
      expect.objectContaining({ mode: "staged" }),
      rt.cfg,
    );
  });

  it("reloads a link-clicked commit review at the same commit it was opened on", async () => {
    const rt = runtime({
      ctx: { worktree: "/wt/x", clickedUrl: "https://github.com/o/r/commit/abc1234def" },
    });
    expect(await dispatch("review:commit", rt as any)).toBe(0);
    expect(await dispatch("reload", rt as any)).toBe(0);
    expect(rt.hunk.reload).toHaveBeenCalledWith(
      "/wt/x",
      expect.objectContaining({ mode: "commit", ref: "abc1234def" }),
      rt.cfg,
    );
  });

  it("reloads a pane that was re-pointed by reuse_pane as the review it now shows", async () => {
    const rt = runtime({
      ctx: {
        worktree: "/wt/x",
        agentName: "reviewer",
        clickedUrl: "https://github.com/o/r/commit/aaaaaaa",
      },
    });
    expect(await dispatch("review:commit", rt as any)).toBe(0);
    expect(rt.index.get("/wt/x")).toMatchObject({
      requestedMode: "commit",
      requestedRef: "aaaaaaa",
    });

    expect(await dispatch("review:staged", rt as any)).toBe(0);
    expect(rt.hunk.reload).toHaveBeenLastCalledWith(
      "/wt/x",
      { worktree: "/wt/x", mode: "staged", ref: undefined },
      rt.cfg,
    );
    expect(rt.index.get("/wt/x")?.requestedMode).toBe("staged");
    expect(rt.index.get("/wt/x")?.requestedRef).toBeUndefined();

    expect(await dispatch("reload", rt as any)).toBe(0);
    expect(rt.hunk.reload).toHaveBeenLastCalledWith(
      "/wt/x",
      { worktree: "/wt/x", mode: "staged", ref: undefined },
      rt.cfg,
    );
  });

  it("falls back to the config default when no review has been opened for the worktree", async () => {
    const rt = runtime();
    expect(await dispatch("reload", rt as any)).toBe(0);
    expect(rt.hunk.reload).toHaveBeenCalledWith("/wt/x", rt.target, rt.cfg);
  });

  it("refuses to reload a pane opened as a stash review, and says why", async () => {
    const rt = runtime();
    expect(await dispatch("review:stash", rt as any)).toBe(0);
    expect(await dispatch("reload", rt as any)).toBe(1);
    expect(rt.hunk.reload).not.toHaveBeenCalled();
    expect(rt.herdr.notify).toHaveBeenCalledWith(expect.stringMatching(/cannot reload a stash/i));
  });
});

describe("the selection-driven action ids that were removed", () => {
  it.each(["review:patch", "review:compare", "review:difftool", "review:paths"])(
    "%s is not dispatchable, and reviews nothing rather than something else",
    async (actionId) => {
      const rt = runtime();
      expect(await dispatch(actionId, rt as any)).toBe(2);
      expect(rt.herdr.openPane).not.toHaveBeenCalled();
      expect(rt.hunk.reload).not.toHaveBeenCalled();
      expect(rt.requests).toEqual([]);
    },
  );
});

describe("what the index records about a review's ref", () => {
  it("records no ref for a review whose ref the resolver derived", async () => {
    const rt = runtime({
      targetFor: (mode?: string, ref?: string) => ({
        worktree: "/wt/x",
        mode: mode === undefined ? "working" : mode,
        ref: ref ?? (mode === "branch" ? "main...HEAD" : undefined),
      }),
    });
    expect(await dispatch("review:branch", rt as any)).toBe(0);
    expect(rt.index.get("/wt/x")?.requestedRef).toBeUndefined();
  });

  it("records the ref a clicked link supplied, which the resolver could not have derived", async () => {
    const rt = runtime({
      ctx: { worktree: "/wt/x", clickedUrl: "https://github.com/o/r/commit/abc1234def" },
    });
    expect(await dispatch("review:commit", rt as any)).toBe(0);
    expect(rt.index.get("/wt/x")?.requestedRef).toBe("abc1234def");
  });
});

describe("a clicked GitHub commit link", () => {
  it("refuses a commit this clone does not have, instead of opening a pane that dies", async () => {
    const rt = runtime({
      ctx: {
        worktree: "/wt/x",
        paneId: "w1:p1",
        clickedUrl: "https://github.com/o/r/commit/0123456789abcdef0123456789abcdef01234567",
      },
      commitExists: vi.fn(() => false),
    });
    expect(await dispatch("review:commit", rt as any)).toBe(1);
    expect(rt.herdr.openPane).not.toHaveBeenCalled();
    expect(rt.herdr.notify).toHaveBeenCalledWith(expect.stringContaining("0123456789"));
  });

  it("reviews that commit rather than the local working tree", async () => {
    const rt = runtime({
      ctx: {
        worktree: "/wt/x",
        agentName: "reviewer",
        clickedUrl: "https://github.com/o/r/commit/abc1234def",
      },
    });
    expect(await dispatch("review:commit", rt as any)).toBe(0);
    expect(rt.requests).toEqual([{ mode: "commit", ref: "abc1234def" }]);
  });

  it("records the commit-ish for the pane process, which cannot see the clicked url", async () => {
    const rt = runtime({
      ctx: { worktree: "/wt/x", clickedUrl: "https://github.com/o/r/commit/abc1234def" },
    });
    await dispatch("review:commit", rt as any);
    expect(rt.index.get("/wt/x")?.requestedRef).toBe("abc1234def");
  });

  it("clears a stale commit-ish when a later review is not a commit review", async () => {
    const rt = runtime({
      ctx: { worktree: "/wt/x", clickedUrl: "https://github.com/o/r/commit/abc1234def" },
    });
    await dispatch("review:commit", rt as any);
    expect(rt.index.get("/wt/x")?.requestedRef).toBe("abc1234def");

    const plain = runtime({
      index: rt.index,
      cfg: { ...DEFAULTS, review: { ...DEFAULTS.review, reuse_pane: false } },
    });
    await dispatch("review", plain as any);
    expect(rt.index.get("/wt/x")?.requestedRef).toBeUndefined();
  });

  it("ignores a pull request url it cannot resolve, and says so", async () => {
    const rt = runtime({
      ctx: { worktree: "/wt/x", clickedUrl: "https://github.com/o/r/pull/42" },
    });
    expect(await dispatch("review:commit", rt as any)).toBe(0);
    expect(rt.requests).toEqual([{ mode: "commit", ref: undefined }]);
    expect(rt.herdr.notify).toHaveBeenCalledWith(expect.stringMatching(/pull request/i));
  });

  it("does not consult the clicked url for a non-commit review action", async () => {
    const rt = runtime({
      ctx: { worktree: "/wt/x", clickedUrl: "https://github.com/o/r/commit/abc1234def" },
    });
    await dispatch("review:staged", rt as any);
    expect(rt.requests).toEqual([{ mode: "staged", ref: undefined }]);
  });
});

describe("what the pane process reads from the index at launch", () => {
  function onDiskIndex(dir: string): Record<string, any> {
    try {
      return JSON.parse(readFileSync(join(dir, "review-index.json"), "utf8"));
    } catch {
      return {};
    }
  }

  function observingRuntime(over: Record<string, any> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "rrm-idx-"));
    const observed: Array<Record<string, any>> = [];
    const rt = runtime({
      index: new ReviewIndex(dir),
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => true),
        openPane: vi.fn(() => {
          observed.push(onDiskIndex(dir));
          return "w1:p7";
        }),
        closePane: vi.fn(() => true),
      },
      ...over,
    });
    return { rt, observed, dir };
  }

  it("sees the clicked commit's ref already recorded when openPane spawns it", async () => {
    const { rt, observed } = observingRuntime({
      ctx: { worktree: "/wt/x", clickedUrl: "https://github.com/o/r/commit/abc1234def" },
    });
    expect(await dispatch("review:commit", rt as any)).toBe(0);
    expect(observed).toHaveLength(1);
    expect(observed[0][worktreeKey("/wt/x")]?.requestedRef).toBe("abc1234def");
  });

  it("sees no ref at all when this invocation has none, rather than the previous review's", async () => {
    const first = observingRuntime({
      ctx: { worktree: "/wt/x", clickedUrl: "https://github.com/o/r/commit/aaaaaaa" },
    });
    await dispatch("review:commit", first.rt as any);
    expect(first.rt.index.get("/wt/x")?.requestedRef).toBe("aaaaaaa");

    const observed: Array<Record<string, any>> = [];
    const plain = runtime({
      index: first.rt.index,
      cfg: { ...DEFAULTS, review: { ...DEFAULTS.review, reuse_pane: false } },
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => true),
        openPane: vi.fn(() => {
          observed.push(onDiskIndex(first.dir));
          return "w1:p8";
        }),
        closePane: vi.fn(() => true),
      },
    });
    expect(await dispatch("review", plain as any)).toBe(0);
    expect(observed).toHaveLength(1);
    expect(observed[0]["/wt/x"]?.requestedRef).toBeUndefined();
  });

  it("still records the pane id afterwards, without clobbering the pre-open state", async () => {
    const { rt } = observingRuntime({
      ctx: {
        worktree: "/wt/x",
        agentName: "reviewer",
        clickedUrl: "https://github.com/o/r/commit/abc1234def",
      },
    });
    await dispatch("review:commit", rt as any);
    expect(rt.index.get("/wt/x")).toMatchObject({
      worktree: "/wt/x",
      agentName: "reviewer",
      paneId: "w1:p7",
      requestedRef: "abc1234def",
    });
  });
});

describe("opens regardless of whether the target has content", () => {
  it("opens a pane even when there is nothing to show, for parity with native hunk", async () => {
    const rt = runtime();
    expect(await dispatch("review", rt as any)).toBe(0);
    expect(rt.herdr.openPane).toHaveBeenCalledTimes(1);
    expect(rt.herdr.notify).not.toHaveBeenCalledWith(expect.stringMatching(/nothing to review/i));
  });

  it("reuses/reloads an existing pane rather than suppressing it, even for an empty target", async () => {
    const rt = runtime();
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    expect(await dispatch("review", rt as any)).toBe(0);
    expect(rt.hunk.reload).toHaveBeenCalledTimes(1);
    expect(rt.herdr.notify).not.toHaveBeenCalledWith(expect.stringMatching(/nothing to review/i));
  });
});
