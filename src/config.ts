import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { asObject, type JsonObject } from "./json.js";

/** Event-hook states this plugin accepts. Manual QA confirmed turn completion arrives as `idle`. */
export type AgentState = "idle" | "working" | "blocked" | "unknown";

/**
 * Placements that return a pane id. Herdr also accepts `popup`, but a session-modal popup has no
 * pane id, which `reuse_pane`, `close-review` and metadata reporting all need.
 */
export type Placement = "overlay" | "split" | "tab" | "zoomed";

/** Concrete modes supported by the hunk adapter. */
export type ResolvedTargetMode = "working" | "staged" | "branch" | "commit" | "stash";

/** A concrete mode or automatic branch/working-tree selection. */
export type TargetMode = "auto" | ResolvedTargetMode;

/** Modes suitable as a standing default. */
export type DefaultTargetMode = "auto" | "working" | "staged" | "branch";

export interface PluginConfig {
  review: {
    auto_open: boolean;
    on_states: AgentState[];
    reuse_pane: boolean;
    default_target: DefaultTargetMode;
    watch: boolean;
    /** Passed to `hunk diff` as `--exclude-untracked`. */
    exclude_untracked: boolean;
    placement: Placement;
  };
  roundtrip: {
    clear_after_send: boolean;
    prompt_template: string;
  };
  hunk: {
    bin: string;
    /** Enables hunk's experimental features, including STML rendering. */
    experimental: boolean;
    extra_args: string[];
  };
}

export const DEFAULT_PROMPT_TEMPLATE = `Human-authored inline review comments on your changes in {worktree}:

{comments}

Address each comment and verify the resulting changes. If a comment is unclear or requires a decision, ask a focused clarification question and continue with any unaffected comments. Then summarize what you changed and explain anything you did not implement.`;

export const DEFAULTS: PluginConfig = {
  review: {
    auto_open: false,
    on_states: ["idle"],
    reuse_pane: true,
    default_target: "auto",
    watch: false,
    exclude_untracked: false,
    placement: "split",
  },
  roundtrip: {
    clear_after_send: true,
    prompt_template: DEFAULT_PROMPT_TEMPLATE,
  },
  hunk: { bin: "auto", experimental: false, extra_args: [] },
};

const TARGET: DefaultTargetMode[] = ["auto", "working", "staged", "branch"];
const PLACEMENTS: Placement[] = ["overlay", "split", "tab", "zoomed"];
const AGENT_STATES: AgentState[] = ["idle", "working", "blocked", "unknown"];

function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && (allowed as string[]).includes(value)
    ? (value as T)
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Filters a set, preserving an explicit empty list but rejecting an entirely invalid one. */
function subset<T extends string>(value: unknown, allowed: T[], fallback: T[]): T[] {
  if (!Array.isArray(value)) return fallback;
  if (value.length === 0) return [];
  const kept = value.filter(
    (v): v is T => typeof v === "string" && (allowed as string[]).includes(v),
  );
  return kept.length > 0 ? kept : fallback;
}

/** Rejects the entire argv if any element is invalid; partial argv can change command semantics. */
function strings(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.every((v) => typeof v === "string") ? (value as string[]) : fallback;
}

export function loadConfig(configDir: string): PluginConfig {
  let raw: JsonObject = {};
  try {
    raw = asObject(parse(readFileSync(join(configDir, "config.toml"), "utf8"))) ?? {};
  } catch {
    return structuredClone(DEFAULTS);
  }

  const r = asObject(raw.review) ?? {};
  const t = asObject(raw.roundtrip) ?? {};
  const h = asObject(raw.hunk) ?? {};

  return {
    review: {
      auto_open: bool(r.auto_open, DEFAULTS.review.auto_open),
      on_states: subset(r.on_states, AGENT_STATES, DEFAULTS.review.on_states),
      reuse_pane: bool(r.reuse_pane, DEFAULTS.review.reuse_pane),
      default_target: pick(r.default_target, TARGET, DEFAULTS.review.default_target),
      watch: bool(r.watch, DEFAULTS.review.watch),
      exclude_untracked: bool(r.exclude_untracked, DEFAULTS.review.exclude_untracked),
      placement: pick(r.placement, PLACEMENTS, DEFAULTS.review.placement),
    },
    roundtrip: {
      clear_after_send: bool(t.clear_after_send, DEFAULTS.roundtrip.clear_after_send),
      prompt_template:
        typeof t.prompt_template === "string" ? t.prompt_template : DEFAULT_PROMPT_TEMPLATE,
    },
    hunk: {
      bin: typeof h.bin === "string" ? h.bin : DEFAULTS.hunk.bin,
      experimental: bool(h.experimental, DEFAULTS.hunk.experimental),
      extra_args: strings(h.extra_args, DEFAULTS.hunk.extra_args),
    },
  };
}
