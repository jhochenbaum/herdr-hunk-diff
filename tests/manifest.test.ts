import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import {
  paneEntrypointFor,
  REVIEW_ACTIONS,
  WINDOWS_PANE_SUFFIX,
  type ReviewActionId,
} from "../src/actions.js";
import { HOOKED_EVENTS } from "../src/events.js";

const manifest = parse(readFileSync("herdr-plugin.toml", "utf8")) as any;

describe("herdr-plugin.toml", () => {
  it("declares the agreed plugin id and version floor", () => {
    expect(manifest.id).toBe("jhochenbaum.hunkdiff");
    expect(manifest.min_herdr_version).toBe("0.8.0");
  });

  it("targets macos, linux and windows", () => {
    expect(manifest.platforms.sort()).toEqual(["linux", "macos", "windows"]);
  });

  // Build steps inherit the top-level platforms, so a platform missing from a build step is a
  // platform that installs the plugin with no `dist/` for herdr to run.
  it("builds on every platform it claims", () => {
    for (const step of manifest.build) {
      expect(step.platforms ?? manifest.platforms).toEqual(manifest.platforms);
    }
  });

  it("uses no dots in action ids", () => {
    for (const action of manifest.actions) expect(action.id).not.toContain(".");
  });

  it("gives every action a palette-first title", () => {
    for (const action of manifest.actions) expect(action.title).toMatch(/^hunk: /);
  });

  it("uses only context values herdr 0.8.0 recognizes", () => {
    const validContexts = ["global", "workspace", "tab", "pane", "selection"];
    for (const action of manifest.actions) {
      for (const context of action.contexts) expect(validContexts).toContain(context);
    }
  });

  it("assigns each action its intended, exact context set", () => {
    const expected: Record<string, string[]> = {
      review: ["workspace", "pane"],
      "review:staged": ["workspace"],
      "review:branch": ["workspace", "pane"],
      "review:commit": ["workspace"],
      "review:stash": ["workspace"],
      "send-review": ["pane"],
      reload: ["workspace", "pane"],
      "close-review": ["pane", "workspace"],
      "setup-keys": ["workspace"],
      "remove-keys": ["workspace"],
      "next-comment": ["pane", "workspace"],
      "prev-comment": ["pane", "workspace"],
      "install-pager": ["workspace"],
      "uninstall-pager": ["workspace"],
    };
    expect(manifest.actions.map((a: any) => a.id).sort()).toEqual(Object.keys(expected).sort());
    for (const action of manifest.actions) {
      expect(action.contexts).toEqual(expected[action.id]);
    }
  });

  it("declares no action in a selection context, which cannot supply an operand", () => {
    for (const action of manifest.actions) {
      expect(action.contexts, `${action.id} claims a selection it can never receive`).not.toContain(
        "selection",
      );
    }
  });

  it("declares no action whose operand could only come from a selection", () => {
    const ids = manifest.actions.map((a: any) => a.id);
    for (const id of ["review:patch", "review:compare", "review:difftool", "review:paths"]) {
      expect(ids).not.toContain(id);
    }
  });

  it("declares no action that could only be driven by a payload on stdin", () => {
    const ids = manifest.actions.map((a: any) => a.id);
    expect(ids).not.toContain("annotate");
    expect(ids).not.toContain("navigate");
  });

  it("names every VCS the pager action covers, and which of them is automatic", () => {
    const install = manifest.actions.find((a: any) => a.id === "install-pager");
    expect(install.title).toMatch(/\bjj\b/);
    expect(install.title).toMatch(/\bsl\b/);
    expect(install.title).toMatch(/\bgit\b/);
    expect(install.title).not.toMatch(/the git pager/);
    expect(install.title).toMatch(/automatic|by hand|manual/i);
  });

  it("declares a build step that installs dependencies", () => {
    expect(manifest.build.some((b: any) => b.command.includes("ci"))).toBe(true);
  });

  it("declares the review pane as a split by default", () => {
    const pane = manifest.panes.find((p: any) => p.id === "review");
    expect(pane.placement).toBe("split");
  });

  it("references the plugin root absolutely in pane commands", () => {
    for (const pane of manifest.panes) {
      expect(pane.command.join(" ")).toContain("HERDR_PLUGIN_ROOT");
    }
  });

  describe("review pane entrypoints", () => {
    const supported = [...REVIEW_ACTIONS] as ReviewActionId[];

    // Every mode needs a POSIX pane and a Windows pane, so assert against both resolutions rather
    // than whichever platform happens to run the suite.
    const platforms: NodeJS.Platform[] = ["darwin", "linux", "win32"];
    const entrypoints = () =>
      platforms.flatMap((platform) => supported.map((id) => paneEntrypointFor(id, platform)));

    it("declares a pane for every supported review action, on every platform", () => {
      for (const platform of platforms) {
        for (const id of supported) {
          const entrypoint = paneEntrypointFor(id, platform);
          expect(
            manifest.panes.some((p: any) => p.id === entrypoint),
            `no [[panes]] entry with id "${entrypoint}" for action "${id}" on ${platform}`,
          ).toBe(true);
        }
      }
    });

    it("passes each action's own id as the pane command's trailing argument", () => {
      for (const platform of platforms) {
        for (const id of supported) {
          const pane = manifest.panes.find((p: any) => p.id === paneEntrypointFor(id, platform));
          expect(pane.command.at(-1).trim().endsWith(` ${id}`)).toBe(true);
        }
      }
    });

    it("declares exactly the panes the review actions open, and no others", () => {
      expect(manifest.panes.map((p: any) => p.id).sort()).toEqual(
        [...new Set(entrypoints())].sort(),
      );
    });

    // A pane herdr will not launch is worse than a missing one: the split flashes and dies before
    // pane.js can report anything, so the shell each entry needs must match the platform it claims.
    it("pairs each pane's declared platforms with a shell those platforms have", () => {
      for (const pane of manifest.panes) {
        const windows = pane.id.endsWith(WINDOWS_PANE_SUFFIX);
        expect(pane.platforms).toEqual(windows ? ["windows"] : ["macos", "linux"]);
        expect(pane.command[0]).toBe(windows ? "cmd" : "sh");
      }
    });

    it("expands the plugin root with the syntax each pane's own shell understands", () => {
      for (const pane of manifest.panes) {
        const command = pane.command.join(" ");
        expect(command).toContain(
          pane.id.endsWith(WINDOWS_PANE_SUFFIX) ? "%HERDR_PLUGIN_ROOT%" : "$HERDR_PLUGIN_ROOT",
        );
      }
    });
  });

  describe("event hooks", () => {
    const commands = () => (manifest.events ?? []).map((e: any) => e.command.join(" "));

    it("declares exactly one hook per event type src/events.ts handles", () => {
      expect((manifest.events ?? []).map((e: any) => e.on)).toEqual([...HOOKED_EVENTS]);
    });

    it("points every hook at the event entrypoint", () => {
      expect(commands()).not.toEqual([]);
      for (const command of commands()) expect(command).toContain("dist/bin/event.js");
    });

    it("runs every hook as direct argv, without a shell", () => {
      for (const event of manifest.events) {
        expect(event.command[0]).toBe("node");
        expect(event.command).toContain("dist/bin/event.js");
        for (const word of event.command) {
          expect(word).not.toMatch(/^(sh|bash|zsh|cmd|cmd\.exe|powershell)$/);
          expect(word).not.toContain("${");
        }
      }
    });

    it("filters no hook by pane id, since none of these types requires one", () => {
      for (const event of manifest.events) expect(event.pane_id).toBeUndefined();
    });

    it("declares no startup process", () => {
      expect(manifest.startup).toBeUndefined();
    });

    it("declares no probe or other throwaway hook", () => {
      for (const command of commands()) expect(command).not.toMatch(/PROBE|echo/i);
    });
  });

  it("gives every action id with no dots and every title the hunk: prefix, actions and link handlers alike", () => {
    for (const action of manifest.actions) {
      expect(action.id).not.toContain(".");
      expect(action.title).toMatch(/^hunk: /);
    }
    for (const handler of manifest.link_handlers) {
      expect(handler.id).not.toContain(".");
      expect(handler.title).toMatch(/^hunk: /);
    }
  });

  describe("link_handlers", () => {
    const handler = manifest.link_handlers.find((h: any) => h.id === "github-commit");
    const pattern = new RegExp(handler.pattern);

    it("points the github-commit handler at the review:commit action", () => {
      expect(handler.action).toBe("review:commit");
      expect(manifest.actions.some((a: any) => a.id === handler.action)).toBe(true);
    });

    it("does not match a GitHub pull request url, which it cannot honour", () => {
      expect(pattern.test("https://github.com/o/r/pull/42")).toBe(false);
    });

    it("matches a GitHub commit url", () => {
      expect(pattern.test("https://github.com/o/r/commit/abc1234")).toBe(true);
      expect(pattern.test("https://github.com/o/r/commit/" + "a".repeat(40))).toBe(true);
    });

    it("does not match a commit url whose sha is too short to be one", () => {
      expect(pattern.test("https://github.com/o/r/commit/abc")).toBe(false);
    });

    it("does not match a non-hex commit path segment", () => {
      expect(pattern.test("https://github.com/o/r/commit/zzzzzzz")).toBe(false);
    });

    it("does not match a GitHub issue url", () => {
      expect(pattern.test("https://github.com/o/r/issues/9")).toBe(false);
    });

    it("does not match an arbitrary GitHub path (repo root, wiki, releases)", () => {
      expect(pattern.test("https://github.com/o/r")).toBe(false);
      expect(pattern.test("https://github.com/o/r/wiki")).toBe(false);
      expect(pattern.test("https://github.com/o/r/releases/tag/v1")).toBe(false);
    });

    it("does not match a non-GitHub url", () => {
      expect(pattern.test("https://example.com/pull/42")).toBe(false);
    });
  });
});
