import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import {
  ConfigParseError,
  DEFAULT_BINDINGS,
  buildKeysBlock,
  detectConflicts,
  stripKeysBlock,
  takenKeys,
} from "../src/keys.js";

const REAL_WORLD = `
onboarding = false

[[keys.command]]
key = "prefix+d"
type = "shell"
command = "herdr plugin pane open --plugin betterup.devpods --entrypoint picker"
description = "DevPods picker"

[[keys.command]]
key = "prefix+alt+c"
type = "shell"
command = "bash /Users/x/workspace/herdr-devpods/bin/dpod-new-tab"
description = "DevPods: new tab in pod"

[ui]
agent_panel_sort = "spaces"
`;

const HERDR_SHIPPED_KEYS = [
  "prefix+?",
  "prefix+s",
  "prefix+q",
  "prefix+shift+r",
  "prefix+o",
  "prefix+w",
  "prefix+g",
  "prefix+shift+n",
  "prefix+shift+g",
  "prefix+shift+w",
  "prefix+shift+d",
  "ctrl+v",
  "prefix+c",
  "prefix+shift+t",
  "prefix+p",
  "prefix+n",
  "prefix+shift+x",
  "prefix+shift+p",
  "prefix+e",
  "prefix+h",
  "prefix+j",
  "prefix+k",
  "prefix+l",
  "prefix+tab",
  "prefix+shift+tab",
  "prefix+v",
  "prefix+minus",
  "prefix+x",
  "prefix+z",
  "prefix+r",
  "prefix+b",
  "prefix+alt+g",
];

describe("takenKeys", () => {
  it("finds keys from [[keys.command]] entries", () => {
    expect(takenKeys(REAL_WORLD).has("prefix+d")).toBe(true);
  });

  it("finds keys from [keys] action bindings", () => {
    expect(takenKeys(`[keys]\nsettings = "prefix+s"\n`).has("prefix+s")).toBe(true);
  });

  it("ignores commented-out bindings", () => {
    expect(takenKeys(`[keys]\n# settings = "prefix+s"\n`).has("prefix+s")).toBe(false);
  });

  it("returns an empty set for an empty config", () => {
    expect(takenKeys("").size).toBe(0);
  });

  it("tracks a [keys] header with a trailing inline comment", () => {
    const taken = takenKeys(`[keys] # my bindings\nsettings = "prefix+s"\n`);
    expect(taken.has("prefix+s")).toBe(true);
  });

  it("tracks a [[keys.command]] header with a trailing inline comment", () => {
    const taken = takenKeys(`[[keys.command]] # my bindings\nkey = "prefix+d"\n`);
    expect(taken.has("prefix+d")).toBe(true);
  });

  it("ends [keys] scope at a commented [ui] header, so [ui] fields are not harvested", () => {
    const taken = takenKeys(
      `[keys] # my bindings\nsettings = "prefix+s"\n\n[ui] # display options\nagent_panel_sort = "prefix+z"\n`,
    );
    expect(taken.has("prefix+s")).toBe(true);
    expect(taken.has("prefix+z")).toBe(false);
  });

  it("does not treat the [keys] leader prefix definition as a bound action key", () => {
    const taken = takenKeys(`[keys]\nprefix = "ctrl+b"\nsettings = "prefix+s"\n`);
    expect(taken.has("ctrl+b")).toBe(false);
    expect(taken.has("prefix+s")).toBe(true);
  });

  describe("shapes TOML permits that a line-by-line scan misses", () => {
    it("finds a single-quoted key in a [[keys.command]] entry", () => {
      const taken = takenKeys(
        `[[keys.command]]\nkey = 'prefix+shift+h'\ntype = 'shell'\ncommand = 'echo mine'\n`,
      );
      expect(taken.has("prefix+shift+h")).toBe(true);
    });

    it("finds single-quoted action bindings under [keys]", () => {
      const taken = takenKeys(`[keys]\nsettings = 'prefix+s'\n`);
      expect(taken.has("prefix+s")).toBe(true);
    });

    it("does not treat a single-quoted prefix as a bound action key either", () => {
      const taken = takenKeys(`[keys]\nprefix = 'ctrl+b'\nsettings = 'prefix+s'\n`);
      expect(taken.has("ctrl+b")).toBe(false);
      expect(taken.has("prefix+s")).toBe(true);
    });

    it("finds a key written as an inline table entry", () => {
      const taken = takenKeys(
        `keys = { command = [{ key = "prefix+shift+h", type = "shell", command = "mine" }] }\n`,
      );
      expect(taken.has("prefix+shift+h")).toBe(true);
    });

    it("finds a key given as a multi-line basic string", () => {
      const taken = takenKeys(`[[keys.command]]\nkey = """prefix+shift+h"""\n`);
      expect(taken.has("prefix+shift+h")).toBe(true);
    });

    it("finds a key whose assignment carries a trailing comment", () => {
      const taken = takenKeys(`[[keys.command]]\nkey = "prefix+shift+h" # mine\n`);
      expect(taken.has("prefix+shift+h")).toBe(true);
    });

    it("does not harvest the nested [keys.indexed] table's fields as bindings", () => {
      const taken = takenKeys(`[keys]\nsettings = "prefix+s"\n\n[keys.indexed]\ntabs = "ctrl"\n`);
      expect(taken.has("prefix+s")).toBe(true);
      expect(taken.has("ctrl")).toBe(false);
    });

    it("ignores explicitly-unbound empty values", () => {
      expect(takenKeys(`[keys]\nopen_worktree = ""\n`).has("")).toBe(false);
    });
  });

  it("refuses to guess at a config it cannot parse, rather than reporting nothing taken", () => {
    expect(() => takenKeys(`[keys\nsettings = "prefix+s"\n`)).toThrow(ConfigParseError);
  });
});

describe("DEFAULT_BINDINGS", () => {
  it("binds the four motions common enough to earn a default key", () => {
    expect(DEFAULT_BINDINGS.map((b) => [b.key, b.action])).toEqual([
      ["prefix+shift+h", "jhochenbaum.hunkdiff.review"],
      ["prefix+shift+s", "jhochenbaum.hunkdiff.send-review"],
      ["prefix+shift+c", "jhochenbaum.hunkdiff.review:commit"],
      ["prefix+shift+a", "jhochenbaum.hunkdiff.review:staged"],
    ]);
  });

  it("binds none of the selection-driven ids the manifest cannot declare", () => {
    const bound = DEFAULT_BINDINGS.map((b) => b.action);
    for (const id of ["review:patch", "review:compare", "review:difftool", "review:paths"]) {
      expect(bound).not.toContain(`jhochenbaum.hunkdiff.${id}`);
    }
    expect(DEFAULT_BINDINGS.map((b) => b.key)).not.toContain("prefix+shift+f");
  });

  it("does not use prefix+d, which collides in the real world", () => {
    expect(DEFAULT_BINDINGS.map((b) => b.key)).not.toContain("prefix+d");
  });

  it("uses qualified action ids", () => {
    for (const b of DEFAULT_BINDINGS) {
      expect(b.action).toMatch(/^jhochenbaum\.hunkdiff\./);
    }
  });

  it("binds only action ids the manifest actually declares", () => {
    const manifest = parse(readFileSync("herdr-plugin.toml", "utf8")) as any;
    const declared = new Set(manifest.actions.map((a: any) => `jhochenbaum.hunkdiff.${a.id}`));
    for (const b of DEFAULT_BINDINGS) expect(declared).toContain(b.action);
  });

  it("claims no key herdr itself binds by default", () => {
    for (const b of DEFAULT_BINDINGS) expect(HERDR_SHIPPED_KEYS).not.toContain(b.key);
  });

  it("uses no key bound in a real user config", () => {
    expect(detectConflicts(REAL_WORLD, DEFAULT_BINDINGS)).toEqual([]);
  });

  it("proposes no key twice", () => {
    const keys = DEFAULT_BINDINGS.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("detectConflicts", () => {
  it("reports a collision against an existing binding", () => {
    const proposed = [{ key: "prefix+d", action: "x.y.z", description: "d" }];
    expect(detectConflicts(REAL_WORLD, proposed)).toEqual(["prefix+d"]);
  });

  it("reports nothing for the shipped defaults against a real config", () => {
    expect(detectConflicts(REAL_WORLD, DEFAULT_BINDINGS)).toEqual([]);
  });

  it("reports a collision against a single-quoted binding", () => {
    const config = `[[keys.command]]\nkey = 'prefix+shift+h'\ntype = 'shell'\ncommand = 'mine'\n`;
    expect(detectConflicts(config, DEFAULT_BINDINGS)).toEqual(["prefix+shift+h"]);
  });

  it("propagates a parse failure instead of answering that nothing collides", () => {
    expect(() => detectConflicts(`[keys\n`, DEFAULT_BINDINGS)).toThrow(ConfigParseError);
  });
});

describe("buildKeysBlock / stripKeysBlock", () => {
  it("emits plugin_action entries inside delimited markers", () => {
    const block = buildKeysBlock(DEFAULT_BINDINGS);
    expect(block).toContain('type = "plugin_action"');
    expect(block).toContain("BEGIN jhochenbaum.hunkdiff");
    expect(block).toContain("END jhochenbaum.hunkdiff");
  });

  it("round-trips: appending then stripping restores the original", () => {
    const withBlock = `${REAL_WORLD}\n${buildKeysBlock(DEFAULT_BINDINGS)}`;
    expect(stripKeysBlock(withBlock)).toBe(REAL_WORLD);
  });

  it("stripping a config without the block is a no-op", () => {
    expect(stripKeysBlock(REAL_WORLD)).toBe(REAL_WORLD);
  });

  it("is idempotent: stripping then appending twice yields one block", () => {
    const once = `${stripKeysBlock(REAL_WORLD)}\n${buildKeysBlock(DEFAULT_BINDINGS)}`;
    const twice = `${stripKeysBlock(once)}\n${buildKeysBlock(DEFAULT_BINDINGS)}`;
    expect(twice.match(/BEGIN jhochenbaum\.hunkdiff/g)).toHaveLength(1);
  });
});
