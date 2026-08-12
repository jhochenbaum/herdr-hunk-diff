---
name: hunk-herdr-review
description: Leave inline review notes on a hunk session a user is reviewing inside herdr, using the hunk binary bundled with the jhochenbaum.hunkdiff plugin. Use when working in a herdr pane on a worktree the user is reviewing with hunk.
---

# hunk review inside herdr

The hunk TUI belongs to the user. **Never launch it** — no `hunk diff`, `hunk show`, `hunk patch`,
no `herdr plugin action invoke review`. Opening or re-pointing a review is the user's decision, made
from their own keybindings and command palette. Your job is to leave notes on the review they are
already looking at, and to move their view only when they ask you to.

Everything below is `hunk`'s own `session` CLI, addressed with `--repo "$PWD"`. There is no
herdr action to go through: `herdr plugin action invoke` accepts no arguments and no stdin, so a
plugin action cannot be handed a note batch or a navigation target at all.

## Resolve the binary once, at the start of the task

**`hunk` is not on your `PATH`.** It ships as a dependency of the `jhochenbaum.hunkdiff` plugin,
inside that plugin's install directory. Assume any bare `hunk ...` command you write will fail with
"command not found". Ask herdr where the plugin lives, and use that copy:

```bash
plugin_root="$(herdr plugin list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=(JSON.parse(s).result.plugins||[]).find(p=>p.plugin_id==="jhochenbaum.hunkdiff");process.stdout.write(p&&p.plugin_root||"")})')"
hunk="$plugin_root/node_modules/.bin/hunk"
test -x "$hunk" || echo "jhochenbaum.hunkdiff is not installed; report your notes in your reply instead"
```

`herdr plugin list --json` answers `{"result":{"plugins":[{...,"plugin_id":...,"plugin_root":...}]}}`.
Match on `plugin_id`, never on list position or on `name` — the list holds every installed plugin.
Resolve `$hunk` once and reuse it; do not hardcode the path, which differs per install.

## Address the right session, every time

```bash
"$hunk" session list --json
"$hunk" session get --repo "$PWD" --json
```

Pass `--repo "$PWD"` to **every** session command. Never rely on hunk auto-resolving a single
session: the user may be reviewing several worktrees at once, and a note applied to the wrong
session lands on somebody else's diff.

`session list` is the one command that succeeds with nothing open (`{"sessions": []}`). Every other
session command exits non-zero when no session matches, which is the signal that the user has not
opened this review yet.

## Read the review before commenting on it

```bash
"$hunk" session review --repo "$PWD" --json
"$hunk" session review --repo "$PWD" --include-notes --json
"$hunk" session context --repo "$PWD" --json
```

`review --json` gives the file and hunk structure without inflating your context; add
`--include-patch` only for files you truly need in raw diff form. `--include-notes` adds the notes
already on the review. `context` reports what the user is currently looking at.

## Leave notes

One batch, from stdin, is the normal case:

```bash
printf '%s' '{"comments":[
  {"filePath":"src/a.ts","newLine":42,"summary":"Guard the null case","rationale":"userId is optional here"},
  {"filePath":"src/b.ts","hunk":2,"summary":"This rename is the point of the change"}
]}' | "$hunk" session comment apply --repo "$PWD" --stdin --json
```

Each item needs `filePath`, `summary`, and **exactly one** of `hunk` (1-based hunk number),
`oldLine`, or `newLine`. `rationale` and `author` are optional. hunk validates the whole batch
before it mutates anything, so a bad item costs you nothing but a retry.

For a single note, `comment add` takes flags instead of stdin:

```bash
"$hunk" session comment add --repo "$PWD" --file src/a.ts --new-line 42 \
  --summary "Guard the null case" --rationale "userId is optional here" --json
```

`comment add` requires `--file`, `--summary`, and exactly one of `--old-line` / `--new-line`;
omitting the target answers `Specify exactly one comment target: --old-line <n> or --new-line <n>.`

Add `--focus` only when the note itself should steer the user's view — it moves them, so the same
restraint applies as to `navigate` below.

**A note needs a live session.** There is no offline queue: if `comment apply` reports no active
session, the user has not opened the review yet. Say so and put your findings in your own reply —
do not open a review yourself, and do not retry in a loop.

## Read notes back — the output shape is not the input shape

```bash
"$hunk" session comment list --repo "$PWD" --type user --json
"$hunk" session comment rm --repo "$PWD" <comment-id> --json
```

`comment list` does **not** echo back what `comment apply` takes. Captured from the verified bundled
Hunk CLI:

```json
{
  "comments": [
    {
      "noteId": "user:1786393885051-1",
      "source": "user",
      "filePath": "README.md",
      "hunkIndex": 0,
      "newRange": [63, 63],
      "body": "Did we really add support for …",
      "author": "user",
      "createdAt": "2026-08-10T20:31:25.051Z",
      "editable": true
    }
  ]
}
```

So on the way out it is `noteId`, `body`, and `newRange`/`oldRange` as `[start, end]` arrays —
where the way in is `summary` plus a scalar `newLine`/`oldLine`, and there is no `rationale` at all.
Do not feed a `comment list` result back into `comment apply`; translate it. `--type user` is
human-authored notes, which is what the user typed.

## Move the user through the review

Relative, and the safe default — it steps between annotated hunks and needs no `--file`:

```bash
"$hunk" session navigate --repo "$PWD" --next-comment --json
"$hunk" session navigate --repo "$PWD" --prev-comment --json
```

Absolute, for pointing at one specific thing you have just been asked about:

```bash
"$hunk" session navigate --repo "$PWD" --file src/a.ts --hunk 2 --json
"$hunk" session navigate --repo "$PWD" --file src/a.ts --new-line 372 --json
"$hunk" session navigate --repo "$PWD" --file src/a.ts --old-line 355 --json
```

`--file` plus **exactly one navigation target** — `--hunk` (1-based), `--old-line`, or `--new-line`.
hunk refuses anything else rather than picking for you:

- two targets → `Specify exactly one navigation target: --hunk <n>, --old-line <n>, or --new-line <n>.`
- a target with no `--file` → `Specify --file <path> with a navigation target, or use --next-comment / --prev-comment.`

Use absolute navigation sparingly: annotate first, and jump only when you are pointing at one thing.
A note is additive and the user can read past it; every jump takes them somewhere they did not
choose to go.

## When something goes wrong

- **"No active Hunk sessions"** while hunk is visibly running usually means loopback
  (`127.0.0.1:47657`) is blocked by your sandbox. Say so rather than retrying silently; hunk honours
  `HUNK_MCP_PORT` if the user has moved the daemon.
- **"No diff file matches …"** — the path is not in the loaded review. Check
  `session review --json` for the paths hunk actually holds; they are as hunk displays them, which
  may not be how you spell them.
- **A command that exits non-zero with no session in `session list`** — the review is not open.
  Report, do not retry.

## Guidelines

- Comment on what the user would not spot themselves. Do not annotate every hunk.
- Keep `summary` to one real sentence; put detail in `rationale`.
- Prefer one `comment apply` batch over many `comment add` calls.
- Never edit the worktree as part of a review.
