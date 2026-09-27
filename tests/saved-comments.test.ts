import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.js";
import { dispatch } from "../src/runtime.js";
import { ReviewIndex } from "../src/index-store.js";
import { HunkUnavailableError, type HunkComment } from "../src/hunk.js";
import {
  forgetSavedComments,
  loadSavedComments,
  saveComments,
  savedCommentsPath,
} from "../src/saved-comments.js";
import { commentSnapshotter } from "../src/bin/comment-watch.js";
import { resolveAndRun } from "../src/bin/pane.js";

const WT = "/wt/x";
const comment = (noteId: string, body = noteId): HunkComment =>
  ({ noteId, filePath: "src/a.ts", newRange: [3, 3], body }) as HunkComment;
const ids = (comments: HunkComment[]) => comments.map((c) => c.noteId);
const stateDir = () => mkdtempSync(join(tmpdir(), "saved-"));

describe("saved comments store", () => {
  it("round-trips comments and removes the file when emptied", () => {
    const dir = stateDir();
    saveComments(dir, WT, [comment("a"), comment("b")]);
    expect(ids(loadSavedComments(dir, WT))).toEqual(["a", "b"]);
    saveComments(dir, WT, []);
    expect(existsSync(savedCommentsPath(dir, WT))).toBe(false);
  });

  it("forgets only the delivered ids", () => {
    const dir = stateDir();
    saveComments(dir, WT, [comment("a"), comment("b")]);
    forgetSavedComments(dir, WT, ["a"]);
    expect(ids(loadSavedComments(dir, WT))).toEqual(["b"]);
  });

  it("reads a missing or corrupt snapshot as empty", () => {
    expect(loadSavedComments(stateDir(), WT)).toEqual([]);
  });
});

describe("commentSnapshotter", () => {
  const deps = (dir: string, live: () => Promise<HunkComment[]>, sent: string[] = []) => ({
    listComments: vi.fn(live),
    sentIds: () => sent,
    stateDir: dir,
  });

  it("saves the viewer's unsent comments", async () => {
    const dir = stateDir();
    await commentSnapshotter(
      WT,
      deps(dir, async () => [comment("a"), comment("b")], ["a"]),
    )();
    expect(ids(loadSavedComments(dir, WT))).toEqual(["b"]);
  });

  it("keeps comments from a closed viewer when a new viewer starts empty", async () => {
    const dir = stateDir();
    saveComments(dir, WT, [comment("old")]);
    await commentSnapshotter(
      WT,
      deps(dir, async () => []),
    )();
    expect(ids(loadSavedComments(dir, WT))).toEqual(["old"]);
  });

  it("drops a comment deleted in the running viewer", async () => {
    const dir = stateDir();
    let live = [comment("a"), comment("b")];
    const snapshot = commentSnapshotter(
      WT,
      deps(dir, async () => live),
    );
    await snapshot();
    live = [comment("b")];
    await snapshot();
    expect(ids(loadSavedComments(dir, WT))).toEqual(["b"]);
  });

  it("keeps the last snapshot when hunk cannot be reached", async () => {
    const dir = stateDir();
    let fail = false;
    const snapshot = commentSnapshotter(
      WT,
      deps(dir, async () => {
        if (fail) throw new HunkUnavailableError("no-session", "gone");
        return [comment("a")];
      }),
    );
    await snapshot();
    fail = true;
    await snapshot();
    expect(ids(loadSavedComments(dir, WT))).toEqual(["a"]);
  });
});

describe("send-review with saved comments (#37)", () => {
  function runtime(dir: string, listComments: () => Promise<HunkComment[]>) {
    const rt: Record<string, any> = {
      cfg: DEFAULTS,
      ctx: { worktree: WT, agentName: "claude", paneId: "w1:p1" },
      pluginRoot: "/plugin",
      stateDir: dir,
      index: new ReviewIndex(dir),
      herdr: { notify: vi.fn(), promptAgent: vi.fn(() => true) },
      hunk: { listComments: vi.fn(listComments), removeComment: vi.fn(async () => {}) },
      target: { worktree: WT, mode: "working" as const },
    };
    rt.targetFor = () => rt.target;
    return rt;
  }

  it("delivers saved comments after the viewer has closed", async () => {
    const dir = stateDir();
    saveComments(dir, WT, [comment("a", "Fix this")]);
    const rt = runtime(dir, async () => {
      throw new HunkUnavailableError("no-session", "No active hunk session.");
    });

    expect(await dispatch("send-review", rt as any)).toBe(0);
    expect(rt.herdr.promptAgent.mock.calls[0][1]).toContain("src/a.ts:3 — Fix this");
    expect(rt.index.sentIds(WT)).toEqual(["a"]);
    expect(loadSavedComments(dir, WT)).toEqual([]);
    expect(rt.hunk.removeComment).not.toHaveBeenCalled();
  });

  it("merges saved and live comments once each, removing only live ones from hunk", async () => {
    const dir = stateDir();
    saveComments(dir, WT, [comment("old"), comment("both")]);
    const rt = runtime(dir, async () => [comment("both"), comment("new")]);

    expect(await dispatch("send-review", rt as any)).toBe(0);
    expect(rt.index.sentIds(WT).sort()).toEqual(["both", "new", "old"]);
    expect(rt.hunk.removeComment.mock.calls.map((c: unknown[]) => c[1]).sort()).toEqual([
      "both",
      "new",
    ]);
    expect(loadSavedComments(dir, WT)).toEqual([]);
  });

  it("still reports a missing session when nothing was saved", async () => {
    const rt = runtime(stateDir(), async () => {
      throw new HunkUnavailableError("no-session", "No active hunk session.");
    });
    expect(await dispatch("send-review", rt as any)).toBe(1);
    expect(rt.herdr.notify).toHaveBeenCalledWith("No active hunk session.");
  });
});

describe("pane exit with unsent comments", () => {
  function launch(dir: string, beforeExit?: () => void) {
    const notify = vi.fn();
    const stop = vi.fn();
    const watch = vi.fn(() => stop);
    const env = {
      HERDR_PLUGIN_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pane-cfg-")),
      HERDR_PLUGIN_STATE_DIR: dir,
    };
    const code = resolveAndRun(
      env,
      WT,
      vi.fn(() => {
        beforeExit?.();
        return { status: 0 };
      }),
      undefined,
      notify,
      watch,
    );
    return { code, notify, watch, stop };
  }

  it("watches the reviewed worktree while hunk runs and stops afterwards", () => {
    const { watch, stop } = launch(stateDir());
    expect(watch).toHaveBeenCalledWith(WT, expect.anything());
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("tells the user their unsent comments were saved", () => {
    const dir = stateDir();
    const { code, notify } = launch(dir, () => saveComments(dir, WT, [comment("a")]));
    expect(code).toBe(0);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("1 unsent review comment(s)"));
  });

  it("stays silent when every saved comment was already sent", () => {
    const dir = stateDir();
    new ReviewIndex(dir).markSent(WT, ["a"]);
    const { notify } = launch(dir, () => saveComments(dir, WT, [comment("a")]));
    expect(notify).not.toHaveBeenCalled();
  });
});
