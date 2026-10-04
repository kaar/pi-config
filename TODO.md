# TODO

## Git worktree support

Add command to /fork or /new a session into a worktree.
This should create a new git worktree under .worktrees/<branch_name> and open up Pi inside this worktree.
The new PI inside the worktree is going to be opened as a split pane in tmux.

For merging changes from a worktree back into the main branch, see
[WORKTREE_MERGE_WORKFLOW.md](./WORKTREE_MERGE_WORKFLOW.md).

## Compare implementations

When I do multiple implementations from the same SPEC I would like a good way to compare the two.

Example would be I have two different .worktrees with the different implementations of the same thing.

## Git guard

- [ ] Add a user-controlled override to temporarily disable `agent/extensions/git-guard.ts` and enable it again. Keep git-guard enabled by default. Show clearly when it is disabled.

Example: session `01a1014e-7b6e-70e3-b828-a8e210d0125d` involved recovery from a paused rebase in `herdr-config`. The user approved skipping a conflicting registry-only commit while preserving the local `plugins.json`. Git-guard blocked the backup, `git rebase --skip`, and restore command sequence with `Blocked: interactive git command`. The user then chose to run the commands manually. An explicit override can let the user authorize this recovery without removing the extension.

Session log: `/Users/casparnettelbladt/.pi/agent/sessions/--Users-casparnettelbladt-GitHub-kaar-herdr-config--/2026-10-03T10-28-03-054Z_01a1014e-7b6e-70e3-b828-a8e210d0125d.jsonl`.

~~Git guard should not alert for a file that it has already touched this session.~~ Fixed: session-touched files are now tracked in a `Set` and bypassed on subsequent write/edit calls.

~~Still manages to do destructive git commands~~ Fixed: `git rm -f` / `git rm --force` added to `DESTRUCTIVE_GIT_PATTERNS`.

Investigate why the git guard blocks `GIT_EDITOR=true git rebase --continue && git status --short --branch && git log --oneline -3` as interactive, and fix it if the classification is incorrect.

## Formatting of design spec markdowns

I'm running into where design documents and other markdown documents are formatted by breaking line lengths.
Not sure what this is coming from. Need to investigate

## Agent Observer
I would like to connect an agent to the current workflow of another agent to continue build on what that agent is currently producing or writing.

You select a session to connect to.
The new agent is listening to the whole conversation and can make continued work or monitoring of what that agent is working on.

For example:

read stream from <session_id> | run agent connected to that stream and use its output and a source of information/context.



## Extensions and Skill replacements
ogulcancelik removed the pi web plugin with a skill. I would like to try that out instead of using the extension.

There are also some other extensions that are interesting like `pi-session-recall`
- https://github.com/ogulcancelik/pi-extensions
- https://github.com/ogulcancelik/agent-skills


## /recap

I would like a similar skill in Pi as clauds recap feature

## Change ci from skill to script

Consider rewriting pi-ai-commit to a script like q-pi
See ~/Dev/scripts/q-pi

## Disable model invocation support
Add extension for handle skills that can not be invoked using human
```yaml
disable-model-invocation: true
```

This is part of the standard that I think Claude Code invokes. It is not part of the SKILLs standard that Pi uses.

Also not executing `!<command>` inside skills.


## Extensions

### To Review
https://github.com/elpapi42/pi-observational-memory, ~/Dev/pi-observational-memory
https://github.com/MasuRii/pi-rtk-optimizer, ~/Dev/pi-rtk-optimizer

## Auto commit

This is an extension that you can turn on and off.
It should be visual in Pi when it is turned on.
It should trigger a workflow where the agent is instructed to auto-commit changes as they are made.
It should be aware that it should invoke a sub-agent to go away and commit the changes as the agent is working on something.
Each commit should capture small commits as changes are being made. The smaller and to the point as possible. If it make sense after each edit or group of related edits.
It can be a bit wonky initially and do for all edits, but if easy it can also do it as group of edits.

The workflow triggered automatically within a session as the agent is working.

## Write a Pi Agent that only communicates with email
Why? I always have access to email.

I can ask it to find things I need.
I can ask it to send me information.
I can ask it to do things like write ups.
Its by design async communication like the agents are.

It should run on its own machine, with its own email.
It should get emails, read them, process them and send tasks.

It should be able to communicate with a limited amount of emails.

It should be able to create loops

It should be able to write stuff into a repo, change files etc.

## Markdown links: visibility workaround applied

**Decision:** Use Pi's existing setting, not an extension. The local `agent/settings.json` (symlinked as `~/.pi/agent/settings.json`) now contains:

```json
{
  "terminal": {
    "hyperlinks": false
  }
}
```

This is a settings fragment, not a replacement for the whole file. `agent/settings.json` is Git-ignored, so the setting must be reapplied on a fresh installation. Run `/reload` to apply it to the current session.

### Why the setting is needed

Pi 0.87.1 detects Ghostty's OSC 8 hyperlink support. With the default `"auto"`, Pi shows only the underlined Markdown label and hides the target. For example, `[the course refresh review](docs/research/course-refresh-review.md)` hides the file path. Descriptive labels also hide HTTP(S) URLs.

Setting `terminal.hyperlinks` to `false` disables OSC 8 output and restores `label (target)`. If the label already equals the target, Pi shows it only once. Paths and URLs stay visible for copying, even when mouse handling prevents a click. This does not disable the terminal's automatic detection of visible HTTP(S) URLs.

For a one-off session, use `PI_HYPERLINKS=0 pi` instead of changing settings.

### Remaining limitation

- [ ] Track upstream support for opening relative Markdown file links. Pi currently passes relative targets directly to OSC 8, without resolving the session directory or encoding an absolute `file://` URI. The visibility setting does not fix file opening. Reconsider `"auto"` only when destinations remain discoverable and local links open correctly.

No custom transformer is planned. The extension draft and its dependency were removed in favor of the setting.

### Evidence and terminal behavior

- Reproduction environment: Pi 0.87.1, Herdr 0.8.2, and Ghostty on macOS.
- Example session log: `~/Dev/jev/links-in-conversation.jsonl`.
- [Pi settings reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md): `terminal.hyperlinks` accepts `true`, `false`, or `"auto"`.
- [Pi environment variables](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/environment-variables.md): `PI_HYPERLINKS` accepts `1`, `0`, or `auto`.
- [Pi Markdown renderer](https://github.com/earendil-works/pi/blob/main/packages/tui/src/components/markdown.ts): the OSC 8 branch hides the target; the fallback prints it when it differs from the label.
- [Herdr issue #2284](https://github.com/ogulcancelik/herdr/issues/2284): Herdr handles Ctrl-click while mouse capture is active. On macOS, Shift-Cmd-click bypasses Herdr to Ghostty. The issue also records missing hover feedback for OSC 8 destinations. With this workaround, Ctrl-click applies to visible HTTP(S) URLs rather than hidden Markdown targets.



## Jev, Command completion

When I run commands in Pi:
!git status
!git push
!git s -c ...

I would like Jev to monitor and suggest next command.
There is already an example of this.

Oh a

## Create QR link skill

Create a skill that turns a URL into a QR code, so I can scan it with my phone and open the link there. The first use case was opening a newly created secret gist on my phone.

### What the agent did manually

1. Made sure `qrencode` was installed, and installed it with Homebrew if it was missing:
   ```bash
   command -v qrencode || brew install qrencode
   ```
2. Printed the QR code directly in the terminal, so I could scan it without opening a file:
   ```bash
   qrencode -t ANSIUTF8 -m 2 "<url>"
   ```
   - `-t ANSIUTF8` draws the code with Unicode block characters.
   - `-m 2` sets a 2-module quiet zone (the white border). A smaller margin than the default makes the code fit better in the terminal.
3. Also saved the QR code as a PNG, which works better if the terminal rendering does not scan:
   ```bash
   qrencode -o /tmp/gist-qr.png -s 10 "<url>"
   ```
   - `-s 10` makes each module 10 pixels.
   - The agent then read the PNG with the `read` tool so the image showed in the conversation. It can be opened with `open /tmp/gist-qr.png`.
4. Tried to check that the code decodes back to the URL with `zbarimg -q /tmp/gist-qr.png`. `zbarimg` was not installed, so this step was skipped and I had to check the result on my phone.
5. Reported the URL in plain text next to the QR code, and warned that anyone who scans the code can open the secret gist.

### Ideas for the skill

- Take the URL as input. If no URL is given, use the last URL in the conversation.
- Always print the terminal version first, then save a PNG as a fallback.
- Use a unique temp file (for example `mktemp -t qr.XXXXXX.png`) instead of a fixed path in `/tmp`.
- Check the result with `zbarimg` (from the `zbar` Homebrew package) when it is installed, and say clearly when the check was skipped.
- Warn when the URL points to private or secret content (secret gists, signed URLs, URLs with tokens in them).
- Maybe write it as a small script (like `q-pi`) instead of only a skill, because the steps never change.

## Handoff extension

Ideas from comparing other Pi handoff extensions (`agent/extensions/handoff/`).

- [ ] Replace separate DeepSeek generation with the active session model. See [the session-model handoff plan](docs/plans/2026-10-04-handoff-session-model-suggestion.md).

- [ ] Name the successor session. Add `--name "handoff: <goal>"` to the Pi arguments after `--` in `herdr agent start`, so `/resume` shows a readable name instead of the first prompt line.
- [ ] Carry the thinking level over. Add `--thinking ${pi.getThinkingLevel()}` next to `--model` in `herdr agent start`. Remove "thinking-level carry-over" from the README's "Not supported" list.
- [ ] Add timeouts to the `herdr` calls. `pi.exec` currently runs without a timeout, so a hung `herdr` blocks `/handoff` forever. Pass `{ timeout }` to `pi.exec`. Use a longer value for `agent start`, because it waits for Pi to start (other extensions use 10 s for most commands and up to 35 s for `agent start`).

### To look into

- [ ] Improve the generation prompt. Ideas from `@ssweens/pi-handoff`, `@tifan/pi-handoff`, and Matt Pocock's `handoff` skill: refer to existing plans, specs, and issues by path instead of copying them; remove secrets; keep exact file paths, function names, and error messages; use fixed sections (Goal, Constraints, Done, In progress, Decisions, Next steps); add a "Suggested skills" section. Not sure yet. Check that more structure does not make DeepSeek Flash output longer or less focused on the goal.
- [ ] Build the file list from tool calls instead of letting the model guess. `@ssweens/pi-handoff` collects `path` from `read`, `edit`, and `write` tool calls in the projected messages (about 30 lines). Needs more investigation: a full list of read files can bring back the irrelevant context that the handoff is meant to remove. Options: list only modified files, or give the list to the generator as input and let it select the relevant ones.
