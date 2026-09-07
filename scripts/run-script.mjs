import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detect, ROOT, run } from "./package-manager.mjs";

const script = process.argv[2];
if (!script) {
  console.error("hunkdiff: run-script.mjs needs a package.json script name");
  process.exit(1);
}

const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
// Script names become shell arguments on Windows.
if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(script) || !Object.hasOwn(scripts ?? {}, script)) {
  console.error(`hunkdiff: unknown or invalid package.json script: ${script}`);
  process.exit(1);
}

const manager = detect();
console.log(`hunkdiff: running \`${manager} run ${script}\``);
process.exit(run(manager, ["run", script]).status ?? 1);
