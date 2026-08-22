import type { TargetMode } from "./config.js";

/** Review action ids shared by dispatch and the pane entrypoint. */
export const REVIEW_ACTIONS = [
  "review",
  "review:staged",
  "review:branch",
  "review:commit",
  "review:stash",
] as const;

export type ReviewActionId = (typeof REVIEW_ACTIONS)[number];

export function isReviewAction(id: string): id is ReviewActionId {
  return (REVIEW_ACTIONS as readonly string[]).includes(id);
}

/** `mode: undefined` delegates to `review.default_target`. */
export interface ReviewRequest {
  mode?: TargetMode;
  /** Whether the pane should recover a positional ref from the review index. */
  takesRef: boolean;
}

const REQUESTS: Record<ReviewActionId, ReviewRequest> = {
  review: { takesRef: false },
  "review:staged": { mode: "staged", takesRef: false },
  "review:branch": { mode: "branch", takesRef: true },
  "review:commit": { mode: "commit", takesRef: true },
  "review:stash": { mode: "stash", takesRef: true },
};

export function reviewRequestFor(id: ReviewActionId): ReviewRequest {
  return REQUESTS[id];
}

/** Maps action ids to the manifest pane entrypoints that carry their mode across processes. */
const PANE_ENTRYPOINTS: Record<string, string> = {
  review: "review",
  "review:staged": "review-staged",
  "review:branch": "review-branch",
  "review:commit": "review-commit",
  "review:stash": "review-stash",
};

/** Selects the cmd-based manifest entry for a Windows pane. */
export const WINDOWS_PANE_SUFFIX = "-windows";

export function paneEntrypointFor(
  id: ReviewActionId,
  platform: NodeJS.Platform = process.platform,
): string {
  const entrypoint = PANE_ENTRYPOINTS[id];
  if (!entrypoint) throw new Error(`No review pane entrypoint for action "${id}"`);
  return platform === "win32" ? `${entrypoint}${WINDOWS_PANE_SUFFIX}` : entrypoint;
}
