import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig } from "../src/config.js";

function withConfig(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hunkcfg-"));
  writeFileSync(join(dir, "config.toml"), toml);
  return dir;
}

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "hunkcfg-"));
    expect(loadConfig(dir)).toEqual(DEFAULTS);
  });

  it("defaults auto_open to false, leaving finish notifications to herdr", () => {
    expect(DEFAULTS.review.auto_open).toBe(false);
  });

  it("merges partial user config over defaults", () => {
    const dir = withConfig(`[review]\nauto_open = true\n`);
    const cfg = loadConfig(dir);
    expect(cfg.review.auto_open).toBe(true);
    expect(cfg.review.reuse_pane).toBe(true);
    expect(cfg.roundtrip.clear_after_send).toBe(true);
  });

  it("exposes no config keys the plugin does not act on", () => {
    expect(Object.keys(DEFAULTS.review).sort()).toEqual([
      "auto_open",
      "default_target",
      "exclude_untracked",
      "on_states",
      "placement",
      "reuse_pane",
      "watch",
    ]);
    expect(Object.keys(DEFAULTS.roundtrip).sort()).toEqual(["clear_after_send", "prompt_template"]);
  });

  it("ignores a removed key left behind in a user's config file", () => {
    const dir = withConfig(`[roundtrip]\nsend_on = "on_close"\n`);
    expect(loadConfig(dir).roundtrip).not.toHaveProperty("send_on");
  });

  it("ignores an include_rationale left behind in a user's config file", () => {
    const dir = withConfig(`[roundtrip]\ninclude_rationale = false\n`);
    expect(loadConfig(dir).roundtrip).not.toHaveProperty("include_rationale");
  });

  it("accepts every placement that returns a pane id", () => {
    for (const placement of ["overlay", "split", "tab", "zoomed"] as const) {
      expect(
        loadConfig(withConfig(`[review]\nplacement = "${placement}"\n`)).review.placement,
      ).toBe(placement);
    }
  });

  it("falls back for popup, which opens without a pane id the plugin can address", () => {
    expect(loadConfig(withConfig(`[review]\nplacement = "popup"\n`)).review.placement).toBe(
      DEFAULTS.review.placement,
    );
  });

  it("falls back to the manifest's own split placement for a value herdr would reject", () => {
    expect(loadConfig(withConfig(`[review]\nplacement = "sidebar"\n`)).review.placement).toBe(
      "split",
    );
    expect(DEFAULTS.review.placement).toBe("split");
  });

  it("rejects a string auto_open value and falls back to the default", () => {
    const dir = withConfig(`[review]\nauto_open = "on"\n`);
    expect(loadConfig(dir).review.auto_open).toBe(false);
  });

  it("exposes no presentational hunk keys, which belong to hunk's own config", () => {
    expect(Object.keys(DEFAULTS.hunk).sort()).toEqual(["bin", "experimental", "extra_args"]);
    for (const key of ["theme", "mode", "line_numbers", "tab_width", "wrap"]) {
      expect(DEFAULTS.hunk).not.toHaveProperty(key);
    }
  });

  it("exposes no config section that gates nothing", () => {
    expect(DEFAULTS).not.toHaveProperty("agents");
    expect(Object.keys(DEFAULTS).sort()).toEqual(["hunk", "review", "roundtrip"]);
  });

  it("ignores an [agents] section left behind in a user's file rather than failing to load", () => {
    const cfg = loadConfig(
      withConfig(`[agents]\nannotate = false\nnavigate = true\n\n[review]\nwatch = true\n`),
    );
    expect(cfg).not.toHaveProperty("agents");
    expect(cfg.review.watch).toBe(true);
  });

  describe("the flags promoted out of extra_args", () => {
    it("reads exclude_untracked and experimental from the file", () => {
      const dir = withConfig(`[review]\nexclude_untracked = true\n\n[hunk]\nexperimental = true\n`);
      const cfg = loadConfig(dir);
      expect(cfg.review.exclude_untracked).toBe(true);
      expect(cfg.hunk.experimental).toBe(true);
    });

    it("defaults both to off, so an untouched config emits neither flag", () => {
      expect(DEFAULTS.review.exclude_untracked).toBe(false);
      expect(DEFAULTS.hunk.experimental).toBe(false);
    });

    it("falls back to off for a non-boolean value rather than reading it as truthy", () => {
      const dir = withConfig(
        `[review]\nexclude_untracked = "false"\n\n[hunk]\nexperimental = "yes"\n`,
      );
      const cfg = loadConfig(dir);
      expect(cfg.review.exclude_untracked).toBe(false);
      expect(cfg.hunk.experimental).toBe(false);
    });
  });

  describe("array-valued keys", () => {
    it("reads a well-formed extra_args and on_states from the file", () => {
      const cfg = loadConfig(
        withConfig(
          `[review]\non_states = ["idle", "blocked"]\n\n[hunk]\nextra_args = ["--wide"]\n`,
        ),
      );
      expect(cfg.review.on_states).toEqual(["idle", "blocked"]);
      expect(cfg.hunk.extra_args).toEqual(["--wide"]);
    });

    it("rejects a non-array for either key", () => {
      const cfg = loadConfig(
        withConfig(`[review]\non_states = "idle"\n\n[hunk]\nextra_args = "-w"\n`),
      );
      expect(cfg.review.on_states).toEqual(DEFAULTS.review.on_states);
      expect(cfg.hunk.extra_args).toEqual(DEFAULTS.hunk.extra_args);
    });

    it("rejects the whole extra_args when any element is not a string", () => {
      const cfg = loadConfig(withConfig(`[hunk]\nextra_args = ["--context", 5]\n`));
      expect(cfg.hunk.extra_args).toEqual([]);
    });

    it("keeps a number out of the launch argv entirely", () => {
      expect(loadConfig(withConfig(`[hunk]\nextra_args = [1]\n`)).hunk.extra_args).toEqual([]);
      for (const arg of loadConfig(withConfig(`[hunk]\nextra_args = [1]\n`)).hunk.extra_args) {
        expect(typeof arg).toBe("string");
      }
    });

    it("defaults on_states to the completion state observed by the event hook", () => {
      expect(DEFAULTS.review.on_states).toEqual(["idle"]);
    });

    it("falls back to the default for done, which no manifest rule can produce", () => {
      const cfg = loadConfig(withConfig(`[review]\non_states = ["done"]\n`));
      expect(cfg.review.on_states).toEqual(DEFAULTS.review.on_states);
    });

    it("filters on_states down to the states an agent can actually reach", () => {
      const cfg = loadConfig(withConfig(`[review]\non_states = ["blocked", "bogus", "idle"]\n`));
      expect(cfg.review.on_states).toEqual(["blocked", "idle"]);
    });

    it("falls back to the default when no on_states value is a real state", () => {
      const cfg = loadConfig(withConfig(`[review]\non_states = ["bogus", "finished"]\n`));
      expect(cfg.review.on_states).toEqual(DEFAULTS.review.on_states);
    });

    it("rejects non-string on_states elements the same way", () => {
      expect(loadConfig(withConfig(`[review]\non_states = [1, true]\n`)).review.on_states).toEqual(
        DEFAULTS.review.on_states,
      );
    });

    it("honours an explicitly empty on_states", () => {
      expect(loadConfig(withConfig(`[review]\non_states = []\n`)).review.on_states).toEqual([]);
    });

    it("honours an explicitly empty extra_args", () => {
      expect(loadConfig(withConfig(`[hunk]\nextra_args = []\n`)).hunk.extra_args).toEqual([]);
    });
  });
});
