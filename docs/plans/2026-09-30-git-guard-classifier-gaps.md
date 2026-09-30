# Git Guard Classifier Gaps Implementation Plan

## Overview

Fix three gaps in `agent/extensions/git-guard.ts` that a comparison against the Jev classifier (`typesafe/jev-latest`) exposed:

1. A false positive: `GIT_EDITOR=true git rebase --continue` is blocked as interactive.
2. A missing destructive rule: `git branch -f` (force-moving a branch ref) is allowed.
3. A missing overwrite rule: bash commands that overwrite a tracked file (`git show <rev>:<path> > <file>`, `cp <src> <file>`) are allowed without the prompt that the `write`/`edit` path policy would apply.

Non-git destructive commands (`rm`, Docker, lock-file cleanup) are out of scope for a git guard and are listed as future work for a general shell guard.

## Motivation and Methodology

We extracted every bash tool call from `docs/research/tailnet-sessions/*.jsonl`: 772 calls, 739 unique commands (jq-sorted, deduplicated). Each unique command was classified twice:

- **Jev** labeled it `safe`, `interactive`, or `destructive` with a confidence.
- **Guard logic** was replicated in a codemode script from the regexes and decision order in `git-guard.ts` (the extension itself was not invoked). A `git commit` with an explicit `-m` message counted as `safe`, because `promptCommitOrBlock` prompts and then allows it.

Result: 705 agreements and 34 disagreements.

| Jev         | Guard       | Count |
|-------------|-------------|-------|
| safe        | safe        | 705   |
| safe        | interactive | 5     |
| interactive | safe        | 6     |
| destructive | safe        | 23    |

Conclusions:

- **safe / interactive (5):** all five are a real guard bug. The rebase rule looks for `GIT_EDITOR` only after `rebase --continue`, so the conventional prefix form `GIT_EDITOR=true git rebase --continue` is blocked. Fix 1.
- **interactive / safe (6):** no guard change. `git add ... && git commit -m "..."` (0.25 to 0.36) does not open an editor and already goes through `promptCommitOrBlock`. `git pull --rebase` (0.45) does not open an editor. `gh auth setup-git && git clone ...` (0.88) and `timeout 5s gh auth login ... --web` (0.89) are `gh` commands, and the second is bounded by `timeout`.
- **destructive / safe (23):** three are in the guard's scope and are real gaps: `git branch -f` (Fix 2), and two tracked-file overwrites (Fix 3). The other 20 are `rm`, Docker, archive, and lock-release commands outside a git guard's scope, plus one Jev false positive on a read-only `echo`/`cat`/`head` command (0.33).
- Jev labels below about 0.5 confidence were mostly noise. See [Using Jev Labels in Testing](#using-jev-labels-in-testing).

## Current State Analysis

The bash branch of the `tool_call` handler (`git-guard.ts:279-290`) tests the raw command string against three rule sets, in this order, and returns on the first match:

1. `INTERACTIVE_GIT_PATTERNS` (`git-guard.ts:25-29`) returns `{ block: true, reason: "Blocked: interactive git command" }`. No prompt, in UI or non-UI mode.
2. `DESTRUCTIVE_GIT_PATTERNS` (`git-guard.ts:31-38`) returns `{ block: true, reason: "Blocked: destructive git command" }`. No prompt.
3. `COMMIT_PATTERN` (`git-guard.ts:23`) calls `promptCommitOrBlock` (`git-guard.ts:205-262`), which prompts in UI mode and blocks in non-UI mode.

If nothing matches, the handler returns `undefined` (allow).

The `write`/`edit` branches (`git-guard.ts:265-278`) call `gatePath` (`git-guard.ts:177-203`). It allows tracked files and new files, and uses `promptOrBlock` (`git-guard.ts:162-175`) for files that are untracked or outside the cwd repository. `promptOrBlock` returns `undefined` when the user allows, and `{ block: true, reason: "Blocked <tool>: <message>" }` otherwise (always in non-UI mode). `isGitTracked` (`git-guard.ts:157-160`) runs `git -C <dir> ls-files --error-unmatch <path>` through `pi.exec`.

The bash rules only inspect the command string. No bash rule currently calls git to check file state.

### Key Discoveries:

- `git-guard.ts:27`: `/git\s+rebase\s+--continue(?!.*(GIT_EDITOR|core\.editor))/` only looks ahead of `--continue`. `.` also does not cross newlines. While this spec was being written, the live guard blocked a heredoc test script. In that script, `export GIT_EDITOR=true; git rebase --continue` was the last test string on its line, so it had the variable before the command and nothing after it.
- `git-guard.ts:31-38`: `DESTRUCTIVE_GIT_PATTERNS` covers `reset --hard`, `clean -f`, `checkout .`, `stash`, `rm -f`. Nothing covers ref moves.
- `git-guard.ts:181-199`: `gatePath` is the existing policy for "is this file protected": inside cwd repo, tracked, and existing. Fix 3 reuses `isGitTracked` and `promptOrBlock` with the same semantics.
- `git-guard.ts:193`: `gatePath` resolves symlinks with `realpathSync` before `isGitTracked`. Fix 3 must do the same.
- All existing patterns match `git\s+<subcommand>`, so `git -C dir <subcommand>` and `git -c key=val <subcommand>` are not matched. This is an existing limitation. The new rules follow the same shape.
- `agent/extensions/tests/git-guard.test.cjs:14-31`: the test harness loads the extension through `ts.transpileModule` with a mock that provides only `on`, and calls the handler with `{ hasUI: false }` and no `cwd`. Fix 3 needs `exec` on the mock and `cwd` on the context.
- The `jevLabels` codemode key from the analysis is not in the current codemode store. The labels are only preserved in this document.

## Desired End State

- `GIT_EDITOR=true git rebase --continue` and its chained variants are allowed.
- `git branch -f` / `git branch --force` are blocked as destructive git commands.
- A bash command that overwrites an existing tracked file with `git show ... > <file>` or `cp ... <file>` gets the same approve/block prompt as other protected-file operations (blocked in non-UI mode).
- All 15 existing tests still pass. New tests cover each fix's example commands and its negative cases.
- The header comment in `git-guard.ts:11-13` describes the new rules.

Verify with `node --test agent/extensions/tests/git-guard.test.cjs` and `npm run typecheck` (in `agent/extensions`).

## What We're NOT Doing

- **Non-git destructive commands.** `rm`, `rm -rf`, `rmdir`, `mv` over files, `flock ... rm` backup pruning, `docker rm`, tar/evidence writes, and agent-coordination lock release (`rm .../write.lock/owner`, `rmdir`, `mv "$tmp"`). These are 20 of the 23 destructive/safe disagreements. They belong to a general shell guard, not a git guard. See [Future Work](#future-work).
- **Generic redirect overwrites.** Only `git show ... >` is covered. `echo ... > README.md`, `jq ... > file`, `tee`, `sed -i`, and similar are shell-guard concerns.
- **Other ref-rewriting commands.** `git branch -D`, `git branch -M`/`-C`, `git checkout -B`, `git switch -C`, `git update-ref`, and `git push --force` did not appear in the disagreements. Adding them is a separate decision.
- **`git merge` with a `GIT_EDITOR=` prefix.** `git-guard.ts:26` has the same blind spot, but no session command hit it.
- **`git -C <dir>` / `git -c <k>=<v>` forms.** This is an existing limitation of every pattern in the file.
- **Changes for the 6 interactive/safe disagreements.** They are Jev false positives or out-of-scope `gh` commands (see Motivation).
- **A shell parser.** Detection stays regex- and token-based. Known misses are listed per fix.
- **Dirty-file checks for Fix 3.** See [Alternative Approaches Considered](#alternative-approaches-considered).

## Implementation Approach

All changes stay in `agent/extensions/git-guard.ts` and its test file. Each fix is independent and has its own phase.

- Fix 1 changes one regex in `INTERACTIVE_GIT_PATTERNS`.
- Fix 2 adds one regex to `DESTRUCTIVE_GIT_PATTERNS`. This matches how the guard treats `reset --hard`: a hard block, because a force-moved branch can orphan commits that only the reflog can recover.
- Fix 3 adds a small target extractor and an async check between the destructive check and the commit check. It uses `promptOrBlock`, because the risk is the same as `gatePath`'s risk (file content), not a ref rewrite. The target must exist and be tracked (same test as `gatePath`), so the rule does not fire for scratch files in `/tmp`.

## Alternative Approaches Considered

- **Fix 1: lookbehind for `GIT_EDITOR=` directly before `git`.** Example: `(?<!GIT_EDITOR=\S*\s+)git\s+rebase`. Rejected. It misses `env GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true git rebase --continue` and `export GIT_EDITOR=true; git rebase --continue`, because other tokens sit between the variable and `git`. A whole-command lookahead is simpler and covers all these forms.
- **Fix 2: prompt instead of hard block.** Rejected for consistency with the other `DESTRUCTIVE_GIT_PATTERNS`. The session use (`git branch -f master HEAD` after a detached rebase) is rare enough that a human can run it.
- **Fix 3: prompt only when the tracked target has uncommitted changes** (`git status --porcelain -- <path>` not empty). This has fewer false positives, because a clean tracked file can be restored with `git checkout -- <path>`. Rejected for now. The observed case was an unmerged conflict file, which is always dirty, so the extra git call would not change the observed result. It also adds a second state concept that `gatePath` does not use. Revisit if the prompt fires too often on clean files.
- **Fix 3: hard block.** Rejected. The agent can already overwrite a tracked file with the `write` tool, which `gatePath` allows. A hard block on the bash form would only push the agent to use `write`. A prompt makes the opaque bash overwrite visible without making it impossible.

---

## Phase 1: Fix 1, rebase with a `GIT_EDITOR` prefix

### Overview

Allow `git rebase --continue` when the command sets `GIT_EDITOR` or `core.editor` anywhere, not only after `--continue`.

### Changes Required:

#### 1. Interactive rule

**File**: `agent/extensions/git-guard.ts` (line 27, in `INTERACTIVE_GIT_PATTERNS`)

Current (broken):

```ts
/git\s+rebase\s+--continue(?!.*(GIT_EDITOR|core\.editor))/,
```

Corrected:

```ts
/^(?![\s\S]*(?:GIT_EDITOR|core\.editor))[\s\S]*git\s+rebase\s+--continue/,
```

The anchored lookahead scans the whole command, before and after `rebase --continue`, and across newlines. The token set (`GIT_EDITOR`, `core.editor`) is unchanged, so every command that the old rule allowed is still allowed.

#### 2. Tests

**File**: `agent/extensions/tests/git-guard.test.cjs`

- Allow (expect `undefined`): the 5 affected commands below, plus `env GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true git rebase --continue`, `export GIT_EDITOR=true; git rebase --continue`, and a multiline command where `GIT_EDITOR=true` and `git rebase --continue` are on different lines.
- Still block as interactive: `git rebase --continue` and `git add x && git rebase --continue`.

### Affected Commands

All 5 were `safe` for Jev and `interactive` for the guard:

```
GIT_EDITOR=true git rebase --continue && git status --short && git log -1 --oneline
GIT_EDITOR=true git rebase --continue && git status --short --branch && git log --oneline -3
GIT_EDITOR=true git rebase --continue && git status --short --branch && git diff --check && bash scripts/check-docs.sh && git log --oneline --decorate -4
cd /Users/casparnettelbladt/Dev/valheim && git add docs/progress.md && GIT_EDITOR=true git rebase --continue
git add docs/progress.md && GIT_EDITOR=true git rebase --continue && git status --short --branch && git log --oneline --decorate -3 && git diff --check origin/master...HEAD
```

| Command                                         | Before               | After                |
|-------------------------------------------------|----------------------|----------------------|
| 5 affected commands above                       | blocked: interactive | allowed              |
| `export GIT_EDITOR=true; git rebase --continue` | blocked: interactive | allowed              |
| `git rebase --continue`                         | blocked: interactive | blocked: interactive |

When run against all 739 unique session commands, the corrected regex matches none, and the old regex matches exactly these 5. So the change has no other effect on the corpus.

### Edge Cases and False-Positive Risk

- **New false negative:** any mention of `GIT_EDITOR` or `core.editor` anywhere exempts the command. For example, `unset GIT_EDITOR; git rebase --continue` or `echo GIT_EDITOR; git rebase --continue` is now allowed and can hang. This is accepted. The old rule had the same weakness for text after `--continue`, and agents write these forms rarely.
- `GIT_SEQUENCE_EDITOR` does not contain the substring `GIT_EDITOR`, so it does not exempt a command by itself. This is correct: `rebase --continue` uses `GIT_EDITOR` for commit messages.
- `git -c core.editor=true rebase --continue` does not match `git\s+rebase` and was already allowed.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `cd agent/extensions && node --test tests/git-guard.test.cjs`
- [ ] Type checking passes: `cd agent/extensions && npm run typecheck`

#### Manual Verification:
- [ ] In a live Pi session during a rebase with a resolved conflict, `GIT_EDITOR=true git rebase --continue` runs and is not blocked.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Fix 2, `git branch -f` as destructive

### Overview

Block force-moving a branch ref, in the same way as `git reset --hard`.

### Changes Required:

#### 1. Destructive rule

**File**: `agent/extensions/git-guard.ts` (append to `DESTRUCTIVE_GIT_PATTERNS`, lines 31-38)

```ts
// Force-moving a branch ref can orphan commits (recoverable only via reflog)
/git\s+branch\b[^;&|\n]*\s(?:-f|--force)(?=[\s;&|]|$)/,
```

- `[^;&|\n]*` keeps the flag search inside the same command segment. So `git branch foo && rm -f x` does not match.
- `(?=[\s;&|]|$)` requires a whole token. So `--format`, `-fq`, and branch names that start with `-f...` do not match.

#### 2. Tests

**File**: `agent/extensions/tests/git-guard.test.cjs`

Add to the existing "still blocks destructive commands" loop (`git-guard.test.cjs:44-58`):

- `git branch -f master HEAD && git switch master`
- `git branch --force main origin/main`
- `git branch topic -f HEAD~1`

Add allow cases (expect `undefined`): `git branch`, `git branch -a`, `git branch --format='%(refname)'`, `git branch feature && rm -f tmp.txt`.

### Affected Command

Jev: `destructive`, confidence 0.53. Guard: `safe`.

```
git branch -f master HEAD && git switch master && git status --short --branch && git log --oneline --decorate -4 && git diff --check && bash scripts/check-docs.sh
```

| Command                        | Before  | After                         |
|--------------------------------|---------|-------------------------------|
| `git branch -f master HEAD ...` | allowed | blocked: destructive git command |
| `git branch --force x y`       | allowed | blocked: destructive git command |
| `git branch`, `git branch -a`  | allowed | allowed                       |

On the 739-command corpus, the new regex matches only this command.

### Edge Cases and False-Positive Risk

- **False positive:** `git branch -f new-branch` when `new-branch` does not exist is only a create, but it is blocked. This is accepted, because agents rarely use it.
- **Workflow impact:** the observed use was legitimate (moving `master` to a rebased detached `HEAD`). After this change, the agent must ask the human to run it, the same as `git reset --hard`.
- **Not covered:** `-D`, `-M`, `-C`, `checkout -B`, `switch -C`, `update-ref` (see What We're NOT Doing). Combined short flags such as `-fv` are not matched.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `cd agent/extensions && node --test tests/git-guard.test.cjs`
- [ ] Type checking passes: `cd agent/extensions && npm run typecheck`

#### Manual Verification:
- [ ] In a live Pi session, `git branch -f <b> HEAD` is blocked with "Blocked: destructive git command", and `git branch -a` runs normally.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Fix 3, tracked-file overwrite from bash

### Overview

Prompt (or block in non-UI mode) when a bash command overwrites an existing file that git tracks in the cwd repository, through either:

- a redirect of `git show` output into the file: `git show <rev>:<path> > <file>`
- a `cp` whose destination is the file: `cp [opts] <src>... <file>`

### Changes Required:

#### 1. Target extraction

**File**: `agent/extensions/git-guard.ts` (new module-level function, next to `parseCommitMessage`)

`overwriteTargets(command: string): string[]` returns the candidate target paths:

1. Split the command into segments on `&&`, `||`, `;`, `|`, and newline (`/&&|\|\||[;|\n]/`).
2. For each segment:
   - **git show redirect:** match `/git\s+show\b[^>]*?(?<![0-9&>])>(?![>&])\s*(\S+)/` and take capture 1. This excludes append (`>>`), fd redirects (`2>`, `>&2`), and `&>`.
   - **cp:** match `/(?:^|\s)cp\s+(.+)/`. Split the arguments on whitespace, drop tokens that start with `-` (including `--`), and if at least 2 tokens remain, take the last one as the destination.
3. Strip one layer of matching surrounding quotes (`"..."` or `'...'`).
4. Drop targets that contain `$`, a backtick, `*`, or `?`. Their value cannot be known before execution.

#### 2. Tracked-overwrite check

**File**: `agent/extensions/git-guard.ts` (new function inside the default export, next to `gatePath`)

`gateOverwrite(command, ctx)`:

1. Call `overwriteTargets(command)`. If the list is empty, return `undefined` without running git.
2. For each target, resolve `abs = resolve(ctx.cwd, target)`. Skip it if `!existsSync(abs)` (a new file is not an overwrite, the same as `gatePath:197`). Use `realpathSync(abs)`, the same as `gatePath:193`.
3. Keep the targets where `await isGitTracked(realAbs, ctx.cwd)` is true. If `ctx.cwd` is not a git repo, or the path is outside it, `ls-files` fails and the target is not tracked.
4. If any tracked target is left, return `promptOrBlock(\`command overwrites tracked file(s): ${list}\`, "bash", ctx)`. Otherwise return `undefined`.

#### 3. Handler wiring

**File**: `agent/extensions/git-guard.ts` (bash branch, `git-guard.ts:279-290`)

Insert the new check after the `DESTRUCTIVE_GIT_PATTERNS` check and before the `COMMIT_PATTERN` check:

```ts
const overwrite = await gateOverwrite(command, ctx);
if (overwrite) return overwrite;
```

If the user allows the overwrite, the handler continues. A chain such as `git show :3:f > f && git add f && git commit -m "..."` then also gets the commit prompt.

#### 4. Header comment

**File**: `agent/extensions/git-guard.ts:11-13`

Add `branch -f` to the destructive list. Add a line: "Prompts when a command overwrites a tracked file via `git show ... >` or `cp`."

#### 5. Tests

**File**: `agent/extensions/tests/git-guard.test.cjs`

- Add an `exec` function to the mocked API (`git-guard.test.cjs:22-27`). It runs the real binary: `exec: async (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; }`. It only runs `git ls-files`, never the command under test.
- Change `check` to pass `{ hasUI: false, cwd: <repo root> }`. The repo root is `path.join(__dirname, '../../..')`. `README.md` at the root is a stable tracked file.
- Block (expect `reason` to start with `Blocked bash: command overwrites tracked file`):
  - `git show :3:README.md > README.md && git add README.md`
  - `cp /tmp/x.md README.md`
  - `cp -p "/tmp/x.md" "README.md"`
- Allow (expect `undefined`):
  - `git show :2:README.md > /tmp/ours.md` (outside the repo)
  - `git show HEAD:README.md >> README.md` (append)
  - `git show HEAD:README.md 2>/dev/null`
  - `cp README.md /tmp/readme.bak` (destination outside the repo)
  - `cp "$source" "$target_dir/"` (variable target)
  - `cp README.md does-not-exist.md` (new file)

### Affected Commands

| Command                                                                                          | Jev              | Before  | After                      |
|--------------------------------------------------------------------------------------------------|------------------|---------|----------------------------|
| `git show :3:docs/progress.md > docs/progress.md && git add docs/progress.md && git diff --check && bash scripts/check-docs.sh && git status --short` | destructive 0.59 | allowed | prompt (blocked in non-UI) |
| `cp /tmp/valheim-rebase/progress-theirs.md docs/progress.md`                                     | destructive 0.85 | allowed | prompt (blocked in non-UI) |

Corpus check: of the 739 commands, 2 contain a `git show ... >` redirect. One is the command above. The other writes to `/tmp/valheim-rebase/progress-ours.md` and stays allowed (outside the repo). There are 13 `cp` segments. Only the command above has a relative in-repo destination. The rest use absolute server paths (`/srv/...`, `/root/...`) or variable destinations, so they stay allowed.

### Edge Cases and False-Positive Risk

- **False positive, clean tracked files:** overwriting a tracked file that has no uncommitted changes can be undone with `git checkout -- <path>`, but it still prompts (see Alternative Approaches Considered).
- **False positive, `cp -t DIR SRC`:** with flags removed, `SRC` is seen as the destination. If `SRC` is tracked, the command prompts. This is rare and accepted.
- **False negative, directory destination:** `cp a.md docs/` resolves to the directory `docs/`, which is not a tracked file, so it is allowed even if `docs/a.md` is tracked. This is accepted to keep extraction simple.
- **False negative, quoted paths with spaces:** whitespace splitting breaks these into several tokens. The last fragment usually does not exist, so the command is allowed.
- **Wrong base directory after `cd`:** targets resolve against `ctx.cwd`. If an earlier segment changes directory (`cd /other/repo && cp x y`), the check uses the wrong base. This can miss an overwrite, or rarely prompt on a same-named file in the cwd repo. This is accepted.
- **Remote commands:** `ssh host 'cp ...'` segments are also parsed. Their destinations are remote paths that do not exist locally, or that are not tracked, so they are allowed.
- **Cost:** `git ls-files` runs only when a target is extracted and exists. Most bash calls run no extra git process.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `cd agent/extensions && node --test tests/git-guard.test.cjs`
- [ ] Type checking passes: `cd agent/extensions && npm run typecheck`

#### Manual Verification:
- [ ] In a live Pi session inside a repo, `cp /tmp/x README.md` shows the approve/block dialog. "No, block it" blocks the command, and "Yes" runs it.
- [ ] `git show HEAD:README.md > /tmp/r.md` runs with no prompt.
- [ ] `git show :3:f > f && git add f && git commit -m "x"` shows the overwrite prompt first, and after approval shows the commit prompt.

---

## Testing Strategy

### Unit Tests:
- Each phase adds its examples from the session corpus as fixtures in `git-guard.test.cjs`, plus the negative cases listed above.
- The existing 15 tests must pass unchanged after each phase. This protects the current `git add`, destructive, interactive, and commit behavior.

### Integration Tests:
- None. The test harness already loads the real extension source and calls its `tool_call` handler. It never runs the command under test.

### Manual Testing Steps:
1. Start Pi in this repo with the extension loaded.
2. Run the manual checks for each phase.
3. Confirm that `git status`, `git log`, `git diff`, and `git add` still run without prompts.

## Using Jev Labels in Testing

Jev labels are a triage signal for finding candidate test cases, not ground truth. Tests assert the guard's intended behavior directly.

- **Below 0.5 confidence: ignore.** Every sub-0.5 disagreement in this corpus was noise or out of scope: the three `git add && git commit -m` chains (0.25 to 0.36), `git pull --rebase` (0.45), the read-only `echo`/`cat`/`head` command (0.33), and low-confidence lock-release and Docker commands (0.28 to 0.44).
- **0.5 and above: review manually** before adding a fixture. Use 0.5, not a higher value such as 0.8. Two of the three real in-scope gaps were at 0.53 (`git branch -f`) and 0.59 (`git show :3: >`). A 0.8 threshold would have missed them.
- **Recommendation:** when re-running this comparison after changes, review only disagreements with confidence ≥ 0.5 whose command contains `git` or touches a tracked path. Record the verdict (guard gap, Jev false positive, or out of scope) and the confidence in the test name or a nearby comment.
- The raw labels (`jevLabels`, `[index, s|i|d, confidence%]` over the jq-sorted unique command list) are no longer in the codemode store. A re-run needs a new classification.

## Future Work

These belong to a separate general shell guard, not `git-guard.ts`. They come from the 20 out-of-scope destructive/safe disagreements:

- **Deletions:** `rm -v docs/plans/...md` (1.00), `rm -rf -- "$archive_dir"` (1.00), `flock ... rm` backup pruning (0.96, 1.00), `rm -f /root/.github-auth.log` + `mv` (0.96), `rm -f "$auth_log"` + `nohup` (0.93), `rm -f .backup-run-state .backup-start-time && git add ...` (0.83), `rm -rf locktest` in `/tmp` (0.67).
- **Agent-coordination lock release:** `rm .../write.lock/owner`, `rmdir`, `mv "$tmp"` (5 commands, 0.28 to 0.83).
- **Docker and backup scripts:** evidence file writes, tar archive creation, `docker rm` on a diagnostic container (7 commands, 0.44 to 1.00).
- **Generic redirect overwrites** of tracked files (`echo`, `jq`, `tee`, `sed -i`). A shell guard could reuse `overwriteTargets` and `gateOverwrite` from Phase 3.

## Performance Considerations

Fixes 1 and 2 are regex-only. Fix 3 adds at most one `git ls-files` call per extracted, existing target (5 s timeout via `GIT_TIMEOUT`, `git-guard.ts:40`). The call runs only when a command contains `git show ... >` or `cp`.

## Migration Notes

None. No config or persisted state changes. To roll back, revert the commit for the phase.

## References

- Extension: `agent/extensions/git-guard.ts`
- Tests: `agent/extensions/tests/git-guard.test.cjs`
- Session corpus: `docs/research/tailnet-sessions/*.jsonl` (read-only)
- Jev and codemode reference: `docs/codemode-and-jev.md`
- Prior git-guard design: `docs/git-guard-commit-viz.md`
- Similar implementation: `gatePath` (`git-guard.ts:177-203`), `isGitTracked` (`git-guard.ts:157-160`)
