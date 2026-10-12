import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join, toNamespacedPath } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../src/config.js";
import { HerdrAdapter, resolveHunkLauncher, withoutNamespacePrefix } from "../src/herdr.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe("withoutNamespacePrefix", () => {
  it("strips the extended-length prefix from a drive path", () => {
    expect(withoutNamespacePrefix("\\\\?\\C:\\Users\\x\\plugin")).toBe("C:\\Users\\x\\plugin");
  });

  it("turns an extended-length UNC path back into a plain UNC path", () => {
    expect(withoutNamespacePrefix("\\\\?\\UNC\\server\\share\\plugin")).toBe(
      "\\\\server\\share\\plugin",
    );
  });

  it("leaves ordinary paths alone", () => {
    for (const path of ["/plugin", "C:\\plugin", "\\\\server\\share\\plugin", "\\\\.\\pipe\\x"]) {
      expect(withoutNamespacePrefix(path)).toBe(path);
    }
  });
});

describe("resolveHunkLauncher", () => {
  it("prefers the bundled hunkdiff when bin is auto", () => {
    expect(resolveHunkLauncher(DEFAULTS, "/plugin", "/bin/node")).toEqual({
      bin: "/bin/node",
      prefix: [join("/plugin", "node_modules", "hunkdiff", "bin", "hunk.cjs")],
    });
  });

  it("runs it under this process's own node by default", () => {
    expect(resolveHunkLauncher(DEFAULTS, "/plugin").bin).toBe(process.execPath);
  });

  it("never reaches for the node_modules/.bin shim", () => {
    const { bin, prefix } = resolveHunkLauncher(DEFAULTS, "/plugin");
    expect([bin, ...prefix].join(" ")).not.toContain(".bin");
  });

  it("never hands node an extended-length plugin root", () => {
    const { prefix } = resolveHunkLauncher(DEFAULTS, "\\\\?\\C:\\plugin", "node");
    expect(prefix[0]).toMatch(/^C:\\plugin/);
  });

  // Herdr can hand Windows plugins a \\?\ root; node must still start the bundled launcher.
  it.runIf(process.platform === "win32")(
    "starts the bundled hunk from an extended-length plugin root",
    () => {
      const { bin, prefix } = resolveHunkLauncher(DEFAULTS, toNamespacedPath(REPO_ROOT));
      const r = spawnSync(bin, [...prefix, "--version"], { encoding: "utf8" });
      expect(r.stderr).not.toContain("EISDIR");
      expect(r.status).toBe(0);
    },
  );

  it("honours an explicit binary path, spawning it with no launcher in front", () => {
    const cfg = { ...DEFAULTS, hunk: { ...DEFAULTS.hunk, bin: "/usr/local/bin/hunk" } };
    expect(resolveHunkLauncher(cfg, "/plugin")).toEqual({ bin: "/usr/local/bin/hunk", prefix: [] });
  });
});

describe("HerdrAdapter", () => {
  it("builds an agent prompt invocation targeting a pane id", () => {
    const calls: string[][] = [];
    const herdr = new HerdrAdapter("herdr", (args) => {
      calls.push(args);
      return { status: 0, stdout: "{}" };
    });
    herdr.promptAgent("w1:p1", "please fix");
    expect(calls[0]).toEqual(["agent", "prompt", "w1:p1", "please fix"]);
  });

  it("builds a notification invocation", () => {
    const calls: string[][] = [];
    const herdr = new HerdrAdapter("herdr", (args) => {
      calls.push(args);
      return { status: 0, stdout: "{}" };
    });
    herdr.notify("3 files to review");
    expect(calls[0][0]).toBe("notification");
    expect(calls[0]).toContain("3 files to review");
  });

  it("opens a plugin pane with an explicit cwd", () => {
    const calls: string[][] = [];
    const herdr = new HerdrAdapter("herdr", (args) => {
      calls.push(args);
      return {
        status: 0,
        stdout:
          '{"result":{"type":"plugin_pane_opened","plugin_pane":{"plugin_id":"jhochenbaum.hunkdiff","entrypoint":"review","pane":{"pane_id":"w1:p7"}}}}',
      };
    });
    const id = herdr.openPane({ entrypoint: "review", cwd: "/wt/x", placement: "split" });
    expect(calls[0]).toContain("--cwd");
    expect(calls[0]).toContain("/wt/x");
    expect(id).toBe("w1:p7");
  });

  it("passes the requested placement through to plugin pane open", () => {
    const calls: string[][] = [];
    const herdr = new HerdrAdapter("herdr", (args) => {
      calls.push(args);
      return { status: 0, stdout: "{}" };
    });
    herdr.openPane({ entrypoint: "review", cwd: "/wt/x", placement: "tab" });
    const idx = calls[0].indexOf("--placement");
    expect(idx).toBeGreaterThan(-1);
    expect(calls[0][idx + 1]).toBe("tab");
  });

  it("targets a pane when the caller identifies the event source", () => {
    const calls: string[][] = [];
    const herdr = new HerdrAdapter("herdr", (args) => {
      calls.push(args);
      return { status: 0, stdout: "{}" };
    });
    herdr.openPane({
      entrypoint: "review",
      cwd: "/wt/x",
      placement: "split",
      targetPane: "w1:p3",
    });
    expect(calls[0]).toContain("--target-pane");
    expect(calls[0][calls[0].indexOf("--target-pane") + 1]).toBe("w1:p3");
  });

  it("returns null when plugin.pane.open's response has an unexpected shape", () => {
    const herdr = new HerdrAdapter("herdr", () => ({
      status: 0,
      stdout: '{"result":{"pane":{"pane_id":"w1:p7"}}}',
    }));
    expect(herdr.openPane({ entrypoint: "review", cwd: "/wt/x" })).toBeNull();
  });

  it("returns null when plugin.pane.open's pane id is not a string", () => {
    const herdr = new HerdrAdapter("herdr", () => ({
      status: 0,
      stdout: '{"result":{"plugin_pane":{"pane":{"pane_id":42}}}}',
    }));
    expect(herdr.openPane({ entrypoint: "review", cwd: "/wt/x", placement: "split" })).toBeNull();
  });

  it("parses agent-list records and drops malformed values", () => {
    const herdr = new HerdrAdapter("herdr", () => ({
      status: 0,
      stdout: JSON.stringify({
        result: {
          agents: [
            { agent: "claude", pane_id: "w1:p1", cwd: "/wt/x", agent_status: "working" },
            null,
            "invalid",
            { agent: 42, pane_id: "w1:p2", cwd: false },
          ],
        },
      }),
    }));

    expect(herdr.agentList()).toEqual([
      { agent: "claude", pane_id: "w1:p1", cwd: "/wt/x", agent_status: "working" },
      { agent: undefined, pane_id: "w1:p2", cwd: undefined, agent_status: undefined },
    ]);
  });

  it("returns no agents when agent-list JSON has an unexpected shape", () => {
    const malformed = new HerdrAdapter("herdr", () => ({ status: 0, stdout: "[]" }));
    const wrongField = new HerdrAdapter("herdr", () => ({
      status: 0,
      stdout: '{"result":{"agents":{}}}',
    }));
    expect(malformed.agentList()).toEqual([]);
    expect(wrongField.agentList()).toEqual([]);
  });

  it("reports pane metadata with the pane id FIRST and a plugin-scoped source", () => {
    const calls: string[][] = [];
    const herdr = new HerdrAdapter("herdr", (args) => {
      calls.push(args);
      return { status: 0, stdout: "" };
    });
    herdr.reportMetadata("w1:p7", { title: "Review: x", display_agent: "hunk (2 unsent)" });
    expect(calls[0]).toEqual([
      "pane",
      "report-metadata",
      "w1:p7",
      "--source",
      "plugin:jhochenbaum.hunkdiff",
      "--title",
      "Review: x",
      "--display-agent",
      "hunk (2 unsent)",
    ]);
  });

  it("omits optional fields from report-metadata when unset", () => {
    const calls: string[][] = [];
    const herdr = new HerdrAdapter("herdr", (args) => {
      calls.push(args);
      return { status: 0, stdout: "" };
    });
    herdr.reportMetadata("w1:p7", {});
    expect(calls[0]).toEqual([
      "pane",
      "report-metadata",
      "w1:p7",
      "--source",
      "plugin:jhochenbaum.hunkdiff",
    ]);
  });

  it("closes a plugin pane by bare positional pane id, with no --plugin or --pane flags", () => {
    const calls: string[][] = [];
    const herdr = new HerdrAdapter("herdr", (args) => {
      calls.push(args);
      return { status: 0, stdout: "" };
    });
    herdr.closePane("w1:p7");
    expect(calls[0]).toEqual(["plugin", "pane", "close", "w1:p7"]);
  });

  it("answers whether herdr actually closed the pane", () => {
    const ok = new HerdrAdapter("herdr", () => ({ status: 0, stdout: "" }));
    expect(ok.closePane("w1:p7")).toBe(true);
    const refused = new HerdrAdapter("herdr", () => ({
      status: 1,
      stdout: '{"error":{"code":"plugin_pane_not_found"}}',
    }));
    expect(refused.closePane("w99:p99")).toBe(false);
  });
});
