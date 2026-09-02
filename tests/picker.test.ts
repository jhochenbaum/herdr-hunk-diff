import { describe, expect, it, vi } from "vitest";
import {
  chooseNumbered,
  discoverRepositories,
  runReviewPicker,
  targetChoices,
  type PickerIo,
} from "../src/picker.js";

function scriptedIo(...answers: string[]): PickerIo & { output: string } {
  const state = {
    output: "",
    write(text: string) {
      state.output += text;
    },
    async ask(prompt: string) {
      state.output += prompt;
      return answers.shift() ?? "q";
    },
  };
  return state;
}

describe("discoverRepositories", () => {
  const rootFor = (dir: string) => {
    if (dir.startsWith("/repo-a")) return "/repo-a";
    if (dir.startsWith("/repo-b")) return "/repo-b";
    return null;
  };

  it("groups Git roots from all panes and keeps the current repository first", () => {
    expect(
      discoverRepositories(
        [
          { pane_id: "w1:p1", cwd: "/repo-a", agent: "claude" },
          {
            pane_id: "w1:p2",
            cwd: "/repo-a",
            foreground_cwd: "/repo-b/services/api",
            agent: "codex",
            display_agent: "backend",
          },
          { pane_id: "w1:p3", cwd: "/repo-b/docs" },
          { pane_id: "w1:p4", cwd: "/tmp" },
        ],
        "/repo-b",
        rootFor,
      ),
    ).toEqual([
      {
        worktree: "/repo-b",
        agents: [
          {
            paneId: "w1:p2",
            agentPaneId: "w1:p2",
            agentName: "backend",
            label: "backend (w1:p2)",
          },
        ],
      },
      {
        worktree: "/repo-a",
        agents: [
          {
            paneId: "w1:p1",
            agentPaneId: "w1:p1",
            agentName: "claude",
            label: "claude (w1:p1)",
          },
        ],
      },
    ]);
  });
});

describe("chooseNumbered", () => {
  it("re-prompts after invalid input and returns the chosen value", async () => {
    const io = scriptedIo("nope", "2");
    expect(
      await chooseNumbered(
        "Pick",
        [
          { label: "first", value: "a" },
          { label: "second", value: "b" },
        ],
        io,
      ),
    ).toBe("b");
    expect(io.output).toContain("Enter one of the listed numbers");
  });

  it("returns undefined when the user cancels", async () => {
    expect(
      await chooseNumbered(
        "Pick",
        [
          { label: "first", value: "a" },
          { label: "second", value: "b" },
        ],
        scriptedIo("q"),
      ),
    ).toBeUndefined();
  });

  it("selects a sole choice without prompting", async () => {
    const io = { write: vi.fn(), ask: vi.fn() };
    expect(await chooseNumbered("Pick", [{ label: "only", value: 7 }], io)).toBe(7);
    expect(io.ask).not.toHaveBeenCalled();
  });
});

describe("targetChoices", () => {
  it("puts Git's resolved base first and excludes symbolic and current-branch refs", () => {
    const run = vi.fn((_cmd: string, args: string[]) => {
      if (args[0] === "for-each-ref") {
        return {
          status: 0,
          stdout:
            "feature\t\nmain\t\norigin/feature\t\norigin/main\t\norigin/release\t\norigin/HEAD\trefs/remotes/origin/main\n",
        };
      }
      if (args[0] === "symbolic-ref" && args.includes("HEAD")) {
        return { status: 0, stdout: "feature\n" };
      }
      if (args.includes("@{u}")) return { status: 0, stdout: "origin/main\n" };
      return { status: 1, stdout: "" };
    });

    expect(targetChoices("/repo", run)).toEqual([
      {
        label: "branch diff against origin/main",
        value: { worktree: "/repo", mode: "branch", ref: "origin/main...HEAD" },
      },
      {
        label: "branch diff against main",
        value: { worktree: "/repo", mode: "branch", ref: "main...HEAD" },
      },
      {
        label: "branch diff against origin/release",
        value: { worktree: "/repo", mode: "branch", ref: "origin/release...HEAD" },
      },
    ]);
  });
});

describe("runReviewPicker", () => {
  it("opens the selected repository/base and associates its agent for round-trip comments", async () => {
    const openReview = vi.fn(async () => 0);
    const rt = {
      ctx: { workspaceId: "w1" },
      target: { worktree: "/repo-a", mode: "working" },
      herdr: {
        paneList: vi.fn(() => [
          { pane_id: "w1:p1", cwd: "/repo-a", agent: "claude" },
          { pane_id: "w1:p2", cwd: "/repo-b", agent: "codex", display_agent: "backend" },
        ]),
        notify: vi.fn(),
      },
    } as any;
    const rootFor = (dir: string) =>
      dir.startsWith("/repo-") ? dir.split("/").slice(0, 2).join("/") : null;
    const runnerFor = () => (_cmd: string, args: string[]) => {
      if (args[0] === "for-each-ref") return { status: 0, stdout: "main\t\n" };
      if (args[0] === "symbolic-ref" && args.includes("HEAD")) {
        return { status: 0, stdout: "feature\n" };
      }
      if (args.includes("@{u}")) return { status: 1, stdout: "" };
      if (args[0] === "symbolic-ref") return { status: 1, stdout: "" };
      if (args[0] === "rev-parse" && args.at(-1) === "main") {
        return { status: 0, stdout: "abc\n" };
      }
      return { status: 1, stdout: "" };
    };

    expect(
      await runReviewPicker(rt, {
        rootFor,
        runnerFor,
        io: scriptedIo("2"),
        openReview,
      }),
    ).toBe(0);
    expect(rt.herdr.paneList).toHaveBeenCalledWith("w1");
    expect(openReview).toHaveBeenCalledWith(
      "review:branch",
      { worktree: "/repo-b", mode: "branch", ref: "main...HEAD" },
      "main...HEAD",
      rt,
      expect.objectContaining({ agentName: "backend", agentPaneId: "w1:p2" }),
    );
  });

  it("fails visibly when the workspace contains no Git repository", async () => {
    const rt = {
      ctx: { workspaceId: "w1" },
      target: { worktree: "/tmp", mode: "working" },
      herdr: { paneList: () => [{ cwd: "/tmp" }], notify: vi.fn() },
    } as any;
    expect(
      await runReviewPicker(rt, {
        rootFor: () => null,
        runnerFor: vi.fn(),
        io: scriptedIo(),
        openReview: vi.fn(),
      }),
    ).toBe(1);
    expect(rt.herdr.notify).toHaveBeenCalledWith(expect.stringMatching(/no git repositories/i));
  });
});
