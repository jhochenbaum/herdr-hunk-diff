#!/usr/bin/env node
import { loadConfig } from "../config.js";
import { HerdrAdapter, resolveHunkLauncher } from "../herdr.js";
import { HunkAdapter } from "../hunk.js";
import { ReviewIndex } from "../index-store.js";
import { hasCommitsAhead, realRunner, repoRoot, resolveBaseRef } from "../git.js";
import { resolveTarget } from "../target.js";
import { handleEvent, parseEvent, worktreeForPaneVia, type EventDeps } from "../events.js";
import { isMainModule } from "./main-guard.js";

/** Builds dependencies for one short-lived manifest event-hook process. */
export interface EventBinDeps {
  buildDeps: (env: NodeJS.ProcessEnv) => EventDeps;
}

const defaultDeps: EventBinDeps = {
  buildDeps: (env) => {
    const herdr = new HerdrAdapter(env.HERDR_BIN_PATH ?? "herdr");
    const cfg = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR ?? ".");
    const launcher = resolveHunkLauncher(cfg, env.HERDR_PLUGIN_ROOT ?? process.cwd());
    const hunk = new HunkAdapter(launcher.bin, launcher.prefix);
    return {
      cfg,
      index: new ReviewIndex(env.HERDR_PLUGIN_STATE_DIR ?? "."),
      herdr,
      worktreeForPane: worktreeForPaneVia(herdr, (dir) => repoRoot(dir, realRunner(dir))),
      reloadReview: (worktree) => {
        const target = resolveTarget({ cwd: worktree }, cfg, {
          resolveBaseRef: (repo) => resolveBaseRef(repo, realRunner(repo)),
          hasCommitsAhead: (repo, base) => hasCommitsAhead(repo, base, realRunner(repo)),
          repoRoot: (dir) => repoRoot(dir, realRunner(dir)),
        });
        return hunk.reload(worktree, target, cfg);
      },
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
