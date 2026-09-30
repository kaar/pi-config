# Handoff Jev Model Selection Implementation Plan

## Overview

Replace automatic source-model inheritance with Jev-based selection of the successor model. Jev rates the generated handoff prompt for difficulty. Deterministic code maps that rating onto the session's scoped models, ordered by catalog output price.

**Status:** Design spec only. Implementation requires separate user approval. The design direction follows the completed investigation. No live classification requests are necessary to implement or test the selection logic.

## Current State Analysis

`/handoff` waits for the source agent to settle, then captures its model. A dedicated DeepSeek V4.1 Flash Nitro request generates the continuation prompt. The command opens a successor Pi session with the captured model, pastes the prompt, focuses the pane, and sends the external-editor shortcut.

The destination contains an unsent draft. Saving and closing the external editor does not submit it. The command leaves the source session and model unchanged.

The existing `BorderedLoader` covers generation only. Its completion guard prevents late responses from completing a cancelled handoff. Classification must extend this same cancellation boundary rather than start after the loader closes.

The previous plan cites Pi 0.87.1. The installed runtime inspected for this spec is 0.99.1. The extension package still pins Pi dependencies to 0.85.1, whose registry declarations lack classifier methods. Its existing typecheck passes, but the planned classifier calls require updated declarations.

## Desired End State

A successful handoff uses one difficulty score to select a successor from `ctx.scopedModels`. It does not normally inherit the source model. Source-model inheritance remains only as the selection fallback.

### User-visible behavior

1. The command waits for idle and captures the source model and scoped-model list for this handoff.
2. The existing generator produces a nonempty, self-contained prompt.
3. Inside the same loader, Jev rates that generated prompt before any call to `launchSuccessor`.
4. The loader closes after selection succeeds or falls back. The source shows the rating and selected model, or a fallback warning.
5. The existing launch sequence starts the successor with `--model <provider>/<id>` and transfers the unchanged prompt.
6. The external editor opens through the existing shortcut. Its edits return to an unsent draft.

Escape during generation or classification cancels the complete handoff. Cancellation creates no pane, changes no source draft, and emits only the existing cancellation notification.

Use a single loader label: `Generating handoff and selecting successor model...`. The public `BorderedLoader` has no label-update method. A second loader or private-field access is unnecessary.

After the loader closes, emit one selection notification before launch:

- Success, `info`: `Handoff: Jev difficulty 2.25/3 -> anthropic/claude-opus-5-5. Override with /model in the new session before submitting.`
- Fallback, `warning`: `Handoff: Jev selection unavailable (no scoped models). Using source model anthropic/claude-opus-5-5.`

Format a successful rating to two decimal places for display only. Use its full precision for selection. The provider-qualified model ID distinguishes models with identical names. A fallback shows a short reason, not an invented rating.

Keep the existing transfer and failure notifications. The selection notification reports the intended model, not successful pane creation. No selection notification appears after cancellation.

The user can still select `/model` in the destination before submitting the draft. There is no automatic model turn. Editor changes do not trigger another classification.

### Key Discoveries:

- The source-model capture and unconditional successor reference are at `agent/extensions/handoff/index.ts:246-253` and `:280`.
- Generation and the completion guard are at `agent/extensions/handoff/index.ts:92-150`. The nonempty text currently finishes the loader at `:143`.
- `launchSuccessor` already accepts a model reference at `agent/extensions/handoff/index.ts:171-188`. Selection needs no new Herdr command.
- The VM harness already mocks the loader and model registry at `agent/extensions/handoff/handoff.test.cjs:37-106`. Source-model inheritance tests are at `:232-252`.
- The configured 11 models appear in `agent/settings.json:19-31`. Pi resolves them, so the extension must not parse this file itself.
- Installed Pi's `dist/core/extensions/types.d.ts:228-232` defines `ctx.scopedModels` as a read-only snapshot resolved from `--models` or `enabledModels`. An empty list means no configured scope, not no available models.
- Installed Pi's `dist/core/model-registry.d.ts:44-47` exposes `getAvailableOfType`, `getModelOfType`, and `classify`. Classification accepts request options, including an abort signal.
- Installed Pi's `node_modules/@earendil-works/pi-ai/dist/types.d.ts:454-501` defines score criteria, the discriminated score answer, and classifier stop reasons.
- `agent/extensions/package.json:8-10` pins all three Pi packages to 0.85.1. Installed versions of those packages are 0.99.1.

Installed Pi paths in this document are relative to `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`.

## What We're NOT Doing

- No thinking-level selection or carry-over. Ignore `ScopedModel.thinkingLevel`. Pass no thinking flag. Destination Pi retains its normal startup behavior.
- No separate model list, thresholds, or handoff configuration. Reuse `ctx.scopedModels`, including Pi's session-specific scope.
- No codemode dependency or tool invocation. Extensions call `ctx.modelRegistry.classify()` directly. Codemode served only the earlier experiments.
- No direct model-choice question, capability table, provider preference, or subscription-cost calculation.
- No changes to the generator model, Nitro payload, compaction handling, external-editor ownership, or Herdr command sequence.
- No virtual model, per-turn routing, background classification, persistent score history, or source-session model changes.
- No confidence threshold, retry loop, alternative classifier provider, or automatic fallback after successor startup fails.
- No full-conversation classification, prompt truncation, additional summarization, or custom tokenizer.
- No source-side model picker, confirmation dialog, or retained “use selected model” mode.

## Implementation Approach

### Classifier request

After successful generation, resolve `ctx.modelRegistry.getModelOfType("classifier", "typesafe", "jev-latest")`. If it returns no model, use the captured source model.

Call `ctx.modelRegistry.classify(jev, context, { signal: loader.signal })`. Pi owns credential resolution, including `TYPESAFE_API_KEY`. A missing credential becomes a classification error and triggers fallback. A separate availability request is unnecessary.

Use the generated, trimmed prompt as the only state field. Do not include model names, prices, the source model, or the full conversation as additional state. Model names that already occur in the generated prompt remain unchanged.

The variant C request contract is:

```ts
{
  state: { prompt: generatedPrompt },
  questions: {
    difficulty: {
      type: "score",
      instructions: "Rate the difficulty of the next task requested in this handoff prompt. Use the context to understand the task. Rate the work that remains, not completed work or prompt length. Do not choose a model.",
      criteria: [
        "Trivial: A mechanical, localized change or simple factual response. The required action is explicit and needs almost no investigation or judgment.",
        "Routine: A familiar, bounded task with clear requirements. It needs ordinary implementation, documentation, or configuration work and straightforward verification.",
        "Hard: Substantial reasoning, investigation, or review. It involves several interacting parts, ambiguous requirements, non-obvious bugs, or meaningful design trade-offs.",
        "Very hard: Deep reasoning about subtle failures or architecture. It involves difficult concurrency, cross-cutting constraints, or substantial uncertainty with no straightforward solution."
      ]
    }
  }
}
```

The ordered criteria define levels 0 through 3. Jev returns a probability-weighted fractional score, not necessarily an integer. The wording above fixes the implementation rubric for this spec. Earlier measurements support the four-level approach, not exact outputs from this wording.

Accept only `stopReason === "stop"`, `answers.difficulty.type === "score"`, and a finite numeric `score`. Clamp finite scores to `[0, 3]`. A missing or malformed answer triggers fallback. Confidence does not affect the route or gate the handoff.

### Price-rank mapping

Use a small pure helper in `index.ts`. Its inputs are the captured scoped-model list and a numeric score. It returns the selected model, or no model for unusable inputs.

1. If the scoped list is empty, return no selection. Do not expand it to the whole catalog.
2. If the score is nonfinite, return no selection.
3. If any output price is missing, nonfinite, or negative, return no selection. Zero is a valid catalog price.
4. Copy the scoped entries. Sort by `entry.model.cost.output` ascending, preserving original list order on ties.
5. Clamp the score to `[0, 3]`.
6. Calculate `index = Math.round((score / 3) * (sorted.length - 1))`.
7. Return `sorted[index].model`.

The mapping is linear in rank, not dollars. Midpoints round toward the higher index. One candidate always selects that candidate. A scoped list with one candidate still receives the normal classification request and rating notification.

Use only the base `cost.output` field. Ignore input prices, cache prices, tiered prices, and thinking metadata. Do not mutate registry objects or the scoped array. Distinct provider entries remain distinct candidates, even when their model names match.

### Worked example: the user's 11 models

This snapshot uses the configured list order and runtime catalog metadata inspected during spec preparation. Prices are USD per million output tokens. These values are examples, not constants to embed in the extension.

| Rank | Provider/model | Output price | Rating interval |
| --- | --- | ---: | --- |
| 0 | `openrouter/deepseek/deepseek-v4.1-flash` | 0.396 | `[0, 0.15)` |
| 1 | `openrouter/deepseek/deepseek-v4-pro-0813` | 1.98 | `[0.15, 0.45)` |
| 2 | `github-copilot/claude-haiku-4.5` | 5 | `[0.45, 0.75)` |
| 3 | `github-copilot/gemini-3.5-flash` | 9 | `[0.75, 1.05)` |
| 4 | `github-copilot/claude-sonnet-5` | 10 | `[1.05, 1.35)` |
| 5 | `openai-codex/gpt-5.6-terra` | 12 | `[1.35, 1.65)` |
| 6 | `github-copilot/gpt-5.6-terra` | 12 | `[1.65, 1.95)` |
| 7 | `openai-codex/gpt-5.6-sol` | 20 | `[1.95, 2.25)` |
| 8 | `anthropic/claude-opus-5-5` | 20 | `[2.25, 2.55)` |
| 9 | `openai-codex/gpt-6-astra` | 50 | `[2.55, 2.85)` |
| 10 | `anthropic/claude-fable-5-1` | 50 | `[2.85, 3]` |

Ties preserve Codex Terra before Copilot Terra, Sol before Opus, and Astra before Fable. Consequently, a maximum rating selects Fable, not Opus or Astra.

Applying the formula to representative ratings from the earlier investigation gives:

| Earlier prompt or example | Rating | Calculation | Selected model |
| --- | ---: | --- | --- |
| Typo | 0.00 | `round(0.00 / 3 * 10) = 0` | DeepSeek V4.1 Flash |
| Neovim change | 0.46 | `round(0.46 / 3 * 10) = 2` | Copilot Haiku 4.5 |
| Small flag | 1.00 | `round(1.00 / 3 * 10) = 3` | Copilot Gemini 3.5 Flash |
| README task | 1.02 | `round(1.02 / 3 * 10) = 3` | Copilot Gemini 3.5 Flash |
| README task | 1.64 | `round(1.64 / 3 * 10) = 5` | Codex Terra |
| Review/implementation example | 1.79 | `round(1.79 / 3 * 10) = 6` | Copilot Terra |
| Hard anchor | 2.00 | `round(2.00 / 3 * 10) = 7` | Codex Sol |
| Review/implementation example | 2.25 | `round(2.25 / 3 * 10) = 8` | Opus 5.5 |
| Race/architecture task | 3.00 | `round(3.00 / 3 * 10) = 10` | Fable 5.1 |

These are deterministic mapping examples, not new classifier results. Different credentials, scope overrides, or catalog updates can change the resolved list and ranking.

### Integration and cancellation

Keep generation, classifier lookup, classification, and mapping inside the existing `ctx.ui.custom()` operation. Extend its successful result with the selected model reference and selection-notification data. Rename the internal operation and result to reflect preparation of the complete handoff.

Capture the source model and a copy of `ctx.scopedModels` after `waitForIdle()`, before generation. Later source-model switches cannot alter the fallback. Later scope changes cannot alter this invocation's candidates.

Retain the single `finish()` guard. Before classifier work and after each asynchronous boundary, inspect cancellation. A late generation result must not start a classifier call. A late classifier result must not emit notifications, select a fallback, or launch a pane after cancellation.

The existing `loader.signal` goes to both generation and classification. `stopReason === "aborted"` cancels the handoff. An exception after the loader signal aborts also cancels it, rather than taking the error fallback.

Keep notifications outside the asynchronous loader work. Only the command handler emits the returned selection notification and calls `launchSuccessor`. Pass the selected reference instead of the unconditional source reference. Do not call `pi.setModel()`.

### Failure boundaries

| Condition | Required behavior |
| --- | --- |
| Existing precondition fails, including no source model | Preserve the current error and stop before generation |
| Generator missing, generation error, or blank prompt | Preserve the current error. No selection, generation fallback, or pane |
| Escape during generation or classification | Cancel immediately. No selection notification or pane |
| Classifier reports `aborted` | Cancel, even if no explicit Escape was observed |
| Empty scoped list | Skip classifier work and use the captured source model |
| Invalid output-price metadata | Skip classifier work and use the captured source model |
| Jev missing from the catalog | Use the captured source model |
| Jev credential, network, provider, or context-limit error | Use the captured source model |
| Classifier lookup/call throws without cancellation | Use the captured source model |
| Missing answer, wrong answer type, or nonfinite score | Use the captured source model |
| Low confidence with a valid score | Use the normal price-rank mapping |
| Successor split/start/paste failure | Preserve existing prompt recovery. Do not try a second successor model |
| Focus or editor-shortcut failure | Preserve existing destination-draft recovery |

The captured source model can be outside the scoped list. Fallback preserves current behavior rather than selecting an arbitrary candidate. Selection errors do not discard the successfully generated prompt.

### Removed behavior

Remove the assumption that the source's selected model is the successor model. There is no existing “use selected model” picker to delete. The behavior to replace is the unconditional `modelRef` passed to `launchSuccessor`.

Update comments, README claims, and tests that promise source-model inheritance. Keep the source-model capture and its tests as fallback behavior. Keep prompt generation independent of both source and successor models.

## Alternative Approaches Considered

The completed investigation compared three variants over six real handoff prompts and four synthetic prompts, using `typesafe/jev-latest`.

- **A: Choose a model with prices and a least-expensive instruction.** It collapsed to the cheapest model. Rejected.
- **B: Choose among model names without prices.** Results were inconsistent and never selected Astra, Sol, or Fable. Rejected.
- **C: Score difficulty across four ordered criteria.** It produced coherent fractional ratings from 0.00 to 3.00. Selected.

Reported confidence was mostly 0.74–1.00. These experiments support the question shape. They do not establish better task outcomes or justify a confidence threshold.

A virtual-model router is unnecessary because handoff selects one startup model, not a model for each request. A separate TypeSafe SDK is unnecessary because Pi already provides classification and authentication.

## Phase 1: Align API Types and Add Deterministic Mapping

### Overview

Provide a typed, tested mapping helper without changing live handoff behavior.

### Changes Required:

#### 1. Pi development dependencies

**Files:** `agent/extensions/package.json`, `agent/extensions/package-lock.json`

**Changes:** Align `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` with the inspected 0.99.1 runtime. Regenerate the lockfile through npm. Do not hide missing APIs with `any` casts or copy classifier declarations locally.

This update is required for the classifier types, not a general dependency cleanup. If it exposes unrelated extension incompatibilities, report them before expanding the implementation scope.

#### 2. Pure mapping helper and tests

**Files:** `agent/extensions/handoff/index.ts`, `agent/extensions/handoff/handoff.test.cjs`

**Changes:** Add the price-rank helper and table-driven unit tests. Keep the helper in the existing extension file. The VM harness can expose it through a test-only assignment appended to the compiled source, without a production export.

### Success Criteria:

#### Automated Verification:

- [ ] Mapping tests pass: `node --test agent/extensions/handoff/handoff.test.cjs`.
- [ ] Updated Pi APIs typecheck: `npm --prefix agent/extensions run typecheck`.
- [ ] Whitespace check passes: `git diff --check`.
- [ ] Existing handoff tests still prove unchanged behavior before integration.

#### Manual Verification:

- [ ] The ranking, tie order, rounding, and 11-model examples match this spec.
- [ ] Dependency changes remain limited to the required Pi version alignment and resulting lockfile changes.

**Implementation Note:** Pause after automated verification for human review of Phase 1 before integration.

---

## Phase 2: Integrate Classification and Document the Workflow

### Overview

Make Jev selection the normal path while preserving cancellation, fallback, and destination editing.

### Changes Required:

#### 1. Handoff preparation and launch

**File:** `agent/extensions/handoff/index.ts`

**Changes:** Add the fixed difficulty question, classifier call, result checks, fallback result, and cancellation handling. Extend the loader operation and successful result. Replace source inheritance at the launch call. Emit the selection notification before launch.

#### 2. Classifier harness and integration tests

**File:** `agent/extensions/handoff/handoff.test.cjs`

**Changes:** Add scoped models with explicit output prices, a fake Jev model, registry lookup recording, and controllable classification results. Change successful-path expectations to use a selected model different from the source. Retain source inheritance assertions in explicit fallback tests.

#### 3. Usage and recovery documentation

**File:** `agent/extensions/handoff/README.md`

**Changes:** Describe the score, price ranking, TypeSafe credential, classification cancellation, fallback, and `/model` override. Distinguish selection fallback from the still-unsupported generation fallback. Replace the “same model” acceptance check. Retain the unsupported thinking-level carry-over note.

Include the new outbound-data boundary: the generated prompt goes to TypeSafe before destination review. State that editor changes do not cause reclassification.

### Success Criteria:

#### Automated Verification:

- [ ] All mapping and integration tests pass: `node --test agent/extensions/handoff/handoff.test.cjs`.
- [ ] All extension types pass: `npm --prefix agent/extensions run typecheck`.
- [ ] Whitespace check passes: `git diff --check`.
- [ ] Tests make no live model requests or Herdr calls.

#### Manual Verification:

- [ ] A live handoff shows a rating and launches the corresponding scoped model.
- [ ] Missing TypeSafe credentials produce a warning and a usable source-model successor draft.
- [ ] Escape during classification creates no pane and no late selection notification.
- [ ] The complete prompt reaches the external editor and returns to an unsent draft.
- [ ] The user can override the destination model before submission. No turn starts automatically.
- [ ] The source model, transcript, and scoped-model order remain unchanged.

**Implementation Note:** Request separate approval before paid model calls or live pane creation. Record unperformed live checks as pending, not passed.

---

## Testing Strategy

### Unit Tests:

Use synthetic model objects with explicit output prices. Include the 11-model snapshot as a fixed mapping fixture, not a dependency on the user's live catalog.

Cover empty and single-model lists, unsorted prices, all-equal prices, stable ties, zero prices, and invalid prices. Include score endpoints, clamping, and nonfinite scores. Include each rank and values immediately before, at, and after representative rounding boundaries. Freeze the input array and models to detect mutation. Different `thinkingLevel` values must not affect the result.

### Integration Tests:

Extend the existing `harness(options)` rather than adding a test framework or loading real providers:

- Add `ctx.scopedModels`, with candidates that differ from `ctx.model` and the generator.
- Mock `getModelOfType(type, provider, id)` and record its arguments.
- Mock `classify(model, context, requestOptions)` and record the complete request.
- Return a fixture with `stopReason: "stop"` and `answers.difficulty: { type: "score", score: 2.25, confidence: 0.9 }`.
- Provide options for missing Jev, error results, rejected promises, malformed answers, and deferred resolution.
- Reuse the existing fake `BorderedLoader` and its abort controller. No codemode or TypeSafe SDK mock is necessary.

Assert that classification receives exactly the generated prompt, one score question with four criteria, and the generation request's abort signal. No separate transcript or model roster belongs in classifier state.

Assert generation → classification completion → notification → pane creation ordering. A deferred classifier promise must prevent Herdr calls until it resolves. The normal success path must pass the mapped reference to `agent start`, without a thinking argument.

Exercise every fallback row in the failure table. Include source changes after capture, scope changes after capture, and a source outside the scope. Fallback must use the captured model and preserve the generated text.

Abort while classification is pending. Then resolve success, return an error, or reject the request. Each case must leave one cancellation notification and no pane. Also retain the late-generation-response test and assert that it starts no classifier request.

Existing notification-count assertions must account for the new pre-launch selection message. Cancellation still has only one notification. Existing transfer errors must remain the final stage-specific notification.

Retain tests for generator independence, reasoning-disabled generation, compaction, full Unicode/multiline transfer, ordered Herdr calls, editor shortcuts, and recovery. The harness must continue to prohibit Enter and automatic prompt submission.

### Manual Testing Steps:

1. After approval for live checks, reload the extension in Pi inside Herdr.
2. Run a handoff with the configured scope and TypeSafe credentials.
3. Compare the displayed rating, catalog order, and successor model with the mapping formula.
4. Save and close the external editor without submitting the draft.
5. Select another model in the destination and verify that no model turn starts before explicit submission.
6. Repeat with unavailable TypeSafe credentials to exercise fallback.
7. Cancel during classification and verify that no pane or late notification appears.
8. Record classification latency separately from generation and pane startup.

## Performance Considerations

The normal path adds one sequential classifier request after generation. Sorting eleven entries is negligible. No latency guarantee follows from the earlier experiments. Missing scope, invalid price metadata, or missing Jev skips the request.

The generated prompt is substantially smaller than the conversation and is the intended input for Jev's 32k per-question budget. Generation does not enforce that limit. A provider rejection follows the selection fallback, without truncating or regenerating the prompt.

## Caveats and Risks

- **Price is a rough capability proxy.** DeepSeek can be inexpensive and capable. This policy ranks price, not demonstrated task performance.
- **Catalog prices are not the user's bill.** Copilot subscription economics differ from catalog token prices. Input, caching, and long-context costs are outside the mapping.
- **Trivial tasks change model.** A rating of 0 selects DeepSeek V4.1 Flash in this snapshot. This differs from the user's manual Opus/Astra choices for trivial work.
- **Tie order is policy.** Equal prices still occupy separate ranks. Changes to scope order can change the selected provider or model.
- **Jev is nondeterministic.** The investigation observed probability jitter around ±0.08. This is not a guaranteed bound on score variation. Small changes near a rank boundary can change the route.
- **The rubric is not a capability benchmark.** High confidence does not prove suitability. The reviewed research establishes no published evidence that this handoff policy improves outcomes.
- **The alias and catalog can change.** `jev-latest` behavior and catalog prices can change without extension changes.
- **Prompt content controls the estimate.** Missing context, misleading text, or instructions inside the prompt can affect the rating. Selection is not a security decision.
- **Editor changes come later.** The classifier sees the generated prompt, not the final edited draft. `/model` remains the user's override.
- **TypeSafe receives additional data.** The generated prompt leaves the source process before editor review. This is separate from the existing OpenRouter generation request.
- **Availability can change after selection.** A stale credential or unavailable destination model can still cause startup or first-turn failure. Existing recovery remains authoritative.

## Migration Notes

No settings or session-data migration is required. `enabledModels` remains the sole configured candidate list. `--models` and runtime scope changes retain Pi's normal precedence. The extension never rewrites these settings.

The implementation updates the development dependencies to the inspected Pi 0.99.1 API baseline. The README must state that baseline. Supporting older classifier-less runtimes is outside this change.

After implementation, `/reload` activates the extension changes. Existing sessions and drafts need no conversion. Reverting the implementation commits and reloading restores unconditional source-model inheritance.

## Open Questions

None block implementation under this spec. The design chooses nearest-rank rounding, source-model fallback, and no confidence gate. Live outcome quality and added latency remain evaluation questions, not undefined implementation behavior.

Implementation and paid/live acceptance checks still require separate user approval.

## References

- [Previous handoff plan](2026-09-29-handoff-fast-generation-and-editor.md).
- [Handoff source](../../agent/extensions/handoff/index.ts), [test harness](../../agent/extensions/handoff/handoff.test.cjs), and [README](../../agent/extensions/handoff/README.md).
- [Codemode and Jev notes](../codemode-and-jev.md), especially the direct extension API and score answer contract.
- [Configured scope](../../agent/settings.json) and [extension dependencies](../../agent/extensions/package.json).
- Installed Pi 0.99.1: `docs/extensions.md`, `docs/tui.md`, `docs/models.md`, `docs/virtual-models.md`, and `examples/extensions/jev-router.ts`.
- Installed Pi declarations: `dist/core/model-registry.d.ts`, `dist/core/extensions/types.d.ts`, `dist/core/model-resolver.d.ts`, and `dist/modes/interactive/components/bordered-loader.d.ts`.
- Local research: `~/Dev/jev/docs/research/jev-pi-extensions.md`, `jev-pi-extensions-sources.md`, `jev-use-cases.md`, and `jev-documentation.md`.
- Investigation results supplied with this request: six real handoff prompts, four synthetic prompts, and variants A/B/C. This spec does not claim a fresh experiment.
