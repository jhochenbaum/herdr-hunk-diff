// Fake hunk for contract tests. Echoes fixture JSON based on argv.
//
// Node rather than a shell script because Windows has no shebang handling, so a spawned
// `#!/usr/bin/env bash` fixture is unrunnable there — and the adapter under test spawns the real
// hunk the same way, as this process's own Node plus a script path.

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
// Bash `"$*"` joins argv with a single space; every glob below was written against that string.
const joined = args.join(" ");

function fail(...lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

// When HUNK_FIXTURE_ARGS_FILE is set, append the exact argv this was called with, so a test can
// assert on the command an adapter method *built* rather than only on what it parsed back. The
// adapter methods that return nothing (reload, navigate, removeComment) have no other observable
// output, and mocking the adapter to check its own arguments would prove nothing.
if (process.env.HUNK_FIXTURE_ARGS_FILE) {
  appendFileSync(process.env.HUNK_FIXTURE_ARGS_FILE, `${joined}\n`);
}

// Argv strictness, before any arm runs. The arms below match on substrings, so on their own they
// would answer a *well-formed-looking* command that real hunk rejects — which is exactly how the
// misplaced `--json` shipped: every reload test passed while the live binary answered
// `error: unknown option '--json'`. Every constraint the verified bundled Hunk CLI enforces on the
// commands this fixture serves has to be enforced here too, or the fixture is licensing a bug
// rather than standing in for the binary.
//
// `--json` is an option of the *outer* command. Everything after `--` is the nested command
// (`hunk session reload --repo . -- diff`), so a `--json` there is parsed as that nested
// command's option and Hunk fails. Verified against the bundled CLI:
//   $ hunk session reload --repo /tmp -- diff --json
//   error: unknown option '--json'
//   $ hunk session reload --repo /tmp --json -- diff
//   hunk: No active Hunk sessions ...          # reaches the real logic
const separator = args.indexOf("--");
if (separator !== -1 && args.slice(separator + 1).includes("--json")) {
  fail(
    "error: unknown option '--json'",
    "fake-hunk: --json must precede the '--' separator; it is an option of the outer command, not the nested one.",
  );
}

// The verified bundled Hunk CLI enforces three rules on a navigate argv, and this fixture must too —
// answering any argv merely shaped like a navigate call would accept what the real binary refuses.
// These invocations fail argument parsing before ever reaching "No active Hunk sessions":
//
//   $ hunk session navigate --repo /tmp --file x --hunk 1 --old-line 5
//   hunk: Specify exactly one navigation target: --hunk <n>, --old-line <n>, or --new-line <n>.
//   $ hunk session navigate --repo /tmp --file x            # zero targets, same refusal
//   hunk: Specify exactly one navigation target: --hunk <n>, --old-line <n>, or --new-line <n>.
//   $ hunk session navigate --repo /tmp --hunk 1            # a target with no --file
//   hunk: Specify --file <path> with a navigation target, or use --next-comment / --prev-comment.
//   $ hunk session navigate --repo /tmp --next-comment --prev-comment
//   hunk: Specify either --next-comment or --prev-comment, not both.
//
// Deliberately NOT enforced: `--file` alongside `--next-comment` or `--prev-comment` is accepted by
// the bundled CLI, which simply ignores `--file`. Rejecting that combination would make this fixture
// *more* restrictive than the binary it stands in for — the mirror image of the bug this guard
// exists to catch — so it is left alone.
if (args[0] === "session" && args[1] === "navigate") {
  const has = (flag) => args.includes(flag);
  const targets = ["--hunk", "--old-line", "--new-line"].filter(has).length;
  const next = has("--next-comment");
  const prev = has("--prev-comment");

  if (next && prev) {
    fail("hunk: Specify either --next-comment or --prev-comment, not both.");
  }
  if (!next && !prev) {
    if (!has("--file")) {
      fail(
        "hunk: Specify --file <path> with a navigation target, or use --next-comment / --prev-comment.",
      );
    }
    if (targets !== 1) {
      fail(
        "hunk: Specify exactly one navigation target: --hunk <n>, --old-line <n>, or --new-line <n>.",
      );
    }
  }
}

function drainStdin() {
  return new Promise((resolve) => {
    process.stdin.on("data", () => {});
    process.stdin.on("end", resolve);
    process.stdin.on("error", resolve);
    process.stdin.resume();
  });
}

// The __no_session__ arm MUST stay first: `session get --repo __no_session__` also matches the
// `session get` arm, and the first match wins.
if (joined.includes("__no_session__")) {
  fail("No active Hunk sessions");
} else if (joined.includes("session get")) {
  console.log('{"session":{"id":"s1","repo":"/wt/x","path":"/wt/x","source":"diff"}}');
} else if (joined.includes("session comment list")) {
  // The comment *output* schema, which is NOT the input schema `session comment apply` takes. A
  // payload here in the input shape (`id`/`summary`/`newLine`/`rationale`) is one real hunk cannot
  // emit, and every test reading it would pass while the live plugin read `undefined` from every
  // field — a fixture that answers a shape the binary never sends licenses a bug rather than
  // standing in for the binary. The verified bundled Hunk CLI answers:
  //
  //   $ hunk session comment list --repo <repo> --type all --json
  //   {"comments":[{"noteId":"user:1786393885051-1","source":"user","filePath":"README.md",
  //     "hunkIndex":0,"newRange":[63,63],"body":"Did we really add support for ...",
  //     "author":"user","createdAt":"2026-08-10T20:31:25.051Z","editable":true}]}
  //
  // Field names, `newRange` as a two-element [start,end] array, and the full set of extra keys are
  // reproduced exactly; only the values are the fixture's own. There is no `rationale` on the way
  // out, so none is invented here — an absent field is part of the contract too.
  console.log(
    '{"comments":[{"noteId":"user:1786393885051-1","source":"user","filePath":"src/a.ts","hunkIndex":0,"newRange":[10,10],"body":"Tighten this","author":"user","createdAt":"2026-08-10T20:31:25.051Z","editable":true}]}',
  );
} else if (joined.includes("session comment apply")) {
  await drainStdin();
  console.log('{"applied":1}');
} else if (joined.includes("session comment rm")) {
  // `comment rm` addresses a comment by an id out of the payload above, so a missing operand or a
  // literal "undefined" means the caller read a field that payload does not have. Refused loudly:
  // answering `{"removed":1}` to either would report success for a removal that cannot have
  // happened, which is indistinguishable from working. Unlike the `--json` guard above, this pins a
  // constraint on *our* callers rather than a known hunk refusal: what the binary itself does with a
  // missing operand is unestablished.
  if (args.includes("undefined")) {
    fail(
      "fake-hunk: 'comment rm' got the literal id 'undefined' — the caller read a field the comment-list payload does not have.",
    );
  }
  // A well-formed rm is exactly 7 words: session comment rm --repo <repo> <id> --json. Anything
  // shorter means the id operand never arrived.
  if (args.length < 7) {
    fail("fake-hunk: 'comment rm' requires a comment id operand; none was passed.");
  }
  console.log('{"removed":1}');
} else if (joined.includes("session reload")) {
  console.log('{"reloaded":true}');
} else if (joined.includes("session navigate")) {
  console.log('{"navigated":true}');
} else {
  console.error(`unexpected args: ${joined}`);
  process.exit(2);
}
