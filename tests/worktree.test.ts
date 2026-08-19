import { describe, expect, it } from "vitest";
import { worktreeKey } from "../src/worktree.js";

describe("worktreeKey", () => {
  describe("on posix", () => {
    it("leaves an ordinary path as its own identity", () => {
      expect(worktreeKey("/wt/x", "linux")).toBe("/wt/x");
    });

    it("ignores a trailing separator, which names the same directory", () => {
      expect(worktreeKey("/wt/x/", "linux")).toBe(worktreeKey("/wt/x", "linux"));
    });

    it("resolves a traversal that names the same directory the long way", () => {
      expect(worktreeKey("/wt/y/../x", "linux")).toBe(worktreeKey("/wt/x", "linux"));
    });

    // POSIX filesystems are case-sensitive, so folding case here would merge two real repositories.
    it("keeps paths that differ only in case distinct", () => {
      expect(worktreeKey("/wt/Repo", "linux")).not.toBe(worktreeKey("/wt/repo", "linux"));
    });

    it("preserves the root, which is entirely separator", () => {
      expect(worktreeKey("/", "linux")).toBe("/");
    });
  });

  describe("on windows", () => {
    // git answers `rev-parse --show-toplevel` with forward slashes even on Windows, while herdr's
    // context and event payloads use backslashes. Both name one repository.
    it("gives the backslash and forward-slash spellings one identity", () => {
      expect(worktreeKey("C:\\Users\\x\\repo", "win32")).toBe(
        worktreeKey("C:/Users/x/repo", "win32"),
      );
    });

    it("folds the drive letter, which either case names the same volume", () => {
      expect(worktreeKey("c:\\repo", "win32")).toBe(worktreeKey("C:\\repo", "win32"));
    });

    it("folds the rest of the path too, since windows compares filenames case-insensitively", () => {
      expect(worktreeKey("C:\\Users\\X\\Repo", "win32")).toBe(
        worktreeKey("c:\\users\\x\\repo", "win32"),
      );
    });

    it("ignores a trailing separator", () => {
      expect(worktreeKey("C:\\repo\\", "win32")).toBe(worktreeKey("C:\\repo", "win32"));
    });

    it("preserves a drive root, which is entirely separator after the volume", () => {
      expect(worktreeKey("C:\\", "win32")).toBe("c:\\");
    });

    it("does not merge two different repositories on the same volume", () => {
      expect(worktreeKey("C:\\a", "win32")).not.toBe(worktreeKey("C:\\b", "win32"));
    });
  });
});
