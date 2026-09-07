import type { PluginConfig, ResolvedTargetMode, TargetMode } from "./config.js";
import type { HerdrContext } from "./context.js";

export interface Target {
  worktree: string;
  mode: ResolvedTargetMode;
  /** Optional positional ref or range consumed by the selected mode. */
  ref?: string;
  warning?: string;
}

export interface TargetDeps {
  resolveBaseRef: (repo: string) => string | null;
  hasCommitsAhead: (repo: string, base: string) => boolean;
  /** Resolves repository identity from an arbitrary directory. */
  repoRoot: (dir: string) => string | null;
  /** Reports tracked changes and, optionally, untracked files. */
  hasWorkingChanges: (repo: string, includeUntracked: boolean) => boolean;
  /** Validates a configured base before it reaches hunk as a range. */
  commitExists: (repo: string, ref: string) => boolean;
}

/** Names what a resolved target displays, for panes and warnings. */
export function describeTarget(target: Omit<Target, "warning">): string {
  switch (target.mode) {
    case "staged":
      return "staged";
    case "branch":
      return target.ref ?? "branch";
    case "commit":
      return target.ref ? `commit ${target.ref}` : "last commit";
    case "stash":
      return target.ref ?? "latest stash";
    default:
      return "working tree";
  }
}

/** Resolves config defaults plus optional action mode and ref overrides. */
export function resolveTarget(
  ctx: HerdrContext,
  cfg: PluginConfig,
  deps: TargetDeps,
  override?: TargetMode,
  refOverride?: string,
): Target {
  const hasContextWorktree = ctx.worktree !== undefined || ctx.cwd !== undefined;
  // Canonicalize arbitrary cwd values so one repository has one index and session identity.
  const worktree =
    ctx.worktree ??
    (() => {
      const dir = ctx.cwd ?? process.cwd();
      return deps.repoRoot(dir) ?? dir;
    })();

  const warnings: string[] = [];
  if (!hasContextWorktree) {
    warnings.push(
      "No worktree resolved from herdr context; using the process working directory instead.",
    );
  }

  const requested = override ?? cfg.review.default_target;

  const withWarning = (target: Omit<Target, "warning">): Target =>
    warnings.length > 0 ? { ...target, warning: warnings.join(" ") } : target;

  // Validate the configured base before constructing a revision range.
  const baseRef = (): string | null => {
    const configured = cfg.review.base.trim();
    if (!configured) return deps.resolveBaseRef(worktree);
    if (deps.commitExists(worktree, configured)) return configured;
    const detected = deps.resolveBaseRef(worktree);
    warnings.push(
      `Configured base "${configured}" does not exist in this repository; ` +
        (detected ? `comparing against ${detected} instead.` : "no base branch resolved."),
    );
    return detected;
  };

  // A branch target without a base would silently become a working-tree diff.
  const branchTarget = (): Omit<Target, "warning"> | null => {
    const base = baseRef();
    if (!base) {
      warnings.push("No base branch resolved; reviewing the working tree instead.");
      return null;
    }
    return { worktree, mode: "branch", ref: `${base}...HEAD` };
  };

  if (requested === "branch") {
    if (refOverride) return withWarning({ worktree, mode: "branch", ref: refOverride });
    return withWarning(branchTarget() ?? { worktree, mode: "working" });
  }

  if (requested === "commit" || requested === "stash") {
    return withWarning({ worktree, mode: requested, ref: refOverride });
  }

  if (requested !== "auto") return withWarning({ worktree, mode: requested });

  // Prefer uncommitted changes over the branch diff.
  if (deps.hasWorkingChanges(worktree, !cfg.review.exclude_untracked)) {
    return withWarning({ worktree, mode: "working" });
  }

  const base = baseRef();
  if (!base) {
    warnings.push("No base branch resolved; reviewing the working tree instead.");
    return withWarning({ worktree, mode: "working" });
  }
  if (deps.hasCommitsAhead(worktree, base)) {
    return withWarning({ worktree, mode: "branch", ref: `${base}...HEAD` });
  }
  return withWarning({ worktree, mode: "working" });
}
