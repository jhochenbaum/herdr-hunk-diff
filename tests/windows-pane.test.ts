import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";

const ROOT = resolve(".");
const manifest = parse(readFileSync("herdr-plugin.toml", "utf8")) as any;
const built = existsSync(join(ROOT, "dist", "bin", "pane.js"));

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  expect(r.status, r.stderr?.toString()).toBe(0);
}

// Spawns the Windows pane argv the way herdr does, from a plugin root containing a space (#29).
// Node quotes argv on Windows the same way herdr does, so this reproduces the bug there.
describe.skipIf(!built && !process.env.CI)("Windows review pane command", () => {
  it("launches hunk from a plugin root whose path contains a space", () => {
    const base = mkdtempSync(join(tmpdir(), "pane-win-"));
    const pluginRoot = join(base, "plugin root");
    symlinkSync(ROOT, pluginRoot, "junction");

    const repo = join(base, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    writeFileSync(join(repo, "f.txt"), "a\n");
    git(repo, "add", "f.txt");
    git(repo, "commit", "-qm", "init");
    writeFileSync(join(repo, "f.txt"), "a\nchanged line\n");

    const pane = manifest.panes.find((p: any) => p.id === "review-windows");
    const result = spawnSync(pane.command[0], pane.command.slice(1), {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HERDR_PLUGIN_ROOT: pluginRoot,
        HERDR_PLUGIN_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pane-cfg-")),
        HERDR_PLUGIN_STATE_DIR: mkdtempSync(join(tmpdir(), "pane-state-")),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    // Without a TTY hunk prints the diff, which proves pane.js ran and launched it.
    expect(result.stdout).toContain("changed line");
  }, 40_000);
});
