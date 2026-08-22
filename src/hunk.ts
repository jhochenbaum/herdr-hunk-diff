import { spawn } from "node:child_process";
import type { PluginConfig } from "./config.js";
import type { AgentNote } from "./notes.js";
import type { Target } from "./target.js";

export type UnavailableReason = "no-session" | "loopback-blocked" | "missing-binary";

export class HunkUnavailableError extends Error {
  constructor(
    readonly reason: UnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = "HunkUnavailableError";
  }
}

export class HunkProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HunkProtocolError";
  }
}

/**
 * Read schema from `session comment list`. It differs from the `AgentNote` write schema: ids, bodies,
 * and line positions use different field names and shapes.
 */
export interface HunkComment {
  /** Stable key used for delivery deduplication. */
  noteId: string;
  filePath: string;
  body: string;
  /** Inclusive `[start, end]` range in the new file. */
  newRange?: [number, number];
  oldRange?: [number, number];
  source?: string;
  author?: string;
  hunkIndex?: number;
  createdAt?: string;
  editable?: boolean;
}

/** Rejects malformed output before feedback can be delivered without a stable deduplication key. */
export function parseHunkComments(value: unknown): HunkComment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HunkProtocolError("hunk returned an invalid comment list; comments were not sent.");
  }

  return value.map((comment, index) => {
    const fields = comment as Record<string, unknown> | null;
    if (
      typeof comment !== "object" ||
      fields === null ||
      typeof fields.noteId !== "string" ||
      fields.noteId === "" ||
      typeof fields.filePath !== "string" ||
      typeof fields.body !== "string"
    ) {
      throw new HunkProtocolError(
        `hunk returned an invalid comment at position ${index + 1}; comments were not sent.`,
      );
    }
    return comment as HunkComment;
  });
}

export type CommentType = "live" | "all" | "ai" | "agent" | "user";

/** A navigation request with exactly one target, matching hunk's CLI constraint. */
export type NavigateRequest =
  | { nextComment: true }
  | { prevComment: true }
  | { file: string; hunk: number }
  | { file: string; oldLine: number }
  | { file: string; newLine: number };

// Return only the subcommand; buildLaunchArgs appends flags shared by every mode.
function subcommandFor(target: Target): string[] {
  switch (target.mode) {
    case "stash":
      return ["stash", "show", ...(target.ref ? [target.ref] : [])];
    case "commit":
      return ["show", ...(target.ref ? [target.ref] : [])];
    case "staged":
      return ["diff", "--staged"];
    case "branch":
      return ["diff", ...(target.ref ? [target.ref] : [])];
    default:
      return ["diff"];
  }
}

/** Modes backed by `hunk diff`, which is where `--exclude-untracked` is accepted. */
const EXCLUDE_UNTRACKED_MODES: ReadonlySet<Target["mode"]> = new Set([
  "working",
  "staged",
  "branch",
]);

export function buildLaunchArgs(target: Target, cfg: PluginConfig, notesPath?: string): string[] {
  const args = subcommandFor(target);
  if (cfg.review.exclude_untracked && EXCLUDE_UNTRACKED_MODES.has(target.mode)) {
    args.push("--exclude-untracked");
  }
  if (cfg.hunk.experimental) args.push("--experimental");
  if (cfg.review.watch) args.push("--watch");
  if (notesPath) args.push("--agent-context", notesPath);
  args.push(...cfg.hunk.extra_args);
  return args;
}

/** Stash has no supported nested command for `hunk session reload`. */
export function canReload(mode: Target["mode"]): boolean {
  return mode !== "stash";
}

export class HunkAdapter {
  constructor(
    private readonly bin: string,
    private readonly prefix: string[] = [],
  ) {}

  /** Full command used in launch errors. */
  private get command(): string {
    return [this.bin, ...this.prefix].join(" ");
  }

  private run(args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, [...this.prefix, ...args], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", () =>
        reject(new HunkUnavailableError("missing-binary", `hunk not executable: ${this.command}`)),
      );
      child.on("close", (code) => {
        if (code === 0) return resolve(out);
        if (/No active Hunk sessions/i.test(err)) {
          return reject(
            new HunkUnavailableError(
              "no-session",
              "No active hunk session. If hunk is visibly running, loopback (127.0.0.1:47657) " +
                "may be blocked by an agent sandbox; set HUNK_MCP_PORT or relax the sandbox.",
            ),
          );
        }
        reject(new Error(err.trim() || `hunk exited ${code}`));
      });
      if (stdin !== undefined) child.stdin.end(stdin);
      else child.stdin.end();
    });
  }

  /** Inserts the outer `--json` option before the first nested-command separator. */
  private async json<T>(args: string[], stdin?: string): Promise<T> {
    const separator = args.indexOf("--");
    const withJson =
      separator === -1
        ? [...args, "--json"]
        : [...args.slice(0, separator), "--json", ...args.slice(separator)];
    return JSON.parse(await this.run(withJson, stdin)) as T;
  }

  async getSession(repo: string): Promise<{ id: string; repo: string; path: string }> {
    const r = await this.json<{ session: { id: string; repo: string; path: string } }>([
      "session",
      "get",
      "--repo",
      repo,
    ]);
    return r.session;
  }

  async listComments(repo: string, type: CommentType = "user"): Promise<HunkComment[]> {
    const r = await this.json<{ comments?: unknown }>([
      "session",
      "comment",
      "list",
      "--repo",
      repo,
      "--type",
      type,
    ]);
    return parseHunkComments(r.comments);
  }

  async removeComment(repo: string, id: string): Promise<void> {
    await this.json(["session", "comment", "rm", "--repo", repo, id]);
  }

  /** Applies the write-side `AgentNote` schema, which differs from `HunkComment`. */
  async applyComments(repo: string, comments: AgentNote[]): Promise<void> {
    await this.json(
      ["session", "comment", "apply", "--repo", repo, "--stdin"],
      JSON.stringify({ comments }),
    );
  }

  /** Re-points a live session, preserving flags that affect reviewed content. */
  async reload(repo: string, target: Target, cfg: PluginConfig): Promise<void> {
    if (!canReload(target.mode)) {
      throw new Error(`hunk cannot reload a ${target.mode} review in place.`);
    }
    const excludeUntracked =
      cfg.review.exclude_untracked && EXCLUDE_UNTRACKED_MODES.has(target.mode)
        ? ["--exclude-untracked"]
        : [];
    await this.json([
      "session",
      "reload",
      "--repo",
      repo,
      "--",
      ...subcommandFor(target),
      ...excludeUntracked,
    ]);
  }

  /** Moves a live session to the single target represented by `NavigateRequest`. */
  async navigate(repo: string, opts: NavigateRequest): Promise<void> {
    const base = ["session", "navigate", "--repo", repo];
    if ("nextComment" in opts) return void (await this.json([...base, "--next-comment"]));
    if ("prevComment" in opts) return void (await this.json([...base, "--prev-comment"]));
    const target =
      "hunk" in opts
        ? ["--hunk", String(opts.hunk)]
        : "oldLine" in opts
          ? ["--old-line", String(opts.oldLine)]
          : ["--new-line", String(opts.newLine)];
    await this.json([...base, "--file", opts.file, ...target]);
  }
}
