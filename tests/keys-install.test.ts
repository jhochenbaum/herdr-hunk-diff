import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { DEFAULT_BINDINGS, buildKeysBlock } from "../src/keys.js";
import { installKeys, removeKeys, resolveHerdrConfigPath } from "../src/keys-install.js";

function config(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "keys-")), "config.toml");
  writeFileSync(path, text);
  return path;
}

const CLEAN = `onboarding = false\n\n[ui]\nagent_panel_sort = "spaces"\n`;
const COLLIDING = `[[keys.command]]\nkey = "prefix+shift+h"\ntype = "shell"\ncommand = "x"\n`;
const ALL_COLLIDING = DEFAULT_BINDINGS.map(
  (b) => `[[keys.command]]\nkey = "${b.key}"\ntype = "shell"\ncommand = "mine"\n`,
).join("\n");

function timesBound(path: string, action: string): number {
  const text = readFileSync(path, "utf8");
  return text.split(`command = "${action}"`).length - 1;
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("resolveHerdrConfigPath", () => {
  const HOME = "/Users/example";
  const DEFAULT = posix.join(HOME, ".config", "herdr", "config.toml");

  it("falls back to $HOME/.config/herdr/config.toml when nothing overrides it", () => {
    expect(resolveHerdrConfigPath({ HOME }, "darwin")).toBe(DEFAULT);
  });

  it("uses the temporary directory when HOME is unavailable, as Herdr does", () => {
    expect(resolveHerdrConfigPath({}, "linux")).toBe(posix.join(tmpdir(), "herdr", "config.toml"));
  });

  it("uses HERDR_CONFIG_PATH when it is set", () => {
    expect(resolveHerdrConfigPath({ HERDR_CONFIG_PATH: "/srv/herdr/mine.toml" })).toBe(
      "/srv/herdr/mine.toml",
    );
  });

  it("does not append config.toml to a value that looks like a directory", () => {
    expect(resolveHerdrConfigPath({ HERDR_CONFIG_PATH: "/tmp/probe" })).toBe("/tmp/probe");
  });

  it("passes the value through without expanding ~", () => {
    expect(resolveHerdrConfigPath({ HERDR_CONFIG_PATH: "~/x.toml" })).toBe("~/x.toml");
  });

  it("prefers HERDR_CONFIG_PATH over XDG_CONFIG_HOME", () => {
    expect(
      resolveHerdrConfigPath({ HERDR_CONFIG_PATH: "/a/mine.toml", XDG_CONFIG_HOME: "/b" }),
    ).toBe("/a/mine.toml");
  });

  it("reads $XDG_CONFIG_HOME/herdr/config.toml when HERDR_CONFIG_PATH is unset", () => {
    expect(resolveHerdrConfigPath({ XDG_CONFIG_HOME: "/b" }, "linux")).toBe(
      posix.join("/b", "herdr", "config.toml"),
    );
  });

  it("returns a path that does not exist yet, and setup-keys creates it there", () => {
    const path = join(mkdtempSync(join(tmpdir(), "keys-")), "nested", "elsewhere.toml");
    expect(existsSync(path)).toBe(false);

    const resolved = resolveHerdrConfigPath({ HERDR_CONFIG_PATH: path });
    expect(resolved).toBe(path);
    expect(installKeys(resolved, DEFAULT_BINDINGS).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("plugin_action");
  });

  it("reports an empty HERDR_CONFIG_PATH as the no-config state herdr treats it as", () => {
    expect(resolveHerdrConfigPath({ HERDR_CONFIG_PATH: "" })).toBe("");
  });

  it("refuses to install when there is no config file path at all", () => {
    const res = installKeys("", DEFAULT_BINDINGS);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("HERDR_CONFIG_PATH");
  });

  it("refuses to remove when there is no config file path at all", () => {
    const res = removeKeys("");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("HERDR_CONFIG_PATH");
  });

  describe("on windows", () => {
    it("reads %APPDATA%/herdr/config.toml", () => {
      expect(resolveHerdrConfigPath({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "win32")).toBe(
        win32.join("C:\\Users\\x\\AppData\\Roaming", "herdr", "config.toml"),
      );
    });

    it("prefers XDG_CONFIG_HOME over APPDATA", () => {
      const path = resolveHerdrConfigPath(
        { APPDATA: "C:\\Users\\x\\AppData\\Roaming", XDG_CONFIG_HOME: "C:\\xdg" },
        "win32",
      );
      expect(path).toBe(win32.join("C:\\xdg", "herdr", "config.toml"));
    });

    it("still honours an explicit HERDR_CONFIG_PATH", () => {
      expect(
        resolveHerdrConfigPath(
          { APPDATA: "C:\\Roaming", HERDR_CONFIG_PATH: "D:\\mine.toml" },
          "win32",
        ),
      ).toBe("D:\\mine.toml");
    });

    it("falls back through USERPROFILE and then HOME", () => {
      expect(resolveHerdrConfigPath({ USERPROFILE: "C:\\Users\\x" }, "win32")).toBe(
        win32.join("C:\\Users\\x", "AppData", "Roaming", "herdr", "config.toml"),
      );
      expect(resolveHerdrConfigPath({ HOME: "C:\\Users\\x" }, "win32")).toBe(
        win32.join("C:\\Users\\x", ".config", "herdr", "config.toml"),
      );
    });

    it("uses the temporary directory when no profile variables exist", () => {
      expect(resolveHerdrConfigPath({}, "win32")).toBe(
        win32.join(tmpdir(), "herdr", "config.toml"),
      );
    });

    it("treats an empty APPDATA as set, matching Herdr's environment lookup", () => {
      expect(resolveHerdrConfigPath({ APPDATA: "" }, "win32")).toBe(
        win32.join("herdr", "config.toml"),
      );
    });
  });
});

describe("installKeys", () => {
  it("appends bindings to a clean config", () => {
    const path = config(CLEAN);
    const res = installKeys(path, DEFAULT_BINDINGS);
    expect(res.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("prefix+shift+h");
  });

  it("creates a backup before writing", () => {
    const path = config(CLEAN);
    const res = installKeys(path, DEFAULT_BINDINGS);
    expect(existsSync(res.backup!)).toBe(true);
    expect(readFileSync(res.backup!, "utf8")).toBe(CLEAN);
  });

  it("reports installing all of them when nothing collides", () => {
    const res = installKeys(config(CLEAN), DEFAULT_BINDINGS);
    expect(res.ok).toBe(true);
    expect(res.skipped).toEqual([]);
    expect(res.installed).toEqual(DEFAULT_BINDINGS);
    expect(res.message).toContain(`Installed ${DEFAULT_BINDINGS.length} keybinding(s)`);
  });

  it("installs every non-colliding binding and skips only the colliding one", () => {
    const path = config(COLLIDING);
    const res = installKeys(path, DEFAULT_BINDINGS);

    expect(res.ok).toBe(true);
    expect(res.installed!.map((b) => b.key)).toEqual([
      "prefix+shift+s",
      "prefix+shift+c",
      "prefix+shift+a",
    ]);
    expect(res.skipped!.map((b) => b.key)).toEqual(["prefix+shift+h"]);

    const text = readFileSync(path, "utf8");
    expect(text).toContain("prefix+shift+a");
    expect(timesBound(path, "jhochenbaum.hunkdiff.review")).toBe(0);
  });

  it("names each skipped key and the action it would have bound, so it can be rebound by hand", () => {
    const res = installKeys(config(COLLIDING), DEFAULT_BINDINGS);
    expect(res.message).toContain("Installed 3 of 4 keybinding(s)");
    expect(res.message).toContain("prefix+shift+h");
    expect(res.message).toContain("jhochenbaum.hunkdiff.review");
    expect(res.message).toContain("already bound");
  });

  it("installs none and says so when every proposed key collides, leaving the file untouched", () => {
    const path = config(ALL_COLLIDING);
    const res = installKeys(path, DEFAULT_BINDINGS);

    expect(res.ok).toBe(false);
    expect(res.installed).toEqual([]);
    expect(res.skipped!.map((b) => b.key)).toEqual(DEFAULT_BINDINGS.map((b) => b.key));
    expect(res.message).toContain("Installed 0");
    for (const b of DEFAULT_BINDINGS) expect(res.message).toContain(b.key);
    expect(readFileSync(path, "utf8")).toBe(ALL_COLLIDING);
    expect(res.backup).toBeUndefined();
  });

  it("never modifies the user's own binding, only appends beside it", () => {
    const userBinding = `[[keys.command]]\nkey = "prefix+shift+c"\ntype = "popup"\ncommand = "lazygit"\ndescription = "mine"\n`;
    const path = config(`${CLEAN}\n${userBinding}`);
    expect(installKeys(path, DEFAULT_BINDINGS).ok).toBe(true);

    const text = readFileSync(path, "utf8");
    expect(text).toContain(userBinding);
    expect(text.split('key = "prefix+shift+c"').length - 1).toBe(1);
    expect(text).not.toContain("jhochenbaum.hunkdiff.review:commit");
  });

  it("adds a previously-skipped binding on re-run once its key is free, without duplicating the rest", () => {
    const path = config(COLLIDING);
    expect(installKeys(path, DEFAULT_BINDINGS).skipped!.map((b) => b.key)).toEqual([
      "prefix+shift+h",
    ]);

    writeFileSync(path, readFileSync(path, "utf8").replace(COLLIDING, ""));
    const res = installKeys(path, DEFAULT_BINDINGS);

    expect(res.ok).toBe(true);
    expect(res.skipped).toEqual([]);
    const text = readFileSync(path, "utf8");
    expect(text.match(/BEGIN jhochenbaum\.hunkdiff/g)).toHaveLength(1);
    for (const b of DEFAULT_BINDINGS) expect(timesBound(path, b.action)).toBe(1);
  });

  it("is idempotent: installing twice yields one managed block", () => {
    const path = config(CLEAN);
    installKeys(path, DEFAULT_BINDINGS);
    installKeys(path, DEFAULT_BINDINGS);
    const text = readFileSync(path, "utf8");
    expect(text.match(/BEGIN jhochenbaum\.hunkdiff/g)).toHaveLength(1);
  });

  it("creates the config file when none exists", () => {
    const path = join(mkdtempSync(join(tmpdir(), "keys-")), "config.toml");
    expect(installKeys(path, DEFAULT_BINDINGS).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("plugin_action");
  });

  it("creates the parent directory when it does not exist yet", () => {
    const path = join(mkdtempSync(join(tmpdir(), "keys-")), "nested", "herdr", "config.toml");
    expect(existsSync(path)).toBe(false);
    const res = installKeys(path, DEFAULT_BINDINGS);
    expect(res.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("plugin_action");
  });

  it("skips a conflict that sits outside an already-installed managed block, keeping the rest", () => {
    const path = config(CLEAN);
    installKeys(path, DEFAULT_BINDINGS);
    const installed = readFileSync(path, "utf8");

    const outsideConflict = `[[keys.command]]\nkey = "prefix+shift+h"\ntype = "shell"\ncommand = "x"\n`;
    writeFileSync(path, `${installed}\n${outsideConflict}`);

    const res = installKeys(path, DEFAULT_BINDINGS);
    expect(res.ok).toBe(true);
    expect(res.skipped!.map((b) => b.key)).toEqual(["prefix+shift+h"]);

    const text = readFileSync(path, "utf8");
    expect(text).toContain(outsideConflict);
    expect(timesBound(path, "jhochenbaum.hunkdiff.review")).toBe(0);
    expect(text.match(/BEGIN jhochenbaum\.hunkdiff/g)).toHaveLength(1);
  });
});

describe("a config that cannot be parsed", () => {
  const BROKEN = `[keys\nsettings = "prefix+s"\n`;

  it("is refused by installKeys, which says why and leaves the bytes alone", () => {
    const path = config(BROKEN);
    const res = installKeys(path, DEFAULT_BINDINGS);

    expect(res.ok).toBe(false);
    expect(res.message).toContain(path);
    expect(res.message).toContain("valid TOML");
    expect(readFileSync(path, "utf8")).toBe(BROKEN);
    expect(res.backup).toBeUndefined();
  });

  it("can still have the managed block removed, byte-for-byte", () => {
    const path = config(`${BROKEN}\n${buildKeysBlock(DEFAULT_BINDINGS)}`);
    expect(removeKeys(path).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(BROKEN);
  });
});

describe("I/O failure handling", () => {
  it.skipIf(isRoot)(
    "installKeys returns ok:false naming the path and reason instead of throwing, when the config file is read-only",
    () => {
      const path = config(CLEAN);
      chmodSync(path, 0o444);
      try {
        const res = installKeys(path, DEFAULT_BINDINGS);
        expect(res.ok).toBe(false);
        expect(res.message).toContain(path);
        expect(readFileSync(path, "utf8")).toBe(CLEAN);
      } finally {
        chmodSync(path, 0o644);
      }
    },
  );

  it.skipIf(isRoot)(
    "removeKeys returns ok:false naming the path and reason instead of throwing, when the config file is read-only",
    () => {
      const path = config(CLEAN);
      const installed = installKeys(path, DEFAULT_BINDINGS);
      expect(installed.ok).toBe(true);
      const withManagedBlock = readFileSync(path, "utf8");

      chmodSync(path, 0o444);
      try {
        const res = removeKeys(path);
        expect(res.ok).toBe(false);
        expect(res.message).toContain(path);
        expect(readFileSync(path, "utf8")).toBe(withManagedBlock);
      } finally {
        chmodSync(path, 0o644);
      }
    },
  );
});

describe("removeKeys", () => {
  it("restores the original config byte-for-byte", () => {
    const path = config(CLEAN);
    installKeys(path, DEFAULT_BINDINGS);
    removeKeys(path);
    expect(readFileSync(path, "utf8")).toBe(CLEAN);
  });

  it("restores the original byte-for-byte after a partial install", () => {
    const original = `${CLEAN}\n${COLLIDING}`;
    const path = config(original);
    const res = installKeys(path, DEFAULT_BINDINGS);
    expect(res.skipped).toHaveLength(1);
    expect(removeKeys(path).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("is a no-op when no managed block is present", () => {
    const path = config(CLEAN);
    expect(removeKeys(path).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(CLEAN);
  });
});
