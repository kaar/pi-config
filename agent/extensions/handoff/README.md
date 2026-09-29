# handoff

Continue the current work in a fresh Pi session in a new Herdr pane. The source session is not changed.

```text
/handoff implement phase one of the plan
```

## How it works

1. Waits for the agent to be idle, then captures the current model as `<provider>/<id>`.
2. Generates a continuation prompt from the active branch with that model. After compaction, the branch is the latest summary plus the kept entries.
3. Opens the prompt in an editor for review. Cancelling the loader or editor stops with no pane created.
4. Runs `herdr` (or `HERDR_BIN_PATH`) without a shell:
   - `pane split --current --direction right --cwd <cwd> --no-focus`
   - `agent start handoff-<base36 time> --kind pi --pane <id> -- --model <provider>/<id>`
   - `pane send-text <id> <prompt>`, which pastes the prompt as a draft without pressing Enter

If the launch fails, the prompt is restored to the source editor and the error says which pane (if any) was created. The pane is not closed automatically.

Not supported: thinking level carry-over, model fallback, other multiplexers, config, retries.

## Herdr and Pi notes

Verified with Herdr 0.9.1 and Pi 0.87.1:

- Agent names must match `[a-z][a-z0-9_-]{0,31}`.
- `agent start` accepts `-- <pi args>` and returns once Pi is ready (about 3s). `pane send-text` treats `--` as literal text, so never pass it there.
- Herdr CLI errors are JSON on stderr with exit code 1.
- Pi's `--model` tries an exact `provider/id` match first, so IDs containing `/` or `:` are safe.
- Do not import `@earendil-works/pi-agent-core`. It cannot be resolved for typecheck. Derive `AgentMessage` from `convertToLlm` instead.

## Testing

```bash
node --test agent/extensions/handoff/handoff.test.cjs
npm --prefix agent/extensions run typecheck
```

Manual checks:

- [ ] With a non-default model, the new pane shows the same model.
- [ ] The new pane opens unfocused on the right, in the same directory.
- [ ] The prompt arrives as an unsubmitted draft, and the source session is unchanged.
- [ ] Works after `/compact`. Refuses outside Herdr.
- [ ] Cancelling the loader or editor creates no pane.
- [ ] If the new Pi cannot resolve the model, the prompt is restored and the error names the pane.
