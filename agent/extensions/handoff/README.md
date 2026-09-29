# handoff

Continue the current work in a fresh Pi session in a new Herdr pane. The source session is not changed.

```text
/handoff implement phase one of the plan
```

## How it works

1. Waits for the agent to be idle, then captures the implementation model as `<provider>/<id>` for the new session.
2. Generates a continuation prompt with `openrouter/deepseek/deepseek-v4.1-flash:nitro`, independently of the implementation model. After compaction, the active branch is the latest summary plus the kept entries.
3. Transfers the generated prompt directly, without a source review dialog. Escape during generation stops the handoff without a new pane.
4. Runs `herdr` (or `HERDR_BIN_PATH`) without a shell:
   - `pane split --current --direction right --cwd <cwd> --no-focus`
   - `agent start handoff-<base36 time> --kind pi --pane <id> -- --model <provider>/<id>`
   - `pane send-text <id> <prompt>`, which pastes the prompt as a draft without pressing Enter
   - `agent focus <id>`
   - `agent send-keys <id> <external-editor-key>`

Focus moves to the destination only after the paste succeeds. The command sends Pi's configured external-editor shortcut, which defaults to Ctrl+G. It does not wait for the editor to close. A successful key command confirms shortcut delivery, not that the editor opened.

Save and close the external editor to return the changed text to the destination Pi draft. Press Enter in Pi to start work. The command never submits the draft.

## External editor

Pi selects the editor from `externalEditor`, then `$VISUAL`, then `$EDITOR`, then its platform default. Pi owns the editor process, temporary file, and return to the draft. GUI editors need their normal wait configuration, such as `--wait`.

The command uses the first configured key for `app.editor.external`. It honors rebinding and skips shortcut delivery if the action has no binding. It does not substitute Ctrl+G or try another key after a failure.

Source and destination use the same local Pi configuration. After keybinding or editor configuration changes, run `/reload` before the handoff. Changes during a handoff are not supported.

## Failure recovery

- Generation cancellation or failure creates no pane and leaves the source draft unchanged. There is no fallback model.
- A split, startup, or paste failure restores the generated prompt to the source editor. The error reports any known pane ID. The command does not close panes automatically.
- A focus failure leaves the draft in the destination and prevents shortcut delivery. Select the reported pane and open Pi's external editor manually.
- A disabled shortcut or key-delivery failure leaves the draft in the focused destination. Review the draft there manually. The command does not restore a duplicate draft in the source.
- Pi handles editor startup failure or cancellation. The handoff command does not resend the prompt or submit it.

Not supported: thinking level carry-over, model fallback, other multiplexers, handoff-specific configuration, retries.

## Generation requirements

The source Pi process needs OpenRouter credentials and the base model `openrouter/deepseek/deepseek-v4.1-flash` in its model catalog. Normal Pi credential lookup applies, including `OPENROUTER_API_KEY`. If the catalog lacks the model, run `pi update --models`, then reload Pi.

The command copies the base model for this request and adds `:nitro` to its ID. It preserves the model metadata and leaves the registry and global configuration unchanged. The request sets `reasoning: { enabled: false }`, replacing reasoning effort settings rather than merely hiding reasoning output.

Nitro favors throughput and admits priority-tier endpoints, which can cost more. It does not guarantee a fixed generation time. The source and destination implementation models remain independent of this generation request.

After extension changes, run `/reload` in Pi.

## Herdr and Pi notes

Reference versions: Herdr 0.9.1 documentation and Pi 0.87.1 source. Live verification of the new workflow remains pending.

- Agent names must match `[a-z][a-z0-9_-]{0,31}`.
- `agent start` accepts `-- <pi args>` and returns once Pi is ready. No extra sleeps or readiness polling are necessary. `pane send-text` treats `--` as literal text, so never pass it there.
- `agent send-keys` checks that the agent still controls the destination pane. Unsupported key combinations produce a warning without another attempt.
- Herdr CLI errors are JSON on stderr with exit code 1.
- Pi's `--model` tries an exact `provider/id` match first, so IDs containing `/` or `:` are safe.
- Do not import `@earendil-works/pi-agent-core`. It cannot be resolved for typecheck. Derive `AgentMessage` from `convertToLlm` instead.

## Testing

```bash
node --test agent/extensions/handoff/handoff.test.cjs
npm --prefix agent/extensions run typecheck
git diff --check
```

The test harness mocks model requests and Herdr commands. It checks command order and complete transfer arguments, but cannot prove terminal paste consumption or editor behavior.

Manual checks (pending):

- [ ] Generation uses DeepSeek V4.1 Flash with Nitro and `reasoning: { enabled: false }`, without an effort setting.
- [ ] With a non-default implementation model, the new pane shows that same model.
- [ ] The source review dialog never appears.
- [ ] The new pane opens on the right, in the same directory. Focus moves only after the prompt arrives.
- [ ] Pi's external editor opens with the complete prompt, including long multiline text, Unicode, code blocks, and the final lines.
- [ ] Changing a line, then saving and closing returns the changed text to the destination Pi draft.
- [ ] Closing without changes leaves a usable draft and starts no model turn.
- [ ] A supported rebound shortcut opens Pi's external editor after `/reload`.
- [ ] A disabled binding skips the editor and leaves the destination draft focused.
- [ ] An unavailable editor command leaves the destination draft usable.
- [ ] The draft contains the requested goal and relevant context. No destination model turn starts before explicit Enter.
- [ ] The source transcript, session, and model remain unchanged.
- [ ] Works after `/compact`. Refuses outside Herdr.
- [ ] Escape during generation creates no pane.
- [ ] An OpenRouter failure reports an error without a fallback model or new pane.
- [ ] If the new Pi cannot resolve the implementation model, the prompt is restored and the error names the pane.
- [ ] Compare three runs with the previous generator on the same branch and goal. Check for lower median generation time without missing critical facts. Measure generation separately from Pi startup.
