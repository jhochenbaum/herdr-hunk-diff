import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

export type WorktreeRealpath = (path: string) => string;

export interface WorktreeIdentity {
  key: string;
  /** True when realpath resolved the Windows directory. */
  canonical: boolean;
}

const nativeRealpath: WorktreeRealpath = (path) => realpathSync.native(path);

/**
 * Canonical index and sidecar key. Windows realpath unifies aliases without merging paths in a
 * case-sensitive directory; missing paths preserve component case.
 */
export function worktreeKey(
  worktree: string,
  platform: NodeJS.Platform = process.platform,
  realpath: WorktreeRealpath = nativeRealpath,
): string {
  return worktreeIdentity(worktree, platform, realpath).key;
}

export function worktreeIdentity(
  worktree: string,
  platform: NodeJS.Platform = process.platform,
  realpath: WorktreeRealpath = nativeRealpath,
): WorktreeIdentity {
  if (platform === "win32") {
    let canonical = win32.normalize(worktree);
    try {
      canonical = win32.normalize(realpath(canonical));
      return { key: foldDriveLetter(trimTrailingSeparators(canonical)), canonical: true };
    } catch {
      // Preserve case after the worktree has been removed.
    }
    return { key: foldDriveLetter(trimTrailingSeparators(canonical)), canonical: false };
  }
  return { key: trimTrailingSeparators(posix.normalize(worktree)), canonical: true };
}

/** Case-folded lookup alias used only when exactly one stored path matches. */
export function worktreeAliasKey(
  worktree: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const key =
    platform === "win32"
      ? trimTrailingSeparators(win32.normalize(worktree))
      : trimTrailingSeparators(posix.normalize(worktree));
  return platform === "win32" ? key.toLowerCase() : key;
}

function foldDriveLetter(path: string): string {
  return /^[A-Za-z]:/.test(path) ? `${path[0]!.toLowerCase()}${path.slice(1)}` : path;
}

/** Keeps a root such as `/` or `C:\` intact, which is entirely separator. */
function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed === "" || /^[A-Za-z]:$/.test(trimmed) ? path : trimmed;
}
