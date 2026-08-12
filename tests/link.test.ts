import { describe, expect, it } from "vitest";
import { parseGithubUrl } from "../src/notes.js";

describe("parseGithubUrl", () => {
  it("parses a pull request url", () => {
    expect(parseGithubUrl("https://github.com/o/r/pull/42")).toEqual({
      kind: "pull",
      ref: "42",
    });
  });

  it("parses a commit url", () => {
    expect(parseGithubUrl("https://github.com/o/r/commit/abc1234")).toEqual({
      kind: "commit",
      ref: "abc1234",
    });
  });

  it("returns null for an unrelated url", () => {
    expect(parseGithubUrl("https://example.com/x")).toBeNull();
  });

  it("returns null for a github url that is not a pr or commit", () => {
    expect(parseGithubUrl("https://github.com/o/r/issues/9")).toBeNull();
  });

  it("returns null for a bare repo url", () => {
    expect(parseGithubUrl("https://github.com/o/r")).toBeNull();
  });

  it("returns null for a pull url with extra trailing path segments", () => {
    expect(parseGithubUrl("https://github.com/o/r/pull/42/files")).toBeNull();
  });

  it("returns null for a non-https github url", () => {
    expect(parseGithubUrl("http://github.com/o/r/pull/42")).toBeNull();
  });

  it("accepts a trailing slash on a commit url", () => {
    expect(parseGithubUrl("https://github.com/o/r/commit/abc1234/")).toEqual({
      kind: "commit",
      ref: "abc1234",
    });
  });
});
