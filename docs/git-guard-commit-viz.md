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

`parseCommitMessage(command: string): string | null`

Handles:
- `-m "message"` and `-m 'message'`
- `--message="message"` and `--message 'message'`
- `--message=unquoted`
- Multiple `-m` flags (concatenated with blank line separators, matching git behavior)

Returns `null` for commands using `-F`/`--file`, `-C`/`--reuse-message`, or unparseable quoting. Those fall back to existing behavior.

### 2. Formatted Approval Dialog

`promptCommitOrBlock` replaces the `promptOrBlock` call for commits.

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

The dialog loop uses `while (true)` so the user can edit multiple times before approving or blocking.

#### Editor Resolution

`resolveEditor(): string` checks the following in order (matching git's own behavior):

1. `$GIT_EDITOR` environment variable
2. `git config core.editor` (via `spawnSync`)
3. `$VISUAL` environment variable
4. `$EDITOR` environment variable
5. Fall back to `"vi"`

#### TUI Suspension Pattern

Use `ctx.ui.custom()` to get TUI access, following the pattern from `interactive-shell.ts`.

The editor must be spawned through a shell (`$SHELL -c "editor 'tmpfile'"`) rather than directly via `spawnSync(program, args)`. Direct spawning fails silently for editors that rely on shell PATH resolution, aliases, or complex command strings like `"code --wait"`. The shell-based approach handles all of these cases.

```typescript
const shell = process.env.SHELL || "/bin/sh";
const escapedPath = tmpFile.replace(/'/g, "'\\''");
const fullCommand = `${editorCmd} '${escapedPath}'`;

const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
  tui.stop();
  process.stdout.write("\x1b[2J\x1b[H");

  const result = spawnSync(shell, ["-c", fullCommand], {
    stdio: "inherit",
    env: process.env,
  });

  tui.start();
  tui.requestRender(true);
  done(result.status);
  return { render: () => [], invalidate: () => {} };
});
```

The temp file path is shell-escaped using single-quote wrapping with interior quote escaping (`'\\''`).

#### Temp File

Use a descriptive filename so the editor shows something meaningful in its title bar:

```typescript
const tmpFile = join(tmpdir(), `pi-commit-msg-${Date.now()}.txt`);
```

Wrap the spawn and read in a try/finally to ensure cleanup.

### 4. Command Reconstruction

`replaceCommitMessage(command: string, newMessage: string): string`

Strips all existing `-m`/`--message` arguments (quoted, unquoted, `=` form) and inserts a single `-m "..."` after `git commit`. Escapes backslashes and double quotes in the new message. Preserves all other flags and arguments.

### 5. Interactive Commit Guarding

The old `INTERACTIVE_GIT_PATTERNS` entry for `git commit` was removed since `COMMIT_PATTERN` now handles all commits. However, interactive commits (those without any message source flag) must still be hard-blocked to prevent the agent from hanging on an editor prompt.

This is handled inside `promptCommitOrBlock`: when `parseCommitMessage` returns `null`, check whether the command contains any message source flag (`-m`, `--message`, `-F`, `--file`, `-C`, `--reuse-message`, `--no-edit`). If none are present, hard-block with a descriptive reason. If a flag is present but unparseable (e.g. `-F`, `-C`), fall back to the two-option prompt dialog.

## Scope

All changes stay in `git-guard.ts`. No new files or extensions needed.

### Functions added (module-level)
- `parseCommitMessage(command: string): string | null`
- `replaceCommitMessage(command: string, newMessage: string): string`
- `resolveEditor(): string`
- `openEditorForMessage(message: string, ctx: ExtensionContext): Promise<string | null>` (handles temp file, TUI suspension, cleanup; returns edited message or `null` on failure/no change)

### Functions added (extension-scoped, inside `export default`)
- `promptCommitOrBlock(event: BashToolCallEvent, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined>`

### Functions modified
- The `tool_call` handler's `COMMIT_PATTERN` branch: calls `promptCommitOrBlock(event, ctx)` instead of `promptOrBlock`

### Constants modified
- `INTERACTIVE_GIT_PATTERNS`: removed the `git commit` entry (now handled by `promptCommitOrBlock`)

### Imports added
- `BashToolCallEvent` type from `@mariozechner/pi-coding-agent`
- `spawnSync` from `node:child_process`
- `writeFileSync`, `readFileSync`, `unlinkSync` from `node:fs`
- `tmpdir` from `node:os`
- `join` from `node:path`

## Event Mutation

When the user edits the commit message and approves, mutate `event.input.command` in place with the reconstructed command. The pi extension API supports this: "To modify arguments, mutate `event.input` in place instead." Returning `undefined` after mutation allows the bash tool to execute the updated command.

## Fallback Behavior

- Non-interactive mode (`!ctx.hasUI`): blocks by default with the raw command in the reason
- Interactive commits (no message source flag): hard-blocked to prevent editor hangs
- Unparseable commit messages (uses `-F`/`-C`/etc.): falls back to two-option dialog with raw command
- Editor exits non-zero or unchanged text: returns to the approval dialog without changes
- No `ctx.hasUI`: cannot use `ctx.ui.custom()`, so the edit option is not available
