# Git Guard: Commit Message Visualization

## Problem

When the agent runs `git commit -m "..."`, git-guard shows a `ctx.ui.select` dialog with the raw command string. The commit message is buried inside the full git command, making it hard to scan. For multi-line or long messages this is especially bad.

## Solution

Enhance the commit approval flow in `git-guard.ts` with three changes:

1. Parse the commit message out of the git command
2. Display it prominently in the approval dialog, separated from the raw command
3. Add an "Edit message" option that opens `$EDITOR` (or git's configured editor) for interactive editing

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
2. **Edit message** - open the user's editor for interactive editing
3. **No, block it** - block the command (current behavior)

When the user picks "Edit message":
- Resolve the editor command using `resolveEditor()` (see below)
- Write the current commit message to a temp file via `node:os` `tmpdir()` and `node:fs` `writeFileSync`
- Use `ctx.ui.custom()` to suspend the TUI and spawn the editor with full terminal access (same pattern as `interactive-shell.ts`)
- Read the temp file back after the editor exits, clean up the temp file
- If the message changed, reconstruct the git command via `replaceCommitMessage` and update the displayed message
- Re-display the approval dialog with the updated command and message
- If the editor exits non-zero or the message is unchanged, re-display the approval dialog unchanged

#### Editor Resolution

Add `resolveEditor(): string` that checks the following in order (matching git's own behavior):

1. `$GIT_EDITOR` environment variable
2. `git config core.editor` (via `spawnSync`)
3. `$VISUAL` environment variable
4. `$EDITOR` environment variable
5. Fall back to `"vi"`

#### TUI Suspension Pattern

Use `ctx.ui.custom()` to get TUI access, following the pattern from `interactive-shell.ts`:

```typescript
const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
  tui.stop();
  process.stdout.write("\x1b[2J\x1b[H");

  const result = spawnSync(editorCmd, editorArgs, {
    stdio: "inherit",
    env: process.env,
  });

  tui.start();
  tui.requestRender(true);
  done(result.status);
  return { render: () => [], invalidate: () => {} };
});
```

This suspends the TUI, gives the editor full terminal control, then restores the TUI when the editor exits. The editor command should be split into program and arguments using a simple shell-word split (handles cases like `"code --wait"`).

#### Temp File

Use a descriptive filename so the editor shows something meaningful in its title bar:

```typescript
const tmpFile = join(tmpdir(), `pi-commit-msg-${Date.now()}.txt`);
writeFileSync(tmpFile, currentMessage);
// ... spawn editor ...
const edited = readFileSync(tmpFile, "utf-8");
unlinkSync(tmpFile);
```

Wrap the spawn and read in a try/finally to ensure cleanup.

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
- `resolveEditor(): string`
- `openEditorForMessage(message: string, ctx: ExtensionContext): Promise<string | null>` (handles temp file, TUI suspension, cleanup; returns edited message or `null` on failure/no change)
- `promptCommitOrBlock(event: BashToolCallEvent, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined>`

### Functions to modify
- The `tool_call` handler's `COMMIT_PATTERN` branch: call `promptCommitOrBlock(event, ctx)` instead of `promptOrBlock`
- `INTERACTIVE_GIT_PATTERNS`: remove the `git commit` entry

### Imports to add
- `BashToolCallEvent` type from `@mariozechner/pi-coding-agent`
- `spawnSync` from `node:child_process`
- `writeFileSync`, `readFileSync`, `unlinkSync` from `node:fs`
- `tmpdir` from `node:os`
- `join` from `node:path`

## Event Mutation

When the user edits the commit message and approves, mutate `event.input.command` in place with the reconstructed command. The pi extension API supports this: "To modify arguments, mutate `event.input` in place instead." Returning `undefined` after mutation allows the bash tool to execute the updated command.

## Fallback Behavior

- Non-interactive mode (`!ctx.hasUI`): unchanged, blocks by default with the raw command in the reason
- Unparseable commit messages (no `-m`, uses `-F`/`-C`, etc.): falls back to current two-option dialog with raw command
- Editor exits non-zero or unchanged text: returns to the approval dialog without changes
- No `ctx.hasUI`: cannot use `ctx.ui.custom()`, so the edit option is not available (two-option dialog only)
