import { readFileSync, writeFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.dependencies?.hunkdiff;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("package.json must pin hunkdiff to an exact semantic version");
}

writeFileSync(".github/verified-hunk-version", `${version}\n`);
