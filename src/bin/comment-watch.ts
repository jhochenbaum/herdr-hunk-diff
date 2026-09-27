#!/usr/bin/env node
import { loadConfig } from "../config.js";
import { resolveHunkLauncher } from "../herdr.js";
import { HunkAdapter, type HunkComment } from "../hunk.js";
import { ReviewIndex } from "../index-store.js";
import { selectUnsent } from "../courier.js";
import { loadSavedComments, saveComments } from "../saved-comments.js";
import { isMainModule } from "./main-guard.js";

const INTERVAL_MS = 3000;

export interface WatchDeps {
  listComments: (worktree: string) => Promise<HunkComment[]>;
  sentIds: (worktree: string) => string[];
  stateDir: string;
}

/**
 * Starts a snapshot that keeps comments saved by earlier viewers, so reopening a review does not
 * overwrite them with the new viewer's empty list. Comments deleted in this viewer drop out.
 */
export function commentSnapshotter(worktree: string, deps: WatchDeps): () => Promise<void> {
  const carried = loadSavedComments(deps.stateDir, worktree);
  return async () => {
    let live: HunkComment[];
    try {
      live = await deps.listComments(worktree);
    } catch {
      // The session may not be up yet, or already gone; keep the last snapshot.
      return;
    }
    const liveIds = new Set(live.map((c) => c.noteId));
    const merged = [...carried.filter((c) => !liveIds.has(c.noteId)), ...live];
    saveComments(deps.stateDir, worktree, selectUnsent(merged, deps.sentIds(worktree)));
  };
}

function parentAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function watch(worktree: string, parentPid: number, env: NodeJS.ProcessEnv): Promise<void> {
  const cfg = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR ?? ".");
  const launcher = resolveHunkLauncher(cfg, env.HERDR_PLUGIN_ROOT ?? process.cwd());
  const hunk = new HunkAdapter(launcher.bin, launcher.prefix);
  const stateDir = env.HERDR_PLUGIN_STATE_DIR ?? ".";
  const index = new ReviewIndex(stateDir);
  const snapshot = commentSnapshotter(worktree, {
    listComments: (wt) => hunk.listComments(wt, "user"),
    sentIds: (wt) => index.sentIds(wt),
    stateDir,
  });

  // The pane stops this process when hunk exits; the parent check covers a pane that was killed.
  while (parentAlive(parentPid)) {
    await snapshot();
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

if (isMainModule(import.meta.url)) {
  const [, , worktree, parentPid] = process.argv;
  if (worktree && parentPid) await watch(worktree, Number(parentPid), process.env);
}
