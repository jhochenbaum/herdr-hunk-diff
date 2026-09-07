import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(managers: Record<string, { versionStatus?: number; runStatus?: number }> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunk build ")));
  temporary.push(dir);
  const root = join(dir, "plugin");
  const bin = join(dir, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  cpSync("scripts", join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }),
  );
  writeFileSync(join(root, "package-lock.json"), "{}");
  const log = join(dir, "calls.jsonl");
  const helper = join(dir, "manager.cjs");
  writeFileSync(
    helper,
    `
    const fs = require("node:fs");
    const [manager, ...args] = process.argv.slice(2);
    const config = ${JSON.stringify(managers)}[manager];
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ manager, args, cwd: process.cwd() }) + "\\n");
    process.exit(args[0] === "--version" ? (config.versionStatus ?? 0) : (config.runStatus ?? 0));
  `,
  );
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  for (const manager of Object.keys(managers)) {
    if (process.platform === "win32") {
      writeFileSync(
        join(bin, `${manager}.cmd`),
        `@echo off\r\n"${process.execPath}" "${helper}" ${manager} %*\r\n`,
      );
    } else {
      writeFileSync(
        join(bin, manager),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(helper)} ${quote(manager)} "$@"\n`,
        { mode: 0o755 },
      );
    }
  }
  return {
    root,
    run(script = "install-deps.mjs", args: string[] = [], override = "") {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
      return spawnSync(process.execPath, [join(root, "scripts", script), ...args], {
        cwd: dir,
        encoding: "utf8",
        env: { ...env, PATH: bin, HUNKDIFF_PACKAGE_MANAGER: override },
      });
    },
    calls(): Array<{ manager: string; args: string[]; cwd: string }> {
      try {
        return readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

describe("package manager build scripts", () => {
  it("prefers npm ci and runs in the plugin root from another directory", () => {
    const f = fixture({ npm: {}, pnpm: {} });
    expect(f.run().status).toBe(0);
    expect(f.calls().at(-1)).toEqual({ manager: "npm", args: ["ci"], cwd: f.root });
    expect(f.calls().some((call) => call.manager === "pnpm")).toBe(false);
  });

  it.each([{}, { npm: { versionStatus: 1 } }])(
    "falls back to pnpm when npm cannot run (%j)",
    (other) => {
      const f = fixture({ ...other, pnpm: {} });
      expect(f.run().status).toBe(0);
      expect(f.calls().at(-1)).toEqual({
        manager: "pnpm",
        args: ["install", "--ignore-scripts"],
        cwd: f.root,
      });
    },
  );

  it("honors an explicit pnpm override even when npm is available", () => {
    const f = fixture({ npm: {}, pnpm: {} });
    expect(f.run("install-deps.mjs", [], " pnpm ").status).toBe(0);
    expect(f.calls().every((call) => call.manager === "pnpm")).toBe(true);
  });

  it("fails when the explicitly requested manager is unavailable", () => {
    const f = fixture({ pnpm: {} });
    const result = f.run("install-deps.mjs", [], "npm");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm did not run");
    expect(f.calls()).toEqual([]);
  });

  it.each(["yarn", "constructor", "toString", "__proto__"])(
    "rejects unsupported manager %s before executing it",
    (manager) => {
      const f = fixture({ [manager]: {} });
      const result = f.run("install-deps.mjs", [], manager);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is not supported");
      expect(f.calls()).toEqual([]);
    },
  );

  it("names the supported managers when neither is installed", () => {
    const result = fixture().run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Install npm or pnpm");
  });

  it("propagates install failure without retrying a different manager", () => {
    const f = fixture({ npm: { runStatus: 7 }, pnpm: {} });
    expect(f.run().status).toBe(7);
    expect(f.calls().some((call) => call.manager === "pnpm")).toBe(false);
  });

  it("runs the requested build script through pnpm and propagates its status", () => {
    const f = fixture({ pnpm: { runStatus: 3 } });
    expect(f.run("run-script.mjs", ["build"]).status).toBe(3);
    expect(f.calls().at(-1)).toEqual({ manager: "pnpm", args: ["run", "build"], cwd: f.root });
  });

  it.each([[], ["unknown"], ["build&echo injected"], ["--help"]])(
    "rejects missing or invalid script arguments %j",
    (...args) => {
      const f = fixture({ npm: {} });
      expect(f.run("run-script.mjs", args).status).toBe(1);
      expect(f.calls()).toEqual([]);
    },
  );
});
