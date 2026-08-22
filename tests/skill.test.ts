import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";

const SKILL = readFileSync("skills/hunk-herdr-review/SKILL.md", "utf8").replaceAll("\r\n", "\n");
const manifest = parse(readFileSync("herdr-plugin.toml", "utf8")) as any;
const PLUGIN_ID = manifest.id as string;
const DECLARED_ACTIONS: string[] = manifest.actions.map((a: any) => a.id);

const CODE_BLOCKS = [...SKILL.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);

const SESSION_LINES = CODE_BLOCKS.flatMap((b) => b.split("\n")).filter((l) =>
  /\bsession\b/.test(l),
);

const HUNK_SESSION_SUBCOMMANDS = new Set([
  "list",
  "get",
  "context",
  "review",
  "navigate",
  "reload",
  "comment add",
  "comment apply",
  "comment list",
  "comment rm",
  "comment clear",
]);

describe("skills/hunk-herdr-review/SKILL.md", () => {
  it("has fenced bash examples that invoke hunk's session CLI at all", () => {
    expect(CODE_BLOCKS.length).toBeGreaterThan(0);
    expect(SESSION_LINES.length).toBeGreaterThan(0);
  });

  describe("resolving the bundled binary", () => {
    it("asks herdr where the plugin lives rather than hardcoding an install path", () => {
      expect(SKILL).toContain("herdr plugin list --json");
      expect(SKILL).toContain("plugin_id");
      expect(SKILL).toContain("plugin_root");
      expect(SKILL).toContain(PLUGIN_ID);
    });

    it("derives the binary from that root, and bakes in no absolute path of its own", () => {
      expect(SKILL).toContain("node_modules/.bin/hunk");
      expect(SKILL).not.toMatch(/\/Users\//);
      expect(SKILL).not.toMatch(/\.config\/herdr\/plugins/);
    });

    it("warns that hunk is not on an agent's PATH", () => {
      expect(SKILL).toMatch(/not on (an agent's |your )?`?PATH`?/i);
    });

    it("never tells an agent to run a bare hunk command", () => {
      const bare = SKILL.split("\n").filter((l) =>
        /^\s*hunk\s+(session|diff|show|patch|stash|markup)\b/.test(l),
      );
      expect(bare).toEqual([]);
    });

    it("routes every session command through the resolved binary variable", () => {
      for (const line of SESSION_LINES) {
        expect(line, `session command not run via the resolved binary: ${line.trim()}`).toMatch(
          /"\$hunk" session/,
        );
      }
    });
  });

  describe("the commands it documents", () => {
    it('addresses every session command with --repo "$PWD"', () => {
      for (const line of SESSION_LINES) {
        if (/"\$hunk" session list\b/.test(line)) continue;
        expect(line, `session command with no --repo: ${line.trim()}`).toContain('--repo "$PWD"');
      }
    });

    it("names only subcommands the verified bundled Hunk CLI has", () => {
      const named = new Set<string>();
      for (const line of SESSION_LINES) {
        const m = line.match(/"\$hunk" session (\S+)(?: (\S+))?/);
        expect(m, `unparseable session command: ${line.trim()}`).not.toBeNull();
        const [, first, second] = m!;
        named.add(first === "comment" ? `comment ${second}` : first);
      }
      expect(named.size).toBeGreaterThan(0);
      for (const sub of named) {
        expect(HUNK_SESSION_SUBCOMMANDS, `Hunk has no \`session ${sub}\``).toContain(sub);
      }
    });

    it("covers the inspect commands an agent needs before it comments", () => {
      for (const sub of ["session list", "session get", "session context", "session review"]) {
        expect(SKILL).toContain(`"$hunk" ${sub}`);
      }
    });
  });

  describe("leaving notes", () => {
    it("shows a comment apply batch whose every item carries the fields hunk requires", () => {
      const example = CODE_BLOCKS.find((b) => b.includes("session comment apply"));
      expect(example, "no fenced example applies a comment batch").toBeDefined();
      expect(example).toContain("--stdin");

      const jsonLiteral = example!.match(/\{[\s\S]*\}(?='\s*\|)/);
      expect(jsonLiteral, "the comment apply example pipes in no JSON payload").not.toBeNull();

      const payload = JSON.parse(jsonLiteral![0]);
      expect(Array.isArray(payload.comments)).toBe(true);
      expect(payload.comments.length).toBeGreaterThan(0);
      for (const c of payload.comments) {
        expect(c.filePath, `batch item with no filePath: ${JSON.stringify(c)}`).toBeTruthy();
        expect(c.summary, `batch item with no summary: ${JSON.stringify(c)}`).toBeTruthy();
        const targets = (["hunk", "oldLine", "newLine"] as const).filter((k) => k in c);
        expect(
          targets,
          `batch item must carry exactly one target: ${JSON.stringify(c)}`,
        ).toHaveLength(1);
      }
    });

    it("documents the single-note form with the flags hunk requires for it", () => {
      const example = CODE_BLOCKS.find((b) => b.includes("session comment add"));
      expect(example, "no fenced example adds a single note").toBeDefined();
      expect(example).toContain("--file");
      expect(example).toContain("--summary");
      expect(example).toMatch(/--new-line|--old-line/);
    });

    it("spells out that comment list's output is not comment apply's input", () => {
      for (const outputField of ["noteId", "body", "newRange"]) {
        expect(SKILL, `the output shape must name ${outputField}`).toContain(outputField);
      }
      for (const inputField of ["filePath", "summary", "newLine"]) {
        expect(SKILL, `the input shape must name ${inputField}`).toContain(inputField);
      }
      expect(SKILL).toMatch(/not the input shape|do not feed a `?comment list`? result/i);
    });

    it("promises no offline queue, and says a live session is required", () => {
      expect(SKILL).toMatch(/live session/i);
      expect(SKILL).not.toMatch(/accumulate/i);
      expect(SKILL).not.toMatch(/saved (your |the )?notes/i);
      expect(SKILL).not.toMatch(/until the review opens/i);
    });
  });

  describe("navigation", () => {
    it("documents the relative form, which needs no --file", () => {
      expect(SKILL).toContain("--next-comment");
      expect(SKILL).toContain("--prev-comment");
    });

    it("documents the absolute form with all three targets hunk accepts", () => {
      const example = CODE_BLOCKS.find(
        (b) => b.includes("session navigate") && b.includes("--file"),
      );
      expect(example, "no fenced example navigates to a file and a location").toBeDefined();
      for (const target of ["--hunk", "--old-line", "--new-line"]) {
        expect(example, `the absolute form must show ${target}`).toContain(target);
      }
    });

    it("states hunk's exactly-one-target rule, which it enforces rather than resolving", () => {
      expect(SKILL).toMatch(/exactly one navigation target/i);
    });

    it("documents navigation as available, and still forbids the TUI as a workaround", () => {
      expect(SKILL).toMatch(/## Move the user through the review/i);
      for (const phrase of [
        /no action for jumping/i,
        /cannot jump to (a|an) (arbitrary )?(file|location)/i,
        /there is no way to (navigate|jump)/i,
      ]) {
        expect(SKILL).not.toMatch(phrase);
      }
      expect(SKILL).toMatch(/never launch it/i);
    });
  });

  it("still tells agents never to launch the TUI, which belongs to the user", () => {
    expect(SKILL).toMatch(/never launch it/i);
    for (const tui of ["hunk diff", "hunk show", "hunk patch"]) {
      expect(SKILL, `the prohibition must name \`${tui}\``).toContain(tui);
    }
  });

  it("keeps the sandbox note that explains a missing session while hunk is running", () => {
    expect(SKILL).toContain("127.0.0.1:47657");
    expect(SKILL).toMatch(/No active Hunk sessions/);
    expect(SKILL).toMatch(/sandbox/i);
  });

  describe("herdr actions it names", () => {
    it("names only actions the manifest declares", () => {
      const invoked = [...SKILL.matchAll(/herdr plugin action invoke ([A-Za-z0-9:_-]+)/g)].map(
        (m) => m[1],
      );
      expect(invoked.length, "no herdr action is named at all").toBeGreaterThan(0);
      for (const id of invoked) {
        expect(DECLARED_ACTIONS, `the skill names an undeclared action "${id}"`).toContain(id);
      }
    });

    it("points agents at neither agent-facing action a payload cannot reach", () => {
      for (const removed of ["annotate", "navigate"]) {
        expect(DECLARED_ACTIONS, `the manifest declares ${removed}`).not.toContain(removed);
        expect(SKILL, `the skill still points agents at the ${removed} action`).not.toMatch(
          new RegExp(`invoke ${removed}`),
        );
      }
    });
  });
});
