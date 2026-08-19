import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paneEntrypointFor } from "../src/actions.js";
import { DEFAULTS } from "../src/config.js";
import { DEFAULT_BINDINGS } from "../src/keys.js";
import { dispatch } from "../src/runtime.js";
import { ReviewIndex } from "../src/index-store.js";
import { HunkUnavailableError } from "../src/hunk.js";

function runtime(over: Record<string, any> = {}) {
  const rt: Record<string, any> = {
    cfg: DEFAULTS,
    ctx: { worktree: "/wt/x", agentName: "reviewer", paneId: "w1:p1" },
    pluginRoot: "/plugin",
    stateDir: mkdtempSync(join(tmpdir(), "rta-state-")),
    index: new ReviewIndex(mkdtempSync(join(tmpdir(), "rta-"))),
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
      navigate: vi.fn(async () => {}),
    },
    target: { worktree: "/wt/x", mode: "working" as const },
    ...over,
  };
  rt.targetFor ??= (mode?: string, ref?: string) =>
    mode === undefined ? rt.target : { ...rt.target, mode, ref };
  return rt;
}

describe("reuse_pane", () => {
  it("reloads an existing review instead of opening a second pane", async () => {
    const rt = runtime();
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    await dispatch("review", rt as any);
    expect(rt.hunk.reload).toHaveBeenCalledOnce();
    expect(rt.herdr.openPane).not.toHaveBeenCalled();
  });

  it("opens a new pane when reuse_pane is disabled", async () => {
    const rt = runtime({
      cfg: { ...DEFAULTS, review: { ...DEFAULTS.review, reuse_pane: false } },
    });
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    await dispatch("review", rt as any);
    expect(rt.herdr.openPane).toHaveBeenCalledOnce();
  });

  describe("a reload that fails must still put a review on screen", () => {
    function staleRuntime(err: unknown, over: Record<string, any> = {}) {
      const rt = runtime({
        hunk: {
          listComments: vi.fn(async () => []),
          removeComment: vi.fn(async () => {}),
          reload: vi.fn(async () => {
            throw err;
          }),
          navigate: vi.fn(async () => {}),
        },
        ...over,
      });
      rt.index.upsert({ worktree: "/wt/x", paneId: "w1:pDEAD", sent: ["c1"] });
      return rt;
    }

    it("opens a fresh pane and succeeds when reload throws", async () => {
      const rt = staleRuntime(new HunkUnavailableError("no-session", "No active hunk session."));
      expect(await dispatch("review", rt as any)).toBe(0);
      expect(rt.hunk.reload).toHaveBeenCalledOnce();
      expect(rt.herdr.openPane).toHaveBeenCalledWith({
        entrypoint: paneEntrypointFor("review"),
        cwd: "/wt/x",
        placement: "split",
      });
    });

    it("does not leave the dead pane id in the index", async () => {
      const rt = staleRuntime(new Error("session is gone"));
      await dispatch("review", rt as any);
      expect(rt.index.get("/wt/x")?.paneId).not.toBe("w1:pDEAD");
      expect(rt.index.get("/wt/x")?.paneId).toBe("w1:p7");
    });

    it("clears the dead pane id even when the fresh open yields no pane id", async () => {
      const rt = staleRuntime(new Error("session is gone"), {
        herdr: {
          notify: vi.fn(),
          promptAgent: vi.fn(() => true),
          openPane: vi.fn(() => null),
          closePane: vi.fn(() => true),
        },
      });
      await dispatch("review", rt as any);
      expect(rt.index.get("/wt/x")?.paneId).toBeUndefined();
    });

    it("tells the user what happened rather than failing silently", async () => {
      const rt = staleRuntime(new HunkUnavailableError("no-session", "No active hunk session."));
      await dispatch("review", rt as any);
      expect(rt.herdr.notify).toHaveBeenCalledWith(
        expect.stringContaining("No active hunk session."),
      );
    });

    it("keeps the sent history across the fallback", async () => {
      const rt = staleRuntime(new Error("session is gone"));
      await dispatch("review", rt as any);
      expect(rt.index.sentIds("/wt/x")).toEqual(["c1"]);
    });

    it("reports a failing explicit reload instead of throwing out of dispatch", async () => {
      const rt = staleRuntime(new HunkUnavailableError("no-session", "No active hunk session."));
      rt.index.upsert({ worktree: "/wt/x", requestedMode: "working", sent: [] });
      expect(await dispatch("reload", rt as any)).toBe(1);
      expect(rt.herdr.notify).toHaveBeenCalledWith(
        expect.stringContaining("No active hunk session."),
      );
      expect(rt.herdr.openPane).not.toHaveBeenCalled();
    });
  });
});

describe("comment navigation", () => {
  it("navigates to the next comment", async () => {
    const rt = runtime();
    expect(await dispatch("next-comment", rt as any)).toBe(0);
    expect(rt.hunk.navigate).toHaveBeenCalledWith("/wt/x", { nextComment: true });
  });

  it("navigates to the previous comment", async () => {
    const rt = runtime();
    await dispatch("prev-comment", rt as any);
    expect(rt.hunk.navigate).toHaveBeenCalledWith("/wt/x", { prevComment: true });
  });

  const throwingNavigate = (err: Error) => ({
    hunk: {
      listComments: vi.fn(async () => []),
      removeComment: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
      navigate: vi.fn(async () => {
        throw err;
      }),
    },
  });

  for (const actionId of ["next-comment", "prev-comment"] as const) {
    it(`reports a missing hunk session for ${actionId} instead of rejecting`, async () => {
      const rt = runtime(
        throwingNavigate(new HunkUnavailableError("no-session", "No active hunk session.")),
      );
      await expect(dispatch(actionId, rt as any)).resolves.toBe(1);
      expect(rt.herdr.notify).toHaveBeenCalledWith(
        expect.stringContaining("No active hunk session."),
      );
    });

    it(`reports an ordinary error from ${actionId} too`, async () => {
      const rt = runtime(throwingNavigate(new Error("hunk exited 2")));
      await expect(dispatch(actionId, rt as any)).resolves.toBe(1);
      expect(rt.herdr.notify).toHaveBeenCalledWith(expect.stringContaining("hunk exited 2"));
    });
  }

  it("names the direction it could not move in", async () => {
    const rt = runtime(throwingNavigate(new Error("boom")));
    await dispatch("prev-comment", rt as any);
    expect(rt.herdr.notify).toHaveBeenCalledWith(expect.stringMatching(/previous comment/i));
  });
});

describe("pane metadata reporting", () => {
  it("reports title and unsent count after reusing an existing review pane", async () => {
    const reportMetadata = vi.fn();
    const rt = runtime({
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => true),
        openPane: vi.fn(() => "w1:p7"),
        closePane: vi.fn(() => true),
        reportMetadata,
      },
      hunk: {
        listComments: vi.fn(async () => [
          { noteId: "c1", filePath: "src/a.ts", newRange: [3, 3], body: "Fix" },
          { noteId: "c2", filePath: "src/b.ts", newRange: [1, 1], body: "Guard" },
        ]),
        removeComment: vi.fn(async () => {}),
        reload: vi.fn(async () => {}),
        navigate: vi.fn(async () => {}),
      },
    });
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    expect(await dispatch("review", rt as any)).toBe(0);
    expect(reportMetadata).toHaveBeenCalledWith("w1:p7", {
      title: "Review: x",
      display_agent: "hunk (2 unsent)",
    });
  });

  it("reports a plain display_agent when every comment has already been sent", async () => {
    const reportMetadata = vi.fn();
    const rt = runtime({
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => true),
        openPane: vi.fn(() => "w1:p7"),
        closePane: vi.fn(() => true),
        reportMetadata,
      },
      hunk: {
        listComments: vi.fn(async () => [
          { noteId: "c1", filePath: "src/a.ts", newRange: [3, 3], body: "Fix" },
        ]),
        removeComment: vi.fn(async () => {}),
        reload: vi.fn(async () => {}),
        navigate: vi.fn(async () => {}),
      },
    });
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: ["c1"] });
    await dispatch("review", rt as any);
    expect(reportMetadata).toHaveBeenCalledWith("w1:p7", {
      title: "Review: x",
      display_agent: "hunk",
    });
  });

  it("reports metadata for a freshly opened pane too, not just a reused one", async () => {
    const reportMetadata = vi.fn();
    const rt = runtime({
      cfg: { ...DEFAULTS, review: { ...DEFAULTS.review, reuse_pane: false } },
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => true),
        openPane: vi.fn(() => "w2:p9"),
        closePane: vi.fn(() => true),
        reportMetadata,
      },
      hunk: {
        listComments: vi.fn(async () => []),
        removeComment: vi.fn(async () => {}),
        reload: vi.fn(async () => {}),
        navigate: vi.fn(async () => {}),
      },
    });
    await dispatch("review", rt as any);
    expect(reportMetadata).toHaveBeenCalledWith("w2:p9", {
      title: "Review: x",
      display_agent: "hunk",
    });
  });

  it("also reports metadata after send-review completes", async () => {
    const reportMetadata = vi.fn();
    const rt = runtime({
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => true),
        openPane: vi.fn(() => "w1:p7"),
        closePane: vi.fn(() => true),
        reportMetadata,
      },
      hunk: {
        listComments: vi.fn(async () => [
          { noteId: "c1", filePath: "src/a.ts", newRange: [3, 3], body: "Fix" },
        ]),
        removeComment: vi.fn(async () => {}),
        reload: vi.fn(async () => {}),
        navigate: vi.fn(async () => {}),
      },
    });
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    expect(await dispatch("send-review", rt as any)).toBe(0);
    expect(reportMetadata).toHaveBeenCalledWith("w1:p7", {
      title: "Review: x",
      display_agent: "hunk",
    });
  });

  it("silently skips reporting when the herdr adapter has no reportMetadata (older CLI)", async () => {
    const rt = runtime();
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    await expect(dispatch("review", rt as any)).resolves.toBe(0);
  });

  it("does not attempt to report metadata when no pane is on record for the worktree", async () => {
    const reportMetadata = vi.fn();
    const rt = runtime({
      cfg: { ...DEFAULTS, review: { ...DEFAULTS.review, reuse_pane: false } },
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => true),
        openPane: vi.fn(() => null),
        closePane: vi.fn(() => true),
        reportMetadata,
      },
    });
    await dispatch("review", rt as any);
    expect(reportMetadata).not.toHaveBeenCalled();
  });

  it("does not fail an already-successful review open when reportMetadata throws", async () => {
    const rt = runtime({
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => true),
        openPane: vi.fn(() => "w1:p7"),
        closePane: vi.fn(() => true),
        reportMetadata: vi.fn(() => {
          throw new Error("herdr socket gone");
        }),
      },
    });
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    expect(await dispatch("review", rt as any)).toBe(0);
  });

  it("does not swallow a failure from the index read that feeds the metadata", async () => {
    const rt = runtime({
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => true),
        openPane: vi.fn(() => "w1:p7"),
        closePane: vi.fn(() => true),
        reportMetadata: vi.fn(),
      },
    });
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    rt.index.sentIds = () => {
      throw new Error("index corrupted");
    };
    await expect(dispatch("review", rt as any)).rejects.toThrow("index corrupted");
  });

  it("does not fail send-review when reportMetadata throws after comments were delivered", async () => {
    const rt = runtime({
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => true),
        openPane: vi.fn(() => "w1:p7"),
        closePane: vi.fn(() => true),
        reportMetadata: vi.fn(() => {
          throw new Error("herdr socket gone");
        }),
      },
      hunk: {
        listComments: vi.fn(async () => [
          { noteId: "c1", filePath: "src/a.ts", newRange: [3, 3], body: "Fix" },
        ]),
        removeComment: vi.fn(async () => {}),
        reload: vi.fn(async () => {}),
        navigate: vi.fn(async () => {}),
      },
    });
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    expect(await dispatch("send-review", rt as any)).toBe(0);
    expect(rt.index.sentIds("/wt/x")).toEqual(["c1"]);
  });
});

describe("a failure with nothing on screen must exit non-zero and say why", () => {
  function withStderr() {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    return spy;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a review whose pane never opened, instead of succeeding silently", async () => {
    const stderr = withStderr();
    const rt = runtime({
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => true),
        openPane: vi.fn(() => null),
        closePane: vi.fn(() => true),
      },
    });

    expect(await dispatch("review", rt as any)).toBe(1);
    expect(rt.herdr.notify).toHaveBeenCalledWith(expect.stringMatching(/could not open/i));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("/wt/x"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("review"));
  });

  it("says so for every review action, not only the plain one", async () => {
    for (const id of ["review:staged", "review:branch", "review:commit"]) {
      withStderr();
      const rt = runtime({
        herdr: {
          notify: vi.fn(),
          promptAgent: vi.fn(() => true),
          openPane: vi.fn(() => null),
          closePane: vi.fn(() => true),
        },
      });
      expect(await dispatch(id, rt as any), id).toBe(1);
      expect(rt.herdr.notify, id).toHaveBeenCalledWith(expect.stringMatching(/could not open/i));
      vi.restoreAllMocks();
    }
  });

  it("keeps a successful open at 0 and writes nothing to stderr", async () => {
    const stderr = withStderr();
    const rt = runtime();
    expect(await dispatch("review", rt as any)).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("reports a close-review whose pane did not close", async () => {
    const stderr = withStderr();
    const rt = runtime({
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => true),
        openPane: vi.fn(() => "w1:p7"),
        closePane: vi.fn(() => false),
      },
    });
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });

    expect(await dispatch("close-review", rt as any)).toBe(1);
    expect(rt.herdr.notify).toHaveBeenCalledWith(expect.stringMatching(/could not close/i));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("w1:p7"));
  });

  it("keeps a successful close at 0 and writes nothing to stderr", async () => {
    const stderr = withStderr();
    const rt = runtime();
    rt.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    expect(await dispatch("close-review", rt as any)).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("still says nothing when only the cosmetic metadata report fails", async () => {
    const stderr = withStderr();
    const rt = runtime({
      herdr: {
        notify: vi.fn(),
        promptAgent: vi.fn(() => true),
        openPane: vi.fn(() => "w1:p7"),
        closePane: vi.fn(() => true),
        reportMetadata: vi.fn(() => {
          throw new Error("herdr socket gone");
        }),
      },
    });
    expect(await dispatch("review", rt as any)).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(rt.herdr.notify).not.toHaveBeenCalled();
  });
});

describe("setup-keys reporting", () => {
  function homeWithConfig(text: string): string {
    const fakeHome = mkdtempSync(join(tmpdir(), "hunkdiff-home-"));
    const path = defaultConfigPath(fakeHome);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return fakeHome;
  }

  /**
   * The default config location differs by platform, and so does the variable that redirects it:
   * `homedir()` ignores HOME on Windows, where herdr reads `%APPDATA%`. Redirecting the wrong one
   * does not fail — it lets these tests install keybindings into the real user config.
   */
  const WINDOWS = process.platform === "win32";
  const CONFIG_ENV = ["HOME", "APPDATA", "HERDR_CONFIG_PATH", "XDG_CONFIG_HOME"] as const;

  async function dispatchWithEnv(
    action: string,
    env: Partial<Record<(typeof CONFIG_ENV)[number], string>>,
    rt: Record<string, any>,
  ): Promise<number> {
    const saved = CONFIG_ENV.map((k) => [k, process.env[k]] as const);
    const restore = (pairs: readonly (readonly [string, string | undefined])[]) => {
      for (const [k, v] of pairs) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    try {
      restore(CONFIG_ENV.map((k) => [k, env[k]] as const));
      return await dispatch(action, rt as any);
    } finally {
      restore(saved);
    }
  }

  const dispatchWithHome = (fakeHome: string, rt: Record<string, any>) =>
    dispatchWithEnv("setup-keys", WINDOWS ? { APPDATA: fakeHome } : { HOME: fakeHome }, rt);

  const userBinding = (key: string) =>
    `[[keys.command]]\nkey = "${key}"\ntype = "shell"\ncommand = "mine"\n`;

  const defaultConfigPath = (fakeHome: string) =>
    WINDOWS
      ? join(fakeHome, "herdr", "config.toml")
      : join(fakeHome, ".config", "herdr", "config.toml");

  function overrideConfig(text: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "hunkdiff-override-")), "elsewhere.toml");
    writeFileSync(path, text);
    return path;
  }

  it("installs into HERDR_CONFIG_PATH and leaves the default location untouched", async () => {
    const fakeHome = homeWithConfig(userBinding("prefix+shift+h"));
    const override = overrideConfig(`onboarding = false\n`);
    const rt = runtime();

    const code = await dispatchWithEnv(
      "setup-keys",
      { ...(WINDOWS ? { APPDATA: fakeHome } : { HOME: fakeHome }), HERDR_CONFIG_PATH: override },
      rt,
    );

    expect(code).toBe(0);
    expect(rt.herdr.notify).toHaveBeenCalledWith(
      expect.stringContaining("Installed 4 keybinding(s)"),
    );
    expect(readFileSync(override, "utf8")).toContain("jhochenbaum.hunkdiff.review");
    expect(readFileSync(defaultConfigPath(fakeHome), "utf8")).toBe(userBinding("prefix+shift+h"));
  });

  it("detects conflicts in HERDR_CONFIG_PATH, not in the default location", async () => {
    const fakeHome = homeWithConfig(`onboarding = false\n`);
    const override = overrideConfig(userBinding("prefix+shift+h"));
    const rt = runtime();

    const code = await dispatchWithEnv(
      "setup-keys",
      { ...(WINDOWS ? { APPDATA: fakeHome } : { HOME: fakeHome }), HERDR_CONFIG_PATH: override },
      rt,
    );

    expect(code).toBe(0);
    expect(rt.herdr.notify).toHaveBeenCalledWith(expect.stringContaining("Installed 3 of 4"));
    expect(readFileSync(override, "utf8")).toContain(userBinding("prefix+shift+h"));
  });

  it("removes the managed block from HERDR_CONFIG_PATH", async () => {
    const original = `onboarding = false\n`;
    const fakeHome = homeWithConfig(original);
    const override = overrideConfig(original);

    await dispatchWithEnv(
      "setup-keys",
      { ...(WINDOWS ? { APPDATA: fakeHome } : { HOME: fakeHome }), HERDR_CONFIG_PATH: override },
      runtime(),
    );
    expect(readFileSync(override, "utf8")).toContain("BEGIN jhochenbaum.hunkdiff");

    const rt = runtime();
    const code = await dispatchWithEnv(
      "remove-keys",
      { ...(WINDOWS ? { APPDATA: fakeHome } : { HOME: fakeHome }), HERDR_CONFIG_PATH: override },
      rt,
    );

    expect(code).toBe(0);
    expect(readFileSync(override, "utf8")).toBe(original);
    expect(readFileSync(defaultConfigPath(fakeHome), "utf8")).toBe(original);
  });

  it("exits 0 on a partial install and names the skipped key with the action it would have bound", async () => {
    const rt = runtime();
    const code = await dispatchWithHome(homeWithConfig(userBinding("prefix+shift+h")), rt);

    expect(code).toBe(0);
    expect(rt.herdr.notify).toHaveBeenCalledWith(
      expect.stringContaining("prefix+shift+h (jhochenbaum.hunkdiff.review)"),
    );
    expect(rt.herdr.notify).toHaveBeenCalledWith(expect.stringContaining("Installed 3 of 4"));
  });

  it("exits 1 and says nothing was installed when every key collided", async () => {
    const rt = runtime();
    const allTaken = DEFAULT_BINDINGS.map((b) => userBinding(b.key)).join("\n");
    const code = await dispatchWithHome(homeWithConfig(allTaken), rt);

    expect(code).toBe(1);
    expect(rt.herdr.notify).toHaveBeenCalledWith(expect.stringContaining("Installed 0 of 4"));
  });
});
