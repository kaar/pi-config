# pi-gate: a no-mistakes-style validation workflow for pi

Design spec, for review. Working name: **pi-gate** (open question #1). Background research: [docs/research/no-mistakes-workflow.md](../research/no-mistakes-workflow.md).

## Summary

### What the workflow is for

Agents generate code faster than humans can validate it. The failure mode is not "the agent can't write the feature", it is slop reaching the shared remote: subtle bugs the author-session is blind to, untested paths, missing docs, lint churn, and PRs the human has to babysit through CI. The bottleneck has moved from writing code to establishing trust in it.

no-mistakes attacks this by inserting one deliberate checkpoint before anything becomes public. Its real product is a trust contract: when a branch passes the gate, it means a fresh pair of eyes reviewed the diff against the author's stated intent, targeted tests and lint actually ran, a human decided every judgment call, and the push could not have clobbered remote work. Everything else (daemon, bare gate repo, SQLite, TUI, nine steps) is infrastructure to deliver that contract outside the authoring session, restart-proof and harness-agnostic.

### The underlying problem, reduced

Strip the infrastructure and the problem is exactly this: **the session that wrote the code cannot be trusted to judge it, and the human cannot be trusted to catch what it missed at diff scale.** So before push you need three things:

1. A **fresh-context, adversarial review** of the diff, informed by what the user actually asked for (intent), producing findings the driver cannot quietly swallow.
2. **Mechanical verification** (tests, lint) actually executed, not claimed.
3. A **human decision point** where judgment-shaped findings are surfaced verbatim, before the push happens.

### The argument for a much simpler solution

Inside pi, most of no-mistakes' machinery is solving problems we do not have. The daemon exists because no harness stays attached; pi's session is the always-attached driver. The gate remote exists to intercept pushes from any tool; we control the trigger, it is a skill invocation. SQLite and the run ledger exist for restart-proofness and multi-run attribution; a single-user chat session is its own record. Transcript-based intent inference exists because the gate runs outside the authoring session; here the intent is sitting in the conversation. The multi-provider adapter layer is void: steps run on pi.

What remains is small enough to be a **single skill plus one fresh-context reviewer call**:

1. Commit the work on a feature branch.
2. Rebase on fresh upstream; stop if the diff is empty.
3. Spawn one **fresh reviewer** (headless `pi --mode json --no-session`, or a subagent) with the diff and the intent, returning structured findings (`severity`, `action: auto-fix|ask-user|no-op`, fail closed to `ask-user`).
4. Run the repo's own test and lint commands. Exit codes are findings.
5. Present all findings in chat. The human approves, asks for fixes (main agent fixes, reviewer re-reviews the new diff), or skips. `ask-user` findings are relayed verbatim.
6. Push with `--force-with-lease` after an `ls-remote` check, open the PR with `gh`, report the URL. Done; CI babysitting stays with the human or a later phase.

That is maybe 150 lines of skill text and a couple of helper scripts, no state files, no executor state machine. Git is the audit trail, the chat is the round history, the PR body is written by the agent that already knows everything. It deliberately gives up: non-blocking validation in a parallel worktree, crash recovery mid-run, automated CI fixing, and the tamper-proofing that makes no-mistakes safe to point at contributor branches. For a single developer driving pi interactively, none of those buys much, and every one of them can be added later without changing the contract in step 3-5.

The recommendation, therefore, is to treat this spec as two proposals: the **minimal gate** above (recommended starting point, roughly Phase 1 stripped of the ledger and worktree), and the fuller pipeline below for when the minimal gate proves the contract and starts hurting (wanting fix-round history, CI auto-fix, or gating unattended subagent work). Decide at review which one to build first (open question #0).

## Goal

Reproduce the no-mistakes workflow contract inside pi, using pi-native primitives (skill + helper scripts + headless `pi` invocations), so that a branch goes through `rebase → review → test → document → lint → push → PR → CI watch` with structured findings, bounded auto-fix, and human gates in the chat, before anything reaches the remote.

## Non-goals

- No Go daemon, no bare gate repo, no git hooks, no SQLite, no TUI, no socket IPC. Single user, single machine; pi's chat is the approval UI and JSON files are the state.
- No multi-agent-harness support. Steps run on pi itself (headless). no-mistakes' adapter layer is exactly what we get to delete.
- No multi-host support in v1. GitHub via `gh` only.
- Not a replacement for installing the real no-mistakes. This is a pi-native reimplementation of the workflow, valuable because it is inspectable, hackable, and integrated with the chat session (intent for free, gates in the conversation).

## What we keep from no-mistakes (the contract)

1. **Fixed step order:** `rebase → review → test → document → lint → push → pr → ci`. Intent is not a step here (see below); order otherwise identical and non-configurable.
2. **Findings model:** `{id, severity: error|warning|info, file, line, description, action: auto-fix|ask-user|no-op}`. Missing `action` fails closed to `ask-user`. Review also returns `risk_level` + `risk_rationale`.
3. **Auto-fix loop:** per-step limits, `review: 0` by default (always parks for the human), rounds recorded with findings, fix summary, and what the user ignored.
4. **Gate semantics:** at a gate the human chooses approve / fix selected (with notes) / skip / abort. `ask-user` findings are relayed verbatim, never resolved by the agent. A `--yes`/yolo equivalent exists only as explicit per-run consent.
5. **Driving rules:** the pipeline owns fixes (the driver never hand-edits mid-run), never abort/rerun to circumvent a gate, stop at `checks-passed` and hand the merge to the human.
6. **Safety invariants:** disposable worktree; HEAD continuity from review onward; review-commit binding before push; `ls-remote` + patch-id force-push guard; empty-diff early exit; step commands run only from committed config on the default branch is **relaxed** (see Security).
7. **Outcomes:** `checks-passed | passed | failed | cancelled`, plus a fixes summary the driver relays to the user.

## What we change

| no-mistakes | pi-gate | Why |
|---|---|---|
| `git push no-mistakes` into a bare gate repo + hooks + daemon | Invoked in-session: `/pi-gate` skill (validate-only or task-first) | Single-user; the deliberate trigger is the skill invocation, not a remote |
| Daemon + SQLite + TOON `axi` | `pi-gate` bash CLI + JSON run ledger under `~/.pi-gate/` | The main pi session is the always-attached driver; state is inspectable files |
| Intent step: transcript matching across 6 harnesses | Driver passes `--intent` from the live conversation; fallback reads the current pi session file | The driver *is* the session that produced the change; no inference needed |
| TUI approval panel | Chat gates: the driver presents findings as a table and asks the user | pi already has a human attached |
| Multi-provider agent adapters + fallback | Headless `pi --mode json --no-session` per step, optionally with `--model` per role | One harness; model choice per step replaces provider fallback |
| CI step holds the run and polls in-daemon | `pi-gate ci-watch` script polls `gh`; driver runs it bounded-foreground, or spawns a subagent for long watches | No daemon to park in |

## Architecture

```
you ── chat ── main pi session (driver, loaded /pi-gate skill)
                    │ bash
                    ▼
              pi-gate CLI (bash toolbelt)
                    │
   ┌────────────────┼─────────────────────────────┐
   ▼                ▼                             ▼
 git worktree   headless pi steps             gh / git
 ~/.pi-gate/    (review, evidence, docs,      (push, pr, ci)
 worktrees/     lint-agent, fixer)
 <run>/         --mode json --no-session
                    │
                    ▼
              run ledger  ~/.pi-gate/runs/<run-id>/
                run.json  (state machine: steps, rounds, findings, head SHAs)
                logs/<step>.log
                evidence/
```

Three components:

### 1. The skill (`~/.pi/agent/skills/pi-gate/SKILL.md`)

Teaches the main session to be the driver, closely modeled on the generated `/no-mistakes` skill:

- **Validate-only** (`/pi-gate`) vs **task-first** (`/pi-gate <task>`): do the work, commit on a feature branch, then gate it.
- Preconditions: committed work, non-default branch, `pi-gate doctor` passes.
- Start: `pi-gate run --intent "<user's goal, decisions, tradeoffs>"`. Blocks until the first gate or outcome, prints JSON.
- Gate loop: on `{"gate": ...}` present the findings table in chat; decide `auto-fix` findings on own judgment, escalate `ask-user` verbatim; respond with `pi-gate respond --action approve|fix|skip [--findings ids] [--instructions ...] [--add-finding json]`; repeat until `{"outcome": ...}`.
- Hard rules copied from no-mistakes: never edit files to fix findings mid-run, never abort to bypass a gate, at `checks-passed` summarize + list pipeline fixes + ask the user to review and merge.
- `--yes` passthrough for consented unattended runs.

### 2. The CLI (`pi-gate`, bash, lives in the skill's `bin/`)

Owns everything deterministic so the driver LLM cannot fudge it:

- `pi-gate run|respond|status|logs|abort|doctor|init`.
- The **executor**: sequential state machine over `run.json`. Each step is a bash function; agent-backed steps shell out to headless pi with a prompt file and a JSON schema contract appended (same pattern as no-mistakes' pi adapter: schema inlined in the prompt, output extracted from fenced/bare JSON and validated with `jq` against required fields + enums; invalid `action` → `ask-user`).
- **Blocking model:** `run`/`respond` execute steps synchronously until the next gate or outcome, then exit printing the gate/outcome JSON. State machine means the process does not need to stay alive at a gate; `respond` picks up where `run` parked. This replicates axi's drive loop without a daemon.
- **Round accounting:** every execution appends a round (trigger, findings, selected ids, fix summary, duration) to `run.json`; auto-fix limits enforced here, not by the LLM.
- Concurrency: one active run per repo, lockfile under `~/.pi-gate/runs/`; a new `run` on the same branch requires the old one aborted or terminal.

### 3. Headless step agents

One `pi --mode json --no-session` process per agent invocation, `cwd` = the run worktree, prompts assembled by the CLI from templates in the skill dir:

| Role | Input | Output schema |
|---|---|---|
| reviewer | diff (ignore-filtered), intent, prior-round history | findings[], risk_level, risk_rationale |
| test-evidence | intent, changed files, baseline-command result | findings[], tested[], testing_summary, artifacts[] |
| documenter | diff, doc placement policy | findings[] (unresolved gaps only; fixes committed in-pass) |
| lint-agent (only when `commands.lint` unset) | changed files | findings[] |
| fixer (shared) | selected findings + notes + user-added findings + round history | fix_summary |
| ci-fixer | failed check names + `gh run view --log-failed` output, intent | fix_summary |
| pr-author | intent, diff stat, rounds | title (conventional commit), what_changed |

Per-role `--model` override in config (e.g. a stronger model for review, a cheap one for lint).

## Step behavior (v1)

- **rebase:** fetch origin, rebase onto `origin/<default>`; conflict → findings + fixer loop (limit 3); empty diff after rebase → outcome `passed` with remaining steps skipped; the local-default-commit-bundling check from no-mistakes is included (cheap: `merge-base --is-ancestor` checks) and parks as `ask-user`.
- **review:** parks whenever findings include `error`/`warning` or any `ask-user` (auto_fix.review = 0 default). Records the reviewed commit SHA into `run.json` (approval binding).
- **test:** run `commands.test` if configured (targeted, per config docs); then evidence agent unless intent already proven; evidence to `runs/<id>/evidence/`.
- **document:** in-pass fixes committed; unresolved findings park.
- **lint:** `commands.lint` or agent pass; fix loop limit 3.
- **HEAD continuity:** before test, document, lint, push: worktree HEAD must equal or descend from the recorded pipeline head, else `failed`.
- **push:** run `commands.format`; commit leftovers (`pi-gate: apply agent fixes`); verify pushed commit descends from the reviewed commit (else fail closed); `git ls-remote`, patch-id check against remote-only commits, `--force-with-lease=<ref>:<sha>` with explicit anchor; push exact SHA.
- **pr:** `gh pr create/edit`; body sections `## Intent`, `## What Changed`, `## Risk Assessment`, `## Testing` (evidence links), `## Pipeline` (issue → fix → verification narrative from rounds); size cap with truncation marker.
- **ci:** `pi-gate ci-watch` polls `gh pr checks` + mergeability (30s/60s/120s tiers, 60s empty-grace). Green + mergeable → print `checks-passed` and exit; failure → ci-fixer loop (limit 3) through the same push guard; idle timeout → gate. Long watches: the driver may spawn a pi subagent that runs `ci-watch` and reports back, instead of blocking the main session.

## Configuration

Global `~/.pi-gate/config.json` + repo `.pi-gate.json` (repo overlays global field by field):

```jsonc
{
  "commands": { "test": "...targeted...", "lint": "...", "format": "..." },
  "ignore_patterns": ["*.lock", "vendor/**"],
  "auto_fix": { "rebase": 3, "review": 0, "test": 3, "lint": 3, "ci": 3 },
  "models": { "review": null, "fix": null, "evidence": null },
  "ci_timeout_minutes": 30,
  "commit_fix_message": "chore(pi-gate-{step}): {summary}"
}
```

### Security posture (deliberate simplification)

no-mistakes reads `commands.*`/`agent` only from the trusted default branch to defeat hostile contributor branches. pi-gate v1 reads `.pi-gate.json` from the **worktree as pushed** and documents that this is safe only for repos where you author every gated branch. If pi-gate is later used on contributor branches, adopt the trusted-default-branch read (a `git show origin/<default>:.pi-gate.json` is easy). The gate-agent AGENTS.md hijack problem is smaller here (headless pi in a worktree of your own repo) but real for orchestration repos; mitigation: run step agents with `--no-session` and a system-prompt steering block, and document that pi-gate should not gate repos whose AGENTS.md asserts an agent identity until pi grows a project-instructions suppression flag (open question #5).

## State layout

```
~/.pi-gate/
  config.json
  runs/<repo-slug>-<branch-slug>-<ts>/
    run.json          # status, steps[], rounds[], reviewed_sha, pipeline_head, pr_url, outcome
    logs/<step>.log
    evidence/
  worktrees/<run-id>/ # git worktree, removed on terminal outcome
```

`run.json` is the single source of truth; `pi-gate status` renders it for the driver; humans can read it directly.

## Phases

**Phase 1 (MVP):** skill + CLI skeleton; worktree; steps rebase, review (park-always), test (command + evidence agent), lint (command only), push (full guard), pr (basic body); gates via chat; `doctor`, `abort`, `status`. No document step, no CI step, no auto-fix loops (every finding parks; `fix` action works but each fix round is user-triggered).

**Phase 2:** auto-fix loops with limits + round history in fixer prompts; document step; agent lint; PR body narrative from rounds; `--yes`.

**Phase 3:** ci-watch + ci-fixer + subagent long-watch; evidence artifacts in PR body; intent fallback from the current pi session file; `pi-gate stats`.

## Open questions (for review)

1. **Name:** `pi-gate`? Other candidates: `gate`, `shipgate`, `no-slop`.
2. **Worktree vs in-place:** spec says worktree from phase 1 (core to the safety story and lets you keep working). Agree, or is in-place acceptable for MVP?
3. **Driver = main session:** gates land in your active chat. Alternative: run the whole pipeline in a spawned subagent pane and only get escalations. Which default?
4. **Language for the CLI:** bash (fits pi-config conventions, but the state machine + JSON handling is heavy for bash) vs TypeScript run via the skill (pi already ships a TS runtime for extensions). I lean TypeScript with a thin bash entry.
5. **Step-agent instruction hygiene:** is a steering block enough, or should we ask pi upstream for a `--no-project-instructions` flag first?
6. **Review model:** default to the session's model, or hardcode a strong-model recommendation in config?

## Reference

- Research report: [docs/research/no-mistakes-workflow.md](../research/no-mistakes-workflow.md)
- Source studied: `github.com/kunchenguid/no-mistakes` (docs under `docs/src/content/docs/`, executor in `internal/pipeline/`, pi adapter in `internal/agent/pi.go`, skill in `skills/no-mistakes/SKILL.md`)
- Consumer reference: `~/Dev/firstmate` (project modes, crew ownership of runs, `fm-crew-state.sh` attribution)
