import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseHunkComments, type HunkComment } from "./hunk.js";
import { worktreeKey } from "./worktree.js";

/**
 * hunk keeps review comments only in memory, so closing the viewer discards any that were never
 * sent. The pane snapshots unsent comments here while hunk runs, and `send-review` delivers them
 * after the viewer is gone.
 */
export function savedCommentsPath(stateDir: string, worktree: string): string {
  const key = createHash("sha256").update(worktreeKey(worktree)).digest("hex").slice(0, 12);
  return join(stateDir, "saved-comments", `${key}.json`);
}

export function loadSavedComments(stateDir: string, worktree: string): HunkComment[] {
  try {
    const parsed = JSON.parse(readFileSync(savedCommentsPath(stateDir, worktree), "utf8"));
    return parseHunkComments(parsed?.comments);
  } catch {
    return [];
  }
}

/** Replaces the snapshot atomically; an empty list removes it. */
export function saveComments(stateDir: string, worktree: string, comments: HunkComment[]): void {
  const path = savedCommentsPath(stateDir, worktree);
  if (comments.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(join(stateDir, "saved-comments"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ comments }, null, 2));
  renameSync(tmp, path);
}

/** Drops delivered comments from the snapshot. */
export function forgetSavedComments(stateDir: string, worktree: string, sentIds: string[]): void {
  const sent = new Set(sentIds);
  const saved = loadSavedComments(stateDir, worktree);
  const remaining = saved.filter((c) => !sent.has(c.noteId));
  if (remaining.length !== saved.length) saveComments(stateDir, worktree, remaining);
}
