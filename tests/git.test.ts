import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitExists,
  hasCommitsAhead,
  realRunner,
  resolveBaseRef,
  type Runner,
} from "../src/git.js";

function runner(table: Record<string, { status?: number; stdout?: string }>): Runner {
  return (_cmd, args) => {
    const key = args.join(" ");
    const hit = table[key];
    return { status: hit?.status ?? 1, stdout: hit?.stdout ?? "" };
  };
}

describe("resolveBaseRef", () => {
  it("prefers the configured upstream", () => {
    const run = runner({
      "rev-parse --abbrev-ref --symbolic-full-name @{u}": { status: 0, stdout: "origin/main\n" },
    });
    expect(resolveBaseRef("/repo", run)).toBe("origin/main");
  });

  it("falls back to origin/HEAD when there is no upstream", () => {
    const run = runner({
      "symbolic-ref --short refs/remotes/origin/HEAD": { status: 0, stdout: "origin/trunk\n" },
    });
    expect(resolveBaseRef("/repo", run)).toBe("origin/trunk");
  });

  it("falls back to the first existing conventional branch", () => {
    const run = runner({
      "rev-parse --verify --quiet master": { status: 0, stdout: "abc123\n" },
    });
    expect(resolveBaseRef("/repo", run)).toBe("master");
  });

  it("returns null when nothing resolves", () => {
    expect(resolveBaseRef("/repo", runner({}))).toBeNull();
  });

  it("prefers upstream over origin/HEAD when both are available", () => {
    const run = runner({
      "rev-parse --abbrev-ref --symbolic-full-name @{u}": { status: 0, stdout: "origin/main\n" },
      "symbolic-ref --short refs/remotes/origin/HEAD": { status: 0, stdout: "origin/trunk\n" },
      "rev-parse --verify --quiet main": { status: 0, stdout: "abc123\n" },
    });
    expect(resolveBaseRef("/repo", run)).toBe("origin/main");
  });

  it("prefers origin/HEAD over conventional branches when both are available", () => {
    const run = runner({
      "symbolic-ref --short refs/remotes/origin/HEAD": { status: 0, stdout: "origin/trunk\n" },
      "rev-parse --verify --quiet main": { status: 0, stdout: "abc123\n" },
      "rev-parse --verify --quiet master": { status: 0, stdout: "def456\n" },
    });
    expect(resolveBaseRef("/repo", run)).toBe("origin/trunk");
  });

  describe("self-referential upstreams", () => {
    it("rejects an upstream that names the current branch, falling through to origin/HEAD", () => {
      const run = runner({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": {
          status: 0,
          stdout: "origin/feat/x\n",
        },
        "symbolic-ref --quiet --short HEAD": { status: 0, stdout: "feat/x\n" },
        "symbolic-ref --short refs/remotes/origin/HEAD": { status: 0, stdout: "origin/main\n" },
      });
      expect(resolveBaseRef("/repo", run)).toBe("origin/main");
    });

    it("falls through past a self-upstream all the way to a conventional branch", () => {
      const run = runner({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": {
          status: 0,
          stdout: "origin/feat/x\n",
        },
        "symbolic-ref --quiet --short HEAD": { status: 0, stdout: "feat/x\n" },
        "rev-parse --verify --quiet main": { status: 0, stdout: "abc123\n" },
      });
      expect(resolveBaseRef("/repo", run)).toBe("main");
    });

    it("still prefers an upstream that names a different branch", () => {
      const run = runner({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": { status: 0, stdout: "origin/main\n" },
        "symbolic-ref --quiet --short HEAD": { status: 0, stdout: "feat/x\n" },
        "symbolic-ref --short refs/remotes/origin/HEAD": { status: 0, stdout: "origin/trunk\n" },
      });
      expect(resolveBaseRef("/repo", run)).toBe("origin/main");
    });

    it("rejects a self-upstream behind a remote whose own name contains a slash", () => {
      const run = runner({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": {
          status: 0,
          stdout: "fork/mine/feat/x\n",
        },
        "symbolic-ref --quiet --short HEAD": { status: 0, stdout: "feat/x\n" },
        "symbolic-ref --short refs/remotes/origin/HEAD": { status: 0, stdout: "origin/main\n" },
      });
      expect(resolveBaseRef("/repo", run)).toBe("origin/main");
    });

    it("accepts the upstream when the current branch cannot be determined", () => {
      const run = runner({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": { status: 0, stdout: "origin/main\n" },
      });
      expect(resolveBaseRef("/repo", run)).toBe("origin/main");
    });

    it("rejects an origin/HEAD that names the current branch too", () => {
      const run = runner({
        "symbolic-ref --short refs/remotes/origin/HEAD": { status: 0, stdout: "origin/feat/x\n" },
        "symbolic-ref --quiet --short HEAD": { status: 0, stdout: "feat/x\n" },
        "rev-parse --verify --quiet master": { status: 0, stdout: "def456\n" },
      });
      expect(resolveBaseRef("/repo", run)).toBe("master");
    });

    it("asks for the current branch at most once per resolution", () => {
      const asked: string[] = [];
      const run: Runner = (_cmd, args) => {
        const key = args.join(" ");
        asked.push(key);
        if (key === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
          return { status: 0, stdout: "origin/feat/x\n" };
        }
        if (key === "symbolic-ref --quiet --short HEAD") return { status: 0, stdout: "feat/x\n" };
        if (key === "symbolic-ref --short refs/remotes/origin/HEAD") {
          return { status: 0, stdout: "origin/feat/x\n" };
        }
        if (key === "rev-parse --verify --quiet main") return { status: 0, stdout: "abc123\n" };
        return { status: 1, stdout: "" };
      };

      expect(resolveBaseRef("/repo", run)).toBe("main");
      expect(asked.filter((k) => k === "symbolic-ref --quiet --short HEAD")).toHaveLength(1);
    });

    it("costs one extra call for a branch with no upstream", () => {
      const asked: string[] = [];
      const run: Runner = (_cmd, args) => {
        const key = args.join(" ");
        asked.push(key);
        if (key === "symbolic-ref --quiet --short HEAD") return { status: 0, stdout: "feat/x\n" };
        if (key === "symbolic-ref --short refs/remotes/origin/HEAD") {
          return { status: 0, stdout: "origin/main\n" };
        }
        return { status: 1, stdout: "" };
      };
      expect(resolveBaseRef("/repo", run)).toBe("origin/main");
      expect(asked).toEqual([
        "rev-parse --abbrev-ref --symbolic-full-name @{u}",
        "symbolic-ref --short refs/remotes/origin/HEAD",
        "symbolic-ref --quiet --short HEAD",
      ]);
    });
  });

  it("prefers main over master and trunk when multiple conventional branches exist", () => {
    const run = runner({
      "rev-parse --verify --quiet main": { status: 0, stdout: "abc123\n" },
      "rev-parse --verify --quiet master": { status: 0, stdout: "def456\n" },
      "rev-parse --verify --quiet trunk": { status: 0, stdout: "ghi789\n" },
    });
    expect(resolveBaseRef("/repo", run)).toBe("main");
  });
});

describe("resolveBaseRef against real git", { timeout: 15_000 }, () => {
  const saved: Record<string, string | undefined> = {};
  const ENV = {
    GIT_CONFIG_GLOBAL: "",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };

  beforeAll(() => {
    const empty = join(mkdtempSync(join(tmpdir(), "hunkgitcfg-")), "gitconfig");
    writeFileSync(empty, "");
    for (const [k, v] of Object.entries({ ...ENV, GIT_CONFIG_GLOBAL: empty })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function git(repo: string, ...args: string[]): void {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if ((r.status ?? 1) !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr?.trim() || r.stdout?.trim()}`);
    }
  }

  function repoWithOrigin(): string {
    const repo = mkdtempSync(join(tmpdir(), "hunkgit-"));
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-qm", "base");
    git(repo, "remote", "add", "origin", join(repo, "unused-remote.git"));
    const head = spawnSync("git", ["rev-parse", "main"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    git(repo, "update-ref", "refs/remotes/origin/main", head);
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    return repo;
  }

  function commitOn(repo: string, branch: string, body: string): void {
    git(repo, "checkout", "-q", "-b", branch);
    writeFileSync(join(repo, "a.txt"), body);
    git(repo, "commit", "-qam", `work on ${branch}`);
  }

  it("uses origin/HEAD for a feature branch with no upstream", () => {
    const repo = repoWithOrigin();
    commitOn(repo, "feat/no-upstream", "base\nfeature\n");
    const run = realRunner(repo);

    expect(
      run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).status,
    ).not.toBe(0);
    expect(resolveBaseRef(repo, run)).toBe("origin/main");
    expect(hasCommitsAhead(repo, "origin/main", run)).toBe(true);
  });

  it("rejects the upstream of a branch tracking origin/<itself> and reviews the branch's work", () => {
    const repo = repoWithOrigin();
    commitOn(repo, "feat/pushed", "base\nfeature\n");
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    git(repo, "update-ref", "refs/remotes/origin/feat/pushed", head);
    git(repo, "config", "branch.feat/pushed.remote", "origin");
    git(repo, "config", "branch.feat/pushed.merge", "refs/heads/feat/pushed");
    const run = realRunner(repo);

    expect(
      run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).stdout.trim(),
    ).toBe("origin/feat/pushed");
    expect(hasCommitsAhead(repo, "origin/feat/pushed", run)).toBe(false);

    expect(resolveBaseRef(repo, run)).toBe("origin/main");
    expect(hasCommitsAhead(repo, "origin/main", run)).toBe(true);
  });

  it("still prefers the upstream of a branch deliberately tracking origin/main", () => {
    const repo = repoWithOrigin();
    commitOn(repo, "feat/tracks-main", "base\nfeature\n");
    git(repo, "config", "branch.feat/tracks-main.remote", "origin");
    git(repo, "config", "branch.feat/tracks-main.merge", "refs/heads/main");
    const run = realRunner(repo);

    expect(
      run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).stdout.trim(),
    ).toBe("origin/main");
    expect(resolveBaseRef(repo, run)).toBe("origin/main");
  });

  it("falls back to a conventional branch in a repo with no remote at all", () => {
    const repo = mkdtempSync(join(tmpdir(), "hunkgit-"));
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-qm", "base");
    commitOn(repo, "feat/local", "base\nfeature\n");

    expect(resolveBaseRef(repo, realRunner(repo))).toBe("main");
  });
});

describe("hasCommitsAhead", () => {
  it("is true when the branch has its own commits", () => {
    const run = runner({ "rev-list --count origin/main..HEAD": { status: 0, stdout: "3\n" } });
    expect(hasCommitsAhead("/repo", "origin/main", run)).toBe(true);
  });

  it("is false at zero commits ahead", () => {
    const run = runner({ "rev-list --count origin/main..HEAD": { status: 0, stdout: "0\n" } });
    expect(hasCommitsAhead("/repo", "origin/main", run)).toBe(false);
  });

  it("is false when the command fails", () => {
    expect(hasCommitsAhead("/repo", "origin/main", runner({}))).toBe(false);
  });
});

describe("commitExists", () => {
  it("asks git for a commit, not just any object with that name", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "" }));
    expect(commitExists("/repo", "abc1234", run)).toBe(true);
    expect(run).toHaveBeenCalledWith("git", [
      "rev-parse",
      "--verify",
      "--quiet",
      "abc1234^{commit}",
    ]);
  });

  it("is false when git cannot resolve the name", () => {
    expect(commitExists("/repo", "nope", () => ({ status: 1, stdout: "" }))).toBe(false);
  });
});
