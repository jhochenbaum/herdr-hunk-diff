import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config.js";
import { formatReview, selectUnsent } from "../src/courier.js";
import type { HunkComment } from "../src/hunk.js";

const c = (over: Partial<HunkComment>): HunkComment => ({
  noteId: "c1",
  filePath: "src/a.ts",
  body: "Tighten this",
  newRange: [10, 10],
  ...over,
});

describe("formatReview edge cases", () => {
  it("renders sensibly with neither newRange nor oldRange (no leaked 'undefined')", () => {
    const text = formatReview([c({ newRange: undefined, oldRange: undefined })], "/wt/x", DEFAULTS);
    expect(text).toContain("- src/a.ts — Tighten this");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("src/a.ts:");
  });

  it("does not let a later substitution corrupt a worktree value that looks like a placeholder", () => {
    const cfg = {
      ...DEFAULTS,
      roundtrip: {
        ...DEFAULTS.roundtrip,
        prompt_template: "worktree={worktree} count={count}",
      },
    };
    const text = formatReview([c({}), c({ noteId: "c2" })], "/repo/{count}/x", cfg);
    expect(text).toContain("worktree=/repo/{count}/x");
    expect(text).toContain("count=2");
  });

  it("does not let a later substitution corrupt a comment body that looks like a placeholder", () => {
    const cfg = {
      ...DEFAULTS,
      roundtrip: {
        ...DEFAULTS.roundtrip,
        prompt_template: "{comments}\nagent={agent}",
      },
    };
    const text = formatReview([c({ body: "handle the {agent} case" })], "/wt/x", cfg, "reviewer");
    expect(text).toContain("handle the {agent} case");
    expect(text).toContain("agent=reviewer");
  });

  it("keeps $-pattern literals ($&, $$, $1) in a substituted value verbatim", () => {
    const cfg = {
      ...DEFAULTS,
      roundtrip: { ...DEFAULTS.roundtrip, prompt_template: "{worktree}" },
    };
    const text = formatReview([c({})], "$&$$$1", cfg);
    expect(text).toBe("$&$$$1");
  });
});

describe("selectUnsent with duplicate ids", () => {
  it("keeps duplicate ids together: a sent id drops every comment sharing it", () => {
    const dup = c({ noteId: "c1", body: "first copy" });
    const dup2 = c({ noteId: "c1", body: "second copy" });
    const other = c({ noteId: "c2" });

    expect(selectUnsent([dup, dup2, other], ["c1"]).map((x) => x.noteId)).toEqual(["c2"]);
    expect(selectUnsent([dup, dup2, other], []).map((x) => x.noteId)).toEqual(["c1", "c1", "c2"]);
  });
});

describe("formatReview with an unknown placeholder token", () => {
  it("leaves an unrecognized {bogus} token untouched", () => {
    const cfg = {
      ...DEFAULTS,
      roundtrip: { ...DEFAULTS.roundtrip, prompt_template: "{bogus} / {count}" },
    };
    const text = formatReview([c({}), c({ noteId: "c2" })], "/wt/x", cfg);
    expect(text).toBe("{bogus} / 2");
  });
});
