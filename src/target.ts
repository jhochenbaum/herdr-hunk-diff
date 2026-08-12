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

  // A branch target without a base would silently become a working-tree diff.
  const branchTarget = (): Omit<Target, "warning"> | null => {
    const base = deps.resolveBaseRef(worktree);
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

  const base = deps.resolveBaseRef(worktree);
  if (!base) {
    warnings.push("No base branch resolved; reviewing the working tree instead.");
    return withWarning({ worktree, mode: "working" });
  }
  if (deps.hasCommitsAhead(worktree, base)) {
    return withWarning({ worktree, mode: "branch", ref: `${base}...HEAD` });
  }
  return withWarning({ worktree, mode: "working" });
}
