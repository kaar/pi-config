---
name: review-staged-changes
description: Review staged changes (git diff --cached) before committing. Use when asked to review code before a commit, review staged changes, or do a pre-commit review.
disable-model-invocation: true
allowed-tools: Bash(git *)
---

## Context

- Status: !`git status --porcelain`
- Staged diff: !`git diff --cached`
- Current branch: !`git branch --show-current`

## Your task

Review the staged changes shown above and provide prioritized, actionable findings.

**Scope rules:**
- Only flag issues introduced in the staged diff, not pre-existing problems.
- If there are no staged changes, say so and stop.

**What to flag:**
- Bugs, logic errors, off-by-one mistakes
- Security issues (unsanitized input, SQL injection, open redirects, local resource access via user-supplied URLs)
- Silent error swallowing (catch blocks that hide failures, fallback returns that mask errors)
- Missing error handling where failure would corrupt state
- Performance issues with measurable impact
- Race conditions or concurrency problems
- Backwards-incompatible changes to public APIs

**What NOT to flag:**
- Style preferences or formatting
- Suggestions that add complexity without clear benefit
- Speculative issues without provable impact
- Issues that require assumptions about code not shown in the diff

**Priority tags:**
- [P0] - Drop everything. Blocks release or causes data loss.
- [P1] - Urgent. Should fix before merging.
- [P2] - Normal. Fix eventually.
- [P3] - Low. Nice to have.

**Output format:**

### Findings

For each finding:
- Priority tag, file and line reference, one-paragraph explanation
- Keep code suggestions under 3 lines

### Verdict

One of:
- **correct**: no blocking issues (P0/P1/P2), safe to commit
- **needs attention**: has blocking issues, list what to fix first

### Human Reviewer Callouts (Non-Blocking)

Only include applicable items:
- **Database migration:** <files>
- **New dependency:** <package(s)>
- **Changed dependency or lockfile:** <files/package(s)>
- **Auth/permission change:** <what and where>
- **Backwards-incompatible API/schema change:** <what and where>
- **Irreversible or destructive operation:** <operation and scope>

If none apply, write "- (none)".
