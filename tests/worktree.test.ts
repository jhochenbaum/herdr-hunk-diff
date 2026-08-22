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

    it("keeps paths that differ only in case distinct", () => {
      expect(worktreeKey("/wt/Repo", "linux")).not.toBe(worktreeKey("/wt/repo", "linux"));
    });

    it("preserves the root, which is entirely separator", () => {
      expect(worktreeKey("/", "linux")).toBe("/");
    });
  });

  describe("on windows", () => {
    it("gives the backslash and forward-slash spellings one identity", () => {
      expect(worktreeKey("C:\\Users\\x\\repo", "win32")).toBe(
        worktreeKey("C:/Users/x/repo", "win32"),
      );
    });

    it("folds the drive letter, which either case names the same volume", () => {
      expect(worktreeKey("c:\\repo", "win32")).toBe(worktreeKey("C:\\repo", "win32"));
    });

    it("uses the filesystem's canonical spelling to unify aliases", () => {
      const canonical = () => "C:\\Users\\X\\Repo";
      expect(worktreeKey("C:\\Users\\X\\Repo", "win32", canonical)).toBe(
        worktreeKey("c:\\users\\x\\repo", "win32", canonical),
      );
    });

    it("keeps distinct casing when the filesystem says both paths exist", () => {
      const asSpelled = (path: string) => path;
      expect(worktreeKey("C:\\work\\Repo", "win32", asSpelled)).not.toBe(
        worktreeKey("C:\\work\\repo", "win32", asSpelled),
      );
    });

    it("keeps component case when a removed path cannot be resolved", () => {
      const missing = () => {
        throw new Error("ENOENT");
      };
      expect(worktreeKey("C:\\work\\Repo", "win32", missing)).not.toBe(
        worktreeKey("C:\\work\\repo", "win32", missing),
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
