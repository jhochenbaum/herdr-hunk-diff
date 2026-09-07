import { detect, MANAGERS, run } from "./package-manager.mjs";

const manager = detect();
const args = MANAGERS[manager].install;
console.log(`hunkdiff: installing dependencies with \`${manager} ${args.join(" ")}\``);
process.exit(run(manager, args).status ?? 1);
