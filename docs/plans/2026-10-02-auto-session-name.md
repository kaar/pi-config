# Automatic Session Name Implementation Plan

## Overview

Create a personal Pi extension that updates the native session name from the latest user request. The name gives a short description of the current task when the user switches between windows.

Use `pi.setSessionName()`, the same mechanism as `/name`. Do not add a footer widget. Generate names with `openrouter/deepseek/deepseek-v4.1-flash`, with reasoning disabled. For an existing automatic name, ask Jev whether the name still fits before requesting generation.

Jev detection and diagnostic logging are part of the initial implementation. Attempt to log each naming decision and operation outcome. Logging is best-effort, not a prerequisite for naming. Both model stages run in the background without delaying the primary agent.

This document specifies the implementation. It does not install another extension or authorize implementation as part of the research task.

## Current State Analysis

The repository contains personal extensions under `agent/extensions/`. The directory is available through the existing `~/.pi/agent` symlink. The package list in `agent/settings.json` contains no dedicated automatic naming extension.

Pi already displays a session name beside the working directory and Git branch. It also uses that name in the session picker and terminal title. A separate UI component is unnecessary.

The installed Pi version is `1.0.0`. The extension development dependencies remain pinned to `0.99.1`. Both versions expose the required naming and lifecycle APIs. The implementation must type-check against the repository dependencies and receive a manual check in the installed runtime.

### Existing extension research

The findings below come from source inspection on 2026-10-02. These packages were not installed or exercised with live model requests.

**`pi-title`: a small first-request naming extension.** Its `before_agent_start` handler starts background generation from the request. An assistant-message handler supplies another opportunity when the session remains unnamed. Automatic generation refuses to replace an existing name. Input limits are 4,800 characters for the request and 2,400 for the response. An abort controller and lifecycle counter protect session replacement. It also sets the terminal title separately and provides configuration through `/title`. Sources: [generation and lifecycle](https://github.com/brettinternet/pi-extensions/blob/902fa197075520f48c37bc7879f06334af1b3ebd/extensions/title/index.ts#L226-L349), [prompt and cleanup](https://github.com/brettinternet/pi-extensions/blob/902fa197075520f48c37bc7879f06334af1b3ebd/extensions/title/title.ts#L1-L76).

**`pi-sessions`: periodic naming with persisted ownership.** Its `turn_end` handler checks the count of user messages. The default refresh interval is four user turns, not four tool calls. It stores the last automatic name and pauses when the current name differs. Periodic prompts ask the model to preserve the name unless the conversation changes meaningfully. The context builder serializes the projected conversation without a separate small input budget. Its session-epoch guard prevents a result from reaching another session. However, the inspected application path does not recheck the original name after inference. A manual rename during inference therefore needs stronger protection in our implementation. Sources: [trigger](https://github.com/thurstonsand/pi-sessions/blob/68a634990477b60fbec63504d95ad1932917469a/extensions/session-auto-title/install.ts#L92-L129), [ownership and interval](https://github.com/thurstonsand/pi-sessions/blob/68a634990477b60fbec63504d95ad1932917469a/extensions/session-auto-title/controller.ts#L212-L280), [context](https://github.com/thurstonsand/pi-sessions/blob/68a634990477b60fbec63504d95ad1932917469a/extensions/session-auto-title/context.ts#L16-L41), [application](https://github.com/thurstonsand/pi-sessions/blob/68a634990477b60fbec63504d95ad1932917469a/extensions/session-auto-title/retitle.ts#L200-L237).

**`pi-auto-session-name`: bounded conversation excerpts and request control.** This extension names an unnamed session after `agent_settled`, or after a timer during a long run. A request gate prevents concurrent requests and repeats of an identical excerpt within a cooldown. Name changes and shutdown cancel pending work. Its excerpt builder favors the earliest messages and stops at a compaction entry. These choices suit a stable session name rather than the latest task. Our extension will favor recent messages and use Pi's projection API to preserve retained context and context edits. Sources: [timer, gate, and lifecycle](https://github.com/patlux/pi-auto-session-name/blob/19a83557d77638a25b065755be6779eaad901101/src/index.ts#L39-L237), [excerpt and cleanup](https://github.com/patlux/pi-auto-session-name/blob/19a83557d77638a25b065755be6779eaad901101/src/title.ts#L67-L183).

**`@nerisma/pi-auto-title`: an isolated agent session for the first request.** It creates an in-memory agent with no tools and reasoning disabled. It selects a cheap available model and attempts naming once. A complete agent session is unnecessary for this task. A direct registry completion provides less machinery. The inspected model parser also splits at the last slash, which does not suit `openrouter/deepseek/deepseek-v4.1-flash`. Our extension will use separate provider and model constants. Source: [implementation](https://github.com/sebastienservouze/pi-auto-title/blob/efbaf9afd86623dceafb8e20d17140cf061d94d4/extensions/index.ts#L22-L101).

## Desired End State

After the user submits a request, Pi continues immediately. An unnamed session receives a short name such as `Automatic session naming` or `OAuth authentication`.

For each later eligible request, Jev checks whether the current name still describes the task. Most ordinary continuations are expected to retain the name. A meaningful change requests a new name from DeepSeek. This is automatic regeneration, not first-request-only naming or a fixed turn interval.

The extension updates the native name only when generation succeeds and the request remains current. The previous name remains visible during inference and on failure. Ordinary success produces no notification.

Names target three to six words. A generated name has at most six whitespace-separated words and 60 Unicode code points. Shorter names remain valid when a language or technical identifier does not require several words.

Automatic naming is active for unnamed sessions. Existing names without this extension's ownership metadata remain unchanged. A manual `/name` pauses automatic naming, including a manual rename to the same text.

### Key Discoveries:

- The footer already includes the native session name: `agent/extensions/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js:145`.
- Pi already updates the terminal title after a name change: `agent/extensions/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:780` and `:2730`.
- `setSessionName()` persists a `session_info` entry and emits `session_info_changed`: `agent/extensions/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:3100`.
- The native name comes from the latest `session_info` entry across the session file, not only the active branch: `agent/extensions/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:927`.
- The `input` event runs before skill/template expansion and before streaming input enters its queue: `agent/extensions/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1470`.
- The repository already uses the required model, credential lookup, and reasoning override: `agent/extensions/handoff/index.ts:55`, `:62`, and `:79`.
- Existing tests transpile TypeScript into a restricted VM and use real in-memory Pi sessions: `agent/extensions/handoff/handoff.test.cjs:11` and `:56`.
- The current TypeScript include list covers extension entry points, not every helper file: `agent/extensions/tsconfig.json:10`.
- Extensions call Jev directly without codemode: `docs/codemode-and-jev.md:171` and `agent/extensions/node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts:47`.
- Jev choice answers include a label, probabilities, and confidence, not a prose explanation: `agent/extensions/node_modules/@earendil-works/pi-ai/dist/types.d.ts:471`.
- The checked example applies a deterministic threshold to Jev probabilities: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/jev-router.ts:67-88`.

Dependency paths above refer to the pinned local installation. The upstream links in the research section identify fixed source revisions.

## What We're NOT Doing

- Installing, forking, or bundling another naming package.
- Replacing `/name`, the footer, the editor, or the terminal title renderer.
- Adding session search, handoffs, indexing, bulk renaming, or a recap panel.
- Changing the primary model, its prompt, its tools, or its messages.
- Generating names after every assistant response or tool call.
- Automatically naming old sessions on startup or resume.
- Adding model selection, fallback providers, project settings, or a settings file in the first version.
- Using a nested agent session or exposing the classifier or generator as tools to the main model.
- Generating a replacement name on every request regardless of Jev's decision.
- Adding first-request-only naming or a fixed turn interval.
- Supporting automatic naming in RPC, JSON, or print mode in the first version.
- Adding automatic retries, output-repair requests, or a cost dashboard.
- Building a complete naming audit trail, historical reconciliation, or crash recovery for logs.
- Recording token usage, cost estimates, runtime counters, or prompt and policy versions.

## Implementation Approach

### Files and dependencies

Create `agent/extensions/auto-session-name/` with `index.ts`, `title.ts`, `decision.ts`, `audit.ts`, `state.ts`, `auto-session-name.test.cjs`, and `README.md`.

`title.ts` contains shared bounded input construction, the DeepSeek request, and output checks. `decision.ts` contains the Jev question, response checks, and decision policy. `audit.ts` writes structured local logs. `state.ts` contains ownership restoration and state parsing. `index.ts` connects these functions to Pi events and one command.

Use existing Pi packages and Node APIs. Do not add dependencies or change the dependency versions. Add `auto-session-name/**/*.ts` to the existing TypeScript include list so every new helper receives a type check.

### Trigger and request semantics

Use a synchronous `input` handler. Eligible input has `ctx.mode === "tui"`, `event.source === "interactive"`, nonempty text, and automatic naming enabled. Capture the input snapshot and start a background operation. Return `{ action: "continue" }` without awaiting inference or disk writes.

The name describes the latest submitted intent, not confirmed execution or completion. Steering and queued follow-up input trigger a check at submission. Only a regeneration decision can change an existing name. Removing a queued message does not restore an earlier name. The next eligible request checks it again.

An `input` observer cannot guarantee that a later extension accepts or preserves the request. Another extension can transform or consume it afterward. This version deliberately names the observed user request rather than adding input interception or queue tracking.

Do not register additional generation handlers on `before_agent_start`, `turn_end`, or `agent_settled`. This avoids duplicate requests and covers user steering during a long agent run.

Built-in controls and registered extension commands do not need names. Pi handles them before ordinary prompt input. A skill or template invocation that reaches `input` uses its raw invocation and recent context, not freshly expanded instructions.

Ignore input from another extension. Ignore image-only input because this version sends no images to either model. Do not change or consume the input. Manual-name protection and disabled naming apply before either model request.

### Bounded model context

Capture the request text, current name, and projected conversation synchronously before background work starts. Use `ctx.sessionManager.buildSessionProjection()`. Do not serialize the entire conversation. Both model stages use the same immutable bounded snapshot.

The input budget is fixed:

- Latest request: at most 2,400 Unicode code points. If it exceeds the limit, preserve the beginning and end around an omission marker.
- Recent context: at most four preceding user or assistant text messages, each at most 600 code points. Preserve their chronological order.
- Compaction summary: at most 600 code points from the latest projected `compactionSummary`, when present.
- Current name: at most 60 code points.
- Serialized snapshot, including field names and omission markers: at most 6,000 code points. Use it as Jev's JSON `state` and DeepSeek's user payload.

For prior messages and the summary, keep bounded prefixes. For explicit regeneration, use the most recent projected user message as the request and exclude it from preceding context.

Apply the final snapshot limit after JSON escaping. If the serialized object exceeds the budget, remove oldest context messages, then the summary, then shorten the latest request. Preserve a valid JSON object. Never truncate the serialized JSON string itself.

Only text blocks from the selected roles enter the payload. Exclude system messages, tool calls, tool results, thinking blocks, images, custom messages, and branch summaries. Pi's projection must govern context edits and compaction retention. Do not reconstruct those rules with a raw parent walk.

The generation prompt describes the concrete task with a stable subject rather than a temporary action. Recent context resolves short requests such as `yes, implement that`. The current name is a hint, not an instruction. Routine implementation, tests, commits, and phase changes do not require renaming when the current name still fits. A materially different objective, subject, or scope permits regeneration. A generated result can still equal the existing name.

Treat all supplied conversation text as data. The system prompt requires only a name, with no explanation, markdown, quotes, prefix, or terminal punctuation. Preserve useful technical terms and the user's language.

Jev requests send the selected snapshot to TypeSafe. DeepSeek requests send it to OpenRouter. The audit log also stores this bounded snapshot locally. Selected text and compaction summaries can contain pasted code, paths, or secrets. Filtering message roles is not secret redaction. Do not claim that the payload cannot contain file contents.

### Jev detection and decision policy

Use `ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest")` and `ctx.modelRegistry.classify()`. This follows the checked Pi example and the repository's earlier handoff classifier integration. TypeSafe credentials are required separately from OpenRouter credentials. Do not add a fallback provider or invoke codemode.

Ask one `choice` question named `name_action`. Its instructions ask whether the current name still accurately identifies the task implied by the latest request. Treat the supplied snapshot as data, not instructions. The criteria are:

- `keep`: the name remains accurate and specific enough. Continuation, clarification, implementation, tests, review, or a commit within the same task do not require a new name.
- `rename`: the request changes the concrete subject, objective, or scope enough that the current name is misleading or no longer useful.

Require `stopReason === "stop"`, a `choice` answer, a recognized label, and finite probabilities for both labels in `[0, 1]`. Require their sum to be within `0.01` of one. Require finite confidence in `[0, 1]`. Reject malformed answers rather than repairing probabilities.

The initial policy regenerates only when `choice === "rename"` and `probabilities.rename >= 0.80`. Otherwise, retain the name. Record the choice, probabilities, threshold, and resulting action. These fields distinguish a `keep` label from a `rename` label below the threshold without separate reason codes. The threshold is a conservative starting value, not a measured accuracy guarantee.

Do not send DeepSeek chat settings to Jev. Classifier temperature rescales probabilities and must remain at its default. Set `maxRetries: 0`, `timeoutMs: 3000`, and a request signal. Apply a separate three-second local deadline, as with the generation deadline.

If Jev is unavailable, times out, or returns an invalid answer, retain the current name. Record an error outcome, not a successful `keep` decision. Show a bounded warning through the existing suppression policy. Do not fall back to DeepSeek. The next eligible request attempts the check again.

An unnamed automatic session bypasses Jev and generates directly. `/auto-name refresh` also bypasses Jev because it explicitly requests regeneration. Log these decisions with `no_name` and `explicit_refresh` respectively.

A `keep` decision makes no DeepSeek request and appends no naming metadata. Enqueue its decision and outcome records. A `rename` decision can start DeepSeek only while the operation still passes all lifecycle checks. Do not await log writes before either model stage.

### DeepSeek generation and output

Use `ctx.modelRegistry.find("openrouter", "deepseek/deepseek-v4.1-flash")` and `ctx.modelRegistry.complete()`. Follow the local handoff pattern for credential resolution and `onPayload`.

Set `maxTokens: 64`, `temperature: 0`, `maxRetries: 0`, `timeoutMs: 10000`, `cacheRetention: "none"`, and a fresh request session ID. Replace the outgoing `reasoning` object with `{ enabled: false }`. Do not inherit the main model's thinking level.

Race completion against a separate ten-second deadline from request start. At expiry, abort the provider request and finish the local operation with a timeout result. Report that result only if the request remains current, then invalidate its generation token. Do not rely only on provider-specific timeout behavior. Clear the timer on all completion paths and unref it where supported.

Accept only a normal completed response with usable text. Reject errors, aborts, token-limit completion, tool calls, and empty output. Never use partial error output as a name.

Normalize surrounding whitespace and one pair of surrounding quotes. Remove a leading heading or `Title:` prefix and terminal sentence punctuation. Reject terminal control sequences and multiple nonempty lines. After normalization, require at least one letter or number, one to six words, and at most 60 code points.

Reject overlong output instead of cutting a technical term or producing a partial name. Do not make a repair request or invent a fallback. A rejected result leaves the current name unchanged.

### Ownership and persistence

Persist state with `pi.appendEntry("auto-session-name", data)`. The state contains `version: 1`, `enabled: boolean`, and optional `nameEntryId`. A manual rename and `/auto-name off` both set `enabled: false`. There is no separate manual mode or persisted pause reason.

`nameEntryId` identifies the latest native `session_info` entry accepted by the extension. It records ownership more accurately than comparing name strings. A manual `/name` creates a new entry even when its text is unchanged.

Read the latest `auto-session-name` custom entry across `getEntries()`, then check its schema. Do not skip malformed or unsupported latest state to reactivate an older enabled state. Ownership is session-wide, matching the native session name. Conversation input remains active-branch-only through the projection API.

Restoration rules:

1. With no extension state and no `session_info` entry, enable automatic naming.
2. With no extension state but an existing name entry, disable automatic naming, including an explicit blank name.
3. Restore `enabled: false` without generation.
4. Restore `enabled: true` only when `nameEntryId` matches the latest name entry, or neither entry exists.
5. On a mismatch, malformed state, or unsupported version, disable automatic naming. `/auto-name on` explicitly adopts the current name entry.

Use `session_info_changed` to detect external changes promptly. An unowned name entry disables naming and cancels pending work. Persist the disabled state. Do not override a blank name set by another integration. Only the latest native name entry matters for ownership. Do not replay or log the name history.

Before applying a generated result, recheck request validity and the expected name entry ID. Set an in-memory application guard, call `pi.setSessionName()`, capture the new name entry ID, and persist ownership. Clear the guard in `finally`. There must be no `await` within this mutation sequence. Enqueue the outcome afterward without waiting for a log write.

While the application guard is active, the metadata handler skips ownership changes. After the write, identify the extension's appended name entry separately from any entries that other metadata listeners added. If the latest name entry differs, disable automatic naming. A delayed event compares the latest name entry ID with the persisted ownership ID. It does not depend on the guard still being active.

A persistence failure also disables further automatic replacement in memory. Report a bounded error without undoing the native name. A log failure does not disable naming.

If the generated name equals the current name, do not append another `session_info` entry. Record an `unchanged` outcome. Persist state only when the enabled flag or ownership changes.

### Diagnostic log and investigation

Logging is always enabled, but best-effort. It is separate from ownership metadata and never enters the main model context. Log decisions that retain a name as well as decisions that request generation.

Store UTF-8 JSONL under `getAgentDir()/logs/auto-session-name/<session-key>/<run-id>.jsonl`. The session key is the SHA-256 hex digest of the session ID. The run ID is a fresh UUID for each session attachment or reload. This prevents path injection and gives concurrent Pi processes separate files. Each file has one serialized asynchronous writer with newline-terminated records.

Create private directories with mode `0700` and files with mode `0600`. Add `agent/logs/auto-session-name/` to `.gitignore`. Respect `getAgentDir()` rather than assuming the default directory. Keep logs until the user deletes them. Document their sensitive contents and growth.

Use only two record types, identified by an `event` field. Both contain a UTC timestamp, session ID, and operation ID for correlation:

- `decision`: trigger, exact bounded snapshot, current name, Jev choice and probabilities when available, threshold, and action (`keep`, `generate`, or `skip`). Record `no_name` or `explicit_refresh` for a bypass. A failed or cancelled check uses `skip`, not a successful `keep`.
- `outcome`: result (`renamed`, `unchanged`, `failed`, or `cancelled`), stage, elapsed milliseconds, and safe failure category when applicable. Include previous and new names when the extension changes the name. An unchanged outcome covers both a Jev keep decision and generation of identical text.

Enqueue a decision after classification or bypass, before any generation. If cancellation or failure precedes a decision, enqueue a `skip` decision with the captured snapshot. Enqueue one outcome when the operation finishes locally. Ignore later provider results. Do not log start events, rename intentions, snapshot hashes, sequence numbers, policy versions, token usage, or cost estimates.

Jev does not produce a prose explanation. Do not invent one. The snapshot, choice, probabilities, threshold, and action provide the diagnostic evidence. Store only these allowlisted fields and safe failure categories, never credentials, HTTP headers, or raw provider errors.

Do not await log writes before inference or mutation. Catch write failures, report degraded logging in status, and use the shared warning policy. Naming and the primary agent continue. A failed write must not prevent attempts to write later records. Log callbacks use captured data and their original writer, not a stale Pi context. Only callbacks for the current runtime can update its logging health or show warnings.

These files explain the extension's operations, not the session's complete naming history. Do not reconcile earlier native name entries or record external changes as extension renames. An external change only needs to disable naming and cancel pending work.

A crash, shutdown, hung operation, or storage failure can leave missing records or an incomplete final line. There is no required shutdown flush deadline or recovery protocol. A decision without an outcome is not proof that a rename occurred. Native session entries remain the authority for the saved name.

The README must include simple `jq` examples for decisions and successful renames. No counters, cost accounting, or formal decision-quality review procedure are required.

### Cancellation and session lifecycle

Maintain a runtime epoch, a monotonically increasing generation number, and an abort controller. Capture the session ID, expected name entry ID, and generation number for each request.

A newer eligible request aborts and supersedes the previous operation, whether it is checking with Jev or generating with DeepSeek. A stale result cannot update the name, state, notification, or current request bookkeeping. Cancellation can enqueue diagnostic records through the captured original writer. Later provider results are ignored.

On `session_start`, replace runtime state and restore metadata. On `session_shutdown`, invalidate the runtime and cancel pending work. On `session_tree`, cancel pending work and retain session-wide naming ownership. On `session_compact`, cancel pending work without generating another name.

Before each pipeline transition, check the runtime epoch and generation number before accessing a captured context. Then check the abort signal, session identity, enabled flag, and latest name entry ID. Do not compare the current leaf ID with the request leaf. Normal assistant output advances the leaf during inference.

A cancelled provider can still finish remotely. Cancellation prevents local application, not necessarily provider charges. Cleanup from an old request must never clear the controller or timer for a newer request. Treat stale-context errors as cancellation, without a notification or another context access.

### Commands and errors

Register only `/auto-name`. Do not replace or alias `/name`.

- `/auto-name` or `/auto-name status`: show enabled/disabled, current name, latest result, log path, and logging health. Make no model request. The latest result includes the Jev probabilities when available, or a bounded failure category.
- `/auto-name on`: enable automatic updates for this session and adopt the current name entry as the baseline. On the next eligible input, check with Jev or generate directly if unnamed.
- `/auto-name off`: persist `enabled: false`, cancel pending work, and preserve the name.
- `/auto-name refresh`: enable updates and adopt the current name entry immediately, then generate from the latest projected user request without Jev. It can replace a manual name. Generation failure preserves the name but leaves updates enabled.

`refresh` invalidates previous work and uses the same generation guards. A manual rename, session change, or `/auto-name off` during refresh prevents application. Without a usable user request, report that no request is available. Preserve the name and leave updates enabled. If enabling cannot be persisted, disable naming in memory and do not start inference.

Automatic success is silent. Show at most one automatic failure warning per session runtime, shared across all failure categories and stages. Successful generation does not reset suppression. Explicit commands can report their own failures. Cancellation and supersession are silent. Status still shows the latest result and logging health after warning suppression.

Use four categories: `unavailable` for missing models or credentials, `timeout`, `invalid_response`, and `failed` for other errors. Include the stage (`classifier`, `generator`, `state`, or `audit`). Do not display raw provider responses, credentials, or input text.

No fallback model or extension-level retry is allowed. The next user request can attempt naming again. Provider billing remains authoritative. Do not claim that these background requests automatically appear in the main agent's cost totals.

## Alternative Approaches Considered

**Native first-request naming only:** smallest implementation, but the name becomes stale when the task changes. Rejected because the user wants automatic regeneration.

**Periodic naming after assistant turns:** reduces request volume and can describe results. Rejected in favor of a Jev check after every eligible user request.

**DeepSeek generation after every request:** simple, but pays for generation even when the existing name is still suitable. Jev detection is part of the initial release instead.

**A separate status line or recap panel:** avoids changing session names but duplicates an existing display. The user prefers the native `/name` behavior.

**An isolated agent session:** provides familiar agent APIs but adds resource loading and lifecycle work. A direct registry completion supplies everything this task requires.

**String-only manual rename detection:** simpler, but cannot distinguish a manual rename to the same text. Native name entry IDs provide that distinction.

## Phase 1: Jev Detection, Generation, and Logging Helpers

### Overview

Implement the bounded input builder, Jev policy, DeepSeek generator, and audit writer without registering the automatic extension. The existing Pi runtime remains unchanged.

### Changes Required:

#### 1. Detection and generation helpers
**Files**: `agent/extensions/auto-session-name/title.ts`, `agent/extensions/auto-session-name/decision.ts`
**Changes**: Implement shared input budgets, the Jev question and threshold, model requests, stage deadlines, response checks, and failure categories. Keep Pi session mutation outside these modules.

#### 2. Audit writer
**File**: `agent/extensions/auto-session-name/audit.ts`
**Changes**: Implement private per-run JSONL files, a serialized writer, and the two record types. Catch write failures and expose logging health without blocking naming. Expose an injectable writer for deterministic tests.

#### 3. Helper tests
**File**: `agent/extensions/auto-session-name/auto-session-name.test.cjs`
**Changes**: Follow the existing transpile-and-VM harness. Mock inference and time. Use temporary directories for audit tests and real in-memory Pi sessions for projection tests. Add no live network calls.

#### 4. Type-check coverage and log exclusion
**Files**: `agent/extensions/tsconfig.json`, `.gitignore`
**Changes**: Add `auto-session-name/**/*.ts` to TypeScript `include`. Ignore `agent/logs/auto-session-name/` without changing other exclusions.

### Success Criteria:

#### Automated Verification:
- [ ] Classifier, generator, and audit tests pass: `node --test agent/extensions/auto-session-name/auto-session-name.test.cjs`.
- [ ] Type checking passes: `npm --prefix agent/extensions run typecheck`.
- [ ] The existing generator remains unchanged: `node --test agent/extensions/handoff/handoff.test.cjs`.
- [ ] Whitespace checks pass: `git diff --check`.
- [ ] Tests prove exact model selection, classifier thresholds, disabled DeepSeek reasoning, no retries, and bounded input.
- [ ] Tests cover both stage deadlines, malformed probabilities, and late completion.
- [ ] Diagnostic fixtures parse as JSONL, include `keep` decisions, and exclude credentials and raw provider errors.
- [ ] Log exclusion works: `git check-ignore agent/logs/auto-session-name/test-session/test-run.jsonl`.

#### Manual Verification:
- [ ] Review classifier fixtures for ordinary continuations, changed objectives, and misleading existing names.
- [ ] Review generator fixtures for a first request and a clear task change.
- [ ] Check that selected context excludes forbidden message roles and reflects context edits.
- [ ] Inspect a sample decision/outcome pair and trace its input, probabilities, threshold, and final action.
- [ ] Check that phase one registers no extension and causes no live naming requests.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Native Session Integration

### Overview

Connect the Jev-to-DeepSeek pipeline to user input. Add durable ownership, diagnostic logging, commands, lifecycle cancellation, and documentation. This phase activates the complete extension through normal discovery.

### Changes Required:

#### 1. State and event handlers
**Files**: `agent/extensions/auto-session-name/state.ts`, `agent/extensions/auto-session-name/index.ts`
**Changes**: Implement the enabled flag, entry-ID ownership, restoration, input observer, pipeline, guards, native name application, and commands. Connect best-effort logging to decisions and outcomes.

#### 2. Lifecycle and persistence tests
**File**: `agent/extensions/auto-session-name/auto-session-name.test.cjs`
**Changes**: Extend the harness with deferred classifier and generator requests, session replacement, metadata events, audit failures, and mocked timers. Use real session entries where possible. Exercise both immediate and delayed metadata-event delivery.

#### 3. User documentation
**Files**: `agent/extensions/auto-session-name/README.md`, `README.md`
**Changes**: Document activation, both provider credentials, Jev policy, commands, ownership, request timing, disclosure, log retention, limits, failures, and removal. Explain best-effort logging and refresh enabling updates even after generation failure. Include simple `jq` examples. Add the extension to the repository overview.

### Success Criteria:

#### Automated Verification:
- [ ] All extension tests pass: `node --test agent/extensions/auto-session-name/auto-session-name.test.cjs agent/extensions/handoff/handoff.test.cjs agent/extensions/tests/*.test.cjs`.
- [ ] Type checking passes: `npm --prefix agent/extensions run typecheck`.
- [ ] Whitespace checks pass: `git diff --check`.
- [ ] Tests prove that input handlers finish while inference remains unresolved.
- [ ] Tests prove that manual renames and newer requests defeat every stale completion path.
- [ ] Tests prove that classifier requests, naming requests, audit records, and custom state do not enter the main model context.
- [ ] Tests prove that `keep`, uncertainty, and classifier failures never call DeepSeek.
- [ ] With a healthy writer, tests correlate decisions and outcomes for kept names, renames, failures, and cancellations.
- [ ] Tests prove that slow or failed log writes block neither inference nor mutation and report degraded logging.
- [ ] Tests prove that refresh enables updates before generation and leaves them enabled after generation failure.

#### Manual Verification:
- [ ] `/reload` discovers the extension without dependency or command conflicts.
- [ ] A first request generates the native name without Jev. A later request invokes Jev before any regeneration.
- [ ] The terminal title retains Pi's native formatting where the terminal supports it.
- [ ] The primary model begins work without waiting for the naming model.
- [ ] A clear topic change passes Jev and updates the name. Ordinary continuations retain it without DeepSeek requests.
- [ ] `/auto-name status` shows enabled/disabled, current name, latest result, log path, and logging health.
- [ ] Diagnostic files show Jev decisions and old/new names for extension renames. Reload does not replay naming history.
- [ ] A manual `/name` remains unchanged across further prompts, reload, and resume.
- [ ] A manual rename to the same text also pauses automatic naming.
- [ ] Steering and follow-up submissions exhibit the documented latest-submitted-intent behavior.
- [ ] Jev failure preserves the name without falling back to DeepSeek. Generation failure preserves the name. Log failure does not stop naming.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- Current-request prefix/suffix retention, chronological recent context, and the complete 6,000-character payload limit.
- Unicode limits, quoted names, valid technical names, blank output, overlong output, multiple lines, controls, and malformed provider responses.
- Exact model ID and payload reasoning override, including replacement of an existing high-effort reasoning object.
- Missing credentials or model, timeout, provider rejection, token-limit completion, and cancellation without fallback requests.
- Supported, malformed, and unknown state versions. Existing manual names, explicit blank names, and absent name entries.
- Jev `keep`, `rename` above the threshold, exact threshold equality, and `rename` below the threshold.
- Missing labels, unknown labels, inconsistent probabilities, NaN, infinity, invalid confidence, and classifier error responses.
- Decision and outcome fields, unique operation IDs, escaped newlines, private file permissions, and logging health after failed writes.

### Integration Tests:

- A request handler returns before its deferred inference promise resolves.
- Requests A and B finish in either order. Only B can apply. A's cleanup cannot clear B's state.
- An old provider ignores cancellation and eventually resolves or rejects. Its result has no effect and produces no extra outcome.
- A newer request arrives during Jev, between stages, or during DeepSeek. The superseded operation cannot rename.
- A Jev keep label, a below-threshold rename label, and a failed check produce diagnostic records and zero DeepSeek requests.
- Initial naming and explicit refresh bypass Jev and enqueue decision/outcome records.
- Log writes remain pending or fail during inference and mutation. Naming continues, failures update logging health, and later writes remain possible.
- A log callback from an old runtime cannot update the current runtime or use a stale Pi context.
- `/name` changes the name during automatic or explicit inference. The generated result cannot replace it.
- `/name` sets identical text. Its new native entry ID still disables automatic naming.
- Immediate and delayed self-generated metadata events do not disable the extension.
- Another metadata listener changes the name during event delivery. The extension yields ownership.
- `/new`, `/resume`, `/reload`, `/fork`, `/tree`, compaction, and shutdown invalidate pending work as specified.
- Resume restores the enabled flag without inference. Forked metadata enables updates only when ownership IDs still match.
- Tree navigation does not incorrectly interpret a session-wide automatic name as a branch-local manual rename.
- Projection respects omitted and replaced context entries, the latest compaction summary, and retained messages.
- An unchanged automatic name creates no duplicate name entry or redundant state entry.
- Extension-originated input, non-TUI modes, and image-only input make no naming request.
- State persistence failure disables automatic replacement. A failure never changes the primary transcript or model.
- Manual renames and `off` both restore as disabled. `on` adopts the current name without inference.
- Refresh enables updates before inference. Failed generation or missing request text preserves the name and leaves updates enabled.
- A manual rename or `off` during refresh disables updates and defeats its pending result.
- Automatic failures warn at most once per runtime. Success does not reset suppression.
- Separate runs use separate log files. Attachment does not replay historical name entries.

### Manual Testing Steps:

1. Reload Pi after phase two.
2. Start an unnamed session and request research on a concrete feature.
3. Check the short native name while the primary model continues.
4. Submit `yes, write the implementation plan` and inspect the Jev decision. A suitable existing name stays unchanged without DeepSeek.
5. Change the topic and check that Jev triggers regeneration. Inspect the decision probabilities and the outcome's previous/new names.
6. Run `/name Fixed review session`, then submit another request.
7. Check that the fixed name survives `/reload` and session resume.
8. Run `/auto-name on`, then submit a request and check that updates resume.
9. Run `/auto-name off` and check that further requests preserve the name.
10. Run `/auto-name refresh` and check that it enables updates before generation. Simulate generation failure and check that updates remain enabled.
11. During each model stage, rename the session or switch sessions. Check for stale name changes and inspect cancellation records.
12. Inspect one live generation payload through a controlled adapter to check disabled reasoning and the context budget.
13. Run `/auto-name status` and copy its log path to `LOG` in a shell.
14. Inspect decisions with `jq 'select(.event == "decision")' "$LOG"`.
15. Inspect renames with `jq 'select(.event == "outcome" and .result == "renamed")' "$LOG"`.
16. Simulate a log write failure. Check that status reports degraded logging while naming and the primary agent continue.

Live checks can incur TypeSafe and OpenRouter charges. Automated tests must not make network requests. Record observed latency during manual checks rather than promising a provider response time.

## Performance Considerations

Each eligible named-session submission attempts one Jev request and at most one DeepSeek request. Initial naming and explicit refresh make only the DeepSeek request. No request occurs on tool events or ordinary assistant output.

Each model receives the bounded 6,000-code-point snapshot plus its fixed question or instructions. DeepSeek output is bounded at 64 tokens. Jev has a three-second deadline and DeepSeek has a ten-second deadline. Log writes run independently of model deadlines. The main agent waits for neither model.

The goal is fewer DeepSeek requests, not necessarily fewer total requests or lower cost. Both providers can charge for requests. This extension does not track usage or estimate savings.

Pi's projection can traverse the current session history. The payload bound does not imply constant-time history traversal. Build one projection per request and no projections during UI rendering. Do not serialize excluded tool output.

Persistent ownership state is small. A changed automatic name adds one native name entry and one ownership entry. Unchanged results add neither. Each check enqueues diagnostic records without waiting for disk writes. Runtime state remains local to each Pi process.

Diagnostic files grow with checks and contain bounded context snapshots. A serialized asynchronous writer prevents interleaved lines. Logging never blocks inference or native name changes.

## Migration Notes

No session rewrite or settings migration is required. Old unnamed sessions receive automatic names on their next eligible request. Existing named sessions keep updates disabled unless the user runs `/auto-name on` or `/auto-name refresh`.

The initial version requires TypeSafe credentials for `typesafe/jev-latest` and OpenRouter credentials for DeepSeek. Missing Jev access preserves existing names and reports the classifier failure. It does not silently revert to generation on every request. Audit files are new local artifacts, excluded from Git. Removing the extension does not delete them.

The extension preserves ordinary Pi names after removal. To stop automatic naming globally, move its directory outside the discovery path and reload Pi. Renaming only the directory is insufficient because Pi discovers subdirectories containing `index.ts`.

Do not run another automatic naming extension concurrently. The ownership checks yield to external changes, but two naming extensions do not share an ownership protocol.

A crash between the native rename and ownership persistence can leave an unowned name. Restoration pauses conservatively. `/auto-name on` restores automatic updates without rewriting history.

## References

- User request: specify a personal extension that uses native `/name` behavior, Jev detection, and basic decision/rename logging. Approved simplifications replace audit guarantees with best-effort diagnostics, remove history replay, and merge manual/off state into one enabled flag.
- Classifier integration and credentials: `docs/codemode-and-jev.md:99-180`.
- Pi classifier guide: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md`.
- Pi classifier example: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/jev-router.ts:67-88`.
- Classifier result contract: `agent/extensions/node_modules/@earendil-works/pi-ai/dist/types.d.ts:448-497`.
- Local generation pattern: `agent/extensions/handoff/index.ts:55-96`.
- Local test pattern: `agent/extensions/handoff/handoff.test.cjs:11-151`.
- Pi extension guide: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.
- Pi session semantics: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md`.
- Pi UI guide: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`.
- `pi-title` inspected revision: `902fa197075520f48c37bc7879f06334af1b3ebd`.
- `pi-sessions` inspected revision: `68a634990477b60fbec63504d95ad1932917469a`.
- `pi-auto-session-name` inspected revision: `19a83557d77638a25b065755be6779eaad901101`.
- `@nerisma/pi-auto-title` inspected revision: `efbaf9afd86623dceafb8e20d17140cf061d94d4`.
