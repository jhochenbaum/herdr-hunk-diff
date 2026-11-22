// Helpers for .github/workflows/release.yml. See "Releasing" in README.md.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Returns the release version after checking that every manifest agrees on it. */
export function readReleaseVersion(root = ".") {
  const read = (file) => readFileSync(`${root}/${file}`, "utf8");
  const packageJson = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const manifest = parseToml(read("herdr-plugin.toml"));

  const versions = {
    "package.json": packageJson.version,
    "package-lock.json": lock.version,
    'package-lock.json packages[""]': lock.packages?.[""]?.version,
    "herdr-plugin.toml": manifest.version,
  };
  const version = packageJson.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`package.json version ${JSON.stringify(version)} is not a semantic version`);
  }
  const mismatched = Object.entries(versions).filter(([, value]) => value !== version);
  if (mismatched.length > 0) {
    const list = mismatched.map(([file, value]) => `${file} has ${value}`).join(", ");
    throw new Error(`Version mismatch: package.json has ${version}, but ${list}`);
  }
  return { version, hunkVersion: packageJson.dependencies?.hunkdiff };
}

/** Extracts the "## Release notes" section from a release pull request body. */
export function extractReleaseNotes(body) {
  const lines = String(body ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const start = lines.findIndex((line) => /^##\s+Release notes\s*$/i.test(line.trim()));
  if (start === -1) {
    throw new Error('The release pull request body has no "## Release notes" section');
  }
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line) || /^---\s*$/.test(line)) break;
    section.push(line);
  }
  let notes = section.join("\n").trim();
  const fenced = notes.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fenced) notes = fenced[1].trim();
  if (notes === "") {
    throw new Error('The "## Release notes" section is empty');
  }
  return notes;
}

/** Builds the published release notes and checks them against the repository's pattern. */
export function buildReleaseNotes({ body, version, previousTag, hunkVersion, repository }) {
  let notes = extractReleaseNotes(body);
  if (!/^- \*\*[^*]+\*\* /m.test(notes)) {
    throw new Error('Release notes need at least one "- **Topic:** sentence. (#PR)" bullet');
  }
  const bundled = notes.match(/Bundles Hunk (\S+?)\.?(?:\s|$)/);
  if (!bundled) {
    throw new Error(
      'Release notes need the requirements line ("Requires Herdr ... Bundles Hunk X.Y.Z. ...")',
    );
  }
  if (hunkVersion && bundled[1] !== hunkVersion) {
    throw new Error(
      `Release notes say Hunk ${bundled[1]}, but package.json pins hunkdiff ${hunkVersion}`,
    );
  }
  if (!/\[Full changelog\]\(/i.test(notes) && previousTag) {
    const compare = `https://github.com/${repository}/compare/${previousTag}...v${version}`;
    notes += `\n\n[Full changelog](${compare})`;
  }
  return `${notes}\n`;
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function main(args) {
  const [command, ...rest] = args;
  if (command === "version") {
    process.stdout.write(`${readReleaseVersion().version}\n`);
    return;
  }
  if (command === "notes") {
    const { version, hunkVersion } = readReleaseVersion();
    const bodyFile = option(rest, "body-file");
    if (!bodyFile) throw new Error("notes requires --body-file");
    const notes = buildReleaseNotes({
      body: readFileSync(bodyFile, "utf8"),
      version,
      hunkVersion,
      previousTag: option(rest, "previous-tag"),
      repository: option(rest, "repository") ?? "jhochenbaum/herdr-hunk-diff",
    });
    process.stdout.write(notes);
    return;
  }
  throw new Error(
    "Usage: node scripts/release.mjs version | notes --body-file FILE [--previous-tag TAG]",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
