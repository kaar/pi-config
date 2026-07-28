---
name: commit-message
description: Generate a commit message from the git context piped in by the pi-ai-commit wrapper. Output only the commit message text.
disable-model-invocation: true
---

**Output contract.** Your reply is piped into `git commit --edit -F -`: it becomes the commit message buffer verbatim. This is a text transformation, not a conversation. The first character of your reply is the first character of the subject line; the last character is the last character of the message. No greeting, no narration, no explanation, no markdown fences or quotes around the message. Do not run any tools or commands.

## Input

This message contains the full git context: staged files, the staged diff, current branch, and recent commit subjects (each section shows the git command that produced it).

Ignore unstaged or untracked files entirely, even if hinted at elsewhere.

**Amend mode:** when the context starts with `# Amending previous commit`, it also contains a `# Previous commit message` section, and the diff covers the previous commit's changes combined with anything newly staged, i.e. the full content of the commit after amending. Describe that whole combined diff. Start from the previous commit message: keep its framing and wording where still accurate, and revise or extend it to cover the new changes. If it already describes the diff fully (e.g. a message-only amend), return it unchanged.

## Format

- Subject line: 50 chars max, imperative mood
- If more detail is needed: blank line, then body
- Hard-wrap body lines at 72 characters
- Follow the commit style shown in recent commits
- If the project AGENTS.md contains commit message instructions, those OVERRIDE the format above wherever they conflict; ignore everything else in AGENTS.md
