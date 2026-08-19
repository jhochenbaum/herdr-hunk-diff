import { describe, expect, it } from "vitest";
import {
  isReviewAction,
  paneEntrypointFor,
  REVIEW_ACTIONS,
  reviewRequestFor,
  type ReviewActionId,
} from "../src/actions.js";

describe("reviewRequestFor", () => {
  it("asks for the mode its action id names", () => {
    const modes = Object.fromEntries(REVIEW_ACTIONS.map((id) => [id, reviewRequestFor(id).mode]));
    expect(modes).toEqual({
      review: undefined,
      "review:staged": "staged",
      "review:branch": "branch",
      "review:commit": "commit",
      "review:stash": "stash",
    });
  });

  it("takes a ref for exactly the actions whose hunk command has one", () => {
    const takesRef = Object.fromEntries(
      REVIEW_ACTIONS.map((id) => [id, reviewRequestFor(id).takesRef]),
    );
    expect(takesRef).toEqual({
      review: false,
      "review:staged": false,
      "review:branch": true,
      "review:commit": true,
      "review:stash": true,
    });
  });

  it("declares no review action that needs an operand it cannot be given", () => {
    for (const id of REVIEW_ACTIONS) {
      expect(id, "a selection-driven action id is on the registry").not.toMatch(
        /^review:(patch|compare|difftool|paths)$/,
      );
    }
    expect(REVIEW_ACTIONS).toHaveLength(5);
  });

  it("never reports a mode of its own for the plain review action", () => {
    expect(reviewRequestFor("review").mode).toBeUndefined();
  });
});

describe("isReviewAction", () => {
  it("recognizes every declared review action", () => {
    for (const id of REVIEW_ACTIONS) expect(isReviewAction(id)).toBe(true);
  });

  it("rejects the non-review actions the dispatcher handles separately", () => {
    for (const id of ["send-review", "reload", "close-review", "next-comment", "setup-keys", ""]) {
      expect(isReviewAction(id)).toBe(false);
    }
  });

  it("rejects the selection-driven ids the registry cannot carry", () => {
    for (const id of ["review:patch", "review:compare", "review:difftool", "review:paths"]) {
      expect(isReviewAction(id)).toBe(false);
    }
  });

  it("rejects a near-miss id rather than treating it as a review", () => {
    expect(isReviewAction("review:")).toBe(false);
    expect(isReviewAction("review:working")).toBe(false);
    expect(isReviewAction("review:path")).toBe(false);
  });
});

describe("paneEntrypointFor", () => {
  it("gives each review action its own pane entrypoint", () => {
    const entrypoints = REVIEW_ACTIONS.map((id) => paneEntrypointFor(id, "darwin"));
    expect(entrypoints).toEqual([
      "review",
      "review-staged",
      "review-branch",
      "review-commit",
      "review-stash",
    ]);
    expect(new Set(entrypoints).size).toBe(entrypoints.length);
  });

  it("selects the windows twin of each entrypoint on win32", () => {
    expect(REVIEW_ACTIONS.map((id) => paneEntrypointFor(id, "win32"))).toEqual([
      "review-windows",
      "review-staged-windows",
      "review-branch-windows",
      "review-commit-windows",
      "review-stash-windows",
    ]);
  });

  it("keeps the posix entrypoint on every platform that has a shell for it", () => {
    for (const platform of ["darwin", "linux", "freebsd"] as NodeJS.Platform[]) {
      expect(paneEntrypointFor("review", platform)).toBe("review");
    }
  });

  it("throws rather than inventing an entrypoint for an id it does not know", () => {
    expect(() => paneEntrypointFor("review:nonsense" as ReviewActionId)).toThrow(/entrypoint/i);
  });
});
