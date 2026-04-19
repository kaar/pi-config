---
name: generate-commit-message
description: Generate a commit message for staged changes (output only, no git commit commands). Use when asked to generate or draft a commit message.
disable-model-invocation: true
allowed-tools: Bash(git *)
---

## Context

- Status: !`git status --porcelain`
- Staged changes: !`git diff --cached`
- Unstaged changes: !`git diff`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -5`

## Your task

Analyze the changes shown above and generate a commit message.

**Output requirements:**
- Output ONLY the commit message text, nothing else
- No explanations, no tool calls, no markdown formatting
- The message should be short but descriptive
- Follow the commit style shown in recent commits
- If there are staged changes, base the message on those
- If no staged changes exist, base the message on unstaged changes

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
