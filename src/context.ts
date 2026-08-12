import { isAbsolute, relative, resolve } from "node:path";
import { asObject, parseJsonObject, type JsonObject } from "./json.js";

export interface HerdrContext {
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  /** Agent kind reported for the focused pane; addressing still uses `paneId`. */
  agentName?: string;
  /** Checkout root from `worktree.checkout_path`, including linked worktrees. */
  worktree?: string;
  cwd?: string;
  /** URL routed through a manifest link handler. */
  clickedUrl?: string;
  actionId?: string;
  event?: unknown;
}

/*
 * Actions cannot reliably consume selected text: terminal key dispatch clears the selection, and
 * action invocation provides neither arguments nor stdin. Review modes must work without an
 * operand; link-handler URLs are the only supported exception.
 */

type Env = Record<string, string | undefined>;

/** Uses path semantics so sibling prefixes such as `/wt/a` and `/wt/ab` do not collide. */
function contains(outer: string, inner: string): boolean {
  const rel = relative(resolve(outer), resolve(inner));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function json(value: string | undefined): JsonObject {
  return parseJsonObject(value) ?? {};
}

/** Reads the flat context payload, using discrete `HERDR_*` variables as fallbacks. */
export function readContext(env: Env): HerdrContext {
  const c = json(env.HERDR_PLUGIN_CONTEXT_JSON);
  const ctx: HerdrContext = {};

  const set = <K extends keyof HerdrContext>(key: K, value: unknown) => {
    if (typeof value === "string" && value.length > 0) ctx[key] = value as HerdrContext[K];
  };

  set("workspaceId", c.workspace_id ?? env.HERDR_WORKSPACE_ID);
  set("tabId", c.tab_id ?? env.HERDR_TAB_ID);
  set("paneId", c.focused_pane_id ?? env.HERDR_PANE_ID);
  set("agentName", c.focused_pane_agent);
  set("cwd", c.focused_pane_cwd ?? c.workspace_cwd);
  // Ignore a workspace checkout that does not contain the focused pane.
  const checkout = asObject(c.worktree)?.checkout_path;
  if (typeof checkout === "string" && (ctx.cwd === undefined || contains(checkout, ctx.cwd))) {
    set("worktree", checkout);
  }
  set("clickedUrl", env.HERDR_PLUGIN_CLICKED_URL);
  set("actionId", env.HERDR_PLUGIN_ACTION_ID);
  if (env.HERDR_PLUGIN_EVENT_JSON) ctx.event = json(env.HERDR_PLUGIN_EVENT_JSON);

  return ctx;
}
