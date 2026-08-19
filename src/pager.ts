import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { Runner } from "./git.js";

/** Pager setup with injected effects because Git configuration is global user state. */

export type Vcs = "git" | "jj" | "sl";

export const PAGER_VCS: readonly Vcs[] = ["git", "jj", "sl"];

/** Documented setup for VCSs that only support interactive config editing. */
export const MANUAL_PAGER_SETUP: Record<
  "jj" | "sl",
  { label: string; command: string; snippet: string }
> = {
  jj: {
    label: "Jujutsu",
    command: "jj config edit --user",
    snippet: '[ui]\npager = ["hunk", "pager"]\ndiff-formatter = ":git"',
  },
  sl: {
    label: "Sapling",
    command: "sl config -u",
    snippet: "[pager]\npager = hunk pager",
  },
};

/** Install and uninstall must agree on the default value owned by this plugin. */
export const GIT_PAGER_VALUE = "hunk pager";

export interface PagerResult {
  ok: boolean;
  message: string;
}

export interface PagerEffects {
  present: (vcs: Vcs) => boolean;
  git: Runner;
  /** Checks bare names on PATH and paths in place. */
  canRun: (nameOrPath: string) => boolean;
}

/**
 * Path semantics of the platform being asked about, rather than the one this process runs on:
 * separators, PATH delimiter and drive letters all differ, and every function here takes an
 * explicit platform so its behaviour can be asserted from either host.
 */
function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** A value naming a location on disk rather than a command to look up on PATH. */
export function looksLikePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return value.includes("/") || (platform === "win32" && value.includes("\\"));
}

/**
 * Names a bare command can have on disk. Windows has no executable bit: a command is executable
 * because of its extension, and `git` on PATH is `git.exe`, so searching for the bare name finds
 * nothing at all. PATHEXT lists the extensions the OS will try, with a documented default for the
 * rare environment that does not set it.
 */
export function executableNames(
  name: string,
  pathExt: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32" || pathFor(platform).extname(name) !== "") return [name];
  const extensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
  // PATHEXT is conventionally uppercase and Windows compares filenames case-insensitively, so the
  // case here is cosmetic — lowercase keeps the candidate paths readable where they get reported.
  return extensions.map((ext) => `${name}${ext}`);
}

/** Searches PATH, excluding empty entries that would implicitly search the current worktree. */
export function onPath(
  name: string,
  pathEnv: string | undefined,
  isExecutable: (path: string) => boolean,
  pathExt: string | undefined = process.env.PATHEXT,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!pathEnv) return false;
  const { delimiter, join: joinFor } = pathFor(platform);
  const candidates = executableNames(name, pathExt, platform);
  return pathEnv
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .some((dir) => candidates.some((candidate) => isExecutable(joinFor(dir, candidate))));
}

/**
 * Real effects require an executable file; `X_OK` alone also accepts directories. On Windows the
 * bit does not exist and `X_OK` degrades to a readability check, so the extension carried by every
 * candidate name from `executableNames` is what makes a hit meaningful there.
 */
export function realPagerEffects(env: NodeJS.ProcessEnv, run: Runner): PagerEffects {
  const isExecutable = (path: string) => {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const search = (name: string) => onPath(name, env.PATH, isExecutable, env.PATHEXT);
  return {
    present: search,
    canRun: (nameOrPath) =>
      looksLikePath(nameOrPath) ? isExecutable(nameOrPath) : search(nameOrPath),
    git: run,
  };
}

/**
 * Auto mode uses PATH because bundled plugin paths can change on update. Explicit paths are assumed
 * to be user-owned and durable.
 */
export function gitPagerPlan(hunkBin: string): { bin: string; command: string } {
  if (hunkBin === "auto") return { bin: "hunk", command: GIT_PAGER_VALUE };
  return { bin: hunkBin, command: `${shellQuote(hunkBin)} pager` };
}

/** Quotes values because Git executes `core.pager` through a shell. */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Includes the auto value so config changes do not make an earlier install unremovable. */
function ownedPagerValues(hunkBin: string): string[] {
  return [...new Set([GIT_PAGER_VALUE, gitPagerPlan(hunkBin).command])];
}

function manualSections(effects: Pick<PagerEffects, "present">, verb: "add" | "remove"): string[] {
  const sections: string[] = [];
  for (const vcs of ["jj", "sl"] as const) {
    if (!effects.present(vcs)) continue;
    const { label, command, snippet } = MANUAL_PAGER_SETUP[vcs];
    sections.push(
      verb === "add"
        ? `${label} (${vcs}) cannot be configured automatically — its config is an interactive ` +
            `edit. Run \`${command}\` and add:\n\n${snippet}`
        : `${label} (${vcs}) was never configured by this plugin, so it cannot be undone here. ` +
            `Run \`${command}\` and remove:\n\n${snippet}`,
    );
  }
  return sections;
}

function noVcsFound(): PagerResult {
  return {
    ok: false,
    message:
      "No git, jj or sl binary found on your PATH, so there is no pager to configure. " +
      "Install one, or set hunk as your pager by hand.",
  };
}

/**
 * Installs only a runnable, durable pager command. Existing values are reported for recovery, and
 * multi-valued or unreadable config is left untouched.
 */
export function installPager(effects: PagerEffects, hunkBin = "auto"): PagerResult {
  const installed = PAGER_VCS.filter((vcs) => effects.present(vcs));
  if (installed.length === 0) return noVcsFound();

  const sections: string[] = [];
  let ok = true;

  if (effects.present("git")) {
    const plan = gitPagerPlan(hunkBin);
    if (isRelativePath(plan.bin)) {
      ok = false;
      sections.push(
        `\`[hunk].bin\` is a relative path (\`${plan.bin}\`), and git reads core.pager from every ` +
          "directory you run git in, so a relative path would resolve to a different place in each " +
          "one. git's core.pager was left alone. Set `bin` to an absolute path — or to `auto` with " +
          "hunk installed globally (`npm i -g hunkdiff`) — then re-run this action.",
      );
    } else if (!effects.canRun(plan.bin)) {
      ok = false;
      const manualToo = effects.present("jj") || effects.present("sl");
      sections.push(unrunnableHunk(hunkBin, plan.bin, manualToo));
    } else {
      const state = readGitPager(effects, ownedPagerValues(hunkBin));
      if (state.kind === "multiple") {
        ok = false;
        sections.push(
          `git's core.pager already has multiple values (${state.values
            .map((v) => `\`${v}\``)
            .join(
              ", ",
            )}), and a plain \`git config --global core.pager <value>\` cannot replace a ` +
            'multi-valued key — git itself refuses with "cannot overwrite multiple values with a ' +
            'single value" (verified against git 2.52.0) — so nothing was changed. Remove the extra ' +
            "`pager` lines from the `[core]` section of your ~/.gitconfig by hand, or run " +
            `\`git config --global --replace-all core.pager ${shellQuote(plan.command)}\` yourself.`,
        );
      } else if (state.kind === "unreadable") {
        ok = false;
        sections.push(
          `Could not read your git config (git exited ${state.status}), so nothing was written — ` +
            "installing without knowing the current value risks replacing a pager you use, with no " +
            "record of what it was.",
        );
      } else {
        const result = effects.git("git", ["config", "--global", "core.pager", plan.command]);
        if (result.status !== 0) {
          ok = false;
          sections.push("Could not update git config, so git still uses its own pager.");
        } else if (state.kind === "absent") {
          sections.push("hunk installed as your git pager.");
        } else if (state.kind === "ours") {
          sections.push("hunk is already configured as your git pager.");
        } else {
          sections.push(
            `git's core.pager was set to ${describeValue(state.value)}; hunk installed as your git ` +
              "pager, replacing it. To restore it, run: " +
              `\`git config --global core.pager ${shellQuote(state.value)}\`.`,
          );
        }
      }
    }
  }
  sections.push(...manualSections(effects, "add"));
  return { ok, message: sections.join("\n\n") };
}

/** Relative paths are unsafe in global config; bare command names are resolved through PATH. */
function isRelativePath(bin: string, platform: NodeJS.Platform = process.platform): boolean {
  return looksLikePath(bin, platform) && !pathFor(platform).isAbsolute(bin);
}

function unrunnableHunk(hunkBin: string, bin: string, manualToo: boolean): string {
  const consequence =
    "git's core.pager was left alone: a pager that cannot start makes `git diff` print an error " +
    "instead of your diff, and git still exits 0, so nothing would point back at this plugin.";
  const alsoManual = manualToo
    ? " The snippets below name a bare `hunk` for the same reason, so they need it too."
    : "";
  if (hunkBin === "auto") {
    return (
      "hunk is not on your PATH, so git could not run it as a pager. " +
      `${consequence} This plugin's own copy of hunk lives inside its plugin directory, whose path ` +
      "changes on every plugin update and is deleted when the plugin is removed, so pointing git " +
      "at it would break your git config later. Install hunk globally with `npm i -g hunkdiff` and " +
      `re-run this action.${alsoManual} (Reviews inside herdr do not need this — they use the ` +
      "bundled copy.)"
    );
  }
  return (
    `\`[hunk].bin\` is set to \`${bin}\`, which is not an executable this machine can run, so git ` +
    `could not use it as a pager. ${consequence} Point \`bin\` at a real hunk binary — or set it ` +
    `back to \`auto\` and install hunk globally with \`npm i -g hunkdiff\` — then re-run this ` +
    `action.${alsoManual}`
  );
}

/** Renders an empty value explicitly because it intentionally disables Git's pager. */
function describeValue(value: string): string {
  return value === "" ? "an empty value (which disables git's pager)" : `\`${value}\``;
}

type PagerState =
  | { kind: "absent" }
  | { kind: "ours" }
  | { kind: "theirs"; value: string }
  | { kind: "multiple"; values: string[] }
  | { kind: "unreadable"; status: number };

/** Uses `--get-all` so multiple values are detected rather than silently collapsed. */
function readGitPager(effects: Pick<PagerEffects, "git">, ours: string[]): PagerState {
  const result = effects.git("git", ["config", "--global", "--get-all", "core.pager"]);
  if (result.status === 1) return { kind: "absent" };
  if (result.status !== 0) return { kind: "unreadable", status: result.status };

  const values = result.stdout.replace(/\n$/, "").split("\n");
  if (values.length === 0 || (values.length === 1 && values[0] === "" && result.stdout === "")) {
    return { kind: "absent" };
  }
  if (values.length > 1) return { kind: "multiple", values };
  return ours.includes(values[0]!) ? { kind: "ours" } : { kind: "theirs", value: values[0]! };
}

/** Unsets only values this plugin could have installed, leaving all other Git pager state intact. */
export function uninstallPager(
  effects: Pick<PagerEffects, "present" | "git">,
  hunkBin = "auto",
): PagerResult {
  const installed = PAGER_VCS.filter((vcs) => effects.present(vcs));
  if (installed.length === 0) return noVcsFound();

  const sections: string[] = [];
  let ok = true;

  if (effects.present("git")) {
    const state = readGitPager(effects, ownedPagerValues(hunkBin));
    switch (state.kind) {
      case "absent":
        sections.push(
          "git's core.pager is not set, so hunk is not your git pager and there was nothing to " +
            "remove.",
        );
        break;
      case "ours": {
        const result = effects.git("git", ["config", "--global", "--unset", "core.pager"]);
        // Status 5 means the key vanished between the read and unset.
        if (result.status === 0 || result.status === 5) {
          sections.push("hunk removed as your git pager.");
        } else {
          ok = false;
          sections.push("Could not update git config, so git may still use hunk as its pager.");
        }
        break;
      }
      case "theirs":
        sections.push(
          `git's core.pager is set to ${describeValue(state.value)}, which this plugin did not write, so it ` +
            "was left exactly as it is — hunk is not your git pager. Clear it yourself with " +
            "`git config --global --unset core.pager` if that is what you wanted.",
        );
        break;
      case "multiple":
        ok = false;
        sections.push(
          `git's core.pager has multiple values (${state.values.map((v) => `\`${v}\``).join(", ")}) ` +
            "and git refuses to unset a multi-valued key, so nothing was changed. Delete the " +
            "`pager` line you want gone from the `[core]` section of your ~/.gitconfig by hand.",
        );
        break;
      case "unreadable":
        ok = false;
        sections.push(
          `Could not read your git config (git exited ${state.status}), so nothing was changed — ` +
            "removing core.pager without knowing what it holds could delete a pager this plugin " +
            "never set.",
        );
        break;
    }
  }
  sections.push(...manualSections(effects, "remove"));
  return { ok, message: sections.join("\n\n") };
}
