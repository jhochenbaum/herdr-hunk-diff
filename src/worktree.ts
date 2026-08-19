import { posix, win32 } from "node:path";

/**
 * Identity of a reviewed repository, used to key the review index and the notes sidecar.
 *
 * Worktree paths reach this plugin from three sources that do not agree on Windows: herdr's context
 * and event payloads, `git rev-parse --show-toplevel` (which answers with forward slashes even
 * there), and a process working directory. `C:\repo`, `C:/repo` and `c:\repo` are one directory to
 * Windows but three distinct strings, so keying on the raw path would give one repository several
 * index entries and several sidecars — an open review would not find the notes written for it, and
 * `reuse_pane` would reopen a pane it already had.
 *
 * Only the key is folded. Callers keep the path they were given for anything a user reads, since a
 * lowercased path in a message is worse than a faithful one.
 */
export function worktreeKey(
  worktree: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    // Windows compares filenames case-insensitively, so two spellings name one repository.
    return trimTrailingSeparators(win32.normalize(worktree)).toLowerCase();
  }
  // POSIX paths are case- and separator-exact; only a trailing separator is not significant.
  return trimTrailingSeparators(posix.normalize(worktree));
}

/** Keeps a root such as `/` or `C:\` intact, which is entirely separator. */
function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed === "" || /^[A-Za-z]:$/.test(trimmed) ? path : trimmed;
}
