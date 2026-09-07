// Picks the package manager the plugin builds with. npm is preferred because package-lock.json is
// the tree CI verifies; other managers re-resolve ranges, so they are a fallback, not a default.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Frozen installs first: they reproduce a lockfile instead of re-resolving ranges. */
export const MANAGERS = {
  npm: { install: existsSync(join(ROOT, "package-lock.json")) ? ["ci"] : ["install"] },
  pnpm: { install: ["install"] },
};

export const OVERRIDE = "HUNKDIFF_PACKAGE_MANAGER";

/** Windows resolves `npm`/`pnpm` through .cmd shims, which need a shell to execute. */
export const SHELL = process.platform === "win32";

export function run(manager, args) {
  return spawnSync(manager, args, { cwd: ROOT, stdio: "inherit", shell: SHELL });
}

// `--version` rather than a PATH lookup, so a shim that cannot actually run is not chosen.
function usable(bin) {
  return spawnSync(bin, ["--version"], { stdio: "ignore", shell: SHELL }).status === 0;
}

const supported = () => Object.keys(MANAGERS).join(", ");
const eitherOf = () => Object.keys(MANAGERS).join(" or ");

/** Resolves the manager to use, or exits with a message naming what the machine would accept. */
export function detect() {
  const requested = process.env[OVERRIDE]?.trim();
  if (requested) {
    if (!(requested in MANAGERS)) {
      console.error(
        `hunkdiff: ${OVERRIDE}="${requested}" is not supported; use one of ${supported()}.`,
      );
      process.exit(1);
    }
    if (!usable(requested)) {
      console.error(
        `hunkdiff: ${OVERRIDE}="${requested}" was requested, but ${requested} did not run.`,
      );
      process.exit(1);
    }
    return requested;
  }

  const found = Object.keys(MANAGERS).find(usable);
  if (!found) {
    console.error(
      `hunkdiff: no supported package manager found. Install ${eitherOf()}, or set ${OVERRIDE}.`,
    );
    process.exit(1);
  }
  return found;
}
