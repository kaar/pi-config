# Session-Model Handoff Implementation Suggestion

## Overview

Replace the separate DeepSeek request with a normal agent turn in the source session. The active model writes the continuation prompt and passes it to a dedicated tool. That tool keeps the existing Herdr transfer workflow.

This adopts the generation pattern from the local `ogulcancelik/pi-handoff` extension, not its session replacement behavior.

**Status:** Proposal only. No implementation changes.

## Current State Analysis

Your extension resolves `openrouter/deepseek/deepseek-v4.1-flash`, serializes the projected conversation, and sends a separate completion request. It uses a different system prompt, a fresh request session ID, no cache retention, and an OpenRouter-specific reasoning override (`agent/extensions/handoff/index.ts:47-99`).

The source model only determines the model for the destination Pi. After generation, the extension opens a right-hand pane, starts Pi, pastes the draft, focuses the destination, and sends Ctrl+G (`agent/extensions/handoff/index.ts:144-169`). It never submits the draft.

The reference extension takes a different path. Its command adds a handoff instruction to the source session through `pi.sendMessage()`. The active agent writes the prompt as the argument to a `handoff` tool (`/Users/casparnettelbladt/GitHub/ogulcancelik/pi-handoff/handoff.ts:124-173`).

## Desired End State

```text
/handoff <goal>
  -> add a handoff instruction to the source session
  -> the active model writes a self-contained prompt
  -> the model calls handoff_submit({ requestId, prompt })
  -> the tool transfers the prompt through the existing Herdr workflow
  -> the destination opens its external editor with an unsubmitted draft
```

Generation uses the normal session model, thinking level, provider credentials, system instructions, and effective conversation context. It requires no dedicated DeepSeek model or separate OpenRouter credentials.

The source session, selected model, and editor draft remain in place. Its transcript now includes the handoff instruction, assistant response, and tool result.

### Key Discoveries

- Replacing the generator with `ctx.model` does not reproduce the reference design. It still creates a separate request with serialized context (`agent/extensions/handoff/index.ts:55-76`).
- Pi supports custom messages that trigger a normal agent turn. `display: false` only hides the message from the UI, not the session transcript (`agent/extensions/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1702-1757`).
- A tool receives `ExtensionToolContext`, not the command context with `waitForIdle()` and `newSession()` (`agent/extensions/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:487`).
- The Herdr adapter requires only `ExtensionAPI`. Its operations can run directly from the new tool (`agent/extensions/handoff/herdr.ts:26-58`).
- The reference switches the source session and submits the successor prompt. Neither behavior matches your current workflow (`/Users/casparnettelbladt/GitHub/ogulcancelik/pi-handoff/handoff.ts:50-69`).
- The local extension package uses `@earendil-works/pi-coding-agent` and `typebox`. The reference uses older package names. Use the local imports (`agent/extensions/question.ts:7-17`).

## What We're NOT Doing

- No source-session replacement or automatic submission in the destination.
- No automatic handoff at a context threshold or after an AFK timeout.
- No autonomous handoff without an explicit `/handoff` command.
- No `session_query` instruction. The reference assumes that separate tool exists.
- No pane-layout changes, model-selection UI, thinking-level carry-over, or editor-keybinding changes.
- No DeepSeek fallback or automatic retry of Herdr commands.

## Implementation Approach

### Command: request generation, not perform generation

Keep the current interactive-mode, goal, Herdr, and model checks. Keep `waitForIdle()` in the command so the current task finishes before the handoff starts.

Reserve one operation slot before `waitForIdle()` so concurrent commands cannot both start a handoff. Do not block the existing agent's tools while this command waits.

After idle, make sure that the source session did not change. Capture its session ID, pane ID, working directory, and model reference. Create an in-memory request with a unique `requestId`, then enter the generation phase. Reject another `/handoff` until the operation finishes.

Use `pi.sendMessage()` with `{ triggerTurn: true, deliverAs: "followUp" }`. The message contains the goal, request ID, and instructions for the agent. Display the request or show a notification so the user knows that a source model turn will run.

The instruction must ask the model to:

1. Write a self-contained prompt for a fresh session.
2. Include relevant decisions, file paths, current state, unfinished work, and known errors.
3. Include completed checks and any checks that remain pending.
4. Preserve the user's goal and constraints.
5. Call `handoff_submit` once with the supplied request ID and the complete prompt.
6. Do not continue the implementation task or call other tools.
7. Treat this request as complete after the tool returns.

The instruction does not include a serialized copy of the conversation. Pi supplies the normal session context.

### Tool: receive the prompt and transfer it

Register `handoff_submit` with `requestId` and `prompt` string parameters. Use `exposure: "model-only"` so the model calls it directly, rather than through a codemode script. Keep its declaration stable across handoffs.

The tool must reject an absent, stale, already consumed, or different-session request. It must also reject a blank prompt and an aborted signal before pane creation. The model cannot choose the source pane, working directory, or destination model. Those values come from the pending request.

Mark the request consumed before the first Herdr operation. This prevents duplicate tool calls from creating multiple panes, even after a partial transfer failure. Keep the operation guard active until settlement so sibling tool calls and concurrent commands remain blocked during transfer.

Keep the existing sequential operations:

```text
splitPane("right", capturedCwd)
startPiAgent(paneId, generatedName, capturedModelRef)
sendText(paneId, prompt)
focusAgent(paneId)
sendKeys(paneId, "ctrl+g")
```

Return a short result with the pane ID and the explicit instruction that the destination draft needs review and Enter. Include the required `details` field. Use `terminate: true` to avoid an unnecessary source follow-up model request after the tool batch.

Pi only terminates early if every result in the batch requests termination. Require the handoff tool to be the only call. During generation and transfer, a session-scoped `tool_call` handler must block other tools with a terminating result. This prevents accidental edits or shell commands. The handler must not affect the earlier idle wait or unrelated sessions.

### Cancellation and cleanup

Replace the custom generation loader with Pi's normal agent progress and cancellation. An optional `ctx.ui.setStatus()` message can identify the handoff operation without taking over terminal input.

Clear request state, the operation guard, and status when the agent fully settles. If the tool never ran, report that no draft was transferred. Use `agent_settled`, not `agent_end`, because automatic retries and recovery can follow `agent_end`.

Also clear pending state on session replacement, tree navigation, shutdown, and reload. A queued or replayed tool call must fail after cleanup. Do not persist authorization to create panes in the session file.

Before the split, cancellation creates no pane. After a split, report the known pane ID on failure and leave the pane available for manual recovery. Preserve the current rule against automatic pane closure or transfer retries.

## Alternative Approaches Considered

1. **Change only the generator to `ctx.model`.** This is the smallest change and preserves the unchanged source transcript. It still uses a separate completion request and flattened context. It does not adopt the reference's session-native flow.
2. **Adopt the command-to-tool flow. Recommended.** This uses Pi's normal context and generation pipeline. It adds a source model turn and requires request-state safeguards.
3. **Copy the reference extension wholesale.** This also adds session replacement, submission, and automatic handoff. Those changes conflict with the existing draft workflow.

## Phase 1: Separate prompt transfer from generation

### Overview

Extract the existing Herdr transfer sequence into a helper while retaining DeepSeek generation. This creates a small, independently verifiable refactor.

### Changes Required

**File:** `agent/extensions/handoff/index.ts`

- Extract the transfer sequence into a helper that accepts the prompt, working directory, and model reference.
- Keep the command behavior, error messages, command order, and draft handling unchanged.
- Leave `herdr.ts` unchanged unless the extraction requires a type-only adjustment.

### Success Criteria

#### Automated Verification

- [ ] `node --test agent/extensions/handoff/handoff.test.cjs`
- [ ] `npm --prefix agent/extensions run typecheck`
- [ ] `git diff --check`

#### Manual Verification

- [ ] A handoff still opens the destination editor without submitting its draft.

## Phase 2: Generate through the source session

### Overview

Add the request-to-tool flow, remove the separate completion request, and update the tests and README together.

### Changes Required

**Files:** `agent/extensions/handoff/index.ts`, `agent/extensions/handoff/handoff.test.cjs`, `agent/extensions/handoff/README.md`

- Register the guarded `handoff_submit` tool and request cleanup handlers.
- Change `/handoff` to request a normal agent turn.
- Remove `createHandoffPrompt()`, `withLoader()`, conversation serialization, and the OpenRouter-specific request configuration.
- Retain `uuidv7` only if it supplies the request ID.
- Replace generator and loader tests with message, tool, request-state, and lifecycle tests.
- Remove dedicated DeepSeek requirements from the README.
- Replace the unchanged-source-transcript promise with an unchanged-source-session and editor-draft promise.

### Success Criteria

#### Automated Verification

- [ ] The same three commands from Phase 1 pass.
- [ ] No handoff path calls `modelRegistry.find()` or `modelRegistry.complete()`.
- [ ] Invalid commands, unauthorized calls, stale IDs, duplicate calls, blank prompts, and cancellation create no pane.
- [ ] Settlement without a tool call and session changes clear pending authorization.
- [ ] The exact Herdr sequence, literal multiline prompt, partial-failure reporting, and no-submission behavior remain covered.
- [ ] A successful tool result includes `details` and requests termination.

#### Manual Verification

- [ ] Generation uses the active source model and normal thinking configuration.
- [ ] A non-OpenRouter source works without separate OpenRouter credentials.
- [ ] The prompt preserves the goal, decisions, files, current state, and pending checks.
- [ ] The workflow works after `/compact` with the context that Pi retains.
- [ ] Escape before transfer creates no pane, and a later handoff still works.
- [ ] The destination draft needs explicit Enter before any work starts.
- [ ] The source remains usable with its original model and editor draft.

## Testing Strategy

The harness must mock `registerTool`, `on`, and `sendMessage` in addition to commands and process calls. It can call the registered tool with a generated prompt to exercise transfer without a paid model request.

Live checks remain necessary for model compliance, terminal paste consumption, focus, and external-editor behavior. Automated tests cannot establish prompt quality.

## Performance Considerations

The main benefit is normal session context and fewer provider-specific requirements. A model has no persistent hidden workspace that this design unlocks. Each request still depends on the context that Pi sends.

After compaction, the model sees the retained context, not every detail from the original conversation. Session-native generation can preserve structured context and use normal cache behavior, but cache reuse is provider-dependent.

The active model can cost more or take longer than DeepSeek Flash, especially with a high thinking level. Compare prompt quality, generation time, and cost before claiming an improvement.

## Migration Notes

Run `/reload` after implementation. Existing sessions and drafts require no conversion.

Do not remove DeepSeek or OpenRouter from shared configuration. Other extensions or sessions can still use them.

## References

- Current extension: `agent/extensions/handoff/index.ts`, `agent/extensions/handoff/herdr.ts`, `agent/extensions/handoff/handoff.test.cjs`.
- Reference implementation: `/Users/casparnettelbladt/GitHub/ogulcancelik/pi-handoff/handoff.ts`.
- Installed Pi documentation: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` and `docs/tui.md`.
- Local Pi API declarations: `agent/extensions/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`.
