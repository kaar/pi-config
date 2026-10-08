# Herdr session split

`/split` opens an independent copy of the active conversation in a right-hand Herdr pane. `/split-tab` opens that copy in a new tab within the caller's current workspace. Both commands require interactive Pi inside Herdr.

Run `/reload` to load this extension from Pi's normal user-extension directory. In this repository, `~/.pi/agent` points to `agent/`. No settings change or installation script is needed.

```text
/split
/split Create a bug report for this issue
/split-tab
/split-tab Explore an alternative approach
```

## Conversation and task

The copy includes the live active branch through its latest entry. It retains messages, tool results, provider metadata, compaction, context edits, and branch-local state. It excludes abandoned branches.

Pi waits for the source to finish its current work before it captures history. Navigation, session replacement, or shutdown during that wait stops the request. Only one split launch can run at a time in this extension runtime.

The child receives a unique session ID and a separate persisted session file. It uses the source working directory, selected model, thinking level, and session directory at capture time. An in-memory source uses Pi's normal persistent storage for that working directory. The child header records the source session path when one exists.

A task is the text after the command, with surrounding whitespace removed. After Herdr reports that Pi is ready, the extension submits that text once. Without a task, the child waits for input. The command returns after startup and optional submission, not after the task finishes.

## Source and resources

The extension leaves source focus, history, selected branch, model, thinking level, and editor draft unchanged. It reports the destination pane ID and child session path through a source UI notification. It adds no source message or model turn and opens no external editor.

The child discovers normal Pi resources in the same working directory. History inheritance does not copy process-local extension state, active tool selection, or the complete process environment. Command-line-only system prompts, credentials, and resource overrides are not copied.

Both sessions share files on disk. Separate conversation files are not separate checkouts. Coordinate edits yourself.

## Partial launch recovery

If a launch fails, the notification includes any known pane ID and child session path. Created panes and persisted child files remain in place. The extension does not retry startup or task submission.

Inspect the destination before you send more input. A startup error or missing prompt acknowledgment does not prove that Pi stopped or missed the task. To inspect a known pane, use:

```bash
herdr agent get <pane-id>
herdr agent read <pane-id> --source recent-unwrapped --lines 120
```

To resume the child manually, run Pi in the original working directory:

```bash
pi --session "<child-session-path>" --session-dir "<child-session-directory>"
```

Do not open the same child file in two active Pi instances. There is no automatic result routing, completion monitoring, or conversation merge.

## Automated verification

The tests use fabricated sessions and the installed Pi 1.1.0 session implementation. They replace Herdr execution and UI notifications. They do not launch agents or contact models.

```bash
node --test agent/extensions/herdr/herdr.test.cjs
npm --prefix agent/extensions run typecheck
node --test agent/extensions/handoff/handoff.test.cjs
git diff --check
```

Live checks still need to establish terminal focus, editor-draft preservation, startup recognition, and task behavior. Run them only with authorization.
