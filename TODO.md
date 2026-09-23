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

## Markdown links are not usable

When Pi outputs a Markdown file link such as `Created [the course refresh review](docs/research/course-refresh-review.md),`, the TUI only displays the label as underlined text. The target path is hidden and the link cannot be opened, so the user cannot tell which file was created.

This also affects ordinary `http` and `https` Markdown links. The session log at `~/Dev/jev/links-in-conversation.jsonl` contains examples where the rendered labels cannot be used to open the URLs.

Findings:

- Pi 0.87.1 detects Ghostty's OSC 8 support and deliberately renders a Markdown link as its label only. `terminal.hyperlinks: false` or `PI_HYPERLINKS=0` restores Pi's visible `label (target)` fallback.
- Pi passes a relative Markdown target directly to OSC 8. It does not resolve `docs/research/course-refresh-review.md` against the session working directory or convert it to a percent-encoded absolute `file://` URI, so local file links cannot reliably open.
- Herdr 0.8.2 captures mouse input. On macOS, use Ctrl-click for Herdr-handled OSC 8 and HTTP(S) links. Shift-Cmd-click bypasses Herdr to Ghostty. Herdr issue #2284 confirms this exact Ghostty usability problem and notes that the hover/target indication is not yet obvious.

Suggested solution:

- Short term: use Ctrl-click for HTTP(S) links in Herdr. Set `terminal.hyperlinks: false` when seeing the literal target is more useful than a hidden OSC 8 target.
- Proper fix: resolve existing relative Markdown file targets against Pi's session CWD and emit an encoded absolute `file://` URI. Retain a visible target fallback, or show it on hover, so the destination is never opaque.
- A local Pi extension could use `registerMarkdownTransformer()` to rewrite existing relative file links into absolute `file://` links and include the path in the visible label until Pi supports this natively.
