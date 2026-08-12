import { afterEach, describe, expect, it, vi } from "vitest";
import * as git from "../src/git.js";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntime, dispatch } from "../src/runtime.js";

describe("buildRuntime target laziness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("setup-keys succeeds and never shells out to git when the resolved cwd is not a git repository", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "hunkdiff-home-"));
    mkdirSync(join(fakeHome, ".config", "herdr"), { recursive: true });

    const nonGitCwd = mkdtempSync(join(tmpdir(), "hunkdiff-nogit-"));

    const originalHome = process.env.HOME;
    const runnerSpy = vi.spyOn(git, "realRunner");

    let code: number;
    try {
      process.env.HOME = fakeHome;
      const rt = buildRuntime({
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: nonGitCwd }),
      });
      code = await dispatch("setup-keys", rt);
    } finally {
      process.env.HOME = originalHome;
    }

    expect(code).toBe(0);
    expect(runnerSpy).not.toHaveBeenCalled();

    const installed = readFileSync(join(fakeHome, ".config", "herdr", "config.toml"), "utf8");
    expect(installed).toContain("prefix+shift+h");
  });

  it("still resolves a Target via git the first time something actually reads rt.target", () => {
    const nonGitCwd = mkdtempSync(join(tmpdir(), "hunkdiff-nogit-"));
    const runnerSpy = vi.spyOn(git, "realRunner");

    const rt = buildRuntime({
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: nonGitCwd }),
    });
    void rt.target;

    expect(runnerSpy).toHaveBeenCalled();
  });
});
