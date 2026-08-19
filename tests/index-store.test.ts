import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewIndex } from "../src/index-store.js";

const dir = () => mkdtempSync(join(tmpdir(), "hunkidx-"));

describe("ReviewIndex", () => {
  it("returns undefined for an unknown worktree", () => {
    expect(new ReviewIndex(dir()).get("/wt/x")).toBeUndefined();
  });

  // One repository is one entry however its path is spelled. The paths reaching the index come from
  // herdr's context, `git rev-parse` and a process cwd, which disagree on Windows; keying on the raw
  // string would give one repository several entries, and a review would miss its own state.
  it("finds an entry through another spelling of the same path", () => {
    const d = dir();
    new ReviewIndex(d).upsert({ worktree: "/wt/x", agentName: "reviewer", sent: [] });
    expect(new ReviewIndex(d).get("/wt/x/")?.agentName).toBe("reviewer");
  });

  it("merges into the existing entry rather than adding a second one", () => {
    const d = dir();
    const index = new ReviewIndex(d);
    index.upsert({ worktree: "/wt/x", agentName: "reviewer", sent: ["a"] });
    index.upsert({ worktree: "/wt/x/", paneId: "w1:p2", sent: ["b"] });

    expect(index.all()).toHaveLength(1);
    expect(index.get("/wt/x")).toMatchObject({ agentName: "reviewer", paneId: "w1:p2" });
    expect(index.sentIds("/wt/x")).toEqual(["a", "b"]);
  });

  it("removes an entry addressed by another spelling of its path", () => {
    const d = dir();
    const index = new ReviewIndex(d);
    index.upsert({ worktree: "/wt/x", sent: [] });
    index.remove("/wt/x/");
    expect(index.get("/wt/x")).toBeUndefined();
  });

  it("persists an entry across instances", () => {
    const d = dir();
    new ReviewIndex(d).upsert({ worktree: "/wt/x", agentName: "reviewer", sent: [] });
    expect(new ReviewIndex(d).get("/wt/x")?.agentName).toBe("reviewer");
  });

  it("accumulates sent comment ids without duplicating", () => {
    const d = dir();
    const idx = new ReviewIndex(d);
    idx.upsert({ worktree: "/wt/x", sent: [] });
    idx.markSent("/wt/x", ["c1", "c2"]);
    idx.markSent("/wt/x", ["c2", "c3"]);
    expect(idx.sentIds("/wt/x").sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("returns an empty sent list for an unknown worktree", () => {
    expect(new ReviewIndex(dir()).sentIds("/wt/nope")).toEqual([]);
  });

  it("keeps an id-less comment out of sent rather than storing it as null", () => {
    const d = dir();
    const idx = new ReviewIndex(d);
    idx.upsert({ worktree: "/wt/x", sent: [] });
    idx.markSent("/wt/x", [undefined as unknown as string, "c1"]);
    expect(idx.sentIds("/wt/x")).toEqual(["c1"]);
    expect(readFileSync(join(d, "review-index.json"), "utf8")).not.toContain("null");
  });

  it("drops a null left in sent by an earlier write", () => {
    const d = dir();
    writeFileSync(
      join(d, "review-index.json"),
      JSON.stringify({ "/wt/x": { worktree: "/wt/x", sent: [null, "c1"] } }),
    );
    const idx = new ReviewIndex(d);
    expect(idx.sentIds("/wt/x")).toEqual(["c1"]);
    idx.markSent("/wt/x", ["c2"]);
    expect(readFileSync(join(d, "review-index.json"), "utf8")).not.toContain("null");
  });

  it("does not treat an empty-string id as sent", () => {
    const d = dir();
    const idx = new ReviewIndex(d);
    idx.markSent("/wt/x", ["", "c1"]);
    expect(idx.sentIds("/wt/x")).toEqual(["c1"]);
  });

  it("does not split a malformed string value into character ids", () => {
    const d = dir();
    writeFileSync(
      join(d, "review-index.json"),
      JSON.stringify({ "/wt/x": { worktree: "/wt/x", sent: "abc" } }),
    );
    expect(new ReviewIndex(d).sentIds("/wt/x")).toEqual([]);
  });

  it("removes an entry", () => {
    const d = dir();
    const idx = new ReviewIndex(d);
    idx.upsert({ worktree: "/wt/x", sent: [] });
    idx.remove("/wt/x");
    expect(idx.get("/wt/x")).toBeUndefined();
  });

  it("survives a corrupt state file", () => {
    const d = dir();
    const idx = new ReviewIndex(d);
    idx.upsert({ worktree: "/wt/x", sent: [] });
    writeFileSync(join(d, "review-index.json"), "{corrupt");
    expect(() => new ReviewIndex(d).all()).not.toThrow();
    expect(new ReviewIndex(d).all()).toEqual([]);
  });

  it("survives a top-level array in the state file without silently dropping later writes", () => {
    const d = dir();
    writeFileSync(join(d, "review-index.json"), "[]");
    const idx = new ReviewIndex(d);
    expect(idx.all()).toEqual([]);

    idx.upsert({ worktree: "/wt/x", agentName: "reviewer", sent: [] });

    const reopened = new ReviewIndex(d);
    expect(reopened.get("/wt/x")?.agentName).toBe("reviewer");
  });

  it("does not lose delivered-comment history when upsert omits sent ids", () => {
    const d = dir();
    const idx = new ReviewIndex(d);
    idx.upsert({ worktree: "/wt/x", agentName: "reviewer", sent: [] });
    idx.markSent("/wt/x", ["c1", "c2"]);

    idx.upsert({ worktree: "/wt/x", agentName: "reviewer", paneId: "pane-1", sent: [] });

    expect(idx.sentIds("/wt/x").sort()).toEqual(["c1", "c2"]);
    expect(new ReviewIndex(d).sentIds("/wt/x").sort()).toEqual(["c1", "c2"]);
  });

  it("persists markSent across fresh instances reading from disk", () => {
    const d = dir();
    const idx = new ReviewIndex(d);
    idx.upsert({ worktree: "/wt/x", sent: [] });
    idx.markSent("/wt/x", ["c1", "c2"]);

    const reopened = new ReviewIndex(d);
    expect(reopened.sentIds("/wt/x").sort()).toEqual(["c1", "c2"]);

    reopened.markSent("/wt/x", ["c2", "c3"]);
    expect(new ReviewIndex(d).sentIds("/wt/x").sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("does not let an undefined field overwrite a stored value", () => {
    const d = dir();
    const idx = new ReviewIndex(d);
    idx.upsert({ worktree: "/wt/x", agentName: "reviewer", paneId: "w1:p7", sent: [] });

    idx.upsert({ worktree: "/wt/x", agentName: undefined, paneId: undefined, sent: [] });

    expect(idx.get("/wt/x")?.agentName).toBe("reviewer");
    expect(idx.get("/wt/x")?.paneId).toBe("w1:p7");
    expect(new ReviewIndex(d).get("/wt/x")?.agentName).toBe("reviewer");
  });

  it("does not let an omitted field overwrite a stored value either", () => {
    const d = dir();
    const idx = new ReviewIndex(d);
    idx.upsert({ worktree: "/wt/x", agentName: "reviewer", paneId: "w1:p7", sent: [] });
    idx.upsert({ worktree: "/wt/x", sent: [] });
    expect(idx.get("/wt/x")?.agentName).toBe("reviewer");
    expect(idx.get("/wt/x")?.paneId).toBe("w1:p7");
  });

  it("still applies a defined value over a stored one", () => {
    const d = dir();
    const idx = new ReviewIndex(d);
    idx.upsert({ worktree: "/wt/x", agentName: "first", paneId: "w1:p1", sent: [] });
    idx.upsert({ worktree: "/wt/x", agentName: "second", paneId: "w1:p2", sent: [] });
    expect(idx.get("/wt/x")?.agentName).toBe("second");
    expect(idx.get("/wt/x")?.paneId).toBe("w1:p2");
  });

  it("clears a field when the incoming value is null", () => {
    const d = dir();
    const idx = new ReviewIndex(d);
    idx.upsert({ worktree: "/wt/x", requestedRef: "abc1234", sent: [] });
    idx.upsert({ worktree: "/wt/x", requestedRef: null, sent: [] });
    expect(idx.get("/wt/x")?.requestedRef).toBeUndefined();
    expect(new ReviewIndex(d).get("/wt/x")).not.toHaveProperty("requestedRef");
  });

  it("never loses the worktree key itself while merging", () => {
    const d = dir();
    const idx = new ReviewIndex(d);
    idx.upsert({ worktree: "/wt/x", sent: [] });
    expect(idx.get("/wt/x")?.worktree).toBe("/wt/x");
  });

  describe("clearPane", () => {
    it("forgets the pane while keeping the agent and delivered-comment history", () => {
      const d = dir();
      const idx = new ReviewIndex(d);
      idx.upsert({ worktree: "/wt/x", agentName: "reviewer", paneId: "w1:p7", sent: ["c1"] });

      idx.clearPane("/wt/x");

      expect(idx.get("/wt/x")?.paneId).toBeUndefined();
      expect(idx.get("/wt/x")?.agentName).toBe("reviewer");
      expect(idx.sentIds("/wt/x")).toEqual(["c1"]);
      expect(new ReviewIndex(d).get("/wt/x")?.paneId).toBeUndefined();
      expect(new ReviewIndex(d).sentIds("/wt/x")).toEqual(["c1"]);
    });

    it("is a no-op for an unknown worktree", () => {
      const idx = new ReviewIndex(dir());
      expect(() => idx.clearPane("/wt/nope")).not.toThrow();
      expect(idx.get("/wt/nope")).toBeUndefined();
    });
  });

  describe("concurrent instances", () => {
    it("keeps both instances' entries when each writes a different worktree", () => {
      const d = dir();
      const a = new ReviewIndex(d);
      const b = new ReviewIndex(d);

      a.upsert({ worktree: "/wt/a", agentName: "claude", sent: [] });
      b.upsert({ worktree: "/wt/b", agentName: "codex", sent: [] });

      const seen = new ReviewIndex(d)
        .all()
        .map((e) => e.worktree)
        .sort();
      expect(seen).toEqual(["/wt/a", "/wt/b"]);
    });

    it("does not let one instance's upsert clobber the other's agentName", () => {
      const d = dir();
      const a = new ReviewIndex(d);
      const b = new ReviewIndex(d);

      a.upsert({ worktree: "/wt/x", agentName: "claude", agentPaneId: "w1:p1", sent: [] });
      b.upsert({ worktree: "/wt/x", paneId: "w1:p9", sent: [] });

      const entry = new ReviewIndex(d).get("/wt/x");
      expect(entry?.agentName).toBe("claude");
      expect(entry?.agentPaneId).toBe("w1:p1");
      expect(entry?.paneId).toBe("w1:p9");
    });

    it("does not let one instance's upsert clobber the other's paneId", () => {
      const d = dir();
      const a = new ReviewIndex(d);
      const b = new ReviewIndex(d);

      a.upsert({ worktree: "/wt/x", paneId: "w1:p9", sent: [] });
      b.upsert({ worktree: "/wt/x", agentName: "claude", sent: [] });

      const entry = new ReviewIndex(d).get("/wt/x");
      expect(entry?.paneId).toBe("w1:p9");
      expect(entry?.agentName).toBe("claude");
    });

    it("unions sent ids written by two instances instead of losing one side", () => {
      const d = dir();
      const a = new ReviewIndex(d);
      const b = new ReviewIndex(d);

      a.markSent("/wt/x", ["c1"]);
      b.markSent("/wt/x", ["c2"]);

      expect(new ReviewIndex(d).sentIds("/wt/x").sort()).toEqual(["c1", "c2"]);
    });

    it("keeps a concurrently written sent history when the other instance clears a pane", () => {
      const d = dir();
      const seed = new ReviewIndex(d);
      seed.upsert({ worktree: "/wt/x", agentName: "claude", paneId: "w1:p1", sent: [] });

      const a = new ReviewIndex(d);
      const b = new ReviewIndex(d);
      a.markSent("/wt/x", ["c1"]);
      b.clearPane("/wt/x");

      const entry = new ReviewIndex(d).get("/wt/x");
      expect(entry?.paneId).toBeUndefined();
      expect(entry?.sent).toEqual(["c1"]);
      expect(entry?.agentName).toBe("claude");
    });

    it("keeps a concurrent removal from resurrecting the removed entry", () => {
      const d = dir();
      const seed = new ReviewIndex(d);
      seed.upsert({ worktree: "/wt/gone", sent: [] });
      seed.upsert({ worktree: "/wt/live", sent: [] });

      const a = new ReviewIndex(d);
      const b = new ReviewIndex(d);
      a.remove("/wt/gone");
      b.upsert({ worktree: "/wt/live", paneId: "w1:p2", sent: [] });

      const seen = new ReviewIndex(d).all().map((e) => e.worktree);
      expect(seen).toEqual(["/wt/live"]);
    });

    it("reads a value another instance wrote after this one was constructed", () => {
      const d = dir();
      const reader = new ReviewIndex(d);
      expect(reader.get("/wt/x")).toBeUndefined();

      new ReviewIndex(d).upsert({ worktree: "/wt/x", agentName: "claude", sent: ["c1"] });

      expect(reader.get("/wt/x")?.agentName).toBe("claude");
      expect(reader.sentIds("/wt/x")).toEqual(["c1"]);
      expect(reader.all().map((e) => e.worktree)).toEqual(["/wt/x"]);
    });
  });

  describe("locking", () => {
    it("leaves no lock file or temp file behind after a mutation", () => {
      const d = dir();
      new ReviewIndex(d).upsert({ worktree: "/wt/x", sent: [] });
      expect(readdirSync(d)).toEqual(["review-index.json"]);
    });

    it("recovers from a stale lock left by a crashed process", () => {
      const d = dir();
      const lock = join(d, "review-index.json.lock");
      writeFileSync(lock, "99999999");

      const idx = new ReviewIndex(d, { staleLockMs: 0, acquireTimeoutMs: 50 });
      idx.upsert({ worktree: "/wt/x", agentName: "claude", sent: [] });

      expect(new ReviewIndex(d).get("/wt/x")?.agentName).toBe("claude");
      expect(existsSync(lock)).toBe(false);
    });

    it("still applies the mutation when the lock cannot be acquired at all", () => {
      const d = dir();
      writeFileSync(join(d, "review-index.json.lock"), "held");

      const idx = new ReviewIndex(d, { staleLockMs: 60_000, acquireTimeoutMs: 20 });
      expect(() => idx.upsert({ worktree: "/wt/x", agentName: "claude", sent: [] })).not.toThrow();
      expect(new ReviewIndex(d).get("/wt/x")?.agentName).toBe("claude");
    });

    it("does not leave a partially written file behind for a reader", () => {
      const d = dir();
      const idx = new ReviewIndex(d);
      for (let i = 0; i < 50; i++) idx.upsert({ worktree: `/wt/${i}`, sent: [`c${i}`] });
      expect(() => JSON.parse(readFileSync(join(d, "review-index.json"), "utf8"))).not.toThrow();
      expect(new ReviewIndex(d).all()).toHaveLength(50);
    });
  });

  it("all() reflects entries for multiple worktrees, read fresh from disk", () => {
    const d = dir();
    const idx = new ReviewIndex(d);
    idx.upsert({ worktree: "/wt/a", agentName: "reviewer-a", sent: [] });
    idx.upsert({ worktree: "/wt/b", agentName: "reviewer-b", sent: [] });

    const worktrees = new ReviewIndex(d)
      .all()
      .map((e) => e.worktree)
      .sort();
    expect(worktrees).toEqual(["/wt/a", "/wt/b"]);
  });
});
