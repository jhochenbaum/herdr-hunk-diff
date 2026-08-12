#!/usr/bin/env node
import { buildRuntime, dispatch, type Runtime } from "../runtime.js";
import { isMainModule } from "./main-guard.js";

export interface ActionDeps {
  buildRuntime: (env: NodeJS.ProcessEnv) => Runtime;
  dispatch: (actionId: string, rt: Runtime) => Promise<number>;
}

const defaultDeps: ActionDeps = { buildRuntime, dispatch };

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: ActionDeps = defaultDeps,
): Promise<number> {
  const actionId = argv[2] ?? env.HERDR_PLUGIN_ACTION_ID ?? "";
  return deps.dispatch(actionId, deps.buildRuntime(env));
}

if (isMainModule(import.meta.url)) {
  process.exit(await main(process.argv, process.env));
}
