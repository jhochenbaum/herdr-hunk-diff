import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  installPager,
  looksLikePath,
  MANUAL_PAGER_SETUP,
  onPath,
  realPagerEffects,
  uninstallPager,
  type Vcs,
} from "../src/pager.js";

function fakePath(...binaries: string[]): {
  pathEnv: string;
  isExecutable: (p: string) => boolean;
} {
  const dirs = ["/usr/bin", "/opt/homebrew/bin"];
  const real = new Set(binaries.flatMap((b) => dirs.map((d) => posix.join(d, b))));
  return { pathEnv: dirs.join(posix.delimiter), isExecutable: (p) => real.has(p) };
}

const present =
  (...vcs: Vcs[]) =>
  (v: Vcs) =>
    vcs.includes(v);

function fakeGit(status = 0) {
  const calls: string[][] = [];
  return {
    calls,
    run: vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      return { status, stdout: "" };
    }),
  };
}

function fakeGitConfig(
  initial: string[] = [],
  opts: { unsetStatus?: number; setStatus?: number } = {},
) {
  const values = [...initial];
  const calls: string[][] = [];
  return {
    calls,
    get writes() {
      return calls.filter((a) => !a.includes("--get-all"));
    },
    get values() {
      return [...values];
    },
    run: vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      const [sub, scope, ...rest] = args;
      if (sub !== "config" || scope !== "--global")
        throw new Error(`unexpected git ${args.join(" ")}`);
      if (rest[0] === "--get-all") {
        return values.length === 0
          ? { status: 1, stdout: "" }
          : { status: 0, stdout: `${values.join("\n")}\n` };
      }
      if (rest[0] === "--unset") {
        if (opts.unsetStatus !== undefined) return { status: opts.unsetStatus, stdout: "" };
        if (values.length === 0) return { status: 5, stdout: "" };
        if (values.length > 1) return { status: 5, stdout: "" };
        values.length = 0;
        return { status: 0, stdout: "" };
      }
      if (opts.setStatus !== undefined) return { status: opts.setStatus, stdout: "" };
      values.length = 0;
      values.push(rest[1]!);
      return { status: 0, stdout: "" };
    }),
  };
}

describe("onPath", () => {
  // Keep POSIX cases independent of the test host.
  const POSIX: [string | undefined, NodeJS.Platform] = [undefined, "linux"];

  it("finds a binary that is executable in a PATH entry", () => {
    const { pathEnv, isExecutable } = fakePath("git");
    expect(onPath("git", pathEnv, isExecutable, ...POSIX)).toBe(true);
  });

  it("does not find a binary that is in no PATH entry", () => {
    const { pathEnv, isExecutable } = fakePath("git");
    expect(onPath("jj", pathEnv, isExecutable, ...POSIX)).toBe(false);
    expect(onPath("sl", pathEnv, isExecutable, ...POSIX)).toBe(false);
  });

  it("finds nothing when PATH is absent or empty", () => {
    const { isExecutable } = fakePath("git");
    expect(onPath("git", undefined, isExecutable, ...POSIX)).toBe(false);
    expect(onPath("git", "", isExecutable, ...POSIX)).toBe(false);
  });

  it("skips an empty PATH entry rather than resolving it relative to the cwd", () => {
    expect(onPath("git", "/usr/bin:", (p) => p === "git" || p === join(".", "git"), ...POSIX)).toBe(
      false,
    );
  });

  describe("on windows", () => {
    const PATHEXT = ".COM;.EXE;.BAT;.CMD";

    it("finds git.exe when the search name is bare git", () => {
      const isExecutable = (p: string) => p === "C:\\Program Files\\Git\\cmd\\git.exe";
      expect(onPath("git", "C:\\Program Files\\Git\\cmd", isExecutable, PATHEXT, "win32")).toBe(
        true,
      );
    });

    it("finds a command shipped as a .cmd shim", () => {
      const isExecutable = (p: string) => p === win32.join("C:\\tools", "hunk.cmd");
      expect(onPath("hunk", "C:\\tools", isExecutable, PATHEXT, "win32")).toBe(true);
    });

    it("does not accept an extensionless file, which windows cannot execute", () => {
      const isExecutable = (p: string) => p === win32.join("C:\\tools", "git");
      expect(onPath("git", "C:\\tools", isExecutable, PATHEXT, "win32")).toBe(false);
    });

    it("honours a PATHEXT that omits an extension", () => {
      const isExecutable = (p: string) => p === win32.join("C:\\tools", "hunk.cmd");
      expect(onPath("hunk", "C:\\tools", isExecutable, ".EXE", "win32")).toBe(false);
    });

    it("falls back to the standard PATHEXT when the variable is unset", () => {
      const isExecutable = (p: string) => p === win32.join("C:\\tools", "git.exe");
      expect(onPath("git", "C:\\tools", isExecutable, undefined, "win32")).toBe(true);
    });

    it("searches a name that already carries an extension as given", () => {
      const isExecutable = (p: string) => p === win32.join("C:\\tools", "git.exe");
      expect(onPath("git.exe", "C:\\tools", isExecutable, PATHEXT, "win32")).toBe(true);
    });

    it("rejects a supplied extension that PATHEXT does not make executable", () => {
      const isExecutable = (p: string) => p === win32.join("C:\\tools", "git.txt");
      expect(onPath("git.txt", "C:\\tools", isExecutable, PATHEXT, "win32")).toBe(false);
    });
  });
});

describe("looksLikePath", () => {
  it("treats a posix path as a path and a bare name as a command", () => {
    expect(looksLikePath("/usr/local/bin/hunk", "linux")).toBe(true);
    expect(looksLikePath("hunk", "linux")).toBe(false);
  });

  it("reads a backslash path as a path only on windows", () => {
    expect(looksLikePath("C:\\tools\\hunk.exe", "win32")).toBe(true);
    expect(looksLikePath("C:\\tools\\hunk.exe", "linux")).toBe(false);
  });
});

describe("realPagerEffects.canRun", () => {
  // Avoid assumptions about binaries installed on the test host.
  function probe(): { dir: string; command: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "pager-bin-"));
    const command = "hunkprobe";
    const windows = process.platform === "win32";
    const file = join(dir, windows ? `${command}.cmd` : command);
    writeFileSync(file, windows ? "@echo off\r\n" : "#!/bin/sh\n");
    if (!windows) chmodSync(file, 0o755);
    return { dir, command, file };
  }

  const effects = (dir: string) =>
    realPagerEffects({ PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, () => ({
      status: 0,
      stdout: "",
    }));

  it("finds a bare command on PATH", () => {
    const { dir, command } = probe();
    expect(effects(dir).canRun(command)).toBe(true);
    expect(effects(dir).canRun("definitely-not-a-real-binary-xyz")).toBe(false);
  });

  it("checks a path where it points rather than on PATH", () => {
    const { dir, file } = probe();
    expect(effects(dir).canRun(file)).toBe(true);
    expect(effects(dir).canRun(join(dir, "definitely-not-a-real-binary-xyz"))).toBe(false);
  });

  it("does not accept a directory", () => {
    const { dir } = probe();
    expect(effects(dir).canRun(dir)).toBe(false);
  });

  it("accepts a direct Windows command path only when its extension is in PATHEXT", () => {
    const dir = mkdtempSync(join(tmpdir(), "pager-win-bin-"));
    const command = join(dir, "hunk.cmd");
    const text = join(dir, "hunk.txt");
    const extensionless = join(dir, "hunk");
    for (const file of [command, text, extensionless]) writeFileSync(file, "probe");

    const windows = realPagerEffects(
      { PATH: "", PATHEXT: ".EXE;.CMD" },
      () => ({ status: 0, stdout: "" }),
      "win32",
    );
    expect(windows.canRun(command)).toBe(true);
    expect(windows.canRun(text)).toBe(false);
    expect(windows.canRun(extensionless)).toBe(false);
  });
});

describe("the documented manual setup", () => {
  it("quotes jj's own instructions, including the diff-formatter it requires", () => {
    expect(MANUAL_PAGER_SETUP.jj.command).toBe("jj config edit --user");
    expect(MANUAL_PAGER_SETUP.jj.snippet).toBe(
      '[ui]\npager = ["hunk", "pager"]\ndiff-formatter = ":git"',
    );
  });

  it("quotes sl's own instructions, in sl's ini spelling rather than jj's array", () => {
    expect(MANUAL_PAGER_SETUP.sl.command).toBe("sl config -u");
    expect(MANUAL_PAGER_SETUP.sl.snippet).toBe("[pager]\npager = hunk pager");
  });
});

describe("installPager", () => {
  it("configures git automatically, which is the one VCS whose setup is scriptable", () => {
    const git = fakeGitConfig();
    const result = installPager({ present: present("git"), git: git.run, canRun: () => true });
    expect(result.ok).toBe(true);
    expect(git.writes).toEqual([["config", "--global", "core.pager", "hunk pager"]]);
    expect(result.message).toMatch(/git pager/i);
  });

  it("reports a failing git config rather than claiming success", () => {
    const git = fakeGitConfig([], { setStatus: 1 });
    const result = installPager({ present: present("git"), git: git.run, canRun: () => true });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not update git config/i);
  });

  it("prints jj's snippet and the command that opens its config, and says it cannot automate it", () => {
    const git = fakeGit();
    const result = installPager({ present: present("jj"), git: git.run, canRun: () => true });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("jj config edit --user");
    expect(result.message).toContain('pager = ["hunk", "pager"]');
    expect(result.message).toContain('diff-formatter = ":git"');
    expect(result.message).toMatch(/cannot be (set up|configured) automatically|by hand/i);
  });

  it("prints sl's snippet and the command that opens its config", () => {
    const git = fakeGit();
    const result = installPager({ present: present("sl"), git: git.run, canRun: () => true });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("sl config -u");
    expect(result.message).toContain("pager = hunk pager");
  });

  it("says nothing about a VCS that is not installed", () => {
    const git = fakeGit();
    const result = installPager({ present: present("git"), git: git.run, canRun: () => true });
    expect(result.message).not.toMatch(/jj|sapling|\bsl\b/i);
  });

  it("covers every installed VCS in one run, not just the first", () => {
    const git = fakeGitConfig();
    const result = installPager({
      present: present("git", "jj", "sl"),
      git: git.run,
      canRun: () => true,
    });
    expect(result.ok).toBe(true);
    expect(git.writes).toHaveLength(1);
    expect(result.message).toContain("jj config edit --user");
    expect(result.message).toContain("sl config -u");
    expect(result.message).toMatch(/git pager/i);
  });

  it("never runs git when git is not installed", () => {
    const git = fakeGit();
    const result = installPager({ present: present("jj"), git: git.run, canRun: () => true });
    expect(git.run).not.toHaveBeenCalled();
    expect(result.message).not.toMatch(/could not update git config/i);
  });

  it("reports finding no VCS at all rather than silently succeeding", () => {
    const git = fakeGit();
    const result = installPager({ present: present(), git: git.run, canRun: () => true });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no (git|supported)/i);
    expect(git.run).not.toHaveBeenCalled();
  });
});

describe("what installPager is willing to write into core.pager", () => {
  it("writes hunk's documented bare command when hunk is on the user's PATH", () => {
    const git = fakeGitConfig();
    const result = installPager({ present: present("git"), git: git.run, canRun: () => true });
    expect(result.ok).toBe(true);
    expect(git.values).toEqual(["hunk pager"]);
  });

  it("asks whether the executable can run, not whether the pager string can", () => {
    const canRun = vi.fn(() => true);
    installPager({ present: present("git"), git: fakeGitConfig().run, canRun });
    expect(canRun).toHaveBeenCalledWith("hunk");
  });

  it("refuses, rather than writing a pager the user's shell cannot start", () => {
    const git = fakeGitConfig();
    const result = installPager({ present: present("git"), git: git.run, canRun: () => false });
    expect(result.ok).toBe(false);
    expect(git.writes).toEqual([]);
    expect(git.values).toEqual([]);
    expect(result.message).toContain("npm i -g hunkdiff");
  });

  it("never writes the bundled plugin path, whose location changes on every plugin update", () => {
    const git = fakeGitConfig();
    installPager({ present: present("git"), git: git.run, canRun: () => true });
    expect(git.values[0]).not.toContain("node_modules");
    expect(git.values[0]).not.toContain("/");
  });

  it("writes the configured bin when the user has named one explicitly", () => {
    const git = fakeGitConfig();
    const result = installPager(
      { present: present("git"), git: git.run, canRun: () => true },
      "/opt/hunk/bin/hunk",
    );
    expect(result.ok).toBe(true);
    expect(git.values).toEqual(["/opt/hunk/bin/hunk pager"]);
  });

  it("quotes a configured bin containing a space, which git's shell would otherwise split", () => {
    const git = fakeGitConfig();
    installPager(
      { present: present("git"), git: git.run, canRun: () => true },
      "/Applications/My Tools/hunk",
    );
    expect(git.values).toEqual(["'/Applications/My Tools/hunk' pager"]);
  });

  it("refuses a relative bin, which would resolve differently in every directory", () => {
    const git = fakeGitConfig();
    const result = installPager(
      { present: present("git"), git: git.run, canRun: () => true },
      "./bin/hunk",
    );
    expect(result.ok).toBe(false);
    expect(git.writes).toEqual([]);
    expect(result.message).toContain("./bin/hunk");
    expect(result.message).toMatch(/relative/i);
  });

  it("refuses a configured bin that cannot run, and names it", () => {
    const git = fakeGitConfig();
    const result = installPager(
      { present: present("git"), git: git.run, canRun: () => false },
      "/opt/gone/hunk",
    );
    expect(result.ok).toBe(false);
    expect(git.writes).toEqual([]);
    expect(result.message).toContain("/opt/gone/hunk");
  });

  it("warns that the jj and sl snippets need the same hunk it just refused to write", () => {
    const result = installPager({
      present: present("git", "jj"),
      git: fakeGitConfig().run,
      canRun: () => false,
    });
    expect(result.message).toMatch(/snippets below/i);
  });

  it("does not mention snippets that were not printed", () => {
    const result = installPager({
      present: present("git"),
      git: fakeGitConfig().run,
      canRun: () => false,
    });
    expect(result.message).not.toMatch(/snippets below/i);
  });

  it("says nothing about hunk being unavailable when git is not installed", () => {
    const result = installPager({
      present: present("jj"),
      git: fakeGitConfig().run,
      canRun: () => false,
    });
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("npm i -g hunkdiff");
  });
});

describe("installPager reading the current core.pager before writing", () => {
  it("reads core.pager before writing, the same way uninstall does", () => {
    const git = fakeGitConfig();
    installPager({ present: present("git"), git: git.run, canRun: () => true });
    expect(git.calls[0]).toEqual(["config", "--global", "--get-all", "core.pager"]);
  });

  it("reports a plain install when core.pager was absent", () => {
    const git = fakeGitConfig();
    const result = installPager({ present: present("git"), git: git.run, canRun: () => true });
    expect(result.ok).toBe(true);
    expect(git.values).toEqual(["hunk pager"]);
    expect(result.message).toMatch(/hunk installed as your git pager/i);
  });

  it("says core.pager is already configured, rather than implying a change was made", () => {
    const git = fakeGitConfig(["hunk pager"]);
    const result = installPager({ present: present("git"), git: git.run, canRun: () => true });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/already configured/i);
    expect(result.message).not.toMatch(/replac/i);
  });

  it("names the value it replaces and gives the exact command to restore it", () => {
    const git = fakeGitConfig(["delta --dark"]);
    const result = installPager({ present: present("git"), git: git.run, canRun: () => true });
    expect(result.ok).toBe(true);
    expect(git.values).toEqual(["hunk pager"]);
    expect(result.message).toContain("delta --dark");
    expect(result.message).toContain("git config --global core.pager 'delta --dark'");
  });

  it("still installs when replacing something else — overwriting is the intended default", () => {
    const git = fakeGitConfig(["less -R"]);
    const result = installPager({ present: present("git"), git: git.run, canRun: () => true });
    expect(result.ok).toBe(true);
    expect(git.values).toEqual(["hunk pager"]);
  });

  it("refuses a multi-valued core.pager instead of guessing which value to keep", () => {
    const git = fakeGitConfig(["one", "two"]);
    const result = installPager({ present: present("git"), git: git.run, canRun: () => true });
    expect(result.ok).toBe(false);
    expect(git.writes).toEqual([]);
    expect(git.values).toEqual(["one", "two"]);
    expect(result.message).toMatch(/multiple values/i);
  });

  it("refuses to write when it could not read the current value", () => {
    const git = fakeGit(128);
    const result = installPager({ present: present("git"), git: git.run, canRun: () => true });
    expect(result.ok).toBe(false);
    expect(git.calls).toEqual([["config", "--global", "--get-all", "core.pager"]]);
    expect(result.message).toMatch(/could not read/i);
  });
});

describe("uninstallPager", () => {
  it("reads core.pager before it considers writing anything", () => {
    const git = fakeGitConfig(["hunk pager"]);
    uninstallPager({ present: present("git"), git: git.run });
    expect(git.calls[0]).toEqual(["config", "--global", "--get-all", "core.pager"]);
  });

  it("treats git's exit 5 — the key went away before the unset — as success", () => {
    const git = fakeGitConfig(["hunk pager"], { unsetStatus: 5 });
    expect(uninstallPager({ present: present("git"), git: git.run }).ok).toBe(true);
  });

  it("still fails on a genuine git error from the unset", () => {
    const git = fakeGitConfig(["hunk pager"], { unsetStatus: 128 });
    const result = uninstallPager({ present: present("git"), git: git.run });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not update git config/i);
  });

  it("refuses to write when it could not read the current value", () => {
    const git = fakeGit(128);
    const result = uninstallPager({ present: present("git"), git: git.run });
    expect(result.ok).toBe(false);
    expect(git.calls).toEqual([["config", "--global", "--get-all", "core.pager"]]);
    expect(result.message).toMatch(/could not read/i);
  });

  it("leaves a pager this plugin did not install alone, and does not claim to have removed hunk", () => {
    const git = fakeGitConfig(["delta"]);
    const result = uninstallPager({ present: present("git"), git: git.run });
    expect(git.writes).toEqual([]);
    expect(git.values).toEqual(["delta"]);
    expect(result.message).not.toMatch(/hunk removed as your git pager/i);
  });

  it("names the pager it found, so the user knows why nothing changed", () => {
    const git = fakeGitConfig(["delta --dark"]);
    const result = uninstallPager({ present: present("git"), git: git.run });
    expect(result.message).toContain("delta --dark");
  });

  it("removes the value install-pager writes, and only after reading it", () => {
    const git = fakeGitConfig(["hunk pager"]);
    const result = uninstallPager({ present: present("git"), git: git.run });
    expect(result.ok).toBe(true);
    expect(git.calls).toEqual([
      ["config", "--global", "--get-all", "core.pager"],
      ["config", "--global", "--unset", "core.pager"],
    ]);
    expect(git.values).toEqual([]);
    expect(result.message).toMatch(/hunk removed as your git pager/i);
  });

  it("reports an unset core.pager as already-there rather than removing something", () => {
    const git = fakeGitConfig([]);
    const result = uninstallPager({ present: present("git"), git: git.run });
    expect(result.ok).toBe(true);
    expect(git.writes).toEqual([]);
    expect(result.message).toMatch(/not (set|configured|using)/i);
  });

  it("refuses a multi-valued core.pager instead of guessing which value is ours", () => {
    const git = fakeGitConfig(["hunk pager", "delta"]);
    const result = uninstallPager({ present: present("git"), git: git.run });
    expect(result.ok).toBe(false);
    expect(git.writes).toEqual([]);
    expect(result.message).toMatch(/multiple values/i);
  });

  it("removes the value install writes for a configured bin", () => {
    const git = fakeGitConfig(["'/Applications/My Tools/hunk' pager"]);
    const result = uninstallPager(
      { present: present("git"), git: git.run },
      "/Applications/My Tools/hunk",
    );
    expect(result.ok).toBe(true);
    expect(git.values).toEqual([]);
  });

  it("still recognises the bare documented form when a bin is configured", () => {
    const git = fakeGitConfig(["hunk pager"]);
    const result = uninstallPager({ present: present("git"), git: git.run }, "/opt/hunk/bin/hunk");
    expect(result.ok).toBe(true);
    expect(git.values).toEqual([]);
  });

  it("tells the user which lines to remove by hand for jj and sl", () => {
    const git = fakeGit();
    const result = uninstallPager({ present: present("jj", "sl"), git: git.run });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("jj config edit --user");
    expect(result.message).toContain("sl config -u");
    expect(result.message).toMatch(/remove/i);
  });
});
