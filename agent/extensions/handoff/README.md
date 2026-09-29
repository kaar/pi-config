# handoff

Continue the current work in a fresh Pi session in a new Herdr pane. The source session is not changed.

```text
/handoff implement phase one of the plan
```

## How it works

1. Waits for the agent to be idle, then captures the implementation model as `<provider>/<id>` for the new session.
2. Generates a continuation prompt with `openrouter/deepseek/deepseek-v4.1-flash:nitro`, independently of the implementation model. After compaction, the active branch is the latest summary plus the kept entries.
3. Opens the prompt in an editor for review. Cancelling the loader or editor stops with no pane created.
4. Runs `herdr` (or `HERDR_BIN_PATH`) without a shell:
   - `pane split --current --direction right --cwd <cwd> --no-focus`
   - `agent start handoff-<base36 time> --kind pi --pane <id> -- --model <provider>/<id>`
   - `pane send-text <id> <prompt>`, which pastes the prompt as a draft without pressing Enter

The destination remains unfocused. Select its pane to review and edit the draft. Press Enter there to start work. The command never submits the draft.

If generation fails, the command reports the error without a new pane or a fallback model. If the split, startup, or paste fails, the command restores the reviewed prompt to the source editor. The error reports any known pane ID. The command does not close panes automatically.

Not supported: thinking level carry-over, model fallback, other multiplexers, handoff-specific configuration, retries.

## Generation requirements

The source Pi process needs OpenRouter credentials and the base model `openrouter/deepseek/deepseek-v4.1-flash` in its model catalog. Normal Pi credential lookup applies, including `OPENROUTER_API_KEY`. If the catalog lacks the model, run `pi update --models`, then reload Pi.

The command copies the base model for this request and adds `:nitro` to its ID. It preserves the model metadata and leaves the registry and global configuration unchanged. The request sets `reasoning: { enabled: false }`, replacing reasoning effort settings rather than merely hiding reasoning output.

Nitro favors throughput and admits priority-tier endpoints, which can cost more. It does not guarantee a fixed generation time. The source and destination implementation models remain independent of this generation request.

After extension changes, run `/reload` in Pi.

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

- [ ] Generation uses DeepSeek V4.1 Flash with Nitro and `reasoning: { enabled: false }`, without an effort setting.
- [ ] With a non-default implementation model, the new pane shows that same model.
- [ ] The new pane opens unfocused on the right, in the same directory.
- [ ] The reviewed prompt arrives as an unsubmitted draft.
- [ ] The draft contains the requested goal and relevant context. No destination model turn starts before explicit Enter.
- [ ] The source transcript, session, and model remain unchanged.
- [ ] Works after `/compact`. Refuses outside Herdr.
- [ ] Cancelling the loader or editor creates no pane.
- [ ] An OpenRouter failure reports an error without a fallback model or new pane.
- [ ] If the new Pi cannot resolve the implementation model, the prompt is restored and the error names the pane.
- [ ] Compare three runs with the previous generator on the same branch and goal. Check for lower median generation time without missing critical facts. Measure generation separately from Pi startup.
