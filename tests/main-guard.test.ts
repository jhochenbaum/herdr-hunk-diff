import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule } from "../src/bin/main-guard.js";

describe("isMainModule", () => {
  const dir = mkdtempSync(join(tmpdir(), "main-guard-"));

  function entrypoint(name: string): { path: string; url: string } {
    const path = join(dir, name);
    writeFileSync(path, "export {};\n");
    return { path, url: pathToFileURL(realpathSync(path)).href };
  }

  it("recognises a module invoked by its own plain path", () => {
    const { path, url } = entrypoint("plain.mjs");
    expect(isMainModule(url, path)).toBe(true);
  });

  it("recognises a module invoked through a symlink to it", () => {
    const { path, url } = entrypoint("target.mjs");
    const link = join(dir, "link.mjs");
    symlinkSync(path, link);
    expect(isMainModule(url, link)).toBe(true);
  });

  it("recognises a path containing characters a URL percent-encodes", () => {
    const { path, url } = entrypoint("a file #1.mjs");
    expect(isMainModule(url, path)).toBe(true);
    expect(url).not.toBe(`file://${realpathSync(path)}`);
  });

  it("recognises this very test module, invoked the way Node reports it", () => {
    expect(isMainModule(import.meta.url, fileURLToPath(import.meta.url))).toBe(true);
  });

  it("rejects an unrelated entrypoint", () => {
    const { url } = entrypoint("mine.mjs");
    expect(isMainModule(url, join(dir, "someone-elses.mjs"))).toBe(false);
  });

  it("returns false rather than throwing when there is no entrypoint argument", () => {
    const { url } = entrypoint("no-argv.mjs");
    expect(isMainModule(url, undefined)).toBe(false);
  });

  it("compares an unresolvable path as given instead of throwing", () => {
    const missing = join(dir, "does-not-exist.mjs");
    expect(() => isMainModule(pathToFileURL(missing).href, missing)).not.toThrow();
    expect(isMainModule(pathToFileURL(missing).href, missing)).toBe(true);
  });
});
