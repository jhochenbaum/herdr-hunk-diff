import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  paneEntrypointFor,
  REVIEW_ACTIONS,
  reviewRequestFor,
  type ReviewActionId,
} from "../src/actions.js";
import { DEFAULTS, type PluginConfig, type TargetMode } from "../src/config.js";
import { handleEvent, parseEvent } from "../src/events.js";
import { canReload } from "../src/hunk.js";
import { ReviewIndex, type ReviewEntry } from "../src/index-store.js";
import { dispatch } from "../src/runtime.js";
import { resolveTarget, type Target } from "../src/target.js";
import { worktreeKey } from "../src/worktree.js";

const WT = "/wt/x";
const SHA = "aaaaaaa";
const COMMIT_URL = `https://github.com/o/r/commit/${SHA}`;

const GIT = {
  resolveBaseRef: () => "main",
  hasCommitsAhead: () => true,
  repoRoot: (dir: string) => dir,
};
const resolve = (cfg: PluginConfig, mode?: TargetMode, ref?: string): Target =>
  resolveTarget({ worktree: WT }, cfg, GIT, mode, ref);

const CFG_STAGED: PluginConfig = {
  ...DEFAULTS,
  review: { ...DEFAULTS.review, default_target: "staged" },
};
const CONFIGS: Array<[string, PluginConfig]> = [
  ["default_target=auto", DEFAULTS],
  ["default_target=staged", CFG_STAGED],
];

function requestedMode(id: ReviewActionId): TargetMode | undefined {
  return reviewRequestFor(id).mode;
}

const ACTION_FOR_ENTRYPOINT: Record<string, ReviewActionId> = {};
for (const id of REVIEW_ACTIONS) {
  ACTION_FOR_ENTRYPOINT[paneEntrypointFor(id)] = id;
}

function onDisk(dir: string): Record<string, ReviewEntry> {
  try {
    return JSON.parse(readFileSync(join(dir, "review-index.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * The index file is keyed by `worktreeKey`, not by the path a caller holds, so a snapshot taken at
 * spawn time has to be read the same way the store writes it.
 */
function entryAt(index: Record<string, ReviewEntry>, worktree: string): ReviewEntry | undefined {
  return index[worktreeKey(worktree)];
}

interface Spawn {
  entrypoint: string;
  index: Record<string, ReviewEntry>;
}

function paneDisplays(cfg: PluginConfig, spawn: Spawn): Target {
  const actionId = ACTION_FOR_ENTRYPOINT[spawn.entrypoint];
  if (!actionId) throw new Error(`No review action maps to pane entrypoint "${spawn.entrypoint}"`);
  const target = resolve(cfg, requestedMode(actionId));
  if (!reviewRequestFor(actionId).takesRef) return target;
  const record = entryAt(spawn.index, WT);
  if (!target.ref && record?.requestedRef) return { ...target, ref: record.requestedRef };
  return target;
}

function expectIndexDescribes(
  cfg: PluginConfig,
  record: ReviewEntry | undefined,
  displayed: Target,
  why: string,
): void {
  expect(
    record,
    `${why}: no index entry for a worktree whose pane is showing a review`,
  ).toBeDefined();
  const mode = record!.requestedMode ?? undefined;
  const ref = record!.requestedRef ?? undefined;
  expect(
    resolve(cfg, mode, ref),
    `${why}: reload would resolve a different review than the pane shows`,
  ).toEqual(displayed);
  const unaided = resolve(cfg, displayed.mode);
  if (unaided.ref === displayed.ref) {
    expect(ref, `${why}: a stale ref is recorded for a review that has none`).toBeUndefined();
  } else {
    expect(ref, `${why}: the operand this review needs was not recorded`).toBe(displayed.ref);
  }
}

interface ReviewCase {
  ctx?: Record<string, string>;
  ref?: string;
}

const CASES: Record<ReviewActionId, ReviewCase> = {
  review: {},
  "review:staged": {},
  "review:branch": {},
  "review:stash": {},
  "review:commit": { ctx: { clickedUrl: COMMIT_URL }, ref: SHA },
};

const REGISTERED = REVIEW_ACTIONS.filter((id) => CASES[id] !== undefined);
const caseFor = (id: ReviewActionId) => CASES[id];

function harness(
  cfg: PluginConfig,
  ctx: Record<string, string>,
  shared?: { dir: string; index: ReviewIndex },
) {
  const dir = shared?.dir ?? mkdtempSync(join(tmpdir(), "inv-"));
  const index = shared?.index ?? new ReviewIndex(dir);
  const spawns: Spawn[] = [];
  const reloads: Target[] = [];
  let panes = 0;
  const rt = {
    cfg,
    ctx,
    pluginRoot: "/plugin",
    stateDir: dir,
    index,
    herdr: {
      notify: vi.fn(),
      promptAgent: vi.fn(() => true),
      closePane: vi.fn(() => true),
      openPane: vi.fn((opts: { entrypoint: string; cwd: string }) => {
        spawns.push({ entrypoint: opts.entrypoint, index: onDisk(dir) });
        return `w1:p${++panes}`;
      }),
    },
    hunk: {
      listComments: vi.fn(async () => []),
      removeComment: vi.fn(async () => {}),
      reload: vi.fn(async (_repo: string, target: Target) => {
        reloads.push(target);
      }),
      navigate: vi.fn(async () => {}),
    },
    targetFor: (mode?: TargetMode, ref?: string) => resolve(cfg, mode, ref),
    commitExists: () => true,
    get target(): Target {
      return resolve(cfg);
    },
  };
  return { rt, cfg, dir, index, spawns, reloads };
}

async function paneShowingCommit(cfg: PluginConfig) {
  const seed = harness(cfg, { worktree: WT, clickedUrl: COMMIT_URL });
  expect(await dispatch("review:commit", seed.rt as any)).toBe(0);
  expect(seed.index.get(WT)?.paneId).toBeDefined();
  return { dir: seed.dir, index: seed.index };
}

describe("registry", () => {
  it("covers every review action id src/actions.ts knows about", () => {
    expect(Object.keys(CASES).sort()).toEqual([...REVIEW_ACTIONS].sort());
  });

  it("gives every action only an operand it can actually be given", () => {
    for (const id of REVIEW_ACTIONS) {
      const c = CASES[id];
      if (c.ref !== undefined) {
        expect(
          reviewRequestFor(id).takesRef,
          `${id} takes no ref, so its case must supply none`,
        ).toBe(true);
      }
      expect(
        c.ref === undefined || c.ctx?.clickedUrl !== undefined,
        `${id} supplies a ref through a channel that cannot reach an action`,
      ).toBe(true);
      expect(c.ctx ?? {}, `${id} case builds a context around a selection`).not.toHaveProperty(
        "selectedText",
      );
    }
  });

  it("has exactly one pane entrypoint per review action", () => {
    expect(Object.values(ACTION_FOR_ENTRYPOINT).sort()).toEqual([...REGISTERED].sort());
  });
});

describe.each(CONFIGS)("a freshly opened review pane (%s)", (_label, cfg) => {
  it.each(REGISTERED)("%s: pane and index agree on the review it shows", async (id) => {
    const c = caseFor(id);
    const h = harness(cfg, { worktree: WT, agentName: "reviewer", ...c.ctx });

    expect(await dispatch(id, h.rt as any)).toBe(0);
    expect(h.spawns, `${id} opened no pane`).toHaveLength(1);
    const displayed = paneDisplays(cfg, h.spawns[0]);

    expect(displayed, `${id}: the pane shows a different review than the action requested`).toEqual(
      resolve(cfg, requestedMode(id), c.ref),
    );
    expectIndexDescribes(
      cfg,
      entryAt(h.spawns[0].index, WT),
      displayed,
      `${id} as openPane spawned the pane`,
    );
    expectIndexDescribes(cfg, h.index.get(WT), displayed, `${id} after the action finished`);
  });
});

describe.each(CONFIGS)(
  "re-pointing a pane that is already showing a review (%s)",
  (_label, cfg) => {
    it.each(REGISTERED)("%s: the index follows the pane to its new review", async (id) => {
      const c = caseFor(id);
      const shared = await paneShowingCommit(cfg);
      const h = harness(cfg, { worktree: WT, agentName: "reviewer", ...c.ctx }, shared);

      expect(await dispatch(id, h.rt as any)).toBe(0);

      const target = resolve(cfg, requestedMode(id), c.ref);
      const shouldReuse = cfg.review.reuse_pane && canReload(target.mode);
      if (shouldReuse) {
        expect(h.reloads, `${id}: expected the existing pane to be reloaded in place`).toHaveLength(
          1,
        );
        expect(h.spawns, `${id}: expected no fresh pane to be opened`).toHaveLength(0);
      } else {
        expect(h.spawns, `${id}: expected a fresh pane to be opened`).toHaveLength(1);
        expect(h.reloads, `${id}: expected the existing pane not to be reloaded`).toHaveLength(0);
      }
      const displayed = shouldReuse ? h.reloads[0] : paneDisplays(cfg, h.spawns[0]);
      expect(displayed, `${id}: re-pointed the pane at a different review than requested`).toEqual(
        target,
      );
      for (const spawn of h.spawns) {
        expectIndexDescribes(
          cfg,
          entryAt(spawn.index, WT),
          paneDisplays(cfg, spawn),
          `${id} as openPane spawned the pane`,
        );
      }
      expectIndexDescribes(cfg, h.index.get(WT), displayed, `${id} after re-pointing the pane`);
    });
  },
);

describe("the reload action", () => {
  it.each(REGISTERED)(
    "%s: refreshes the review its pane is showing, and nothing else",
    async (id) => {
      const c = caseFor(id);
      const h = harness(DEFAULTS, { worktree: WT, agentName: "reviewer", ...c.ctx });
      expect(await dispatch(id, h.rt as any)).toBe(0);
      const displayed = paneDisplays(DEFAULTS, h.spawns[0]);

      const code = await dispatch("reload", h.rt as any);

      if (!canReload(displayed.mode)) {
        expect(code).toBe(1);
        expect(h.reloads).toEqual([]);
        expect(h.rt.herdr.notify).toHaveBeenCalledWith(expect.stringMatching(/cannot reload/i));
      } else {
        expect(code).toBe(0);
        expect(
          h.reloads[h.reloads.length - 1],
          `${id}: reload targeted a different review`,
        ).toEqual(displayed);
      }
      expectIndexDescribes(DEFAULTS, h.index.get(WT), displayed, `${id} after reload`);
    },
  );
});

describe("the event hook's auto-open", () => {
  function hook(cfg: PluginConfig, shared: { dir: string; index: ReviewIndex }) {
    const spawns: Spawn[] = [];
    const deps = {
      cfg: { ...cfg, review: { ...cfg.review, auto_open: true } },
      index: shared.index,
      herdr: {
        notify: vi.fn(),
        closePane: vi.fn(() => true),
        openPane: vi.fn((opts: { entrypoint: string; cwd: string }) => {
          spawns.push({ entrypoint: opts.entrypoint, index: onDisk(shared.dir) });
          return "w1:p9";
        }),
      },
      worktreeForPane: () => WT,
    };
    const payload = {
      event: "pane_agent_status_changed",
      data: {
        type: "pane_agent_status_changed",
        pane_id: "w1:p3",
        workspace_id: "w1",
        agent_status: "idle",
        agent: "reviewer",
      },
    };
    const fire = () => handleEvent(parseEvent(undefined, JSON.stringify(payload))!, deps as any);
    return { deps, spawns, fire };
  }

  it.each(CONFIGS)(
    "leaves the index describing the config-default review it opens (%s)",
    async (_label, cfg) => {
      const seed = harness(cfg, { worktree: WT, agentName: "reviewer" });
      expect(await dispatch("review:staged", seed.rt as any)).toBe(0);

      const d = hook(cfg, { dir: seed.dir, index: seed.index });
      await d.fire();

      expect(d.spawns).toHaveLength(1);
      expect(d.spawns[0].entrypoint).toBe(paneEntrypointFor("review"));
      const displayed = paneDisplays(cfg, d.spawns[0]);
      expect(displayed).toEqual(resolve(cfg));
      expectIndexDescribes(cfg, seed.index.get(WT), displayed, "event-hook auto-open, afterwards");
    },
  );

  it("corrects the stale mode only after openPane has spawned the pane", async () => {
    const seed = harness(DEFAULTS, { worktree: WT, agentName: "reviewer" });
    expect(await dispatch("review:staged", seed.rt as any)).toBe(0);

    const d = hook(DEFAULTS, { dir: seed.dir, index: seed.index });
    await d.fire();

    expect(entryAt(d.spawns[0].index, WT)?.requestedMode).toBe("staged");
    expect(seed.index.get(WT)?.requestedMode).toBeUndefined();
  });

  it("keeps a stale commit-ish for a pane that is not showing a commit", async () => {
    const shared = await paneShowingCommit(DEFAULTS);
    expect(shared.index.get(WT)?.requestedRef).toBe(SHA);

    const d = hook(DEFAULTS, shared);
    await d.fire();

    const record = shared.index.get(WT);
    expect(record?.requestedMode).toBeUndefined();
    expect(record?.requestedRef).toBe(SHA);
    expect(
      resolve(DEFAULTS, record?.requestedMode ?? undefined, record?.requestedRef ?? undefined),
    ).toEqual(paneDisplays(DEFAULTS, d.spawns[0]));
  });
});
