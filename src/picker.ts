import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { HerdrPane } from "./herdr.js";
import { listBaseRefs, realRunner, repoRoot, resolveBaseRef, type Runner } from "./git.js";
import { reportFailure } from "./herdr.js";
import { openReviewTarget, type ReviewAssociation, type Runtime } from "./runtime.js";
import type { Target } from "./target.js";

export interface AgentChoice extends ReviewAssociation {
  paneId: string;
  label: string;
}

export interface RepositoryChoice {
  worktree: string;
  agents: AgentChoice[];
}

export interface PickerIo {
  write: (text: string) => void;
  ask: (prompt: string) => Promise<string>;
}

export type RepoRoot = (dir: string) => string | null;

/** Groups every Git checkout represented by a pane in the current Herdr workspace. */
export function discoverRepositories(
  panes: HerdrPane[],
  currentWorktree: string,
  rootFor: RepoRoot,
): RepositoryChoice[] {
  const repositories = new Map<string, RepositoryChoice>();

  const ensure = (dir: string | undefined): RepositoryChoice | undefined => {
    if (!dir) return undefined;
    const worktree = rootFor(dir);
    if (!worktree) return undefined;
    let repository = repositories.get(worktree);
    if (!repository) {
      repository = { worktree, agents: [] };
      repositories.set(worktree, repository);
    }
    return repository;
  };

  const current = ensure(currentWorktree)?.worktree;
  for (const pane of panes) {
    const repository = ensure(pane.foreground_cwd ?? pane.cwd);
    if (!repository || !pane.pane_id || !pane.agent) continue;
    if (repository.agents.some((agent) => agent.paneId === pane.pane_id)) continue;
    repository.agents.push({
      paneId: pane.pane_id,
      agentPaneId: pane.pane_id,
      agentName: pane.display_agent ?? pane.agent,
      label: `${pane.display_agent ?? pane.agent} (${pane.pane_id})`,
    });
  }

  return [...repositories.values()].sort((a, b) => {
    if (a.worktree === current) return -1;
    if (b.worktree === current) return 1;
    return a.worktree.localeCompare(b.worktree);
  });
}

interface NumberedChoice<T> {
  label: string;
  value: T;
}

/** A dependency-free picker suitable for the plugin's temporary overlay pane. */
export async function chooseNumbered<T>(
  title: string,
  choices: NumberedChoice<T>[],
  io: PickerIo,
): Promise<T | undefined> {
  if (choices.length === 0) return undefined;
  if (choices.length === 1) return choices[0]!.value;

  io.write(`\n${title}\n`);
  choices.forEach((choice, index) => io.write(`  ${index + 1}. ${choice.label}\n`));
  for (;;) {
    const answer = (await io.ask(`\nSelect [1-${choices.length}, q to cancel]: `)).trim();
    if (answer.toLowerCase() === "q") return undefined;
    const selected = Number.parseInt(answer, 10);
    if (Number.isInteger(selected) && selected >= 1 && selected <= choices.length) {
      return choices[selected - 1]!.value;
    }
    io.write("Enter one of the listed numbers, or q to cancel.\n");
  }
}

export function targetChoices(repo: string, run: Runner): Array<NumberedChoice<Target>> {
  const preferred = resolveBaseRef(repo, run);
  const bases = listBaseRefs(repo, run);
  const ordered =
    preferred && bases.includes(preferred)
      ? [preferred, ...bases.filter((candidate) => candidate !== preferred)]
      : bases;

  return [
    ...ordered.map((base) => ({
      label: `branch diff against ${base}`,
      value: { worktree: repo, mode: "branch" as const, ref: `${base}...HEAD` },
    })),
  ];
}

function terminalIo(): { io: PickerIo; close: () => void } {
  const readline = createInterface({ input: stdin, output: stdout });
  return {
    io: { write: (text) => stdout.write(text), ask: (prompt) => readline.question(prompt) },
    close: () => readline.close(),
  };
}

export interface PickerDeps {
  rootFor: RepoRoot;
  runnerFor: (repo: string) => Runner;
  io: PickerIo;
  openReview?: typeof openReviewTarget;
}

/** Selects a repository, review target and (when ambiguous) feedback agent. */
export async function runReviewPicker(rt: Runtime, deps: PickerDeps): Promise<number> {
  const repositories = discoverRepositories(
    rt.herdr.paneList(rt.ctx.workspaceId),
    rt.target.worktree,
    deps.rootFor,
  );
  if (repositories.length === 0) {
    return reportFailure(rt.herdr, "No Git repositories were found in this Herdr workspace.");
  }

  const repository = await chooseNumbered(
    "Repository to review",
    repositories.map((candidate) => ({
      label: `${basename(candidate.worktree)} — ${candidate.worktree}`,
      value: candidate,
    })),
    deps.io,
  );
  if (!repository) return 0;

  const targets = targetChoices(repository.worktree, deps.runnerFor(repository.worktree));
  if (targets.length === 0) {
    return reportFailure(
      rt.herdr,
      `No base branches were found in ${repository.worktree}; review the working tree instead.`,
    );
  }
  const target = await chooseNumbered(
    `Changes to review in ${basename(repository.worktree)}`,
    targets,
    deps.io,
  );
  if (!target) return 0;

  const agent = await chooseNumbered(
    "Agent to receive review comments",
    repository.agents.map((candidate) => ({ label: candidate.label, value: candidate })),
    deps.io,
  );

  return (deps.openReview ?? openReviewTarget)(
    "review:branch",
    target,
    target.ref,
    rt,
    agent ?? {},
  );
}

/** Production wiring kept separate so selection logic remains testable without a TTY or Git. */
export async function runTerminalReviewPicker(rt: Runtime): Promise<number> {
  const terminal = terminalIo();
  try {
    return await runReviewPicker(rt, {
      rootFor: (dir) => repoRoot(dir, realRunner(dir)),
      runnerFor: realRunner,
      io: terminal.io,
    });
  } finally {
    terminal.close();
  }
}
