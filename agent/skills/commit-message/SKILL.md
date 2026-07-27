---
name: commit-message
description: Generate a commit message from git context provided in the same message (staged diff, branch, recent commits, project conventions). Output only the commit message text. Invoked by the pi-ai-commit wrapper script which pipes the context in on stdin.
disable-model-invocation: true
---

## Input

This message includes the full git context for the commit, gathered by a wrapper script:

- `# Staged files`: output of `git diff --cached --name-status`
- `# Staged changes`: the staged diff (`git diff --cached`)
- `# Current branch`
- `# Recent commits`: last 5 subjects, for style reference
- `# Project commit conventions`: project AGENTS.md contents, or `(no AGENTS.md found)`

Do NOT run any tools or commands. Use only the provided context.

## Your task

Generate a commit message describing **only** the staged changes shown in the provided context.

**Project conventions:** If the project AGENTS.md contains commit message instructions (format, style, wording rules), those OVERRIDE the default format below wherever they conflict. Ignore everything in AGENTS.md that is not about commit messages.

**Rules:**
- If the staged diff is empty, output exactly: `No staged changes. Stage files with 'git add' first.` and stop.
- Ignore unstaged or untracked files entirely, even if hinted at elsewhere.
- Output ONLY the commit message text, nothing else.
- Your entire response must BE the commit message. The very first character you output must be the first character of the subject line.
- Do NOT prepend any preamble, lead-in, or acknowledgement. Never write phrases like "Based on the staged changes, here's the commit message:", "Here is the commit message:", or similar.
- Do NOT append any trailing commentary after the commit message.
- No explanations, no markdown formatting, no code fences around the message.
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
