---
name: generate-commit-message
description: Generate a commit message for staged changes (output only, no git commit commands). Use when asked to generate or draft a commit message.
disable-model-invocation: true
allowed-tools: Bash(git *)
---

## Context

- Staged files: !`git diff --cached --name-status`
- Staged changes: !`git diff --cached`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -5`

## Your task

Generate a commit message describing **only** the staged changes shown above.

**Rules:**
- If the staged diff is empty, output exactly: `No staged changes. Stage files with 'git add' first.` and stop.
- Ignore unstaged or untracked files entirely, even if hinted at elsewhere.
- Output ONLY the commit message text, nothing else.
- No explanations, no tool calls, no markdown formatting.
- Follow the commit style shown in recent commits.

**Format:**
- First line: Subject (50 chars max, imperative mood)
- If more detail is needed: blank line, then body

**Example output:**
```
Add user authentication endpoint

Implement JWT-based auth with refresh token support.
```

Or for simple changes, just:
```
Fix typo in README
```
