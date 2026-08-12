import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config.js";
import { readContext } from "../src/context.js";
import { resolveTarget } from "../src/target.js";

const deps = (opts: { base?: string | null; ahead?: boolean; root?: string | null }) => ({
  resolveBaseRef: () => (opts.base === undefined ? "origin/main" : opts.base),
  hasCommitsAhead: () => opts.ahead ?? false,
  repoRoot: (dir: string) => (opts.root === undefined ? dir : opts.root),
});

describe("resolveTarget", () => {
  it("uses the context worktree", () => {
    const t = resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({}));
    expect(t.worktree).toBe("/wt/x");
  });

  it("falls back to cwd when no worktree is in context", () => {
    const t = resolveTarget({ cwd: "/repo" }, DEFAULTS, deps({}));
    expect(t.worktree).toBe("/repo");
  });

  it("auto picks branch mode when the branch is ahead of its base", () => {
    const t = resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({ ahead: true }));
    expect(t.mode).toBe("branch");
    expect(t.ref).toBe("origin/main...HEAD");
  });

  it("auto picks working mode when the branch is not ahead", () => {
    const t = resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({ ahead: false }));
    expect(t.mode).toBe("working");
    expect(t.ref).toBeUndefined();
  });

  it("auto falls back to working with a warning when no base resolves", () => {
    const t = resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({ base: null, ahead: true }));
    expect(t.mode).toBe("working");
    expect(t.warning).toMatch(/base/i);
  });

  it("honours an explicit staged config over auto detection", () => {
    const cfg = { ...DEFAULTS, review: { ...DEFAULTS.review, default_target: "staged" as const } };
    const t = resolveTarget({ worktree: "/wt/x" }, cfg, deps({ ahead: true }));
    expect(t.mode).toBe("staged");
  });

  it("honours an explicit override argument over config", () => {
    const t = resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({ ahead: true }), "working");
    expect(t.mode).toBe("working");
  });

  it("honours an explicit override even when config specifies a conflicting explicit mode", () => {
    const cfg = { ...DEFAULTS, review: { ...DEFAULTS.review, default_target: "staged" as const } };
    const t = resolveTarget({ worktree: "/wt/x" }, cfg, deps({ ahead: true }), "branch");
    expect(t.mode).toBe("branch");
  });

  it("falls back to process.cwd() when context has neither worktree nor cwd", () => {
    const t = resolveTarget({}, DEFAULTS, deps({}));
    expect(t.worktree).toBe(process.cwd());
  });

  it("warns when falling back to process.cwd() because no worktree resolved from context", () => {
    const t = resolveTarget({}, DEFAULTS, deps({}));
    expect(t.warning).toBeTruthy();
    expect(t.warning).toMatch(/worktree/i);
  });

  it("does not set a worktree warning when ctx.worktree is present", () => {
    const t = resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({}));
    expect(t.warning).toBeUndefined();
  });

  it("combines the worktree warning and the base-ref warning when both conditions hit", () => {
    const t = resolveTarget({}, DEFAULTS, deps({ base: null }));
    expect(t.warning).toMatch(/worktree/i);
    expect(t.warning).toMatch(/base/i);
  });

  it("resolves a base ref for an explicitly requested branch review", () => {
    const t = resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({ ahead: false }), "branch");
    expect(t.mode).toBe("branch");
    expect(t.ref).toBe("origin/main...HEAD");
  });

  it("does not require commits ahead of base for an explicitly requested branch review", () => {
    const t = resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({ ahead: false }), "branch");
    expect(t.mode).toBe("branch");
  });

  it("degrades an explicit branch request to the working tree, with a warning, when no base resolves", () => {
    const t = resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({ base: null }), "branch");
    expect(t.mode).toBe("working");
    expect(t.warning).toMatch(/base/i);
  });

  it("resolves a commit review with no ref, so hunk shows the most recent commit", () => {
    const t = resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({}), "commit");
    expect(t.mode).toBe("commit");
    expect(t.ref).toBeUndefined();
  });

  it("carries an explicit ref onto a commit review (a clicked GitHub commit url)", () => {
    const t = resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({}), "commit", "abc1234");
    expect(t.mode).toBe("commit");
    expect(t.ref).toBe("abc1234");
  });

  it("resolves a stash review, defaulting to the most recent entry", () => {
    expect(resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({}), "stash").ref).toBeUndefined();
    expect(resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({}), "stash", "stash@{1}").ref).toBe(
      "stash@{1}",
    );
  });

  describe("repository identity", () => {
    it("canonicalises a context cwd to the repository root", () => {
      const t = resolveTarget({ cwd: "/repo/src/deep" }, DEFAULTS, deps({ root: "/repo" }));
      expect(t.worktree).toBe("/repo");
    });

    it("resolves two subdirectories of one repository to the same worktree", () => {
      const d = deps({ root: "/repo" });
      expect(resolveTarget({ cwd: "/repo/src" }, DEFAULTS, d).worktree).toBe(
        resolveTarget({ cwd: "/repo/tests/fixtures" }, DEFAULTS, d).worktree,
      );
    });

    it("canonicalises the process.cwd() last resort too", () => {
      const t = resolveTarget({}, DEFAULTS, deps({ root: "/repo" }));
      expect(t.worktree).toBe("/repo");
    });

    it("prefers a context worktree verbatim, without resolving a root", () => {
      const repoRoot = () => "/somewhere/else";
      const t = resolveTarget({ worktree: "/wt/x", cwd: "/wt/x/src" }, DEFAULTS, {
        ...deps({}),
        repoRoot,
      });
      expect(t.worktree).toBe("/wt/x");
    });

    it("does not resolve a root at all when the context carries a worktree", () => {
      let calls = 0;
      const repoRoot = () => {
        calls += 1;
        return "/repo";
      };
      resolveTarget({ worktree: "/wt/x" }, DEFAULTS, { ...deps({}), repoRoot });
      expect(calls).toBe(0);
    });

    it("keeps the supplied directory when it is in no git repository", () => {
      const t = resolveTarget({ cwd: "/jj/checkout/sub" }, DEFAULTS, deps({ root: null }));
      expect(t.worktree).toBe("/jj/checkout/sub");
    });

    it("does not warn when the root cannot be resolved but a cwd was supplied", () => {
      const t = resolveTarget({ cwd: "/jj/checkout" }, DEFAULTS, deps({ root: null }));
      expect(t.warning).toBeUndefined();
    });

    it("resolves the root at most once per resolution", () => {
      let calls = 0;
      const repoRoot = () => {
        calls += 1;
        return "/repo";
      };
      resolveTarget({ cwd: "/repo/src" }, DEFAULTS, {
        ...deps({ ahead: true }),
        repoRoot,
      });
      expect(calls).toBe(1);
    });
  });

  it("never shells out for a base ref when the requested mode does not need one", () => {
    let calls = 0;
    const counting = {
      resolveBaseRef: () => {
        calls += 1;
        return "origin/main";
      },
      hasCommitsAhead: () => true,
      repoRoot: (dir: string) => dir,
    };
    for (const mode of ["working", "staged", "commit", "stash"] as const) {
      resolveTarget({ worktree: "/wt/x" }, DEFAULTS, counting, mode);
    }
    expect(calls).toBe(0);
  });

  describe("the supplied ref", () => {
    it("carries a base ref supplied for a branch review instead of deriving one", () => {
      let calls = 0;
      const counting = {
        resolveBaseRef: () => {
          calls += 1;
          return "origin/main";
        },
        hasCommitsAhead: () => true,
      };
      const t = resolveTarget(
        { worktree: "/wt/x" },
        DEFAULTS,
        counting,
        "branch",
        "main...feature",
      );
      expect(t.mode).toBe("branch");
      expect(t.ref).toBe("main...feature");
      expect(calls).toBe(0);
      expect(t.warning).toBeUndefined();
    });

    it("carries a commit-ish supplied for a commit review", () => {
      const t = resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({}), "commit", "abc1234def");
      expect(t.mode).toBe("commit");
      expect(t.ref).toBe("abc1234def");
    });

    it("resolves no target carrying a key beyond worktree, mode, ref and warning", () => {
      const allowed = ["worktree", "mode", "ref", "warning"];
      for (const mode of ["working", "staged", "branch", "commit", "stash"] as const) {
        for (const ref of [undefined, "some-ref"]) {
          const t = resolveTarget({ worktree: "/wt/x" }, DEFAULTS, deps({}), mode, ref);
          expect(
            Object.keys(t).filter((k) => !allowed.includes(k)),
            `${mode}/${ref}`,
          ).toEqual([]);
        }
      }
    });
  });
});

describe("readContext feeding resolveTarget", () => {
  const target = (payload: Record<string, unknown>) =>
    resolveTarget(
      readContext({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(payload) }),
      DEFAULTS,
      deps({}),
    );

  it("keys a review on the checkout root when the invocation came from a subdirectory", () => {
    const t = target({
      focused_pane_cwd: "/wt/repo/src/ui",
      workspace_cwd: "/wt/repo",
      worktree: { checkout_path: "/wt/repo", repo_root: "/wt/repo", is_linked_worktree: false },
    });
    expect(t.worktree).toBe("/wt/repo");
    expect(t.warning).toBeUndefined();
  });

  it("reviews both subdirectories of one repo as the same review", () => {
    const wt = { checkout_path: "/wt/repo" };
    const a = target({ focused_pane_cwd: "/wt/repo/src", worktree: wt });
    const b = target({ focused_pane_cwd: "/wt/repo/docs/deep", worktree: wt });
    expect(a.worktree).toBe(b.worktree);
  });

  it("still reviews the focused pane's repo when it is not the workspace's checkout", () => {
    const t = target({
      focused_pane_cwd: "/wt/other-repo",
      workspace_cwd: "/wt/repo",
      worktree: { checkout_path: "/wt/repo" },
    });
    expect(t.worktree).toBe("/wt/other-repo");
  });
});
