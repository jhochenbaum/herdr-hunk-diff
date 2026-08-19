import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { ResolvedTargetMode } from "./config.js";
import { worktreeKey } from "./worktree.js";

export interface ReviewEntry {
  worktree: string;
  /** Human-readable agent kind; use `agentPaneId` for addressing. */
  agentName?: string;
  /** Pane running the agent and accepted by `herdr agent prompt`. */
  agentPaneId?: string;
  /** Pane displaying the hunk review. */
  paneId?: string;
  /** Positional ref passed from the action process to the pane; `null` clears it. */
  requestedRef?: string | null;
  /** Mode currently displayed, used by reload; `null` restores config-driven selection. */
  requestedMode?: ResolvedTargetMode | null;
  sent: string[];
}

let tmpCounter = 0;

const STALE_LOCK_MS = 10_000;
const ACQUIRE_TIMEOUT_MS = 2_000;
const POLL_MS = 5;

export interface ReviewIndexOptions {
  staleLockMs?: number;
  acquireTimeoutMs?: number;
}

/** Blocks without spinning while another short-lived process holds the lock. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process review state, keyed by `worktreeKey` so the same repository resolves to one entry
 * whichever spelling of its path a caller happens to hold. Mutations lock and reread the file;
 * writes use an atomic rename so concurrent readers never observe partial JSON.
 */
export class ReviewIndex {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly staleLockMs: number;
  private readonly acquireTimeoutMs: number;

  constructor(stateDir: string, opts: ReviewIndexOptions = {}) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "review-index.json");
    this.lockFile = `${this.file}.lock`;
    this.staleLockMs = opts.staleLockMs ?? STALE_LOCK_MS;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS;
  }

  private read(): Record<string, ReviewEntry> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Writes beside the destination so `rename` remains atomic on a single filesystem. */
  private write(entries: Record<string, ReviewEntry>): void {
    const tmp = `${this.file}.${process.pid}.${tmpCounter++}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(entries, null, 2));
      renameSync(tmp, this.file);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Preserve the original write error.
      }
      throw err;
    }
  }

  /**
   * Mutates state under an exclusive-create lock. Stale locks are removed; after the acquire timeout
   * the operation favors liveness and may proceed unlocked. Atomic writes still prevent torn reads.
   */
  private mutate(fn: (entries: Record<string, ReviewEntry>) => void): void {
    const release = this.acquire();
    try {
      const entries = this.read();
      fn(entries);
      this.write(entries);
    } finally {
      release();
    }
  }

  private acquire(): () => void {
    const deadline = Date.now() + this.acquireTimeoutMs;
    let stolen = false;
    for (;;) {
      try {
        const fd = openSync(this.lockFile, "wx");
        try {
          writeSync(fd, String(process.pid));
        } finally {
          closeSync(fd);
        }
        return () => {
          try {
            rmSync(this.lockFile, { force: true });
          } catch {
            // A peer may already have broken this lock as stale.
          }
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (this.breakIfStale()) continue;
        if (Date.now() < deadline) {
          sleep(POLL_MS);
          continue;
        }
        if (stolen) return () => {};
        stolen = true;
        try {
          rmSync(this.lockFile, { force: true });
        } catch {
          // The next iteration proceeds unlocked as a last resort.
        }
      }
    }
  }

  private breakIfStale(): boolean {
    try {
      const age = Date.now() - statSync(this.lockFile).mtimeMs;
      if (age < this.staleLockMs) return false;
      rmSync(this.lockFile, { force: true });
      return true;
    } catch {
      // The holder released it or a peer broke it; retry immediately.
      return true;
    }
  }

  get(worktree: string): ReviewEntry | undefined {
    return this.read()[worktreeKey(worktree)];
  }

  all(): ReviewEntry[] {
    return Object.values(this.read());
  }

  /** Keeps delivery history deduplicated and limited to nonempty string ids. */
  private static ids(stored: unknown): string[] {
    if (!Array.isArray(stored)) return [];
    return [...new Set(stored)].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
  }

  /**
   * Merges under the lock: `sent` is unioned, `undefined` preserves stored fields, and `null` clears
   * them. This lets processes update fields they own without erasing state learned elsewhere.
   */
  upsert(entry: ReviewEntry): void {
    this.mutate((entries) => {
      const key = worktreeKey(entry.worktree);
      const existing = entries[key];
      const merged: Record<string, unknown> = { ...existing };
      for (const [key, value] of Object.entries(entry)) {
        if (value === undefined) continue;
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      merged.sent = ReviewIndex.ids([...(existing?.sent ?? []), ...(entry.sent ?? [])]);
      merged.worktree = entry.worktree;
      entries[key] = merged as unknown as ReviewEntry;
    });
  }

  /** Clears the displayed pane while preserving agent and delivery history. */
  clearPane(worktree: string): void {
    this.mutate((entries) => {
      const entry = entries[worktreeKey(worktree)];
      if (!entry) return;
      delete entry.paneId;
    });
  }

  markSent(worktree: string, ids: string[]): void {
    this.mutate((entries) => {
      const key = worktreeKey(worktree);
      const entry = entries[key] ?? { worktree, sent: [] };
      entry.sent = ReviewIndex.ids([...(entry.sent ?? []), ...ids]);
      entries[key] = entry;
    });
  }

  sentIds(worktree: string): string[] {
    return ReviewIndex.ids(this.read()[worktreeKey(worktree)]?.sent);
  }

  remove(worktree: string): void {
    this.mutate((entries) => {
      delete entries[worktreeKey(worktree)];
    });
  }
}
