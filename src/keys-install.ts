import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildKeysBlock,
  ConfigParseError,
  detectConflicts,
  stripKeysBlock,
  type Binding,
} from "./keys.js";

export interface Result {
  ok: boolean;
  message: string;
  backup?: string;
  /** Bindings written by `installKeys`. */
  installed?: Binding[];
  /** Bindings skipped because their keys were occupied. */
  skipped?: Binding[];
}

/**
 * Mirrors Herdr's config precedence. `HERDR_CONFIG_PATH` is a literal file path, including an empty
 * value; otherwise XDG config wins over `~/.config`.
 *
 * Windows resolves to `%APPDATA%` and deliberately ignores `XDG_CONFIG_HOME`, because herdr
 * documents only the APPDATA location there. Guessing wrong is silent: the keys land in a file
 * herdr never reads, `setup-keys` reports success, and no keybinding works.
 */
export function resolveHerdrConfigPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.HERDR_CONFIG_PATH;
  if (override !== undefined) return override;
  if (platform === "win32") {
    // An empty APPDATA would make this a relative path, resolved against whatever cwd we happen
    // to have; fall back to its standard location instead.
    const appData = env.APPDATA ? env.APPDATA : join(homedir(), "AppData", "Roaming");
    return join(appData, "herdr", "config.toml");
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined) return join(xdg, "herdr", "config.toml");
  return join(homedir(), ".config", "herdr", "config.toml");
}

function noConfigPath(): Result {
  return {
    ok: false,
    message:
      "HERDR_CONFIG_PATH is set to an empty value, so herdr loads no config file at all and there " +
      "is nowhere to install keybindings. Unset it, or point it at the config file you want, then " +
      "re-run.",
  };
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// Preserve the most recent pre-write snapshot, not a full history.
function backup(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const dest = `${path}.hunkdiff-backup`;
  copyFileSync(path, dest);
  return dest;
}

function ioFailure(path: string, err: unknown): Result {
  const reason = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    message: `Could not update ${path}: ${reason}. Fix the permissions/path and try again.`,
  };
}

function describe(bindings: Binding[]): string {
  return bindings.map((b) => `${b.key} (${b.action})`).join(", ");
}

/** Replaces the managed block, installing free keys and leaving conflicting user bindings intact. */
export function installKeys(configPath: string, bindings: Binding[]): Result {
  if (configPath === "") return noConfigPath();

  let original: string;
  try {
    original = read(configPath);
  } catch (err) {
    return ioFailure(configPath, err);
  }

  const withoutManaged = stripKeysBlock(original);

  let conflicts: Set<string>;
  try {
    conflicts = new Set(detectConflicts(withoutManaged, bindings));
  } catch (err) {
    if (!(err instanceof ConfigParseError)) throw err;
    return {
      ok: false,
      message:
        `Could not update ${configPath}: it is not valid TOML (${err.message}). herdr discards a ` +
        "config it cannot parse and falls back to its defaults, so keybindings added here would " +
        "not load — and an unparseable config also hides the keys you have already bound, which " +
        "this plugin never overwrites. Your config was not changed. Fix the file (`herdr config " +
        "check` reports the error) and re-run `setup-keys`.",
    };
  }
  const installable = bindings.filter((b) => !conflicts.has(b.key));
  const skipped = bindings.filter((b) => conflicts.has(b.key));

  if (installable.length === 0) {
    return {
      ok: false,
      message:
        `Installed 0 of ${bindings.length} keybinding(s): every key is already bound in your ` +
        `herdr config — ${describe(skipped)}. Your config was not changed. Free a key and re-run ` +
        "`setup-keys`, or add the bindings by hand.",
      installed: [],
      skipped,
    };
  }

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    const saved = backup(configPath);
    const body = withoutManaged.replace(/\n*$/, "\n");
    writeFileSync(configPath, `${body}\n${buildKeysBlock(installable)}`);
    const reload = "Run `herdr server reload-config`.";
    return {
      ok: true,
      message:
        skipped.length === 0
          ? `Installed ${installable.length} keybinding(s) in ${configPath}. ${reload}`
          : `Installed ${installable.length} of ${bindings.length} keybinding(s) in ${configPath}. Skipped ` +
            `${describe(skipped)} — already bound in your herdr config, and left untouched. ` +
            `Bind those actions to keys of your own if you want them. ${reload}`,
      backup: saved,
      installed: installable,
      skipped,
    };
  } catch (err) {
    return ioFailure(configPath, err);
  }
}

export function removeKeys(configPath: string): Result {
  if (configPath === "") return noConfigPath();

  let original: string;
  try {
    original = read(configPath);
  } catch (err) {
    return ioFailure(configPath, err);
  }

  const stripped = stripKeysBlock(original);
  if (stripped === original) return { ok: true, message: "No managed keybindings found." };

  try {
    const saved = backup(configPath);
    writeFileSync(configPath, stripped);
    return { ok: true, message: "Removed managed keybindings.", backup: saved };
  } catch (err) {
    return ioFailure(configPath, err);
  }
}
