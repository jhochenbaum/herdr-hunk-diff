import { basename } from "node:path";
import { selectUnsent } from "./courier.js";
import type { HerdrAdapter } from "./herdr.js";
import type { HunkAdapter } from "./hunk.js";
import type { ReviewIndex } from "./index-store.js";

interface MetadataDeps {
  index: ReviewIndex;
  herdr: Partial<Pick<HerdrAdapter, "reportMetadata">>;
  hunk: Pick<HunkAdapter, "listComments">;
}

// Metadata is cosmetic and only applies while a review pane is open.
export async function reportReviewMetadata(rt: MetadataDeps, worktree: string): Promise<void> {
  if (!rt.herdr.reportMetadata) return;
  const entry = rt.index.get(worktree);
  if (!entry?.paneId) return;
  const unsentCount = selectUnsent(
    await rt.hunk.listComments(worktree, "user").catch(() => []),
    rt.index.sentIds(worktree),
  ).length;
  try {
    rt.herdr.reportMetadata(entry.paneId, {
      title: `Review: ${basename(worktree)}${entry.displayedTarget ? ` — ${entry.displayedTarget}` : ""}`,
      display_agent: unsentCount > 0 ? `hunk (${unsentCount} unsent)` : "hunk",
    });
  } catch {
    // Metadata failures must not fail a completed action.
  }
}
