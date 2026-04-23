# Git Guard: Commit Message Visualization

## Problem

When the agent runs `git commit -m "..."`, git-guard shows a `ctx.ui.select` dialog with the raw command string. The commit message is buried inside the full git command, making it hard to scan. For multi-line or long messages this is especially bad.

## Solution

Enhance the commit approval flow in `git-guard.ts` with three changes:

1. Parse the commit message out of the git command
2. Display it prominently in the approval dialog, separated from the raw command
3. Add an "Edit message" option that opens `ctx.ui.editor()` for interactive editing

## Implementation

### 1. Message Parser

Add `parseCommitMessage(command: string): string | null`.

Handles:
- `-m "message"` and `-m 'message'`
- `--message="message"` and `--message 'message'`
- `--message=unquoted`
- Multiple `-m` flags (concatenated with blank line separators, matching git behavior)

Returns `null` for commands using `-F`/`--file`, `-C`/`--reuse-message`, or unparseable quoting. Those fall back to existing behavior.

### 2. Formatted Approval Dialog

Replace the current `promptOrBlock` call for commits with a dedicated `promptCommitOrBlock` function.

The `ctx.ui.select` title uses `ctx.ui.theme` for formatting:

```
git commit requires approval

Message:
  fix: refactor auth module to use token-based validation

Command:
  git commit -m "fix: ..." path/to/file.ts
```

- "Message:" label and the message text use `theme.fg("accent", ...)` so it stands out
- "Command:" label and the raw command use `theme.fg("dim", ...)` so it recedes
- Fallback: if parsing fails, show the raw command only (current behavior)

### 3. Edit Option

The select dialog offers three choices instead of two:

1. **Yes, allow this once** - proceed with the command (mutates `event.input.command` if message was edited)
2. **Edit message** - open `ctx.ui.editor()` prefilled with the parsed message
3. **No, block it** - block the command (current behavior)

When the user picks "Edit message":
- Open `ctx.ui.editor("Edit commit message", currentMessage)`
- If the user submits edited text, reconstruct the git command via `replaceCommitMessage` and update the displayed message
- Re-display the approval dialog with the updated command and message
- If the user cancels the editor (returns `undefined`) or submits unchanged text, re-display the approval dialog unchanged

Must use `ctx.ui.editor()` (pi's built-in editor), not an external `$EDITOR`. Pi's bash tool cannot handle interactive programs (vim, nano, etc.) because it lacks TTY passthrough. Approaches like rewriting the command to `git commit --edit -F <tmpfile>` will hang pi.

### 4. Command Reconstruction

Add `replaceCommitMessage(command: string, newMessage: string): string`.

Strips all existing `-m`/`--message` arguments (quoted, unquoted, `=` form) and inserts a single `-m "..."` after `git commit`. Escapes backslashes and double quotes in the new message. Preserves all other flags and arguments.

### 5. Remove Commit from INTERACTIVE_GIT_PATTERNS

The old `INTERACTIVE_GIT_PATTERNS` entry for `git commit` hard-blocked commits without `-m`/`--message`/`-F` etc. before they could reach the approval dialog. Since `COMMIT_PATTERN` now handles all commits (with or without `-m`), remove the `git commit` entry from `INTERACTIVE_GIT_PATTERNS`. Commits without a parseable message fall through to the two-option fallback dialog.

## Scope

All changes stay in `git-guard.ts`. No new files or extensions needed.

### Functions to add
- `parseCommitMessage(command: string): string | null`
- `replaceCommitMessage(command: string, newMessage: string): string`
- `promptCommitOrBlock(event: BashToolCallEvent, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined>`

### Functions to modify
- The `tool_call` handler's `COMMIT_PATTERN` branch: call `promptCommitOrBlock(event, ctx)` instead of `promptOrBlock`
- `INTERACTIVE_GIT_PATTERNS`: remove the `git commit` entry

### Imports to add
- `BashToolCallEvent` type from `@mariozechner/pi-coding-agent`

## Event Mutation

When the user edits the commit message and approves, mutate `event.input.command` in place with the reconstructed command. The pi extension API supports this: "To modify arguments, mutate `event.input` in place instead." Returning `undefined` after mutation allows the bash tool to execute the updated command.

## Fallback Behavior

- Non-interactive mode (`!ctx.hasUI`): unchanged, blocks by default with the raw command in the reason
- Unparseable commit messages (no `-m`, uses `-F`/`-C`, etc.): falls back to current two-option dialog with raw command
- Editor cancel or unchanged text: returns to the approval dialog without changes
