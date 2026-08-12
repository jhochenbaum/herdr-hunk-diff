import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.js";
import { HOOKED_EVENTS, handleEvent, parseEvent, worktreeForPaneVia } from "../src/events.js";
import { ReviewIndex } from "../src/index-store.js";
import { main } from "../src/bin/event.js";

const finishedEvent = {
  event: "pane_agent_status_changed",
  data: {
    type: "pane_agent_status_changed",
    pane_id: "w1Y:p1",
    workspace_id: "w1Y",
    agent_status: "idle",
    agent: "claude",
  },
};

const withStatus = (agent_status: string) => ({
  ...finishedEvent,
  data: { ...finishedEvent.data, agent_status },
});

const paneGoneEvent = (type: "pane_exited" | "pane_closed", pane_id: string) => ({
  event: type,
  data: { type, pane_id, workspace_id: "w1Y" },
});

const worktreeRemovedEvent = (path: string) => ({
  event: "worktree_removed",
  data: { type: "worktree_removed", worktree: { path } },
});

const freshPaneEachTime = {
  ...DEFAULTS,
  review: { ...DEFAULTS.review, auto_open: true, reuse_pane: false },
};

function deps(over: Record<string, any> = {}) {
  return {
    cfg: DEFAULTS,
    index: new ReviewIndex(mkdtempSync(join(tmpdir(), "evt-"))),
    herdr: {
      notify: vi.fn(),
      openPane: vi.fn(() => "w1:p7"),
      closePane: vi.fn(),
    },
    worktreeForPane: vi.fn(() => "/wt/x"),
    ...over,
  };
}

async function fire(payload: unknown, d: ReturnType<typeof deps>) {
  const event = parseEvent(undefined, JSON.stringify(payload));
  expect(event, "the delivered payload did not parse").not.toBeNull();
  await handleEvent(event!, d as any);
}

describe("parseEvent", () => {
  it("reads the type and data out of the delivered nesting", () => {
    expect(parseEvent("pane.agent_status_changed", JSON.stringify(finishedEvent))).toEqual({
      type: "pane_agent_status_changed",
      data: finishedEvent.data,
    });
  });

  it("normalises the manifest's dotted spelling to the payload's snake_case", () => {
    expect(parseEvent("pane.exited", JSON.stringify({ data: { pane_id: "w1:p1" } }))?.type).toBe(
      "pane_exited",
    );
  });

  it("rejects a payload with no data object", () => {
    expect(
      parseEvent(
        "pane.agent_status_changed",
        JSON.stringify({
          type: "pane_agent_status_changed",
          pane_id: "w1Y:p1",
          agent_status: "idle",
        }),
      ),
    ).toBeNull();
    expect(
      parseEvent("pane.exited", JSON.stringify({ event: "pane_exited", data: null })),
    ).toBeNull();
    expect(
      parseEvent("pane.exited", JSON.stringify({ event: "pane_exited", data: [] })),
    ).toBeNull();
  });

  it("rejects a payload that is absent, unparseable, or not an object", () => {
    expect(parseEvent("pane.exited", undefined)).toBeNull();
    expect(parseEvent("pane.exited", "")).toBeNull();
    expect(parseEvent("pane.exited", "{not json")).toBeNull();
    expect(parseEvent("pane.exited", "[]")).toBeNull();
    expect(parseEvent("pane.exited", "null")).toBeNull();
  });

  it("falls back to the hook's event name when the payload names no type", () => {
    expect(
      parseEvent("worktree.removed", JSON.stringify({ data: { worktree: { path: "/wt/x" } } }))
        ?.type,
    ).toBe("worktree_removed");
  });

  it("rejects a payload whose type cannot be determined at all", () => {
    expect(parseEvent(undefined, JSON.stringify({ data: { pane_id: "w1:p1" } }))).toBeNull();
  });
});

describe("handleEvent: an agent reaching a reviewable state", () => {
  it("records the agent without opening a pane or notifying, by default", async () => {
    const d = deps();
    await fire(finishedEvent, d);
    expect(d.index.get("/wt/x")?.agentPaneId).toBe("w1Y:p1");
    expect(d.herdr.openPane).not.toHaveBeenCalled();
    expect(d.herdr.notify).not.toHaveBeenCalled();
  });

  it("opens a review pane when auto_open is enabled", async () => {
    const d = deps({ cfg: { ...DEFAULTS, review: { ...DEFAULTS.review, auto_open: true } } });
    await fire(finishedEvent, d);
    expect(d.herdr.openPane).toHaveBeenCalledWith({
      entrypoint: "review",
      cwd: "/wt/x",
      placement: "split",
      targetPane: "w1Y:p1",
    });
  });

  it("clears a stale requested mode when auto-opening the config-default review pane", async () => {
    const d = deps({ cfg: { ...DEFAULTS, review: { ...DEFAULTS.review, auto_open: true } } });
    d.index.upsert({ worktree: "/wt/x", requestedMode: "staged", sent: [] });
    await fire(finishedEvent, d);
    expect(d.index.get("/wt/x")?.requestedMode).toBeUndefined();
    expect(d.index.get("/wt/x")?.paneId).toBe("w1:p7");
  });

  describe("auto_open = true honours reuse_pane", () => {
    const enabledCfg = { ...DEFAULTS, review: { ...DEFAULTS.review, auto_open: true } };

    function autoOpenDeps(over: Record<string, any> = {}) {
      return deps({ cfg: enabledCfg, reloadReview: vi.fn(async () => {}), ...over });
    }

    it("re-points the pane already showing this worktree instead of opening a second one", async () => {
      const d = autoOpenDeps();
      d.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
      await fire(finishedEvent, d);
      expect(d.reloadReview).toHaveBeenCalledWith("/wt/x");
      expect(d.herdr.openPane).not.toHaveBeenCalled();
      expect(d.index.get("/wt/x")?.paneId).toBe("w1:p7");
    });

    it("still opens a pane when no review is on screen for this worktree", async () => {
      const d = autoOpenDeps();
      await fire(finishedEvent, d);
      expect(d.herdr.openPane).toHaveBeenCalledWith({
        entrypoint: "review",
        cwd: "/wt/x",
        placement: "split",
        targetPane: "w1Y:p1",
      });
      expect(d.reloadReview).not.toHaveBeenCalled();
    });

    it("opens a second pane when reuse_pane is disabled", async () => {
      const d = autoOpenDeps({
        cfg: { ...enabledCfg, review: { ...enabledCfg.review, reuse_pane: false } },
      });
      d.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
      await fire(finishedEvent, d);
      expect(d.herdr.openPane).toHaveBeenCalledOnce();
      expect(d.reloadReview).not.toHaveBeenCalled();
    });

    it("falls back to a fresh pane when the re-point fails, dropping the dead pane id", async () => {
      const d = autoOpenDeps({
        reloadReview: vi.fn(async () => {
          throw new Error("session is gone");
        }),
      });
      d.index.upsert({ worktree: "/wt/x", paneId: "w1:pDEAD", sent: ["c1"] });
      await fire(finishedEvent, d);
      expect(d.herdr.openPane).toHaveBeenCalledWith({
        entrypoint: "review",
        cwd: "/wt/x",
        placement: "split",
        targetPane: "w1Y:p1",
      });
      expect(d.index.get("/wt/x")?.paneId).toBe("w1:p7");
      expect(d.index.sentIds("/wt/x")).toEqual(["c1"]);
    });

    it("clears a stale requested mode when it re-points a pane", async () => {
      const d = autoOpenDeps();
      d.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", requestedMode: "staged", sent: [] });
      await fire(finishedEvent, d);
      expect(d.index.get("/wt/x")?.requestedMode).toBeUndefined();
    });
  });

  it("does nothing when auto_open is disabled", async () => {
    const d = deps({ cfg: { ...DEFAULTS, review: { ...DEFAULTS.review, auto_open: false } } });
    await fire(finishedEvent, d);
    expect(d.herdr.notify).not.toHaveBeenCalled();
    expect(d.herdr.openPane).not.toHaveBeenCalled();
  });

  it("ignores a status not listed in on_states", async () => {
    const d = deps();
    await fire(withStatus("working"), d);
    expect(d.herdr.notify).not.toHaveBeenCalled();
    expect(d.index.get("/wt/x")).toBeUndefined();
  });

  it("reacts to blocked when configured to", async () => {
    const d = deps({
      cfg: {
        ...DEFAULTS,
        review: { ...DEFAULTS.review, auto_open: true, on_states: ["idle", "blocked"] },
      },
    });
    await fire(withStatus("blocked"), d);
    expect(d.herdr.openPane).toHaveBeenCalled();
  });

  it("reads the agent state from agent_status, the field herdr actually sends", async () => {
    const d = deps();
    await fire(
      {
        ...finishedEvent,
        data: { ...finishedEvent.data, agent_status: undefined, status: "idle" },
      },
      d,
    );
    expect(d.herdr.notify).not.toHaveBeenCalled();
  });

  it("ignores non-string status and pane fields instead of coercing them", async () => {
    const d = deps();
    await fire(
      {
        ...finishedEvent,
        data: { ...finishedEvent.data, agent_status: { value: "idle" }, pane_id: 12 },
      },
      d,
    );
    expect(d.herdr.notify).not.toHaveBeenCalled();
    expect(d.worktreeForPane).not.toHaveBeenCalled();
  });

  it("records the agent against the worktree", async () => {
    const d = deps();
    await fire(finishedEvent, d);
    expect(d.index.get("/wt/x")?.agentName).toBe("claude");
  });

  it("records the agent's pane id as the delivery target, not just its kind", async () => {
    const d = deps();
    await fire(finishedEvent, d);
    expect(d.index.get("/wt/x")?.agentPaneId).toBe("w1Y:p1");
  });

  it("reports a pane it cannot resolve to a worktree, rather than returning silently", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ worktreeForPane: vi.fn(() => null) });

    const event = parseEvent(undefined, JSON.stringify(finishedEvent))!;
    expect(await handleEvent(event, d as any)).toBe(1);

    expect(d.index.all()).toEqual([]);
    expect(d.herdr.notify).toHaveBeenCalledWith(expect.stringMatching(/w1Y:p1/));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("w1Y:p1"));
    vi.restoreAllMocks();
  });

  it("reports an auto-open whose pane never appeared, instead of exiting 0", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({
      cfg: { ...DEFAULTS, review: { ...DEFAULTS.review, auto_open: true } },
      herdr: { notify: vi.fn(), openPane: vi.fn(() => null), closePane: vi.fn() },
    });

    const event = parseEvent(undefined, JSON.stringify(finishedEvent))!;
    expect(await handleEvent(event, d as any)).toBe(1);

    expect(d.herdr.notify).toHaveBeenCalledWith(expect.stringMatching(/pane could not be opened/i));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("/wt/x"));
    expect(d.index.get("/wt/x")?.agentPaneId).toBe("w1Y:p1");
    vi.restoreAllMocks();
  });

  it("answers 0 for a handled event that did what it meant to", async () => {
    const d = deps();
    const event = parseEvent(undefined, JSON.stringify(finishedEvent))!;
    expect(await handleEvent(event, d as any)).toBe(0);
  });

  it("acts twice for idle -> working -> idle, the shape of the round-trip loop", async () => {
    const d = deps({ cfg: freshPaneEachTime });
    await fire(finishedEvent, d);
    await fire(withStatus("working"), d);
    await fire(finishedEvent, d);
    expect(d.herdr.openPane).toHaveBeenCalledTimes(2);
  });

  it("acts on every delivered transition, including a repeated status", async () => {
    const d = deps({ cfg: freshPaneEachTime });
    await fire(finishedEvent, d);
    await fire(finishedEvent, d);
    expect(d.herdr.openPane).toHaveBeenCalledTimes(2);
  });
});

describe("handleEvent: a review pane going away", () => {
  it.each(["pane_exited", "pane_closed"] as const)(
    "%s keeps the review entry, clearing only the pane id",
    async (type) => {
      const d = deps();
      d.index.upsert({ worktree: "/wt/x", agentName: "claude", paneId: "w1:p7", sent: [] });
      d.index.markSent("/wt/x", ["c1", "c2"]);

      await fire(paneGoneEvent(type, "w1:p7"), d);

      expect(d.index.get("/wt/x")?.paneId).toBeUndefined();
      expect(d.index.get("/wt/x")?.agentName).toBe("claude");
      expect(d.index.sentIds("/wt/x").sort()).toEqual(["c1", "c2"]);
    },
  );

  it.each(["pane_exited", "pane_closed"] as const)(
    "%s leaves other worktrees' panes alone",
    async (type) => {
      const d = deps();
      d.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
      d.index.upsert({ worktree: "/wt/y", paneId: "w1:p8", sent: [] });
      await fire(paneGoneEvent(type, "w1:p7"), d);
      expect(d.index.get("/wt/y")?.paneId).toBe("w1:p8");
    },
  );
});

describe("handleEvent: a worktree being removed", () => {
  it("closes the review pane and drops the index entry", async () => {
    const d = deps();
    d.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    d.index.markSent("/wt/x", ["c1"]);
    await fire(worktreeRemovedEvent("/wt/x"), d);
    expect(d.herdr.closePane).toHaveBeenCalledWith("w1:p7");
    expect(d.index.get("/wt/x")).toBeUndefined();
  });

  it("drops the entry even when no pane was open for it", async () => {
    const d = deps();
    d.index.upsert({ worktree: "/wt/x", sent: [] });
    await fire(worktreeRemovedEvent("/wt/x"), d);
    expect(d.herdr.closePane).not.toHaveBeenCalled();
    expect(d.index.get("/wt/x")).toBeUndefined();
  });

  it("leaves every other worktree's review alone", async () => {
    const d = deps();
    d.index.upsert({ worktree: "/wt/x", paneId: "w1:p7", sent: [] });
    d.index.upsert({ worktree: "/wt/y", paneId: "w1:p8", sent: [] });
    await fire(worktreeRemovedEvent("/wt/x"), d);
    expect(d.herdr.closePane).toHaveBeenCalledTimes(1);
    expect(d.index.get("/wt/y")?.paneId).toBe("w1:p8");
  });
});

describe("handleEvent: an event type nothing is hooked for", () => {
  it("is a no-op rather than a mis-handled status change", async () => {
    const d = deps();
    await fire({ event: "pane_created", data: { type: "pane_created", pane_id: "w1:p1" } }, d);
    expect(d.herdr.notify).not.toHaveBeenCalled();
    expect(d.herdr.openPane).not.toHaveBeenCalled();
    expect(d.index.all()).toEqual([]);
  });
});

describe("worktreeForPaneVia", () => {
  const root = (dir: string) => dir;

  it("resolves a pane id to the cwd herdr reports for it", () => {
    const agentList = vi.fn(() => [
      { name: "other", pane_id: "w1Y:p9", cwd: "/wt/other" },
      { name: "claude", pane_id: "w1Y:p1", cwd: "/wt/x" },
    ]);
    expect(worktreeForPaneVia({ agentList }, root)("w1Y:p1")).toBe("/wt/x");
    expect(agentList).toHaveBeenCalledTimes(1);
  });

  it("returns null for a pane herdr reports no agent for", () => {
    expect(worktreeForPaneVia({ agentList: () => [] }, root)("w1Y:p1")).toBeNull();
  });

  it("ignores entries missing a pane id or a cwd", () => {
    const agentList = () => [{ pane_id: "w1Y:p1" }, { cwd: "/wt/x" }] as any[];
    expect(worktreeForPaneVia({ agentList }, root)("w1Y:p1")).toBeNull();
  });

  it("canonicalises the reported cwd to the repository root", () => {
    const agentList = () => [{ pane_id: "w1Y:p1", cwd: "/wt/x/src/deep" }];
    const repoRoot = vi.fn((dir: string) => (dir.startsWith("/wt/x") ? "/wt/x" : null));
    expect(worktreeForPaneVia({ agentList }, repoRoot)("w1Y:p1")).toBe("/wt/x");
    expect(repoRoot).toHaveBeenCalledWith("/wt/x/src/deep");
  });

  it("resolves two subdirectories of one repository to the same key", () => {
    const repoRoot = () => "/wt/x";
    const first = worktreeForPaneVia(
      { agentList: () => [{ pane_id: "p1", cwd: "/wt/x/src" }] },
      repoRoot,
    )("p1");
    const second = worktreeForPaneVia(
      { agentList: () => [{ pane_id: "p2", cwd: "/wt/x/tests/fixtures" }] },
      repoRoot,
    )("p2");
    expect(first).toBe(second);
  });

  it("keeps the reported cwd when it is in no git repository", () => {
    const agentList = () => [{ pane_id: "w1Y:p1", cwd: "/jj/checkout" }];
    expect(worktreeForPaneVia({ agentList }, () => null)("w1Y:p1")).toBe("/jj/checkout");
  });

  it("resolves the root at most once per lookup", () => {
    const repoRoot = vi.fn(() => "/wt/x");
    const agentList = () => [
      { pane_id: "w1Y:p9", cwd: "/wt/other" },
      { pane_id: "w1Y:p1", cwd: "/wt/x/src" },
    ];
    worktreeForPaneVia({ agentList }, repoRoot)("w1Y:p1");
    expect(repoRoot).toHaveBeenCalledTimes(1);
  });
});

describe("the event entrypoint", () => {
  function harness(over: Record<string, any> = {}) {
    const d = deps(over);
    return { d, buildDeps: () => d as any };
  }

  it("drives a real delivered payload from the environment through to the review index", async () => {
    const h = harness();
    const code = await main(
      {
        HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify(finishedEvent),
      },
      { buildDeps: h.buildDeps },
    );
    expect(code).toBe(0);
    expect(h.d.index.get("/wt/x")?.agentName).toBe("claude");
  });

  it("opens the review pane through the shared entrypoint map when auto_open is enabled", async () => {
    const h = harness({
      cfg: { ...DEFAULTS, review: { ...DEFAULTS.review, auto_open: true } },
    });
    await main(
      {
        HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify(finishedEvent),
      },
      { buildDeps: h.buildDeps },
    );
    expect(h.d.herdr.openPane).toHaveBeenCalledWith({
      entrypoint: "review",
      cwd: "/wt/x",
      placement: "split",
      targetPane: "w1Y:p1",
    });
  });

  it("propagates the handler's own failure as the process exit code", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness({ worktreeForPane: vi.fn(() => null) });
    const code = await main(
      {
        HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify(finishedEvent),
      },
      { buildDeps: h.buildDeps },
    );
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("exits non-zero and touches nothing when the payload cannot be read", async () => {
    const h = harness();
    const code = await main(
      { HERDR_PLUGIN_EVENT: "pane.agent_status_changed", HERDR_PLUGIN_EVENT_JSON: "{not json" },
      { buildDeps: h.buildDeps },
    );
    expect(code).toBe(1);
    expect(h.d.herdr.notify).not.toHaveBeenCalled();
    expect(h.d.herdr.openPane).not.toHaveBeenCalled();
  });

  it("exits non-zero on a payload with no data object, without inventing an event from it", async () => {
    const h = harness();
    const code = await main(
      {
        HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ agent_status: "idle", pane_id: "w1Y:p1" }),
      },
      { buildDeps: h.buildDeps },
    );
    expect(code).toBe(1);
    expect(h.d.herdr.notify).not.toHaveBeenCalled();
    expect(h.d.index.all()).toEqual([]);
  });

  it("does not build its dependencies for an unreadable payload", async () => {
    const buildDeps = vi.fn(() => deps() as any);
    expect(await main({ HERDR_PLUGIN_EVENT_JSON: "{not json" }, { buildDeps })).toBe(1);
    expect(buildDeps).not.toHaveBeenCalled();
  });
});

describe("HOOKED_EVENTS", () => {
  it("names each hooked type in the dotted form the manifest's `on` filter uses", () => {
    expect([...HOOKED_EVENTS]).toEqual([
      "pane.agent_status_changed",
      "pane.exited",
      "pane.closed",
      "worktree.removed",
    ]);
    for (const type of HOOKED_EVENTS) expect(type).toContain(".");
  });
});
