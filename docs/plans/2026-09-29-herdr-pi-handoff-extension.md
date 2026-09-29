# Herdr Pi Handoff Extension Implementation Plan

## Overview

Add a small global Pi extension that transfers the useful context of the active Pi session to a fresh Pi process in an adjacent Herdr pane. `/handoff <goal>` will generate a focused, editable continuation prompt from the current branch, let the user review it, start a new Pi agent in a right-hand split, and paste the approved prompt into that new Pi editor without submitting it. The original Pi session remains open and unchanged.

## Current State Analysis

This repository is the user-level Pi configuration. `install.sh` symlinks `agent/` into `~/.pi/agent`, where Pi auto-discovers extension directories with an `index.ts` entry point. The extensions package already has the Pi runtime packages and a strict TypeScript typecheck command that includes `*/index.ts`. Existing tests transpile an extension with TypeScript and exercise it with a small mocked Pi API.

Pi ships a directly relevant handoff example. It reconstructs meaningful history from the active branch, including a compaction summary and retained messages, serializes it, makes a one-off `modelRegistry.complete()` request, and presents the result in an editor. Its final `ctx.newSession()` call replaces the current in-process session, which is deliberately not suitable here.

The installed Herdr CLI provides the missing process and layout operations. A Pi extension running in a Herdr pane can split its own pane with `--current`, start Pi through `herdr agent start --kind pi`, and use `herdr pane send-text` to insert text without Enter. `agent prompt` is intentionally unsuitable because it submits the prompt. The current Pi integration is present but outdated; that affects Herdr lifecycle reporting and does not prevent pane splitting or process launch.

## Desired End State

In an interactive Pi session inside Herdr, the user can run:

```text
/handoff implement phase one of the plan
```

Pi generates a concise, self-contained prompt from the active branch and that goal. The user can edit or cancel it. On acceptance, the extension creates an unfocused right-hand sibling pane in the same working directory, starts a fresh Pi agent there, and pastes the approved prompt into its editor. The prompt is visible and editable in the successor pane but is not submitted. The original session stays in its source pane and no handoff artifact, configuration file, session mutation, or automatic work is created.

### Key Discoveries:

- `agent/extensions/` is the global auto-discovery location used by this configuration through the `agent/` symlink: `README.md:3-11`.
- Pi auto-discovers extension directories that contain `index.ts`, and the extensions package uses strict, no-emit TypeScript checking that includes those entry points: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:37-55`, `agent/extensions/package.json:3-7`, `agent/extensions/tsconfig.json:2-10`.
- The local extension test pattern transpiles TypeScript and mocks the Pi API with Node's test runner: `agent/extensions/tests/tailnet.test.cjs:1-60`.
- Pi's official handoff example already establishes correct branch and compaction reconstruction, model generation, and editor-review patterns: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/handoff.ts:37-156`.
- The official example switches the current session with `ctx.newSession()`, which conflicts with retaining the source pane: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/handoff.ts:174-187`.
- Herdr separates pane creation from agent startup. `agent start` waits until Pi is ready, and `pane send-text` sends text without Enter: `/Users/casparnettelbladt/.agents/skills/herdr-docs/herdr/docs/versions/0.9.1/website/src/content/docs/agent-automation.mdx:16-30,42-67`.
- Herdr's CLI explicitly supports `pane split --current --direction right --cwd ... --no-focus`, `agent start --kind pi`, and `pane send-text`: `/Users/casparnettelbladt/.agents/skills/herdr-docs/herdr/docs/versions/0.9.1/website/src/content/docs/cli-reference.mdx:217-253,341-360`.
- Herdr's Pi integration is installed but reports version 6 when version 9 is current. It is separate from this extension and not a delivery dependency: `agent/extensions/herdr-agent-state.ts:1-6` and `herdr integration status` observed on 2026-09-29.

## What We're NOT Doing

- Replacing the original Pi session or using `ctx.newSession()`.
- Automatically submitting the successor prompt or making the successor begin work.
- Supporting tmux, other multiplexers, non-Herdr mode, other agent kinds, alternate split directions, or configurable launch commands.
- Collecting live Git state, untracked files, task boards, skills, external memories, or terminal scrollback beyond the current Pi branch.
- Persisting handoff documents, parent-session metadata, shared state files, clipboard fallbacks, automatic retries, or lifecycle/event-bus integrations.
- Updating the installed Herdr integration as part of this feature.
- Publishing the extension as an npm or Pi package.

## Implementation Approach

Implement an `agent/extensions/handoff/` extension module with `index.ts` as its one `/handoff <goal>` entry point. Keep version-one helpers in `index.ts` because it has one command, one generation request, and one Herdr launch sequence. The directory establishes an isolated module boundary so later helpers, UI, or tests can move into focused files without reorganizing the extension's public location.

The command must first require TUI mode, an active model, a non-empty goal, and `HERDR_ENV=1` with a current Herdr pane. If any precondition fails, it must notify the user and make no model call or Herdr change. It must wait for the current agent to settle before taking the branch snapshot.

Reuse the official example's semantic approach, not its session-replacement step. Convert message and compaction entries from `ctx.sessionManager.getBranch()` into the reconstructed active context, call `convertToLlm()` and `serializeConversation()`, then make one nested `ctx.modelRegistry.complete()` call with `ctx.model`. The generator system prompt must request a concise, self-contained continuation prompt with context, decisions, relevant files, current state, and the user-supplied next task. It must request only the prompt, with no conversational preamble. Use `BorderedLoader` and its abort signal for the generation UI. A compacted branch must include the latest compaction summary plus entries retained from its `firstKeptEntryId`, matching the official example.

After generation, open `ctx.ui.editor()` so the user approves and edits the transfer. Cancelling either the loader or editor ends the command without creating a pane. An empty generated result is an error rather than a reason to start a blank Pi session.

After approval, run the Herdr binary from `HERDR_BIN_PATH` when present, otherwise `herdr`, through `pi.exec()`. The exact sequence is:

1. `pane split --current --direction right --cwd <ctx.cwd> --no-focus`.
2. Parse the JSON response and require `.result.pane.pane_id`.
3. `agent start <unique-handoff-name> --kind pi --pane <pane-id>` so Herdr waits for the new Pi editor to be ready.
4. `pane send-text <pane-id> <approved-prompt>` to leave the prompt as an editable draft without pressing Enter.

The generated agent name must begin with a letter, be at most 32 characters, and include a timestamp-derived suffix so parallel handoffs do not collide. The command must not call `agent prompt`, `pane run`, `sendUserMessage`, or `ctx.newSession()`.

If Herdr fails before a pane is created, notify the user and leave the source session intact. If it fails after the split, notify the user with the created pane ID for inspection or manual close. In either failure case after editor acceptance, restore the approved prompt into the source Pi editor with `ctx.ui.setEditorText()` so the user does not lose it. Do not automatically close a pane created by this command; clear failure and manual recovery are preferable to hidden cleanup.

## Alternative Approaches Considered

### Use Pi's official example unchanged

Rejected because it creates a successor with `ctx.newSession()` inside the existing Pi process. That switches away from the source session and cannot satisfy the adjacent Herdr-pane requirement. Its branch reconstruction, nested model call, loader, and editor patterns remain the reference for this design.

### Implement a Herdr plugin instead

Rejected for version one because the requested starting point is a Pi extension and Pi already has direct access to the precise active branch and model runtime. A standalone Herdr plugin would need to rediscover and parse the Pi session externally, then duplicate prompt generation and review UI.

### Launch `pi` with `pane run` and then paste the prompt

Rejected because it does not wait for Pi to become ready. `herdr agent start --kind pi` gives the needed readiness boundary. `pane send-text` is used only after startup because it preserves the editable-draft decision by not sending Enter.

### Adopt a full external handoff implementation

Rejected because the researched packages add configuration systems, Git collection, multiplexer abstraction, shared memory, durable documents, transcript fallback, redaction policies, event hooks, and recovery workflows. Those are possible later iterations, but none are required for the first personal Pi extension.

## Phase 1: Implement Focused Prompt Generation

### Overview

Create the global extension and make `/handoff <goal>` reliably generate and review a continuation prompt from the active Pi branch without changing sessions or panes.

### Changes Required:

#### 1. Handoff extension
**File**: `agent/extensions/handoff/index.ts`
**Changes**: Add the module's auto-discovered entry point that registers `/handoff` and implements preflight, active-branch reconstruction, one nested model completion, loader cancellation, and editor review.

- Import only Pi-supplied packages: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent`.
- Adapt the official `entryToMessage()` and `getHandoffMessages()` behavior so the current branch is represented correctly after compaction.
- Require TUI mode, a selected model, a non-empty goal, and Herdr environment variables before generation.
- Call `ctx.waitForIdle()` before reading `ctx.sessionManager.getBranch()`.
- Serialize the reconstructed branch and use `ctx.modelRegistry.complete()` with a fresh `uuidv7()` session ID, `cacheRetention: "none"`, and the loader's abort signal.
- Extract text blocks only. Treat a cancelled response, a completion error, or blank text as a user-visible failure with no side effect.
- Open `ctx.ui.editor("Edit handoff prompt", generatedPrompt)`. A cancelled editor stops cleanly. A returned value is the approved handoff text for Phase 2.

### Success Criteria:

#### Automated Verification:
- [ ] `npm --prefix agent/extensions run typecheck` passes.

#### Manual Verification:
- [ ] In a normal interactive Pi session, `/handoff` with no argument shows usage and does not start a model request.
- [ ] Outside Herdr, `/handoff <goal>` explains that the extension requires Herdr and does not generate a prompt.
- [ ] In Herdr, `/handoff <goal>` shows a generated prompt in the editor, and cancelling the editor creates no pane and leaves the current session selected.
- [ ] A session with compaction produces a prompt that includes the compacted history summary and recent retained work.

**Implementation Note**: After completing this phase and its automated verification, pause for manual confirmation before proceeding.

---

## Phase 2: Launch and Seed the Herdr Successor Pane

### Overview

Connect the approved prompt to a fresh, ready Pi process in a right-hand Herdr sibling pane while preserving the source session and leaving the successor prompt unsubmitted.

### Changes Required:

#### 1. Herdr launch helpers in the handoff extension
**File**: `agent/extensions/handoff/index.ts`
**Changes**: Add small helpers to invoke and validate the three Herdr CLI operations after prompt approval.

- Resolve the executable as `process.env.HERDR_BIN_PATH ?? "herdr"`.
- Split the caller pane with `pi.exec()` using `--current`, `--direction right`, `--cwd ctx.cwd`, and `--no-focus`.
- Parse command stdout as JSON and validate the returned pane ID before continuing. Report malformed or failed CLI output as an error.
- Start `--kind pi` in that returned pane with a generated valid, unique handoff agent name. Do not pass a resume argument, so this is a fresh Pi session.
- Once `agent start` succeeds, send the approved text with `pane send-text`. Do not send Enter and do not call `agent prompt`.
- Notify the user with the target pane ID when the editable draft is ready.
- On any post-approval failure, restore the approved text to the source editor. When a split already succeeded, include the pane ID in the notification and leave cleanup to the user.

### Success Criteria:

#### Automated Verification:
- [ ] `npm --prefix agent/extensions run typecheck` passes.

#### Manual Verification:
- [ ] From a Pi pane in Herdr, accepting `/handoff <goal>` creates a right-hand sibling with the same working directory and does not steal focus from the source pane.
- [ ] The successor process is a newly started Pi session, not a resumed source session.
- [ ] The approved handoff text is visible in the successor editor and can be changed before submission.
- [ ] The successor does not begin a model turn until the user explicitly presses Enter.
- [ ] The source Pi session remains open, retains its transcript, and can continue independently.
- [ ] Simulating a Herdr launch failure restores the approved prompt to the source editor and reports whether a pane was created.

**Implementation Note**: After completing this phase and its automated verification, pause for manual confirmation before proceeding.

---

## Phase 3: Add Focused Regression Coverage and Usage Documentation

### Overview

Lock down the branch, error, and Herdr command contract with focused unit tests, then document the command for this personal configuration.

### Changes Required:

#### 1. Extension command tests
**File**: `agent/extensions/tests/handoff.test.cjs`
**Changes**: Follow the existing `tailnet.test.cjs` Node test harness style. Transpile `handoff/index.ts`, capture the registered command, and mock the command context, nested model completion, UI, environment, and `pi.exec()` responses.

Cover these cases:

- Successful flow reconstructs branch input, opens the review editor, invokes split, starts `--kind pi`, then calls `pane send-text` with the edited result.
- The launch sequence uses `--current`, right direction, current working directory, `--no-focus`, and the exact pane ID returned by split.
- Success never invokes `ctx.newSession()`, `agent prompt`, or a command that includes Enter.
- Missing goal, non-TUI mode, missing model, missing Herdr environment, no usable history, cancelled generation, blank generation, and cancelled editor make no Herdr calls.
- Invalid split JSON, a missing pane ID, start failure, and send failure restore the approved prompt to the source editor and report an error. A post-split failure includes the created pane ID.

#### 2. Usage documentation
**File**: `README.md`
**Changes**: Add `handoff` to the custom-extension list with its exact invocation, the Herdr requirement, the fact that it preserves the source session, and that the successor prompt remains an editable unsubmitted draft.

### Success Criteria:

#### Automated Verification:
- [ ] `node --test agent/extensions/tests/handoff.test.cjs` passes.
- [ ] `npm --prefix agent/extensions run typecheck` passes.
- [ ] `git diff --check` passes.

#### Manual Verification:
- [ ] Follow the README invocation in a real Herdr Pi pane and verify every documented behavior.
- [ ] Cancel each UI stage once and verify no unwanted successor pane or session is created.
- [ ] Review the successor pane manually to confirm the draft has not been submitted.

**Implementation Note**: After completing this phase and its automated verification, pause for manual confirmation before considering the feature complete.

## Testing Strategy

### Unit Tests:

- Compaction-aware branch reconstruction includes the latest compaction summary and the correct retained suffix.
- Generation responses are reduced to text and blank or cancelled responses stop safely.
- Herdr JSON parsing rejects absent or malformed pane IDs.
- The generated agent name conforms to Herdr's naming rules and does not reuse a fixed name.
- The command sequence and arguments preserve draft behavior by ending in `pane send-text`, not `agent prompt`.
- Every preflight, cancellation, and failure branch avoids unintended session replacement or prompt submission.

### Integration Tests:

- No automated live Herdr integration test in version one. Herdr creates terminal panes and interactive Pi processes, so a real installation is the appropriate small-scope integration check.

### Manual Testing Steps:

1. Start Pi inside Herdr in a repository with several turns of work, then run `/handoff <specific next task>`.
2. Review and edit the generated prompt, then accept it.
3. Confirm a right-side Pi pane opens in the same directory and that the prompt is present but unsubmitted.
4. Edit the successor draft, submit it manually, and confirm it can act without the source transcript.
5. Return to the source pane and confirm its session and editor remain usable.
6. Repeat once after `/compact` and once with Herdr disabled to verify the compaction and preflight paths.

## Performance Considerations

The only expensive operation is one nested model completion over the active branch. Use the active model and Pi's serialized branch representation. Do not add Git scans, file walks, background processes, transcript copies, or retry loops. If the nested completion exceeds the selected model's context window, report the model error and let the user compact or narrow the handoff goal before retrying manually.

## Migration Notes

No migration is required. The extension is discovered automatically after adding `agent/extensions/handoff/index.ts`. Reload Pi with `/reload` during development or start a new Pi process. Existing sessions and Herdr panes are unchanged.

## References

- Pi official handoff example: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/handoff.ts`
- Pi extension API and lifecycle: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Installed Pi extension type contracts: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- Herdr 0.9.1 agent automation: `/Users/casparnettelbladt/.agents/skills/herdr-docs/herdr/docs/versions/0.9.1/website/src/content/docs/agent-automation.mdx`
- Herdr 0.9.1 CLI reference: `/Users/casparnettelbladt/.agents/skills/herdr-docs/herdr/docs/versions/0.9.1/website/src/content/docs/cli-reference.mdx`
- Existing test pattern: `agent/extensions/tests/tailnet.test.cjs`
- Research comparison: https://github.com/javapacr/pi-handoff and https://github.com/sanirudh17/herdr-agent-handoff
