# handoff

Continue the current work in a fresh Pi session in a new Herdr pane. The source session is not changed.

```text
/handoff implement phase one of the plan
```

## How it works

1. Waits for the source agent to be idle, then captures its model and a copy of `ctx.scopedModels`.
2. Generates a continuation prompt with `openrouter/deepseek/deepseek-v4.1-flash:nitro`. After compaction, the active branch is the latest summary plus the kept entries.
3. Sends the generated prompt to `typesafe/jev-latest` for a difficulty score. Code maps this score to a scoped model by output-price rank.
4. Shows the score and selected model, or a warning with the reason for the source-model fallback.
5. Transfers the unchanged prompt without a source review dialog. Escape during generation or classification cancels the handoff without a new pane.
6. Runs `herdr` (or `HERDR_BIN_PATH`) without a shell:
   - `pane split --current --direction right --cwd <cwd> --no-focus`
   - `agent start handoff-<base36 time> --kind pi --pane <id> -- --model <provider>/<id>`
   - `pane send-text <id> <prompt>`, which pastes the prompt as a draft without pressing Enter
   - `agent focus <id>`
   - `agent send-keys <id> <external-editor-key>`

Focus moves to the destination only after the paste succeeds. The command sends Pi's configured external-editor shortcut, which defaults to Ctrl+G. It does not wait for the editor to close. A successful key command confirms shortcut delivery, not that the editor opened.

Save and close the external editor to return the changed text to the destination Pi draft. To override the selected model, use `/model` before submission. Press Enter in Pi to start work. The command never submits the draft. Editor changes do not trigger another classification.

## Successor model selection

The API baseline is Pi 0.99.1. Earlier runtimes without classifier APIs are not supported.

Pi resolves the candidate list through `ctx.scopedModels`, using `enabledModels` or the session scope from `--models`. The extension does not read settings files or add another model list. Later source-model or scope changes do not change the captured selection inputs.

The source process needs TypeSafe credentials for automatic selection. Pi resolves these credentials, including `TYPESAFE_API_KEY`. The extension calls `ctx.modelRegistry.classify()` directly. It does not require codemode or a separate TypeSafe SDK.

Jev rates the remaining task against four ordered criteria: trivial, routine, hard, and very hard. It returns a fractional score from 0 to 3, not a model choice. Code clamps finite scores to this range and ignores confidence.

The extension sorts a copy of the scope by base `cost.output`, from lowest to highest. Equal prices retain their original scope order, and zero prices are valid. Distinct provider entries remain separate candidates. Input, cache, tiered prices, and `thinkingLevel` do not affect selection.

The selected index is `Math.round((score / 3) * (sorted.length - 1))`. This formula uses rank, not dollar distance. A single candidate still receives classification. JavaScript floating-point arithmetic applies: in the 11-model fixture, scores `0.15` and `1.65` select ranks 0 and 5. The notification rounds the score to two decimals for display only. Selection uses its full precision.

Catalog prices do not necessarily represent your bill or model capability. A different scope, tie order, or catalog update can change the selected model. The destination uses its normal startup thinking level. The handoff does not select or carry over a thinking level.

### Data sent before review

The generation request sends the conversation context and handoff goal to OpenRouter. The classification request then sends the generated, trimmed prompt to TypeSafe before destination review. That prompt is the only classifier state field. The extension adds no separate conversation, source model, candidate list, or prices to that state. Model names already in the prompt remain unchanged.

The command does not truncate the generated prompt to fit a classifier limit. A context-limit error uses the source-model fallback and preserves the prompt.

## Classification debug log

The extension appends selection records to `~/.pi/agent/logs/handoff-classifications.jsonl`, separate from the session transcript. The path follows `PI_CODING_AGENT_DIR` when set.

Each JSONL line contains:

- A timestamp, duration, source session ID and file, working directory, and source model.
- The exact classification request, including the generated prompt and difficulty rubric.
- The full classifier response, including the score, confidence, usage, and provider error message when available. Thrown errors appear in `error`.
- Candidate model IDs and output prices in scope order and sorted rank order.
- The selection outcome, chosen model, clamped score, zero-based rank, and mapping rule, or the fallback reason.

Jev returns a score, not a written explanation. The logged rubric, answer, and rank mapping show the evidence for the model choice. The logged selection describes the intended successor model, not successful pane creation.

Skipped classification records have a null request and response. Cancelled requests produce a record when the request settles, including any late response, without another notification or pane. Generation failures and cancellations before selection produce no classification record.

The file contains full prompts and can contain sensitive project information. The logger does not add credentials, headers, or environment variables. New log files use owner-only permissions (`0600`). This repository ignores the log file. The file grows until you delete or archive it manually. Log write failures go to stderr and do not block the handoff.

After `/reload`, new handoffs create records. To read the latest record:

```bash
tail -n 1 "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/logs/handoff-classifications.jsonl" | jq .
```

## External editor

Pi selects the editor from `externalEditor`, then `$VISUAL`, then `$EDITOR`, then its platform default. Pi owns the editor process, temporary file, and return to the draft. GUI editors need their normal wait configuration, such as `--wait`.

The command uses the first configured key for `app.editor.external`. It honors rebinding and skips shortcut delivery if the action has no binding. It does not substitute Ctrl+G or try another key after a failure.

Source and destination use the same local Pi configuration. After keybinding or editor configuration changes, run `/reload` before the handoff. Changes during a handoff are not supported.

## Failure recovery

- Escape during generation or classification creates no pane and leaves the source draft unchanged. Late results cannot start a successor or show selection notifications.
- An aborted model response also cancels the handoff. Generation failure creates no pane. There is no generation fallback.
- Missing scope or invalid output prices skip classification. Missing Jev, credential or request errors, and malformed scores also use the source-model fallback.
- Selection fallback shows a warning and uses the captured source model, even outside the scope. It preserves the generated prompt.
- A split, startup, or paste failure restores the generated prompt to the source editor. The error reports any known pane ID. The command does not close panes or try another successor model.
- A focus failure leaves the draft in the destination and prevents shortcut delivery. Select the reported pane and open Pi's external editor manually.
- A disabled shortcut or key-delivery failure leaves the draft in the focused destination. Review the draft there manually. The command does not restore a duplicate draft in the source.
- Pi handles editor startup failure or cancellation. The handoff command does not resend the prompt or submit it.

Not supported: thinking-level selection or carry-over, generation fallback, successor-startup fallback, other multiplexers, handoff-specific configuration, retries.

## Generation requirements

The source Pi process needs OpenRouter credentials and the base model `openrouter/deepseek/deepseek-v4.1-flash` in its model catalog. Normal Pi credential lookup applies, including `OPENROUTER_API_KEY`. If the catalog lacks the model, run `pi update --models`, then reload Pi.

The command copies the base model for this request and adds `:nitro` to its ID. It preserves the model metadata and leaves the registry and global configuration unchanged. The request sets `reasoning: { enabled: false }`, replacing reasoning effort settings rather than merely hiding reasoning output.

Nitro favors throughput and admits priority-tier endpoints, which can cost more. It does not guarantee a fixed generation time. The source and destination implementation models remain independent of this generation request.

After extension changes, run `/reload` in Pi.

## Herdr and Pi notes

Reference versions: Herdr 0.9.1 documentation and Pi 0.99.1 APIs. Live checks of the new workflow remain pending.

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

The test harness mocks generation, Jev classification, and Herdr commands. It covers the fixed rubric, price-rank mapping, fallbacks, cancellation, command order, and complete transfer arguments. It cannot prove terminal paste consumption or editor behavior. Automated checks make no live requests or Herdr calls.

Manual checks require separate approval for live requests and pane creation. All remain pending:

- [ ] Generation uses DeepSeek V4.1 Flash with Nitro and `reasoning: { enabled: false }`, without an effort setting.
- [ ] The source shows a difficulty score and selected model. The new pane uses the corresponding scoped model, not necessarily the source model.
- [ ] Missing TypeSafe credentials show a warning and produce a usable source-model successor draft.
- [ ] `/model` overrides the selection before submission, without an automatic model turn.
- [ ] The source review dialog never appears.
- [ ] The new pane opens on the right, in the same directory. Focus moves only after the prompt arrives.
- [ ] Pi's external editor opens with the complete prompt, including long multiline text, Unicode, code blocks, and the final lines.
- [ ] Changing a line, then saving and closing returns the changed text to the destination Pi draft.
- [ ] Closing without changes leaves a usable draft and starts no model turn.
- [ ] A supported rebound shortcut opens Pi's external editor after `/reload`.
- [ ] A disabled binding skips the editor and leaves the destination draft focused.
- [ ] An unavailable editor command leaves the destination draft usable.
- [ ] The draft contains the requested goal and relevant context. No destination model turn starts before explicit Enter.
- [ ] The source transcript, session, model, and scoped-model order remain unchanged.
- [ ] Works after `/compact`. Refuses outside Herdr.
- [ ] Escape during generation or classification creates no pane. Late results produce no selection notification.
- [ ] An OpenRouter failure reports an error without a fallback model or new pane.
- [ ] If the new Pi cannot resolve the implementation model, the prompt is restored and the error names the pane.
- [ ] Compare three runs with the previous generator on the same branch and goal. Check for lower median generation time without missing critical facts. Measure generation, classification, and Pi startup separately.
