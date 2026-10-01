# handoff

Continue the current work in a fresh Pi session in a new Herdr pane. The source session is not changed.

```text
/handoff implement phase one of the plan
```

## How it works

1. Waits for the source agent to be idle, then captures its model.
2. Generates a continuation prompt with `openrouter/deepseek/deepseek-v4.1-flash` behind a cancellable loader. The conversation comes from Pi's session projection, so after compaction it is the latest summary plus the kept entries.
3. Runs `herdr` (or `HERDR_BIN_PATH`) without a shell:
   - `pane split --current --direction right --cwd <cwd> --no-focus`
   - `agent start handoff-<base36 time> --kind pi --pane <id> -- --model <provider>/<id>`
   - `pane send-text <id> <prompt>`, which pastes the prompt as a draft without pressing Enter
   - `agent focus <id>`
   - `agent send-keys <id> ctrl+g`
4. Reports the destination pane in the source.

The destination uses the source model. To use another model, run `/model` in the destination before submission. Focus moves to the destination only after the paste succeeds. The command does not wait for the editor to close. A successful key command confirms shortcut delivery, not that the editor opened.

Save and close the external editor to return the changed text to the destination Pi draft. Press Enter in Pi to start work. The command never submits the draft.

## External editor

Pi selects the editor from `externalEditor`, then `$VISUAL`, then `$EDITOR`, then its platform default. Pi owns the editor process, temporary file, and return to the draft. GUI editors need their normal wait configuration, such as `--wait`.

The command always sends Ctrl+G, Pi's default for `app.editor.external`. It does not read your keybindings. If you rebind or disable that action, open the editor in the destination yourself.

Source and destination use the same local Pi configuration. After editor configuration changes, run `/reload` before the handoff.

## Failure recovery

- Escape during generation cancels the handoff. No pane is created and the source draft is unchanged.
- A generation failure reports an error. No pane is created. There is no generation fallback.
- A failure in any Herdr command reports an error and leaves the source editor unchanged. After a successful split, the error includes the destination pane ID. The command does not close panes it created.
- Pi handles editor startup failure or cancellation. The handoff command does not resend the prompt or submit it.

Not supported: successor model selection, thinking-level carry-over, generation fallback, other multiplexers, handoff-specific configuration, retries.

## Generation requirements

The source Pi process needs OpenRouter credentials and the model `openrouter/deepseek/deepseek-v4.1-flash` in its model catalog. Normal Pi credential lookup applies, including `OPENROUTER_API_KEY`. If the catalog lacks the model, run `pi update --models`, then reload Pi.

The request sets `reasoning: { enabled: false }`, replacing reasoning effort settings rather than merely hiding reasoning output. The request sends the conversation context and handoff goal to OpenRouter.

After extension changes, run `/reload` in Pi.

## Herdr and Pi notes

Reference versions: Herdr 0.9.1 documentation and Pi 0.99.1 APIs.

- Agent names must match `[a-z][a-z0-9_-]{0,31}`.
- `agent start` accepts `-- <pi args>` and returns once Pi is ready. No extra sleeps or readiness polling are necessary. `pane send-text` treats `--` as literal text, so never pass it there.
- `agent send-keys` checks that the agent still controls the destination pane.
- Herdr CLI errors are JSON on stderr with exit code 1.
- Pi's `--model` tries an exact `provider/id` match first, so IDs containing `/` or `:` are safe.

## Testing

```bash
node --test agent/extensions/handoff/handoff.test.cjs
npm --prefix agent/extensions run typecheck
git diff --check
```

The test harness mocks generation and Herdr commands. It cannot prove terminal paste consumption or editor behavior. Automated checks make no live requests or Herdr calls.

Manual checks require live requests and pane creation:

- [ ] Generation uses DeepSeek V4.1 Flash with `reasoning: { enabled: false }`.
- [ ] The new pane opens on the right, in the same directory, with the source model. Focus moves only after the prompt arrives.
- [ ] Pi's external editor opens with the complete prompt, including long multiline text, Unicode, code blocks, and the final lines.
- [ ] Changing a line, then saving and closing returns the changed text to the destination Pi draft.
- [ ] The draft contains the requested goal and relevant context. No destination model turn starts before explicit Enter.
- [ ] The source transcript, session, and model remain unchanged.
- [ ] Works after `/compact`. Refuses outside Herdr.
- [ ] Escape during generation creates no pane.
- [ ] An OpenRouter failure reports an error without a new pane.
- [ ] If the new Pi cannot resolve the model, the command reports an error and leaves the source editor unchanged.
