import type { PluginConfig } from "./config.js";
import type { HunkComment } from "./hunk.js";

/** Filters comments by the same `noteId` persisted by `ReviewIndex.markSent`. */
export function selectUnsent(comments: HunkComment[], sentIds: string[]): HunkComment[] {
  const sent = new Set(sentIds);
  return comments.filter((c) => !sent.has(c.noteId));
}

function line(c: HunkComment): string {
  const at = c.newRange?.[0] ?? c.oldRange?.[0];
  return `${c.filePath}${at !== undefined ? `:${at}` : ""} — ${c.body}`;
}

export function formatReview(
  comments: HunkComment[],
  worktree: string,
  cfg: PluginConfig,
  agentName?: string,
): string {
  if (comments.length === 0) return "";
  const rendered = comments.map((c) => `- ${line(c)}`).join("\n");

  const values: Record<string, string> = {
    "{worktree}": worktree,
    "{comments}": rendered,
    "{count}": String(comments.length),
    "{agent}": agentName ?? "agent",
  };
  // One pass avoids reprocessing placeholders from substituted text; a function preserves `$`.
  return cfg.roundtrip.prompt_template.replace(
    /\{worktree\}|\{comments\}|\{count\}|\{agent\}/g,
    (match) => values[match],
  );
}
