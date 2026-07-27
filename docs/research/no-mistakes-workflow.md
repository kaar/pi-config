# no-mistakes: workflow research report

Research into [kunchenguid/no-mistakes](https://github.com/kunchenguid/no-mistakes) (same author as firstmate), based on the cloned source at `/tmp/pi-github-repos/kunchenguid/no-mistakes`, its Astro docs site, and how `~/Dev/firstmate` consumes it. This report feeds the pi design spec at `docs/plans/pi-gate.md`.

## 1. Overview

Tagline: "`git push no-mistakes`. Kill all the slop. Raise clean PR."

no-mistakes is a Go binary that puts a **local git gate** between your branch and the real remote. Instead of `git push origin`, you push to a local remote named `no-mistakes`. That push lands in a local bare repo, a daemon picks it up, checks the branch out into a **disposable worktree**, and runs an **AI-driven validation pipeline**. Only when every check is green does it forward the branch to the real push target and open a PR, then it keeps watching CI and auto-fixes failures.

The core value proposition: AI agents produce huge diffs; the bottleneck is review and validation, not code generation. no-mistakes moves review, tests, docs, and lint from the outer loop (post-push CI churn) into a deliberate local gate, with a human approving anything judgment-shaped.

### Three entry points, one pipeline

1. **`git push no-mistakes <branch>`** - explicit Git path for committed work.
2. **`no-mistakes`** (bare) - TUI. Attaches to the active run, or runs a wizard that branches, commits, and pushes for you. `no-mistakes -y` does it all automatically.
3. **`/no-mistakes`** - agent skill. The coding agent either gates already-committed work (validate-only) or does a task first and then gates it (task-first), driving the run headlessly through `no-mistakes axi`, a non-interactive TOON-format CLI interface.

### The fixed pipeline

```
intent → rebase → review → test → document → lint → push → pr → ci
```

Order is **not configurable**; commands, auto-fix limits, and per-run skips are. The rationale: "passed the gate" must mean the same thing in every repo.

| # | Step | What it does | Default auto-fix limit |
|---|------|--------------|------------------------|
| 1 | intent | Use supplied `--intent` or infer author intent from recent local agent transcripts (Claude Code, Codex, OpenCode, Rovo Dev, Pi, Copilot) | n/a |
| 2 | rebase | Fetch fresh upstream + pushed-branch target, rebase onto them; end run early if diff becomes empty | 3 |
| 3 | review | AI code review of the diff, with intent as context; returns findings + risk level | 0 (parks for human approval) |
| 4 | test | Targeted validation of the change (configured baseline command and/or agent-driven evidence gathering); explicitly not a full CI suite | 3 |
| 5 | document | Agent updates docs for the change during its own pass; only unresolved gaps become findings | initial pass only |
| 6 | lint | Configured lint command, or agent-driven lint combined with the document pass when unconfigured | 3 |
| 7 | push | Safety-guarded push of the validated branch to the configured target | n/a |
| 8 | pr | Create or update the PR with a generated title/body (intent, what changed, risk, testing, pipeline narrative) | n/a |
| 9 | ci | Poll CI + mergeability, auto-fix failures and merge conflicts, signal `checks-passed` when green | 3 |

Ordering rationale (from docs): intent first so every later prompt has author context; rebase next so everything runs against fresh upstream; review before test so the reviewer reads untouched code; document after test so docs describe working code; lint last among local checks; push/pr/ci only after local gates pass.

### The findings model

Every agent-driven step returns structured **findings**: `{id, severity, file, line, description, action}`.

- `severity`: `error` | `warning` | `info`.
- `action`: `auto-fix` (objective, mechanical; eligible for the fix loop) | `ask-user` (challenges author intent or product behavior; only a human decides) | `no-op` (informational).
- **Fail-closed rule:** a finding with a missing/unknown `action` is treated as `ask-user`. An unclassified finding is never auto-fixed.

The review step also returns `risk_level` (`low`/`medium`/`high`) plus `risk_rationale`, which flows into the PR body and firstmate's reporting.

### The auto-fix loop

```
run step → findings? → auto-fix enabled + eligible? → fixer agent applies fixes → re-run step
                    ↘ no                           ↘ limit hit or ask-user findings remain
                      pause for human: approve / fix selected / skip / abort
```

Key properties:

- Per-step attempt limits (`auto_fix.<step>`), review defaulting to `0` so review findings always park for a human unless the user opts in.
- Each execution is a recorded **round** with its findings, duration, the merged payload sent to the fixer, and a one-line fix summary. Rounds power PR-body narratives ("issue → fix → verification") and `axi status` displays like `auto-fix 1/3`.
- User-triggered fixes at a gate: select findings, attach per-finding notes, add user-authored findings, send to the fixer, then a `fix_review` pause shows results before continuing.
- Fixer prompts include sanitized prior-round history including which findings the user chose to ignore, so re-reviews don't nag about them again.
- Yolo mode (TUI) / `--yes` (axi) is explicit standing consent: one fix round with all findings selected, fix reviews approved, `no-op`-only gates approved.

### Step statuses and outcomes

Steps: `pending / running / fixing / awaiting_approval / fix_review / completed / skipped / failed`.

Run outcomes surfaced to agents: `checks-passed` (CI green, PR mergeable, human should review and merge; monitoring continues in the background), `passed` (PR merged/closed), `failed`, `cancelled`.

## 2. Architecture deep dive

### 2.1 The gate: bare repo + hooks

`no-mistakes init` in a working repo:

1. Creates a bare gate repo at `~/.no-mistakes/repos/<id>.git` (id = first 12 hex chars of sha256 of the abs working path).
2. Installs a `pre-receive` **admission** hook (daemon authorizes the update before any gate ref changes; descendants of an active validation step are refused, which is the recursive-run containment) and a `post-receive` **notification** hook (calls `no-mistakes daemon notify-push` with gate path, ref, old/new SHAs, and push options like `-o no-mistakes.skip=test,lint`).
3. Adds a `no-mistakes` remote to the working repo pointing at the gate. `origin` is never touched; that is an explicit trust decision.
4. Installs/refreshes the `/no-mistakes` skill at user level (`~/.claude/skills/`, `~/.agents/skills/`).
5. Ensures the daemon is running.

`init` is idempotent and handles repo moves/renames (reattach, preserve repo ID and history) and copies (new gate). `--fork-url` records a GitHub fork as the branch push target while `origin` remains the PR-base parent.

### 2.2 The daemon

Long-running background process, one per `NM_HOME` (exclusive OS lock on `daemon.lock`):

- Listens on a Unix socket (`~/.no-mistakes/socket`), JSON-RPC 2.0. `subscribe` streams events to TUI clients; `axi` uses request/response.
- Creates and cleans up detached worktrees under `~/.no-mistakes/worktrees/<repoID>/<runID>/`.
- Serializes pushes per branch (a new push cancels the in-progress run for that branch).
- Scopes configured commands and agent subprocesses to step lifetime; terminates leftover children on completion/failure/cancel.
- Persists everything to SQLite (`state.sqlite`): repos, runs, step results, rounds, intent summaries, agent invocation telemetry, session metadata for resumable reviewer/fixer roles, `awaiting_agent_since` parked timestamps, accumulated parked time.
- Crash recovery on startup: validates state, reconciles parked gates, fails closed.
- Per-step logs at `~/.no-mistakes/logs/<runID>/<step>.log`.

### 2.3 The executor

Runs steps sequentially with the approval/fix loop described above. Notable engineering:

- **Early exit:** after rebase, if the diff against the default branch is empty, remaining steps are skipped.
- **Post-review HEAD continuity:** at entry to every step after review, the live worktree HEAD must equal or descend from the pipeline-recorded head. A backward reset or divergent sibling fails the run before the step does work. This prevents anything (including a confused agent) from swapping the reviewed history.
- **Review approval binding:** the exact reviewed commit is durably recorded; push later refuses to proceed unless the pushed commit equals or descends from it. Skipping review leaves no binding, so push fails closed unless push is also skipped.
- **Parked observability:** while paused at a gate, runs expose `awaiting_agent: parked <duration>`; while running/fixing, `active_steps` shows duration, last activity, agent PID, and current round, with a `quiet` prefix when nothing has happened for longer than `step_quiet_warning`. Pure observability, never behavior-changing. firstmate's `fm-crew-state.sh` reads exactly this to distinguish "crew still working" from "wedged".

### 2.4 Step safety mechanisms worth copying

- **Rebase:** tries pushed-branch target first, then `origin/<default>`; skips the pushed-branch target if the push rewrote history; pauses with `ask-user` if the branch would silently bundle local default-branch commits never pushed upstream; conflict → agent resolves markers and `git rebase --continue` in a non-interactive git env.
- **Review:** diff filtered by `ignore_patterns`; structured output schema; intent treated as enforceable acceptance criteria; findings that merely complain "no PR/CI exists yet" are stripped because later steps own those outcomes; guidance against scope-creep review (no speculative redesign demands, no promoting nice-to-haves into blockers); reviewer/fixer session reuse across rounds (Claude/Codex) with fresh-session fallback.
- **Test:** "do not run everything" is not "run nothing": the agent must produce the smallest relevant evidence (focused tests, manual verification, screenshots for UI work) or return a warning that evidence is not possible. Records `tested[]`, `testing_summary`, and `artifacts[]` (path/url/content). Evidence goes to a temp `no-mistakes-evidence/<runID>` dir by default, or into the repo with `test.evidence.store_in_repo`.
- **Push:** runs `commands.format` first; commits leftover agent changes; re-reads the target via `git ls-remote`; refuses force-pushes that would discard remote commits the run has not incorporated **by patch-id**; fails closed if the check is inconclusive; uses `--force-with-lease=<ref>:<sha>` with an explicit SHA anchor; pushes the exact verified SHA, not mutable HEAD.
- **PR:** provider CLIs (`gh`, `glab`, `az`, Bitbucket API); conventional-commit title; body sections: `## Intent`, `## What Changed` (agent-authored), `## Risk Assessment`, `## Testing` (from the recorded rounds and evidence), `## Pipeline` (issue → fix → verification narrative); 63,488-byte cap with structured truncation.
- **CI:** poll at 30s/60s/120s tiers; 60s grace before trusting empty check results; waits for all checks before fixing; fetches failed job logs and hands them to the agent; auto-rebases actual merge conflicts through the same force-push guard; `checks-passed` signal the moment checks are green so the agent can stop driving and hand the merge decision to the human; monitoring continues until merge/close or `ci_timeout` idle, then parks at a gate rather than silently ending.

### 2.5 Agent abstraction

`internal/agent` defines `Agent { Name(); Run(ctx, RunOpts) (*Result, error); Close() }` with adapters for claude, codex, opencode, rovodev, copilot, **pi**, and generic ACP targets via `acpx` (cursor is an ACP alias). Highlights:

- `RunOpts` carries prompt, CWD, an optional JSON schema for structured output, streaming chunk callback, lifecycle callback, session ref, and telemetry labels.
- **Structured output without provider support:** the schema is inlined into the prompt as a "final output contract"; the parser then extracts JSON from the raw text, fenced blocks, or the last bare balanced `{...}` object, and validates it against the schema (types, enums, required, additionalProperties). Schema/validation failures do not trigger provider fallback; process failures do.
- **Pi adapter** (`internal/agent/pi.go`): spawns `pi [user extras] --mode json --no-session`, writes the prompt to stdin, parses the JSONL event stream (`message_update` text deltas, `message_end`/`turn_end`/`agent_end` for final text and token usage), one process per invocation, no server.
- **Ordered fallback lists** (`agent: [codex, claude]`): filtered to available binaries at run start; a process-level failure retries the invocation with the next provider.
- **Gate neutralization:** because the gate agent runs inside the target checkout with a free shell, a repo whose `AGENTS.md` claims an orchestration identity (firstmate's fleet captain) can hijack it. This actually happened (the "ambient-authority incident"). Only adapters with a verified suppression knob (claude, codex) can run with `disable_project_settings: true`; the gate **fails closed** and refuses to launch other agents when that opt-out is requested. firstmate sets this in its own `.no-mistakes.yaml`, and additionally its fleet scripts refuse to run inside a gate context (`fm-gate-refuse-lib.sh`).

### 2.6 AXI: the agent-facing interface

`no-mistakes axi` prints TOON (`key: value`, `name[N]{cols}:` tables, `help[N]:` next-command hints) on stdout, progress on stderr. The contract the generated skill teaches:

- `axi run --intent "..."` starts a run and **blocks** until the first gate or the outcome. Every `axi respond` blocks until the next decision point. The run never advances past a gate on its own; the driver loops: read output → on `gate:` respond → until `outcome:`.
- `axi respond --action approve|fix|skip` with `--findings <ids>`, `--instructions`, `--add-finding '<json>'`, optional `--step`.
- `axi status` (with `awaiting_agent` / `active_steps`), `axi logs --step <s> --full`, `axi abort`, `axi sync` (guarded branch synchronization after pipeline commits, with `--recover` custody recovery), `axi run --yes` for consented unattended driving.
- Intent is required and should be the user's goal in their own words, enriched with decisions/tradeoffs, not a diff description. The review step uses it to tell deliberate choices from mistakes.
- Hard rules for the driving agent: never edit code to fix findings while a run is active (the pipeline owns fixes), never abort/rerun to circumvent a gate, escalate `ask-user` findings verbatim, stop at `checks-passed` and hand the merge to the human.
- Exit codes: 0 success/gates, 1 failed/cancelled, 2 bad usage. Errors carry the exact fix command.

### 2.7 Configuration

- Global `~/.no-mistakes/config.yaml`: `agent` (+ fallback list), `agent_path_override`, `agent_args_override`, `auto_fix` limits, `ci_timeout`, `step_quiet_warning`, `session_reuse`, `commit.fix_message` template, `intent.*`, `test.evidence.*`.
- Repo `.no-mistakes.yaml`: same knobs plus `commands.{test,lint,format}`, `ignore_patterns`, `document.instructions`, `disable_project_settings`.
- **Supply-chain guard:** `commands.*`, `agent`, `document.instructions`, and `disable_project_settings` are read **only from the trusted default-branch copy** at the freshly fetched commit, never from the pushed SHA, so a contributor branch cannot make the daemon execute hostile commands. Opt out per-repo with `allow_repo_commands: true` (itself only read from the default branch). Non-executing fields are read from the pushed branch.

### 2.8 How firstmate consumes it

- Project modes: `no-mistakes` (full pipeline, the default), `direct-PR` (PR without the pipeline), `local-only`. When no-mistakes is selected it **alone** owns review, fixes, tests, docs, push, PR, and CI; firstmate is forbidden from stacking manual review gates on top.
- The crewmate (worker) that starts a run owns every `axi run`/`axi respond` through to the outcome; firstmate never responds on a crew-owned run. Ready signal: `done: PR <url> checks green`.
- `fm-crew-state.sh` attributes an active/terminal no-mistakes run to a crew by branch + code identity and treats an actively running step as positive "still working" evidence for the supervision watcher.
- New projects get `no-mistakes init && no-mistakes doctor` during onboarding.

## 3. Essence to carry into a pi implementation

The system decomposes into layers of decreasing importance:

1. **The workflow contract** (portable, cheap): fixed step order; structured findings with severity + fail-closed action classes; per-step auto-fix limits with review defaulting to human approval; recorded rounds; intent as first-class review context; explicit outcomes; the driving-agent rules (pipeline owns fixes, escalate ask-user, stop at checks-passed).
2. **The safety engineering** (portable, medium cost): worktree isolation; HEAD continuity + review-commit binding; patch-id force-push guard; trusted-source config for anything that executes; early empty-diff exit.
3. **The infrastructure** (expensive, mostly replaceable in a single-user pi setup): bare gate repo + hooks, daemon + socket + SQLite, TUI, multi-provider agent adapters, multi-host PR/CI providers.

Layer 1 and selected parts of layer 2 are what a pi-native workflow should reproduce. Layer 3 exists because no-mistakes is agent-agnostic, multi-user-ish, and restart-proof; inside pi, the harness itself (skills, subagents, headless `pi --mode json`, session files, chat gates) can supply those roles far more cheaply.

Design spec: [docs/plans/pi-gate.md](../plans/pi-gate.md).
