// Build step 2: run a package.json script through the detected package manager, so the manifest
// never hardcodes one. Keeps package.json the single source of truth for what building means.
import { detect, run } from "./package-manager.mjs";

const script = process.argv[2];
if (!script) {
  console.error("hunkdiff: run-script.mjs needs a package.json script name");
  process.exit(1);
}

const manager = detect();
console.log(`hunkdiff: running \`${manager} run ${script}\``);
process.exit(run(manager, ["run", script]).status ?? 1);
