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

describe("selectUnsent", () => {
  it("drops comments already delivered", () => {
    const out = selectUnsent([c({ noteId: "c1" }), c({ noteId: "c2" })], ["c1"]);
    expect(out.map((x) => x.noteId)).toEqual(["c2"]);
  });

  it("returns everything when nothing was sent", () => {
    expect(selectUnsent([c({ noteId: "c1" })], [])).toHaveLength(1);
  });
});

describe("formatReview", () => {
  it("renders path:line — body", () => {
    const text = formatReview([c({})], "/wt/x", DEFAULTS);
    expect(text).toContain("src/a.ts:10 — Tighten this");
  });

  it("uses the old range's start when there is no new range", () => {
    const text = formatReview([c({ newRange: undefined, oldRange: [7, 7] })], "/wt/x", DEFAULTS);
    expect(text).toContain("src/a.ts:7 —");
  });

  it("renders the start of a multi-line range, not its end", () => {
    const text = formatReview([c({ newRange: [12, 20] })], "/wt/x", DEFAULTS);
    expect(text).toContain("src/a.ts:12 — Tighten this");
    expect(text).not.toContain("src/a.ts:20");
  });

  it("ignores the extra fields hunk sends that this plugin does not render", () => {
    const text = formatReview(
      [
        c({
          source: "user",
          author: "user",
          hunkIndex: 0,
          createdAt: "2026-08-10T20:31:25.051Z",
          editable: true,
        }),
      ],
      "/wt/x",
      DEFAULTS,
    );
    expect(text).toContain("- src/a.ts:10 — Tighten this\n");
    expect(text).not.toContain("2026-08-10");
  });

  it("substitutes template variables", () => {
    const cfg = {
      ...DEFAULTS,
      roundtrip: {
        ...DEFAULTS.roundtrip,
        prompt_template: "{count} notes in {worktree} for {agent}:\n{comments}",
      },
    };
    const text = formatReview([c({})], "/wt/x", cfg, "reviewer");
    expect(text).toContain("1 notes in /wt/x for reviewer");
  });

  it("returns an empty string for no comments", () => {
    expect(formatReview([], "/wt/x", DEFAULTS)).toBe("");
  });
});

const LIVE_COMMENT_LIST_JSON = `{
  "comments": [
    {
      "noteId": "user:1786393885051-1",
      "source": "user",
      "filePath": "README.md",
      "hunkIndex": 0,
      "newRange": [63, 63],
      "body": "Did we really add support for jit command-palette? I don't remember this",
      "author": "user",
      "createdAt": "2026-08-10T20:31:25.051Z",
      "editable": true
    },
    {
      "noteId": "user:1786393972949-2",
      "source": "user",
      "filePath": "README.md",
      "hunkIndex": 0,
      "newRange": [83, 83],
      "body": "Add comments/definition where it might not be clear to the user what the option means",
      "author": "user",
      "createdAt": "2026-08-10T20:32:52.949Z",
      "editable": true
    },
    {
      "noteId": "user:1786394028804-3",
      "source": "user",
      "filePath": "README.md",
      "hunkIndex": 0,
      "newRange": [1, 1],
      "body": "Review the readme from the user's perspective. Pay attention to AI slop speak.",
      "author": "user",
      "createdAt": "2026-08-10T20:33:48.804Z",
      "editable": true
    }
  ]
}`;

const liveComments = (): HunkComment[] =>
  (JSON.parse(LIVE_COMMENT_LIST_JSON) as { comments: HunkComment[] }).comments;

describe("the real `session comment list` output shape", () => {
  it("renders each comment's body text and its line number, not 'undefined'", () => {
    const text = formatReview(liveComments(), "/wt/x", DEFAULTS);

    expect(text).toContain(
      "- README.md:63 — Did we really add support for jit command-palette? I don't remember this",
    );
    expect(text).toContain(
      "- README.md:83 — Add comments/definition where it might not be clear to the user what the option means",
    );
    expect(text).toContain("- README.md:1 — Review the readme from the user's perspective.");

    expect(text).not.toContain("undefined");
    expect(text).not.toContain("README.md —");
  });

  it("derives the line number from oldRange when a comment sits on the old side", () => {
    const [first] = liveComments();
    const oldSide = { ...first, newRange: undefined, oldRange: [12, 14] as [number, number] };
    expect(formatReview([oldSide], "/wt/x", DEFAULTS)).toContain("README.md:12 —");
  });

  it("recognises comments as already-sent across two send-review runs", () => {
    const first = selectUnsent(liveComments(), []);
    expect(first).toHaveLength(3);

    const sentIds = first.map((c) => c.noteId);
    expect(sentIds).toEqual([
      "user:1786393885051-1",
      "user:1786393972949-2",
      "user:1786394028804-3",
    ]);

    expect(selectUnsent(liveComments(), sentIds)).toEqual([]);
  });
});
