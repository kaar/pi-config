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
- Project commit conventions: !`f="AGENTS.md"; [[ -f "$f" ]] || f="$(git rev-parse --show-toplevel 2>/dev/null || true)/AGENTS.md"; [[ -f "$f" ]] && cat "$f" || echo "(no AGENTS.md found)"`

## Your task

Generate a commit message describing **only** the staged changes shown above.

**Project conventions:** If the project AGENTS.md above contains commit message instructions (format, style, wording rules), those OVERRIDE the default format below wherever they conflict. Ignore everything in AGENTS.md that is not about commit messages.

**Rules:**
- If the staged diff is empty, output exactly: `No staged changes. Stage files with 'git add' first.` and stop.
- Ignore unstaged or untracked files entirely, even if hinted at elsewhere.
- Output ONLY the commit message text, nothing else.
- Your entire response must BE the commit message. The very first character you output must be the first character of the subject line.
- Do NOT prepend any preamble, lead-in, or acknowledgement. Never write phrases like "Based on the staged changes, here's the commit message:", "Here is the commit message:", or similar.
- Do NOT append any trailing commentary after the commit message.
- No explanations, no tool calls, no markdown formatting, no code fences around the message.
- Follow the commit style shown in recent commits.

**Format:**
- First line: Subject (50 chars max, imperative mood)
- If more detail is needed: blank line, then body

**Example output** (the fences below are illustration only, do not include them):
```
Add user authentication endpoint

Implement JWT-based auth with refresh token support.
```

Or for simple changes, just:
```
Fix typo in README
```
