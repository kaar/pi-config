# Pi handoff: alternatives, architectural differences, and improvement ideas

**Research date:** 2026-10-04. **Scope:** Nine comparable extensions, skills, and protocols. **Status:** Research and proposals, not an implementation plan.

## Summary

Your extension is a focused **draft-transfer workflow**: summarize the active context, open another Pi process, and let the user edit before submission. Most alternatives instead emphasize durable checkpoint files, same-process session replacement, or a receiving-side resume procedure.

The best improvements do not require a larger orchestration framework:

1. Preserve the exact user goal separately from the generated summary.
2. Record source provenance and a small, deterministic snapshot of the repository state.
3. Make verification status, rejected approaches, and unanswered questions explicit.
4. Preserve the generated draft when launch fails, without changing the source editor.
5. Measure successor understanding, not only successful CLI calls.

Keep the strongest existing properties: explicit submission, an unchanged source session, generation before pane creation, and no silent provider fallback.

**Reading guide:** Sections 1–3 explain the current implementation and alternatives. Section 4 contains a prioritized checklist. Sections 5–8 cover architectural choices, evaluation, and cautions.

## 1. What your extension actually does

### Current flow

```text
/handoff <goal>
  → require interactive Pi inside Herdr
  → wait for the source agent to become idle
  → capture the source model
  → obtain Pi's current session projection
  → convert and serialize the projected messages
  → summarize with a dedicated OpenRouter model
  → create a right-hand pane in the same working directory
  → start a fresh Pi process with the captured source model
  → paste the generated prompt without Enter
  → focus the destination and send Ctrl+G
  → user edits, closes the editor, and explicitly submits
```

The generator is fixed to `openrouter/deepseek/deepseek-v4.1-flash`. The request disables reasoning, disables cache retention, and uses a fresh request session ID. The source session ID appears in an OpenRouter header, but the extension does not create a successor-parent link. [L1]

The prompt asks for relevant context, files, current state, and a clear next task. The example headings are `Context`, `Current state`, and `Task`. These are prompt instructions, not a validated output contract. [L1]

The extension passes the current directory and model to the successor. It does not explicitly transfer the thinking level, active tool selection, source-session identity, or runtime-only extension state. Fresh Pi configuration supplies the destination environment. [L1, L2]

### Strengths worth preserving

- **A real review gate.** No destination model turn starts through this command. Editor closure is not approval to execute.
- **Source preservation.** The command does not replace the source session or overwrite its editor.
- **A stable snapshot boundary.** The command waits for idle before reading the model and context.
- **Canonical projection.** `buildSessionProjection()` respects compaction and context edits. It avoids reconstructing current context from raw history.
- **Separate generator and worker models.** Handoff generation does not require another turn from the implementation model.
- **Clear sequencing.** Every Herdr command completes before the next begins. Generation failure creates no pane.
- **Literal process arguments.** The adapter does not interpolate the prompt into a shell command.
- **Good failure-path coverage.** Local tests cover cancellation, compaction, command ordering, literal text, and failures at each transport stage.

I ran `node --test agent/extensions/handoff/handoff.test.cjs`: **67 passed, zero failed**. These tests use mocked model requests and Herdr calls. They do not establish live paste consumption or summary quality. [L3]

### Important boundaries and gaps

| Area | Current behavior | Consequence |
|---|---|---|
| Input history | Latest projected context, not complete raw history | Earlier omissions cannot be recovered by the summarizer alone |
| Tool output | Pi serializes at most 2,000 characters per tool result | Important evidence near the end of a result can disappear |
| Other serialized content | Tool-call arguments remain; available thinking blocks are included | Input size and disclosure are broader than visible assistant prose |
| Repository facts | No independent Git snapshot | The summary can repeat stale conversation claims about the tree |
| Goal | The model rewrites the requested next task | Exact scope and authorization depend on model fidelity |
| Output checks | Rejects errors, aborts, and blank text | Non-empty but incomplete or structurally poor output can pass |
| Durability | No handoff-specific saved artifact | A pre-paste launch failure loses the generated text from this workflow |
| Lineage | No explicit parent session or source leaf in the successor | Recovering omitted evidence requires manual source discovery |
| Destination editor | Always sends `ctrl+g` | Rebound or disabled external-editor bindings need manual action |
| Launch result | Successful CLI calls, then a notification | Shortcut delivery does not prove editor startup or complete draft consumption |
| Workspace | Both agents use the same directory | A fresh session is not an isolated worktree |

These are design boundaries, not all defects. In particular, strict fail-fast behavior and an unchanged source are deliberate choices. [L1–L3]

**Serialization detail:** Disabling reasoning on the generator does not strip thinking blocks already present in its input. Pi's installed serializer includes those blocks. Preserve conclusions and evidence rather than transferring internal reasoning. [P2]

**Version detail:** The installed Pi is 1.0.1. The extension-local dependency used by the test harness is 0.99.1. Both serializers contain the 2,000-character limit and thinking-block serialization.

**Documentation drift:** The earlier generation/editor plan describes Nitro routing, configurable editor shortcuts, and source-draft recovery. Current code does none of those. The separate layout-aware split plan also remains absent from the inspected implementation. This report uses code and current tests as the baseline. [L4]

## 2. Comparison at a glance

“Human gate” identifies the reviewed workflow's stopping point. Skill instructions express intended behavior; they are not equivalent to runtime enforcement.

| Approach | Generation and input | Transfer and storage | Human gate | Most useful difference |
|---|---|---|---|---|
| **Your extension** | Dedicated model; projected conversation + goal | New Herdr pane; destination draft | Explicit Enter after editing | Source stays open and unchanged |
| **Pi official example** | Active model; compacted branch context + goal | Same-process `newSession`; parent link | Edit before switch, then submit | Native lineage without a multiplexer |
| **javapacr/pi-handoff** | Detached model call or active-agent skill; Git, tasks, documents | Inline first message; session-backed recovery | Starts successor work on launch | Two generation paths share one contract |
| **ttiimmaahh/pi-handoff** | Cheap/configured model; threshold or command | `.pi/handoff.md`; optional load and compaction hook | Confirms startup load | Proactive checkpointing with debounce |
| **HumanLayer commands** | Current agent writes a referenced document | Timestamped handoff files and thoughts sync | Resume checks state, proposes work, asks approval | Resume is a first-class procedure |
| **jumpifequal/handoff-skill** | Current agent; schema, evidence labels, exact WIP | Portable Markdown; producer and intake modes | Intake applies normal authorization | Structural validation and explicit trust boundary |
| **orzilca/agent-handoff-skills** | Current agent; compact rationale and state | Shared cross-agent handoff directory | Continue briefs, then stops | Context loading is separate from work approval |
| **jdmnk/context-checkpoint-skill** | Current agent; explicit checkpoint request | Updated `AGENT_CONTEXT.md` | User controls checkpoint creation | Bounded, current project state |
| **Entire session-handoff** | Receiving agent retrieves stored transcripts | Entire CLI sessions and checkpoints | Continues unless an unanswered question blocks it | Recovery without a prepared handoff |
| **Handover protocol and skills** | Structured continuity record and referenced evidence | JSON contract; separate service workflow | Workflow-specific permissions and review | Revision-aware records and continuity evaluation |

## 3. Detailed comparisons

### 3.1 Pi's official `handoff.ts`: native session replacement

**Observed behavior.** The example generates with the active model. It gathers the latest compaction summary and retained branch messages. It opens `ctx.ui.editor()` before switching sessions. Then it calls `ctx.newSession({ parentSession, withSession })` and places the edited prompt in the replacement editor. It does not submit the draft. [P1]

**Difference from yours.** Your review happens in the destination, after a separate process starts. The official example reviews before replacement and needs no multiplexer. Your source stays visible; its source remains saved but is no longer the active session.

**Ideas to borrow:** Parent-session provenance and an optional same-pane destination. Neither requires copying the official example's entire context-gathering implementation.

**Trade-off:** Restoring source-side review reverses your deliberate removal of a redundant review step. Keep destination editing as the default.

**Code caution:** Your use of the canonical projection is preferable to manually rebuilding compaction context. Raw branch scans can miss newer context-edit semantics.

### 3.2 `javapacr/pi-handoff`: two producers, one continuation contract

**Observed behavior.** This extension supports two paths: [J1–J4]

- A **detached path** generates a handoff through a separately configured model, then creates the successor session.
- An **active-agent path** uses a skill to fill a shared template and call `continue({ document })`. The tool validates the text and stages `/continue`.

The command recovers the newest `continue` tool-call document from the active branch. Session JSONL supplies the recovery record; no separate handoff document is necessary. Both paths use a shared session creator with `parentSession` and a hidden `handoff-origin` message.

Context gathering adds Git state, tasks, document files, skills, and the working directory. Document tracking combines Git changes with write/edit calls. A filter removes selected low-value tool traffic from a cloned message list. [J2, J3]

The detached flow preserves generated text through clipboard and stderr recovery when validation or session creation fails. The template requires a non-empty `Next Task` section. The active-agent tool can return repair instructions and accept a corrected document. [J1, J4]

**Difference from yours.** Its terminal integrations submit a staged command; they do not reproduce your separate-pane draft workflow. Its shared session creator replaces the active Pi session and sends the first user message immediately.

**Ideas to borrow:** Deterministic metadata, explicit source lineage, one contract across generation modes, and recovery of already-generated text.

**Trade-offs:** An active-agent path changes the source transcript and can invoke tools. It does not preserve your current source-immutability guarantee. Clipboard and stderr recovery also expose sensitive content to more surfaces.

**Source correction:** Search results described a file-based artifact flow. Parts of the README still mention it. Current command and session-creator code use inline documents instead.

### 3.3 `ttiimmaahh/pi-handoff`: proactive checkpoints and compaction integration

**Observed behavior.** A `turn_end` watcher checks context usage. The default threshold is 80%, with percentage and absolute-token configuration. Successful generation is debounced: percentage mode refreshes after another five percentage points. [T1, T2]

It writes a structured `.pi/handoff.md` with source session, generation time, models, and usage metadata. It uses restrictive permissions. Startup offers a recent handoff from another session, with a 24-hour freshness window. [T2]

A load queues a one-shot `context` transformation. The handoff reaches the next model request but does not become a persisted session entry. Optional compaction enrichment replaces Pi's summary with the same section structure and retains file-operation information. [T1, T2]

**Difference from yours.** This is a checkpoint system, not a pane launcher. It prepares context before the user asks to leave. Your command instead targets a specific next goal.

**Ideas to borrow:** An optional context-pressure reminder, metadata, a user-selected generator, and explicit freshness checks.

**Trade-offs:** Automatic generation adds background calls and cancellation/concurrency concerns. A single file can be overwritten by another session in the same directory. One-shot injection cannot be reconstructed as an explicit handoff entry after restart.

**Compatibility caution:** Its README specifies Pi 0.80.9–0.80.x. Treat it as an architectural reference, not a confirmed drop-in package for your current Pi.

### 3.4 HumanLayer `create_handoff` / `resume_handoff`: validate the present, not only summarize the past

**Observed behavior.** Creation writes timestamped, ticket-scoped Markdown with Git commit, branch, task status, critical references, changes, learnings, artifacts, and next actions. It uses HumanLayer's metadata and thoughts-sync workflow. [H1]

Resume reads the handoff and linked plans in full. It inspects current files, compares recorded state with present state, and proposes an action. Implementation follows user approval. [H2]

**Difference from yours.** Your extension prepares a first prompt but imposes no dedicated receiving procedure. HumanLayer treats recovery and reconciliation as substantial work.

**Ideas to borrow:** A small “read first” list, Git provenance, explicit phase status, and a drift check before changes.

**Trade-off:** Its full resume procedure can cost too much for an immediate handoff to the adjacent pane. A small check of HEAD and relevant files is a better default than rereading every artifact.

**Provenance note:** The discovered `acampb/claude-rpi-framework` repository downloads these commands from HumanLayer. The comparison uses the upstream command files, not the installer description.

### 3.5 `jumpifequal/handoff-skill`: a portable contract with explicit uncertainty

**Observed behavior.** The skill defines both producer and intake behavior. Its template carries schema version, origin, source surface, timestamp, status, and optional continuation-chain fields. A validation script checks required metadata and a real next step. [U1, U2]

Content rules preserve decisions with reasons, rejected paths, exact work-in-progress, and one concrete next action. Claims carry evidence or an explicit unverified label. Inherited claims do not become newly verified merely through repetition.

Intake treats the handoff as **untrusted continuity data**, not a higher-priority instruction. A structurally valid artifact does not establish authorization. The skill also distinguishes curated handoffs from degraded fallback output. [U1, U2]

**Difference from yours.** Your output is free-form text with only a non-empty check. This skill defines what the receiver can expect and what uncertainty means.

**Ideas to borrow:** A lightweight schema, explicit unknowns, evidence labels, degraded status, and continuation-chain provenance.

**Trade-off:** Copying all WIP verbatim can be wasteful for your shared-filesystem case. Preserve exact text only when it exists nowhere durable. Reference repository files instead.

### 3.6 `orzilca/agent-handoff-skills`: concise preparation and a strict briefing-only resume

**Observed behavior.** Preparation writes a project-local handoff with next steps first. It targets at most 60 lines, with a hard cap of 100. It records rationale, rejected approaches, verification status, gotchas, Git state, and open questions. [O1]

Preparation explicitly forbids “one last fix,” commits, or fresh test runs. It records what the session already established. Continuation reads only the handoff, gives a briefing, and stops. It does not inspect the repository or start step one. [O2]

**Difference from yours.** Your draft review happens before the successor's first turn. This workflow adds a briefing after context ingestion, before any work authorization.

**Ideas to borrow:** Separate handoff preparation from implementation. Put the next action early. Preserve uncertainty rather than rerunning work during generation.

**Trade-off:** Its no-inspection resume policy conflicts with HumanLayer's validate-first policy. These are alternatives, not features to combine blindly. A briefing-only mode fits a changed goal; a small drift check fits direct continuation.

### 3.7 `jdmnk/context-checkpoint-skill`: one current project-state file

**Observed behavior.** This explicit-request-only skill creates or updates `AGENT_CONTEXT.md`. It replaces stale information rather than endlessly appending. The document includes a freshness timestamp, status, constraints, evidence, decisions, risks, rejected approaches, and a resume prompt. The target is roughly 200 lines. [C1]

It also adds a reminder to an existing agent-instruction file, without creating a new instruction file automatically.

**Difference from yours.** This preserves durable project state, not just a task-specific prompt. It works across sessions and tools without a launcher.

**Ideas to borrow:** A short stable checkpoint can complement a goal-specific handoff. Keep reusable decisions separate from temporary next-task instructions.

**Trade-offs:** A shared file needs an ownership policy for concurrent branches and agents. Automatic changes to `AGENTS.md` expand scope and can make stale context load in unrelated sessions.

### 3.8 Entire `session-handoff`: receiver-side recovery from transcripts

**Observed behavior.** The receiving agent uses Entire CLI to select a session, retrieve its transcript, and summarize it. The skill also handles checkpoints containing several sessions. It preserves unanswered questions and asks them instead of choosing an answer. [E1]

This is a **pull workflow**. The previous agent does not need to prepare a handoff before it stops.

**Difference from yours.** Your source performs selection and summarization, then pushes the result into a known destination. Entire can recover after the source disappears.

**Ideas to borrow:** A recovery command that accepts an explicit source session ID, plus an “unanswered user question” field.

**Trade-offs:** The inspected skill samples transcript beginnings and endings. This can miss decisions in the middle. It can also fall back to sessions outside the current worktree scope. An explicit ID is safer than “latest session” selection.

**Do not copy directly:** Its JSONL extraction examples use text matching and line truncation. Use a real JSONL parser and Pi's branch semantics. Recovery from raw history must not silently restore context that the source deliberately omitted.

### 3.9 Handover's record format and continuity tests: separate data, transport, and evidence

**Observed behavior.** The Handoff Continuity Record defines objective, acceptance criteria, state, decisions, evidence references, constraints, next action, next actor, and review state. Its JSON contract explicitly excludes storage, transport, authentication, and routing. [V1]

The associated service test distinguishes three outcomes: connectivity, successful publication/read-back, and actual successor continuity. It checks exact artifact contents, stale revisions, and recovery by a fresh session without the original chat. [V2]

**Difference from yours.** Your extension combines summary generation and terminal delivery. It reports delivery-stage success, while semantic continuity remains a manual check.

**Ideas to borrow:** A small transport-independent handoff record, optional evidence hashes, and separate delivery and continuity metrics.

**Trade-off:** The full multi-user service, permissions, annotations, and revision workflow are excessive for a personal local extension. Borrow the separation and test principles, not the infrastructure.

## 4. Improvement checklist

These are proposals inferred from the comparison. Effort estimates are relative: **small**, **medium**, or **large**. “First” means high value without changing the core workflow.

### First: improve the handoff content and preserve existing guarantees

- [ ] **1. Keep the exact user goal outside model-authored context.** Compose an extension-owned `Requested task` section from the original argument. Let the model summarize only supporting context. This reduces scope drift and preserves the current request. **Effort: small.** Inspiration: explicit task contracts in [U1, V1].
- [ ] **2. Add a compact content contract.** Require current state, constraints, decisions with reasons, verification status, unresolved questions, and next action. Omit genuinely empty sections. This improves consistency without requiring a large JSON schema. **Effort: small.** Inspiration: [H1, U1, O1].
- [ ] **3. Preserve unanswered questions and rejected approaches.** State what still needs the user's answer and why a prior approach failed. Do not invent an answer to make the handoff look complete. **Effort: small.** Inspiration: [E1, U1, O1].
- [ ] **4. Add deterministic provenance.** Record a handoff ID, timestamp, source session ID/path, source leaf, working directory, and generator identity. Compute these fields in code. Keep them outside the source transcript if source immutability remains strict. **Effort: small–medium.** Inspiration: [P1, J1, U2].
- [ ] **5. Add a bounded repository snapshot.** Capture repository root, branch, HEAD, and changed/untracked paths. Label these as observed facts, not model claims. Avoid full diffs by default. **Effort: medium.** Inspiration: [J2, H1, O1].
- [ ] **6. Rescue the generated draft without overwriting the source editor.** Offer a private local artifact or explicit export after a launch failure. Keep the handoff ID and any created pane ID. Do not silently copy sensitive text to the clipboard. **Effort: medium.** Inspiration: [J4, T2].
- [ ] **7. Detect incomplete generation.** Reject or clearly label length-limited responses. Validate the next-task section and basic content before creating a pane. Current code accepts non-empty output with stop reasons other than `error` or `aborted`, including `length`. **Effort: small.** Inspiration: [J4, U2].
- [ ] **8. Add a semantic fixture suite.** Evaluate what a fresh receiver understands, including constraints and verification gaps. The existing mocked transport tests remain valuable but answer a different question. **Effort: medium.** Inspiration: [V2].

### Next: improve control, diagnosis, and privacy

- [ ] **9. Make disclosure explicit.** Show the summarizer provider and model. Strip internal reasoning from handoff inputs and exclude known secret-bearing data before the external request. Output-only redaction is too late to prevent provider disclosure. **Effort: medium.** Inspiration: [T1, U1, C1]; local serializer finding [P2].
- [ ] **10. Add a generator input budget.** Account for the summarizer's context window, not only the source model's. Preserve constraints, failures, and relevant evidence before low-value output. Report omitted material. **Effort: medium.** Inspiration: [J3, O1].
- [ ] **11. Make the generator configurable without silent fallback.** Retain today's fixed default and fail-fast behavior. Offer explicit alternatives for availability, privacy, or quality. Show the actual chosen model. **Effort: small–medium.** Inspiration: [J2, T1].
- [ ] **12. Record stage timings and outcome.** Separate generation, Pi startup, paste, focus, and shortcut delivery. Record counts and timings rather than prompt contents. Compare quality alongside latency. **Effort: small.** Inspiration: [J4, V2].
- [ ] **13. Clarify partial success.** Distinguish “draft generated,” “draft sent,” and “editor shortcut delivered.” If focus or shortcut delivery fails after paste, report the usable destination rather than only a generic failure. **Effort: small.** Inspiration: [V2] and your existing failure boundaries.
- [ ] **14. Make destination configuration deliberate.** Offer thinking-level carry-over and binding-aware editor activation only where Pi exposes supported APIs. Do not assume that passing the model copies all runtime state. **Effort: medium.** Local gap: [L1, L2].
- [ ] **15. Add a small receiving checklist.** Before edits, inspect the critical references and compare current HEAD with the recorded snapshot. Escalate to broader reconciliation only when relevant state changed. **Effort: small–medium.** Inspiration: [H2, V1].
- [ ] **16. Warn about shared-worktree concurrency.** A source-preserving pane is still a second agent with access to the same files. Make ownership clear before both agents start editing. Separate worktrees can remain an explicit advanced option. **Effort: small for guidance; large for worktree management.** Derived from [L1, H2].

### Optional architecture changes

- [ ] **17. Support export without launch.** Use the same handoff record for a Herdr draft, a Markdown export, or a same-pane session. Add adapters only for real workflows. **Effort: medium.** Inspiration: [P1, U1, V1].
- [ ] **18. Add a warm generation mode.** Let the active agent prepare the same contract through a skill and a validated tool. Keep detached generation available. Benchmark both; cache reuse does not guarantee lower total cost. **Effort: large.** Inspiration: [J1]. This changes the source transcript guarantee.
- [ ] **19. Add a context-pressure nudge, not an automatic handoff.** Start with a notification. Only add background checkpoint generation after measuring its cost and stale-write behavior. **Effort: small for a nudge; medium–large for snapshots.** Inspiration: [T2].
- [ ] **20. Add source-session recovery.** Accept an explicit source session and leaf when the original pane is unavailable. Reconstruct the projected branch and retrieve omitted evidence only on demand. **Effort: large.** Inspiration: [E1, P2].
- [ ] **21. Add destination acknowledgement if transport becomes unreliable.** A destination helper can read a private record, set its own editor through Pi APIs, and acknowledge the draft hash. This requires a separate protocol; it is not an existing guarantee of Herdr CLI success. **Effort: large.** Inspiration: [V2].
- [ ] **22. Add stable checkpoint references for repeated handoffs.** Keep durable decisions and canonical artifacts outside successive summaries. Carry links and evidence status forward without upgrading inherited claims. **Effort: medium–large.** Inspiration: [C1, U2].

**Suggested first selection:** 1, 2, 4, 6, 7, and 8. Add 5 and 15 if stale repository state is a recurring problem. Add 9 before broadening provider choice or persistence.

## 5. Three architectural directions

### A. Keep the current workflow and enrich the record

```text
projected context + exact goal + small metadata snapshot
  → bounded summary
  → structural checks
  → optional private recovery record
  → existing Herdr draft delivery
  → explicit user submission
```

This is the recommended direction. It preserves your interaction model while improving content quality and recoverability. The extension can remain small.

A recovery record introduces retention and permissions requirements. It does not require changing the source transcript, adding a background watcher, or building a general resume service.

### B. Separate preparation from delivery

```text
prepare handoff record
  → Herdr draft adapter
  → same-pane Pi adapter
  → Markdown export adapter
```

The record contains exact user intent, generated context, deterministic metadata, and evidence references. Delivery does not need to regenerate it.

This helps with retries and cross-agent use. It also adds schema versioning, storage cleanup, and adapter-specific behavior. Implement it only when a second destination is useful.

### C. Build a checkpoint and resume system

```text
explicit or threshold checkpoint
  → durable checkpoint store
  → source selection
  → drift assessment
  → resume briefing or approved work
```

This addresses crash recovery, multi-day work, and cross-tool continuity. It is a different product scope from an adjacent-pane handoff.

Its costs include stale checkpoints, concurrent writers, permission boundaries, retention, and automatic external calls. A single mutable file is insufficient once several sessions share a worktree.

## 6. Trade-offs that cannot be solved by adding every feature

### Self-contained text versus artifact references

A self-contained prompt works without local files but duplicates context and can become stale. References save tokens and preserve exact artifacts, but depend on access.

For your same-directory workflow, use a hybrid: short context, exact requested task, and a prioritized “read first” list. Embed only ephemeral material that lacks a durable location. [J2, H1, U1, O1]

### Fast resume versus present-state validation

Orzilca stops after a handoff-only briefing. HumanLayer inspects current state before seeking approval. Entire usually starts work immediately.

These represent different authorization policies. Preserve your explicit Enter gate. After submission, make the requested task decide whether the receiver briefs, checks state, or implements. [O2, H2, E1]

### Cheap detached summary versus active-agent preparation

Your detached call avoids changing the source conversation and can use a cheaper model. Active-agent preparation can reuse available context and tools but adds another source turn.

Measure wall time, input cost, output quality, and extra tool work together. A cheaper model is not automatically cheaper when it rereads a long uncached history. [L1, J1]

### Durable recovery versus source immutability

Pi custom entries can persist non-context metadata, but they still change the source session. A tool-call-backed handoff changes it even more.

If immutability means no source-session writes, keep recovery records outside that session. Record successor provenance in the destination or an external private record. [P2, J1]

### Automation versus trustworthy stopping points

Automatic generation can preserve context before compaction. Automatic submission also removes your strongest human gate.

Treat checkpoint creation and work execution as separate policies. A context threshold is not permission to launch another agent or start its next task. [T2, O2]

## 7. How to evaluate improvements

### Three independent success levels

1. **Generation:** The model returns usable context without inventing state or changing the requested task.
2. **Delivery:** The intended destination receives the complete draft and does not submit it.
3. **Continuity:** A fresh receiver identifies the right objective, constraints, unresolved questions, and first action.

Your automated suite covers substantial parts of delivery orchestration and failure handling. It does not prove all three levels. Handover's evaluation separation is useful even without its service. [L3, V2]

### Suggested fixture set

| Fixture | Required outcome |
|---|---|
| Compacted session | Preserve the latest summary and retained decisions; exclude superseded material |
| Context-edited branch | Respect replaced or omitted entries; avoid raw-history resurrection |
| Failed test near a long result's end | Preserve failure status or explicitly mark missing evidence |
| Dirty tree with unrelated user files | Identify relevant work without claiming ownership of every changed file |
| Research-only goal after coding | Keep research scope; do not turn the task into implementation |
| Unanswered user question | Preserve the question; do not choose an answer |
| Rejected approach | Preserve the reason and any condition for reconsideration |
| Length-limited generation | Stop before pane creation or clearly mark incomplete output |
| Split/start/paste failure | Keep generated text recoverable; preserve the source editor |
| Focus/shortcut failure after paste | Identify the existing usable destination; avoid duplicate launch |
| Long Unicode draft with a final sentinel | Confirm complete destination content, including the final line |
| Three successive handoffs | Do not lose constraints or upgrade inherited claims to verified facts |
| Branch/HEAD changes before submission | Surface the mismatch before edits |
| Embedded hostile instructions | Treat copied context as data; preserve current authority and permissions |

Use synthetic credentials in privacy fixtures. Do not send real secrets to evaluate redaction.

### Metrics

- Generation time and total time until the draft is editable.
- Input/output tokens and billed cost where available.
- Required-fact recall against a human-authored fixture checklist.
- Unsupported claims and changes to the exact requested task.
- User edits needed before submission.
- Time until the successor performs the first correct action.
- Recovery success after each failure stage.

Run comparisons on the same source snapshot and goal. Separate cheap structural tests from paid model evaluations and live terminal checks. No paid generation tests or live pane creation occurred during this research.

## 8. What not to copy by default

- **Automatic submission.** It conflicts with your explicit review workflow.
- **Broad provider fallback.** Availability does not justify an unannounced privacy or cost change.
- **One global “latest handoff.”** Concurrent sessions need explicit identity and scope.
- **One-shot hidden context as the only record.** Request-local context is not a durable resume history.
- **Full transcript transfer.** It recreates the context-size problem and increases disclosure.
- **Claims of lossless summarization.** These workflows can omit information. Some additionally truncate inputs before generation.
- **Heavy memory or task-system dependencies.** They add value only when those systems are part of your actual workflow.
- **Automatic instruction-file edits.** Handoff creation need not change project policy.
- **Retrying side effects without identity.** Repeating a pane split can create duplicate successors. Prefer explicit recovery tied to a handoff and pane ID.
- **Blindly preserving old decisions.** Record reasons and reconsideration conditions, not permanent prohibitions against new evidence.

## 9. Sources and evidence limits

Sources were checked on 2026-10-04. External repositories were inspected at the revisions below. Skills describe intended agent behavior; they do not establish model compliance. External packages were not installed or executed. This is not a benchmark or security audit.

The [chronological source log](pi-handoff-comparison-sources.md) records discovery queries, repository snapshots, inspection actions, and corrections to search descriptions.

### Local baseline

- **[L1]** [Extension implementation](../../agent/extensions/handoff/index.ts) and [Herdr adapter](../../agent/extensions/handoff/herdr.ts).
- **[L2]** [Current README](../../agent/extensions/handoff/README.md).
- **[L3]** [Local tests](../../agent/extensions/handoff/handoff.test.cjs). Executed during this research: 67 passed.
- **[L4]** [Earlier generation/editor plan](../plans/2026-09-29-handoff-fast-generation-and-editor.md) and [split-direction plan](../plans/2026-10-02-handoff-split-direction.md). Historical intent, not current behavior.

### Pi references

- **[P1]** [Official handoff example](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/examples/extensions/handoff.ts). Inspected the installed Pi 1.0.1 example.
- **[P2]** [Extension API](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/extensions.md), [session format](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/session-format.md), [compaction reference](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/compaction.md), and [serializer source](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/src/core/compaction/utils.ts). Installed documentation and runtime code inspected; serializer behavior also checked in the local 0.99.1 dependency.

### Comparable implementations

- **[J1]** javapacr, revision `f0bc7f3`: [continue tool](https://github.com/javapacr/pi-handoff/blob/f0bc7f330d906025c1084fec75418ae099fb052c/tools/continue.ts), [continue command](https://github.com/javapacr/pi-handoff/blob/f0bc7f330d906025c1084fec75418ae099fb052c/commands/continue.ts), and [session creator](https://github.com/javapacr/pi-handoff/blob/f0bc7f330d906025c1084fec75418ae099fb052c/application/session-creator.ts).
- **[J2]** Same revision: [context gatherer](https://github.com/javapacr/pi-handoff/blob/f0bc7f330d906025c1084fec75418ae099fb052c/application/context-gatherer.ts), [Git adapter](https://github.com/javapacr/pi-handoff/blob/f0bc7f330d906025c1084fec75418ae099fb052c/infrastructure/git-client.ts), [template](https://github.com/javapacr/pi-handoff/blob/f0bc7f330d906025c1084fec75418ae099fb052c/domain/handoff-template.ts), and [generator](https://github.com/javapacr/pi-handoff/blob/f0bc7f330d906025c1084fec75418ae099fb052c/application/prompt-generator.ts).
- **[J3]** Same revision: [tool filter](https://github.com/javapacr/pi-handoff/blob/f0bc7f330d906025c1084fec75418ae099fb052c/infrastructure/tool-skip.ts).
- **[J4]** Same revision: [handoff executor](https://github.com/javapacr/pi-handoff/blob/f0bc7f330d906025c1084fec75418ae099fb052c/application/handoff-executor.ts). Code takes precedence over contradictory README passages.
- **[T1]** ttiimmaahh, revision `7bb4a2b`: [README](https://github.com/ttiimmaahh/pi-handoff/blob/7bb4a2b754d4a6c3aa5762915e3f2bc68913da25/README.md).
- **[T2]** Same revision: [generation, watcher, compaction, and injection implementation](https://github.com/ttiimmaahh/pi-handoff/blob/7bb4a2b754d4a6c3aa5762915e3f2bc68913da25/index.ts).
- **[H1]** HumanLayer, revision `99abe67`: [create_handoff](https://github.com/humanlayer/humanlayer/blob/99abe673498cf8bdcd5f989aebe9406a27185b3b/.claude/commands/create_handoff.md).
- **[H2]** Same revision: [resume_handoff](https://github.com/humanlayer/humanlayer/blob/99abe673498cf8bdcd5f989aebe9406a27185b3b/.claude/commands/resume_handoff.md).
- **[U1]** jumpifequal, revision `0e6cb31`: [handoff skill](https://github.com/jumpifequal/handoff-skill/blob/0e6cb31a66ede5c4791e8fa077e23bee002bb698/SKILL.md).
- **[U2]** Same revision: [template](https://github.com/jumpifequal/handoff-skill/blob/0e6cb31a66ede5c4791e8fa077e23bee002bb698/references/handoff-template.md) and [validation contract](https://github.com/jumpifequal/handoff-skill/blob/0e6cb31a66ede5c4791e8fa077e23bee002bb698/references/handoff-validation.md).
- **[O1]** orzilca, revision `a6233e0`: [prepare skill source](https://github.com/orzilca/agent-handoff-skills/blob/a6233e0feb05d0f44a90105bea56f93d2105a9df/src/handoff-prepare.md).
- **[O2]** Same revision: [continue skill source](https://github.com/orzilca/agent-handoff-skills/blob/a6233e0feb05d0f44a90105bea56f93d2105a9df/src/handoff-continue.md).
- **[C1]** jdmnk, revision `00ee7ab`: [context-checkpoint skill](https://github.com/jdmnk/context-checkpoint-skill/blob/00ee7ab09516b37b2dd0520bdaa1d89e5668fe8e/skills/context-checkpoint/SKILL.md).
- **[E1]** Entire, revision `fe5266f`: [session-handoff skill](https://github.com/entireio/skills/blob/fe5266f76d846222c73b080ce39fd803dd705198/skills/session-handoff/SKILL.md).
- **[V1]** Handover, revision `b036340`: [Handoff Continuity Record](https://github.com/44-pixels/handover-mcp/blob/b036340342ee64c009231378dc1a288b820474c6/protocol/v1/README.md).
- **[V2]** Same revision: [continuity-test skill](https://github.com/44-pixels/handover-mcp/blob/b036340342ee64c009231378dc1a288b820474c6/skills/handover-test-continuity/SKILL.md).
