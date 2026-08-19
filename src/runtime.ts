import { spawnSync } from "node:child_process";
import { loadConfig, type PluginConfig, type TargetMode } from "./config.js";
import { readContext, type HerdrContext } from "./context.js";
import { HerdrAdapter, reportFailure, resolveHunkLauncher } from "./herdr.js";
import { canReload, HunkAdapter, HunkProtocolError, HunkUnavailableError } from "./hunk.js";
import { ReviewIndex, type ReviewEntry } from "./index-store.js";
import { formatReview, selectUnsent } from "./courier.js";
import { parseGithubUrl } from "./notes.js";
import { installPager, realPagerEffects, uninstallPager } from "./pager.js";
import { resolveTarget, type Target } from "./target.js";
import { commitExists, hasCommitsAhead, realRunner, repoRoot, resolveBaseRef } from "./git.js";
import {
  isReviewAction,
  paneEntrypointFor,
  reviewRequestFor,
  type ReviewActionId,
} from "./actions.js";
import { DEFAULT_BINDINGS } from "./keys.js";
import { installKeys, removeKeys, resolveHerdrConfigPath } from "./keys-install.js";

export interface Runtime {
  cfg: PluginConfig;
  ctx: HerdrContext;
  pluginRoot: string;
  /** Shared directory for the review index and note sidecars. */
  stateDir: string;
  index: ReviewIndex;
  herdr: Pick<HerdrAdapter, "notify" | "promptAgent" | "openPane" | "closePane" | "reportMetadata">;
  hunk: Pick<HunkAdapter, "listComments" | "removeComment" | "reload" | "navigate">;
  /** Config-driven target, equivalent to `targetFor()`. */
  target: Target;
  /** Resolves an optional action-specific mode and ref. */
  targetFor: (mode?: TargetMode, ref?: string) => Target;
  commitExists: (repo: string, ref: string) => boolean;
}

export function buildRuntime(env: NodeJS.ProcessEnv): Runtime {
  const cfg = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR ?? ".");
  const ctx = readContext(env);
  const pluginRoot = env.HERDR_PLUGIN_ROOT ?? process.cwd();

  // Avoid Git subprocesses for actions that never inspect a review target.
  const targetDeps = {
    resolveBaseRef: (repo: string) => resolveBaseRef(repo, realRunner(repo)),
    hasCommitsAhead: (repo: string, base: string) => hasCommitsAhead(repo, base, realRunner(repo)),
    repoRoot: (dir: string) => repoRoot(dir, realRunner(dir)),
  };

  let resolvedTarget: Target | undefined;
  const targetFor = (mode?: TargetMode, ref?: string): Target => {
    if (mode === undefined && ref === undefined) {
      return (resolvedTarget ??= resolveTarget(ctx, cfg, targetDeps));
    }
    return resolveTarget(ctx, cfg, targetDeps, mode, ref);
  };

  const stateDir = env.HERDR_PLUGIN_STATE_DIR ?? ".";
  const hunkLauncher = resolveHunkLauncher(cfg, pluginRoot);

  return {
    cfg,
    ctx,
    pluginRoot,
    stateDir,
    index: new ReviewIndex(stateDir),
    herdr: new HerdrAdapter(env.HERDR_BIN_PATH ?? "herdr"),
    hunk: new HunkAdapter(hunkLauncher.bin, hunkLauncher.prefix),
    targetFor,
    commitExists: (repo, ref) => commitExists(repo, ref, realRunner(repo)),
    get target(): Target {
      return targetFor();
    },
  };
}

// Metadata is cosmetic and only applies while a review pane is open.
async function reportReviewMetadata(rt: Runtime, target: Target): Promise<void> {
  if (!("reportMetadata" in rt.herdr)) return;
  const entry = rt.index.get(target.worktree);
  if (!entry?.paneId) return;
  const unsentCount = selectUnsent(
    await rt.hunk.listComments(target.worktree, "user").catch(() => []),
    rt.index.sentIds(target.worktree),
  ).length;
  try {
    rt.herdr.reportMetadata(entry.paneId, {
      title: `Review: ${target.worktree.split("/").pop()}`,
      display_agent: unsentCount > 0 ? `hunk (${unsentCount} unsent)` : "hunk",
    });
  } catch {
    // Metadata failures must not fail a completed action.
  }
}

/**
 * Records what the pane displays for the separate pane process and later reloads. Store only the
 * caller-supplied ref; derived branch ranges must be resolved again.
 */
function displayedReviewRecord(
  target: Target,
  suppliedRef: string | undefined,
): Pick<ReviewEntry, "requestedMode" | "requestedRef"> {
  return {
    requestedRef: suppliedRef ?? null,
    requestedMode: target.mode,
  };
}

/** Opens or re-points a review using the mode encoded by its action id. */
async function reviewAction(actionId: ReviewActionId, rt: Runtime): Promise<number> {
  const request = reviewRequestFor(actionId);

  const suppliedRef = commitRefFromContext(actionId, rt);

  const target = rt.targetFor(request.mode, suppliedRef);
  if (target.warning) rt.herdr.notify(target.warning);

  // hunk writes its own failure into a pane herdr then tears down, so the message never lands.
  if (suppliedRef !== undefined && !rt.commitExists(target.worktree, suppliedRef)) {
    return reportFailure(
      rt.herdr,
      `Could not resolve ${suppliedRef} in ${target.worktree}. ` +
        "Fetch the commit, then try the link again.",
    );
  }

  const existing = rt.index.get(target.worktree);
  if (rt.cfg.review.reuse_pane && existing?.paneId && canReload(target.mode)) {
    try {
      await rt.hunk.reload(target.worktree, target, rt.cfg);
      rt.index.upsert({
        worktree: target.worktree,
        ...displayedReviewRecord(target, suppliedRef),
        sent: [],
      });
      await reportReviewMetadata(rt, target);
      return 0;
    } catch (err) {
      // The pane may be stale; preserve sent history and fall through to a fresh open.
      rt.index.clearPane(target.worktree);
      rt.herdr.notify(
        `Could not reuse the open review pane; opening a new one. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Herdr starts the pane process during openPane, so its launch state must already be persisted.
  rt.index.upsert({
    worktree: target.worktree,
    agentName: rt.ctx.agentName,
    agentPaneId: agentPaneFromContext(rt),
    ...displayedReviewRecord(target, suppliedRef),
    sent: [],
  });

  const entrypoint = paneEntrypointFor(actionId);
  const paneId = rt.herdr.openPane({
    entrypoint,
    cwd: target.worktree,
    placement: rt.cfg.review.placement,
  });
  if (!paneId) {
    return reportFailure(
      rt.herdr,
      `Could not open the hunk review pane for ${target.worktree} (entrypoint "${entrypoint}"): ` +
        "herdr returned no pane id. Check that the plugin is linked and built " +
        "(`herdr plugin list`), then `herdr plugin log list` for the open that failed.",
    );
  }
  // The pane id is only available after launch; undefined fields preserve the pre-launch record.
  rt.index.upsert({ worktree: target.worktree, paneId, sent: [] });
  await reportReviewMetadata(rt, target);
  return 0;
}

/** Returns the invoking pane only when Herdr reports that it runs an agent. */
function agentPaneFromContext(rt: Runtime): string | undefined {
  return rt.ctx.agentName ? rt.ctx.paneId : undefined;
}

/** Extracts a commit-ish from a commit-review link invocation. */
function commitRefFromContext(actionId: ReviewActionId, rt: Runtime): string | undefined {
  if (actionId !== "review:commit" || !rt.ctx.clickedUrl) return undefined;
  const parsed = parseGithubUrl(rt.ctx.clickedUrl);
  if (parsed?.kind === "pull") {
    rt.herdr.notify(
      "hunk: GitHub pull request links aren't supported (that needs a network call); " +
        "reviewing the most recent commit instead.",
    );
    return undefined;
  }
  return parsed?.ref;
}

async function sendReview(rt: Runtime): Promise<number> {
  const worktree = rt.target.worktree;
  let comments;
  try {
    comments = await rt.hunk.listComments(worktree, "user");
  } catch (err) {
    return reportFailure(
      rt.herdr,
      err instanceof HunkUnavailableError || err instanceof HunkProtocolError
        ? err.message
        : "hunk session unavailable.",
    );
  }

  const unsent = selectUnsent(comments, rt.index.sentIds(worktree));
  if (unsent.length === 0) {
    rt.herdr.notify("No new review comments to send.");
    return 0;
  }

  const entry = rt.index.get(worktree);
  const target = agentPaneFromContext(rt) ?? entry?.agentPaneId;
  const label = rt.ctx.agentName ?? entry?.agentName;
  if (!target) {
    return reportFailure(rt.herdr, "No agent is associated with this worktree; comments kept.");
  }

  const text = formatReview(unsent, worktree, rt.cfg, label);
  if (!rt.herdr.promptAgent(target, text)) {
    return reportFailure(rt.herdr, `Could not prompt agent "${label ?? target}"; comments kept.`);
  }

  // Record delivery before cleanup so a removal failure cannot cause a duplicate prompt.
  rt.index.markSent(
    worktree,
    unsent.map((c) => c.noteId),
  );
  if (rt.cfg.roundtrip.clear_after_send) {
    for (const c of unsent) {
      try {
        await rt.hunk.removeComment(worktree, c.noteId);
      } catch {
        rt.herdr.notify(
          `Sent comment ${c.noteId} to ${label ?? target}, but could not remove it from hunk; it will stay visible.`,
        );
      }
    }
  }
  rt.herdr.notify(`Sent ${unsent.length} comment(s) to ${label ?? target}.`);
  await reportReviewMetadata(rt, rt.target);
  return 0;
}

function hunkErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Navigates the viewer and turns adapter failures into visible action failures. */
async function navigateAction(
  rt: Runtime,
  direction: "next" | "previous",
  request: Parameters<Runtime["hunk"]["navigate"]>[1],
): Promise<number> {
  try {
    await rt.hunk.navigate(rt.target.worktree, request);
    return 0;
  } catch (err) {
    return reportFailure(
      rt.herdr,
      `Could not move to the ${direction} comment. ${hunkErrorMessage(err)}`,
    );
  }
}

export async function dispatch(actionId: string, rt: Runtime): Promise<number> {
  if (isReviewAction(actionId)) return reviewAction(actionId, rt);

  switch (actionId) {
    case "send-review":
      return sendReview(rt);
    case "reload": {
      // Reload the displayed mode, falling back to config only when no mode was recorded.
      const recorded = rt.index.get(rt.target.worktree);
      const target = recorded?.requestedMode
        ? rt.targetFor(recorded.requestedMode, recorded.requestedRef ?? undefined)
        : rt.target;
      if (!canReload(target.mode)) {
        return reportFailure(
          rt.herdr,
          `hunk cannot reload a ${target.mode} review in place; close it and open a new one.`,
        );
      }
      try {
        await rt.hunk.reload(target.worktree, target, rt.cfg);
      } catch (err) {
        return reportFailure(rt.herdr, `Could not reload the review. ${hunkErrorMessage(err)}`);
      }
      return 0;
    }
    case "close-review": {
      const entry = rt.index.get(rt.target.worktree);
      if (!entry?.paneId) {
        rt.herdr.notify("No review pane is open for this worktree.");
        return 0;
      }
      if (!rt.herdr.closePane(entry.paneId)) {
        return reportFailure(
          rt.herdr,
          `Could not close the review pane ${entry.paneId}; it is still on screen. ` +
            "It may already be gone from herdr's side — `herdr plugin log list` has the refusal.",
        );
      }
      return 0;
    }
    case "next-comment":
      return navigateAction(rt, "next", { nextComment: true });
    case "prev-comment":
      return navigateAction(rt, "previous", { prevComment: true });
    case "install-pager":
    case "uninstall-pager":
      return pagerAction(actionId, rt);
    case "setup-keys": {
      const res = installKeys(resolveHerdrConfigPath(process.env), DEFAULT_BINDINGS);
      rt.herdr.notify(res.message);
      return res.ok ? 0 : 1;
    }
    case "remove-keys": {
      const res = removeKeys(resolveHerdrConfigPath(process.env));
      rt.herdr.notify(res.message);
      return res.ok ? 0 : 1;
    }
    default:
      return 2;
  }
}

/** Wires pager decisions to the user's real PATH and global Git config. */
function pagerAction(actionId: string, rt: Runtime): number {
  const effects = realPagerEffects(process.env, (cmd, args) => {
    const result = spawnSync(cmd, args, { encoding: "utf8" });
    return { status: result.status ?? 1, stdout: result.stdout ?? "" };
  });
  const result =
    actionId === "install-pager"
      ? installPager(effects, rt.cfg.hunk.bin)
      : uninstallPager(effects, rt.cfg.hunk.bin);
  rt.herdr.notify(result.message);
  return result.ok ? 0 : 1;
}
