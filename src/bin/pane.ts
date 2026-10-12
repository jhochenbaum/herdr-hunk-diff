#!/usr/bin/env node
import {
  spawn as spawnAsync,
  spawnSync,
  type SpawnSyncReturns,
  type StdioOptions,
} from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isReviewAction, reviewRequestFor, type ReviewRequest } from "../actions.js";
import { loadConfig } from "../config.js";
import { readContext } from "../context.js";
import { HerdrAdapter, resolveHunkLauncher } from "../herdr.js";
import { buildLaunchArgs } from "../hunk.js";
import { ReviewIndex } from "../index-store.js";
import { realRunner, realTargetDeps } from "../git.js";
import { sidecarPath } from "../notes.js";
import { loadSavedComments } from "../saved-comments.js";
import { selectUnsent } from "../courier.js";
import { resolveTarget, type Target } from "../target.js";
import { isMainModule } from "./main-guard.js";

export type SpawnFn = (
  bin: string,
  args: string[],
  opts: { stdio: StdioOptions; cwd: string },
) => Pick<SpawnSyncReturns<Buffer>, "status">;

/** Starts saving the worktree's unsent comments and returns a function that stops it. */
export type WatchFn = (worktree: string, env: NodeJS.ProcessEnv) => () => void;

const noWatch: WatchFn = () => () => {};

/** Lines of hunk's stderr quoted in a failure notification, and their combined length cap. */
const STDERR_TAIL_LINES = 3;
const STDERR_TAIL_CHARS = 300;

interface StderrLog {
  fd: number;
  /** Closes the log, replays it to this process's stderr, and returns its text. */
  drain: () => string;
}

/** Sends hunk's stderr to a file rather than a pipe, so a chatty hunk can never fill a buffer. */
function openStderrLog(): StderrLog | undefined {
  try {
    const dir = mkdtempSync(join(tmpdir(), "hunkdiff-stderr-"));
    const path = join(dir, "stderr.log");
    const fd = openSync(path, "w");
    return {
      fd,
      drain: () => {
        let text = "";
        try {
          closeSync(fd);
          text = readFileSync(path, "utf8");
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Losing the captured text only costs the notification its detail.
        }
        if (text) process.stderr.write(text);
        return text;
      },
    };
  } catch {
    return undefined;
  }
}

/** Last few non-empty stderr lines, without terminal escapes, fit for a one-line notification. */
export function stderrTail(text: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = plain
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.slice(-STDERR_TAIL_LINES).join(" / ");
  return tail.length > STDERR_TAIL_CHARS ? `…${tail.slice(-STDERR_TAIL_CHARS)}` : tail;
}

/** Runs the comment snapshotter beside hunk, since spawnSync blocks this process meanwhile. */
export const realWatch: WatchFn = (worktree, env) => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "comment-watch.js");
  const child = spawnAsync(process.execPath, [script, worktree, String(process.pid)], {
    env,
    stdio: "ignore",
  });
  child.on("error", () => {
    // Saving comments is best effort; the review itself must still open.
  });
  return () => child.kill();
};

/** Resolves the action-encoded target and launches hunk from its canonical worktree. */
export function resolveAndRun(
  env: NodeJS.ProcessEnv,
  cwd: string,
  spawn: SpawnFn = spawnSync,
  actionId?: string,
  notify: (message: string) => void = (m) =>
    new HerdrAdapter(env.HERDR_BIN_PATH ?? "herdr").notify(m),
  watch: WatchFn = noWatch,
): number {
  const cfg = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR ?? ".");
  const ctx = readContext(env);

  const request: ReviewRequest =
    actionId && isReviewAction(actionId) ? reviewRequestFor(actionId) : { takesRef: false };

  const stateDir = env.HERDR_PLUGIN_STATE_DIR ?? ".";
  const targetDeps = realTargetDeps(realRunner);
  let target: Target = resolveTarget({ ...ctx, cwd }, cfg, targetDeps, request.mode);

  // Only ref-taking actions consume the value passed through the cross-process index.
  if (request.takesRef) {
    const record = new ReviewIndex(stateDir).get(target.worktree);
    const ref = record?.requestedRef ?? undefined;
    if (ref !== undefined) {
      // Re-resolve because an explicit branch range bypasses base discovery and fallback behavior.
      target = resolveTarget({ ...ctx, cwd }, cfg, targetDeps, request.mode, ref);
    }
  }

  const notesPath = sidecarPath(stateDir, target.worktree);
  let sidecar: string | undefined;
  try {
    readFileSync(notesPath, "utf8");
    sidecar = notesPath;
  } catch {
    sidecar = undefined;
  }

  const launcher = resolveHunkLauncher(cfg, env.HERDR_PLUGIN_ROOT ?? cwd);
  const stopWatch = watch(target.worktree, env);
  const stderrLog = openStderrLog();
  const result = spawn(
    launcher.bin,
    [...launcher.prefix, ...buildLaunchArgs(target, cfg, sidecar)],
    {
      // Keep stderr: herdr closes the pane on a non-zero exit, taking hunk's error with it.
      stdio: ["inherit", "inherit", stderrLog?.fd ?? "inherit"],
      cwd: target.worktree,
    },
  );

  stopWatch();
  const stderr = stderrLog?.drain() ?? "";

  const unsent = selectUnsent(
    loadSavedComments(stateDir, target.worktree),
    new ReviewIndex(stateDir).sentIds(target.worktree),
  );
  if (unsent.length > 0) {
    notify(
      `hunk closed with ${unsent.length} unsent review comment(s). They were saved; ` +
        `run send-review to deliver them.`,
    );
  }

  // hunk's own stderr dies with the pane herdr closes on a non-zero exit, so report it out of band.
  if (result.status !== 0) {
    const detail = stderrTail(stderr);
    notify(
      `hunk exited ${result.status ?? "abnormally"} for the ${target.mode} review of ` +
        `${target.worktree}${target.ref ? ` at ${target.ref}` : ""}` +
        (detail ? `: ${detail}` : "."),
    );
  }

  // Delete only after hunk consumes it successfully, so failed launches remain retryable.
  if (sidecar && result.status === 0) {
    try {
      rmSync(sidecar, { force: true });
    } catch {
      // A stale sidecar is cosmetic.
    }
  }

  return result.status ?? 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(
    resolveAndRun(process.env, process.cwd(), spawnSync, process.argv[2], undefined, realWatch),
  );
}
