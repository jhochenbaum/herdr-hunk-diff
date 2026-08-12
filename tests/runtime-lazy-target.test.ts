import { afterEach, describe, expect, it, vi } from "vitest";
import * as git from "../src/git.js";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntime, dispatch } from "../src/runtime.js";

describe("buildRuntime target laziness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("setup-keys succeeds and never shells out to git when the resolved cwd is not a git repository", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "hunkdiff-home-"));
    mkdirSync(join(fakeHome, ".config", "herdr"), { recursive: true });
    const configPath = join(fakeHome, ".config", "herdr", "config.toml");

    const nonGitCwd = mkdtempSync(join(tmpdir(), "hunkdiff-nogit-"));

    const runnerSpy = vi.spyOn(git, "realRunner");
    vi.stubEnv("HERDR_CONFIG_PATH", configPath);

    const rt = buildRuntime({
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: nonGitCwd }),
    });
    const code = await dispatch("setup-keys", rt);

    expect(code).toBe(0);
    expect(runnerSpy).not.toHaveBeenCalled();

    const installed = readFileSync(configPath, "utf8");
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
