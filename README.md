<div align="center">

# herdr-hunk-diff

**Review agent-authored changes in [hunk](https://hunk.dev) without leaving [herdr](https://herdr.dev).**

Opens the right worktree, collects your inline review comments,
and sends them back to the agent responsible for the changes.

[![CI](https://github.com/jhochenbaum/herdr-hunk-diff/actions/workflows/ci.yml/badge.svg)](https://github.com/jhochenbaum/herdr-hunk-diff/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

https://github.com/user-attachments/assets/a36991a9-288f-4c8a-845c-ce2399334b9b

</div>

---

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Keybinding behavior](#keybinding-behavior)
- [Review actions](#review-actions) &middot; [Base branch resolution](#base-branch-resolution) &middot; [GitHub commit links](#github-commit-links)
- [Configuration](#configuration) &middot; [Options](#option-reference) &middot; [Automatic opening](#automatic-opening) &middot; [Target and display](#review-target-and-display) &middot; [Round-trip prompts](#round-trip-prompts) &middot; [Hunk executable](#hunk-executable)
- [Optional VCS pager setup](#optional-vcs-pager-setup)
- [Direct hunk workflows](#direct-hunk-workflows)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Prior art](#prior-art) &middot; [License](#license)

---

## Requirements

| Name | Version |
| --- | --- |
| **herdr** | 0.8.0 or newer on macOS or Linux |
| **Node** | 22.12 or newer |

The plugin installs its pinned `hunkdiff` dependency automatically. You do not need a global hunk
installation for reviews opened inside herdr.

## Quick start

### 1. Install the plugin

```bash
herdr plugin install jhochenbaum/herdr-hunk-diff
```

### 2. Choose how to run actions

<table>
<tr><th width="50%">Recommended: keybindings</th><th width="50%">No setup: CLI</th></tr>
<tr valign="top">
<td>

Most users should install the default bindings:

```bash
herdr plugin action invoke setup-keys \
  --plugin jhochenbaum.hunkdiff
herdr server reload-config
```

</td>
<td>

Every action can also be invoked directly:

```bash
herdr plugin action invoke review \
  --plugin jhochenbaum.hunkdiff
herdr plugin action invoke send-review \
  --plugin jhochenbaum.hunkdiff
```

</td>
</tr>
</table>

| Key              | Action                 |
| ---------------- | ---------------------- |
| `prefix+shift+h` | Review changes         |
| `prefix+shift+s` | Send review to agent   |
| `prefix+shift+c` | Review the last commit |
| `prefix+shift+a` | Review staged changes  |

### 3. Review and send

1. Focus the agent or worktree you want to review in herdr.
2. Press `prefix+shift+h`, or invoke the CLI `review` action.
3. Leave comments with hunk's normal inline-comment controls.
4. Press `prefix+shift+s`, or invoke the CLI `send-review` action.

By default, `review` shows the branch diff when the branch is ahead of its base. Otherwise, it
shows the working tree. The plugin reads only your human-authored comments; agent annotations
remain in the review for context.

`send-review` formats all unsent comments into one prompt and submits it to the associated agent.
Successfully delivered comments are removed from hunk by default, and their IDs are recorded so
they cannot be sent twice.

> [!NOTE]
> Reviews do not open automatically by default. See [Automatic opening](#automatic-opening) to opt
> in.

## Keybinding behavior

`setup-keys` edits the config file herdr actually loads:

1. `$HERDR_CONFIG_PATH` when set
2. `$XDG_CONFIG_HOME/herdr/config.toml`
3. `~/.config/herdr/config.toml`

Before writing, it backs up an existing config to `config.toml.hunkdiff-backup`. It never
overwrites an occupied key. Free bindings are installed, conflicts are reported and skipped, and
invalid TOML is left untouched. Re-running the action installs any bindings that have since become
available.

Remove the managed bindings with:

```bash
herdr plugin action invoke remove-keys --plugin jhochenbaum.hunkdiff
herdr server reload-config
```

> [!TIP]
> If you use [`jt.command-palette`](https://github.com/JanTvrdik/herdr-command-palette), every
> action is also searchable by its `hunk: ` title without installing keybindings.

## Review actions

**Opening a review**

| Action          | Review opened                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `review`        | Configured `default_target`; `auto` selects the branch diff when ahead of base, otherwise the working tree |
| `review:staged` | Staged changes with `hunk diff --staged`                                                                   |
| `review:branch` | `<base>...HEAD`; falls back to the working tree with a warning when no base can be resolved                |
| `review:commit` | The latest commit, or a locally available commit from a Ctrl-clicked GitHub commit URL                      |
| `review:stash`  | The most recent stash entry                                                                                |

**Everything else**

| Action            | Effect                                                    |
| ----------------- | --------------------------------------------------------- |
| `send-review`     | Send all unsent inline comments to the associated agent    |
| `reload`          | Reload the target shown in the current review pane         |
| `close-review`    | Close the review pane for the current worktree             |
| `next-comment`    | Move hunk to the next annotated hunk                       |
| `prev-comment`    | Move hunk to the previous annotated hunk                   |
| `setup-keys`      | Install the default herdr keybindings                      |
| `remove-keys`     | Remove only the keybinding block installed by this plugin  |
| `install-pager`   | Configure supported VCS pagers                             |
| `uninstall-pager` | Remove pager configuration owned by this plugin             |

Invoke any action from the CLI with:

```bash
herdr plugin action invoke <action> --plugin jhochenbaum.hunkdiff
```

### Base branch resolution

Branch reviews resolve their base in this order:

1. The current branch's upstream, unless it is that branch's own remote-tracking branch
2. `origin/HEAD`
3. The first existing branch named `main`, `master`, or `trunk`

This keeps a feature branch that deliberately tracks `origin/main` working as expected while
avoiding an empty comparison against `origin/<same-feature-branch>`.

### GitHub commit links

Ctrl-clicking a GitHub commit URL opens that commit with `hunk show <sha>`. The commit must already
exist in the current local repository; fetch it first if the plugin reports that it cannot resolve
the SHA.

Pull request URLs are not handled because resolving a PR accurately requires network access and
authentication.

## Configuration

Ask herdr for the plugin's config directory, then create `config.toml` there:

```bash
config_dir="$(herdr plugin config-dir jhochenbaum.hunkdiff)"
${EDITOR:-vi} "$config_dir/config.toml"
```

Files in other locations are ignored. All settings are optional; this is the complete default
configuration:

```toml
[review]
auto_open         = false
on_states         = ["idle"]  # idle | working | blocked | unknown
reuse_pane        = true
default_target    = "auto"    # auto | working | staged | branch
watch             = false
placement         = "split"   # overlay | split | tab | zoomed
exclude_untracked = false

[roundtrip]
clear_after_send = true
prompt_template = """Human-authored inline review comments on your changes in {worktree}:

{comments}

Address each comment and verify the resulting changes. If a comment is unclear or requires a decision, ask a focused clarification question and continue with any unaffected comments. Then summarize what you changed and explain anything you did not implement."""

[hunk]
bin          = "auto"
experimental = false
extra_args   = []
```

### Option reference

<details>
<summary><b><code>[review]</code></b> — what opens, where, and when</summary>

| Setting                    | Accepted values                                 | Effect                                                                                                                     |
| -------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `review.auto_open`         | `true` / `false`                                | Opens or refreshes a review when an associated agent enters a configured state.                                            |
| `review.on_states`         | List of `idle`, `working`, `blocked`, `unknown` | Selects the Herdr agent states that trigger automatic opening. An empty list disables all triggers.                        |
| `review.reuse_pane`        | `true` / `false`                                | Refreshes the worktree's existing review pane when possible instead of opening another pane.                                |
| `review.default_target`    | `auto`, `working`, `staged`, `branch`           | Chooses what the `review` action shows. `auto` uses the branch diff when ahead of its base and the working tree otherwise. |
| `review.watch`             | `true` / `false`                                | Passes `--watch` to Hunk so an open review refreshes as its underlying source changes.                                      |
| `review.placement`         | `overlay`, `split`, `tab`, `zoomed`             | Chooses where Herdr opens review panes: over the active pane, beside it, in a new tab, or as a zoomed pane.                |
| `review.exclude_untracked` | `true` / `false`                                | Hides untracked files from working-tree, staged, and branch reviews.                                                        |

</details>

<details>
<summary><b><code>[roundtrip]</code></b> — sending comments back to the agent</summary>

| Setting                      | Accepted values  | Effect                                                                                                                  |
| ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `roundtrip.clear_after_send` | `true` / `false` | Removes comments from Hunk after successful delivery. With `false`, they remain visible but are still recorded as sent.  |
| `roundtrip.prompt_template`  | String           | Controls the prompt sent to the agent. Supported placeholders are listed under [Round-trip prompts](#round-trip-prompts). |

</details>

<details>
<summary><b><code>[hunk]</code></b> — which executable runs, and how</summary>

| Setting             | Accepted values            | Effect                                                                                                                           |
| ------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `hunk.bin`          | `auto` or an absolute path | Uses the bundled Hunk executable or a specific external executable.                                                              |
| `hunk.experimental` | `true` / `false`           | Passes Hunk's `--experimental` option, currently including support for STML-rendered agent notes.                                 |
| `hunk.extra_args`   | List of strings            | Appends advanced arguments verbatim to each new Hunk launch. Invalid or conflicting arguments can prevent a review from opening. |

</details>

### Automatic opening

Set `auto_open = true` to open or refresh a review when an associated agent reaches one of the
configured `on_states`:

```toml
[review]
auto_open = true
on_states = ["idle"]
```

Manual testing with herdr's plugin event hook confirmed that an agent completing a turn arrives as
`idle`. With `auto_open = false`, matching events still associate the agent with its worktree so a
later `send-review` knows where to deliver your comments.

`reuse_pane = true` refreshes the existing review for a worktree instead of opening another pane.
Automatic opens target the pane that emitted the agent event.

### Review target and display

`default_target = "auto"` selects a branch review only when the current branch has commits ahead of
its resolved base. Otherwise, it opens the working tree.

`exclude_untracked = true` hides untracked files in working-tree, staged, and branch reviews. Hunk
does not accept that option for commit or stash reviews.

`placement` supports the four persistent Herdr placements that return a pane ID. Herdr's modal
`popup` placement is intentionally excluded because it cannot be reused, addressed, closed, or
reported through the pane APIs this plugin relies on.

> [!NOTE]
> Hunk owns presentation settings such as theme, split/stack layout, line numbers, wrapping, and
> tab width. Configure those in `~/.config/hunk/config.toml`; this plugin does not override them.

### Round-trip prompts

`prompt_template` supports four placeholders:

| Placeholder  | Value                                      |
| ------------ | ------------------------------------------ |
| `{comments}` | Markdown list of unsent review comments    |
| `{count}`    | Number of comments being sent              |
| `{worktree}` | Absolute path of the reviewed worktree     |
| `{agent}`    | Associated agent name, or `agent` if unset |

Sending is always explicit. Closing a review ends its hunk session, so comments cannot be sent
reliably after the pane has closed.

### Hunk executable

`[hunk].bin = "auto"` resolves the hunk binary bundled with this plugin. Set an absolute path to use
a separately installed binary.

`experimental = true` passes hunk's `--experimental` option, including support for STML-rendered
agent notes. `extra_args` appends string arguments to every hunk launch. If any list item is not a
string, the entire list is rejected to avoid constructing a partial command.

## Optional VCS pager setup

Pager setup is independent of reviews inside herdr. It makes commands such as `git diff`, `git log`,
and `git show` open hunk from any terminal.

First install hunk globally so the pager command remains available across plugin updates:

```bash
npm install --global hunkdiff
herdr plugin action invoke install-pager --plugin jhochenbaum.hunkdiff
```

**Git.** The action writes `core.pager = hunk pager` only after confirming that `hunk` is on
`PATH`. If another pager is configured, the action names the replaced value and prints its restore
command. Multi-valued or unreadable Git configuration is left untouched.

`uninstall-pager` removes only a value this plugin could have installed. It will not remove an
unrelated pager configured later.

**Jujutsu and Sapling.** The action prints the required configuration snippet and edit command;
their configuration is not changed automatically.

## Direct hunk workflows

Herdr plugin actions cannot accept a file, pathspec, patch, or arbitrary revision argument. Install
hunk globally when you need those forms:

```bash
npm install --global hunkdiff

hunk diff -- src/ui          # Review selected paths
hunk patch fix.diff          # Review a patch file
hunk diff before.ts after.ts # Compare two files
hunk show HEAD~1             # Review an arbitrary commit
```

The plugin's bundled executable is intentionally not added to your shell's `PATH`.

## Troubleshooting

<details>
<summary><b>A review pane closes immediately</b></summary>

The plugin sends a Herdr notification when hunk exits unsuccessfully. Inspect the captured action
and event logs for the full failure:

```bash
herdr plugin log list --plugin jhochenbaum.hunkdiff
```

For a linked development checkout, rebuild before retrying:

```bash
npm run build
```

</details>

<details>
<summary><b>No active hunk session</b></summary>

Open a review before using `send-review`, `reload`, `next-comment`, or `prev-comment`. If hunk is
visibly open, the agent sandbox may be blocking loopback access to `127.0.0.1:47657`. Allow local
loopback traffic or configure both processes with the same `HUNK_MCP_PORT`.

</details>

<details>
<summary><b>No agent is associated with this worktree</b></summary>

Focus the intended agent pane and open the review again. Review actions invoked from an agent pane
record that pane as the delivery target. Matching agent-status events also record the association.

The index stores one delivery target per worktree. If multiple agents share a checkout, invoke
`send-review` from the intended agent pane or reopen the review from that pane before sending.

</details>

<details>
<summary><b>Installed keybindings do nothing</b></summary>

Reload Herdr's config after `setup-keys` or `remove-keys`:

```bash
herdr server reload-config
```

</details>

<details>
<summary><b>Configuration appears to be ignored</b></summary>

Confirm that the file is in the directory Herdr reports:

```bash
herdr plugin config-dir jhochenbaum.hunkdiff
```

Invalid TOML and invalid values fall back to defaults.

</details>

## Known limitations

- Review actions cannot receive pathspecs, patch paths, file pairs, or arbitrary revisions.
- Stash reviews cannot be reloaded in place; close and reopen them.
- Sending comments is explicit through `send-review`; closing a pane does not send them.
- GitHub links support commits already present locally, not pull requests.
- Agent-authored notes require a live hunk session. The bundled
  [`hunk-herdr-review` skill](skills/hunk-herdr-review/SKILL.md) documents that workflow.

## Development

```bash
npm ci
npm run check
npm run build
npm test
```

CI runs formatting, linting, TypeScript compilation, tests, and a high-severity dependency audit.

## Prior art

[`persiyanov/herdr-reviewr`](https://github.com/persiyanov/herdr-reviewr) covers similar workflows
with its own diff viewer. This plugin is for users who specifically want hunk's review UI and live
session API.

## License

[MIT](LICENSE)
