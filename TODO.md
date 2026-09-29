# TODO

## Sharing Skills

I currently have duplicated skills both in Claude & PI.

Here I have skills under `~/.pi/agent/skills` and for Claude under `~/.claude/skills`

It would be possible to also store all the skills under `~/.agents/skills/` so that Claude and PI can share them.

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
