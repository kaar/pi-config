# Herdr commands

`/herdr-fork [task]` copies the saved session into a new Herdr tab. It submits the optional task after Pi starts. Without a task, Pi waits for input.

`/herdr-handoff [goal]` starts a fresh Pi session in a new tab. It generates a continuation prompt from the current conversation and goal, then submits it automatically. Without a goal, it preserves context and asks Pi to wait for instructions.

```text
/herdr-fork
/herdr-fork Create a bug report for this issue
/herdr-handoff Implement phase one of the plan
```

Both commands require interactive Pi inside Herdr and an idle source session. They keep the current workspace, directory, model, and thinking level. Source history, editor draft, and focus stay unchanged. Run `/reload` to load the extension.

## Limits and generation

Fork copies the saved session at startup, including alternative branches. It resumes at the last saved entry, not necessarily your current `/tree` position. In-memory sessions and custom `--session-dir` paths are unsupported.

Handoff reads the conversation after startup, including compaction summaries and retained messages. It sends that conversation and goal to OpenRouter. Both commands generate tab names through OpenRouter in the background.

Generation requires OpenRouter credentials (such as `OPENROUTER_API_KEY`) and `openrouter/deepseek/deepseek-v4.1-flash` in Pi's model catalog. If the model is missing, run `pi update --models`, then reload Pi.

Fork returns after the task is submitted. Handoff returns after the generated prompt is submitted, so it can take up to a minute. Naming continues in the background after either command returns. Neither command waits for destination work to finish. Sessions share files on disk, not separate checkouts. Coordinate edits yourself. Results are not returned or merged automatically.

## Failures

Launch, generation, and submission errors show an error notification. Naming errors show a warning and leave the placeholder agent name (`fork-<id>` or `handoff-<id>`). Failed launches and failed submissions leave created tabs in place. Nothing retries automatically.

Before resending a task, inspect the destination. A failed acknowledgment does not prove that delivery failed. Error notifications do not include the destination pane. Find it with `herdr agent list`, then inspect it.

```bash
herdr agent list
herdr agent get <pane-id>
herdr agent read <pane-id> --source recent-unwrapped --lines 120
```

## Tests

Run from the repository root. These tests make no live Herdr calls or model requests.

```bash
node --test agent/extensions/herdr/*.test.cjs
npm --prefix agent/extensions run typecheck
git diff --check
```
