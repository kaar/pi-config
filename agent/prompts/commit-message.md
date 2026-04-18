---
description: Generate a commit message for staged changes
---

Gather git context by running these commands:
- `git status --porcelain`
- `git diff --cached`
- `git branch --show-current`
- `git log --oneline -5`

Then generate a commit message based on the changes.

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
