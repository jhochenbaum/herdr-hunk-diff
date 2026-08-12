#!/usr/bin/env node
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { isReviewAction, reviewRequestFor, type ReviewRequest } from "../actions.js";
import { loadConfig } from "../config.js";
import { readContext } from "../context.js";
import { HerdrAdapter, resolveHunkBin } from "../herdr.js";
import { buildLaunchArgs } from "../hunk.js";
import { ReviewIndex } from "../index-store.js";
import { hasCommitsAhead, realRunner, repoRoot, resolveBaseRef } from "../git.js";
import { sidecarPath } from "../notes.js";
import { resolveTarget, type Target } from "../target.js";
import { isMainModule } from "./main-guard.js";

export type SpawnFn = (
  bin: string,
  args: string[],
  opts: { stdio: "inherit"; cwd: string },
) => Pick<SpawnSyncReturns<Buffer>, "status">;

/** Resolves the action-encoded target and launches hunk from its canonical worktree. */
export function resolveAndRun(
  env: NodeJS.ProcessEnv,
  cwd: string,
  spawn: SpawnFn = spawnSync,
  actionId?: string,
  notify: (message: string) => void = (m) =>
    new HerdrAdapter(env.HERDR_BIN_PATH ?? "herdr").notify(m),
): number {
  const cfg = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR ?? ".");
  const ctx = readContext(env);

  const request: ReviewRequest =
    actionId && isReviewAction(actionId) ? reviewRequestFor(actionId) : { takesRef: false };

  const stateDir = env.HERDR_PLUGIN_STATE_DIR ?? ".";
  const targetDeps = {
    resolveBaseRef: (repo: string) => resolveBaseRef(repo, realRunner(repo)),
    hasCommitsAhead: (repo: string, base: string) => hasCommitsAhead(repo, base, realRunner(repo)),
    repoRoot: (dir: string) => repoRoot(dir, realRunner(dir)),
  };
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

  const bin = resolveHunkBin(cfg, env.HERDR_PLUGIN_ROOT ?? cwd);
  const result = spawn(bin, buildLaunchArgs(target, cfg, sidecar), {
    stdio: "inherit",
    cwd: target.worktree,
  });

  // hunk's own stderr dies with the pane herdr closes on a non-zero exit, so report it out of band.
  if (result.status !== 0) {
    notify(
      `hunk exited ${result.status ?? "abnormally"} for the ${target.mode} review of ` +
        `${target.worktree}${target.ref ? ` at ${target.ref}` : ""}.`,
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
  process.exit(resolveAndRun(process.env, process.cwd(), spawnSync, process.argv[2]));
}
