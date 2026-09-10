import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

export interface SandboxInfo {
  name: string;
  /** Host-visible workspace path `sbx ls` reports for this sandbox, when it has one. */
  workspace?: string;
}

export interface SandboxLookup {
  /** True when `path` exists on the filesystem the plugin process itself runs on. */
  exists: (path: string) => boolean;
  /** Lists sandboxes known to `sbx`. Returns `[]` when `sbx` is unavailable or reports none. */
  listSandboxes: () => SandboxInfo[];
}

/** Uses path semantics so sibling prefixes such as `/wt/a` and `/wt/ab` do not collide. */
function containsPath(outer: string, inner: string): boolean {
  const rel = relative(resolve(outer), resolve(inner));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Picks the sandbox whose workspace contains `path`, preferring the most specific match. */
export function findSandboxForPath(path: string, sandboxes: SandboxInfo[]): string | undefined {
  const candidates = sandboxes.filter(
    (s): s is SandboxInfo & { workspace: string } =>
      typeof s.workspace === "string" && s.workspace.length > 0 && containsPath(s.workspace, path),
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, s) => (s.workspace.length > best.workspace.length ? s : best))
    .name;
}

/**
 * Accepts the documented `sbx ls --json` shape (a `SANDBOX`/`WORKSPACE` table serialized as
 * objects) plus a couple of reasonable variants, and degrades to no sandboxes rather than throw.
 */
export function parseSandboxList(value: unknown): SandboxInfo[] {
  const list = Array.isArray(value)
    ? value
    : value !== null &&
        typeof value === "object" &&
        Array.isArray((value as { sandboxes?: unknown }).sandboxes)
      ? (value as { sandboxes: unknown[] }).sandboxes
      : [];

  return list.flatMap((item): SandboxInfo[] => {
    if (typeof item !== "object" || item === null) return [];
    const fields = item as Record<string, unknown>;
    const name = fields.name ?? fields.sandbox;
    if (typeof name !== "string" || name === "") return [];
    const workspace = fields.workspace;
    return [{ name, workspace: typeof workspace === "string" ? workspace : undefined }];
  });
}

export const realSandboxLookup: SandboxLookup = {
  exists: existsSync,
  listSandboxes: () => {
    const r = spawnSync("sbx", ["ls", "--json"], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) return [];
    return parseSandboxList(JSON.parse(r.stdout));
  },
};
