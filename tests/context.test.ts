import { describe, expect, it } from "vitest";
import { readContext } from "../src/context.js";

const LIVE_CONTEXT = {
  correlation_id: "cli:plugin",
  focused_pane_agent: "claude",
  focused_pane_cwd: "/workspaces/herdr-hunk-diff",
  focused_pane_id: "w1Y:p1",
  focused_pane_status: "working",
  invocation_source: "cli",
  tab_id: "w1Y:t1",
  tab_label: "hunk-main",
  workspace_cwd: "/workspaces/herdr-hunk-diff",
  workspace_id: "w1Y",
  workspace_label: "herdr-hunk-diff",
} as const;

describe("readContext", () => {
  it("returns an empty context when nothing is set", () => {
    expect(readContext({})).toEqual({});
  });

  it("reads ids from discrete env vars", () => {
    const ctx = readContext({
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    });
    expect(ctx.workspaceId).toBe("w1");
    expect(ctx.tabId).toBe("w1:t1");
    expect(ctx.paneId).toBe("w1:p1");
  });

  it("reads every field it needs out of the real flat payload", () => {
    const ctx = readContext({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(LIVE_CONTEXT) });
    expect(ctx.workspaceId).toBe("w1Y");
    expect(ctx.tabId).toBe("w1Y:t1");
    expect(ctx.paneId).toBe("w1Y:p1");
    expect(ctx.agentName).toBe("claude");
    expect(ctx.cwd).toBe("/workspaces/herdr-hunk-diff");
  });

  it("resolves a cwd from the focused pane, which is what a review targets", () => {
    const ctx = readContext({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(LIVE_CONTEXT) });
    expect(ctx.cwd).toBeDefined();
  });

  it("falls back to the workspace cwd when no pane has one", () => {
    const ctx = readContext({
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/wt/feature-x" }),
    });
    expect(ctx.cwd).toBe("/wt/feature-x");
  });

  it("prefers the focused pane's cwd over the workspace's", () => {
    const ctx = readContext({
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_cwd: "/wt/feature-x",
        workspace_cwd: "/wt/main",
      }),
    });
    expect(ctx.cwd).toBe("/wt/feature-x");
  });

  it("leaves worktree unset when the payload carries no worktree object", () => {
    const ctx = readContext({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(LIVE_CONTEXT) });
    expect(ctx.worktree).toBeUndefined();
  });

  describe("worktree.checkout_path", () => {
    const withWorktree = (worktree: unknown, rest: Record<string, unknown> = {}) =>
      readContext({
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ ...LIVE_CONTEXT, ...rest, worktree }),
      });

    it("prefers the checkout root when the focused pane sits inside it", () => {
      const ctx = withWorktree(
        {
          repo_key: "gh:o/r",
          repo_name: "r",
          repo_root: "/wt/repo",
          checkout_path: "/wt/repo",
          is_linked_worktree: false,
        },
        { focused_pane_cwd: "/wt/repo/src/deep", workspace_cwd: "/wt/repo" },
      );
      expect(ctx.worktree).toBe("/wt/repo");
      expect(ctx.cwd).toBe("/wt/repo/src/deep");
    });

    it("accepts a checkout that is exactly the focused pane's directory", () => {
      const ctx = withWorktree(
        { checkout_path: "/wt/repo", repo_root: "/wt/repo" },
        { focused_pane_cwd: "/wt/repo" },
      );
      expect(ctx.worktree).toBe("/wt/repo");
    });

    it("ignores a checkout that does not contain the focused pane's directory", () => {
      const ctx = withWorktree(
        { checkout_path: "/wt/other-repo", repo_root: "/wt/other-repo" },
        { focused_pane_cwd: "/wt/repo/src" },
      );
      expect(ctx.worktree).toBeUndefined();
      expect(ctx.cwd).toBe("/wt/repo/src");
    });

    it("does not mistake a sibling directory with a shared prefix for a child", () => {
      const ctx = withWorktree(
        { checkout_path: "/wt/feature" },
        { focused_pane_cwd: "/wt/feature-x" },
      );
      expect(ctx.worktree).toBeUndefined();
      expect(ctx.cwd).toBe("/wt/feature-x");
    });

    it("tolerates a trailing separator on the checkout path", () => {
      const ctx = withWorktree(
        { checkout_path: "/wt/repo/" },
        { focused_pane_cwd: "/wt/repo/src" },
      );
      expect(ctx.worktree).toBe("/wt/repo/");
    });

    it("uses the checkout root when the payload resolves no cwd at all", () => {
      const ctx = readContext({
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ worktree: { checkout_path: "/wt/repo" } }),
      });
      expect(ctx.worktree).toBe("/wt/repo");
      expect(ctx.cwd).toBeUndefined();
    });

    it("treats an explicit null worktree as absent, as it does a null selection", () => {
      expect(withWorktree(null).worktree).toBeUndefined();
    });

    it("ignores a worktree object with no usable checkout_path", () => {
      expect(withWorktree({ repo_root: "/wt/repo" }).worktree).toBeUndefined();
      expect(withWorktree({ checkout_path: "" }).worktree).toBeUndefined();
      expect(withWorktree({ checkout_path: 42 }).worktree).toBeUndefined();
      expect(withWorktree("/wt/repo").worktree).toBeUndefined();
    });
  });

  it("prefers context JSON pane id over the discrete env var", () => {
    const ctx = readContext({
      HERDR_PANE_ID: "w1:p1",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w1:p9" }),
    });
    expect(ctx.paneId).toBe("w1:p9");
  });

  it("degrades to an empty context for a nested payload, which herdr never sends", () => {
    const ctx = readContext({
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        agent: { name: "reviewer" },
        worktree: { path: "/wt/feature-x" },
        pane: { id: "w1:p3", cwd: "/wt/feature-x" },
        workspace: { id: "w1" },
      }),
    });
    expect(ctx).toEqual({});
  });

  it("survives malformed context JSON rather than throwing", () => {
    expect(() => readContext({ HERDR_PLUGIN_CONTEXT_JSON: "{not json" })).not.toThrow();
    expect(readContext({ HERDR_PLUGIN_CONTEXT_JSON: "{not json" })).toEqual({});
  });

  it("degrades to an empty context for non-object JSON shapes", () => {
    expect(readContext({ HERDR_PLUGIN_CONTEXT_JSON: "null" })).toEqual({});
    expect(readContext({ HERDR_PLUGIN_CONTEXT_JSON: "[]" })).toEqual({});
    expect(readContext({ HERDR_PLUGIN_CONTEXT_JSON: '"a string"' })).toEqual({});
    expect(readContext({ HERDR_PLUGIN_CONTEXT_JSON: "123" })).toEqual({});
  });

  it("does not turn an empty-string env value into an empty-string context field", () => {
    const ctx = readContext({ HERDR_PANE_ID: "" });
    expect(ctx.paneId).toBeUndefined();
    expect(ctx).toEqual({});
  });

  it("pins the behavior when JSON supplies an explicit empty string for a field with a discrete fallback", () => {
    const ctx = readContext({
      HERDR_PANE_ID: "w1:p1",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "" }),
    });
    expect(ctx.paneId).toBeUndefined();
  });

  it("degrades HERDR_PLUGIN_EVENT_JSON arrays to an empty object", () => {
    const ctx = readContext({ HERDR_PLUGIN_EVENT_JSON: "[]" });
    expect(ctx.event).toEqual({});
  });

  it("reads the clicked url for link handlers", () => {
    const ctx = readContext({
      HERDR_PLUGIN_CLICKED_URL: "https://github.com/o/r/pull/12",
    });
    expect(ctx.clickedUrl).toBe("https://github.com/o/r/pull/12");
  });

  describe("selected_text, which is deliberately not read", () => {
    it("ignores a populated selection rather than exposing an operand nothing can supply", () => {
      const ctx = readContext({
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ ...LIVE_CONTEXT, selected_text: "0001.patch" }),
      });
      expect(ctx).not.toHaveProperty("selectedText");
      expect(Object.values(ctx)).not.toContain("0001.patch");
    });

    it("reads the rest of the payload normally when a selection is present", () => {
      const withSelection = readContext({
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ ...LIVE_CONTEXT, selected_text: "a.ts b.ts" }),
      });
      const without = readContext({
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(LIVE_CONTEXT),
      });
      expect(withSelection).toEqual(without);
    });

    it("still reads the clicked url, the only operand channel an action has", () => {
      const ctx = readContext({
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ ...LIVE_CONTEXT, selected_text: "ignored" }),
        HERDR_PLUGIN_CLICKED_URL: "https://github.com/o/r/commit/abc1234",
      });
      expect(ctx.clickedUrl).toBe("https://github.com/o/r/commit/abc1234");
    });
  });
});
