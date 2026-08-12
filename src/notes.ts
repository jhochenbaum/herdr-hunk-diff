import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Write schema for `hunk session comment apply --stdin` and `--agent-context`. */
export interface AgentNote {
  filePath: string;
  summary: string;
  rationale?: string;
  newLine?: number;
  oldLine?: number;
  hunk?: number;
}

/** Derives a stable, worktree-specific sidecar path. */
export function sidecarPath(stateDir: string, worktree: string): string {
  const key = createHash("sha256").update(worktree).digest("hex").slice(0, 12);
  return join(stateDir, "notes", `${key}.json`);
}

function existingNotes(path: string): AgentNote[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.comments) ? (parsed.comments as AgentNote[]) : [];
  } catch {
    return [];
  }
}

/** Appends notes queued before a review opens; the pane consumes the sidecar after display. */
export function writeNotesSidecar(
  stateDir: string,
  worktree: string,
  notes: AgentNote[],
): string | null {
  if (notes.length === 0) return null;
  const path = sidecarPath(stateDir, worktree);
  mkdirSync(join(stateDir, "notes"), { recursive: true });
  const comments = [...existingNotes(path), ...notes];
  writeFileSync(path, JSON.stringify({ comments }, null, 2));
  return path;
}

const GITHUB = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull|commit)\/([A-Za-z0-9]+)\/?$/;

export function parseGithubUrl(url: string): { kind: "pull" | "commit"; ref: string } | null {
  const m = GITHUB.exec(url);
  if (!m) return null;
  return { kind: m[1] === "pull" ? "pull" : "commit", ref: m[2] };
}
