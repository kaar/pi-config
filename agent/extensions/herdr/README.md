# Herdr session split

`/split` opens an independent copy of the saved session in a right-hand Herdr pane. `/split-tab` opens that copy in a new tab within the caller's current workspace. Both commands require interactive Pi inside Herdr.

Run `/reload` to load this extension from Pi's normal user-extension directory. In this repository, `~/.pi/agent` points to `agent/`. No settings change or installation script is needed.

```text
/split
/split Create a bug report for this issue
/split-tab
/split-tab Explore an alternative approach
```

## Conversation and task

The copy includes the entire saved session, including alternative branches. It retains messages, tool results, provider metadata, compaction, context edits, labels, and saved extension state. The child resumes at the last entry in the file, not necessarily your current position in `/tree`.

Both commands require an idle Pi session with a saved conversation. They start the child with `pi --fork <source-session-id>`. Pi resolves that ID and copies the saved history during startup, so changes to the file before startup are included. Launches can overlap. Navigation, session replacement, or shutdown after the command runs does not cancel a launch.

The child receives a unique session ID and a separate persisted session file in Pi's default session directory. It uses the working directory, selected model, and thinking level from when the command runs. The child header records the source session path. Pi handles labels and file permissions.

In-memory sessions and sessions stored in a custom `--session-dir` are not supported. The extension does not check for them. Pi exits in the child pane with `No session found`, and the launch fails at `herdr agent start`.

A task is the text after the command, with surrounding whitespace removed. After Herdr reports that Pi is ready, the extension submits that text once. Without a task, the child waits for input. The command returns after startup and optional submission, not after the task finishes.

Both commands generate Herdr agent names in the background, and `/split-tab` also renames its tab. Naming sends limited task text and a short excerpt of the last assistant response to OpenRouter, with silent failures.

## Source and resources

The extension leaves source focus, history, selected branch, model, thinking level, and editor draft unchanged. A successful launch shows no notification. The extension does not know the child session path because Pi creates it during startup. It adds no source message or model turn and opens no external editor.

The child discovers normal Pi resources in the same working directory. History inheritance does not copy process-local extension state, active tool selection, or the complete process environment. Command-line-only system prompts, credentials, and resource overrides are not copied.

Both sessions share files on disk. Separate conversation files are not separate checkouts. Coordinate edits yourself.

## Partial launch recovery

If a launch fails, the source shows an error notification. Created panes and any child files that Pi creates remain in place. The extension does not retry startup or task submission.

Inspect the destination before you send more input. A startup error or missing prompt acknowledgment does not prove that Pi stopped or missed the task. To inspect a known pane, use:

```bash
herdr agent get <pane-id>
herdr agent read <pane-id> --source recent-unwrapped --lines 120
```

If the child is running, use `/session` there to find its session path. To resume that child manually, run Pi in the original working directory:

```bash
pi --session "<child-session-path>" --session-dir "<child-session-directory>"
```

Do not open the same child file in two active Pi instances. There is no automatic result routing, completion monitoring, or conversation merge.

## Automated verification

The tests replace Herdr execution, the session manager, model requests, and UI notifications. They check guards, exact Herdr arguments, failure reporting, and background naming. They do not launch agents, fork sessions, or contact models.

```bash
node --test agent/extensions/herdr/herdr.test.cjs
npm --prefix agent/extensions run typecheck
node --test agent/extensions/handoff/handoff.test.cjs
git diff --check
```

Live checks still need to establish terminal focus, editor-draft preservation, startup recognition, task behavior, and visible names. Run them only with authorization.
