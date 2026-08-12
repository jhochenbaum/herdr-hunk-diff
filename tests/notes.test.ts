import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sidecarPath, writeNotesSidecar } from "../src/notes.js";

const dir = () => mkdtempSync(join(tmpdir(), "notes-"));

describe("writeNotesSidecar", () => {
  it("returns null when there are no notes", () => {
    expect(writeNotesSidecar(dir(), "/wt/x", [])).toBeNull();
  });

  it("writes a hunk-shaped agent-context file", () => {
    const path = writeNotesSidecar(dir(), "/wt/x", [
      { filePath: "src/a.ts", newLine: 3, summary: "Guard null" },
    ])!;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.comments[0].filePath).toBe("src/a.ts");
    expect(parsed.comments[0].summary).toBe("Guard null");
  });

  it("preserves the hunk-number field under the key hunk expects, not a made-up one", () => {
    const path = writeNotesSidecar(dir(), "/wt/x", [
      { filePath: "src/a.ts", hunk: 2, summary: "Explain this hunk" },
    ])!;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.comments[0].hunk).toBe(2);
    expect(parsed.comments[0].hunkNumber).toBeUndefined();
  });

  it("namespaces the file per worktree so parallel reviews do not collide", () => {
    const d = dir();
    const a = writeNotesSidecar(d, "/wt/a", [{ filePath: "f", newLine: 1, summary: "s" }])!;
    const b = writeNotesSidecar(d, "/wt/b", [{ filePath: "f", newLine: 1, summary: "s" }])!;
    expect(a).not.toBe(b);
    const contentsA = JSON.parse(readFileSync(a, "utf8"));
    const contentsB = JSON.parse(readFileSync(b, "utf8"));
    expect(contentsA).toEqual(contentsB);
  });

  it("is deterministic: the same worktree always resolves to the same path", () => {
    const d = dir();
    const a = writeNotesSidecar(d, "/wt/same", [{ filePath: "f", newLine: 1, summary: "s" }])!;
    const b = writeNotesSidecar(d, "/wt/same", [{ filePath: "f", newLine: 2, summary: "t" }])!;
    expect(a).toBe(b);
  });

  it("appends a second batch instead of replacing the first", () => {
    const d = dir();
    writeNotesSidecar(d, "/wt/x", [{ filePath: "src/a.ts", newLine: 1, summary: "First" }]);
    const path = writeNotesSidecar(d, "/wt/x", [
      { filePath: "src/b.ts", newLine: 2, summary: "Second" },
    ])!;

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.comments.map((c: any) => c.summary)).toEqual(["First", "Second"]);
  });

  it("keeps appending across many batches, in the order they were written", () => {
    const d = dir();
    for (const summary of ["a", "b", "c"]) {
      writeNotesSidecar(d, "/wt/x", [{ filePath: "f", newLine: 1, summary }]);
    }
    const parsed = JSON.parse(readFileSync(sidecarPath(d, "/wt/x"), "utf8"));
    expect(parsed.comments.map((c: any) => c.summary)).toEqual(["a", "b", "c"]);
  });

  it("does not append one worktree's notes onto another's", () => {
    const d = dir();
    writeNotesSidecar(d, "/wt/a", [{ filePath: "f", newLine: 1, summary: "for a" }]);
    const b = writeNotesSidecar(d, "/wt/b", [{ filePath: "f", newLine: 1, summary: "for b" }])!;
    const parsed = JSON.parse(readFileSync(b, "utf8"));
    expect(parsed.comments.map((c: any) => c.summary)).toEqual(["for b"]);
  });

  it("starts fresh rather than failing when the existing sidecar is unreadable", () => {
    const d = dir();
    const path = sidecarPath(d, "/wt/x");
    writeNotesSidecar(d, "/wt/x", [{ filePath: "f", newLine: 1, summary: "old" }]);
    writeFileSync(path, "{not json");

    writeNotesSidecar(d, "/wt/x", [{ filePath: "f", newLine: 1, summary: "new" }]);

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.comments.map((c: any) => c.summary)).toEqual(["new"]);
  });

  it("writes into the path predicted by the exported sidecarPath helper", () => {
    const d = dir();
    const path = writeNotesSidecar(d, "/wt/x", [{ filePath: "f", newLine: 1, summary: "s" }])!;
    expect(path).toBe(sidecarPath(d, "/wt/x"));
  });
});

describe("sidecarPath", () => {
  it("differs for different worktrees under the same state dir", () => {
    const d = dir();
    expect(sidecarPath(d, "/wt/a")).not.toBe(sidecarPath(d, "/wt/b"));
  });
});
