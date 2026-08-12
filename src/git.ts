import { spawnSync } from "node:child_process";

export type Runner = (cmd: string, args: string[]) => { status: number; stdout: string };

export function realRunner(cwd: string): Runner {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  };
}

/** Returns Git's working-tree root, including for linked worktrees and submodules. */
export function repoRoot(dir: string, run: Runner): string | null {
  const r = run("git", ["rev-parse", "--show-toplevel"]);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

const CONVENTIONAL = ["main", "master", "trunk"];

// Remote names may contain slashes, so conservatively reject any matching branch-name suffix.
function namesBranch(candidate: string, branch: string): boolean {
  return candidate === branch || candidate.endsWith(`/${branch}`);
}

/** Resolves a base other than the current branch, avoiding empty self-comparisons. */
export function resolveBaseRef(repo: string, run: Runner): string | null {
  let branch: string | null | undefined;
  const currentBranch = (): string | null => {
    if (branch === undefined) {
      const r = run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      branch = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    }
    return branch;
  };

  const usable = (candidate: string): boolean => {
    const on = currentBranch();
    return on === null || !namesBranch(candidate, on);
  };

  const upstream = run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.status === 0 && upstream.stdout.trim() && usable(upstream.stdout.trim())) {
    return upstream.stdout.trim();
  }

  const head = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.status === 0 && head.stdout.trim() && usable(head.stdout.trim())) {
    return head.stdout.trim();
  }

  // A conventional local branch may equal HEAD; auto mode then correctly falls back to the worktree.
  for (const branchName of CONVENTIONAL) {
    const exists = run("git", ["rev-parse", "--verify", "--quiet", branchName]);
    if (exists.status === 0 && exists.stdout.trim()) return branchName;
  }
  return null;
}

export function hasCommitsAhead(repo: string, base: string, run: Runner): boolean {
  const r = run("git", ["rev-list", "--count", `${base}..HEAD`]);
  if (r.status !== 0) return false;
  return Number.parseInt(r.stdout.trim(), 10) > 0;
}

/** `^{commit}` so an existing blob or tree name does not pass as a reviewable commit. */
export function commitExists(repo: string, ref: string, run: Runner): boolean {
  return run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0;
}
