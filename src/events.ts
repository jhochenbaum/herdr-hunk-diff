import { paneEntrypointFor } from "./actions.js";
import type { Placement, PluginConfig } from "./config.js";
import { reportFailure } from "./herdr.js";
import type { ReviewIndex } from "./index-store.js";
import { asObject, asString, parseJsonObject, type JsonObject } from "./json.js";

/**
 * Global manifest hooks. Socket subscriptions require a pane id for agent status events and cannot
 * cover every pane.
 */
export const HOOKED_EVENTS = [
  "pane.agent_status_changed",
  "pane.exited",
  "pane.closed",
  "worktree.removed",
] as const;

export interface EventDeps {
  cfg: PluginConfig;
  index: ReviewIndex;
  herdr: {
    notify: (msg: string) => void;
    openPane: (opts: {
      entrypoint: string;
      cwd: string;
      placement: Placement;
      targetPane?: string;
    }) => string | null;
    closePane: (paneId: string) => void;
  };
  worktreeForPane: (paneId: string) => string | null;
  /** Re-points an existing review to the worktree's current default target. */
  reloadReview: (worktree: string) => Promise<void>;
}

export interface HerdrEvent {
  type: string;
  data: JsonObject;
}

/** Normalizes dotted manifest names and snake_case payload names. */
function normalizeType(value: unknown): string {
  return typeof value === "string" ? value.replace(/\./g, "_") : "";
}

/** Parses the nested event payload without accepting malformed top-level field fallbacks. */
export function parseEvent(
  name: string | undefined,
  payloadJson: string | undefined,
): HerdrEvent | null {
  const payload = parseJsonObject(payloadJson);
  if (!payload) return null;
  const data = asObject(payload.data);
  if (!data) return null;

  const type = normalizeType(data.type ?? payload.event ?? name);
  if (!type) return null;

  return { type, data };
}

/** Handles one event and returns the status recorded in Herdr's plugin log. */
export async function handleEvent(event: HerdrEvent, deps: EventDeps): Promise<number> {
  switch (event.type) {
    case "worktree_removed":
      return worktreeRemoved(event.data, deps);
    case "pane_exited":
    case "pane_closed":
      return paneGone(event.data, deps);
    case "pane_agent_status_changed":
      return agentStatusChanged(event.data, deps);
    default:
      return 0;
  }
}

function worktreeRemoved(data: JsonObject, deps: EventDeps): number {
  // Current payloads use `worktree.path`; `path` remains a compatibility fallback.
  const path = asString(asObject(data.worktree)?.path) ?? asString(data.path) ?? "";
  if (!path) return 0;

  const entry = deps.index.get(path);
  if (entry?.paneId) deps.herdr.closePane(entry.paneId);
  deps.index.remove(path);
  return 0;
}

/** Clears display state while preserving sent-comment history. */
function paneGone(data: JsonObject, deps: EventDeps): number {
  const paneId = asString(data.pane_id);
  if (!paneId) return 0;
  for (const entry of deps.index.all()) {
    if (entry.paneId === paneId) deps.index.clearPane(entry.worktree);
  }
  return 0;
}

async function agentStatusChanged(data: JsonObject, deps: EventDeps): Promise<number> {
  const status = asString(data.agent_status) ?? "";
  const paneId = asString(data.pane_id) ?? "";
  if (!deps.cfg.review.on_states.some((state) => state === status)) return 0;

  const worktree = deps.worktreeForPane(paneId);
  if (!worktree) {
    return reportFailure(
      deps.herdr,
      `An agent in pane ${paneId} reached "${status}", but herdr reported no worktree for that ` +
        "pane, so no review was prepared. `herdr agent list` lists no agent with that pane id " +
        "(or could not be reached).",
    );
  }

  deps.index.upsert({
    worktree,
    agentName: asString(data.agent),
    agentPaneId: paneId,
    sent: deps.index.sentIds(worktree),
  });

  if (!deps.cfg.review.auto_open) return 0;

  const existing = deps.index.get(worktree);
  if (deps.cfg.review.reuse_pane && existing?.paneId) {
    try {
      await deps.reloadReview(worktree);
      deps.index.upsert({
        worktree,
        requestedMode: null,
        sent: deps.index.sentIds(worktree),
      });
      return 0;
    } catch {
      // A stale pane id must not prevent a fresh auto-open; preserve delivery history.
      deps.index.clearPane(worktree);
    }
  }

  const entrypoint = paneEntrypointFor("review");
  const pane = deps.herdr.openPane({
    entrypoint,
    cwd: worktree,
    placement: deps.cfg.review.placement,
    targetPane: paneId,
  });
  // Plain review entrypoints use the config default, so clear any previously explicit mode.
  deps.index.upsert({
    worktree,
    paneId: pane ?? undefined,
    requestedMode: null,
    sent: deps.index.sentIds(worktree),
  });
  if (!pane) {
    return reportFailure(
      deps.herdr,
      `An agent finished in ${worktree}, but the review pane could not be opened ` +
        `(entrypoint "${entrypoint}"): herdr returned no pane id. ` +
        "`herdr plugin log list` has the open that failed.",
    );
  }
  return 0;
}

/** Resolves a pane's agent cwd and canonicalizes it to repository identity when possible. */
export function worktreeForPaneVia(
  herdr: { agentList: () => Array<{ pane_id?: string; cwd?: string }> },
  repoRoot: (dir: string) => string | null,
): (paneId: string) => string | null {
  return (paneId) => {
    if (!paneId) return null;
    for (const agent of herdr.agentList()) {
      if (agent.pane_id === paneId && agent.cwd) return repoRoot(agent.cwd) ?? agent.cwd;
    }
    return null;
  };
}
