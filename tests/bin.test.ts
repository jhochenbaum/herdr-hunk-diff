import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndRun } from "../src/bin/pane.js";
import { main } from "../src/bin/action.js";
import { ReviewIndex } from "../src/index-store.js";
import { sidecarPath, writeNotesSidecar } from "../src/notes.js";
import type { Runtime } from "../src/runtime.js";

/**
 * hunk is spawned as `node <bundled launcher> …`, never as the `node_modules/.bin` shim, so the
 * argv a test cares about starts after that prefix. Asserting the prefix here keeps every caller
 * from having to know about it, and fails loudly if the launcher stops being used.
 */
function hunkArgs(call: [string, string[], ...unknown[]]): string[] {
  const [bin, args] = call;
  expect(bin).toBe(process.execPath);
  expect(args[0]).toMatch(/hunkdiff[/\\]bin[/\\]hunk\.cjs$/);
  return args.slice(1);
}

describe("pane.ts resolveAndRun", () => {
  it("reports a non-zero hunk exit, which the closing pane would otherwise swallow", () => {
    const configDir = mkdtempSync(join(tmpdir(), "pane-cfg-"));
    const env: NodeJS.ProcessEnv = { HERDR_PLUGIN_CONFIG_DIR: configDir };
    const notify = vi.fn();

    const code = resolveAndRun(
      env,
      "/wt/resolved",
      vi.fn(() => ({ status: 128 })),
      undefined,
      notify,
    );

    expect(code).toBe(128);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("128"));
  });

  it("stays silent when hunk exits cleanly", () => {
    const configDir = mkdtempSync(join(tmpdir(), "pane-cfg-"));
    const notify = vi.fn();
    resolveAndRun(
      { HERDR_PLUGIN_CONFIG_DIR: configDir },
      "/wt/resolved",
      vi.fn(() => ({ status: 0 })),
      undefined,
      notify,
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("spawns hunk in the directory it was launched in, not the focused pane's", () => {
    const configDir = mkdtempSync(join(tmpdir(), "pane-cfg-"));
    const env: NodeJS.ProcessEnv = {
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: "/wt/somebody-elses-pane" }),
    };
    const spawn = vi.fn(() => ({ status: 0 }));

    const code = resolveAndRun(env, "/wt/resolved", spawn);

    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [, , opts] = spawn.mock.calls[0];
    expect(opts.cwd).toBe("/wt/resolved");
    expect(opts.cwd).not.toBe("/wt/somebody-elses-pane");
  });

  it("passes through the diff args built for the resolved target", () => {
    const configDir = mkdtempSync(join(tmpdir(), "pane-cfg-"));
    const env: NodeJS.ProcessEnv = {
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: "/wt/resolved" }),
    };
    const spawn = vi.fn(() => ({ status: 0 }));

    resolveAndRun(env, "/wt/resolved", spawn);

    expect(hunkArgs(spawn.mock.calls[0])[0]).toBe("diff");
  });

  it("passes --agent-context pointing at a sidecar previously written for this worktree", () => {
    const configDir = mkdtempSync(join(tmpdir(), "pane-cfg-"));
    const stateDir = mkdtempSync(join(tmpdir(), "pane-state-"));
    const expectedPath = writeNotesSidecar(stateDir, "/wt/resolved", [
      { filePath: "src/a.ts", newLine: 3, summary: "Guard null" },
    ])!;
    const env: NodeJS.ProcessEnv = {
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: "/wt/resolved" }),
    };
    const spawn = vi.fn(() => ({ status: 0 }));

    resolveAndRun(env, "/wt/resolved", spawn);

    const args = hunkArgs(spawn.mock.calls[0]);
    const idx = args.indexOf("--agent-context");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe(expectedPath);
  });

  it("omits --agent-context when no sidecar exists for this worktree", () => {
    const configDir = mkdtempSync(join(tmpdir(), "pane-cfg-"));
    const stateDir = mkdtempSync(join(tmpdir(), "pane-state-"));
    const env: NodeJS.ProcessEnv = {
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: "/wt/resolved" }),
    };
    const spawn = vi.fn(() => ({ status: 0 }));

    resolveAndRun(env, "/wt/resolved", spawn);

    expect(hunkArgs(spawn.mock.calls[0])).not.toContain("--agent-context");
  });

  it("does not confuse a sidecar written for a different worktree with this one's", () => {
    const configDir = mkdtempSync(join(tmpdir(), "pane-cfg-"));
    const stateDir = mkdtempSync(join(tmpdir(), "pane-state-"));
    writeNotesSidecar(stateDir, "/wt/other", [
      { filePath: "src/a.ts", newLine: 3, summary: "Guard null" },
    ]);
    const env: NodeJS.ProcessEnv = {
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: "/wt/resolved" }),
    };
    const spawn = vi.fn(() => ({ status: 0 }));

    resolveAndRun(env, "/wt/resolved", spawn);

    expect(hunkArgs(spawn.mock.calls[0])).not.toContain("--agent-context");
    expect(() => readFileSync(sidecarPath(stateDir, "/wt/other"))).not.toThrow();
  });

  describe("receives the requested review mode as its action-id argument", () => {
    function launch(actionId: string | undefined, over: NodeJS.ProcessEnv = {}) {
      const configDir = mkdtempSync(join(tmpdir(), "pane-cfg-"));
      const env: NodeJS.ProcessEnv = {
        HERDR_PLUGIN_CONFIG_DIR: configDir,
        HERDR_PLUGIN_STATE_DIR: mkdtempSync(join(tmpdir(), "pane-state-")),
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: "/wt/resolved" }),
        ...over,
      };
      const spawn = vi.fn(() => ({ status: 0 }));
      const code = resolveAndRun(env, "/wt/resolved", spawn, actionId);
      return { code, spawn, env };
    }

    it("launches `hunk diff --staged` for review:staged", () => {
      const { spawn } = launch("review:staged");
      expect(hunkArgs(spawn.mock.calls[0]).slice(0, 2)).toEqual(["diff", "--staged"]);
    });

    it("launches `hunk show` for review:commit", () => {
      const { spawn } = launch("review:commit");
      expect(hunkArgs(spawn.mock.calls[0]).slice(0, 1)).toEqual(["show"]);
    });

    it("launches `hunk stash show` for review:stash", () => {
      const { spawn } = launch("review:stash");
      expect(hunkArgs(spawn.mock.calls[0]).slice(0, 2)).toEqual(["stash", "show"]);
    });

    it("falls back to the config-driven target when given no action id at all", () => {
      const { spawn } = launch(undefined);
      expect(hunkArgs(spawn.mock.calls[0])[0]).toBe("diff");
      expect(hunkArgs(spawn.mock.calls[0])).not.toContain("--staged");
    });

    it("ignores an argument that is not a review action id", () => {
      const { spawn } = launch("send-review");
      expect(hunkArgs(spawn.mock.calls[0])[0]).toBe("diff");
    });

    it("launches every review action it is given, since none needs an operand", () => {
      for (const id of [
        "review",
        "review:staged",
        "review:branch",
        "review:commit",
        "review:stash",
      ]) {
        const { code, spawn } = launch(id);
        expect(code, id).toBe(0);
        expect(spawn, id).toHaveBeenCalledTimes(1);
      }
    });

    it("shows the commit-ish the invoking action recorded in the review index", () => {
      const stateDir = mkdtempSync(join(tmpdir(), "pane-state-"));
      new ReviewIndex(stateDir).upsert({
        worktree: "/wt/resolved",
        requestedRef: "abc1234def",
        sent: [],
      });
      const { spawn } = launch("review:commit", { HERDR_PLUGIN_STATE_DIR: stateDir });
      expect(hunkArgs(spawn.mock.calls[0]).slice(0, 2)).toEqual(["show", "abc1234def"]);
    });

    it("does not apply a recorded commit-ish to a review that is not a commit review", () => {
      const stateDir = mkdtempSync(join(tmpdir(), "pane-state-"));
      new ReviewIndex(stateDir).upsert({
        worktree: "/wt/resolved",
        requestedRef: "abc1234def",
        sent: [],
      });
      const { spawn } = launch("review:staged", { HERDR_PLUGIN_STATE_DIR: stateDir });
      expect(hunkArgs(spawn.mock.calls[0])).not.toContain("abc1234def");
    });

    describe("the ref the action recorded", () => {
      function launchWithRecord(actionId: string, record: { requestedRef?: string }) {
        const stateDir = mkdtempSync(join(tmpdir(), "pane-state-"));
        new ReviewIndex(stateDir).upsert({ worktree: "/wt/resolved", ...record, sent: [] });
        return launch(actionId, { HERDR_PLUGIN_STATE_DIR: stateDir });
      }

      it("applies a recorded ref to a branch review, which would otherwise derive its own", () => {
        const { spawn } = launchWithRecord("review:branch", { requestedRef: "main...feature" });
        expect(hunkArgs(spawn.mock.calls[0]).slice(0, 2)).toEqual(["diff", "main...feature"]);
      });

      it("applies a recorded ref to a stash review", () => {
        const { spawn } = launchWithRecord("review:stash", { requestedRef: "stash@{2}" });
        expect(hunkArgs(spawn.mock.calls[0]).slice(0, 3)).toEqual(["stash", "show", "stash@{2}"]);
      });

      it("ignores a recorded ref for an action that takes none", () => {
        for (const id of ["review", "review:staged"]) {
          const { spawn } = launchWithRecord(id, { requestedRef: "abc1234def" });
          expect(hunkArgs(spawn.mock.calls[0]), id).not.toContain("abc1234def");
        }
      });
    });
  });

  describe("agent-notes sidecar lifecycle", () => {
    function launchWithSidecar(status: number) {
      const configDir = mkdtempSync(join(tmpdir(), "pane-cfg-"));
      const stateDir = mkdtempSync(join(tmpdir(), "pane-state-"));
      const path = writeNotesSidecar(stateDir, "/wt/resolved", [
        { filePath: "src/a.ts", newLine: 3, summary: "Guard null" },
      ])!;
      const env: NodeJS.ProcessEnv = {
        HERDR_PLUGIN_CONFIG_DIR: configDir,
        HERDR_PLUGIN_STATE_DIR: stateDir,
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: "/wt/resolved" }),
      };
      const spawn = vi.fn(() => ({ status }));
      resolveAndRun(env, "/wt/resolved", spawn, "review");
      return { path, spawn };
    }

    it("deletes the sidecar once hunk has exited cleanly", () => {
      const { path, spawn } = launchWithSidecar(0);
      expect(spawn.mock.calls[0][1]).toContain(path);
      expect(existsSync(path)).toBe(false);
    });

    it("keeps the sidecar when hunk failed, so the notes are not lost undelivered", () => {
      const { path } = launchWithSidecar(2);
      expect(existsSync(path)).toBe(true);
    });
  });

  it("propagates hunk's exit status, defaulting to 1 when status is missing", () => {
    const configDir = mkdtempSync(join(tmpdir(), "pane-cfg-"));
    const env: NodeJS.ProcessEnv = {
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: "/wt/resolved" }),
    };
    expect(
      resolveAndRun(
        env,
        "/wt/resolved",
        vi.fn(() => ({ status: 7 })),
      ),
    ).toBe(7);
    expect(
      resolveAndRun(
        env,
        "/wt/resolved",
        vi.fn(() => ({ status: null })),
      ),
    ).toBe(1);
  });
});

describe("action.ts main", () => {
  function fakeRuntime(): Runtime {
    return {} as Runtime;
  }

  it("dispatches the action id taken from argv[2]", async () => {
    const rt = fakeRuntime();
    const buildRuntime = vi.fn(() => rt);
    const dispatch = vi.fn(async () => 0);

    const code = await main(["node", "action.js", "send-review"], {}, { buildRuntime, dispatch });

    expect(dispatch).toHaveBeenCalledWith("send-review", rt);
    expect(code).toBe(0);
  });

  it("falls back to HERDR_PLUGIN_ACTION_ID when argv has no action id", async () => {
    const rt = fakeRuntime();
    const buildRuntime = vi.fn(() => rt);
    const dispatch = vi.fn(async () => 0);

    await main(
      ["node", "action.js"],
      { HERDR_PLUGIN_ACTION_ID: "reload" },
      { buildRuntime, dispatch },
    );

    expect(dispatch).toHaveBeenCalledWith("reload", rt);
  });

  it("propagates dispatch's exit code back to the caller", async () => {
    const buildRuntime = vi.fn(() => fakeRuntime());
    const dispatch = vi.fn(async () => 2);

    const code = await main(["node", "action.js", "nope"], {}, { buildRuntime, dispatch });

    expect(code).toBe(2);
  });
});
