# Faster Handoff Generation and Destination Editing

## Status

Implementation and automated checks are complete. Live verification and latency measurements remain pending. No paid model calls or live pane creation occurred during implementation.

After the Phase 1 checkpoint, the user requested a model-only commit, followed by the remaining interaction changes. Source-review removal therefore belongs to Phase 2 in the final commit split.

- **Phase 1:** Dedicated generation model, committed as `ea3cdba` (`feat(handoff): use DeepSeek Flash Nitro for prompt generation`). Source review remained intact in this commit. All 26 tests passed.
- **Phase 2:** Source-review removal, destination focus, configured external-editor shortcut, and stage-specific recovery. All 32 tests passed.
- The extension package typecheck and `git diff --check` passed for both phases.

Usage, configuration requirements, recovery instructions, and the live checklist are in [the handoff README](../../agent/extensions/handoff/README.md).

## Goal

Generate handoff prompts independently of the implementation model. Remove the redundant source review. Focus the populated destination pane and invoke Pi's external editor. Preserve explicit submission: saving and closing the editor returns to an unsubmitted draft.

The source transcript, session, and model selection remain unchanged. The successor starts with the implementation model captured after `waitForIdle()`.

## Implemented Design

### Dedicated generation

The command resolves `openrouter/deepseek/deepseek-v4.1-flash` with `ctx.modelRegistry.find()`. It copies the base model and appends `:nitro` to the request-local ID. The registry model and global configuration remain unchanged.

Generation uses `ctx.modelRegistry.complete()` for Pi's normal credential lookup and cancellation. It retains the existing system prompt, branch serialization, fresh request session ID, and `cacheRetention: "none"`. Compacted context remains the latest summary plus retained and later entries.

The request-local `onPayload` hook replaces the reasoning object with `reasoning: { enabled: false }`. It does not merge effort settings or merely hide reasoning output. The implementation session's thinking level does not control generation.

A missing base model produces an actionable error before generation or pane creation. Cancellation, request failure, or blank output also creates no pane. There is no fallback generation model.

Nitro favors throughput and admits priority-tier endpoints, which can cost more. It does not guarantee a fixed completion time. No latency improvement is claimed without measurements.

### Destination editing

The loader factory captures `keybindings.getKeys("app.editor.external")[0]` from Pi's active keybindings manager. The successful generation result carries this key with the prompt. The default key is `ctrl+g`. Configured or disabled bindings take precedence.

The command transfers the generated text directly, without `ctx.ui.editor()` in the source. It awaits these Herdr operations in order:

```text
pane split --current --direction right --cwd <cwd> --no-focus
agent start <name> --kind pi --pane <id> -- --model <implementation-provider/model>
pane send-text <id> <generated-prompt>
agent focus <id>
agent send-keys <id> <external-editor-key>
```

`agent start` is the startup readiness boundary. The initial split remains unfocused. Focus moves only after a successful paste. `pane send-text` receives no `--` separator because Herdr treats it as literal text.

A disabled editor action skips key delivery but preserves transfer and focus. A rejected key produces a warning without another attempt. A successful key command confirms delivery, not editor startup.

Pi selects the editor from `externalEditor`, then `$VISUAL`, then `$EDITOR`, then its platform default. Pi owns its process, temporary file, terminal suspension, and return to the draft. GUI editors require their normal wait configuration.

Source and destination share local Pi configuration. Configuration changes during a handoff are outside the command's contract. Users reload Pi before a handoff after configuration changes.

### Failure boundaries

- **Before successful generation:** Report cancellation or failure. Create no pane and leave the source draft unchanged.
- **Split, startup, or paste failure:** Restore the generated prompt to the source editor. Report any known pane ID. Do not close panes automatically.
- **Focus failure after paste:** Leave the destination draft intact. Report the pane and manual recovery instructions. Do not send the shortcut.
- **Disabled binding or shortcut-delivery failure:** Leave the draft in the destination. Report partial success without a duplicate source draft.
- **Editor startup failure or cancellation:** Let destination Pi handle the result. Do not resend or submit the prompt.

## Scope Boundaries

The change adds no generation fallback, retry loop, sleep, readiness polling, or custom key parser. It adds no editor process, destination bootstrap extension, or global configuration change. It does not carry the source thinking level into the destination.

The command never sends Enter, submits a prompt, replaces the source session, or copies its transcript into a resumed session.

Throughput-only sorting was not selected because the user requested Nitro, including its priority-tier eligibility. A custom editor process was not selected because Pi already owns that workflow.

## Verification

### Automated checks

- [x] `node --test agent/extensions/handoff/handoff.test.cjs`: 32 tests pass.
- [x] `npm --prefix agent/extensions run typecheck` passes.
- [x] `git diff --check` passes.

The existing harness covers model independence, registry immutability, payload reasoning replacement, compaction, cancellation, and missing-model errors. It also covers absent source review, exact command order, awaited commands, default/rebound/disabled shortcuts, and separate transfer versus post-transfer recovery.

The harness checks complete long multiline, Unicode, and code-block arguments. It prohibits submission commands and permits only the configured external-editor key. Mocked CLI success cannot prove that destination Pi consumed the complete paste before the shortcut.

### Pending live acceptance

- [ ] Confirm Nitro generation with reasoning disabled and unchanged implementation models in both sessions.
- [ ] Confirm no source review and no pane after generation cancellation or OpenRouter failure.
- [ ] Confirm complete long multiline, Unicode, and code-block content, including final lines, in the external editor.
- [ ] Confirm focus moves only after the prompt arrives.
- [ ] Change a line, save, and close. Confirm the edited text returns to the destination draft.
- [ ] Close without changes. Confirm a usable draft remains and no model turn starts.
- [ ] Confirm no destination model turn starts before explicit Enter in Pi.
- [ ] Confirm supported rebinding after `/reload`, disabled binding behavior, and recovery with an unavailable editor command.
- [ ] Confirm the source remains usable with its original transcript and model, including after compaction.
- [ ] Compare at least three runs per generator on the same branch snapshot and goal. Require lower median generation time without missing critical facts. Measure generation separately from Pi startup and editor time.

Paid requests and live pane creation require separate agreement. They are not part of the automated test command.

## Migration

No configuration migration is required. The base model already appears in `agent/settings.json`. If the runtime catalog lacks it, run `pi update --models`, then reload Pi. Normal OpenRouter credentials must be available to the source process.

After extension changes, run `/reload`. Existing sessions and drafts require no conversion. Rollback consists of reverting the implementation commits and reloading Pi.

## References

- [Extension](../../agent/extensions/handoff/index.ts), [tests](../../agent/extensions/handoff/handoff.test.cjs), and [usage](../../agent/extensions/handoff/README.md).
- Pi 0.87.1 documentation and source under `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`: `docs/extensions.md`, `docs/tui.md`, `docs/keybindings.md`, `docs/models.md`, `dist/core/model-registry.d.ts`, and `dist/modes/interactive/interactive-mode.js`.
- Local Pi dependencies under `agent/extensions/node_modules/`: `@earendil-works/pi-ai/dist/api/openai-completions.js` and `@earendil-works/pi-tui/dist/keybindings.d.ts`.
- Herdr 0.9.1 documentation: `cli-reference.mdx` and `agent-automation.mdx` under `/Users/casparnettelbladt/.agents/skills/herdr-docs/herdr/docs/versions/0.9.1/website/src/content/docs/`.
- [OpenRouter Nitro](https://openrouter.ai/docs/guides/routing/model-variants/nitro), [reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), and [model metadata](https://openrouter.ai/api/v1/models), checked during design on 2026-09-29.
