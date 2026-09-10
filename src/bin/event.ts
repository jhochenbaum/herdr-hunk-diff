#!/usr/bin/env node
import { loadConfig } from "../config.js";
import { HerdrAdapter, resolveHunkLauncher } from "../herdr.js";
import { HunkAdapter } from "../hunk.js";
import { ReviewIndex } from "../index-store.js";
import { realRunner, realTargetDeps, repoRoot } from "../git.js";
import { resolveTarget } from "../target.js";
import { handleEvent, parseEvent, worktreeForPaneVia, type EventDeps } from "../events.js";
import { isMainModule } from "./main-guard.js";
import { reportReviewMetadata } from "../metadata.js";

/** Builds dependencies for one short-lived manifest event-hook process. */
export interface EventBinDeps {
  buildDeps: (env: NodeJS.ProcessEnv) => EventDeps;
}

const defaultDeps: EventBinDeps = {
  buildDeps: (env) => {
    const herdr = new HerdrAdapter(env.HERDR_BIN_PATH ?? "herdr");
    const cfg = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR ?? ".");
    const pluginRoot = env.HERDR_PLUGIN_ROOT ?? process.cwd();
    // Resolved per worktree: which launcher applies can differ across the events one process
    // may see, and the choice depends on that worktree's own resolution (see resolveHunkLauncher).
    const hunkFor = (worktree: string): HunkAdapter => {
      const launcher = resolveHunkLauncher(cfg, pluginRoot, worktree);
      return new HunkAdapter(launcher.bin, launcher.prefix);
    };
    const index = new ReviewIndex(env.HERDR_PLUGIN_STATE_DIR ?? ".");
    return {
      cfg,
      index,
      herdr,
      worktreeForPane: worktreeForPaneVia(herdr, (dir) => repoRoot(dir, realRunner(dir))),
      resolveTarget: (worktree) =>
        resolveTarget({ cwd: worktree }, cfg, realTargetDeps(realRunner)),
      reloadReview: (target) => hunkFor(target.worktree).reload(target.worktree, target, cfg),
      reportReviewMetadata: (worktree) =>
        reportReviewMetadata({ index, herdr, hunk: hunkFor(worktree) }, worktree),
    };
  },
};

export async function main(
  env: NodeJS.ProcessEnv,
  deps: EventBinDeps = defaultDeps,
): Promise<number> {
  const event = parseEvent(env.HERDR_PLUGIN_EVENT, env.HERDR_PLUGIN_EVENT_JSON);
  if (!event) {
    console.error(
      "hunkdiff: could not read the event payload;",
      "HERDR_PLUGIN_EVENT=",
      env.HERDR_PLUGIN_EVENT ?? "(unset)",
      "HERDR_PLUGIN_EVENT_JSON=",
      env.HERDR_PLUGIN_EVENT_JSON ?? "(unset)",
    );
    return 1;
  }

  return await handleEvent(event, deps.buildDeps(env));
}

if (isMainModule(import.meta.url)) {
  process.exit(await main(process.env));
}
