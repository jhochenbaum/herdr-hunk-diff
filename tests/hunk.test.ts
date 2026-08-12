import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../src/config.js";
import {
  canReload,
  HunkAdapter,
  HunkProtocolError,
  HunkUnavailableError,
  buildLaunchArgs,
  parseHunkComments,
} from "../src/hunk.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-hunk", import.meta.url));
const hunk = new HunkAdapter(FAKE);

describe("buildLaunchArgs", () => {
  it("builds a working-tree review", () => {
    expect(buildLaunchArgs({ worktree: "/wt/x", mode: "working" }, DEFAULTS)).toEqual(["diff"]);
  });

  it("builds a staged review", () => {
    expect(buildLaunchArgs({ worktree: "/wt/x", mode: "staged" }, DEFAULTS)).toEqual([
      "diff",
      "--staged",
    ]);
  });

  it("builds a branch review with the merge-base ref", () => {
    const args = buildLaunchArgs(
      { worktree: "/wt/x", mode: "branch", ref: "origin/main...HEAD" },
      DEFAULTS,
    );
    expect(args).toEqual(["diff", "origin/main...HEAD"]);
  });

  it("passes the agent-context sidecar when notes exist", () => {
    const args = buildLaunchArgs({ worktree: "/wt/x", mode: "working" }, DEFAULTS, "/tmp/n.json");
    expect(args).toContain("--agent-context");
    expect(args).toContain("/tmp/n.json");
  });

  it("passes --watch only when configured", () => {
    const cfg = { ...DEFAULTS, review: { ...DEFAULTS.review, watch: true } };
    expect(buildLaunchArgs({ worktree: "/wt/x", mode: "working" }, cfg)).toContain("--watch");
    expect(buildLaunchArgs({ worktree: "/wt/x", mode: "working" }, DEFAULTS)).not.toContain(
      "--watch",
    );
  });

  it("never emits presentational flags owned by hunk's own config", () => {
    const args = buildLaunchArgs({ worktree: "/wt/x", mode: "working" }, DEFAULTS);
    for (const flag of ["--theme", "--mode", "--line-numbers", "--tab-width", "--wrap"]) {
      expect(args).not.toContain(flag);
    }
  });

  describe("review.exclude_untracked", () => {
    const cfg = { ...DEFAULTS, review: { ...DEFAULTS.review, exclude_untracked: true } };

    it("emits --exclude-untracked for a working-tree review when set", () => {
      expect(buildLaunchArgs({ worktree: "/wt/x", mode: "working" }, cfg)).toEqual([
        "diff",
        "--exclude-untracked",
      ]);
    });

    it("emits nothing for it by default, so an unset key changes no argv", () => {
      expect(buildLaunchArgs({ worktree: "/wt/x", mode: "working" }, DEFAULTS)).not.toContain(
        "--exclude-untracked",
      );
      expect(DEFAULTS.review.exclude_untracked).toBe(false);
    });

    it("emits it for the other reviews that are `hunk diff`", () => {
      expect(buildLaunchArgs({ worktree: "/wt/x", mode: "staged" }, cfg)).toEqual([
        "diff",
        "--staged",
        "--exclude-untracked",
      ]);
      expect(
        buildLaunchArgs({ worktree: "/wt/x", mode: "branch", ref: "main...HEAD" }, cfg),
      ).toEqual(["diff", "main...HEAD", "--exclude-untracked"]);
    });

    it("never emits it for a review whose subcommand hunk would reject it on", () => {
      const targets = [
        { worktree: "/wt/x", mode: "commit" as const, ref: "abc1234" },
        { worktree: "/wt/x", mode: "stash" as const },
      ];
      for (const target of targets) {
        expect(buildLaunchArgs(target, cfg), target.mode).not.toContain("--exclude-untracked");
      }
    });
  });

  describe("hunk.experimental", () => {
    const cfg = { ...DEFAULTS, hunk: { ...DEFAULTS.hunk, experimental: true } };

    it("emits --experimental for every review mode when set", () => {
      const targets = [
        { worktree: "/wt/x", mode: "working" as const },
        { worktree: "/wt/x", mode: "staged" as const },
        { worktree: "/wt/x", mode: "branch" as const, ref: "main...HEAD" },
        { worktree: "/wt/x", mode: "commit" as const, ref: "abc1234" },
        { worktree: "/wt/x", mode: "stash" as const },
      ];
      for (const target of targets) {
        expect(buildLaunchArgs(target, cfg), target.mode).toContain("--experimental");
      }
    });

    it("emits nothing for it by default, so an unset key changes no argv", () => {
      expect(buildLaunchArgs({ worktree: "/wt/x", mode: "working" }, DEFAULTS)).not.toContain(
        "--experimental",
      );
      expect(DEFAULTS.hunk.experimental).toBe(false);
    });
  });

  it("appends configured extra_args verbatim", () => {
    const cfg = { ...DEFAULTS, hunk: { ...DEFAULTS.hunk, extra_args: ["--transparent-bg"] } };
    expect(buildLaunchArgs({ worktree: "/wt/x", mode: "working" }, cfg)).toContain(
      "--transparent-bg",
    );
  });

  it("builds a commit review as `hunk show`, with the ref when one is known", () => {
    expect(buildLaunchArgs({ worktree: "/wt/x", mode: "commit" }, DEFAULTS)).toEqual(["show"]);
    expect(
      buildLaunchArgs({ worktree: "/wt/x", mode: "commit", ref: "abc1234" }, DEFAULTS),
    ).toEqual(["show", "abc1234"]);
  });

  it("builds a stash review as `hunk stash show`", () => {
    expect(buildLaunchArgs({ worktree: "/wt/x", mode: "stash" }, DEFAULTS)).toEqual([
      "stash",
      "show",
    ]);
    expect(
      buildLaunchArgs({ worktree: "/wt/x", mode: "stash", ref: "stash@{1}" }, DEFAULTS),
    ).toEqual(["stash", "show", "stash@{1}"]);
  });

  it("still passes the agent-context sidecar and --watch for commit and stash reviews", () => {
    const cfg = { ...DEFAULTS, review: { ...DEFAULTS.review, watch: true } };
    for (const mode of ["commit", "stash"] as const) {
      const args = buildLaunchArgs({ worktree: "/wt/x", mode }, cfg, "/tmp/n.json");
      expect(args).toContain("--agent-context");
      expect(args).toContain("/tmp/n.json");
      expect(args).toContain("--watch");
    }
  });

  describe("the argv every review mode builds", () => {
    it("launches every mode with no operand but the optional ref", () => {
      expect(buildLaunchArgs({ worktree: "/wt/x", mode: "working" }, DEFAULTS)).toEqual(["diff"]);
      expect(buildLaunchArgs({ worktree: "/wt/x", mode: "staged" }, DEFAULTS)).toEqual([
        "diff",
        "--staged",
      ]);
      expect(buildLaunchArgs({ worktree: "/wt/x", mode: "branch" }, DEFAULTS)).toEqual(["diff"]);
      expect(buildLaunchArgs({ worktree: "/wt/x", mode: "commit" }, DEFAULTS)).toEqual(["show"]);
      expect(buildLaunchArgs({ worktree: "/wt/x", mode: "stash" }, DEFAULTS)).toEqual([
        "stash",
        "show",
      ]);
    });

    it("emits no `--` separator for any mode, since no pathspec can reach it", () => {
      const cfg = {
        ...DEFAULTS,
        review: { ...DEFAULTS.review, watch: true, exclude_untracked: true },
        hunk: { ...DEFAULTS.hunk, experimental: true, extra_args: ["--transparent-bg"] },
      };
      for (const target of [
        { worktree: "/wt/x", mode: "working" as const },
        { worktree: "/wt/x", mode: "staged" as const },
        { worktree: "/wt/x", mode: "branch" as const, ref: "main...HEAD" },
        { worktree: "/wt/x", mode: "commit" as const, ref: "abc1234" },
        { worktree: "/wt/x", mode: "stash" as const, ref: "stash@{1}" },
      ]) {
        expect(buildLaunchArgs(target, cfg, "/tmp/n.json"), target.mode).not.toContain("--");
      }
    });

    it("emits the subcommand first and the user's extra_args last", () => {
      const cfg = {
        ...DEFAULTS,
        review: { ...DEFAULTS.review, watch: true },
        hunk: { ...DEFAULTS.hunk, extra_args: ["--transparent-bg"] },
      };
      expect(buildLaunchArgs({ worktree: "/wt/x", mode: "working" }, cfg, "/tmp/n.json")).toEqual([
        "diff",
        "--watch",
        "--agent-context",
        "/tmp/n.json",
        "--transparent-bg",
      ]);
    });
  });
});

describe("HunkAdapter.navigate argument construction", () => {
  const original = process.env.HUNK_FIXTURE_ARGS_FILE;

  afterEach(() => {
    if (original === undefined) delete process.env.HUNK_FIXTURE_ARGS_FILE;
    else process.env.HUNK_FIXTURE_ARGS_FILE = original;
  });

  async function navigateArgs(opts: Parameters<HunkAdapter["navigate"]>[1]): Promise<string> {
    const file = join(mkdtempSync(join(tmpdir(), "hunk-args-")), "argv.txt");
    process.env.HUNK_FIXTURE_ARGS_FILE = file;
    await new HunkAdapter(FAKE).navigate("/wt/x", opts);
    return readFileSync(file, "utf8").trim();
  }

  it("keeps the comment-stepping forms the human actions use", async () => {
    expect(await navigateArgs({ nextComment: true })).toBe(
      "session navigate --repo /wt/x --next-comment --json",
    );
    expect(await navigateArgs({ prevComment: true })).toBe(
      "session navigate --repo /wt/x --prev-comment --json",
    );
  });

  it("builds the absolute forms as --file plus exactly one target", async () => {
    expect(await navigateArgs({ file: "src/a.ts", hunk: 2 })).toBe(
      "session navigate --repo /wt/x --file src/a.ts --hunk 2 --json",
    );
    expect(await navigateArgs({ file: "src/a.ts", newLine: 42 })).toBe(
      "session navigate --repo /wt/x --file src/a.ts --new-line 42 --json",
    );
    expect(await navigateArgs({ file: "src/a.ts", oldLine: 7 })).toBe(
      "session navigate --repo /wt/x --file src/a.ts --old-line 7 --json",
    );
  });

  it("never emits a camelCase flag name", async () => {
    const args = await navigateArgs({ file: "a.ts", newLine: 1 });
    expect(args).not.toContain("newLine");
    expect(args).not.toContain("filePath");
  });
});

describe("canReload", () => {
  it("accepts the modes hunk can re-point a live session at", () => {
    for (const mode of ["working", "staged", "branch", "commit"] as const) {
      expect(canReload(mode)).toBe(true);
    }
  });

  it("rejects a stash review, which hunk cannot reload in place", () => {
    expect(canReload("stash")).toBe(false);
  });
});

describe("HunkAdapter.reload argument construction", () => {
  const original = process.env.HUNK_FIXTURE_ARGS_FILE;

  afterEach(() => {
    if (original === undefined) delete process.env.HUNK_FIXTURE_ARGS_FILE;
    else process.env.HUNK_FIXTURE_ARGS_FILE = original;
  });

  async function reloadArgs(
    target: Parameters<HunkAdapter["reload"]>[1],
    cfg = DEFAULTS,
  ): Promise<string> {
    const file = join(mkdtempSync(join(tmpdir(), "hunk-args-")), "argv.txt");
    process.env.HUNK_FIXTURE_ARGS_FILE = file;
    await new HunkAdapter(FAKE).reload("/wt/x", target, cfg);
    return readFileSync(file, "utf8").trim();
  }

  it("reloads a working-tree review as `-- diff`", async () => {
    expect(await reloadArgs({ worktree: "/wt/x", mode: "working" })).toBe(
      "session reload --repo /wt/x --json -- diff",
    );
  });

  it("reloads a staged review as `-- diff --staged`", async () => {
    expect(await reloadArgs({ worktree: "/wt/x", mode: "staged" })).toBe(
      "session reload --repo /wt/x --json -- diff --staged",
    );
  });

  it("reloads a branch review with its base ref", async () => {
    expect(await reloadArgs({ worktree: "/wt/x", mode: "branch", ref: "origin/main...HEAD" })).toBe(
      "session reload --repo /wt/x --json -- diff origin/main...HEAD",
    );
  });

  it("reloads a commit review as `-- show <ref>`", async () => {
    expect(await reloadArgs({ worktree: "/wt/x", mode: "commit", ref: "abc1234" })).toBe(
      "session reload --repo /wt/x --json -- show abc1234",
    );
  });

  it("omits the ref for a commit review that has none, so hunk shows the last commit", async () => {
    expect(await reloadArgs({ worktree: "/wt/x", mode: "commit" })).toBe(
      "session reload --repo /wt/x --json -- show",
    );
  });

  it("refuses to reload a stash review rather than reloading a plain diff instead", async () => {
    await expect(
      new HunkAdapter(FAKE).reload("/wt/x", { worktree: "/wt/x", mode: "stash" }, DEFAULTS),
    ).rejects.toThrow(/cannot reload a stash review/i);
  });

  describe("review.exclude_untracked on a reload", () => {
    const cfg = { ...DEFAULTS, review: { ...DEFAULTS.review, exclude_untracked: true } };

    it("carries the flag into the nested diff form", async () => {
      expect(await reloadArgs({ worktree: "/wt/x", mode: "working" }, cfg)).toBe(
        "session reload --repo /wt/x --json -- diff --exclude-untracked",
      );
    });

    it("keeps it after the nested command's own ref", async () => {
      expect(await reloadArgs({ worktree: "/wt/x", mode: "branch", ref: "main...HEAD" }, cfg)).toBe(
        "session reload --repo /wt/x --json -- diff main...HEAD --exclude-untracked",
      );
    });

    it("never emits it for a commit reload, whose nested form is `show`", async () => {
      expect(await reloadArgs({ worktree: "/wt/x", mode: "commit", ref: "abc1234" }, cfg)).toBe(
        "session reload --repo /wt/x --json -- show abc1234",
      );
    });

    it("still carries no presentational or session-level flag", async () => {
      const noisy = {
        ...cfg,
        review: { ...cfg.review, watch: true },
        hunk: { ...cfg.hunk, experimental: true, extra_args: ["--transparent-bg"] },
      };
      const args = await reloadArgs({ worktree: "/wt/x", mode: "working" }, noisy);
      for (const flag of ["--watch", "--experimental", "--transparent-bg", "--agent-context"]) {
        expect(args).not.toContain(flag);
      }
    });
  });

  it("emits exactly one separator, since no pathspec can reach a reload", async () => {
    for (const target of [
      { worktree: "/wt/x", mode: "working" as const },
      { worktree: "/wt/x", mode: "branch" as const, ref: "main...HEAD" },
      { worktree: "/wt/x", mode: "commit" as const, ref: "abc1234" },
    ]) {
      const argv = (await reloadArgs(target)).split(" ");
      const separators = argv.filter((arg) => arg === "--");
      expect(separators, target.mode).toHaveLength(1);
      expect(argv.indexOf("--json")).toBeLessThan(argv.indexOf("--"));
    }
  });

  it("reloads the repo it was asked about, not a session-id guess", async () => {
    const args = await reloadArgs({ worktree: "/wt/other", mode: "working" });
    expect(args).toContain("--repo /wt/x");
  });

  it("places --json before the `--` separator, never after it", async () => {
    const argv = (await reloadArgs({ worktree: "/wt/x", mode: "working" })).split(" ");
    expect(argv.indexOf("--json")).toBeLessThan(argv.indexOf("--"));
  });
});

describe("HunkAdapter --json placement across every caller", () => {
  const original = process.env.HUNK_FIXTURE_ARGS_FILE;

  afterEach(() => {
    if (original === undefined) delete process.env.HUNK_FIXTURE_ARGS_FILE;
    else process.env.HUNK_FIXTURE_ARGS_FILE = original;
  });

  async function argvOf(call: (h: HunkAdapter) => Promise<unknown>): Promise<string> {
    const file = join(mkdtempSync(join(tmpdir(), "hunk-args-")), "argv.txt");
    process.env.HUNK_FIXTURE_ARGS_FILE = file;
    await call(new HunkAdapter(FAKE));
    return readFileSync(file, "utf8").trim();
  }

  it("appends --json for the flat commands, which have no separator to precede", async () => {
    expect(await argvOf((h) => h.getSession("/wt/x"))).toBe("session get --repo /wt/x --json");
    expect(await argvOf((h) => h.listComments("/wt/x", "user"))).toBe(
      "session comment list --repo /wt/x --type user --json",
    );
    expect(await argvOf((h) => h.removeComment("/wt/x", "c1"))).toBe(
      "session comment rm --repo /wt/x c1 --json",
    );
    expect(await argvOf((h) => h.navigate("/wt/x", { nextComment: true }))).toBe(
      "session navigate --repo /wt/x --next-comment --json",
    );
    expect(await argvOf((h) => h.applyComments("/wt/x", [{ id: "n1" }]))).toBe(
      "session comment apply --repo /wt/x --stdin --json",
    );
  });
});

describe("fake-hunk argv strictness", () => {
  it("refuses a --json that appears after the `--` separator, matching Hunk", async () => {
    const adapter = new HunkAdapter(FAKE) as unknown as {
      json: (args: string[]) => Promise<unknown>;
    };
    await expect(
      adapter.json(["session", "reload", "--repo", "/wt/x", "--", "diff", "--json"]),
    ).rejects.toThrow(/unknown option '--json'/);
  });

  describe("fake-hunk `session navigate` strictness", () => {
    const adapter = new HunkAdapter(FAKE) as unknown as {
      json: (args: string[]) => Promise<unknown>;
    };

    it("refuses two navigation targets, matching Hunk", async () => {
      await expect(
        adapter.json([
          "session",
          "navigate",
          "--repo",
          "/wt/x",
          "--file",
          "a.ts",
          "--hunk",
          "1",
          "--old-line",
          "5",
        ]),
      ).rejects.toThrow(/Specify exactly one navigation target/);
    });

    it("refuses zero navigation targets, matching Hunk", async () => {
      await expect(
        adapter.json(["session", "navigate", "--repo", "/wt/x", "--file", "a.ts"]),
      ).rejects.toThrow(/Specify exactly one navigation target/);
    });

    it("refuses an absolute target given with no --file, matching Hunk", async () => {
      await expect(
        adapter.json(["session", "navigate", "--repo", "/wt/x", "--hunk", "1"]),
      ).rejects.toThrow(/Specify --file <path> with a navigation target/);
    });

    it("refuses --next-comment and --prev-comment together, matching Hunk", async () => {
      await expect(
        adapter.json([
          "session",
          "navigate",
          "--repo",
          "/wt/x",
          "--next-comment",
          "--prev-comment",
        ]),
      ).rejects.toThrow(/Specify either --next-comment or --prev-comment, not both/);
    });

    it("does not invent a --file refusal for the relative forms, matching Hunk", async () => {
      await expect(
        adapter.json([
          "session",
          "navigate",
          "--repo",
          "/wt/x",
          "--file",
          "a.ts",
          "--next-comment",
        ]),
      ).resolves.toEqual({ navigated: true });
    });

    it("still accepts the well-formed absolute and relative forms", async () => {
      await expect(
        adapter.json(["session", "navigate", "--repo", "/wt/x", "--file", "a.ts", "--hunk", "1"]),
      ).resolves.toEqual({ navigated: true });
      await expect(
        adapter.json(["session", "navigate", "--repo", "/wt/x", "--next-comment"]),
      ).resolves.toEqual({ navigated: true });
      await expect(
        adapter.json(["session", "navigate", "--repo", "/wt/x", "--prev-comment"]),
      ).resolves.toEqual({ navigated: true });
    });
  });
});

describe("HunkAdapter", () => {
  it("lists only user comments when asked", async () => {
    const comments = await hunk.listComments("/wt/x", "user");
    expect(comments[0].noteId).toBe("user:1786393885051-1");
    expect(comments[0].body).toBe("Tighten this");
    expect(comments[0].newRange).toEqual([10, 10]);
    expect(comments[0]).not.toHaveProperty("rationale");
  });

  it("classifies a missing session as loopback-blocked-or-absent", async () => {
    const broken = new HunkAdapter(FAKE);
    await expect(broken.getSession("__no_session__")).rejects.toBeInstanceOf(HunkUnavailableError);
  });

  it("tags the no-session error with the sandbox loopback hint", async () => {
    const broken = new HunkAdapter(FAKE);
    await expect(broken.getSession("__no_session__")).rejects.toMatchObject({
      reason: "no-session",
      message: expect.stringContaining("127.0.0.1:47657"),
    });
  });

  it("surfaces missing-binary when the hunk executable cannot be spawned", async () => {
    const missing = new HunkAdapter("/nonexistent/bin/hunk-does-not-exist");
    await expect(missing.getSession("/wt/x")).rejects.toMatchObject({
      reason: "missing-binary",
    });
  });
});

describe("parseHunkComments", () => {
  it("accepts the fields needed for delivery and deduplication", () => {
    expect(parseHunkComments([{ noteId: "c1", filePath: "src/a.ts", body: "Fix this" }])).toEqual([
      { noteId: "c1", filePath: "src/a.ts", body: "Fix this" },
    ]);
  });

  it.each([
    ["a non-array list", { noteId: "c1" }],
    ["a missing id", [{ filePath: "src/a.ts", body: "Fix this" }]],
    ["an empty id", [{ noteId: "", filePath: "src/a.ts", body: "Fix this" }]],
    ["a missing path", [{ noteId: "c1", body: "Fix this" }]],
    ["a missing body", [{ noteId: "c1", filePath: "src/a.ts" }]],
  ])("rejects %s", (_label, value) => {
    expect(() => parseHunkComments(value)).toThrow(HunkProtocolError);
  });
});
