import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Placement, PluginConfig } from "./config.js";
import { asObject, asString, parseJsonObject, type JsonObject } from "./json.js";
import { PLUGIN_ID } from "./keys.js";

export type CliRunner = (args: string[]) => { status: number; stdout: string };

export interface HerdrAgent {
  agent?: string;
  pane_id?: string;
  cwd?: string;
  agent_status?: string;
}

/** Reports through both the user notification channel and Herdr's captured stderr. */
export function reportFailure(herdr: { notify: (message: string) => void }, message: string): 1 {
  console.error(`hunkdiff: ${message}`);
  herdr.notify(message);
  return 1;
}

/** Executable and arguments prepended to hunk's argv. */
export interface HunkLauncher {
  bin: string;
  prefix: string[];
}

/** Runs the bundled launcher with Node, bypassing platform-specific npm shims. */
export function resolveHunkLauncher(
  cfg: PluginConfig,
  pluginRoot: string,
  execPath: string = process.execPath,
): HunkLauncher {
  if (cfg.hunk.bin !== "auto") return { bin: cfg.hunk.bin, prefix: [] };
  return {
    bin: execPath,
    prefix: [join(pluginRoot, "node_modules", "hunkdiff", "bin", "hunk.cjs")],
  };
}

export class HerdrAdapter {
  constructor(
    private readonly bin: string,
    private readonly run: CliRunner = (args) => {
      const r = spawnSync(this.bin, args, { encoding: "utf8" });
      return { status: r.status ?? 1, stdout: r.stdout ?? "" };
    },
  ) {}

  private json(args: string[]): JsonObject | null {
    const r = this.run(args);
    if (r.status !== 0) return null;
    return parseJsonObject(r.stdout);
  }

  notify(message: string): void {
    this.run(["notification", "show", message]);
  }

  /** Sends text to the pane running an agent; agent kinds are not addressable here. */
  promptAgent(target: string, text: string): boolean {
    return this.run(["agent", "prompt", target, text]).status === 0;
  }

  // `pane_id` is nested under `result.plugin_pane.pane` in the CLI response.
  openPane(opts: {
    entrypoint: string;
    cwd: string;
    placement: Placement;
    targetPane?: string;
  }): string | null {
    const args = [
      "plugin",
      "pane",
      "open",
      "--plugin",
      PLUGIN_ID,
      "--entrypoint",
      opts.entrypoint,
      "--cwd",
      opts.cwd,
      "--placement",
      opts.placement,
    ];
    if (opts.targetPane) args.push("--target-pane", opts.targetPane);
    const response = this.json(args);
    const result = asObject(response?.result);
    const pluginPane = asObject(result?.plugin_pane);
    const pane = asObject(pluginPane?.pane);
    return asString(pane?.pane_id) ?? null;
  }

  /** Closes a pane by positional id and reports whether Herdr accepted the request. */
  closePane(paneId: string): boolean {
    return this.run(["plugin", "pane", "close", paneId]).status === 0;
  }

  /** Lists live agents using the CLI's `agent_status` and `pane_id` field names. */
  agentList(): HerdrAgent[] {
    const response = this.json(["agent", "list"]);
    const agents = asObject(response?.result)?.agents;
    if (!Array.isArray(agents)) return [];

    return agents.flatMap((value): HerdrAgent[] => {
      const agent = asObject(value);
      if (!agent) return [];
      return [
        {
          agent: asString(agent.agent),
          pane_id: asString(agent.pane_id),
          cwd: asString(agent.cwd),
          agent_status: asString(agent.agent_status),
        },
      ];
    });
  }

  /** Reports pane metadata; the CLI requires the pane id before options and a source id. */
  reportMetadata(paneId: string, fields: { title?: string; display_agent?: string }): void {
    const args = ["pane", "report-metadata", paneId, "--source", `plugin:${PLUGIN_ID}`];
    if (fields.title) args.push("--title", fields.title);
    if (fields.display_agent) args.push("--display-agent", fields.display_agent);
    this.run(args);
  }
}
